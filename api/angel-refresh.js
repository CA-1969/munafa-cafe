// api/angel-refresh.js — Auto-refresh Angel One JWT every day via Vercel cron
// Runs at 03:00 UTC (8:30 AM IST) — just before market opens at 9:15 AM IST
// Also callable manually: GET /api/angel-refresh?secret=YOUR_CRON_SECRET
//
// Vercel env vars required (same as angel-login.js):
//   ANGEL_API_KEY        — Angel One SmartAPI key
//   ANGEL_CLIENT_ID      — Your Angel One client code
//   ANGEL_PIN            — Your Angel One login PIN
//   ANGEL_TOTP_SECRET    — Base32 TOTP secret from Angel One authenticator setup
//   KV_REST_API_URL      — Upstash Redis URL
//   KV_REST_API_TOKEN    — Upstash Redis token
//   CRON_SECRET          — Any random string for manual trigger auth
//   FAST2SMS_API_KEY     — For SMS alert to owner if login fails
//   OWNER_PHONE          — 10-digit mobile number to alert on failure (e.g. 9997XXXXXX)
//
// What it does:
//   1. Generates a fresh TOTP from ANGEL_TOTP_SECRET (same algorithm as Google Authenticator)
//   2. Logs in to Angel One SmartAPI
//   3. Stores JWT + refresh token in Redis (23h TTL)
//   4. If login fails → sends SMS alert to OWNER_PHONE so you can log in manually
//
// Result: nse-proxy.js always finds a fresh JWT in Redis → real-time market data

import { Redis } from "@upstash/redis";
import { authenticator } from "otplib";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Auth: Vercel cron header OR manual secret
  const cronSecret = process.env.CRON_SECRET || "";
  const isCron     = req.headers["x-vercel-cron"] === "1";
  const hasSecret  = cronSecret && req.query.secret === cronSecret;
  if (!isCron && !hasSecret) return res.status(401).json({ error: "Unauthorized" });

  const apiKey     = process.env.ANGEL_API_KEY;
  const clientId   = process.env.ANGEL_CLIENT_ID;
  const pin        = process.env.ANGEL_PIN;
  const totpSecret = process.env.ANGEL_TOTP_SECRET;

  if (!apiKey || !clientId || !pin || !totpSecret) {
    const msg = "Angel credentials missing in Vercel env vars";
    console.error(msg);
    await sendAlert(`MunaFa Alert: ${msg} — login manually at munaapha.co.in/api/angel-login`);
    return res.status(500).json({ error: msg });
  }

  try {
    // ── Step 1: Generate current TOTP (same as Google Authenticator) ──────────
    // otplib handles the 30-second window automatically — always the right code
    const totpToken = authenticator.generate(totpSecret);
    console.log("Generated TOTP for login attempt");

    // ── Step 2: Login to Angel One SmartAPI ───────────────────────────────────
    const loginRes = await fetch(
      "https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword",
      {
        method: "POST",
        headers: {
          "Content-Type":     "application/json",
          "Accept":           "application/json",
          "X-UserType":       "USER",
          "X-SourceID":       "WEB",
          "X-ClientLocalIP":  "192.168.1.1",
          "X-ClientPublicIP": "49.43.152.78",
          "X-MACAddress":     "00:00:00:00:00:00",
          "X-PrivateKey":     apiKey
        },
        body: JSON.stringify({
          clientcode: clientId,
          password:   pin,
          totp:       totpToken
        })
      }
    );

    const data = await loginRes.json();

    if (!data?.data?.jwtToken) {
      const errMsg = data?.message || "No JWT returned from Angel One";
      console.error("Angel login failed:", errMsg);
      await sendAlert(
        `MunaFa Alert: Angel One auto-login FAILED — ${errMsg}. ` +
        `Market data will use Stooq fallback today. Visit: munaapha.co.in`
      );
      return res.status(401).json({ error: "Angel login failed", detail: errMsg });
    }

    const jwt          = data.data.jwtToken;
    const refreshToken = data.data.refreshToken;
    const feedToken    = data.data.feedToken;

    // ── Step 3: Store in Redis (23h TTL — JWT is valid 24h, 1h buffer) ────────
    await Promise.all([
      redis.set("angel:jwt",          jwt,          { ex: 82800 }),
      redis.set("angel:refreshToken", refreshToken, { ex: 82800 }),
      redis.set("angel:feedToken",    feedToken,    { ex: 82800 }),
      redis.set("angel:last_login",   new Date().toISOString(), { ex: 90000 })
    ]);

    console.log("Angel One JWT refreshed and cached in Redis — expires in 23h");

    return res.status(200).json({
      success:    true,
      message:    "Angel One JWT refreshed and cached",
      expires_in: "23 hours",
      login_at:   new Date().toISOString()
    });

  } catch (err) {
    console.error("angel-refresh error:", err.message);
    await sendAlert(
      `MunaFa Alert: Angel One auto-refresh error — ${err.message}. ` +
      `Market data will use Stooq fallback today.`
    );
    return res.status(500).json({ error: "Refresh failed", detail: err.message });
  }
}

// ── SMS alert to owner phone on failure ───────────────────────────────────────
// Uses Fast2SMS Quick route — no template needed
async function sendAlert(message) {
  const apiKey = process.env.FAST2SMS_API_KEY;
  const phone  = process.env.OWNER_PHONE; // e.g. "9997123456"
  if (!apiKey || !phone) {
    console.warn("Cannot send SMS alert — FAST2SMS_API_KEY or OWNER_PHONE not set");
    return;
  }
  try {
    await fetch("https://www.fast2sms.com/dev/bulkV2", {
      method: "POST",
      headers: { "authorization": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        route:    "q",
        message:  message.slice(0, 160),
        language: "english",
        flash:    0,
        numbers:  phone
      })
    });
  } catch(e) {
    console.warn("SMS alert failed:", e.message);
  }
}
