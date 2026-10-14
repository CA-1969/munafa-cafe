// api/nse-proxy.js — Indian market data
// Primary: Angel One SmartAPI (real-time, JWT cached in Redis)
// Fallback: Stooq (free, works from Vercel, ~15min delay)
// type=indices | type=gainers | type=losers

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const type = req.query.type || "indices";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=30");

  try {
    // Try Angel JWT first
    const jwt = await redis.get("angel:jwt").catch(() => null);

    if (jwt && process.env.ANGEL_API_KEY) {
      try {
        if (type === "indices") return res.status(200).json(await fetchIndicesAngel(jwt));
        if (type === "gainers" || type === "losers") return res.status(200).json(await fetchGainersLosersAngel(jwt, type));
      } catch (angelErr) {
        console.warn("Angel failed, falling back:", angelErr.message);
      }
    }

    // Fallback: Stooq CSV
    if (type === "indices") return res.status(200).json(await fetchIndicesStooq());
    if (type === "gainers" || type === "losers") return res.status(200).json(await fetchGainersLosersStooq(type));

    return res.status(400).json({ error: "Unknown type: " + type });

  } catch (err) {
    console.error("nse-proxy error:", err.message);
    return res.status(500).json({ error: "Fetch failed", detail: err.message });
  }
}

// ─── STOOQ FALLBACK ───────────────────────────────────────────────────────────
// Stooq serves Indian indices reliably from any server — no bot detection

async function stooqQuote(symbol) {
  // Stooq CSV: symbol,date,time,open,high,low,close,volume
  const url = `https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcv&h&e=csv`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  if (!r.ok) throw new Error(`Stooq ${symbol} returned ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;
  const [sym, date, time, open, high, low, close, volume] = lines[1].split(",");
  const c = parseFloat(close);
  if (!c || isNaN(c)) return null;
  return { open: parseFloat(open), high: parseFloat(high), low: parseFloat(low), close: c, volume: parseFloat(volume)||0 };
}

// Stooq symbols for Indian indices
const STOOQ_INDICES = [
  { sym: "^nsei",      name: "NIFTY 50"        },
  { sym: "^bsesn",     name: "S&P BSE SENSEX"  },
  { sym: "^nsebank",   name: "NIFTY BANK"      },
  { sym: "^cnxmc",     name: "NIFTY MIDCAP 100"},
  { sym: "^cnxit",     name: "NIFTY IT"        },
  { sym: "^cnxauto",   name: "NIFTY AUTO"      },
  { sym: "^cnxfmcg",   name: "NIFTY FMCG"     },
  { sym: "^cnxpharma", name: "NIFTY PHARMA"   },
  { sym: "^indiavix",  name: "INDIA VIX"       }
];

async function fetchIndicesStooq() {
  // Fetch all in parallel
  const results = await Promise.allSettled(
    STOOQ_INDICES.map(i => stooqQuote(i.sym))
  );

  const indices = STOOQ_INDICES.map(({ name }, idx) => {
    const r = results[idx].status === "fulfilled" ? results[idx].value : null;
    if (!r) return { name, last: null, change: null, pct: null, open: null, high: null, low: null, prev: null, status: "Closed" };
    // Stooq returns today's OHLC; for change we'd need yesterday's close.
    // Use open as proxy for prev (intraday change from open).
    const last   = r.close;
    const prev   = r.open; // best we can do without prev-close
    const change = last - prev;
    const pct    = prev ? (change / prev) * 100 : 0;
    const ist    = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const isOpen = ist.getDay() >= 1 && ist.getDay() <= 5 &&
      (ist.getHours() > 9 || (ist.getHours() === 9 && ist.getMinutes() >= 15)) &&
      (ist.getHours() < 15 || (ist.getHours() === 15 && ist.getMinutes() <= 30));
    return { name, last, change, pct, open: r.open, high: r.high, low: r.low, prev: r.open, status: isOpen ? "Open" : "Closed" };
  });

  return { timestamp: new Date().toISOString(), source: "stooq", indices };
}

// Nifty 50 stocks on Stooq (.ns suffix = NSE)
const NIFTY50_STOOQ = [
  "reliance.ns","tcs.ns","hdfcbank.ns","bhartiartl.ns","icicibank.ns",
  "infy.ns","sbin.ns","lici.ns","hindunilvr.ns","itc.ns",
  "kotakbank.ns","lt.ns","hcltech.ns","maruti.ns","axisbank.ns",
  "bajfinance.ns","titan.ns","asianpaint.ns","sunpharma.ns","ultracemco.ns",
  "adanient.ns","adaniports.ns","wipro.ns","ntpc.ns","powergrid.ns",
  "coalindia.ns","bajajfinsv.ns","nestleind.ns","techm.ns","ongc.ns",
  "tatamotors.ns","tatasteel.ns","jswsteel.ns","hindalco.ns","mm.ns",
  "divislab.ns","cipla.ns","drreddy.ns","apollohosp.ns","eichermot.ns",
  "sbilife.ns","hdfclife.ns","indusindbk.ns","britannia.ns","bpcl.ns",
  "grasim.ns","trent.ns","shriramfin.ns","bel.ns","heromotoco.ns"
];

async function fetchGainersLosersStooq(type) {
  // Fetch in batches of 10 to avoid overwhelming Stooq
  const results = await Promise.allSettled(
    NIFTY50_STOOQ.map(s => stooqQuote(s))
  );

  const stocks = NIFTY50_STOOQ.map((s, i) => {
    const q = results[i].status === "fulfilled" ? results[i].value : null;
    if (!q || !q.close) return null;
    const pct = q.open ? ((q.close - q.open) / q.open) * 100 : 0;
    return {
      symbol: s.replace(".ns","").toUpperCase().replace("MM","M&M").replace("INFY","INFOSYS"),
      ltp:    q.close,
      change: q.close - q.open,
      pct,
      volume: q.volume,
      value:  null
    };
  }).filter(Boolean);

  if (type === "gainers") stocks.sort((a,b) => b.pct - a.pct);
  else stocks.sort((a,b) => a.pct - b.pct);

  return { timestamp: new Date().toISOString(), source: "stooq", type, stocks: stocks.slice(0, 10) };
}

// ─── ANGEL ONE (real-time when JWT cached) ────────────────────────────────────

const ANGEL_INDICES = [
  { token: "99926000", exchange: "NSE", name: "NIFTY 50" },
  { token: "99919000", exchange: "BSE", name: "S&P BSE SENSEX" },
  { token: "99926009", exchange: "NSE", name: "NIFTY BANK" },
  { token: "99926011", exchange: "NSE", name: "NIFTY MIDCAP 100" },
  { token: "99926013", exchange: "NSE", name: "NIFTY IT" },
  { token: "99926010", exchange: "NSE", name: "NIFTY AUTO" },
  { token: "99926014", exchange: "NSE", name: "NIFTY FMCG" },
  { token: "99926012", exchange: "NSE", name: "NIFTY PHARMA" },
  { token: "99926002", exchange: "NSE", name: "INDIA VIX" }
];

async function angelQuote(jwt, exchangeTokens) {
  const r = await fetch("https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-UserType": "USER", "X-SourceID": "WEB",
      "X-ClientLocalIP": "192.168.1.1",
      "X-ClientPublicIP": "49.43.152.78",
      "X-MACAddress": "00:00:00:00:00:00",
      "X-PrivateKey": process.env.ANGEL_API_KEY,
      "Authorization": "Bearer " + jwt
    },
    body: JSON.stringify({ mode: "FULL", exchangeTokens })
  });
  if (!r.ok) throw new Error(`Angel quote ${r.status}`);
  const j = await r.json();
  if (!j.status) throw new Error("Angel: " + j.message);
  return j.data?.fetched || [];
}

async function fetchIndicesAngel(jwt) {
  const nse = ANGEL_INDICES.filter(i=>i.exchange==="NSE").map(i=>i.token);
  const bse = ANGEL_INDICES.filter(i=>i.exchange==="BSE").map(i=>i.token);
  const et  = {};
  if (nse.length) et["NSE"] = nse;
  if (bse.length) et["BSE"] = bse;
  const quotes = await angelQuote(jwt, et);
  const qMap = {};
  for (const q of quotes) qMap[q.symbolToken] = q;
  const indices = ANGEL_INDICES.map(({token,name}) => {
    const q = qMap[token] || {};
    const last = q.ltp || null;
    const prev = q.close || null;
    const change = (last && prev) ? last - prev : null;
    const pct    = (last && prev) ? (change/prev)*100 : null;
    return { name, last, change, pct, open:q.open||null, high:q.high||null, low:q.low||null, prev, status: q.exchFeedTime ? "Open":"Closed" };
  });
  return { timestamp: new Date().toISOString(), source: "angel", indices };
}

const NIFTY50_ANGEL = [
  {token:"2885",sym:"RELIANCE"},{token:"11536",sym:"TCS"},{token:"1333",sym:"HDFCBANK"},
  {token:"10604",sym:"BHARTIARTL"},{token:"4963",sym:"ICICIBANK"},{token:"1594",sym:"INFOSYS"},
  {token:"3045",sym:"SBIN"},{token:"10940",sym:"LICI"},{token:"1394",sym:"HINDUNILVR"},
  {token:"1660",sym:"ITC"},{token:"1922",sym:"KOTAKBANK"},{token:"11483",sym:"LT"},
  {token:"7229",sym:"HCLTECH"},{token:"10999",sym:"MARUTI"},{token:"5900",sym:"AXISBANK"},
  {token:"317",sym:"BAJFINANCE"},{token:"3506",sym:"TITAN"},{token:"236",sym:"ASIANPAINT"},
  {token:"3351",sym:"SUNPHARMA"},{token:"2952",sym:"ULTRACEMCO"},{token:"25",sym:"ADANIENT"},
  {token:"15083",sym:"ADANIPORTS"},{token:"3787",sym:"WIPRO"},{token:"11630",sym:"NTPC"},
  {token:"14977",sym:"POWERGRID"},{token:"1079",sym:"COALINDIA"},{token:"16675",sym:"BAJAJFINSV"},
  {token:"17963",sym:"NESTLEIND"},{token:"13538",sym:"TECHM"},{token:"2475",sym:"ONGC"},
  {token:"3432",sym:"TATAMOTORS"},{token:"3499",sym:"TATASTEEL"},{token:"11723",sym:"JSWSTEEL"},
  {token:"1363",sym:"HINDALCO"},{token:"2031",sym:"M&M"},{token:"10940",sym:"DIVISLAB"},
  {token:"694",sym:"CIPLA"},{token:"881",sym:"DRREDDY"},{token:"157",sym:"APOLLOHOSP"},
  {token:"910",sym:"EICHERMOT"},{token:"21808",sym:"SBILIFE"},{token:"467",sym:"HDFCLIFE"},
  {token:"5258",sym:"INDUSINDBK"},{token:"547",sym:"BRITANNIA"},{token:"526",sym:"BPCL"},
  {token:"315",sym:"GRASIM"},{token:"1964",sym:"TRENT"},{token:"4306",sym:"SHRIRAMFIN"},
  {token:"634",sym:"BEL"},{token:"1345",sym:"HEROMOTOCO"}
];

async function fetchGainersLosersAngel(jwt, type) {
  const tokens = NIFTY50_ANGEL.map(s=>s.token);
  const quotes = await angelQuote(jwt, { NSE: tokens });
  const tm = {}; for (const s of NIFTY50_ANGEL) tm[s.token] = s.sym;
  const stocks = quotes.filter(q=>q.ltp&&q.close).map(q => {
    const pct = ((q.ltp-q.close)/q.close)*100;
    return { symbol: tm[q.symbolToken]||q.symbolToken, ltp:q.ltp, change:q.ltp-q.close, pct, volume:q.tradeVolume||null, value:null };
  });
  if (type==="gainers") stocks.sort((a,b)=>b.pct-a.pct);
  else stocks.sort((a,b)=>a.pct-b.pct);
  return { timestamp: new Date().toISOString(), source: "angel", type, stocks: stocks.slice(0,10) };
}
