// api/check-sub.js — Check subscription status by phone number
// Uses Upstash Redis (REST client) — keys stay in Vercel env vars only.
// Returns: { found, active, plan, expiry_label }

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { phone } = req.body || {};

  if (!phone || !/^\d{10}$/.test(String(phone))) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  try {
    const record = await redis.get("sub:" + phone);

    if (!record) {
      return res.status(200).json({ found: false, active: false });
    }

    const now         = Date.now();
    const active      = record.expiry > now;
    const expiryDate  = new Date(record.expiry);
    const expiry_label = expiryDate.toLocaleDateString("en-IN", {
      day: "2-digit", month: "short", year: "numeric"
    });

    return res.status(200).json({
      found: true,
      active,
      plan:         record.plan,
      expiry_label,
      expiry:       record.expiry,
      payment_id:   record.payment_id
    });

  } catch (err) {
    console.error("check-sub error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
