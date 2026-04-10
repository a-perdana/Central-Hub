# CentralHub — Architecture Reference

## What This App Is

CentralHub is the super-admin control panel for the Eduversal platform. `central_user` and `central_admin` roles can access it; only `central_admin` sees management actions. It manages schools, staff, announcements, documents, and the message board across the whole platform. It is a **vanilla HTML/CSS/JS application** (no React, no bundler framework). Pages are plain `.html` files with inline scripts that load Firebase via CDN.

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
4. **Domain check** — if email is not `@eduversal.org` (and not an email/password account) → signs out and redirects to `login?error=domain`.
5. Fetches `users/{uid}` from Firestore. If missing, creates a profile and auto-assigns `central_user`.
6. Role-checks against `['central_user', 'central_admin']`. If not allowed → signs out and redirects to `login?error=access`.
7. Exposes globals and dispatches `authReady`.

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

Each platform has its **own** Firestore role field — there is no single shared `role` field. **The legacy `role` field is no longer read by any app** — `auth-guard.js` and all pages use only `role_<platform>` fields.

| Platform      | Firestore field       | Allowed values                          |
|---------------|-----------------------|-----------------------------------------|
| CentralHub    | `role_centralhub`     | `'central_user'` \| `'central_admin'`  |
| Academic Hub  | `role_academichub`    | `'academic_user'` \| `'academic_admin'`|
| Teachers Hub  | `role_teachershub`    | `'teachers_user'` \| `'teachers_admin'`|
| Research Hub  | `role_researchhub`    | `'research_user'` \| `'research_admin'`|

**Sub-role arrays** (managed in `console.html`, optional per user):

| Platform     | Firestore field  | Values                                                                        |
|--------------|------------------|-------------------------------------------------------------------------------|
| Central Hub  | `ch_sub_roles[]` | `'director'`, `'coordinator'`                                                 |
| Academic Hub | `ah_sub_roles[]` | `'foundation_representative'`, `'school_principal'`, `'academic_coordinator'`, `'cambridge_coordinator'` |
| Teachers Hub | `th_sub_roles[]` | `'subject_teacher'`, `'subject_leader'`                                       |

Sub-roles control tab visibility in weekly-checklist pages and `visible_to[]` filtering on dashboard category documents. A user can hold multiple sub-roles simultaneously.

**Approval status fields** (managed in `console.html`; shown as inline Approve/Reject buttons for pending users):

| Platform     | Firestore field                  | Values                                     |
|--------------|----------------------------------|--------------------------------------------|
| Academic Hub | `approval_status_academichub`    | `'pending'` (default) \| `'approved'` \| `'rejected'` |
| Teachers Hub | `approval_status_teachershub`    | `'pending'` (default) \| `'approved'` \| `'rejected'` |

`console.html` shows a banner at the top and a stat card when there are pending users. Clicking either filters the user list to pending users. `academic_admin` and `teachers_admin` bypass the approval check.

**CentralHub allowed values:** `'central_user'` (read access) | `'central_admin'` (full management access).

Access is restricted to `@eduversal.org` email addresses (enforced in both `login.html` and `auth-guard.js`). Email/password accounts created manually in Firebase Console bypass the domain check. First login auto-assigns `central_user` via `setDoc` with `{ merge: true }`. `central_admin` must be set manually via `console.html`.

**isAdmin check pattern:**
```js
const isAdmin = profile?.role_centralhub === 'central_admin';
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
| `calendar_events/{docId}`           | Academic calendar events (title, category, department, date_start, date_end). Sheets events are merged with Firestore overrides at runtime. | central_admin |
| `calendar_settings/current`         | Single-document academic year config: `academicYearStart` (ISO), `totalTeachingWeeks` (int), `terms[]` ({label, start, end}). **Single source of truth for all date/term data — never store termStart or totalWeeks anywhere else.** | central_admin |
| `math_pacing/year9-10`              | IGCSE math pacing: `chapters[]`, `classes[]`, `objPrefixes[]`. Read by Teachers Hub. | central_admin |
| `biology_pacing/year9-10`           | IGCSE biology pacing — same structure as math_pacing.            | central_admin |
| `chemistry_pacing/year9-10`         | IGCSE chemistry pacing — same structure as math_pacing.          | central_admin |
| `physics_pacing/year9-10`           | IGCSE physics pacing — same structure as math_pacing.            | central_admin |
| `igcse_syllabus/{docId}`            | Syllabus reference items. **Doc ID format: `{subjectCode}_{syllabusCode}` e.g. `0580_C1.1`**. Fields: `code` (display code e.g. `C1.1`), `title`, `tier` (`Core`/`Extended`), `topicArea`, `description`, `content`, `notes`. Autocomplete in igcse-math-pacing must search `entry.code` field, NOT the doc ID. | central_admin |
| `userProgress/{uid}`                | Per-teacher pacing progress written by Teachers Hub. Not read by Central Hub yet. | owner (teacher) |

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
3. Injects `<link rel="stylesheet" href="shared-styles.css">` into every HTML page (before the first `<style>` tag).
4. Copies all HTML files into `dist/`.
5. Copies `auth-guard.js`, `calendar-fallback.js`, `shared-styles.css`, and `resources/` into `dist/`.

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
| `academic-calendar.html`           | `/academic-calendar`            | Academic calendar (Sheets + Firestore events). Admin: **⚙ Year Settings** modal writes `calendar_settings/current` (academicYearStart, totalTeachingWeeks, terms). This is the single source of truth for all date/term data across the platform. |
| `igcse-syllabus.html`              | `/igcse-syllabus`               | IGCSE syllabus guide — view/edit syllabus entries, GLH, chapter hours. Redirects to Teacher Progress (math only). Old URL `/igcse-pacing` redirects here. |
| `igcse-math-pacing.html`          | `/igcse-math-pacing`            | IGCSE Math pacing admin — chapter/topic structure, inline edit (codes autocomplete from `igcse_syllabus`, hours, week), Teacher Progress, Coverage Heatmap, Hours Report. Old URL `/igcse-math-admin` redirects here. |
| `as-alevel-pacing.html`            | `/as-alevel-pacing`             | A-Level pacing guide                              |
| `primary-checkpoint-pacing.html`   | `/primary-checkpoint-pacing`    | Primary checkpoint pacing (Year 4–6)              |
| `secondary-checkpoint-pacing.html` | `/secondary-checkpoint-pacing`  | Secondary checkpoint pacing (Year 7–8)            |
| `console.html`                     | `/console`                      | User management — sets all 4 platform role fields, approves AH + TH users; pending banner + stat card for unapproved users |
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
| `build.js`                   | Vercel build script — injects navbar + shared-styles, generates firebase-config.js, copies assets |
| `shared-styles.css`          | **Central design system** — `:root` tokens, reset, body, modal, drawer, badge, btn, form, table, sidebar, skel/shimmer, avatar, pagination, empty-state, profile modal CSS |
| `partials/navbar.html`       | Shared navbar HTML+CSS+JS injected into every page via `<!-- SHARED_NAVBAR -->` comment   |
| `calendar-fallback.js`       | Static fallback calendar events (`window.CAL_DEMO_EVENTS`) — update each academic year    |
| `firebase.json`              | Firestore rules config (no hosting section used)                                          |
| `firebase-config.js`         | Local dev config (gitignored)                                                             |
| `firebase-config.example.js` | Template for firebase-config.js                                                           |
| `firestore.rules`            | Firestore security rules — **THE authoritative copy, deploy from here**                   |
| `vercel.json`                | Vercel deployment config (build cmd, output dir)                                          |
| `resources/`                 | Static assets                                                                             |

---

## CSS Architecture

All pages share a single design system file: **`shared-styles.css`**.

`build.js` automatically injects `<link rel="stylesheet" href="shared-styles.css">` into every HTML file at build time. During local dev, ensure the tag is present in the HTML file.

### What shared-styles.css provides (do NOT duplicate in page `<style>` blocks):
- `:root` design tokens: `--ink`, `--paper`, `--accent`, `--accent-dk`, `--accent-2`, `--border`, `--shadow-sm`, `--shadow`, `--shadow-lg`, `--radius`, `--white`
- Reset: `* { box-sizing: border-box; margin: 0; padding: 0; }`
- `body {}` base (font, background, color, min-height)
- `.page-layout`, `.sidebar` and all sidebar sub-components
- `.filter-bar`, `.filter-chip`, `.search-input-wrap`, `.search-input`, `.search-icon`, `.btn-reset`
- `.badge` base + all standard color variants (active, inactive, pending, warning, success, info, neutral, violet, danger, draft, read, unread, pinned, featured, role-*)
- `.skel` + `@keyframes shimmer`
- `.modal-overlay`, `.modal`, `@keyframes modalIn`, `.modal-head`, `.modal-close`, `.modal-body`, `.modal-footer`, `.modal-error`
- `.form-group`, `.form-label`, `.form-input`, `.form-select`, `.form-textarea`, `.form-hint`, `.form-error`
- `.btn-primary`, `.btn-save`, `.btn-add`, `.btn-cancel`, `.btn-delete`, `.btn-icon` base
- `.toolbar` and sub-components
- `.avatar`, `.avatar-sm`, `.avatar-lg`
- `.pagination`, `.page-btn`, `.page-btn.active`
- `.empty-state`
- Profile modal CSS (`.profile-modal-*` classes) — auth-guard.js no longer injects these dynamically

### Page-specific `<style>` blocks should contain ONLY:
- `:root` accent color overrides (e.g. `--accent: #7c3aed` for assessments, `--d97706` for appraisals)
- Component styles unique to that page
- Override rules that differ from shared defaults (e.g. different modal max-width, different padding)
- `display: none` overrides for admin-only elements (e.g. `.btn-add { display: none; }`)

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
