// firebase-config.example.js — CentralHub
// ─────────────────────────────────────────────────────────────────
// Copy this file to firebase-config.js and fill in YOUR_API_KEY
// and YOUR_APP_ID from:
//   Firebase Console → centralhub-8727b → Project Settings → Your apps
//
// firebase-config.js is GITIGNORED — never commit it.
//
// All three apps share the centralhub-8727b Firebase project.
// ─────────────────────────────────────────────────────────────────
window.ENV = {
  FIREBASE_API_KEY:             "YOUR_API_KEY",
  FIREBASE_AUTH_DOMAIN:         "centralhub-8727b.firebaseapp.com",
  FIREBASE_PROJECT_ID:          "centralhub-8727b",
  FIREBASE_STORAGE_BUCKET:      "centralhub-8727b.firebasestorage.app",
  FIREBASE_MESSAGING_SENDER_ID: "244951050014",
  FIREBASE_APP_ID:              "YOUR_APP_ID",
  // Mail service (Railway) — set these in Vercel env vars too
  MAIL_SERVICE_URL:             "https://YOUR_RAILWAY_APP.railway.app",
  MAIL_SERVICE_SECRET:          "YOUR_API_SECRET",
};
