# CentralHub — Architecture Reference

## What This App Is

CentralHub is the super-admin control panel for the Eduversal platform. Only `central_admin` users can access it. It manages schools, staff, announcements, documents, and the message board across the whole platform. It is a **vanilla HTML/CSS/JS application** (no React, no bundler framework). Pages are plain `.html` files with inline scripts that load Firebase via CDN.

**Deployment:** Vercel (build output in `dist/`).

---

## Monorepo Structure

```
Eduversal Web/                    ← monorepo root (not a deployed app)
├── Academic Hub/                 ← analytics dashboards (Vercel)
├── CentralHub/                   ← THIS app (Vercel)
│   ├── firestore.rules           ← ⚠️ ONLY Firestore rules file — deploy from here
│   └── firebase.json             ← firebase deploy config
├── Teachers Hub/                 ← teacher tools (Vercel)
├── migrate-auth-and-firestore.js ← one-time migration script
└── keys/                         ← service account JSON keys (gitignored)
```

Each app has its **own GitHub repository** and its **own deployment target**, but all three share the single Firebase backend `centralhub-8727b`.

---

## Shared Firebase Backend

**Project ID:** `centralhub-8727b`

| Field                | Value                                      |
|----------------------|--------------------------------------------|
| authDomain           | centralhub-8727b.firebaseapp.com           |
| projectId            | centralhub-8727b                           |
| storageBucket        | centralhub-8727b.firebasestorage.app       |
| messagingSenderId    | 244951050014                               |
| apiKey / appId       | gitignored — see Firebase Console          |

**SDK:** Firebase modular v10 (`10.7.1`), loaded from the CDN:
```
https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js
https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js
https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js
```
Do NOT use the compat SDK (`firebase/app`, `firebase.firestore()` namespace style). Always use modular imports.

---

## Firebase Config Pattern

**`firebase-config.js`** (gitignored) sets `window.ENV` at page load:
```js
window.ENV = {
  FIREBASE_API_KEY: "...",
  FIREBASE_AUTH_DOMAIN: "centralhub-8727b.firebaseapp.com",
  // ...
};
```

All HTML pages load this with:
```html
<script src="firebase-config.js"></script>
```

**`build.js`** generates `dist/firebase-config.js` from Vercel environment variables and copies all HTML/JS/asset files into `dist/`. The `firebase-config.js` source file is NOT deployed — it is only used for local development.

**Template:** `firebase-config.example.js` — copy to `firebase-config.js` and fill in `apiKey` and `appId`.

---

## Auth Pattern

Every protected page (all pages except `login.html`) loads `auth-guard.js` as a module:
```html
<script type="module" src="auth-guard.js"></script>
```

`auth-guard.js` (modular SDK v10):
1. Hides `document.body` immediately (prevents flash of content).
2. Initialises Firebase (guards against double-init with `getApps()`).
3. Listens on `onAuthStateChanged`. If no user → redirects to `login` (clean URL).
4. Fetches `users/{uid}` from Firestore. If missing, creates a profile stub with no role.
5. Role-checks against `['central_admin']`. If not allowed → signs out and redirects to `login?error=access`.
6. Exposes globals and dispatches `authReady`.

**Globals exposed after `authReady`:**
| Global               | Value                                |
|----------------------|--------------------------------------|
| `window.firebaseApp` | FirebaseApp instance                 |
| `window.auth`        | Auth instance                        |
| `window.db`          | Firestore instance                   |
| `window.currentUser` | firebase.User object                 |
| `window.userProfile` | Firestore `users/{uid}` document     |

**Listening for auth in page scripts:**
```js
document.addEventListener('authReady', ({ detail: { user, profile } }) => {
  // safe to use window.db, window.currentUser, window.userProfile here
});
```

**`login.html`** does NOT use `auth-guard.js` — it handles auth inline using the modular SDK, reading config from `window.ENV`.

---

## Role System

Each platform has its **own** Firestore role field — there is no single shared `role` field. The legacy `role` field still exists on old documents but is no longer the source of truth.

| Platform      | Firestore field       | Allowed values                          |
|---------------|-----------------------|-----------------------------------------|
| CentralHub    | `role_centralhub`     | `'central_user'` \| `'central_admin'`  |
| Academic Hub  | `role_academichub`    | `'academic_user'` \| `'academic_admin'`|
| Teachers Hub  | `role_teachershub`    | `'teachers_user'` \| `'teachers_admin'`|
| Research Hub  | `role_researchhub`    | `'research_user'` \| `'research_admin'`|

**CentralHub allowed values:** `role_centralhub === 'central_admin'`.

`auth-guard.js` also accepts the legacy `role === 'central_admin'` for backwards compatibility with accounts that have not logged in since the migration.

`central_admin` accounts are created **manually** in the Firebase Console (email/password), never via self-registration. First login auto-assigns `central_user` via `setDoc` with `{ merge: true }`.

**isAdmin check pattern (always use both for safety):**
```js
const isAdmin = profile?.role_centralhub === 'central_admin'
             || profile?.role === 'central_admin'; // legacy fallback
```

---

## Firestore Collections

| Collection                          | Purpose                                                          | Write access        |
|-------------------------------------|------------------------------------------------------------------|---------------------|
| `users/{uid}`                       | User profiles (uid, email, displayName, photoURL, role_centralhub, role_academichub, role_teachershub, role_researchhub, createdAt, lastLoginAt) | owner or central_admin |
| `schools/{schoolId}`                | Partner school records                                           | central_admin       |
| `staff/{staffId}`                   | Staff records                                                    | central_admin       |
| `announcements/{annId}`             | Platform-wide announcements                                      | central_admin       |
| `central_documents/{docId}`         | CentralHub-managed documents (was `documents` before migration)  | central_admin       |
| `topics/{topicId}`                  | Message board topics                                             | any authorised user |
| `topics/{topicId}/replies/{replyId}`| Message board replies                                            | any authorised user |
| `activity_projects/{projectId}`     | Activity kanban boards                                           | central_admin       |
| `activity_tasks/{taskId}`           | Tasks inside activity boards (`projectId` field links to project)| central_admin       |
| `surveys/{surveyId}`                | Cross-platform surveys                                           | central_admin       |
| `central_certificates/{certId}`     | Workshop certificate records                                     | central_admin       |
| `feedback/{feedbackId}`             | User feedback submissions from the dashboard floating button     | any authorised user |

**Timestamp field:** always `createdAt` (serverTimestamp). Do not use `timestamp` — that was the legacy name.

**IMPORTANT — collection rename:** CentralHub's documents collection is `central_documents`, NOT `documents`. The rename happened during the multi-project consolidation to avoid Firestore rule conflicts with the legacy `documents` collection.

**Firestore rules** live **exclusively** in `CentralHub/firestore.rules` — this is the single source of truth for all three apps (they share the same Firebase project).

⚠️ **Always deploy rules from the `CentralHub/` directory:**
```bash
cd "Eduversal Web/CentralHub"
firebase deploy --only firestore:rules --project centralhub-8727b
```
Academic Hub and Teachers Hub do NOT have their own `firestore.rules`. Never create one there — it would overwrite the shared rules with an outdated version.

---

## Build & Deployment

**Platform:** Vercel
**Build command:** `node build.js`
**Output directory:** `dist/`

### What `build.js` does:
1. Generates `dist/firebase-config.js` from Vercel environment variables.
2. Injects `partials/navbar.html` into every HTML page (replacing `<!-- SHARED_NAVBAR -->`).
3. Copies all HTML files into `dist/`.
4. Copies `auth-guard.js`, `calendar-fallback.js`, and `resources/` into `dist/`.

### Vercel environment variables required:
```
FIREBASE_API_KEY
FIREBASE_AUTH_DOMAIN
FIREBASE_PROJECT_ID
FIREBASE_STORAGE_BUCKET
FIREBASE_MESSAGING_SENDER_ID
FIREBASE_APP_ID
```

### Firestore rules (separate from hosting):
Rules are deployed independently via the Firebase CLI:
```
firebase deploy --only firestore:rules --project centralhub-8727b
```

---

## Pages

| File                               | Clean URL                       | Purpose                                           |
|------------------------------------|---------------------------------|---------------------------------------------------|
| `index.html`                       | `/`                             | Dashboard / home                                  |
| `login.html`                       | `/login`                        | Login page (no auth guard)                        |
| `announcements.html`               | `/announcements`                | Create/manage announcements                       |
| `messageboard.html`                | `/messageboard`                 | Platform message board                            |
| `schools.html`                     | `/schools`                      | School management                                 |
| `staff.html`                       | `/staff`                        | Staff management                                  |
| `documents.html`                   | `/documents`                    | Document management (`central_documents` collection) |
| `academics.html`                   | `/academics`                    | Academics module hub                              |
| `academic-calendar.html`           | `/academic-calendar`            | Academic calendar (reads Google Apps Script API)  |
| `igcse-pacing.html`                | `/igcse-pacing`                 | IGCSE pacing guide management                     |
| `as-alevel-pacing.html`            | `/as-alevel-pacing`             | A-Level pacing guide                              |
| `secondary-checkpoint-pacing.html` | `/secondary-checkpoint-pacing`  | Secondary checkpoint pacing                       |
| `console.html`                     | `/console`                      | User management — sets all 4 platform role fields |
| `appraisals.html`                  | `/appraisals`                   | Staff appraisal hub                               |
| `school-appraisals.html`           | `/school-appraisals`            | School-level appraisals                           |
| `teacher-appraisals.html`          | `/teacher-appraisals`           | Teacher appraisals                                |
| `ease-system.html`                 | `/ease-system`                  | EASE assessment system                            |
| `assessments.html`                 | `/assessments`                  | Assessments module hub                            |
| `activities.html`                  | `/activities`                   | Activity boards / project kanban                  |
| `surveys.html`                     | `/surveys`                      | Survey response viewer                            |
| `survey-console.html`              | `/survey-console`               | Survey creation & management                      |
| `certificates.html`                | `/certificates`                 | Workshop certificate tracking                     |
| `certificate-verify.html`          | `/certificate-verify`           | Public certificate verification (no auth guard)   |

---

## Key Files

| File                         | Purpose                                                                                   |
|------------------------------|-------------------------------------------------------------------------------------------|
| `auth-guard.js`              | Auth + role gate for all protected pages (modular SDK v10)                                |
| `build.js`                   | Vercel build script — injects navbar, generates firebase-config.js, copies assets         |
| `partials/navbar.html`       | Shared navbar HTML+CSS+JS injected into every page via `<!-- SHARED_NAVBAR -->` comment   |
| `calendar-fallback.js`       | Static fallback calendar events (`window.CAL_DEMO_EVENTS`) — update each academic year    |
| `firebase.json`              | Firestore rules config (no hosting section used)                                          |
| `firebase-config.js`         | Local dev config (gitignored)                                                             |
| `firebase-config.example.js` | Template for firebase-config.js                                                           |
| `firestore.rules`            | Firestore security rules — **THE authoritative copy, deploy from here**                   |
| `vercel.json`                | Vercel deployment config (build cmd, output dir)                                          |
| `resources/`                 | Static assets                                                                             |

---

## Important Conventions

- **No React, no npm bundler.** All JS runs directly in the browser via CDN ESM imports.
- **Always use modular SDK v10.** Never use the compat namespace.
- **`createdAt` not `timestamp`** for all Firestore timestamp fields.
- **Never commit `firebase-config.js`.** It is in `.gitignore`.
- **`central_documents` not `documents`** — the collection was renamed during consolidation.
- **Auth guard goes first.** `auth-guard.js` must be the first `<script type="module">` on protected pages.
- **Use `authReady` event** to gate all Firestore reads — never call `window.db` before the event fires.
- **Login redirects use clean URLs:** `login`, not `login.html`. Auth guard redirects to `'login'` and `'login?error=access'`.
- **Role field is `role_centralhub`**, NOT the legacy `role` field. Always check `profile?.role_centralhub` first, with `profile?.role` as a fallback for legacy accounts.
- **Shared navbar** lives in `partials/navbar.html`. Every page uses `<!-- SHARED_NAVBAR -->` which gets replaced at build time. Do NOT put nav HTML directly in individual pages.
- **Calendar fallback** is `window.CAL_DEMO_EVENTS` loaded from `calendar-fallback.js`. Do NOT inline the array inside page scripts — update the standalone file instead.
- **N+1 Firestore queries are forbidden.** When fetching sub-collections for a list of parents (e.g. tasks for projects), always use a single `where('parentId', 'in', ids)` query and group results in JS. The `in` operator supports up to 30 values.
- **Event notification modal** only appears for events ≤7 days away. Do not change this threshold without user approval.
- **All UI text must be in English.** No Turkish labels in forms, buttons, or cards — this was a past bug (`İlişkili Duyuru`).
- **Dates use `en-GB` locale** everywhere (`toLocaleDateString('en-GB', ...)`). Never use `id-ID` or other locales.

---

## Common Mistakes — Do Not Repeat

These are bugs that were introduced and fixed. Never reintroduce them.

### 1. Missing Firebase imports
Before writing any code that calls a Firestore/Storage function, verify **every** function used is in the import list at the top of the `<script type="module">` block. Past bugs:
- `addDoc` not imported → reply posting silently broken with ReferenceError
- `limit` not imported → dropdown query failed silently
- `deleteDoc` not imported → delete feature broken

**Rule:** After writing code, scan every function call against the import list. If it's not there, add it.

### 2. Undefined CSS variables
Every `var(--name)` used in CSS must be defined in `:root`. Past bug: `--accent-2` was used in `.cat-btn.active` and `.post-op-label` but missing from `:root` — those elements rendered with no background colour.

**Rule:** When adding a new CSS variable usage, add it to `:root` at the same time.

### 3. Never use `alert()` or `confirm()`
Browser blocking dialogs are banned. Use inline error messages (`.visible` class on error elements) or double-click confirmation patterns (set `data-confirming` attribute, reset after 3s timeout).

### 4. Admin-only UI must check `isAdmin`
Edit, Delete, and any destructive/management buttons must be gated behind `isAdmin`. Never render admin actions for all users and rely on Firestore rules to block the write — the UI must enforce it too. Past bug: Edit Topic button shown to all users.

**Pattern:**
```js
const isAdmin = profile?.role_centralhub === 'central_admin' || profile?.role === 'central_admin';
// then in authReady handler, set module-level isAdmin variable
// then gate: if (isAdmin) { ... render admin buttons ... }
```

### 5. Validate user-supplied URLs
Any URL from Firestore or user input used in an `href` or `src` must be validated. Block `javascript:` protocol:
```js
function safeUrl(url) {
  return /^https?:\/\//i.test(url) ? url : '#';
}
```

### 6. After a single document mutation, refresh only that document
Do not call `loadTopics()` (full collection refetch) just to update one document's data. Use a targeted `getDoc` and update the in-memory array:
```js
const snap = await getDoc(fsDoc(db, 'topics', id));
const idx = allTopics.findIndex(t => t.id === id);
if (idx >= 0) allTopics[idx] = { id, ...snap.data() };
```

### 7. Large collections need pagination
Never fetch an unbounded collection with `getDocs(collection(...))`. Always add `limit(N)` and a "Load more" UI pattern. Past bug: `loadTopics()` fetched all topics with no limit.

### 8. Cancel button context
When a form is used for both Create and Edit modes, the Cancel button must return to the appropriate view:
- Editing → back to the thread/detail view
- Creating → back to the list view
Never unconditionally `showView('list')` in a shared Cancel handler.
