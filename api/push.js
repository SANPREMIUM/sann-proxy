// Pengirim notifikasi push SANN (chat & broadcast) lewat FCM, berjalan di Vercel.
// Environment Variable yang dibutuhkan: FIREBASE_SERVICE_ACCOUNT (isi file JSON service account Firebase).
//
// Dipanggil dari index.html:
//   POST  Authorization: Bearer <Firebase ID token>
//   {type:'chat', to:'<username penerima>'}
//   {type:'broadcast', title, text, offset}   (khusus admin)

const admin = require('firebase-admin');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const BATCH_USERS = 200; // jumlah akun per putaran broadcast

function send(res, status, body) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(body));
}

function initAdmin() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diisi');
  const sa = JSON.parse(raw);
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}

const DEAD_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
];

// pairs: [{token, uid}] -> kirim data-message ke semua token, bersihkan token mati.
async function sendToTokens(db, pairs, data) {
  const owners = new Map(); // token -> Set(username)
  for (const p of pairs) {
    if (!p.token || typeof p.token !== 'string') continue;
    if (!owners.has(p.token)) owners.set(p.token, new Set());
    owners.get(p.token).add(p.uid);
  }
  const tokens = Array.from(owners.keys());
  let sent = 0;
  const strData = {};
  Object.keys(data).forEach((k) => {
    if (data[k] != null) strData[k] = String(data[k]);
  });

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const r = await admin.messaging().sendEachForMulticast({
      tokens: chunk,
      data: strData,
      android: { priority: 'high', ttl: 24 * 60 * 60 * 1000 },
    });
    sent += r.successCount;
    const cleanups = [];
    r.responses.forEach((resp, idx) => {
      if (!resp.success && resp.error && DEAD_CODES.includes(resp.error.code)) {
        const tk = chunk[idx];
        owners.get(tk).forEach((uid) => {
          cleanups.push(
            db.collection('users').doc(uid)
              .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(tk) })
              .catch(() => {})
          );
        });
      }
    });
    await Promise.all(cleanups);
  }
  return sent;
}

async function handleChat(db, res, me, body) {
  const to = String(body.to || '').trim();
  if (!to || to.toLowerCase() === me.toLowerCase()) {
    return send(res, 400, { ok: false, message: 'Penerima tidak valid' });
  }
  const chatId = [me, to].map((x) => x.toLowerCase()).sort().join('__');
  const chatSnap = await db.collection('chats').doc(chatId).get();
  if (!chatSnap.exists) {
    return send(res, 404, { ok: false, message: 'Percakapan tidak ditemukan' });
  }
  const parts = chatSnap.get('participantsLower') || [];
  if (!parts.includes(me.toLowerCase())) {
    return send(res, 403, { ok: false, message: 'Bukan peserta percakapan' });
  }

  const userSnap = await db.collection('users').doc(to).get();
  if (!userSnap.exists) return send(res, 200, { ok: true, sent: 0, next: null });
  const tokens = userSnap.get('fcmTokens') || [];

  let text = '';
  if (chatSnap.get('lastFrom') === me) text = String(chatSnap.get('lastText') || '');
  const sent = await sendToTokens(
    db,
    tokens.map((t) => ({ token: t, uid: to })),
    {
      title: me,
      body: text ? text.slice(0, 120) : 'Pesan baru',
      tag: 'chat-' + chatId,
      type: 'chat',
    }
  );
  return send(res, 200, { ok: true, sent, next: null });
}

async function handleBroadcast(db, res, decoded, me, body) {
  const adminDoc = await db.collection('admins').doc(decoded.uid).get();
  let isAdmin = adminDoc.exists;
  if (!isAdmin) {
    const meDoc = await db.collection('users').doc(me).get();
    isAdmin = meDoc.exists && meDoc.get('isAdmin') === true;
  }
  if (!isAdmin) return send(res, 403, { ok: false, message: 'Khusus admin' });

  const title = String(body.title || '').trim();
  const text = String(body.text || '').trim();
  if (!title) return send(res, 400, { ok: false, message: 'Judul wajib diisi' });

  const offset = Math.max(0, parseInt(body.offset, 10) || 0);
  const snap = await db.collection('users')
    .orderBy(admin.firestore.FieldPath.documentId())
    .offset(offset)
    .limit(BATCH_USERS)
    .get();

  const pairs = [];
  snap.forEach((doc) => {
    (doc.get('fcmTokens') || []).forEach((t) => pairs.push({ token: t, uid: doc.id }));
  });

  const sent = await sendToTokens(db, pairs, {
    title: title.slice(0, 80),
    body: text.slice(0, 200),
    tag: 'broadcast',
    type: 'broadcast',
  });
  const next = snap.size === BATCH_USERS ? offset + BATCH_USERS : null;
  return send(res, 200, { ok: true, sent, next });
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return send(res, 405, { ok: false, message: 'Method not allowed' });
  }

  try {
    initAdmin();
  } catch (e) {
    return send(res, 500, { ok: false, message: 'Konfigurasi server belum benar: ' + e.message });
  }

  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return send(res, 401, { ok: false, message: 'Belum login' });

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch (e) {
    return send(res, 401, { ok: false, message: 'Token login tidak valid' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  try {
    const db = admin.firestore();
    const uidDoc = await db.collection('usersByUid').doc(decoded.uid).get();
    const me = uidDoc.exists ? uidDoc.get('username') : null;
    if (!me) return send(res, 403, { ok: false, message: 'Akun belum terdaftar' });

    if (body.type === 'chat') return await handleChat(db, res, me, body);
    if (body.type === 'broadcast') return await handleBroadcast(db, res, decoded, me, body);
    return send(res, 400, { ok: false, message: 'Jenis notifikasi tidak dikenal' });
  } catch (e) {
    return send(res, 500, { ok: false, message: String((e && e.message) || e) });
  }
};
