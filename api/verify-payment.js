import crypto from "crypto";

const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ error: "Missing payment fields" });

  if (!KEY_SECRET)
    return res.status(500).json({ error: "Server config error" });

  // Verify HMAC-SHA256 signature
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expected = crypto.createHmac("sha256", KEY_SECRET).update(body).digest("hex");

  if (expected !== razorpay_signature)
    return res.status(400).json({ error: "Payment signature mismatch — possible tampering" });

  // Signature valid — payment confirmed
  return res.status(200).json({
    success: true,
    payment_id: razorpay_payment_id,
    plan,
    message: "Payment verified successfully"
  });
}
