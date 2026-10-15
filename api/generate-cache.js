// api/generate-cache.js — Pre-generate all module scripts with REAL market data
// Called by Vercel cron at 00:30 UTC (midnight IST) and 06:30 UTC (noon IST)
// Also callable manually: GET /api/generate-cache?secret=YOUR_CRON_SECRET
//
// Flow:
//   1. Fetch real Nifty/Sensex/BankNifty/VIX/sector data from Stooq
//   2. Fetch gainers/losers from Stooq (Nifty 50 stocks)
//   3. Inject real numbers into every AI prompt
//   4. Call Claude → Gemini → GPT for each module × language
//   5. Store results in Redis with 13h TTL

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const CACHE_TTL = 13 * 3600; // 13 hours

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const cronSecret = process.env.CRON_SECRET || "";
  const isCron     = req.headers["x-vercel-cron"] === "1";
  const hasSecret  = cronSecret && req.query.secret === cronSecret;
  if (!isCron && !hasSecret) return res.status(401).json({ error: "Unauthorized" });

  const dateStr = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });

  // ── STEP 1: Fetch real market data ────────────────────────────────────────
  console.log("Fetching real market data from Stooq...");
  const mkt = await fetchMarketData();
  console.log("Market data:", JSON.stringify(mkt));

  // ── STEP 2: Build prompts with real data injected ─────────────────────────
  const modules = buildPrompts(dateStr, mkt);

  // ── STEP 3: Generate and cache each module ────────────────────────────────
  const results = [];
  let success = 0, failed = 0;

  for (const { key, prompt } of modules) {
    try {
      const content = await callAI(prompt);
      if (content && content.length > 100) {
        await redis.set(key, content, { ex: CACHE_TTL });
        results.push({ key, status: "ok", len: content.length });
        success++;
      } else {
        results.push({ key, status: "empty" });
        failed++;
      }
    } catch(e) {
      results.push({ key, status: "error", error: e.message });
      failed++;
    }
    // Small pause between AI calls to avoid rate limits
    await sleep(1500);
  }

  await redis.set("cache:generated_at", new Date().toISOString(), { ex: CACHE_TTL });
  await redis.set("cache:market_snapshot", JSON.stringify(mkt), { ex: CACHE_TTL });

  return res.status(200).json({ generated_at: new Date().toISOString(), success, failed, market: mkt, results });
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL MARKET DATA FETCH — Stooq CSV (same source as nse-proxy.js)
// ─────────────────────────────────────────────────────────────────────────────
async function stooqQuote(symbol) {
  try {
    const url = `https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;
    const parts = lines[1].split(",");
    const close = parseFloat(parts[6]);
    const open  = parseFloat(parts[3]);
    if (!close || isNaN(close)) return null;
    const chg = close - open;
    const pct = open ? (chg / open) * 100 : 0;
    return { close, open, high: parseFloat(parts[4]), low: parseFloat(parts[5]), chg, pct };
  } catch(e) {
    console.warn("Stooq fetch failed for", symbol, e.message);
    return null;
  }
}

function fmt(val, dec = 2) {
  if (!val || isNaN(val)) return "N/A";
  return val.toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtChg(val) {
  if (!val || isNaN(val)) return "N/A";
  return (val >= 0 ? "+" : "") + fmt(val);
}
function fmtPct(val) {
  if (!val || isNaN(val)) return "N/A";
  return (val >= 0 ? "+" : "") + fmt(val) + "%";
}

const INDICES = [
  { sym: "^nsei",      name: "Nifty 50"         },
  { sym: "^bsesn",     name: "Sensex"            },
  { sym: "^nsebank",   name: "Bank Nifty"        },
  { sym: "^cnxmc",     name: "Nifty Midcap 100"  },
  { sym: "^cnxit",     name: "Nifty IT"          },
  { sym: "^cnxfmcg",   name: "Nifty FMCG"       },
  { sym: "^cnxpharma", name: "Nifty Pharma"      },
  { sym: "^cnxauto",   name: "Nifty Auto"        },
  { sym: "^indiavix",  name: "India VIX"         }
];

const NIFTY50_STOCKS = [
  { sym: "reliance.ns", name: "RELIANCE" }, { sym: "tcs.ns", name: "TCS" },
  { sym: "hdfcbank.ns", name: "HDFCBANK" }, { sym: "icicibank.ns", name: "ICICIBANK" },
  { sym: "infy.ns", name: "INFOSYS" },      { sym: "sbin.ns", name: "SBIN" },
  { sym: "bhartiartl.ns", name: "BHARTIARTL" }, { sym: "kotakbank.ns", name: "KOTAKBANK" },
  { sym: "lt.ns", name: "LT" },             { sym: "hcltech.ns", name: "HCLTECH" },
  { sym: "maruti.ns", name: "MARUTI" },     { sym: "axisbank.ns", name: "AXISBANK" },
  { sym: "bajfinance.ns", name: "BAJFINANCE" }, { sym: "titan.ns", name: "TITAN" },
  { sym: "asianpaint.ns", name: "ASIANPAINT" }, { sym: "sunpharma.ns", name: "SUNPHARMA" },
  { sym: "ultracemco.ns", name: "ULTRACEMCO" }, { sym: "wipro.ns", name: "WIPRO" },
  { sym: "ntpc.ns", name: "NTPC" },         { sym: "tatamotors.ns", name: "TATAMOTORS" },
  { sym: "tatasteel.ns", name: "TATASTEEL" }, { sym: "adanient.ns", name: "ADANIENT" },
  { sym: "hindalco.ns", name: "HINDALCO" }, { sym: "cipla.ns", name: "CIPLA" },
  { sym: "drreddy.ns", name: "DRREDDY" },   { sym: "techm.ns", name: "TECHM" }
];

async function fetchMarketData() {
  // Fetch indices and stocks in parallel
  const [indexResults, stockResults] = await Promise.all([
    Promise.allSettled(INDICES.map(i => stooqQuote(i.sym))),
    Promise.allSettled(NIFTY50_STOCKS.map(s => stooqQuote(s.sym)))
  ]);

  // Build index map
  const idx = {};
  INDICES.forEach(({ name }, i) => {
    const r = indexResults[i].status === "fulfilled" ? indexResults[i].value : null;
    idx[name] = r;
  });

  // Build gainers/losers from stocks
  const stocks = NIFTY50_STOCKS.map(({ name }, i) => {
    const r = stockResults[i].status === "fulfilled" ? stockResults[i].value : null;
    if (!r) return null;
    return { name, close: r.close, pct: r.pct, chg: r.chg };
  }).filter(Boolean);

  stocks.sort((a, b) => b.pct - a.pct);
  const gainers = stocks.slice(0, 5);
  const losers  = stocks.slice(-5).reverse();

  // Format into readable strings for prompt injection
  const nifty    = idx["Nifty 50"];
  const sensex   = idx["Sensex"];
  const bankNifty = idx["Bank Nifty"];
  const midcap   = idx["Nifty Midcap 100"];
  const vix      = idx["India VIX"];
  const niftyIT  = idx["Nifty IT"];
  const niftyFMCG = idx["Nifty FMCG"];
  const niftyPharma = idx["Nifty Pharma"];
  const niftyAuto = idx["Nifty Auto"];

  return {
    // Raw values for prompt use
    nifty:     nifty    ? { val: fmt(nifty.close, 0),    chg: fmtChg(nifty.chg),    pct: fmtPct(nifty.pct),    high: fmt(nifty.high, 0),   low: fmt(nifty.low, 0)   } : null,
    sensex:    sensex   ? { val: fmt(sensex.close, 0),   chg: fmtChg(sensex.chg),   pct: fmtPct(sensex.pct),   high: fmt(sensex.high, 0),  low: fmt(sensex.low, 0)  } : null,
    bankNifty: bankNifty? { val: fmt(bankNifty.close, 0),chg: fmtChg(bankNifty.chg),pct: fmtPct(bankNifty.pct),high: fmt(bankNifty.high, 0),low: fmt(bankNifty.low, 0)} : null,
    midcap:    midcap   ? { val: fmt(midcap.close, 0),   pct: fmtPct(midcap.pct)   } : null,
    vix:       vix      ? { val: fmt(vix.close),         pct: fmtPct(vix.pct)      } : null,
    sectors: {
      it:     niftyIT    ? fmtPct(niftyIT.pct)    : "N/A",
      fmcg:   niftyFMCG  ? fmtPct(niftyFMCG.pct)  : "N/A",
      pharma: niftyPharma? fmtPct(niftyPharma.pct) : "N/A",
      auto:   niftyAuto  ? fmtPct(niftyAuto.pct)   : "N/A"
    },
    gainers: gainers.map(s => `${s.name} ${fmtPct(s.pct)}`).join(", "),
    losers:  losers.map(s  => `${s.name} ${fmtPct(s.pct)}`).join(", "),
    // Compact summary string for prompt injection
    summary: buildSummary(nifty, sensex, bankNifty, vix, gainers, losers)
  };
}

function buildSummary(nifty, sensex, bankNifty, vix, gainers, losers) {
  const lines = [];
  if (nifty)    lines.push(`Nifty 50: ${fmt(nifty.close, 0)} (${fmtChg(nifty.chg)}, ${fmtPct(nifty.pct)}) | High: ${fmt(nifty.high, 0)} | Low: ${fmt(nifty.low, 0)}`);
  if (sensex)   lines.push(`Sensex: ${fmt(sensex.close, 0)} (${fmtChg(sensex.chg)}, ${fmtPct(sensex.pct)})`);
  if (bankNifty)lines.push(`Bank Nifty: ${fmt(bankNifty.close, 0)} (${fmtChg(bankNifty.chg)}, ${fmtPct(bankNifty.pct)})`);
  if (vix)      lines.push(`India VIX: ${fmt(vix.close)} (${fmtPct(vix.pct)})`);
  if (gainers.length) lines.push(`Top Gainers: ${gainers.map(s => `${s.name} ${fmtPct(s.pct)}`).join(", ")}`);
  if (losers.length)  lines.push(`Top Losers: ${losers.map(s => `${s.name} ${fmtPct(s.pct)}`).join(", ")}`);
  return lines.join("\n") || "Market data unavailable — use realistic estimates.";
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPTS — real data injected
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompts(d, mkt) {
  const items = [];
  const S = mkt.summary; // real data block injected into every market-related prompt

  const niftyStr    = mkt.nifty    ? `${mkt.nifty.val} (${mkt.nifty.chg}, ${mkt.nifty.pct})` : "N/A";
  const sensexStr   = mkt.sensex   ? `${mkt.sensex.val} (${mkt.sensex.chg}, ${mkt.sensex.pct})` : "N/A";
  const bankStr     = mkt.bankNifty? `${mkt.bankNifty.val} (${mkt.bankNifty.chg}, ${mkt.bankNifty.pct})` : "N/A";
  const vixStr      = mkt.vix      ? mkt.vix.val : "N/A";
  const gainersStr  = mkt.gainers  || "N/A";
  const losersStr   = mkt.losers   || "N/A";
  const sectorsStr  = `IT: ${mkt.sectors.it} | FMCG: ${mkt.sectors.fmcg} | Pharma: ${mkt.sectors.pharma} | Auto: ${mkt.sectors.auto}`;

  // ── MODULE 0 — Morning Brief ──────────────────────────────────────────────
  const m0dataHI = `\n\n📊 आज के REAL बाज़ार आंकड़े (इन्हीं का उपयोग करें, बदलें नहीं):\n${S}\nSectors: ${sectorsStr}`;
  const m0dataEN = `\n\n📊 TODAY'S REAL MARKET DATA (use these exact figures, do not invent):\n${S}\nSectors: ${sectorsStr}`;

  items.push({ key: "cache:module:0:hi", prompt:
    `आप MunaFa Café FM के दो RJ हैं — Anurag (पुरुष, बाज़ार विशेषज्ञ) और Deepa (महिला, जो सरल और तीखे सवाल पूछती हैं)। आज की तारीख है ${d}।${m0dataHI}\n\nमहत्वपूर्ण निर्देश:\n- ऊपर दिए गए REAL आंकड़ों का उपयोग करें। कोई काल्पनिक संख्या न दें।\n- शो में RJ का नाम केवल "Anurag" है — "RJ Anurag" नहीं।\n- भाषा: शुद्ध हिंदी। केवल ये अंग्रेज़ी शब्द रखें: Nifty, Sensex, Bank Nifty, SIP, NAV, FII, DII, EBITDA, GDP, IPO, NFO, RSI, VIX।\n- मुद्रा शब्दों में लिखें।\n\n15 turns का संवाद लिखें, हर turn 40-55 शब्द। सिर्फ यह JSON दें:\n{"turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}\n\nTurn 1(A): शो का परिचय। Turn 2(D): कल की मुख्य घटनाएँ। Turn 3(A): Nifty ${niftyStr} और Sensex ${sensexStr} — विस्तृत विवरण। Turn 4(D): आज की संभावित दिशा। Turn 5(A): तकनीकी support/resistance। Turn 6(D): Bank Nifty ${bankStr} और क्षेत्र। Turn 7(A): Sectors — ${sectorsStr}। Turn 8(D): आज के gainers — ${gainersStr}। Turn 9(A): आज के losers — ${losersStr} और सावधानियाँ। Turn 10(D): FII/DII प्रवाह और रुपया। Turn 11(A): संस्थागत गतिविधि विश्लेषण। Turn 12(D): जिंस बाज़ार। Turn 13(A): सोना और तेल। Turn 14(D): आज के महत्वपूर्ण events। Turn 15(A): VIX ${vixStr} के संदर्भ में जोशीली विदाई।`
  });

  items.push({ key: "cache:module:0:en", prompt:
    `You are two RJs on MunaFa Café FM — Anurag (male, market expert) and Deepa (female, sharp questions). Today is ${d}.${m0dataEN}\n\nCRITICAL: Use the REAL figures above — do NOT invent numbers.\n\nWrite a 15-turn Morning Market Brief, each turn 40-55 words. Reply ONLY with JSON:\n{"turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}\n\nTurn 1(A): Show intro. Turn 2(D): Yesterday's key events. Turn 3(A): Nifty at ${niftyStr}, Sensex at ${sensexStr} — detailed read. Turn 4(D): Today's direction. Turn 5(A): Technical support/resistance levels. Turn 6(D): Bank Nifty ${bankStr} and sectors. Turn 7(A): Sector breakdown — ${sectorsStr}. Turn 8(D): Today's gainers — ${gainersStr}. Turn 9(A): Losers — ${losersStr} and risk alerts. Turn 10(D): FII/DII flows and rupee. Turn 11(A): Institutional activity analysis. Turn 12(D): Commodities. Turn 13(A): Gold and crude oil. Turn 14(D): Today's key events/results. Turn 15(A): VIX at ${vixStr} — energetic sign-off.`
  });

  // ── MODULE 1 — Company Spotlight ─────────────────────────────────────────
  const m1data = `\n\nToday's market context (use as backdrop): Nifty ${niftyStr} | Sensex ${sensexStr} | Bank Nifty ${bankStr} | India VIX ${vixStr}`;

  items.push({ key: "cache:module:1:hi", prompt:
    `आप MunaFa Café FM के RJ Anurag और Deepa हैं। आज की तारीख है ${d}।${m1data.replace("Today's market context","आज का बाज़ार संदर्भ")}\n\nआज की featured company: NSE/BSE की एक बड़ी कंपनी जो इस सप्ताह खबरों में है। इस market context को ध्यान में रखते हुए कंपनी का विश्लेषण करें। 15 turns, हर turn 40-55 शब्द, शुद्ध हिंदी। सिर्फ JSON:\n{"company":"कंपनी का नाम","turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}\nविषय: परिचय, व्यवसाय, वित्तीय, valuation, तकनीकी, ताकत, जोखिम, FII/DII, हालिया खबर, भविष्य, MF कनेक्शन, निष्कर्ष।`
  });

  items.push({ key: "cache:module:1:en", prompt:
    `You are RJ Anurag and Deepa on MunaFa Café FM. Today is ${d}.${m1data}\n\nPick a prominent NSE/BSE stock in news this week. Analyse it against today's market backdrop. Write 15-turn dialogue, each 40-55 words. Reply ONLY with JSON:\n{"company":"COMPANY NAME","turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}\nCover: intro, business, financials, valuation, technicals, strengths, risks, FII/DII, recent news, outlook, MF angle, conclusion.`
  });

  // ── MODULE 2 — Macro & Economy ────────────────────────────────────────────
  const m2data = `\n\nReal market snapshot: ${S}`;

  items.push({ key: "cache:module:2:hi", prompt:
    `आप MunaFa Café FM के RJ Anurag और Deepa हैं। आज की तारीख है ${d}।${m2data}\n\nविषय: भारत का समष्टि आर्थिक परिदृश्य — RBI नीति, GDP, मुद्रास्फीति, FII/DII प्रवाह, वैश्विक बाज़ार। ऊपर दिए market data को macro context में use करें। 15 turns, हर turn 40-55 शब्द, शुद्ध हिंदी। सिर्फ JSON:\n{"turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}`
  });

  items.push({ key: "cache:module:2:en", prompt:
    `You are RJ Anurag and Deepa on MunaFa Café FM. Today is ${d}.${m2data}\n\nTopic: India's macro picture — RBI policy, GDP, inflation, FII/DII flows, global markets. Use the real market data above as anchor. Write 15-turn dialogue, each 40-55 words. Reply ONLY with JSON:\n{"turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}`
  });

  // ── MODULE 3 — Market Buzz ────────────────────────────────────────────────
  const m3data = `\n\nReal data: Nifty ${niftyStr} | Bank Nifty ${bankStr} | VIX ${vixStr}\nTop Gainers: ${gainersStr}\nTop Losers: ${losersStr}`;

  items.push({ key: "cache:module:3:hi", prompt:
    `आप MunaFa Café FM के RJ Anurag और Deepa हैं। आज की तारीख है ${d}।${m3data}\n\nविषय: आज की बाज़ार की गर्म खबरें — ऊपर दिए real gainers/losers का उल्लेख करें, block deals, insider activity, बड़ी घोषणाएँ। 15 turns, हर turn 40-55 शब्द, शुद्ध हिंदी। सिर्फ JSON:\n{"turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}`
  });

  items.push({ key: "cache:module:3:en", prompt:
    `You are RJ Anurag and Deepa on MunaFa Café FM. Today is ${d}.${m3data}\n\nTopic: today's hot market buzz. Mention the REAL gainers and losers listed above. Add block deals, big announcements, circuit stocks. Write 15-turn dialogue, each 40-55 words. Reply ONLY with JSON:\n{"turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}`
  });

  // ── MODULE 4 — IPO/NFO Radar ──────────────────────────────────────────────
  items.push({ key: "cache:module:4:hi", prompt:
    `आप MunaFa Café FM के RJ Anurag और Deepa हैं। आज की तारीख है ${d}। बाज़ार संदर्भ: Nifty ${niftyStr}, VIX ${vixStr}।\n\nविषय: आने वाले/चालू IPO और NFO — SWOT विश्लेषण, apply करें या नहीं, current market valuation के संदर्भ में। 15 turns, हर turn 40-55 शब्द, शुद्ध हिंदी। सिर्फ JSON:\n{"turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}`
  });

  items.push({ key: "cache:module:4:en", prompt:
    `You are RJ Anurag and Deepa on MunaFa Café FM. Today is ${d}. Market context: Nifty ${niftyStr}, VIX ${vixStr}.\n\nTopic: upcoming and active IPOs and NFOs — SWOT analysis, apply or avoid verdict in context of current market valuations. Write 15-turn dialogue, each 40-55 words. Reply ONLY with JSON:\n{"turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}`
  });

  // ── MODULE 5 — Results Calendar ───────────────────────────────────────────
  items.push({ key: "cache:module:5:hi", prompt:
    `आप MunaFa Café FM के RJ Anurag और Deepa हैं। आज की तारीख है ${d}। बाज़ार: Nifty ${niftyStr} | Sensex ${sensexStr}।\n\nविषय: इस सप्ताह के quarterly results — प्रमुख कंपनियों के परिणाम, पिछली तिमाही से तुलना, बाज़ार पर असर। 15 turns, हर turn 40-55 शब्द, शुद्ध हिंदी। सिर्फ JSON:\n{"turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}`
  });

  items.push({ key: "cache:module:5:en", prompt:
    `You are RJ Anurag and Deepa on MunaFa Café FM. Today is ${d}. Market: Nifty ${niftyStr} | Sensex ${sensexStr}.\n\nTopic: this week's quarterly results — key companies reporting, YoY and QoQ comparison, market impact. Write 15-turn dialogue, each 40-55 words. Reply ONLY with JSON:\n{"turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"D","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"D","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"D","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"D","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"D","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"D","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"D","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}`
  });

  // ── MODULE 6 — Learn Today (no market data needed) ────────────────────────
  items.push({ key: "cache:module:6:hi", prompt:
    `आप MunaFa Café FM के RJ Anurag हैं। आज की तारीख है ${d}। आज एक महत्वपूर्ण निवेश अवधारणा को सरल हिंदी में समझाएँ जो भारतीय खुदरा निवेशकों के लिए उपयोगी हो। 15 turns का Anurag का एकल monologue, हर turn 40-55 शब्द। सिर्फ JSON:\n{"topic":"विषय का नाम","turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"A","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"A","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"A","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"A","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"A","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"A","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"A","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}`
  });

  items.push({ key: "cache:module:6:en", prompt:
    `You are RJ Anurag on MunaFa Café FM. Today is ${d}. Explain one important investing concept useful for Indian retail investors. Write a 15-turn solo monologue, each turn 40-55 words. Reply ONLY with JSON:\n{"topic":"TOPIC NAME","turns":[{"n":1,"s":"A","t":"TEXT"},{"n":2,"s":"A","t":"TEXT"},{"n":3,"s":"A","t":"TEXT"},{"n":4,"s":"A","t":"TEXT"},{"n":5,"s":"A","t":"TEXT"},{"n":6,"s":"A","t":"TEXT"},{"n":7,"s":"A","t":"TEXT"},{"n":8,"s":"A","t":"TEXT"},{"n":9,"s":"A","t":"TEXT"},{"n":10,"s":"A","t":"TEXT"},{"n":11,"s":"A","t":"TEXT"},{"n":12,"s":"A","t":"TEXT"},{"n":13,"s":"A","t":"TEXT"},{"n":14,"s":"A","t":"TEXT"},{"n":15,"s":"A","t":"TEXT"}]}`
  });

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI CALL — Claude → Gemini → GPT fallback
// ─────────────────────────────────────────────────────────────────────────────
async function callAI(prompt) {
  // Claude
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 2048, messages: [{ role: "user", content: prompt }] })
    });
    if (r.ok) { const j = await r.json(); const t = j.content?.[0]?.text || ""; if (t.length > 100) return t; }
  } catch(e) { console.warn("Claude failed:", e.message); }

  // Gemini
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY || ""}`;
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 2048, temperature: 0.7 } })
    });
    if (r.ok) { const j = await r.json(); const t = j.candidates?.[0]?.content?.parts?.[0]?.text || ""; if (t.length > 100) return t; }
  } catch(e) { console.warn("Gemini failed:", e.message); }

  // GPT
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (process.env.OPENAI_API_KEY || "") },
    body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 2048, temperature: 0.7, messages: [{ role: "user", content: prompt }] })
  });
  if (!r.ok) throw new Error("GPT " + r.status);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
