// api/sms-broadcast.js — Daily 8am IST SMS broadcast to premium subscribers
// via Fast2SMS (instant signup, no business verification needed)
//
// Called by Vercel cron at 02:30 UTC (= 08:00 IST)
// Also callable manually: GET /api/sms-broadcast?secret=YOUR_CRON_SECRET
//
// Vercel env vars required:
//   FAST2SMS_API_KEY        — from fast2sms.com dashboard → API section
//   CRON_SECRET             — any random string you set
//   KV_REST_API_URL         — Upstash Redis URL
//   KV_REST_API_TOKEN       — Upstash Redis token
//
// When WhatsApp BSP is ready later, swap the sendSMS() call with sendWhatsApp()
// (stub included at the bottom of this file)

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

// ── Update this to your live domain ──────────────────────────────────────────
const SITE_URL = "https://munafa-cafe.vercel.app";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Security: only Vercel cron header OR secret query param
  const cronSecret = process.env.CRON_SECRET || "";
  const isCron     = req.headers["x-vercel-cron"] === "1";
  const hasSecret  = cronSecret && req.query.secret === cronSecret;

  if (!isCron && !hasSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "FAST2SMS_API_KEY not set in Vercel env vars" });
  }

  // ── Fetch premium subscriber phone numbers from Redis ─────────────────────
  let phones = [];
  try {
    // Primary: Redis Set "subscribers:premium" → plain 10-digit numbers
    const premiumSet = await redis.smembers("subscribers:premium");
    if (premiumSet && premiumSet.length > 0) {
      phones = premiumSet.map(normalizePhone).filter(Boolean);
    } else {
      // Fallback: scan sub:* keys for active premium subscribers
      const keys = await redis.keys("sub:*");
      for (const k of keys) {
        try {
          const val = await redis.get(k);
          if (!val) continue;
          const data = typeof val === "string" ? JSON.parse(val) : val;
          if (data.plan && data.plan !== "free" && data.phone) {
            if (!data.expires_at || new Date(data.expires_at) > new Date()) {
              const p = normalizePhone(data.phone);
              if (p) phones.push(p);
            }
          }
        } catch(_) {}
      }
    }
  } catch (err) {
    console.error("Redis fetch failed:", err.message);
    return res.status(500).json({ error: "Redis error", detail: err.message });
  }

  if (phones.length === 0) {
    return res.status(200).json({ sent: 0, message: "No premium subscribers found" });
  }

  // ── Today's date ──────────────────────────────────────────────────────────
  const today = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short", day: "numeric", month: "short"
  });

  // ── SMS message (160 chars max for single SMS; keep under 150 to be safe) ─
  // Fast2SMS supports Unicode so Hindi/Hinglish works fine
  const message =
    `MunaFa Cafe FM - Subah ka Brief tayar hai! ` +
    `Aaj (${today}) ke baazar ki puri analysis aur scripts ready hain. ` +
    `Abhi suniye: ${SITE_URL}`;

  // ── Send in batches of 200 (Fast2SMS limit per API call) ──────────────────
  const BATCH = 200;
  let sent = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < phones.length; i += BATCH) {
    const batch = phones.slice(i, i + BATCH);
    try {
      const result = await sendSMS(apiKey, batch, message);
      if (result.return === true) {
        sent += batch.length;
      } else {
        failed += batch.length;
        errors.push(result.message || "Unknown Fast2SMS error");
      }
    } catch (e) {
      failed += batch.length;
      errors.push(e.message);
    }
    // Small delay between batches
    if (i + BATCH < phones.length) await sleep(500);
  }

  const result = {
    sent, failed,
    total: phones.length,
    timestamp: new Date().toISOString(),
    errors: errors.slice(0, 5)
  };

  // Store last broadcast info in Redis (25h TTL)
  await redis.set("broadcast:last_sms", JSON.stringify(result), { ex: 90000 });

  console.log("SMS broadcast complete:", result);
  return res.status(200).json(result);
}

// ── Fast2SMS API call ─────────────────────────────────────────────────────────
async function sendSMS(apiKey, phoneNumbers, message) {
  // Fast2SMS Quick SMS (no DLT template needed for transactional/quick route)
  // Numbers must be 10-digit Indian mobile numbers, comma-separated
  const numbers = phoneNumbers.join(",");

  const r = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
      "authorization": apiKey,
      "Content-Type":  "application/json"
    },
    body: JSON.stringify({
      route:    "q",          // "q" = Quick SMS route (no DLT template required)
      message:  message,
      language: "english",   // use "unicode" if sending Hindi/Devanagari text
      flash:    0,
      numbers:  numbers
    })
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Fast2SMS HTTP ${r.status}: ${txt.slice(0, 100)}`);
  }

  return await r.json();
  // Expected success response: { return: true, request_id: "...", message: [...] }
}

// ── Phone number normalizer (returns 10-digit Indian number or null) ──────────
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[\s\-\(\)\+]/g, "");
  // Strip country code 91 if present
  if (p.startsWith("91") && p.length === 12) p = p.slice(2);
  // Must be 10 digits starting with 6-9 (Indian mobile)
  if (/^[6-9]\d{9}$/.test(p)) return p;
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP STUB — swap in when Meta BSP is approved
// Replace the sendSMS() call in the main loop with sendWhatsApp() below
// ─────────────────────────────────────────────────────────────────────────────
/*
async function sendWhatsApp(phone10digit, message) {
  // Works with AiSensy, Interakt, Wati, or direct Meta API
  // For AiSensy: use their broadcast API with campaign name
  // For direct Meta API:
  const waToken  = process.env.WHATSAPP_TOKEN;
  const phoneId  = process.env.WHATSAPP_PHONE_ID;
  const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + waToken
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to:   "91" + phone10digit,
      type: "text",
      text: { body: message }
    })
  });
  return r.ok;
}
*/
