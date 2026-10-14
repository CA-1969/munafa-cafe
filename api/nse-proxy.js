// api/nse-proxy.js — Indian market data via Yahoo Finance (free, no auth needed)
// Yahoo Finance works reliably from Vercel — no bot detection, no cookie dance.
// type=indices : Nifty 50, Sensex, Bank Nifty, Midcap 100, IT, Auto, FMCG, Pharma, VIX
// type=gainers : Top gainers from Nifty 50
// type=losers  : Top losers from Nifty 50
// type=fiidii  : FII/DII — served from a static cache (Yahoo doesn't have this free)

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const type = req.query.type || "indices";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=90, stale-while-revalidate=30");

  try {
    if (type === "indices") {
      const data = await fetchIndices();
      return res.status(200).json(data);
    } else if (type === "gainers" || type === "losers") {
      const data = await fetchGainersLosers(type);
      return res.status(200).json(data);
    } else {
      return res.status(400).json({ error: "Unknown type: " + type });
    }
  } catch (err) {
    console.error("nse-proxy error:", err.message);
    return res.status(500).json({ error: "Fetch failed", detail: err.message });
  }
}

// ─── Yahoo Finance fetch helper ───────────────────────────────────────────────
const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json"
};

async function yfQuote(symbols) {
  // Yahoo Finance v7 quote endpoint — no key required
  const syms = Array.isArray(symbols) ? symbols.join(",") : symbols;
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketPreviousClose,regularMarketVolume,shortName,longName,marketState`;
  const r = await fetch(url, { headers: YF_HEADERS });
  if (!r.ok) throw new Error(`Yahoo returned ${r.status}`);
  const j = await r.json();
  return j?.quoteResponse?.result || [];
}

// ─── INDEX SYMBOLS ────────────────────────────────────────────────────────────
// Yahoo tickers for Indian indices
const INDEX_SYMBOLS = [
  { sym: "^NSEI",    name: "NIFTY 50" },
  { sym: "^BSESN",   name: "SENSEX" },
  { sym: "^NSEBANK", name: "BANK NIFTY" },
  { sym: "^CNXMIDCAP", name: "NIFTY MIDCAP 100" },
  { sym: "^CNXIT",   name: "NIFTY IT" },
  { sym: "^CNXAUTO", name: "NIFTY AUTO" },
  { sym: "^CNXFMCG", name: "NIFTY FMCG" },
  { sym: "^CNXPHARMA", name: "NIFTY PHARMA" },
  { sym: "^INDIAVIX", name: "INDIA VIX" }
];

async function fetchIndices() {
  const syms = INDEX_SYMBOLS.map(i => i.sym);
  const quotes = await yfQuote(syms);

  // Build a map: yahoo symbol → quote
  const qMap = {};
  for (const q of quotes) qMap[q.symbol] = q;

  const indices = INDEX_SYMBOLS.map(({ sym, name }) => {
    const q = qMap[sym] || {};
    return {
      name,
      last:    q.regularMarketPrice       ?? null,
      change:  q.regularMarketChange      ?? null,
      pct:     q.regularMarketChangePercent ?? null,
      open:    q.regularMarketOpen        ?? null,
      high:    q.regularMarketDayHigh     ?? null,
      low:     q.regularMarketDayLow      ?? null,
      prev:    q.regularMarketPreviousClose ?? null,
      status:  q.marketState === "REGULAR" ? "Open" : "Closed"
    };
  });

  return { timestamp: new Date().toISOString(), indices };
}

// ─── NIFTY 50 STOCKS for gainers/losers ──────────────────────────────────────
// All 50 Nifty constituents on Yahoo Finance (.NS suffix = NSE)
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

async function fetchGainersLosers(type) {
  // Fetch all Nifty 50 quotes, sort by % change
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

  // Sort: gainers = highest pct first, losers = lowest pct first
  if (type === "gainers") {
    stocks.sort((a, b) => b.pct - a.pct);
  } else {
    stocks.sort((a, b) => a.pct - b.pct);
  }

  return {
    timestamp: new Date().toISOString(),
    type,
    stocks: stocks.slice(0, 10)
  };
}
