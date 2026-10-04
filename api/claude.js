export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "No prompt" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d?.error?.message || "Claude error" });
    const text = d?.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
    if (!text) return res.status(500).json({ error: "Claude empty response" });
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
