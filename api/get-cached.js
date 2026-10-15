// api/get-cached.js — Serve pre-generated module scripts from Redis cache
// GET /api/get-cached?mi=0&lang=hi         → cached module script
// GET /api/get-cached?type=snapshot        → market data snapshot (for live AI calls)
// Returns: { content: string, generated_at: string, cached: true } or { cached: false }

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");

  // ── Market snapshot endpoint ──────────────────────────────────────────────
  if (req.query.type === "snapshot") {
    try {
      const snap = await redis.get("cache:market_snapshot");
      if (!snap) return res.status(200).json({ cached: false });
      const data = typeof snap === "string" ? JSON.parse(snap) : snap;
      return res.status(200).json({ cached: true, snapshot: data });
    } catch (err) {
      console.error("snapshot error:", err.message);
      return res.status(500).json({ error: "Redis error", detail: err.message });
    }
  }

  // ── Module script endpoint ────────────────────────────────────────────────
  const mi   = req.query.mi   || "0";
  const lang = (req.query.lang || "hi").toLowerCase();

  // Validate
  const validMi   = ["0","1","2","3","4","5","6"];
  const validLang = ["hi","en"];
  if (!validMi.includes(mi) || !validLang.includes(lang)) {
    return res.status(400).json({ error: "Invalid mi or lang" });
  }

  const key = `cache:module:${mi}:${lang}`;

  try {
    const [content, generatedAt] = await Promise.all([
      redis.get(key),
      redis.get("cache:generated_at")
    ]);

    if (!content) {
      return res.status(200).json({ cached: false });
    }

    return res.status(200).json({
      cached: true,
      content: typeof content === "string" ? content : JSON.stringify(content),
      generated_at: generatedAt || null
    });

  } catch (err) {
    console.error("get-cached error:", err.message);
    return res.status(500).json({ error: "Redis error", detail: err.message });
  }
}
