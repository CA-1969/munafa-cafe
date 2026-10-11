import crypto from "crypto";

const KEY_ID     = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (!KEY_ID || !KEY_SECRET)
    return res.status(500).json({ error: "Razorpay credentials not configured" });

  const { amount, plan } = req.body;
  if (!amount || amount < 100)
    return res.status(400).json({ error: "Invalid amount" });

  try {
    const receipt = "munafa_" + plan + "_" + Date.now();
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + Buffer.from(KEY_ID + ":" + KEY_SECRET).toString("base64"),
      },
      body: JSON.stringify({ amount, currency: "INR", receipt }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.description || "Order creation failed" });
    return res.status(200).json({ order_id: data.id, amount: data.amount, currency: data.currency });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
