// api/verify-payment.js — Razorpay signature verification + subscriber save
// RAZORPAY_KEY_SECRET lives only in Vercel env vars — never reaches the browser.
// After successful verification, saves the subscriber record to Upstash Redis.

import crypto       from "crypto";
import { Redis }    from "@upstash/redis";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const PLAN_DURATIONS = {
  monthly: 31  * 24 * 60 * 60 * 1000,   // 31 days in ms
  yearly:  366 * 24 * 60 * 60 * 1000    // 366 days in ms
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "Razorpay key secret not configured" });
  }

  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    plan,
    phone
  } = req.body || {};

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing payment fields" });
  }

  // ── HMAC-SHA256 signature verification ──────────────────────────
  const body     = razorpay_order_id + "|" + razorpay_payment_id;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  if (expected !== razorpay_signature) {
    console.warn("Signature mismatch", { expected, received: razorpay_signature });
    return res.status(400).json({ success: false, error: "Signature mismatch" });
  }

  // ── Signature valid → save subscriber ───────────────────────────
  const expiry     = Date.now() + (PLAN_DURATIONS[plan] || PLAN_DURATIONS.monthly);
  const cleanPhone = phone ? String(phone).replace(/\D/g, "").slice(-10) : null;

  const record = {
    plan,
    expiry,
    payment_id: razorpay_payment_id,
    order_id:   razorpay_order_id,
    created_at: Date.now()
  };

  const saves = [];
  if (cleanPhone && /^\d{10}$/.test(cleanPhone)) {
    saves.push(redis.set("sub:" + cleanPhone, record));
  }
  // Index by payment_id so support can look up any payment
  saves.push(redis.set("pay:" + razorpay_payment_id, { ...record, phone: cleanPhone }));

  try {
    await Promise.all(saves);
  } catch (kvErr) {
    // Redis write failed — payment was real; still return success so user is unlocked
    console.error("Redis write failed:", kvErr);
  }

  return res.status(200).json({
    success: true,
    phone:   cleanPhone || null   // returned to frontend for localStorage save
  });
}
