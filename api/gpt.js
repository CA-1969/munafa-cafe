// api/gpt.js — OpenAI GPT-4o proxy for MunaFa Café FM scripts
// OPENAI_API_KEY lives in Vercel env vars only — never reaches the browser.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OpenAI API key not configured" });

  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 2048,
        temperature: 0.7,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("GPT error:", r.status, err);
      return res.status(r.status).json({ error: "OpenAI error", detail: err });
    }

    const j = await r.json();
    const content = j.choices?.[0]?.message?.content || "";
    return res.status(200).json({ content });

  } catch (err) {
    console.error("api/gpt error:", err.message);
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
}
