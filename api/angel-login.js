// api/angel-login.js — Angel One SmartAPI login → cache JWT in Upstash Redis
// Call this once from your office browser each morning (or automate via cron).
// The JWT is valid 24 hrs; nse-proxy.js reads it from Redis for all data calls.
// POST /api/angel-login  (no body needed — credentials come from env vars)

import { Redis } from "@upstash/redis";
import { totp } from "otplib";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

export default async function handler(req, res) {
  // Allow GET so it can be triggered directly from browser address bar
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CORS headers so angel-refresh.html works from any origin (local file, etc.)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey    = process.env.ANGEL_API_KEY;
  const clientId  = process.env.ANGEL_CLIENT_ID;
  const pin       = process.env.ANGEL_PIN;
  const totpSecret = process.env.ANGEL_TOTP_SECRET;

  if (!apiKey || !clientId || !pin || !totpSecret) {
    return res.status(500).json({ error: "Angel credentials not configured in env vars" });
  }

  try {
    // Generate current TOTP from secret
    const totpToken = totp.generate(totpSecret);

    const loginRes = await fetch("https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Accept":        "application/json",
        "X-UserType":    "USER",
        "X-SourceID":    "WEB",
        "X-ClientLocalIP": "192.168.1.1",
        "X-ClientPublicIP": "49.43.152.78",
        "X-MACAddress":  "00:00:00:00:00:00",
        "X-PrivateKey":  apiKey
      },
      body: JSON.stringify({
        clientcode: clientId,
        password:   pin,
        totp:       totpToken
      })
    });

    const data = await loginRes.json();

    if (!data?.data?.jwtToken) {
      console.error("Angel login failed:", JSON.stringify(data));
      return res.status(401).json({ error: "Angel login failed", detail: data?.message || "No JWT returned" });
    }

    const jwt         = data.data.jwtToken;
    const refreshToken = data.data.refreshToken;
    const feedToken   = data.data.feedToken;

    // Store in Redis — expire in 23 hours (JWT valid 24h, slight buffer)
    await redis.set("angel:jwt",          jwt,          { ex: 82800 });
    await redis.set("angel:refreshToken", refreshToken, { ex: 82800 });
    await redis.set("angel:feedToken",    feedToken,    { ex: 82800 });

    return res.status(200).json({
      success: true,
      message: "Logged in and JWT cached in Redis",
      expires_in: "23 hours"
    });

  } catch (err) {
    console.error("angel-login error:", err.message);
    return res.status(500).json({ error: "Login failed", detail: err.message });
  }
}
