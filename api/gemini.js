export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt provided" });

  // Free tier models as of Oct 2026 — gemini-1.5 is RETIRED (404)
  const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-flash-preview"];

  let lastError = "";
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        lastError = `${model} ${response.status}: ${data?.error?.message || "unknown"}`;
        console.error("Gemini error:", lastError);
        continue;
      }
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!text) { lastError = `${model}: empty`; continue; }
      return res.status(200).json({ text });
    } catch (e) {
      lastError = `${model}: ${e.message}`;
      continue;
    }
  }
  return res.status(500).json({ error: "Gemini failed: " + lastError });
}
