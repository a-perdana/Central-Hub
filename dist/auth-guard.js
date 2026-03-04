// auth-guard.js — CentralHub (modular SDK v10)
// ─────────────────────────────────────────────────────────────────
// Include on every protected page (NOT on login.html).
// Depends on firebase-config.js setting window.ENV before this runs.
//
// Allowed roles: central_admin, central_user
//
// Exposes globals (set once authReady fires):
//   window.firebaseApp   — FirebaseApp instance
//   window.db            — Firestore instance
//   window.auth          — Auth instance
//   window.currentUser   — firebase.User object
//   window.userProfile   — Firestore users/{uid} document data
//
// Dispatches CustomEvent 'authReady' on document when auth + profile
// are confirmed, with detail: { user, profile }
// ─────────────────────────────────────────────────────────────────

import { initializeApp, getApps }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── Platform identity ─────────────────────────────────────────────
const PLATFORM_KEY  = 'role_centralhub';   // per-user Firestore field
const DEFAULT_ROLE  = 'central_user';

// Roles permitted to use CentralHub
const ALLOWED_ROLES = ['central_admin', 'central_user'];

// Hide page content until auth is confirmed (prevents flash of content)
document.body.style.visibility = 'hidden';

// ── Initialise Firebase (guard against double-init) ──────────────
const firebaseConfig = {
  apiKey:            window.ENV.FIREBASE_API_KEY,
  authDomain:        window.ENV.FIREBASE_AUTH_DOMAIN,
  projectId:         window.ENV.FIREBASE_PROJECT_ID,
  storageBucket:     window.ENV.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: window.ENV.FIREBASE_MESSAGING_SENDER_ID,
  appId:             window.ENV.FIREBASE_APP_ID,
};

const app  = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

window.firebaseApp = app;
window.auth        = auth;
window.db          = db;

// ── Name prompt (shown when displayName is missing) ───────────────
function promptForName() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(28,28,46,0.75);display:flex;align-items:center;justify-content:center;padding:24px;font-family:"DM Sans",sans-serif';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:40px 36px;width:100%;max-width:400px;box-shadow:0 20px 60px rgba(0,0,0,0.35)">
        <h2 style="font-size:1.4rem;font-weight:600;color:#1c1c2e;margin-bottom:6px">Welcome!</h2>
        <p style="font-size:0.875rem;color:#8888a8;margin-bottom:24px">Please enter your full name to complete your profile.</p>
        <input id="_nameInput" type="text" placeholder="Your full name"
          style="width:100%;padding:10px 14px;border:1px solid #e0ddd6;border-radius:8px;font-size:0.95rem;color:#1c1c2e;outline:none;margin-bottom:8px;box-sizing:border-box">
        <p id="_nameErr" style="font-size:0.82rem;color:#dc2626;min-height:20px;margin-bottom:12px"></p>
        <button id="_nameBtn" style="width:100%;padding:11px;background:linear-gradient(135deg,#7c3aed,#0891b2);color:#fff;border:none;border-radius:8px;font-size:0.95rem;font-weight:600;cursor:pointer">Continue →</button>
      </div>`;
    document.body.appendChild(overlay);
    document.body.style.visibility = 'visible';

    const input = overlay.querySelector('#_nameInput');
    const btn   = overlay.querySelector('#_nameBtn');
    const err   = overlay.querySelector('#_nameErr');
    input.focus();

    const submit = () => {
      const name = input.value.trim();
      if (!name) { err.textContent = 'Please enter your name.'; return; }
      overlay.remove();
      document.body.style.visibility = 'hidden';
      resolve(name);
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  });
}

// ── Auth state listener ──────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {

  // 1. Not signed in → redirect to login
  if (!user) {
    window.location.replace('login');
    return;
  }

  // 2. Fetch (or create) Firestore profile
  let profile;
  const userRef = doc(db, 'users', user.uid);
  try {
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      // First sign-in: assign default CentralHub role.
      const newProfile = {
        uid:            user.uid,
        email:          user.email,
        displayName:    user.displayName || '',
        photoURL:       user.photoURL    || '',
        [PLATFORM_KEY]: DEFAULT_ROLE,
        createdAt:      serverTimestamp(),
      };
      await setDoc(userRef, newProfile);
      profile = newProfile;
    } else {
      profile = userSnap.data();
      // Legacy role mapping: old 'admin' → 'central_admin'
      const LEGACY_MAP = { 'admin': 'central_admin' };
      const legacyRole = profile.role;
      if (profile[PLATFORM_KEY] == null) {
        // First visit with new system — assign correct role
        const assignRole = LEGACY_MAP[legacyRole]
          || (ALLOWED_ROLES.includes(legacyRole) ? legacyRole : DEFAULT_ROLE);
        await setDoc(userRef, { [PLATFORM_KEY]: assignRole }, { merge: true });
        profile = { ...profile, [PLATFORM_KEY]: assignRole };
      } else if (profile[PLATFORM_KEY] === DEFAULT_ROLE && LEGACY_MAP[legacyRole]) {
        // Correct a previously wrong mapping (e.g. 'admin' was assigned 'central_user')
        const correctRole = LEGACY_MAP[legacyRole];
        await setDoc(userRef, { [PLATFORM_KEY]: correctRole }, { merge: true });
        profile = { ...profile, [PLATFORM_KEY]: correctRole };
      }
    }
  } catch (err) {
    console.error('auth-guard: could not fetch user profile', err);
    await signOut(auth);
    window.location.replace('login?error=profile');
    return;
  }

  // 3. Role check
  const platformRole = profile[PLATFORM_KEY];
  if (!ALLOWED_ROLES.includes(platformRole)) {
    await signOut(auth);
    window.location.replace('login?error=access');
    return;
  }
  // Set profile.role for backward compat with page-level checks
  profile.role = platformRole;

  // 4. Name prompt if missing
  if (!profile.displayName) {
    const name = await promptForName();
    await setDoc(userRef, { displayName: name }, { merge: true });
    profile.displayName = name;
  }

  // 5. All checks passed — expose globals
  window.currentUser = user;
  window.userProfile = profile;

  // ── Show Console nav link for central_admin (right side of nav) ──
  if (platformRole === 'central_admin') {
    const navAuth = document.querySelector('.nav-auth');
    if (navAuth && !navAuth.querySelector('a[href="console"]')) {
      const link = document.createElement('a');
      link.href        = 'console';
      link.className   = 'nav-link';
      link.textContent = 'Console';
      navAuth.insertBefore(link, navAuth.firstChild);
    }
  }

  // ── Populate shared nav elements ─────────────────────────────────
  const displayName = profile.displayName || user.displayName;
  const navUserName = document.querySelector('.nav-user-name');
  const navAvatar   = document.getElementById('navAvatar');
  const logoutBtn   = document.getElementById('logoutBtn');

  if (navUserName) {
    navUserName.textContent = displayName
      ? displayName.split(' ')[0]
      : user.email;
  }

  if (navAvatar) {
    const initials = displayName
      ? displayName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
      : user.email[0].toUpperCase();
    navAvatar.textContent = initials;
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await signOut(auth);
      window.location.href = 'login';
    });
  }

  // 6. Show page and notify
  document.body.style.visibility = 'visible';
  document.dispatchEvent(new CustomEvent('authReady', {
    detail: { user, profile },
  }));
});
