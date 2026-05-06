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
import { getFirestore, doc, getDoc, getDocs, setDoc, addDoc, collection, serverTimestamp }
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

// ── Subject-specialty gating ─────────────────────────────────────
// Maps each subject-specific page slug to the ch_subjects[] values
// that grant access.
//
// Sub-role hierarchy (applies even before ch_subjects[]):
//   - central_admin: bypass — full management surface.
//   - director: bypass — directors sit *above* subject specialists,
//     they are network-wide and need cross-subject visibility.
//   - coordinator: ALWAYS filtered by ch_subjects[]. A coordinator IS
//     a subject specialist. If a coordinator's ch_subjects[] is empty
//     they see no subject pages — that's a misconfiguration; promote
//     them to director (or assign subjects) on /console.
//   - other central_users: filtered by ch_subjects[]; empty = no access.
//
// Combined-science pacing pages accept ANY of biology/chemistry/physics.
const SUBJECT_PAGE_MAP = {
  // IGCSE single-subject
  'igcse-math-pacing':           ['math'],
  'igcse-biology-pacing':        ['biology'],
  'igcse-chemistry-pacing':      ['chemistry'],
  'igcse-physics-pacing':        ['physics'],
  // AS/A-Level single-subject
  'as-alevel-math-pacing':       ['math'],
  'as-alevel-biology-pacing':    ['biology'],
  'as-alevel-chemistry-pacing':  ['chemistry'],
  'as-alevel-physics-pacing':    ['physics'],
  // Checkpoint
  'checkpoint-math-pacing':      ['math'],
  'checkpoint-english-pacing':   ['english'],
  'checkpoint-science-pacing':   ['biology', 'chemistry', 'physics', 'science'],
};

// Syllabus pages render multiple subject tabs in one page. Each entry
// lists every ch_subjects[] value that *any* tab on that page accepts;
// a user with no overlap gets the link hidden and the page itself shows
// a "no matching subjects" notice. Keep in sync with each syllabus
// HTML's initSyllabusPage({ subjects }) config.
const SYLLABUS_PAGE_SUBJECTS = {
  'igcse-syllabus':                 ['math', 'biology', 'chemistry', 'physics'],
  'as-alevel-syllabus':             ['math', 'biology', 'chemistry', 'physics'],
  // Checkpoint Science is the combined-science subject — biology /
  // chemistry / physics specialists may also enter to read the lower-
  // secondary build-up of their subject (matches checkpoint_science_pacing
  // rule layer + SUBJECT_PAGE_MAP['checkpoint-science-pacing']).
  'secondary-checkpoint-syllabus':  ['math', 'english', 'science', 'biology', 'chemistry', 'physics'],
  'primary-checkpoint-syllabus':    ['math', 'english', 'science', 'biology', 'chemistry', 'physics'],
};

// Pages that NEVER get gated regardless of role (auth flow + dashboard).
const SUBJECT_GATE_BYPASS = new Set(['', 'index', 'login']);

function currentPageKey() {
  const path = (window.location.pathname || '/').toLowerCase();
  let slug = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.html$/, '');
  if (slug.includes('/')) slug = slug.split('/')[0];
  return slug;
}

function isSubjectAllowed(profile, pageKey) {
  // central_admin bypasses unconditionally.
  if (profile?.role_centralhub === 'central_admin') return true;

  const requiredSubjects = SUBJECT_PAGE_MAP[pageKey];
  if (!requiredSubjects) return true; // not a subject-gated page

  // director sits above subject specialists — cross-subject visibility.
  const chSubRoles = Array.isArray(profile?.ch_sub_roles) ? profile.ch_sub_roles : [];
  if (chSubRoles.includes('director')) return true;

  // Everyone else (coordinator + plain central_user) is filtered by
  // ch_subjects[]. Empty array = no subject access.
  const userSubjects = Array.isArray(profile?.ch_subjects) ? profile.ch_subjects : [];
  return userSubjects.some(s => requiredSubjects.includes(s));
}

// Same hierarchy as isSubjectAllowed but answers "given a list of
// candidate subject keys, which can this user see?". Used by pages
// that render multiple subjects in tabs (syllabus pages, etc.).
//   - Returns the input array unchanged for admin / director.
//   - Returns the intersection with ch_subjects[] for coordinator /
//     plain user. Empty ch_subjects[] → empty result.
//
// Subject keys are the canonical ones in ch_subjects[]:
// 'math' | 'biology' | 'chemistry' | 'physics' | 'science' | 'english' | 'bahasa' | 'religion'.
// 'science' is the combined-science specialty used by checkpoint pages
// (separate from biology/chemistry/physics which are IGCSE/AS-A-Level only).
function visibleSubjectsForUser(profile, candidateKeys) {
  const keys = Array.isArray(candidateKeys) ? candidateKeys : [];
  if (profile?.role_centralhub === 'central_admin') return keys.slice();
  const chSubRoles = Array.isArray(profile?.ch_sub_roles) ? profile.ch_sub_roles : [];
  if (chSubRoles.includes('director')) return keys.slice();
  const userSubjects = Array.isArray(profile?.ch_subjects) ? profile.ch_subjects : [];
  return keys.filter(k => userSubjects.includes(k));
}

// Inject CSS once so [data-ch-hidden="1"] elements collapse without flicker.
function ensureSubjectGateStyles() {
  if (document.getElementById('chSubjectGateStyle')) return;
  const style = document.createElement('style');
  style.id = 'chSubjectGateStyle';
  style.textContent = '[data-ch-hidden="1"] { display: none !important; }';
  document.head.appendChild(style);
}

// Walk navbar links + dashboard cards and hide subject-specific entries
// the user cannot access. Mirrors the AH page-access pattern but driven
// by ch_subjects[] instead of page_access_config.
function applySubjectGating(profile) {
  ensureSubjectGateStyles();

  // Resolve a slug to "should this be hidden from the current user?".
  // Single-subject pacing pages use SUBJECT_PAGE_MAP. Multi-subject
  // syllabus pages use SYLLABUS_PAGE_SUBJECTS — hidden only when none
  // of the page's subjects intersect ch_subjects[].
  const slugHidden = (key) => {
    if (key in SUBJECT_PAGE_MAP) return !isSubjectAllowed(profile, key);
    if (key in SYLLABUS_PAGE_SUBJECTS) {
      return visibleSubjectsForUser(profile, SYLLABUS_PAGE_SUBJECTS[key]).length === 0;
    }
    return false; // not a subject-gated slug
  };

  // 1. Navbar links by data-nav-key (CH navbar uses these)
  document.querySelectorAll('[data-nav-key], [data-nav-page]').forEach(el => {
    const key = (el.getAttribute('data-nav-key') || el.getAttribute('data-nav-page') || '').toLowerCase();
    if (!key || SUBJECT_GATE_BYPASS.has(key)) return;
    if (slugHidden(key)) el.setAttribute('data-ch-hidden', '1');
  });

  // 2. Dashboard cards <a class="card" href="...">
  document.querySelectorAll('a.card[href]').forEach(el => {
    const href = el.getAttribute('href') || '';
    let slug = href.toLowerCase().replace(/^\/+/, '').replace(/\.html$/, '');
    if (slug.includes('/')) slug = slug.split('/')[0];
    if (slug.includes('?')) slug = slug.split('?')[0];
    if (!slug || SUBJECT_GATE_BYPASS.has(slug)) return;
    if (slugHidden(slug)) el.setAttribute('data-ch-hidden', '1');
  });
}

// ── Page-access helpers (sub-role gating via page_access_config) ──
// Companion to subject-specialty gating above (which keys off
// ch_subjects[]). This one keys off ch_sub_roles[] (director / coordinator).
// Both can run on the same DOM — they use different `data-*-hidden`
// attributes and a shared "display: none !important" rule.
const PAGE_ACCESS_BYPASS = new Set(['', 'index', 'login']);
// Cache TTL — short enough that an admin's page-access save is felt
// almost immediately by other tabs, long enough to absorb hot navigation.
// Was 5 min before 2026-05-05; cut to 60s when we noticed admins were
// surprised that hidden=true didn't block coordinators until their
// session expired. Real-time listeners would be tighter but this is
// "good enough" for a tool admin save uses several times a year.
const PAGE_ACCESS_TTL_MS = 60 * 1000;

async function getPageAccessConfig(database, pageKey) {
  try {
    const raw = sessionStorage.getItem('pac:' + pageKey);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached && (Date.now() - cached.at) < PAGE_ACCESS_TTL_MS) return cached.data;
    }
  } catch (_) {}
  let data = null;
  try {
    const snap = await getDoc(doc(database, 'page_access_config', pageKey));
    data = snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('page_access_config read failed for', pageKey, err);
    return null;
  }
  try {
    sessionStorage.setItem('pac:' + pageKey, JSON.stringify({ at: Date.now(), data }));
  } catch (_) {}
  return data;
}

async function getAllPageAccessConfigs(database) {
  try {
    const raw = sessionStorage.getItem('pac:__all__:centralhub');
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached && (Date.now() - cached.at) < PAGE_ACCESS_TTL_MS) return new Map(cached.entries);
    }
  } catch (_) {}
  const map = new Map();
  try {
    // @lint-allow-unbounded — full config doc set (~54 small docs); cached for 5 min
    const snap = await getDocs(collection(database, 'page_access_config'));
    snap.forEach(d => {
      const data = d.data() || {};
      if (data.platform && data.platform !== 'centralhub') return;
      map.set(d.id, data);
    });
    sessionStorage.setItem('pac:__all__:centralhub', JSON.stringify({
      at: Date.now(),
      entries: [...map.entries()],
    }));
  } catch (err) {
    console.warn('page_access_config bulk read failed', err);
  }
  return map;
}

function paSlugFromHref(href) {
  if (!href) return '';
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return '';
    let p = url.pathname.toLowerCase();
    p = p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.html$/, '');
    if (p.includes('/')) p = p.split('/').pop();
    return p;
  } catch (_) {
    return '';
  }
}

function ensurePageAccessStyles() {
  if (document.getElementById('paGatingStyle')) return;
  const style = document.createElement('style');
  style.id = 'paGatingStyle';
  style.textContent = '[data-pa-hidden="1"] { display: none !important; }';
  document.head.appendChild(style);
}

function applyPageAccessGating(configs, userSubRoles) {
  // Director sits above coordinator in the CH sub-role hierarchy and
  // bypasses page-access entirely (mirrors central_admin). Admins cannot
  // accidentally lock directors out by setting visible_to=['coordinator'].
  // Keep in sync with the URL-level guard at step 4c.
  const isDirector = userSubRoles.includes('director');
  const isAllowed = (cfg) => {
    if (!cfg) return true;
    if (isDirector) return true;
    if (cfg.hidden === true) return false;
    const vt = Array.isArray(cfg.visible_to) ? cfg.visible_to : [];
    if (vt.length === 0) return true;
    return userSubRoles.some(r => vt.includes(r));
  };

  document.querySelectorAll('[data-nav-key], [data-nav-page]').forEach(el => {
    const key = (el.getAttribute('data-nav-key') || el.getAttribute('data-nav-page') || '').toLowerCase();
    if (!key || PAGE_ACCESS_BYPASS.has(key)) return;
    if (!configs.has(key)) return;
    if (!isAllowed(configs.get(key))) el.setAttribute('data-pa-hidden', '1');
    else                              el.removeAttribute('data-pa-hidden');
  });

  document.querySelectorAll('a.card[href]').forEach(el => {
    const key = paSlugFromHref(el.getAttribute('href'));
    if (!key || PAGE_ACCESS_BYPASS.has(key)) return;
    if (!configs.has(key)) return;
    if (!isAllowed(configs.get(key))) el.setAttribute('data-pa-hidden', '1');
    else                              el.removeAttribute('data-pa-hidden');
  });

  // CH navbar uses .ch-dd-wrap for dropdowns; hide if every child is hidden.
  ['.ch-dd-wrap', '.ch-dd-submenu-wrap'].forEach(selector => {
    document.querySelectorAll(selector).forEach(group => {
      const items = group.querySelectorAll('[data-nav-key], [data-nav-page]');
      if (!items.length) return;
      const allHidden = [...items].every(it =>
        it.getAttribute('data-pa-hidden') === '1' || it.getAttribute('data-ch-hidden') === '1'
      );
      if (allHidden) group.setAttribute('data-pa-hidden', '1');
      else            group.removeAttribute('data-pa-hidden');
    });
  });

  document.querySelectorAll('.ch-dd-col').forEach(col => {
    const items = col.querySelectorAll('[data-nav-key], [data-nav-page]');
    if (!items.length) return;
    const allHidden = [...items].every(it =>
      it.getAttribute('data-pa-hidden') === '1' || it.getAttribute('data-ch-hidden') === '1'
    );
    if (allHidden) col.setAttribute('data-pa-hidden', '1');
    else            col.removeAttribute('data-pa-hidden');
  });
}

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
window.storage     = storage;

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
        <div class="profile-field">
          <label>CentralHub Access <span style="font-size:0.7rem;font-weight:400;color:#8888a8;margin-left:6px">(set by central_admin)</span></label>
          <div id="profileAccessSummary" style="font-size:0.85rem;color:#1c1c2e;background:#f7f6f3;border:1px solid #e0ddd6;border-radius:8px;padding:10px 12px;line-height:1.6">
            <em style="color:#8888a8">— loading —</em>
          </div>
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
    accessSummary: overlay.querySelector('#profileAccessSummary'),
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
    if (el.accessSummary) renderAccessSummary();
  };

  // Read-only summary of the user's CentralHub role + sub-roles + subject
  // specialties. To change any of these, a central_admin must edit the
  // user's record in console.html.
  const SUBJECT_LABELS = {
    math: 'Mathematics', biology: 'Biology', chemistry: 'Chemistry',
    physics: 'Physics', science: 'Science', english: 'English',
    bahasa: 'Bahasa', religion: 'Religion',
  };
  const SUB_ROLE_LABELS = { director: 'Director', coordinator: 'Coordinator' };
  const renderAccessSummary = () => {
    const role     = profile.role_centralhub || '—';
    const subRoles = Array.isArray(profile.ch_sub_roles) ? profile.ch_sub_roles : [];
    const subjects = Array.isArray(profile.ch_subjects) ? profile.ch_subjects : [];
    const chip = (text) => `<span style="display:inline-block;padding:2px 9px;border-radius:100px;background:#ede9fe;color:#5b21b6;font-size:0.72rem;font-weight:600;margin:2px 4px 2px 0">${text}</span>`;
    const muted = (text) => `<span style="color:#8888a8;font-style:italic">${text}</span>`;
    const lines = [];
    lines.push(`<div><strong style="color:#44445a">Role:</strong> ${role === '—' ? muted('— not set —') : role}</div>`);
    lines.push(`<div style="margin-top:4px"><strong style="color:#44445a">Sub-roles:</strong> ${subRoles.length ? subRoles.map(r => chip(SUB_ROLE_LABELS[r] || r)).join('') : muted('none')}</div>`);
    lines.push(`<div style="margin-top:4px"><strong style="color:#44445a">Subject specialties:</strong> ${subjects.length ? subjects.map(s => chip(SUBJECT_LABELS[s] || s)).join('') : muted('none — assign in console to access subject-specific pacing pages')}</div>`);
    el.accessSummary.innerHTML = lines.join('');
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

  // 1b. Career applicant guard. TH `/careers-apply` uses
  // sendSignInLinkToEmail to mail candidates a magic-link for application
  // tracking. That sign-in must NEVER provision a Central Hub profile —
  // applicants are not HQ staff. Detected via providerData carrying
  // 'emailLink'. Redirect to TH careers-status host without creating a
  // users/{uid} doc.
  const isEmailLinkUser = user.providerData.some(p => p.providerId === 'emailLink');
  if (isEmailLinkUser) {
    window.location.replace('https://teachershub.eduversal.org/careers-status');
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
      if (profile[PLATFORM_KEY] == null) {
        await setDoc(userRef, { [PLATFORM_KEY]: DEFAULT_ROLE }, { merge: true });
        profile = { ...profile, [PLATFORM_KEY]: DEFAULT_ROLE };
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

  // 4b. Subject-specialty gate — block direct URL access to a pacing
  //     page outside the user's ch_subjects[]. Admins, directors and
  //     coordinators bypass via isSubjectAllowed(). Sends to dashboard
  //     with a banner via sessionStorage so we don't loop on the page.
  const pageKey = currentPageKey();
  if (!isSubjectAllowed(profile, pageKey)) {
    try {
      sessionStorage.setItem('ch_subject_denied', JSON.stringify({
        pageKey,
        requiredSubjects: SUBJECT_PAGE_MAP[pageKey] || [],
        at: Date.now(),
      }));
    } catch (_) {}
    window.location.replace('/?denied=' + encodeURIComponent(pageKey));
    return;
  }

  // 4c. Page-access gate (sub-role gating via page_access_config).
  //     Companion to the subject-specialty gate above, this one keys
  //     off ch_sub_roles[] (director / coordinator). central_admin
  //     bypasses; missing config / empty visible_to ⇒ allow.
  //     cfg.hidden === true hides the page from every non-admin.
  if (platformRole !== 'central_admin' && pageKey && !PAGE_ACCESS_BYPASS.has(pageKey)) {
    const cfg = await getPageAccessConfig(db, pageKey);
    if (cfg) {
      const userSubRoles = Array.isArray(profile.ch_sub_roles) ? profile.ch_sub_roles : [];
      // Director bypasses page-access entirely (sits above coordinator,
      // mirrors central_admin). Stays in sync with applyPageAccessGating.
      const isDirector = userSubRoles.includes('director');
      const isHidden = !isDirector && cfg.hidden === true;
      const vt = Array.isArray(cfg.visible_to) ? cfg.visible_to : [];
      const subRoleAllowed = isDirector || vt.length === 0 || userSubRoles.some(r => vt.includes(r));
      const allowed = !isHidden && subRoleAllowed;
      if (!allowed) {
        try {
          sessionStorage.setItem('ch_access_denied', JSON.stringify({
            pageKey,
            label: cfg.label || pageKey,
            at: Date.now(),
          }));
        } catch (_) {}
        window.location.replace('/?denied=' + encodeURIComponent(pageKey));
        return;
      }
    }
  }

  // 5. Name prompt if missing
  if (!profile.displayName) {
    const name = await promptForName();
    await setDoc(userRef, { displayName: name }, { merge: true });
    profile.displayName = name;
  }

  // 6. All checks passed — expose globals
  window.currentUser = user;
  window.userProfile = profile;

  // Log platform usage event (fire-and-forget, non-blocking)
  addDoc(collection(db, 'platform_usage'), {
    userId:   user.uid,
    platform: 'centralhub',
    role:     profile[PLATFORM_KEY] || '',
    ts:       serverTimestamp(),
  }).catch(() => {});  // silently ignore if rules block or offline

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

  // 6b. UI gating — hide subject-specific navbar links + dashboard cards
  //     the user cannot access. Same approach as Academic Hub's
  //     applyPageAccessGating(): initial pass + MutationObserver for
  //     async navbar mounts and dynamically inserted cards.
  applySubjectGating(profile);
  const subjectMo = new MutationObserver(muts => {
    const interesting = muts.some(m =>
      [...m.addedNodes].some(n =>
        n.nodeType === 1 && (
          n.matches?.('[data-nav-key], [data-nav-page], a.card[href]') ||
          n.querySelector?.('[data-nav-key], [data-nav-page], a.card[href]')
        )
      )
    );
    if (interesting) applySubjectGating(profile);
  });
  subjectMo.observe(document.body, { childList: true, subtree: true });
  window.__chSubjectGate = () => applySubjectGating(profile);
  // Pages that render their own subject tabs (e.g. syllabus-core.js)
  // ask "which of these subject keys is this user allowed to see?".
  window.__chVisibleSubjects = (candidateKeys) =>
    visibleSubjectsForUser(profile, candidateKeys);

  // 6c. Page-access UI gating — hide navbar links + cards the user
  //     can't access by sub-role (ch_sub_roles[]). central_admin
  //     bypasses; same MutationObserver pattern as subject gating
  //     so it picks up async navbar mounts and dynamically added cards.
  if (platformRole !== 'central_admin') {
    ensurePageAccessStyles();
    const subRoles = Array.isArray(profile.ch_sub_roles) ? profile.ch_sub_roles : [];
    const configs  = await getAllPageAccessConfigs(db);
    const runPaGating = () => applyPageAccessGating(configs, subRoles);
    runPaGating();
    const paMo = new MutationObserver(muts => {
      const interesting = muts.some(m =>
        [...m.addedNodes].some(n =>
          n.nodeType === 1 && (
            n.matches?.('[data-nav-key], [data-nav-page], a.card[href]') ||
            n.querySelector?.('[data-nav-key], [data-nav-page], a.card[href]')
          )
        )
      );
      if (interesting) runPaGating();
    });
    paMo.observe(document.body, { childList: true, subtree: true });
    window.__paGate = runPaGating;
  }

  // 7. Show page and notify
  document.body.style.visibility = 'visible';
  document.dispatchEvent(new CustomEvent('authReady', {
    detail: { user, profile },
  }));
});
