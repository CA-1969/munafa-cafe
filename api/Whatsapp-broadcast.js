// api/whatsapp-broadcast.js — Daily 8am IST WhatsApp broadcast to premium subscribers
// Called by Vercel cron at 02:30 UTC (= 08:00 IST)
// Also callable manually: GET /api/whatsapp-broadcast?secret=YOUR_CRON_SECRET
//
// Requires env vars:
//   WHATSAPP_TOKEN        — Meta WhatsApp Business API token
//   WHATSAPP_PHONE_ID     — WhatsApp Business phone number ID (from Meta)
//   CRON_SECRET           — shared with generate-cache.js
//   KV_REST_API_URL / KV_REST_API_TOKEN — Upstash Redis

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const SITE_URL = "https://munafa-cafe.vercel.app"; // update to your domain

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Security: only cron header OR secret param
  const cronSecret = process.env.CRON_SECRET || "";
  const isCron     = req.headers["x-vercel-cron"] === "1";
  const hasSecret  = cronSecret && req.query.secret === cronSecret;

  if (!isCron && !hasSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const waToken   = process.env.WHATSAPP_TOKEN;
  const phoneId   = process.env.WHATSAPP_PHONE_ID;

  if (!waToken || !phoneId) {
    return res.status(500).json({ error: "WhatsApp credentials not configured. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID in Vercel env vars." });
  }

  // Fetch all premium subscriber phone numbers from Redis
  // Key pattern: sub:<phone> with value containing plan info
  // We scan for all subscriber keys
  let subscribers = [];
  try {
    // Try to get from a dedicated set of premium subscribers
    const premiumSet = await redis.smembers("subscribers:premium");
    if (premiumSet && premiumSet.length > 0) {
      subscribers = premiumSet;
    } else {
      // Fallback: scan sub:* keys and filter active premium ones
      const keys = await redis.keys("sub:*");
      for (const k of keys) {
        try {
          const val = await redis.get(k);
          if (!val) continue;
          const data = typeof val === "string" ? JSON.parse(val) : val;
          // Include if premium and not expired
          if (data.plan && data.plan !== "free" && data.phone) {
            if (!data.expires_at || new Date(data.expires_at) > new Date()) {
              subscribers.push(data.phone);
            }
          }
        } catch(_) {}
      }
    }
  } catch (err) {
    console.error("Failed to fetch subscribers:", err.message);
    return res.status(500).json({ error: "Failed to fetch subscribers", detail: err.message });
  }

  if (subscribers.length === 0) {
    return res.status(200).json({ sent: 0, message: "No premium subscribers found" });
  }

  // Today's date in Indian format
  const today = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });

  // Message text
  const messageText = `🎙️ *MunaFa Café FM* — Good Morning!\n\n📅 ${today}\n\n✅ आज की Morning Brief तैयार है!\nबाज़ार खुलने से पहले हमारी ताज़ा analysis सुनें।\n\n🔗 अभी सुनें: ${SITE_URL}\n\n💡 _MunaFa Café — Paisa Samajhna Aasan Hai_ ☕`;

  // Send to each subscriber
  let sent = 0, failed = 0;
  const errors = [];

  for (const phone of subscribers) {
    try {
      // Normalize phone: ensure international format (91XXXXXXXXXX for India)
      const normalized = normalizePhone(phone);
      if (!normalized) {
        errors.push({ phone, error: "Invalid number format" });
        failed++;
        continue;
      }

      const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + waToken
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: normalized,
          type: "text",
          text: { body: messageText }
        })
      });

      if (r.ok) {
        sent++;
      } else {
        const errBody = await r.text();
        errors.push({ phone: normalized, error: errBody.slice(0, 100) });
        failed++;
      }

      // Rate-limit: 80 messages/second max for WhatsApp Business API
      // Add small delay to stay safe
      await sleep(15);

    } catch (e) {
      errors.push({ phone, error: e.message });
      failed++;
    }
  }

  // Log result
  const result = {
    sent, failed, total: subscribers.length,
    timestamp: new Date().toISOString(),
    errors: errors.slice(0, 10) // cap error list
  };

  // Store last broadcast info in Redis
  await redis.set("broadcast:last", JSON.stringify(result), { ex: 90000 }); // 25h TTL

  console.log("WhatsApp broadcast complete:", result);
  return res.status(200).json(result);
}

function normalizePhone(phone) {
  // Remove spaces, dashes, parentheses
  let p = String(phone).replace(/[\s\-\(\)]/g, "");
  // Remove leading +
  if (p.startsWith("+")) p = p.slice(1);
  // Add 91 if 10-digit Indian number
  if (p.length === 10 && /^[6-9]/.test(p)) p = "91" + p;
  // Validate: must be 12 digits starting with 91 for India
  if (!/^\d{10,15}$/.test(p)) return null;
  return p;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
