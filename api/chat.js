// api/chat.js — taruh di repo sann-proxy (folder api/), lalu deploy ulang ke Vercel.
// Environment variable di Vercel:
//   GEMINI_API_KEY = key dari https://aistudio.google.com/apikey
//   GEMINI_MODEL   = (opsional) nama model, default di bawah

const SYSTEM_PROMPT = `Kamu adalah SANN AI, asisten di aplikasi SANN Toolbox.
Gaya: santai, ramah, bahasa Indonesia sehari-hari, jawaban singkat dan jelas (cocok dibaca di HP).
Tugasmu ada dua:
1) Menjelaskan fitur-fitur SANN Toolbox kalau user bertanya.
2) Ngobrol santai sehari-hari.

Daftar fitur SANN Toolbox (isi/edit sesuai aplikasimu):
- Download video TikTok, foto/slide TikTok, dan Reels/Video FB & IG lewat link (ada batas kuota harian).
- Game Center: Bola Gacor, Bola Duel (bisa mabar online), Tumpuk Balok, Neon Serpent, 2048, Sliding Puzzle, Biliar, dan lainnya.
- Papan Skor / Leaderboard, achievement, streak, level.
- Chat antar pengguna (ada tanda dilihat dan notifikasi pesan belum dibaca).
- Kategori Pengetahuan, termasuk Fakta Unik Tentang Hewan.
- Profil pengguna dengan status online dan game yang sedang dimainkan.

Aturan: kalau ditanya fitur yang tidak ada di daftar, bilang jujur tidak tahu atau fiturnya belum ada. Jangan mengarang fitur.`;

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    // messages: [{role:'user'|'ai', text:'...'}]
    const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
    if (!messages.length) return res.status(400).json({ error: 'Pesan kosong' });

    const contents = messages.map((m) => ({
      role: m.role === 'ai' ? 'model' : 'user',
      parts: [{ text: String(m.text || '').slice(0, 1500) }],
    }));

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { maxOutputTokens: 600, temperature: 0.8 },
        }),
      }
    );

    const data = await r.json();
    if (!r.ok) {
      const code = r.status === 429 ? 429 : 502;
      return res.status(code).json({ error: data?.error?.message || 'Gagal memanggil AI' });
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    return res.status(200).json({ reply: text || 'Hmm, aku belum bisa jawab itu. Coba tanya lagi ya.' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
}
