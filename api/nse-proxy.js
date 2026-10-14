// api/nse-proxy.js — Real-time Indian market data via Angel One SmartAPI
// JWT is cached in Upstash Redis by api/angel-login.js (call once per day from office)
// type=indices : Nifty 50, Sensex, Bank Nifty, Midcap 100, IT, Auto, FMCG, Pharma, VIX
// type=gainers : Top gainers from Nifty 50
// type=losers  : Top losers from Nifty 50
// Falls back to Yahoo Finance if no JWT in Redis (15-min delay, always available)

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const type = req.query.type || "indices";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=10");

  try {
    // Try to get cached Angel JWT
    const jwt = await redis.get("angel:jwt");

    if (jwt) {
      // Real-time path via Angel SmartAPI
      if (type === "indices") {
        const data = await fetchIndicesAngel(jwt);
        return res.status(200).json(data);
      } else if (type === "gainers" || type === "losers") {
        const data = await fetchGainersLosersAngel(jwt, type);
        return res.status(200).json(data);
      }
    } else {
      // Fallback: Yahoo Finance (~15 min delay)
      console.warn("No Angel JWT in Redis — falling back to Yahoo Finance");
      if (type === "indices") {
        const data = await fetchIndicesYahoo();
        return res.status(200).json({ ...data, source: "yahoo_fallback" });
      } else if (type === "gainers" || type === "losers") {
        const data = await fetchGainersLosersYahoo(type);
        return res.status(200).json({ ...data, source: "yahoo_fallback" });
      }
    }

    return res.status(400).json({ error: "Unknown type: " + type });

  } catch (err) {
    console.error("nse-proxy error:", err.message);
    // Try Yahoo fallback on Angel error
    try {
      if (type === "indices") {
        const data = await fetchIndicesYahoo();
        return res.status(200).json({ ...data, source: "yahoo_fallback" });
      } else if (type === "gainers" || type === "losers") {
        const data = await fetchGainersLosersYahoo(type);
        return res.status(200).json({ ...data, source: "yahoo_fallback" });
      }
    } catch (e2) {
      return res.status(500).json({ error: "All data sources failed", detail: err.message });
    }
  }
}

// ─── ANGEL ONE SmartAPI ───────────────────────────────────────────────────────

const ANGEL_API_KEY = process.env.ANGEL_API_KEY;

// Angel One token symbols for indices
// exchangeType: 1=NSE, 3=BSE
const ANGEL_INDICES = [
  { token: "99926000", exchange: "NSE", name: "NIFTY 50" },
  { token: "99919000", exchange: "BSE", name: "SENSEX" },
  { token: "99926009", exchange: "NSE", name: "BANK NIFTY" },
  { token: "99926011", exchange: "NSE", name: "NIFTY MIDCAP 100" },
  { token: "99926013", exchange: "NSE", name: "NIFTY IT" },
  { token: "99926010", exchange: "NSE", name: "NIFTY AUTO" },
  { token: "99926014", exchange: "NSE", name: "NIFTY FMCG" },
  { token: "99926012", exchange: "NSE", name: "NIFTY PHARMA" },
  { token: "99926002", exchange: "NSE", name: "INDIA VIX" }
];

async function angelQuote(jwt, exchangeTokens) {
  // exchangeTokens: array of { exchange, symboltoken }
  const res = await fetch("https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Accept":        "application/json",
      "X-UserType":    "USER",
      "X-SourceID":    "WEB",
      "X-ClientLocalIP": "192.168.1.1",
      "X-ClientPublicIP": "49.43.152.78",
      "X-MACAddress":  "00:00:00:00:00:00",
      "X-PrivateKey":  ANGEL_API_KEY,
      "Authorization": "Bearer " + jwt
    },
    body: JSON.stringify({ mode: "FULL", exchangeTokens })
  });
  if (!res.ok) throw new Error(`Angel quote returned ${res.status}`);
  const j = await res.json();
  if (!j.status) throw new Error("Angel quote error: " + (j.message || "unknown"));
  return j.data?.fetched || [];
}

async function fetchIndicesAngel(jwt) {
  // Group by exchange
  const nseTokens = ANGEL_INDICES.filter(i => i.exchange === "NSE").map(i => i.token);
  const bseTokens = ANGEL_INDICES.filter(i => i.exchange === "BSE").map(i => i.token);

  const exchangeTokens = {};
  if (nseTokens.length) exchangeTokens["NSE"] = nseTokens;
  if (bseTokens.length) exchangeTokens["BSE"] = bseTokens;

  const quotes = await angelQuote(jwt, exchangeTokens);

  // Build map by token
  const qMap = {};
  for (const q of quotes) qMap[q.symbolToken] = q;

  const indices = ANGEL_INDICES.map(({ token, name }) => {
    const q = qMap[token] || {};
    const prev = q.close || 0;
    const last = q.ltp   || 0;
    const change = prev ? last - prev : null;
    const pct    = prev ? ((last - prev) / prev) * 100 : null;
    return {
      name,
      last:   last   || null,
      change: change || null,
      pct:    pct    || null,
      open:   q.open || null,
      high:   q.high || null,
      low:    q.low  || null,
      prev:   prev   || null,
      status: q.exchFeedTime ? "Open" : "Closed"
    };
  });

  return { timestamp: new Date().toISOString(), source: "angel", indices };
}

// Nifty 50 stock tokens on Angel (NSE)
const NIFTY50_ANGEL = [
  { token: "2885",  sym: "RELIANCE" },
  { token: "11536", sym: "TCS" },
  { token: "1333",  sym: "HDFCBANK" },
  { token: "10604", sym: "BHARTIARTL" },
  { token: "4963",  sym: "ICICIBANK" },
  { token: "1594",  sym: "INFOSYS" },
  { token: "3045",  sym: "SBIN" },
  { token: "10940", sym: "LICI" },
  { token: "1394",  sym: "HINDUNILVR" },
  { token: "1660",  sym: "ITC" },
  { token: "1922",  sym: "KOTAKBANK" },
  { token: "11483", sym: "LT" },
  { token: "7229",  sym: "HCLTECH" },
  { token: "10999", sym: "MARUTI" },
  { token: "5900",  sym: "AXISBANK" },
  { token: "317",   sym: "BAJFINANCE" },
  { token: "3506",  sym: "TITAN" },
  { token: "236",   sym: "ASIANPAINT" },
  { token: "3351",  sym: "SUNPHARMA" },
  { token: "2952",  sym: "ULTRACEMCO" },
  { token: "25",    sym: "ADANIENT" },
  { token: "15083", sym: "ADANIPORTS" },
  { token: "3787",  sym: "WIPRO" },
  { token: "11630", sym: "NTPC" },
  { token: "14977", sym: "POWERGRID" },
  { token: "1079",  sym: "COALINDIA" },
  { token: "16675", sym: "BAJAJFINSV" },
  { token: "17963", sym: "NESTLEIND" },
  { token: "13538", sym: "TECHM" },
  { token: "2475",  sym: "ONGC" },
  { token: "3432",  sym: "TATAMOTORS" },
  { token: "3499",  sym: "TATASTEEL" },
  { token: "11723", sym: "JSWSTEEL" },
  { token: "1363",  sym: "HINDALCO" },
  { token: "2031",  sym: "M&M" },
  { token: "10940", sym: "DIVISLAB" },
  { token: "694",   sym: "CIPLA" },
  { token: "881",   sym: "DRREDDY" },
  { token: "157",   sym: "APOLLOHOSP" },
  { token: "910",   sym: "EICHERMOT" },
  { token: "21808", sym: "SBILIFE" },
  { token: "467",   sym: "HDFCLIFE" },
  { token: "5258",  sym: "INDUSINDBK" },
  { token: "547",   sym: "BRITANNIA" },
  { token: "526",   sym: "BPCL" },
  { token: "315",   sym: "GRASIM" },
  { token: "1964",  sym: "TRENT" },
  { token: "4306",  sym: "SHRIRAMFIN" },
  { token: "634",   sym: "BEL" },
  { token: "1345",  sym: "HEROMOTOCO" }
];

async function fetchGainersLosersAngel(jwt, type) {
  const tokens = NIFTY50_ANGEL.map(s => s.token);
  const quotes = await angelQuote(jwt, { NSE: tokens });

  const tokenMap = {};
  for (const s of NIFTY50_ANGEL) tokenMap[s.token] = s.sym;

  const stocks = quotes
    .filter(q => q.ltp && q.close)
    .map(q => {
      const pct = ((q.ltp - q.close) / q.close) * 100;
      return {
        symbol: tokenMap[q.symbolToken] || q.symbolToken,
        ltp:    q.ltp,
        change: q.ltp - q.close,
        pct,
        volume: q.tradeVolume || null,
        value:  null
      };
    });

  if (type === "gainers") {
    stocks.sort((a, b) => b.pct - a.pct);
  } else {
    stocks.sort((a, b) => a.pct - b.pct);
  }

  return { timestamp: new Date().toISOString(), source: "angel", type, stocks: stocks.slice(0, 10) };
}

// ─── YAHOO FINANCE FALLBACK ───────────────────────────────────────────────────

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json"
};

async function yfQuote(symbols) {
  const syms = Array.isArray(symbols) ? symbols.join(",") : symbols;
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketPreviousClose,regularMarketVolume,marketState`;
  const r = await fetch(url, { headers: YF_HEADERS });
  if (!r.ok) throw new Error(`Yahoo returned ${r.status}`);
  const j = await r.json();
  return j?.quoteResponse?.result || [];
}

const INDEX_SYMBOLS = [
  { sym: "^NSEI",      name: "NIFTY 50" },
  { sym: "^BSESN",     name: "SENSEX" },
  { sym: "^NSEBANK",   name: "BANK NIFTY" },
  { sym: "^CNXMIDCAP", name: "NIFTY MIDCAP 100" },
  { sym: "^CNXIT",     name: "NIFTY IT" },
  { sym: "^CNXAUTO",   name: "NIFTY AUTO" },
  { sym: "^CNXFMCG",   name: "NIFTY FMCG" },
  { sym: "^CNXPHARMA", name: "NIFTY PHARMA" },
  { sym: "^INDIAVIX",  name: "INDIA VIX" }
];

async function fetchIndicesYahoo() {
  const syms = INDEX_SYMBOLS.map(i => i.sym);
  const quotes = await yfQuote(syms);
  const qMap = {};
  for (const q of quotes) qMap[q.symbol] = q;

  const indices = INDEX_SYMBOLS.map(({ sym, name }) => {
    const q = qMap[sym] || {};
    return {
      name,
      last:   q.regularMarketPrice          ?? null,
      change: q.regularMarketChange         ?? null,
      pct:    q.regularMarketChangePercent  ?? null,
      open:   q.regularMarketOpen           ?? null,
      high:   q.regularMarketDayHigh        ?? null,
      low:    q.regularMarketDayLow         ?? null,
      prev:   q.regularMarketPreviousClose  ?? null,
      status: q.marketState === "REGULAR" ? "Open" : "Closed"
    };
  });

  return { timestamp: new Date().toISOString(), indices };
}

const NIFTY50_SYMS = [
  "RELIANCE.NS","TCS.NS","HDFCBANK.NS","BHARTIARTL.NS","ICICIBANK.NS",
  "INFOSYS.NS","SBIN.NS","LICI.NS","HINDUNILVR.NS","ITC.NS",
  "KOTAKBANK.NS","LT.NS","HCLTECH.NS","MARUTI.NS","AXISBANK.NS",
  "BAJFINANCE.NS","TITAN.NS","ASIANPAINT.NS","SUNPHARMA.NS","ULTRACEMCO.NS",
  "ADANIENT.NS","ADANIPORTS.NS","WIPRO.NS","NTPC.NS","POWERGRID.NS",
  "COALINDIA.NS","BAJAJFINSV.NS","NESTLEIND.NS","TECHM.NS","ONGC.NS",
  "TATAMOTORS.NS","TATASTEEL.NS","JSWSTEEL.NS","HINDALCO.NS","M&M.NS",
  "DIVISLAB.NS","CIPLA.NS","DRREDDY.NS","APOLLOHOSP.NS","EICHERMOT.NS",
  "SBILIFE.NS","HDFCLIFE.NS","INDUSINDBK.NS","BRITANNIA.NS","BPCL.NS",
  "GRASIM.NS","TRENT.NS","SHRIRAMFIN.NS","BEL.NS","HEROMOTOCO.NS"
];

async function fetchGainersLosersYahoo(type) {
  const quotes = await yfQuote(NIFTY50_SYMS);
  const stocks = quotes
    .filter(q => q.regularMarketChangePercent != null)
    .map(q => ({
      symbol: q.symbol.replace(".NS", ""),
      ltp:    q.regularMarketPrice,
      change: q.regularMarketChange,
      pct:    q.regularMarketChangePercent,
      volume: q.regularMarketVolume,
      value:  null
    }));

  if (type === "gainers") {
    stocks.sort((a, b) => b.pct - a.pct);
  } else {
    stocks.sort((a, b) => a.pct - b.pct);
  }

  return { timestamp: new Date().toISOString(), type, stocks: stocks.slice(0, 10) };
}
