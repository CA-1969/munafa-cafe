// api/seed-sub.js — One-time admin endpoint to manually seed a subscriber
// Protected by SEED_SECRET env var. Use from terminal/Postman only.
// Delete or disable after seeding your initial subscribers.
//
// Usage:
//   curl -X POST https://munaapha.co.in/api/seed-sub \
//     -H "Content-Type: application/json" \
//     -d '{"secret":"YOUR_SEED_SECRET","phone":"9458415065","plan":"yearly","days":366}'

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { secret, phone, plan, days, payment_id } = req.body || {};

  const expectedSecret = process.env.SEED_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const cleanPhone = String(phone || "").replace(/\D/g, "").slice(-10);
  if (!/^\d{10}$/.test(cleanPhone)) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  const daysN  = parseInt(days, 10) || 366;
  const expiry = Date.now() + daysN * 24 * 60 * 60 * 1000;

  const record = {
    plan:       plan || "yearly",
    expiry,
    payment_id: payment_id || "manual_seed",
    order_id:   "manual_seed",
    created_at: Date.now(),
    note:       "Manually seeded by admin"
  };

  await redis.set("sub:" + cleanPhone, record);

  const expiryDate = new Date(expiry).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric"
  });

  return res.status(200).json({
    success: true,
    phone:   cleanPhone,
    plan:    record.plan,
    expiry:  expiryDate,
    message: "Subscriber seeded successfully"
  });
}
