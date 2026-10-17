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

  // ── SINGLE MODULE MODE: ?mi=X&lang=hi|en ─────────────────────────────────
  // Called per-module from the admin Regen button (fits in Vercel 10s limit)
  if (req.query.mi !== undefined) {
    const mi   = parseInt(req.query.mi, 10);
    const lang = req.query.lang === "en" ? "en" : "hi";
    if (isNaN(mi) || mi < 0 || mi > 6) return res.status(400).json({ error: "Invalid mi" });

    const mkt = await fetchMarketData();
    const modules = buildPrompts(dateStr, mkt);

    // keys are built as cache:module:{mi}:{lang}, filter to the one we want
    const target = modules.find(m => m.key === `cache:module:${mi}:${lang}`);
    if (!target) return res.status(400).json({ error: "Module not found" });

    try {
      const raw     = await callAI(target.prompt);
      const content = cleanJSON(raw);
      if (content && content.length > 100) {
        await redis.set(target.key, content, { ex: CACHE_TTL });
        // Save market snapshot and generated_at on every call (cheap overwrite)
        await redis.set("cache:generated_at",     new Date().toISOString(),  { ex: CACHE_TTL });
        await redis.set("cache:market_snapshot",  JSON.stringify(mkt),       { ex: CACHE_TTL });
        return res.status(200).json({ key: target.key, status: "ok", len: content.length });
      } else {
        return res.status(200).json({ key: target.key, status: "empty" });
      }
    } catch(e) {
      return res.status(500).json({ key: target.key, status: "error", error: e.message });
    }
  }

  // ── FULL BATCH MODE: cron or ?secret= without mi ─────────────────────────
  const mkt = await fetchMarketData();
  console.log("Market data:", JSON.stringify(mkt));
  const modules = buildPrompts(dateStr, mkt);

  const results = [];
  let success = 0, failed = 0;

  for (const { key, prompt } of modules) {
    try {
      const raw = await callAI(prompt);
      const content = cleanJSON(raw);
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
    await sleep(1000);
  }

  await redis.set("cache:generated_at", new Date().toISOString(), { ex: CACHE_TTL });
  await redis.set("cache:market_snapshot", JSON.stringify(mkt), { ex: CACHE_TTL });

  return res.status(200).json({ generated_at: new Date().toISOString(), success, failed, market: mkt, results });
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL MARKET DATA — via internal /api/nse-proxy (Angel One → Stooq fallback)
// Calling own endpoint avoids Vercel outbound allowlist issues with stooq.com
// ─────────────────────────────────────────────────────────────────────────────

function fmt(val, dec = 2) {
  if (val == null || isNaN(val)) return "N/A";
  return Number(val).toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtChg(val) {
  if (val == null || isNaN(val)) return "N/A";
  return (val >= 0 ? "+" : "") + fmt(val);
}
function fmtPct(val) {
  if (val == null || isNaN(val)) return "N/A";
  return (val >= 0 ? "+" : "") + fmt(val) + "%";
}

// ── Stooq direct fetch (used as second fallback when nse-proxy returns nulls) ──
const STOOQ_IDX = [
  { sym: "^nsei",      name: "NIFTY 50"         },
  { sym: "^bsesn",     name: "S&P BSE SENSEX"   },
  { sym: "^nsebank",   name: "NIFTY BANK"       },
  { sym: "^cnxmc",     name: "NIFTY MIDCAP 100" },
  { sym: "^cnxit",     name: "NIFTY IT"         },
  { sym: "^cnxauto",   name: "NIFTY AUTO"       },
  { sym: "^cnxfmcg",   name: "NIFTY FMCG"      },
  { sym: "^cnxpharma", name: "NIFTY PHARMA"    },
  { sym: "^indiavix",  name: "INDIA VIX"        }
];
async function stooqOne(sym) {
  const url = `https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) return null;
  const text = await r.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;
  const [,, , , high, low, close] = lines[1].split(",");
  // line[1] fields: sym,date,time,open,high,low,close,volume
  const parts = lines[1].split(",");
  const o = parseFloat(parts[3]), h = parseFloat(parts[4]), l = parseFloat(parts[5]), c = parseFloat(parts[6]);
  if (!c || isNaN(c)) return null;
  const chg = c - o;
  const pct = o ? (chg/o)*100 : 0;
  return { last: c, change: chg, pct, open: o, high: h, low: l, prev: o };
}
async function fetchStooqDirect() {
  const results = await Promise.allSettled(STOOQ_IDX.map(i => stooqOne(i.sym)));
  const indices = STOOQ_IDX.map(({ name }, idx) => {
    const r = results[idx].status === "fulfilled" ? results[idx].value : null;
    if (!r) return { name, last: null, change: null, pct: null, open: null, high: null, low: null, prev: null };
    return { name, ...r };
  });
  return { indices };
}

async function fetchMarketData() {
  // Call our own nse-proxy endpoint — same domain, always allowed
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://munafa-cafe.vercel.app";

  let indicesData = null, gainersData = null, losersData = null;

  try {
    const [ri, rg, rl] = await Promise.all([
      fetch(`${base}/api/nse-proxy?type=indices`,  { signal: AbortSignal.timeout(8000) }),
      fetch(`${base}/api/nse-proxy?type=gainers`,  { signal: AbortSignal.timeout(8000) }),
      fetch(`${base}/api/nse-proxy?type=losers`,   { signal: AbortSignal.timeout(8000) })
    ]);
    if (ri.ok) indicesData = await ri.json();
    if (rg.ok) gainersData = await rg.json();
    if (rl.ok) losersData  = await rl.json();
    console.log("nse-proxy ok — Nifty:",
      indicesData?.indices?.find(i=>i.name==="NIFTY 50")?.last ?? "null");
  } catch(e) {
    console.warn("nse-proxy fetch failed:", e.message);
  }

  // If nse-proxy returned no index data (all nulls), try Stooq directly
  const niftyCheck = indicesData?.indices?.find(i => i.name === "NIFTY 50");
  if (!niftyCheck?.last) {
    console.warn("nse-proxy returned no index data — trying Stooq directly");
    try {
      indicesData = await fetchStooqDirect();
      console.log("Stooq direct ok — Nifty:", indicesData?.indices?.find(i=>i.name==="NIFTY 50")?.last ?? "null");
    } catch(e2) {
      console.warn("Stooq direct also failed:", e2.message);
    }
  }

  // Parse indices
  const find = (name) => indicesData?.indices?.find(i => i.name === name) || null;
  const nifty     = find("NIFTY 50");
  const sensex    = find("S&P BSE SENSEX");
  const bankNifty = find("NIFTY BANK");
  const midcap    = find("NIFTY MIDCAP 100");
  const vix       = find("INDIA VIX");
  const niftyIT   = find("NIFTY IT");
  const niftyFMCG = find("NIFTY FMCG");
  const niftyPharma = find("NIFTY PHARMA");
  const niftyAuto = find("NIFTY AUTO");

  // Parse gainers/losers (top 5 each)
  const gainers = (gainersData?.stocks || []).slice(0, 5);
  const losers  = (losersData?.stocks  || []).slice(0, 5);

  const n = (idx) => idx ? { val: fmt(idx.last, 0), chg: fmtChg(idx.change), pct: fmtPct(idx.pct), high: fmt(idx.high, 0), low: fmt(idx.low, 0) } : null;

  return {
    nifty:     n(nifty),
    sensex:    n(sensex),
    bankNifty: n(bankNifty),
    midcap:    midcap ? { val: fmt(midcap.last, 0), pct: fmtPct(midcap.pct) } : null,
    vix:       vix    ? { val: fmt(vix.last),        pct: fmtPct(vix.pct)   } : null,
    sectors: {
      it:     niftyIT    ? fmtPct(niftyIT.pct)    : "N/A",
      fmcg:   niftyFMCG  ? fmtPct(niftyFMCG.pct)  : "N/A",
      pharma: niftyPharma? fmtPct(niftyPharma.pct) : "N/A",
      auto:   niftyAuto  ? fmtPct(niftyAuto.pct)   : "N/A"
    },
    gainers: gainers.map(s => `${s.symbol} ${fmtPct(s.pct)}`).join(", ") || "",
    losers:  losers.map(s  => `${s.symbol} ${fmtPct(s.pct)}`).join(", ") || "",
    summary: buildSummary(nifty, sensex, bankNifty, vix, gainers, losers)
  };
}

function buildSummary(nifty, sensex, bankNifty, vix, gainers, losers) {
  const lines = [];
  if (nifty)     lines.push(`Nifty 50: ${fmt(nifty.last, 0)} (${fmtChg(nifty.change)}, ${fmtPct(nifty.pct)}) | High: ${fmt(nifty.high, 0)} | Low: ${fmt(nifty.low, 0)}`);
  if (sensex)    lines.push(`Sensex: ${fmt(sensex.last, 0)} (${fmtChg(sensex.change)}, ${fmtPct(sensex.pct)})`);
  if (bankNifty) lines.push(`Bank Nifty: ${fmt(bankNifty.last, 0)} (${fmtChg(bankNifty.change)}, ${fmtPct(bankNifty.pct)})`);
  if (vix)       lines.push(`India VIX: ${fmt(vix.last)} (${fmtPct(vix.pct)})`);
  if (gainers.length) lines.push(`Top Gainers: ${gainers.map(s => `${s.symbol} ${fmtPct(s.pct)}`).join(", ")}`);
  if (losers.length)  lines.push(`Top Losers: ${losers.map(s  => `${s.symbol} ${fmtPct(s.pct)}`).join(", ")}`);
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
    `आप MunaFa Café FM के दो RJ हैं — Anurag (पुरुष, बाज़ार विशेषज्ञ) और Deepa (महिला, जो सरल और तीखे सवाल पूछती हैं)। आज की तारीख है ${d}।${m0dataHI}\n\nमहत्वपूर्ण निर्देश:\n- ऊपर दिए गए REAL आंकड़ों का उपयोग करें। कोई काल्पनिक संख्या न दें।\n- शो में नाम केवल "Anurag" बोलें — "RJ Anurag" कभी नहीं।\n- IMPORTANT: केवल raw JSON दें। कोई markdown fences नहीं, कोई \`\`\`json नहीं।\n- भाषा: शुद्ध हिंदी। केवल ये अंग्रेज़ी शब्द रखें: Nifty, Sensex, Bank Nifty, SIP, NAV, FII, DII, EBITDA, GDP, IPO, NFO, RSI, VIX।\n- मुद्रा शब्दों में लिखें।\n\n15 turns का संवाद लिखें, हर turn 40-55 शब्द। सिर्फ यह JSON दें:\n{"turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"D","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"D","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"D","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"D","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"D","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"D","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"D","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}\n\nTurn 1(A): शो का परिचय। Turn 2(D): कल की मुख्य घटनाएँ। Turn 3(A): Nifty ${niftyStr} और Sensex ${sensexStr} — विस्तृत विवरण। Turn 4(D): आज की संभावित दिशा। Turn 5(A): तकनीकी support/resistance। Turn 6(D): Bank Nifty ${bankStr} और क्षेत्र। Turn 7(A): Sectors — ${sectorsStr}। Turn 8(D): आज के gainers — ${gainersStr}। Turn 9(A): आज के losers — ${losersStr} और सावधानियाँ। Turn 10(D): FII/DII प्रवाह और रुपया। Turn 11(A): संस्थागत गतिविधि विश्लेषण। Turn 12(D): जिंस बाज़ार। Turn 13(A): सोना और तेल। Turn 14(D): आज के महत्वपूर्ण events। Turn 15(A): VIX ${vixStr} के संदर्भ में जोशीली विदाई।`
  });

  items.push({ key: "cache:module:0:en", prompt:
    `You are two RJs on MunaFa Café FM — Anurag (male, market expert) and Deepa (female, sharp questions). Today is ${d}.${m0dataEN}\n\nCRITICAL: Use the REAL figures above — do NOT invent numbers. Never say "RJ Anurag" — say "Anurag" only.\nIMPORTANT: Reply with ONLY raw JSON. No markdown fences, no \`\`\`json, no explanation.\n\nWrite a 15-turn Morning Market Brief, each turn 40-55 words. Reply ONLY with JSON:\n{"turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"D","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"D","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"D","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"D","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"D","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"D","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"D","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}\n\nTurn 1(A): Show intro. Turn 2(D): Yesterday's key events. Turn 3(A): Nifty at ${niftyStr}, Sensex at ${sensexStr} — detailed read. Turn 4(D): Today's direction. Turn 5(A): Technical support/resistance levels. Turn 6(D): Bank Nifty ${bankStr} and sectors. Turn 7(A): Sector breakdown — ${sectorsStr}. Turn 8(D): Today's gainers — ${gainersStr}. Turn 9(A): Losers — ${losersStr} and risk alerts. Turn 10(D): FII/DII flows and rupee. Turn 11(A): Institutional activity analysis. Turn 12(D): Commodities. Turn 13(A): Gold and crude oil. Turn 14(D): Today's key events/results. Turn 15(A): VIX at ${vixStr} — energetic sign-off.`
  });

  // ── MODULE 1 — Company Spotlight ─────────────────────────────────────────
  const m1data = `\n\nToday's market context (use as backdrop): Nifty ${niftyStr} | Sensex ${sensexStr} | Bank Nifty ${bankStr} | India VIX ${vixStr}`;

  items.push({ key: "cache:module:1:hi", prompt:
    `आप MunaFa Café FM के Anurag और Deepa हैं। नाम केवल "Anurag" बोलें। IMPORTANT: केवल raw JSON दें, कोई markdown fences नहीं। आज की तारीख है ${d}।${m1data.replace("Today's market context","आज का बाज़ार संदर्भ")}\n\nआज की featured company: NSE/BSE की एक बड़ी कंपनी जो इस सप्ताह खबरों में है। इस market context को ध्यान में रखते हुए कंपनी का विश्लेषण करें। 15 turns, हर turn 40-55 शब्द, शुद्ध हिंदी। सिर्फ JSON:\n{"company":"कंपनी का असली नाम","turns":[{"n":1,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":2,"s":"D","t":"[40-55 शब्दों की असली script]"},{"n":3,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":4,"s":"D","t":"[40-55 शब्दों की असली script]"},{"n":5,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":6,"s":"D","t":"[40-55 शब्दों की असली script]"},{"n":7,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":8,"s":"D","t":"[40-55 शब्दों की असली script]"},{"n":9,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":10,"s":"D","t":"[40-55 शब्दों की असली script]"},{"n":11,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":12,"s":"D","t":"[40-55 शब्दों की असली script]"},{"n":13,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":14,"s":"D","t":"[40-55 शब्दों की असली script]"},{"n":15,"s":"A","t":"[40-55 शब्दों की असली script]"}]}\nविषय: परिचय, व्यवसाय, वित्तीय, valuation, तकनीकी, ताकत, जोखिम, FII/DII, हालिया खबर, भविष्य, MF कनेक्शन, निष्कर्ष।`
  });

  items.push({ key: "cache:module:1:en", prompt:
    `You are Anurag and Deepa on MunaFa Café FM. Say "Anurag" not "RJ Anurag". IMPORTANT: Reply with ONLY raw JSON, no markdown fences. Today is ${d}.${m1data}\n\nPick a prominent NSE/BSE stock in news this week. Analyse it against today's market backdrop. Write 15-turn dialogue, each 40-55 words. Reply ONLY with JSON:\n{"company":"ACTUAL COMPANY NAME","turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"D","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"D","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"D","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"D","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"D","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"D","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"D","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}\nCover: intro, business, financials, valuation, technicals, strengths, risks, FII/DII, recent news, outlook, MF angle, conclusion.`
  });

  // ── MODULE 2 — Macro & Economy ────────────────────────────────────────────
  const m2data = `\n\nReal market snapshot: ${S}`;

  items.push({ key: "cache:module:2:hi", prompt:
    `आप MunaFa Café FM के Anurag और Deepa हैं। नाम केवल "Anurag" बोलें। IMPORTANT: केवल raw JSON दें, कोई markdown fences नहीं। आज की तारीख है ${d}।${m2data}\n\nविषय: भारत का समष्टि आर्थिक परिदृश्य — RBI नीति, GDP, मुद्रास्फीति, FII/DII प्रवाह, वैश्विक बाज़ार। ऊपर दिए market data को macro context में use करें। 15 turns, हर turn 40-55 शब्द, शुद्ध हिंदी। सिर्फ JSON:\n{"turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"D","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"D","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"D","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"D","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"D","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"D","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"D","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}`
  });

  items.push({ key: "cache:module:2:en", prompt:
    `You are Anurag and Deepa on MunaFa Café FM. Say "Anurag" not "RJ Anurag". IMPORTANT: Reply with ONLY raw JSON, no markdown fences. Today is ${d}.${m2data}\n\nTopic: India's macro picture — RBI policy, GDP, inflation, FII/DII flows, global markets. Use the real market data above as anchor. Write 15-turn dialogue, each 40-55 words. Reply ONLY with JSON:\n{"turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"D","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"D","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"D","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"D","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"D","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"D","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"D","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}`
  });

  // ── MODULE 3 — Market Buzz ────────────────────────────────────────────────
  const m3data = `\n\nReal data: Nifty ${niftyStr} | Bank Nifty ${bankStr} | VIX ${vixStr}\nTop Gainers: ${gainersStr}\nTop Losers: ${losersStr}`;

  items.push({ key: "cache:module:3:hi", prompt:
    `आप MunaFa Café FM के Anurag और Deepa हैं। नाम केवल "Anurag" बोलें। IMPORTANT: केवल raw JSON दें, कोई markdown fences नहीं। आज की तारीख है ${d}।${m3data}\n\nविषय: आज की बाज़ार की गर्म खबरें — ऊपर दिए real gainers/losers का उल्लेख करें, block deals, insider activity, बड़ी घोषणाएँ। 15 turns, हर turn 40-55 शब्द, शुद्ध हिंदी। सिर्फ JSON:\n{"turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"D","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"D","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"D","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"D","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"D","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"D","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"D","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}`
  });

  items.push({ key: "cache:module:3:en", prompt:
    `You are Anurag and Deepa on MunaFa Café FM. Say "Anurag" not "RJ Anurag". IMPORTANT: Reply with ONLY raw JSON, no markdown fences. Today is ${d}.${m3data}\n\nTopic: today's hot market buzz. Mention the REAL gainers and losers listed above. Add block deals, big announcements, circuit stocks. Write 15-turn dialogue, each 40-55 words. Reply ONLY with JSON:\n{"turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"D","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"D","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"D","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"D","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"D","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"D","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"D","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}`
  });

  // ── MODULE 4 — IPO/NFO Radar ──────────────────────────────────────────────
  items.push({ key: "cache:module:4:hi", prompt:
    `आप MunaFa Café FM के Anurag और Deepa हैं। नाम केवल "Anurag" बोलें। IMPORTANT: केवल raw JSON दें। आज की तारीख है ${d}। बाज़ार संदर्भ: Nifty ${niftyStr}, VIX ${vixStr}।\n\nविषय: आने वाले/चालू IPO और NFO — SWOT विश्लेषण, apply करें या नहीं, current market valuation के संदर्भ में। 15 turns, हर turn 40-55 शब्द, शुद्ध हिंदी। सिर्फ JSON:\n{"turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"D","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"D","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"D","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"D","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"D","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"D","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"D","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}`
  });

  items.push({ key: "cache:module:4:en", prompt:
    `You are Anurag and Deepa on MunaFa Café FM. Say "Anurag" only. IMPORTANT: Reply with ONLY raw JSON, no markdown fences. Today is ${d}. Market context: Nifty ${niftyStr}, VIX ${vixStr}.\n\nTopic: upcoming and active IPOs and NFOs — SWOT analysis, apply or avoid verdict in context of current market valuations. Write 15-turn dialogue, each 40-55 words. Reply ONLY with JSON:\n{"turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"D","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"D","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"D","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"D","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"D","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"D","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"D","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}`
  });

  // ── MODULE 5 — Results Calendar ───────────────────────────────────────────
  items.push({ key: "cache:module:5:hi", prompt:
    `आप MunaFa Café FM के Anurag और Deepa हैं। नाम केवल "Anurag" बोलें। IMPORTANT: केवल raw JSON दें। आज की तारीख है ${d}। बाज़ार: Nifty ${niftyStr} | Sensex ${sensexStr}।\n\nविषय: इस सप्ताह के quarterly results — प्रमुख कंपनियों के परिणाम, पिछली तिमाही से तुलना, बाज़ार पर असर। 15 turns, हर turn 40-55 शब्द, शुद्ध हिंदी। सिर्फ JSON:\n{"turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"D","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"D","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"D","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"D","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"D","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"D","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"D","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}`
  });

  items.push({ key: "cache:module:5:en", prompt:
    `You are Anurag and Deepa on MunaFa Café FM. Say "Anurag" only. IMPORTANT: Reply with ONLY raw JSON, no markdown fences. Today is ${d}. Market: Nifty ${niftyStr} | Sensex ${sensexStr}.\n\nTopic: this week's quarterly results — key companies reporting, YoY and QoQ comparison, market impact. Write 15-turn dialogue, each 40-55 words. Reply ONLY with JSON:\n{"turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"D","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"D","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"D","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"D","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"D","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"D","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"D","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}`
  });

  // ── MODULE 6 — Learn Today (no market data needed) ────────────────────────
  // Pick today's topic deterministically from a 60-topic list using day-of-year as seed
  // This ensures a DIFFERENT topic every day, with no random repeats
  const LEARN_TOPICS_HI = [
    "SIP (Systematic Investment Plan) क्या है","P/E Ratio समझना","Mutual Fund NAV","Index Fund vs Active Fund",
    "Debt Fund कैसे काम करते हैं","ELSS Tax Saving Fund","Dividend vs Growth Option",
    "Stop Loss का महत्व","Risk-Reward Ratio","Asset Allocation क्यों जरूरी है",
    "Book Value और Market Value का अंतर","EPS (Earnings Per Share)","ROE और ROCE",
    "Market Cap: Large, Mid, Small Cap","Sector Rotation Strategy","Gold में निवेश: सही या गलत",
    "PPF vs ELSS: कहाँ निवेश करें","RD vs SIP: अंतर समझें","Bond और Debenture",
    "IPO में निवेश: सही तरीका","Circuit Breaker और Upper/Lower Circuit",
    "F&O: Futures और Options","Options Premium कैसे काम करती है","Beta क्या है",
    "Dividend Yield","Free Cash Flow","Working Capital Management","Debt-to-Equity Ratio",
    "Promoter Holding का महत्व","FII और DII का असर","Rupee Cost Averaging",
    "Compounding: निवेश की जादुई शक्ति","Emergency Fund क्यों ज़रूरी","Term Insurance vs Investment",
    "Inflation और Real Return","Credit Rating क्या होती है","SEBI की भूमिका",
    "Demat Account कैसे काम करता है","T+1 Settlement","Corporate Actions: Bonus, Split, Buyback",
    "Rights Issue","ESOP (Employee Stock Options)","Pledging of Shares",
    "Technical Analysis: Support और Resistance","Moving Average","RSI Indicator",
    "Volume Analysis","Candlestick Patterns","52-Week High/Low Strategy",
    "Swing Trading vs Long-term Investing","Arbitrage क्या है","Liquid Fund",
    "Overnight Fund","Gilt Fund","International Fund में निवेश","ETF vs Index Fund",
    "Gold ETF","REITs: Real Estate Investment Trusts","SGBs (Sovereign Gold Bonds)"
  ];
  const LEARN_TOPICS_EN = [
    "What is SIP and Why It Works","Understanding P/E Ratio","How Mutual Fund NAV Works",
    "Index Fund vs Active Fund","How Debt Funds Work","ELSS Tax Saving Funds",
    "Dividend vs Growth Option","Importance of Stop Loss","Risk-Reward Ratio Explained",
    "Why Asset Allocation Matters","Book Value vs Market Value","Understanding EPS",
    "ROE and ROCE for Stock Analysis","Market Cap Categories Explained","Sector Rotation Strategy",
    "Gold as an Investment","PPF vs ELSS: Where to Invest","RD vs SIP: Key Differences",
    "Bonds and Debentures Explained","How to Apply for an IPO","Circuit Breakers Explained",
    "Futures and Options Basics","How Options Premium Works","What is Beta",
    "Dividend Yield Analysis","Understanding Free Cash Flow","Working Capital Management",
    "Debt-to-Equity Ratio","Why Promoter Holding Matters","Impact of FII and DII",
    "Rupee Cost Averaging","Power of Compounding","Why Emergency Fund is Essential",
    "Term Insurance vs ULIP","Inflation and Real Return","Credit Ratings Explained",
    "Role of SEBI","How Demat Account Works","T+1 Settlement System",
    "Corporate Actions: Bonus, Split, Buyback","Rights Issue Explained","ESOPs Explained",
    "Share Pledging by Promoters","Support and Resistance in Technical Analysis",
    "Moving Average Strategy","RSI Indicator","Volume Analysis","Candlestick Patterns",
    "52-Week High/Low Investing","Swing Trading vs Long-term Investing","What is Arbitrage",
    "Liquid Funds","Overnight Funds","Gilt Funds","International Funds",
    "ETF vs Index Fund","Gold ETF","REITs Explained","Sovereign Gold Bonds"
  ];
  // Day-of-year index ensures a different topic every day, cycling through 60 topics
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const dayOfYear = Math.floor((ist - new Date(ist.getFullYear(), 0, 0)) / 86400000);
  const topicIdx = dayOfYear % LEARN_TOPICS_HI.length;
  const todayTopicHI = LEARN_TOPICS_HI[topicIdx];
  const todayTopicEN = LEARN_TOPICS_EN[topicIdx];
  const tomorrowTopicHI = LEARN_TOPICS_HI[(topicIdx + 1) % LEARN_TOPICS_HI.length];
  const tomorrowTopicEN = LEARN_TOPICS_EN[(topicIdx + 1) % LEARN_TOPICS_EN.length];

  items.push({ key: "cache:module:6:hi", prompt:
    `आप MunaFa Café FM के Anurag हैं। नाम "Anurag" बोलें। IMPORTANT: केवल raw JSON दें, कोई markdown fences नहीं।\n\nआज की तारीख है ${d}।\nआज का FIXED विषय है: "${todayTopicHI}" — यही विषय पढ़ाएँ, कोई दूसरा नहीं।\nकल का विषय "${tomorrowTopicHI}" होगा — आज वो नहीं पढ़ाना।\n\n15 turns का Anurag का एकल monologue, हर turn 40-55 शब्द। सिर्फ JSON:\n{"topic":"${todayTopicHI}","turns":[{"n":1,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":2,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":3,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":4,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":5,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":6,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":7,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":8,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":9,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":10,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":11,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":12,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":13,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":14,"s":"A","t":"[40-55 शब्दों की असली script]"},{"n":15,"s":"A","t":"[40-55 शब्दों की असली script]"}]}`
  });

  items.push({ key: "cache:module:6:en", prompt:
    `You are Anurag on MunaFa Café FM. Say "Anurag" only, never "RJ Anurag". IMPORTANT: Reply with ONLY raw JSON, no markdown fences.\n\nToday is ${d}.\nToday's FIXED topic is: "${todayTopicEN}" — teach ONLY this topic, no other.\nTomorrow's topic will be "${tomorrowTopicEN}" — do NOT teach it today.\n\nWrite a 15-turn solo monologue, each turn 40-55 words. Reply ONLY with JSON:\n{"topic":"${todayTopicEN}","turns":[{"n":1,"s":"A","t":"[write 40-55 word script here]"},{"n":2,"s":"A","t":"[write 40-55 word script here]"},{"n":3,"s":"A","t":"[write 40-55 word script here]"},{"n":4,"s":"A","t":"[write 40-55 word script here]"},{"n":5,"s":"A","t":"[write 40-55 word script here]"},{"n":6,"s":"A","t":"[write 40-55 word script here]"},{"n":7,"s":"A","t":"[write 40-55 word script here]"},{"n":8,"s":"A","t":"[write 40-55 word script here]"},{"n":9,"s":"A","t":"[write 40-55 word script here]"},{"n":10,"s":"A","t":"[write 40-55 word script here]"},{"n":11,"s":"A","t":"[write 40-55 word script here]"},{"n":12,"s":"A","t":"[write 40-55 word script here]"},{"n":13,"s":"A","t":"[write 40-55 word script here]"},{"n":14,"s":"A","t":"[write 40-55 word script here]"},{"n":15,"s":"A","t":"[write 40-55 word script here]"}]}`
  });

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLEAN JSON — strip markdown fences, extract outermost { } object
// ─────────────────────────────────────────────────────────────────────────────
function cleanJSON(text) {
  if (!text) return "";
  // 1. Strip ALL markdown fences globally (```json, ```, etc.)
  let s = text.replace(/```(?:json)?\s*/gi, "").trim();
  // 2. Normalize problematic Unicode that breaks JSON.parse on frontend
  s = s
    .replace(/–/g, "-")         // en-dash
    .replace(/—/g, "-")         // em-dash
    .replace(/‘|’/g, "'")  // smart single quotes
    .replace(/“|”/g, '"')  // smart double quotes
    .replace(/…/g, "...")        // ellipsis
    .replace(/ /g, " ");        // non-breaking space
  // 3. Extract from first { to last } (removes any surrounding text)
  const start = s.indexOf("{");
  const end   = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    s = s.slice(start, end + 1);
  }
  // 4. Quick validity check — if it parses, great; if not, do char-by-char repair
  try { JSON.parse(s); return s; } catch(_) {}
  // 5. Char-by-char: fix unescaped newlines/tabs inside string values
  let fixed = ""; let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { fixed += c; esc = false; continue; }
    if (c === "\\") { esc = true; fixed += c; continue; }
    if (c === '"') { inStr = !inStr; fixed += c; continue; }
    if (inStr && (c === "\n" || c === "\r")) { fixed += " "; continue; }
    if (inStr && c === "\t") { fixed += " "; continue; }
    fixed += c;
  }
  // 6. Remove trailing commas before } or ] (common GPT mistake)
  fixed = fixed.replace(/,(\s*[}\]])/g, "$1");
  return fixed;
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
