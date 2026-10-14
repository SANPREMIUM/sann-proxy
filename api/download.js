// Proxy downloader FB & IG untuk Vercel (pindahan dari Cloudflare Worker)
// Environment Variables yang harus diisi di Vercel: APP_SECRET, RAPIDAPI_KEY

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
};

function send(res, status, body) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(body));
}

function getInstagramShortcode(link) {
  const m = link.match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return send(res, 405, { success: false, message: 'Method not allowed' });
  }

  if (req.headers['x-app-secret'] !== process.env.APP_SECRET) {
    return send(res, 401, { success: false, message: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { url, platform } = body || {};
  if (!url) {
    return send(res, 400, { success: false, message: 'URL is required' });
  }

  try {
    let apiUrl;
    if (platform === 'instagram') {
      const shortcode = getInstagramShortcode(url);
      if (!shortcode) {
        return send(res, 400, { success: false, message: 'Shortcode Instagram tidak ditemukan di link' });
      }
      apiUrl = `https://social-media-video-downloader.p.rapidapi.com/instagram/v3/media/post/details?renderableFormats=720p,highres&shortcode=${encodeURIComponent(shortcode)}`;
    } else {
      apiUrl = `https://social-media-video-downloader.p.rapidapi.com/facebook/v3/post/details?renderableFormats=720p,highres&url=${encodeURIComponent(url)}`;
    }

    const r = await fetch(apiUrl, {
      headers: {
        'x-rapidapi-host': 'social-media-video-downloader.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
      },
    });
    const json = await r.json();
    const videos = json && json.contents && json.contents[0] && json.contents[0].videos;
    if (!videos || !videos.length) {
      return send(res, 404, { success: false, message: 'Video tidak ditemukan' });
    }

    const best = videos.find((v) => v.label === 'native_hd') || videos[0];
    return send(res, 200, {
      success: true,
      data: {
        downloadUrl: best.url,
        title: json.contents[0].title || '',
        quality: best.label,
      },
    });
  } catch (err) {
    return send(res, 500, { success: false, message: String((err && err.message) || err) });
  }
};
