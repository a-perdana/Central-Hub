# Central Hub — Architecture Reference

## What This App Is

Eduversal HQ operations portal — nerve centre for the entire partner school network. Users:

- **Directors** — Primary Schools / Secondary Schools
- **Subject Specialists** — Math, English, Bahasa, Physics, Chemistry, Biology, Religion (gated by `ch_subjects[]`)
- **Coordinators** — cross-functional HQ

Key responsibilities: partner school profiles + performance, staff DB, announcements, document repo, activity kanban, EASE coordination, appraisal visit management, academic calendar (single source of truth), weekly checklists, **competency evidence review for all 3 platforms**, **induction admin**, full user/role management via `/console`, **page-access manager** for all 3 hubs, Cambridge ↔ Indonesian KM curriculum alignment.

Access restricted to `@eduversal.org`. `central_user` reads + participates; `central_admin` has full management. **Vanilla HTML/CSS/JS** (no React, no bundler).

**Deployment:** Vercel (`dist/`).

---

## Shared Firebase Backend

**Project:** `centralhub-8727b` (shared with AH / TH / Research Hub).

**SDK:** Firebase modular v10.7.1, CDN imports. NEVER use compat (`firebase.firestore()`).

**Config:**
- `firebase-config.js` (gitignored) sets `window.ENV.*`
- All HTML pages: `<script src="firebase-config.js"></script>`
- `build.js` generates `dist/firebase-config.js` from Vercel env vars

**Firestore rules:** maintained EXCLUSIVELY in this directory (`Central Hub/firestore.rules`) — single source of truth for all four shared-project apps. Deploy from here:
```bash
cd "Central Hub" && firebase deploy --only firestore:rules --project centralhub-8727b
```

For full schema + collection catalogue, see [`docs/FIRESTORE_SCHEMA.md`](../docs/FIRESTORE_SCHEMA.md) and the root `CLAUDE.md`.

---

## Auth Pattern

Every protected page (all except `login.html`) loads `auth-guard.js` as a module:
```html
<body style="display:none">
  <script src="firebase-config.js"></script>
  <script type="module" src="auth-guard.js"></script>
```

> **Order matters.** `auth-guard.js` reads `window.ENV.FIREBASE_*` at module load (top-level). If `firebase-config.js` is missing or placed after, the page hangs on `<body style="display:none">` with a `TypeError`. Past incident: `design-system.html` shipped without the tag.

Steps:
1. Hide `document.body`
2. Init Firebase (guarded against double-init)
3. `onAuthStateChanged` — no user → `login` (clean URL)
4. **Domain check** — non-`@eduversal.org` Google SSO → `login?error=domain` (email/password bypasses)
5. Fetch / create `users/{uid}`. Auto-assigns `central_user`.
6. **Role check** — `role_centralhub ∈ ['central_user','central_admin']`
7. Mount profile modal (display name / phone / title / photo edit)
8. Expose globals · dispatch `authReady`

**Globals:** `window.firebaseApp`, `window.auth`, `window.db`, `window.storage`, `window.currentUser`, `window.userProfile`.

**Profile modal** (mounted by auth-guard) edits ONLY `displayName`, `phone`, `title`, `photoURL`. Email + role + sub-role + subjects are **read-only**. Role mutations only via `/console`.

---

## Role System

Each platform has its own role field — there is no shared `role` field (legacy fully removed).

| Platform | Field | Values |
|---|---|---|
| Central Hub | `role_centralhub` | `'central_user'` \| `'central_admin'` |
| Academic Hub | `role_academichub` | `'academic_user'` \| `'academic_admin'` |
| Teachers Hub | `role_teachershub` | `'teachers_user'` \| `'teachers_admin'` |
| Research Hub | `role_researchhub` | `'research_user'` \| `'research_admin'` |

**Sub-roles** (managed via `/console`, optional, composable):

| Platform | Field | Values |
|---|---|---|
| Central Hub | `ch_sub_roles[]` | `director`, `coordinator` |
| Academic Hub | `ah_sub_roles[]` | `foundation_representative`, `school_principal`, `academic_coordinator`, `cambridge_coordinator` |
| Teachers Hub | `th_sub_roles[]` | `subject_teacher`, `subject_leader`, `interviewer`, `hiring_manager` |

**Subject specialty (CH only):** `ch_subjects[] ⊂ {math, biology, chemistry, physics, english, bahasa, religion}`. Drives subject-scoped filtering on pacing dashboards. Sub-role hierarchy:
- `central_admin` → bypass (full management).
- `director` → bypass (network-wide, sits above specialists).
- `coordinator` → IS a subject specialist; always filtered by `ch_subjects[]`. Empty = no subject access (misconfig — promote to director or assign subjects).
- plain `central_user` → filtered; empty = no access.

**Approval status (AH + TH only):** `approval_status_academichub` / `approval_status_teachershub` ∈ `'pending'` / `'approved'` / `'rejected'`. `/console` shows a banner + stat card for pending users.

**isAdmin pattern:**
```js
const isAdmin = profile?.role_centralhub === 'central_admin';
```

---

## Page-Access Gating

`auth-guard.js` enforces three layers (CH-specific selectors):

1. **Per-navigation gate (Step 5b)** — direct URL access redirects to `/?denied=<slug>` if not allowed.
2. **UI gating (`applyPageAccessGating`):**
   - desktop navbar: `[data-nav-key]` AND `[data-nav-page]`
   - empty `.ch-dd-wrap` / `.ch-dd-submenu-wrap` (any wrap whose children are all `data-pa-hidden` OR `data-ch-hidden`)
   - empty `.ch-dd-col` columns inside multi-column dropdowns
3. **Subject specialty gate** — pacing pages with `data-pacing-subject` filtered against `ch_subjects[]`. Uses `data-ch-hidden` (separate from `data-pa-hidden` so the two systems compose without interference).

**Bypass list** (`PAGE_ACCESS_BYPASS`): `''`, `'index'`, `'login'`.

**Cache key:** `pac:__all__:centralhub` (5 min TTL).

**Critical-page guard (at `/page-access` save time):** restricting `visible_to[]` on admin tooling pages opens a confirm modal — `central_admin` bypasses but `director` / `coordinator` get locked out without explicit acknowledgement. CRITICAL_PAGES: `page-access`, `console`, `rules-viewer`, `design-system`, `kpi-admin`, `competency-admin`, `orientation-admin`, `checklist-admin`, `schedule-settings`, `mail-composer`, `feedback-management`, `induction-admin`, `careers-admin`, `careers-compare`.

---

## Navigation

`index.html` has **no sidebar** — the shared navbar (`partials/navbar.html`) is the sole navigation surface. Removed 2026-05-05 because navbar dropdowns (Network / Communications / Curriculum / Operations / Admin / My Specialist CPD) already cover every page; the sidebar duplicated them.

The legacy `sidebar_config/order` doc + the `dsb-*` CSS / `SIDEBAR_*` JS / `dash-sidebar` markup are gone. Page-access gating still happens through navbar `[data-nav-key]` / `[data-nav-page]` attributes; auth-guard's `.dsb-section-wrap` / `.dsb-section-label` handling was removed at the same time.

---

## Firestore Collections (CH-touching)

CH is the **rules host + cross-platform admin tool**. It touches almost every collection in the system. Full catalogue in [`docs/FIRESTORE_SCHEMA.md`](../docs/FIRESTORE_SCHEMA.md). Below is the CH-specific perspective.

| Collection | Purpose | CH role |
|---|---|---|
| `users/{uid}` | Profile + 4 platform role fields + sub-role arrays + approval flags + `ch_subjects[]` | central_admin manages all from `/console` |
| `partner_schools/{schoolId}` | School directory + `domain` + `enabled_systems[]` + `classes/{classId}` subcoll | central_admin manages from `/schools` |
| `staff` · `announcements` · `central_documents` · `topics` · `surveys` · `central_certificates` · `activity_projects` · `activity_tasks` | Standard CH content collections | central_admin |
| `feedbacks/{feedbackId}` | Single canonical feedback collection. Every hub writes here with `__src` discriminator. CH `feedback-management.html` reads + reviews. | central_admin (read/update/delete) |
| `calendar_events/{docId}` · `calendar_settings/current` | Academic calendar + year config. **Single source of truth** for date/term data — never store `termStart` or `totalWeeks` anywhere else. | central_admin |
| `school_events/{eventId}` | Partner Schools Event Calendar — any CH user can write |
| `math_pacing/year9-10` · `biology_pacing/year9-10` · `chemistry_pacing/year9-10` · `physics_pacing/year9-10` | IGCSE pacing structure. Read by Teachers Hub. | central_admin |
| `cambridge_syllabus/{subjectCode}_{syllabusCode}` | Syllabus reference (e.g. `0580_C1.1`, `0862_7Ni.02`, `0893_8Bp.04`). Autocomplete in pacing pages searches `entry.code`, NOT the doc ID. | central_admin |
| `cambridge_scheme_of_work/{subjectCode}_{code}` | Scheme-of-work content. **0862 entries also include `stage`, `unit`, `commonMisconceptions[]`, `keyVocabulary[]`** (Checkpoint Teaching Guide). **9709 entries also include `paper`, misconceptions, vocabulary** (AS/A-Level). Seeded so far: IGCSE Math 0580 (125) + Lower Secondary Math 0862 (179) + AS Math 9709 (38) = 342 total. | central_admin |
| `cambridge_syllabus_progression/{subjectCode}` | Stage 7→8→9 progression mapping. Drives the Progression Grid tab on checkpoint pacing pages. | central_admin |
| `km_curriculum/{docId}` · `curriculum_master_topics/{docId}` | Indonesian Kurikulum Merdeka chapters + Cambridge ↔ KM master topic taxonomy. Powers the National Alignment page. Seeded by `seed-curriculum-alignment.js`. | central_admin |
| `userProgress/{uid}` | Per-teacher pacing progress written by TH. Not read by CH (yet). | TH-owned |
| `competency_framework/{trackId}` (+ `levels/` subcoll) | 3-track Cambridge competency taxonomy. CH writes via seed scripts; reads in `competency-admin.html` (review context) and the 4 `specialist-*.html` pages. | central_admin |
| `cambridge_crossref/index` | Single CTS aggregator. Built by `scripts/competency/build-crossref-index.js`. | central_admin |
| `content_overrides_{teachers,academic}/{compId}_{lvl}` | Admin reading override (HTML allowlist sanitiser on save AND render) | TH/AH admin |
| `user_competencies/{uid}` | Three parallel `earned*` fields (TH `earned`, AH `earned_academic`, CH `earned_central`). `competency-admin.html` derives field name by `platform` on approve. | per platform owner; central_admin on approve |
| `competency_evidence/{docId}` | Submissions from all 3 hubs (`platform ∈ {teachers, academic, central}`). Reviewed via `competency-admin.html`. Storage: `competency_evidence/{platform}/{uid}/{ts}_{filename}` (≤25 MB; storage rule accepts all 3). | owner create; central_admin update |
| `competency_certificates/{certId}` | Issued from "Issue Certificates" tab of `competency-admin.html`. Now supports `central` platform too. Also receives Induction Completion Cert (Charter NN5). | central_admin |
| `induction_programs/{programId}` | 3 handbook templates seeded from `docs/induction/handbook-*.json`. **Source of truth is JSON; Firestore docs are reverted on next seed.** | central_admin via seed |
| `induction_assignments/{menteeUid}` | One active induction per user. NN3+NN4 enforced (mentor must hold cert; three party uids required). | central_admin |
| `induction_progress` · `induction_observations` · `induction_journal` · `induction_pulses` · `mentor_certifications` · `induction_journal_aggregates` | Induction module collections. NN1+NN2 enforced in rules. See root CLAUDE.md "Induction Module" section for full architecture. | various |
| `page_access_config/{slug}` | Per-page sub-role visibility (all 3 hubs). Edited via `/page-access`. Seeded by `scripts/page-access/seed-{ah,th,ch}-page-access.js`. | central_admin |
| `nav_config/{docId}` | Admin-editable navbar config. **PK is mixed:** `nav_config/v1` for CH (legacy, supports columns + nested submenu groups, in-place editor in `partials/navbar.html`); `nav_config/academichub` and `nav_config/teachershub` for AH/TH (flat shape `{platform, items:[{key,label,hidden}], updatedAt}`, edited via shared `shared-design/nav-edit-simple.js`). | each hub's admin |
| `school_appraisals_archive_v1/{docId}` | **Tombstone (retired 2026-05-03).** No client code reads/writes; central_admin only for forensics. Active appraisal collection is `school_appraisals_v2`. | central_admin only |
| `teacher_kpi_submissions/{uid}_{periodId}` | TH self-assessment (CH is rules host). Requires `schoolId` on write; composite index `(periodId, schoolId)` registered. | TH owner |
| `job_positions` · `interview_question_sets` · `job_applications` · `interview_scorecards` · `job_application_audit` · `mail` | **Careers Module** (TH-owned). CH only matters as rules host. Helpers `hasTHSubRole`, `isInterviewer`, `isHiringManager`, `hasHiringPower`, `isHiringMgrSameSchool` live in `firestore.rules` "CAREERS + INTERVIEW MODULE" block. | TH-owned |

**Timestamp:** `createdAt` (serverTimestamp). NEVER `timestamp`.

**Collection rename:** CH's documents collection is `central_documents`, NOT `documents`. Renamed during multi-project consolidation to avoid Firestore rule conflicts.

---

## Build & Deployment

`node build.js` → `dist/`. What it does:
1. Generates `dist/firebase-config.js` from Vercel env vars
2. Injects `partials/navbar.html` into every HTML (replacing `<!-- SHARED_NAVBAR -->`)
3. Injects `<link rel="stylesheet" href="shared-styles.css">` before the first `<style>` tag (or `</head>`)
4. Injects `<!-- SYLLABUS_MODALS -->` + `<!-- SYLLABUS_TEACH_SCHED_BTN -->` placeholders if present
5. Injects `<script src="cambridge-crossref.js" defer>` before `</body>` on every page except login + index
6. Copies HTML, `auth-guard.js`, `calendar-fallback.js`, `shared-styles.css`, `cambridge-crossref.js`, `resources/` into `dist/`

**Vercel env vars:** `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID`.

---

## Pages

**Auth + landing:**
- `index.html` (`/`) — dashboard with sidebar (DAILY / NETWORK / OPERATIONS / INSIGHTS / ADMIN) + stats row + hero + upcoming events + announcements
- `login.html` — login (no auth-guard)

**Network:** `schools` (writes `partner_schools`, UI label kept as "Schools"), `staff`, `event-calendar`, `academic-calendar` (admin **⚙ Year Settings** writes `calendar_settings/current` — single source of truth for all date/term data), `network-health`

**Communications:** `announcements`, `messageboard`, `documents` (`central_documents`), `library`, `mail-composer`, `notifications`

**Curriculum:** `igcse-syllabus`, `as-alevel-syllabus`, `primary-checkpoint-syllabus`, `secondary-checkpoint-syllabus`, `curriculum-map`, `national-alignment` (Cambridge ↔ KM), `igcse-{math,biology,chemistry,physics}-pacing` (IGCSE), `checkpoint-{math,english,science}-pacing` (Lower Secondary, also has Progression Grid tab), `as-alevel-{math,biology,chemistry,physics}-pacing`, `teaching-progress` (real-time across all 11 subjects)

**Operations:** `appraisals`, `school-appraisals`, `teacher-appraisals`, `ease-system`, `assessment-management`, `assessments`, `activities` (kanban), `school-visits`, `kpi-admin`, `reports`

**Survey + Certificates:** `surveys`, `survey-console`, `certificates`, `certificate-verify` (no auth guard)

**Admin tooling:** `console`, `page-access`, `competency-admin`, `induction-admin`, `orientation-admin`, `checklist-admin`, `schedule-settings`, `feedback-management`, `rules-viewer`, `design-system`

**Specialist CPD (4-page set for HQ Subject Specialists):** `specialist-framework`, `specialist-path`, `specialist-portfolio`, `specialist-certificates`

**Induction (HQ-side):** `induction-admin`, `my-induction`, `handbook`

**Activities + Cambridge:** `cambridge-calendar`, `cambridge-standards`

---

## CSS Architecture

All pages share **`shared-styles.css`** (build-injected before the first `<style>` tag).

**Provided in shared-styles.css (do NOT duplicate in page `<style>`):**
- `:root` tokens: `--ink`, `--paper`, `--accent`, `--accent-dk`, `--accent-2`, `--border`, `--shadow-{sm,,lg}`, `--radius`, `--white`
- Reset + `body {}` base
- `.page-layout`, `.sidebar` (and sub-components — page-internal filter/selector rails)
- `.filter-bar`, `.filter-chip`, `.search-input-wrap`, `.search-input`, `.search-icon`, `.btn-reset`
- `.badge` + variants (active/inactive/pending/warning/success/info/neutral/violet/danger/draft/read/unread/pinned/featured/role-*)
- `.skel` + `@keyframes shimmer`
- `.modal-overlay`, `.modal`, `@keyframes modalIn`, `.modal-{head,close,body,footer,error}`
- `.form-{group,label,input,select,textarea,hint,error}`
- `.btn-{primary,save,add,cancel,delete,icon}`
- `.toolbar`, `.avatar(-sm/-lg)`, `.pagination`, `.page-btn`, `.empty-state`
- Profile modal CSS (`.profile-modal-*`)

**Page-specific `<style>` blocks should contain ONLY:**
- `:root` accent overrides (e.g. `--accent: #7c3aed` for assessments, `#d97706` for appraisals)
- Component styles unique to that page
- Override rules differing from shared defaults
- `display: none` overrides for admin-only elements

---

## Cambridge Competency Framework — CH dual role

CH owns two roles in the 3-track system:
1. **Reviewer** for all 3 tracks via `competency-admin.html` (track filter chips, heatmap, cohort, issue tabs all support `teachers` / `academic` / `central`)
2. **Author of CH Specialist track** via the 4 `specialist-*.html` pages

**CH-specific:**
- The Specialist track is **hybrid by design** — coaching-observer (cof / tpd) + subject-deepening (csm / cqa) + network strategy (nls / xen). 9/27 CTS covered (intentional — Specialists work *with* teachers, not *as* teachers).
- Per-(comp, level) content **auto-generated** by `scripts/competency/generate-and-seed-specialists-content.js` from framework metadata + Cambridge verbatim text. Each doc carries `generated: true` so a future hand-rewrite pass can identify what to overwrite.
- `kpi-admin.html` "Add Teacher KPI" modal has a "Cambridge Teacher Standards Tags" input. Refs validated against `competency_framework/teachers.cambridgeStandards` on save.
- `schools.html` "Edit School" modal has "Enabled Pilots" checkboxes writing to `partner_schools.enabled_systems[]`. **Caveat:** 2 unfixed callsites still write to legacy `'schools'` collection (notes-update line ~542 + delete line ~981) — needs follow-up.
- Storage rule for `competency_evidence/{platform}/{uid}/{filename}` accepts all 3 platforms (≤25 MB).
- `cambridge-crossref.js` build-injected on every dist HTML except login/index. Auto-wires CTS chips into click-to-expand popovers.
- Specialist CPD navbar entries in Admin dropdown's "My Specialist CPD" column. `groupKeys` map includes the 4 `specialist-*` slugs so trigger highlights when on those pages.

---

## Careers + Interview Module — CH entry points

The Careers Module lives in **Teachers Hub**. CH only hosts the rules + a few UI entry points.

**Navbar:**
- Admin dropdown → "Users & Access" column → `Hiring Funnel ↗` external link to `https://teachershub.eduversal.org/careers-admin` (`target="_blank"`). Admin dropdown is `data-admin-only="1"`, so visible only to `central_admin`.
- Mobile drawer's Admin section has the same link.

**`/console`:**
- TH sub-roles checkbox panel: 4 entries (`subject_teacher`, `subject_leader`, `interviewer`, `hiring_manager`). Last two unlock the Careers dropdown in TH.
- `roleFilter` `<select>` has 2 dedicated options: "TH sub-role: interviewer" / "TH sub-role: hiring_manager" — useful for HQ to audit hiring-power users per school.

**HQ → TH cross-platform caveat:** TH `auth-guard.js` admin bypass is `teachers_admin` only, NOT `central_admin`. CH admins clicking the Hiring Funnel link need either `teachers_admin` OR `hiring_manager` on their TH profile. **Operational fix:** assign HQ users `teachers_admin` from `/console` — same caveat applies to all cross-platform admin actions.

**No CH-side `careers-*` page exists.** Navbar link is purely a launcher.

---

## Key Files

| File | Purpose |
|---|---|
| `auth-guard.js` | Auth + role gate, profile modal mount, page-access UI gating |
| `build.js` | Vercel build — navbar injection, shared-styles injection, cambridge-crossref injection, asset copy |
| `shared-styles.css` | Central design system — tokens, reset, components, sidebar, profile modal CSS |
| `partials/navbar.html` | Shared navbar HTML+CSS+JS injected via `<!-- SHARED_NAVBAR -->`. Bespoke in-place navbar editor (admin only) supporting columns + nested submenu groups + Add-Group button. Toggled via `#btnNavEdit`; writes to `nav_config/v1`. |
| `calendar-fallback.js` | Static `window.CAL_DEMO_EVENTS` — update each academic year |
| `cambridge-crossref.js` | Singleton runtime auto-wiring CTS chips into click-to-expand popovers. Build-injected. |
| `firebase.json` | Firestore rules config (no hosting section used) |
| `firebase-config.js` / `.example.js` | Local dev config (gitignored) / template |
| `firestore.rules` | **THE authoritative copy** — deploy from here |
| `vercel.json` | Vercel config |
| `resources/` | Static assets |

---

## Important Conventions

- **No React, no npm bundler.** All JS via CDN ESM imports.
- **Modular SDK v10 only.** Never compat (`firebase.firestore()`).
- **`createdAt` not `timestamp`.**
- **Never commit `firebase-config.js`** — gitignored.
- **`central_documents` not `documents`** — collection rename.
- **Auth guard goes first** + `firebase-config.js` BEFORE auth-guard. Past incident: `design-system.html` shipped without firebase-config.
- **Use `authReady`** — never call `window.db` before the event fires.
- **Login redirects use clean URLs:** `login`, NOT `login.html`.
- **Role field is `role_centralhub`.** Never check the legacy `role` field.
- **Shared navbar via `<!-- SHARED_NAVBAR -->` placeholder.** Don't put nav HTML in individual pages.
- **Calendar fallback** is `window.CAL_DEMO_EVENTS` from `calendar-fallback.js`. NEVER inline.
- **N+1 Firestore queries are forbidden.** Use `where('parentId','in',ids)` (up to 30 values) and group in JS.
- **Event notification modal** only for events ≤7 days away. Don't change without user approval.
- **All UI text in English.** No Turkish (past bug: `İlişkili Duyuru`).
- **Dates use `en-GB` locale** (`toLocaleDateString('en-GB', ...)`). Never `id-ID`.
- **`weekly_progress` writes always include `schoolId`** — `schoolId: window.userProfile?.schoolId || null`. CH HQ → null; AH/TH → `partner_schools` doc id.
- **`feedback` collection is gone.** Write to `feedbacks` with `__src` field.
- **`staff.html` writes both `schoolId` (FK) and `school` (denormalised name).** `<select>` value = `partner_schools.id`. Don't revert to free-text.
- **`/page-access` critical-page guard** opens confirm modal at save time before narrowing visibility on admin tooling pages. central_admin bypasses; other power users (director / coordinator) get explicit acknowledgement.
- **In-place navbar editor lives in `partials/navbar.html`** (CH only — bespoke). Writes to `nav_config/v1`. Don't fork into AH/TH — their navbars are flat and use `shared-design/nav-edit-simple.js` writing to `nav_config/{platform}`.
- **Profile modal edits ONLY personal fields** — displayName / phone / title / photoURL. Email + role + sub-role + subjects ASLA editable from here. Role mutations only via `/console`.
- **No sidebar on `index.html`.** Navbar dropdowns are the sole navigation surface (removed 2026-05-05). The `academics` data-nav-key still exists in navbar config + `page_access_config/academics`, but its href routes to `curriculum-map` because there is no `/academics` page; do not create one.

---

## Common Mistakes — Do Not Repeat

### 1. Missing Firebase imports
Before writing any code that calls a Firestore/Storage function, verify **every** function is in the import list. Past bugs: `addDoc` not imported (reply silently broken), `limit` not imported (dropdown failed silently), `deleteDoc` not imported (delete broken). After writing code, scan every function call against the import list.

### 2. Undefined CSS variables
Every `var(--name)` used in CSS must be defined in `:root`. Past bug: `--accent-2` used in `.cat-btn.active` but missing from `:root` — elements rendered with no background.

### 3. Never use `alert()` or `confirm()`
Browser blocking dialogs are banned. Use inline error messages (`.visible` class) or double-click confirmation (`data-confirming` attribute, 3s timeout).

### 4. Admin-only UI must check `isAdmin`
Edit/Delete/destructive buttons gated behind `isAdmin`. Never rely on Firestore rules alone. Past bug: Edit Topic shown to all users.

### 5. Validate user-supplied URLs
URLs from Firestore or user input used in `href`/`src` must be validated. Block `javascript:`:
```js
function safeUrl(url) { return /^https?:\/\//i.test(url) ? url : '#'; }
```

### 6. Refresh only the mutated document
After single-doc mutation, don't call `loadTopics()` (full refetch). Use targeted `getDoc` + update in-memory array.

### 7. Large collections need pagination
Never `getDocs(collection(...))` unbounded. Always `limit(N)` + "Load more" UI. Past bug: `loadTopics()` had no limit.

### 8. Cancel button context
Forms used for both Create + Edit modes: Cancel must return to the appropriate view. Editing → thread/detail; Creating → list. Never unconditionally `showView('list')`.

### 9. `firebase-config.js` BEFORE `auth-guard.js`
`auth-guard.js` reads `window.ENV.FIREBASE_*` at module-load time (top-level). If missing or after, page hangs on `<body style="display:none">`. Past bug: `design-system.html`. Order:
```html
<body style="display:none">
  <script src="firebase-config.js"></script>
  <script type="module" src="auth-guard.js"></script>
```

### 10. Virtual nav slots need a real `href`
The `academics` data-nav-key is virtual (no `academics.html`). Its navbar entry routes `href="curriculum-map"`. New virtual slots must do the same — `data-nav-key=<id>` stays as the canonical key for `page_access_config` matching, but `href` routes to a real page.

### 11. Reserved Firestore doc IDs
`__name__`-style (double-underscore start AND end) is reserved by Firestore — `setDoc` rejects with "Resource id is invalid because it is reserved". Use single-underscore-each-side patterns instead.
