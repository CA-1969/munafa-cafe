// api/xi-health.js — ElevenLabs daily credit balance check + SMS alert
// Runs at 02:00 UTC (7:30 AM IST) — same time as sms-broadcast, before the day starts
// Also callable manually: GET /api/xi-health?secret=YOUR_CRON_SECRET
//
// Vercel env vars required:
//   ELEVENLABS_API_KEY   — ElevenLabs API key (server-side only, NEVER in frontend)
//   KV_REST_API_URL      — Upstash Redis URL
//   KV_REST_API_TOKEN    — Upstash Redis token
//   FAST2SMS_API_KEY     — Fast2SMS API key
//   OWNER_PHONE          — Your 10-digit mobile number for alerts (e.g. 9997XXXXXX)
//   CRON_SECRET          — Any random string for manual trigger auth
//
// What it does:
//   1. Calls ElevenLabs /v1/user/subscription to get character_count + character_limit
//   2. Computes remaining = character_limit - character_count
//   3. Stores result in Redis key xi:health:last (24h TTL) for dashboard use
//   4. If remaining < LOW_THRESHOLD (10,000 chars) → sends SMS alert to OWNER_PHONE
//   5. Returns JSON with balance details
//
// Why 10,000 chars? A typical MunaFa show segment is ~500-800 chars of TTS.
// 10,000 chars ≈ 12-20 segments — about 1-2 days of content at full load.
// You'll get the alert in the morning before the day's shows run.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

// Alert threshold: send SMS when remaining chars drop below this
const LOW_THRESHOLD = 10000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Auth: Vercel cron header OR manual secret
  const cronSecret = process.env.CRON_SECRET || "";
  const isCron     = req.headers["x-vercel-cron"] === "1";
  const hasSecret  = cronSecret && req.query.secret === cronSecret;
  if (!isCron && !hasSecret) return res.status(401).json({ error: "Unauthorized" });

  const xiKey = process.env.ELEVENLABS_API_KEY;
  if (!xiKey) {
    const msg = "ELEVENLABS_API_KEY not set in Vercel env vars";
    console.error(msg);
    return res.status(500).json({ error: msg });
  }

  try {
    // ── Step 1: Fetch ElevenLabs subscription info ────────────────────────────
    const subRes = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: {
        "xi-api-key": xiKey,
        "Accept":     "application/json"
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!subRes.ok) {
      const errText = await subRes.text().catch(() => "");
      throw new Error(`ElevenLabs API returned ${subRes.status}: ${errText.slice(0, 200)}`);
    }

    const sub = await subRes.json();

    // ElevenLabs subscription response fields:
    //   character_count   — characters used so far this billing period
    //   character_limit   — total characters in your plan per billing period
    //   next_character_count_reset_unix — when the counter resets (unix timestamp)
    const used      = sub.character_count   ?? 0;
    const limit     = sub.character_limit   ?? 0;
    const remaining = limit - used;
    const usedPct   = limit > 0 ? ((used / limit) * 100).toFixed(1) : "0.0";
    const resetAt   = sub.next_character_count_reset_unix
      ? new Date(sub.next_character_count_reset_unix * 1000).toISOString()
      : null;

    console.log(`ElevenLabs balance: ${remaining.toLocaleString()} chars remaining (${usedPct}% used)`);

    // ── Step 2: Store result in Redis for dashboard / status endpoint ──────────
    const healthData = {
      checked_at:  new Date().toISOString(),
      used,
      limit,
      remaining,
      used_pct:    parseFloat(usedPct),
      reset_at:    resetAt,
      plan:        sub.tier || sub.name || "unknown",
      low:         remaining < LOW_THRESHOLD
    };

    await redis.set("xi:health:last", JSON.stringify(healthData), { ex: 90000 }); // 25h TTL

    // ── Step 3: Send SMS alert if balance is low ───────────────────────────────
    if (remaining < LOW_THRESHOLD) {
      const alertMsg =
        `MunaFa Alert: ElevenLabs TTS credit LOW — ` +
        `${remaining.toLocaleString()} chars left (${usedPct}% used). ` +
        `Resets: ${resetAt ? resetAt.slice(0,10) : "unknown"}. ` +
        `Top up at elevenlabs.io`;
      console.warn("LOW BALANCE — sending SMS alert:", alertMsg);
      await sendAlert(alertMsg);
    }

    // ── Step 4: Return result ──────────────────────────────────────────────────
    return res.status(200).json({
      success:        true,
      checked_at:     healthData.checked_at,
      used,
      limit,
      remaining,
      used_pct:       parseFloat(usedPct),
      reset_at:       resetAt,
      plan:           healthData.plan,
      low:            remaining < LOW_THRESHOLD,
      alert_sent:     remaining < LOW_THRESHOLD,
      threshold:      LOW_THRESHOLD
    });

  } catch (err) {
    console.error("xi-health error:", err.message);
    // Alert owner if we can't even check the balance
    await sendAlert(`MunaFa Alert: ElevenLabs balance check FAILED — ${err.message}. Check API key in Vercel env vars.`);
    return res.status(500).json({ error: "Balance check failed", detail: err.message });
  }
}

// ── SMS alert via Fast2SMS Quick route ────────────────────────────────────────
async function sendAlert(message) {
  const apiKey = process.env.FAST2SMS_API_KEY;
  const phone  = process.env.OWNER_PHONE; // 10-digit Indian mobile, e.g. "9997123456"
  if (!apiKey || !phone) {
    console.warn("Cannot send SMS alert — FAST2SMS_API_KEY or OWNER_PHONE not set in env vars");
    return;
  }
  try {
    const r = await fetch("https://www.fast2sms.com/dev/bulkV2", {
      method:  "POST",
      headers: { "authorization": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        route:    "q",
        message:  message.slice(0, 160), // SMS limit: 160 chars
        language: "english",
        flash:    0,
        numbers:  phone
      })
    });
    const result = await r.json().catch(() => ({}));
    if (result.return) console.log("SMS alert sent successfully");
    else console.warn("SMS alert response:", JSON.stringify(result));
  } catch(e) {
    console.warn("SMS alert failed:", e.message);
  }
}
