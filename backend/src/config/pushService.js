// src/config/pushService.js
// ── FIREBASE PUSH NOTIFICATIONS (FCM) ────────────────────────────────────────
// Sends push notifications to employees' registered devices. Requires a
// Firebase service-account key — set FIREBASE_SERVICE_ACCOUNT env var to
// either the JSON itself, or a path to the JSON file (Firebase Console >
// Project Settings > Service Accounts > Generate new private key).
// If unset, sendPush() silently no-ops so the app runs fine without FCM
// configured — push is best-effort, never a hard dependency for a feature.

const db = require('../config/db');

let app = null;
let initTried = false;

function getApp() {
  if (app || initTried) return app;
  initTried = true;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.warn('[pushService] FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
    return null;
  }
  try {
    const admin = require('firebase-admin');
    const fs = require('fs');
    const serviceAccount = raw.trim().startsWith('{')
      ? JSON.parse(raw)
      : JSON.parse(fs.readFileSync(raw, 'utf8'));
    app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return app;
  } catch (err) {
    console.error('[pushService] Failed to initialize Firebase Admin:', err.message);
    return null;
  }
}

// Sends a push to one employee's registered device (no-op if they have no
// token or FCM isn't configured). Never throws — callers should not have to
// wrap this in try/catch for every call site.
async function sendPush(employeeId, title, body, data = {}) {
  try {
    const firebaseApp = getApp();
    if (!firebaseApp) return;
    const r = await db.query(`SELECT fcm_token FROM employees WHERE id=$1`, [employeeId]);
    const token = r.rows[0]?.fcm_token;
    if (!token) return;
    const admin = require('firebase-admin');
    await admin.messaging(firebaseApp).send({
      token,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high' }
    });
  } catch (err) {
    // A stale/uninstalled token is the most common failure — not worth logging loudly.
    console.warn('[pushService] send failed:', err.message);
  }
}

module.exports = { sendPush };
