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
import { getAuth, onAuthStateChanged, signOut, updateProfile }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// ── Platform identity ─────────────────────────────────────────────
const PLATFORM_KEY  = 'role_centralhub';   // per-user Firestore field
const DEFAULT_ROLE  = 'central_user';

// Roles permitted to use CentralHub
const ALLOWED_ROLES = ['central_admin', 'central_user'];

// Only @eduversal.org email addresses are allowed to access CentralHub.
// Email/password accounts (manually created in Firebase Console) bypass
// this check so that service accounts can still be used if needed.
const ALLOWED_DOMAIN = 'eduversal.org';
function isDomainAllowed(user) {
  const domain = (user.email || '').split('@')[1];
  if (domain === ALLOWED_DOMAIN) return true;
  // Allow manually-created email/password accounts (no Google provider)
  return user.providerData.some(p => p.providerId === 'password');
}

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
const storage = getStorage(app);

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

    const input = overlay.querySelector('#_nameInput');
    const btn   = overlay.querySelector('#_nameBtn');
    const err   = overlay.querySelector('#_nameErr');
    input.focus();

    const submit = () => {
      const name = input.value.trim();
      if (!name) { err.textContent = 'Please enter your name.'; return; }
      overlay.remove();
      resolve(name);
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  });
}

// Profile modal CSS lives in shared-styles.css — no dynamic injection needed.

function formatPhoneInputValue(rawValue) {
  const hasPlus = rawValue.trim().startsWith('+');
  let digits = rawValue.replace(/\D/g, '');

  if (!digits) return hasPlus ? '+' : '';

  if (hasPlus && digits.startsWith('62')) {
    const country = '+62';
    const local = digits.slice(2, 13);
    const a = local.slice(0, 3);
    const b = local.slice(3, 7);
    const c = local.slice(7, 11);
    return [country, a, b, c].filter(Boolean).join(' ');
  }

  if (!hasPlus && digits.startsWith('0')) {
    const local = digits.slice(0, 12);
    const a = local.slice(0, 4);
    const b = local.slice(4, 8);
    const c = local.slice(8, 12);
    return [a, b, c].filter(Boolean).join(' ');
  }

  if (hasPlus) {
    digits = digits.slice(0, 15);
    const countryLen = Math.min(3, digits.length);
    const country = `+${digits.slice(0, countryLen)}`;
    const rest = digits.slice(countryLen);
    const chunks = rest.match(/.{1,3}/g) || [];
    return [country, ...chunks].join(' ').trim();
  }

  digits = digits.slice(0, 15);
  return (digits.match(/.{1,3}/g) || []).join(' ').trim();
}

function getInitials(displayName, email) {
  const seed = (displayName || email || '').trim();
  if (!seed) return 'U';
  return seed
    .split(' ')
    .filter(Boolean)
    .map(n => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function applyAvatarVisual(avatarEl, displayName, email, photoURL) {
  if (!avatarEl) return;
  const initials = getInitials(displayName, email);
  if (photoURL) {
    avatarEl.style.backgroundImage = `url("${photoURL}")`;
    avatarEl.style.backgroundSize = 'cover';
    avatarEl.style.backgroundPosition = 'center';
    avatarEl.textContent = '';
  } else {
    avatarEl.style.backgroundImage = 'linear-gradient(135deg, #7c3aed, #0891b2)';
    avatarEl.style.backgroundSize = '';
    avatarEl.style.backgroundPosition = '';
    avatarEl.textContent = initials;
  }
}

let _profileModalMounted = false;
function mountProfileModal({ user, profile, userRef, navUserName, navAvatar }) {
  if (_profileModalMounted) return;
  if (!navAvatar) return;
  _profileModalMounted = true;

  if (navUserName) {
    navUserName.style.cursor = 'pointer';
    navUserName.title = 'Open profile';
    navUserName.classList.add('nav-profile-trigger');
  }
  navAvatar.style.cursor = 'pointer';
  navAvatar.title = 'Open profile';
  navAvatar.classList.add('nav-profile-trigger');

  const overlay = document.createElement('div');
  overlay.className = 'profile-modal-overlay';
  overlay.innerHTML = `
    <div class="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profileModalTitle">
      <div class="profile-modal-head">
        <h3 id="profileModalTitle">Profile</h3>
        <button type="button" class="profile-modal-close" id="profileCloseBtn" aria-label="Close profile">×</button>
      </div>
      <div class="profile-modal-body">
        <div class="profile-field">
          <label>Photo</label>
          <div class="profile-avatar-editor">
            <div class="profile-avatar-preview" id="profileAvatarPreview"></div>
            <div class="profile-avatar-actions">
              <button type="button" class="profile-btn" id="profilePhotoPickBtn">Choose photo</button>
              <button type="button" class="profile-btn" id="profilePhotoRemoveBtn">Remove</button>
              <input id="profilePhotoFile" class="profile-avatar-file" type="file" accept="image/*" />
            </div>
          </div>
        </div>
        <div class="profile-field">
          <label for="profileDisplayName">Display name</label>
          <input id="profileDisplayName" type="text" maxlength="80" />
        </div>
        <div class="profile-field">
          <label for="profilePhone">Phone</label>
          <input id="profilePhone" type="tel" maxlength="30" placeholder="+62..." />
        </div>
        <div class="profile-field">
          <label for="profileTitle">Title</label>
          <input id="profileTitle" type="text" maxlength="80" placeholder="Coordinator, Principal, etc." />
        </div>
        <div class="profile-field">
          <label for="profileEmail">Email</label>
          <input id="profileEmail" type="email" readonly />
        </div>
      </div>
      <p class="profile-modal-msg" id="profileMsg"></p>
      <div class="profile-modal-foot">
        <button type="button" class="profile-btn-signout" id="profileSignOutBtn">Sign out</button>
        <div style="display:flex;gap:8px">
          <button type="button" class="profile-btn" id="profileCancelBtn">Cancel</button>
          <button type="button" class="profile-btn profile-btn-primary" id="profileSaveBtn">Save</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const el = {
    overlay,
    close: overlay.querySelector('#profileCloseBtn'),
    cancel: overlay.querySelector('#profileCancelBtn'),
    save: overlay.querySelector('#profileSaveBtn'),
    signOut: overlay.querySelector('#profileSignOutBtn'),
    msg: overlay.querySelector('#profileMsg'),
    avatarPreview: overlay.querySelector('#profileAvatarPreview'),
    photoPickBtn: overlay.querySelector('#profilePhotoPickBtn'),
    photoRemoveBtn: overlay.querySelector('#profilePhotoRemoveBtn'),
    photoFile: overlay.querySelector('#profilePhotoFile'),
    displayName: overlay.querySelector('#profileDisplayName'),
    phone: overlay.querySelector('#profilePhone'),
    title: overlay.querySelector('#profileTitle'),
    email: overlay.querySelector('#profileEmail'),
  };

  const localState = {
    photoURL: (profile.photoURL || user.photoURL || '').trim(),
    removePhoto: false,
    selectedPhotoFile: null,
  };

  const refreshNav = (name, photoURL) => {
    const finalName = (name || '').trim() || user.email;
    if (navUserName) navUserName.textContent = finalName;
    applyAvatarVisual(navAvatar, finalName, user.email, photoURL);
  };

  const refreshProfileAvatarPreview = () => {
    const previewUrl = localState.removePhoto ? '' : localState.photoURL;
    applyAvatarVisual(el.avatarPreview, el.displayName.value.trim(), user.email, previewUrl);
  };

  const fill = () => {
    el.displayName.value = (profile.displayName || user.displayName || '').trim();
    el.phone.value = (profile.phone || '').trim();
    el.title.value = (profile.title || '').trim();
    el.email.value = user.email || '';
    localState.photoURL = (profile.photoURL || user.photoURL || '').trim();
    localState.removePhoto = false;
    localState.selectedPhotoFile = null;
    el.photoFile.value = '';
    refreshProfileAvatarPreview();
    el.msg.textContent = '';
    el.msg.classList.remove('ok');
  };

  const open = () => {
    fill();
    overlay.classList.add('open');
    el.displayName.focus();
  };
  const close = () => {
    overlay.classList.remove('open');
  };

  if (navUserName) navUserName.addEventListener('click', open);
  navAvatar.addEventListener('click', open);
  el.close.addEventListener('click', close);
  el.cancel.addEventListener('click', close);
  el.signOut.addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = 'login';
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  el.displayName.addEventListener('input', refreshProfileAvatarPreview);
  el.photoPickBtn.addEventListener('click', () => el.photoFile.click());
  el.photoRemoveBtn.addEventListener('click', () => {
    localState.removePhoto = true;
    localState.selectedPhotoFile = null;
    el.photoFile.value = '';
    refreshProfileAvatarPreview();
    el.msg.textContent = 'Photo will be removed when you save.';
    el.msg.classList.remove('ok');
  });
  el.photoFile.addEventListener('change', () => {
    const file = el.photoFile.files && el.photoFile.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      el.msg.textContent = 'Please choose an image file.';
      el.msg.classList.remove('ok');
      el.photoFile.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      el.msg.textContent = 'Image must be smaller than 5MB.';
      el.msg.classList.remove('ok');
      el.photoFile.value = '';
      return;
    }
    localState.selectedPhotoFile = file;
    localState.removePhoto = false;
    const objectUrl = URL.createObjectURL(file);
    localState.photoURL = objectUrl;
    refreshProfileAvatarPreview();
    el.msg.textContent = 'Photo selected. Click Save to upload.';
    el.msg.classList.remove('ok');
  });
  el.phone.addEventListener('input', () => {
    const before = el.phone.value;
    const prevStart = el.phone.selectionStart || el.phone.value.length;
    const next = formatPhoneInputValue(before);
    el.phone.value = next;
    const delta = next.length - before.length;
    const nextPos = Math.min(next.length, Math.max(0, prevStart + delta));
    el.phone.setSelectionRange(nextPos, nextPos);
  });

  el.save.addEventListener('click', async () => {
    const nextDisplayName = el.displayName.value.trim();
    const nextPhone = formatPhoneInputValue(el.phone.value.trim());
    const nextTitle = el.title.value.trim();

    if (!nextDisplayName) {
      el.msg.textContent = 'Display name is required.';
      el.msg.classList.remove('ok');
      return;
    }

    el.save.disabled = true;
    el.msg.textContent = '';
    try {
      let nextPhotoURL = (profile.photoURL || user.photoURL || '').trim();
      const avatarRef = storageRef(storage, `users/${user.uid}/avatar`);
      if (localState.selectedPhotoFile) {
        await uploadBytes(avatarRef, localState.selectedPhotoFile, {
          contentType: localState.selectedPhotoFile.type,
        });
        nextPhotoURL = await getDownloadURL(avatarRef);
      } else if (localState.removePhoto) {
        nextPhotoURL = '';
      }

      await setDoc(userRef, {
        displayName: nextDisplayName,
        phone: nextPhone,
        title: nextTitle,
        photoURL: nextPhotoURL,
      }, { merge: true });

      if (user.displayName !== nextDisplayName || (user.photoURL || '') !== nextPhotoURL) {
        await updateProfile(user, {
          displayName: nextDisplayName,
          photoURL: nextPhotoURL || null,
        });
      }

      profile.displayName = nextDisplayName;
      profile.phone = nextPhone;
      profile.title = nextTitle;
      profile.photoURL = nextPhotoURL;
      window.userProfile = profile;
      refreshNav(nextDisplayName, nextPhotoURL);

      el.msg.textContent = 'Profile updated.';
      el.msg.classList.add('ok');
      setTimeout(close, 450);
    } catch (err) {
      console.error('profile update failed', err);
      el.msg.textContent = 'Could not save profile. Please try again.';
      el.msg.classList.remove('ok');
    } finally {
      el.save.disabled = false;
    }
  });
}

// ── Auth state listener ──────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {

  // 1. Not signed in → redirect to login
  if (!user) {
    window.location.replace('login');
    return;
  }

  // 2. Domain check — only @eduversal.org (or email/password) accounts allowed
  if (!isDomainAllowed(user)) {
    await signOut(auth);
    window.location.replace('login?error=domain');
    return;
  }

  // 3. Fetch (or create) Firestore profile
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

  // 4. Role check
  const platformRole = profile[PLATFORM_KEY];
  if (!ALLOWED_ROLES.includes(platformRole)) {
    await signOut(auth);
    window.location.replace('login?error=access');
    return;
  }
  // Set profile.role for backward compat with page-level checks
  profile.role = platformRole;

  // 5. Name prompt if missing
  if (!profile.displayName) {
    const name = await promptForName();
    await setDoc(userRef, { displayName: name }, { merge: true });
    profile.displayName = name;
  }

  // 6. All checks passed — expose globals
  window.currentUser = user;
  window.userProfile = profile;

  // ── Cache shared nav element references ──────────────────────────
  const navAuth     = document.querySelector('.nav-auth');
  const navUserName = document.querySelector('.nav-user-name');
  const navAvatar   = document.getElementById('navAvatar');
  const logoutBtn   = document.getElementById('logoutBtn');
  const displayName = profile.displayName || user.displayName;

  // ── Show Console nav link for central_admin (in nav-links) ──
  if (platformRole === 'central_admin') {
    const navLinks = document.querySelector('.nav-links');
    if (navLinks && !navLinks.querySelector('a[href="console"]')) {
      const link = document.createElement('a');
      link.href        = 'console';
      link.className   = 'nav-link';
      link.setAttribute('data-nav-page', 'console');
      link.textContent = 'Console';
      navLinks.appendChild(link);
    }
  }

  // ── Populate shared nav elements ─────────────────────────────────

  if (navUserName) {
    navUserName.textContent = displayName || user.email;
  }

  if (navAvatar) {
    applyAvatarVisual(navAvatar, displayName, user.email, profile.photoURL || user.photoURL || '');
  }

  if (navAvatar) {
    mountProfileModal({ user, profile, userRef, navUserName, navAvatar });
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
