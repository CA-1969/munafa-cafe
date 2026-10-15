// api/gemini.js — Google Gemini proxy for MunaFa Café FM scripts
// GEMINI_API_KEY lives in Vercel env vars only — never reaches the browser.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Gemini API key not configured" });

  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.7 }
      })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("Gemini error:", r.status, err);
      return res.status(r.status).json({ error: "Gemini error", detail: err });
    }

    const j = await r.json();
    const content = j.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return res.status(200).json({ content });

  } catch (err) {
    console.error("api/gemini error:", err.message);
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
}
