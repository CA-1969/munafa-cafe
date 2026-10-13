// api/tts.js — ElevenLabs TTS proxy
// Vercel serverless function. ELEVENLABS_API_KEY lives in Vercel env vars only.
// The key NEVER reaches the browser.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "ElevenLabs API key not configured" });
  }

  const { text, voice_id, model_id, voice_settings, seed } = req.body;

  if (!text || !voice_id) {
    return res.status(400).json({ error: "Missing text or voice_id" });
  }

  // Clamp text length to avoid runaway ElevenLabs charges
  const safeText = String(text).slice(0, 600);

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": key
        },
        body: JSON.stringify({
          text: safeText,
          model_id: model_id || "eleven_multilingual_v2",
          voice_settings: voice_settings || {
            stability: 0.50,
            similarity_boost: 0.82,
            style: 0.25,
            use_speaker_boost: true
          },
          ...(seed !== undefined && { seed: Number(seed) })  // lock voice — prevents variation across calls
        })
      }
    );

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error("ElevenLabs error:", upstream.status, errText);
      return res.status(upstream.status).json({ error: "ElevenLabs error", detail: errText });
    }

    // Stream audio back to browser
    const audioBuffer = await upstream.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400"); // cache for 24h — same text = same audio
    res.status(200).send(Buffer.from(audioBuffer));

  } catch (err) {
    console.error("TTS proxy error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
