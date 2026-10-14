// api/claude.js — Anthropic Claude proxy for MunaFa Café FM scripts
// ANTHROPIC_API_KEY lives in Vercel env vars only — never reaches the browser.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Anthropic API key not configured" });

  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("Claude error:", r.status, err);
      return res.status(r.status).json({ error: "Claude error", detail: err });
    }

    const j = await r.json();
    const content = j.content?.[0]?.text || "";
    return res.status(200).json({ content });

  } catch (err) {
    console.error("api/claude error:", err.message);
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
}
