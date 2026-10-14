// api/nse-proxy.js — NSE India free data proxy
// Fetches live index & market data from NSE's own public JSON endpoints.
// NSE blocks direct browser requests (CORS + cookie check), so this
// Vercel serverless function acts as a thin authenticated bridge.
// Zero cost — no third-party APIs, no keys required.

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const type = req.query.type || "indices"; // indices | gainers | losers | fiidii

  // NSE requires a cookie handshake first — fetch the homepage to get cookies,
  // then hit the JSON endpoint with those cookies in hand.
  const BASE = "https://www.nseindia.com";

  const ENDPOINTS = {
    indices: `${BASE}/api/allIndices`,
    gainers: `${BASE}/api/live-analysis-variations?index=gainers&type=&indexName=NIFTY%2050`,
    losers:  `${BASE}/api/live-analysis-variations?index=losers&type=&indexName=NIFTY%2050`,
    fiidii:  `${BASE}/api/fiidiiTradeReact`
  };

  const url = ENDPOINTS[type];
  if (!url) {
    return res.status(400).json({ error: "Unknown type: " + type });
  }

  // Browser-like headers NSE expects
  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.nseindia.com/market-data/live-equity-market",
    "X-Requested-With": "XMLHttpRequest",
    "Connection": "keep-alive"
  };

  try {
    // Step 1: Warm up session — NSE sets a bm_sv / nsit cookie on homepage hit
    const warmup = await fetch(BASE, {
      headers: {
        "User-Agent": HEADERS["User-Agent"],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    // Extract Set-Cookie from warmup response
    const rawCookies = warmup.headers.get("set-cookie") || "";
    // Parse multiple cookies from the header (Vercel gives a single joined string)
    const cookieStr = rawCookies
      .split(/,(?=[^ ].*?=)/)   // split on comma not inside a cookie value
      .map(c => c.trim().split(";")[0]) // keep only name=value part
      .filter(Boolean)
      .join("; ");

    // Step 2: Fetch actual data with session cookie
    const dataRes = await fetch(url, {
      headers: {
        ...HEADERS,
        ...(cookieStr ? { Cookie: cookieStr } : {})
      }
    });

    if (!dataRes.ok) {
      const txt = await dataRes.text();
      console.error("NSE error:", dataRes.status, txt.slice(0, 200));
      return res.status(dataRes.status).json({
        error: "NSE returned " + dataRes.status,
        hint: "NSE may be down or blocking — try again in a moment"
      });
    }

    const data = await dataRes.json();

    // Transform & filter to only what the dashboard needs
    let out;

    if (type === "indices") {
      // Pick the key indices we show
      const WANT = ["NIFTY 50", "NIFTY BANK", "NIFTY MIDCAP 100", "NIFTY IT",
                    "NIFTY AUTO", "NIFTY FMCG", "NIFTY PHARMA", "INDIA VIX",
                    "S&P BSE SENSEX"];
      const rows = (data.data || []).filter(r => WANT.includes(r.index));
      out = {
        timestamp: data.timestamp || new Date().toISOString(),
        indices: rows.map(r => ({
          name:    r.index,
          last:    r.last,
          change:  r.variation,          // absolute change
          pct:     r.percentChange,      // % change
          open:    r.open,
          high:    r.high,
          low:     r.low,
          prev:    r.previousClose,
          advance: r.advances,
          decline: r.declines,
          unch:    r.unchanged,
          status:  r.marketStatus        // Open / Closed
        }))
      };
    } else if (type === "gainers" || type === "losers") {
      const rows = (data.data || []).slice(0, 10);
      out = {
        timestamp: new Date().toISOString(),
        type,
        stocks: rows.map(r => ({
          symbol:  r.symbol,
          ltp:     r.ltp,
          change:  r.netPrice,
          pct:     r.perChange,
          volume:  r.tradedQuantity,
          value:   r.turnover
        }))
      };
    } else if (type === "fiidii") {
      // FII/DII latest day
      const rows = data || [];
      out = { timestamp: new Date().toISOString(), fiidii: rows.slice(0, 5) };
    }

    // Cache for 2 minutes (NSE data updates ~every 90s during market hours)
    res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=30");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(out);

  } catch (err) {
    console.error("NSE proxy error:", err.message);
    return res.status(500).json({ error: "Proxy fetch failed", detail: err.message });
  }
}
