# CentralHub — Architecture Reference

## What This App Is

Central Hub is the **Eduversal HQ operations portal** — the nerve centre for the entire partner school network. Its users are Eduversal headquarters staff:

- **Directors** — Primary Schools Director and Secondary Schools Director
- **Subject Specialists** — Math, English, Bahasa, Physics, Chemistry, Biology, Religion
- **Coordinators** — cross-functional HQ coordinators

Key responsibilities managed here: partner school profiles and performance, staff database, platform-wide announcements, document repository, activity/project tracking, EASE assessment coordination, appraisal visit management, academic calendar, weekly checklists for HQ roles, competency evidence review (for all platforms), and full user/role management via the Console.

Access is restricted to `@eduversal.org` email addresses. `central_user` can read and participate; `central_admin` has full management access. It is a **vanilla HTML/CSS/JS application** (no React, no bundler framework). Pages are plain `.html` files with inline scripts that load Firebase via CDN.

**Deployment:** Vercel (build output in `dist/`).

---

## Monorepo Structure

```
Eduversal Web/                    ← monorepo root (no remote, not deployed)
├── Academic Hub/                 ← embedded subrepo — analytics dashboards (Vercel)
├── Central Hub/                  ← embedded subrepo — THIS app (Vercel)
│   ├── firestore.rules           ← ⚠️ ONLY Firestore rules file — deploy from here
│   └── firebase.json             ← firebase deploy config
├── Teachers Hub/                 ← embedded subrepo — teacher tools (Vercel)
├── Research Hub/                 ← real submodule — research management (Vercel)
├── IGCSE Tools/                  ← real submodule — uses its OWN Firebase project `igcse-tools`
├── School Hub/                   ← untracked scratch folder (no .git)
└── keys/                         ← service account JSON keys (gitignored)
```

Each app has its **own GitHub repository** and its **own Vercel deployment**. Academic / Central / Teachers / Research Hub share the single Firebase backend `centralhub-8727b`; IGCSE Tools is on its own project. Academic / Central / Teachers Hub are embedded subrepos (gitlinks without a `.gitmodules` entry); Research Hub and IGCSE Tools are properly registered submodules. See the root `CLAUDE.md` for the full explanation and git workflow.

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

**Subject specialty (Central Hub only):** `ch_subjects[]` is an array of `'math' | 'biology' | 'chemistry' | 'physics' | 'english' | 'bahasa' | 'religion'`. Set in `console.html` for HQ Subject Specialists; drives subject-scoped filtering on pacing dashboards (Step 10/11 hardening). Empty array = "all subjects" (Directors / cross-subject coordinators).

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
| `partner_schools/{schoolId}`        | School directory (15 partner schools + `eduversal_hq`). Each doc carries `name`, `domain` (e.g. `fatih.sch.id`, drives AH/TH email-based auto-default), and a `classes/{classId}` subcollection (`name`, `grade`, `section`). | AH admin / central_admin (write); any authorised user (read) |
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
| `cambridge_syllabus/{docId}`            | Syllabus reference items. **Doc ID format: `{subjectCode}_{syllabusCode}` e.g. `0580_C1.1`, `0862_7Ni.02`, `0893_8Bp.04`**. Fields: `code` (display code e.g. `C1.1`), `title`, `tier` (`Core`/`Extended`), `topicArea`, `description`, `content`, `notes`, `paper` (Stage 7/8/9 for checkpoint), `subjectCode`. Autocomplete in pacing pages must search `entry.code` field, NOT the doc ID. | central_admin |
| `cambridge_scheme_of_work/{docId}`      | Cambridge scheme-of-work content per ref code: teaching activities, learning objectives, external resources, SDG links. **Doc ID format: `{subjectCode}_{code}` e.g. `0580_C1.1`, `0862_7Ni.01`, `9709_1.1`** — same convention as `cambridge_syllabus`. Fields: `subjectCode`, `code`, `tier` (`'core'`/`'extended'`/`'all'` for IGCSE/Lower Secondary; `'AS'`/`'A2'` for 9709), `title`, `topicArea`, `learningObjectives[]`, `teachingActivities[{body, tags[]}]` (tags: `I`/`E`/`F`/`TWM.NN`/SDG-N), `resources[{title, url, type}]` (type: `'external'`/`'resource_plus'`/`'past_paper'`), `sdgLinks[{goals[], suggestion}]`, `syllabusVersion`, `schemeOfWorkVersion`, `examFromYear`, `examToYear`. **0862 (Lower Secondary) entries also include `stage` (7\|8\|9), `unit`, `commonMisconceptions[]`, `keyVocabulary[]`** — surfaced by the Checkpoint Teaching Guide. **9709 (AS & A Level Mathematics) entries also include `paper` (`'P1'`/`'P2'`/`'P3'`/`'M1'`/`'S1'`/`'S2'`), `commonMisconceptions[]`, `keyVocabulary[]`** — surfaced by the AS/A-Level Teaching Guide. Seeded by `seed-scheme-of-work-{code}.js` from `cambridge-scheme-of-work-{code}.json` (or `…-{code}-stage{N}.json` for Lower Secondary). **Seeded so far: IGCSE Math 0580 (125 entries) + Lower Secondary Math 0862 Stages 7-8-9 (179 entries) + AS & A Level Mathematics 9709 (38 entries) = 342 total.** Biology/chemistry/physics (IGCSE & AS) + Checkpoint English (0861) + Checkpoint Science (0893) not yet seeded. | central_admin |
| `cambridge_syllabus_progression/{subjectCode}` | Curated Stage 7→8→9 progression mapping per subject (one doc per `subjectCode`, e.g. `0862`, `0893`). Fields: `subjectCode`, `rows: [{component, topicArea, stage7, stage8, stage9}]` where stage values are codes or null. Used by the Progression Grid tab on checkpoint pacing pages — falls back to a title-similarity heuristic if absent. Seeded by `seed-progression-{code}.js`. | central_admin |
| `km_curriculum/{docId}`             | Indonesian Kurikulum Merdeka textbook chapters (one doc per textbook bab/chapter). Doc ID format: `km-{subject}-kelas-{grade}-bab-{n}` or `…-bab-{n}-tl` for Matematika Tingkat Lanjut. Fields: `subject`, `fase` (`'D'`\|`'E'`\|`'F'`\|`'F+'`), `grade` (7..12), `track` (`'mainstream'`\|`'tingkat_lanjut'`), `textbook`, `bab_number`, `bab_title`, `bab_title_en`, `sections[]`, `concept_tags[]`, `source`, `createdAt`. Read open to all hubs; seeded by `seed-curriculum-alignment.js` from `curriculum-research/km-curriculum-seed.json` (gitignored). | central_admin |
| `curriculum_master_topics/{docId}`  | Master conceptual topic taxonomy linking Cambridge G7-12 (Checkpoint+IGCSE+AS/A-Level) with KM Fase D/E/F/F+. Doc ID format: `topic-{subject}-{TOPIC_ID}`. Fields: `subject`, `topic_id`, `topic_name`, `concept_family`, `cambridge_coverage[{level,subjectCode,codes[],depth,notes?}]`, `km_coverage[{fase,grade,track,km_curriculum_doc_id,depth,notes?}]`, `comparison{cambridge_first_grade,km_first_grade,status,notes}`, `createdAt`. `comparison.status` enum: `'covered'`\|`'partial'`\|`'km_only'`\|`'cambridge_only'`\|`'depth_mismatch'`. Read open; powers the National Alignment page. Seeded by `seed-curriculum-alignment.js` from `curriculum-research/master-topics-math-seed.json` (gitignored). | central_admin |
| `userProgress/{uid}`                | Per-teacher pacing progress written by Teachers Hub. Not read by Central Hub yet. | owner (teacher) |
| `school_events/{eventId}`           | Partner Schools Event Calendar events. Fields: `schoolId`, `schoolName`, `title`, `category`, `date_start` (YYYY-MM-DD), `date_end`, `description`, `createdBy`, `createdAt`. | any central hub user |
| `user_competencies/{uid}`           | Competency progress for Teachers Hub (`earned`, `matDone`) and Academic Hub (`earned_academic`, `matDone_academic`). Written by each platform, read by `competency-admin.html` for context. | owner (per platform) |
| `competency_evidence/{docId}`       | Evidence submissions from Teachers Hub and Academic Hub for competency certification. Fields: `uid`, `platform` (`'teachers'`\|`'academic'`), `compId`, `compName`, `domain`, `level`, `description`, `fileUrl`, `fileName`, `status` (`'pending'`\|`'approved'`\|`'rejected'`), `reviewerNote`, `createdAt`, `updatedAt`. Reviewed via `competency-admin.html`. | owner (create), central_admin (update status/reviewerNote) |
| `page_access_config/{pageKey}`      | Per-page sub-role visibility for Academic Hub (and eventually TH/CH). Doc ID = clean URL slug. Fields: `pageKey`, `platform` (`'academichub'`), `label`, `visible_to[]` (sub-role values; empty = open to all), `description`, `updatedAt`. Read open to any signed-in user; managed via `/page-access` admin tool. Seeded by `scripts/page-access/seed-ah-page-access.js`. | central_admin |
| `teacher_kpi_submissions/{uid}_{periodId}` | Teacher KPI self-assessments. Now require a `schoolId` field on write so AH evaluators can be school-scoped at both query and rule level (Step 1.3 hardening). Composite index `(periodId, schoolId)` registered. | owner teacher (create/update) |

**Timestamp field:** always `createdAt` (serverTimestamp). Do not use `timestamp` — that was the legacy name.

**IMPORTANT — collection rename:** CentralHub's documents collection is `central_documents`, NOT `documents`. The rename happened during the multi-project consolidation to avoid Firestore rule conflicts with the legacy `documents` collection.

**Firestore rules** live **exclusively** in `Central Hub/firestore.rules` — this is the single source of truth for all four apps that share the `centralhub-8727b` project (Academic / Central / Teachers / Research Hub).

⚠️ **Always deploy rules from the `Central Hub/` directory:**
```bash
cd "Eduversal Web/Central Hub"
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
| `schools.html`                     | `/schools`                      | School management — reads/writes the `partner_schools` collection (UI label kept as "Schools" for clarity). |
| `staff.html`                       | `/staff`                        | Staff management                                  |
| `documents.html`                   | `/documents`                    | Document management (`central_documents` collection) |
| `academics.html`                   | `/academics`                    | Academics module hub                              |
| `academic-calendar.html`           | `/academic-calendar`            | Academic calendar (Sheets + Firestore events). Admin: **⚙ Year Settings** modal writes `calendar_settings/current` (academicYearStart, totalTeachingWeeks, terms). This is the single source of truth for all date/term data across the platform. |
| `igcse-syllabus.html`              | `/igcse-syllabus`               | IGCSE syllabus guide — view/edit syllabus entries, GLH, chapter hours. Redirects to Teacher Progress (math only). |
| `igcse-math-pacing.html`           | `/igcse-math-pacing`            | IGCSE Math pacing admin — chapter/topic structure, inline edit (codes autocomplete from `cambridge_syllabus`, hours, week), Teacher Progress, Coverage Heatmap, Hours Report. Generated from `igcse-pacing-template.html` by `build.js`. Sister pages: `igcse-biology-pacing`, `igcse-chemistry-pacing`, `igcse-physics-pacing`. |
| `checkpoint-{math,english,science}-pacing.html` | `/checkpoint-…-pacing` | Lower Secondary Checkpoint pacing admin (Year 7–8). Generated from `secondary-checkpoint-pacing-template.html`. Same Pacing Structure / Teacher Progress / Coverage Heatmap / Hours Report tabs as IGCSE, **plus a "Progression Grid" tab** that renders the official Cambridge Stage 7→8→9 progression with live coverage pills per cell (joins pacing data with `cambridge_syllabus_progression/{subjectCode}`). Math uses subject code `0862`, science `0893`, english `1111` (legacy — Cambridge has renamed to `0861` but no migration done yet). |
| `as-alevel-{math,biology,chemistry,physics}-pacing.html` | `/as-alevel-…-pacing` | AS & A Level pacing admin (Year 11–12). Generated from `as-alevel-pacing-template.html`. |
| `as-alevel-syllabus.html`          | `/as-alevel-syllabus`           | AS/A Level syllabus guide — view/edit syllabus entries for Math, Biology, Chemistry, Physics (Year 11–12). |
| `primary-checkpoint-syllabus.html` | `/primary-checkpoint-syllabus`  | Primary Checkpoint syllabus admin — chapter/topic/objective structure (Year 4–6). Uses `initSyllabusPage` from `partials/syllabus-core.js`. |
| `secondary-checkpoint-syllabus.html` | `/secondary-checkpoint-syllabus` | Secondary Checkpoint syllabus admin — chapter/topic/objective structure (Year 7–8). Uses `initSyllabusPage` from `partials/syllabus-core.js`. |
| `console.html`                     | `/console`                      | User management — sets all 4 platform role fields, approves AH + TH users; pending banner + stat card for unapproved users |
| `page-access.html`                 | `/page-access`                  | **Page Access Manager** — central_admin tool to edit `page_access_config/{slug}` for each platform. Tabs per platform (only Academic Hub wired up); search, dirty-state tracking, batched Firestore writes; “open to all” badge when `visible_to: []`. Linked from navbar under User Console. |
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
| `event-calendar.html`              | `/event-calendar`               | Partner Schools Event Calendar — school activities by month. All Central Hub users can add/edit/delete events. Firestore: `school_events` collection. |
| `schedule-settings.html`           | `/schedule-settings`            | Weekly lesson hours admin — set `weeklyHours` for every subject across all 4 programmes (Primary, Secondary, IGCSE, AS/A Level) from a single page. central_admin only. Reads/writes `{collection}/{docId}.weeklyHours` with merge. |
| `checklist-admin.html`             | `/checklist-admin`              | Weekly checklist template admin — sets tasks and essentials for all 8 platforms (teachers, subject_leader, academic_coordinator, school_principal, foundation_representative, cambridge_coordinator, director, coordinator). central_admin only. |
| `weekly-checklist.html`            | `/weekly-checklist`             | Weekly checklist for Central Hub users — director and coordinator ch_sub_roles. Users see only their own tab(s); central_admin sees both and can add/edit/delete tasks inline. Firestore: `weekly_templates` (read), `weekly_progress` (read/write own), `weekly_essentials` (read). |
| `competency-admin.html`            | `/competency-admin`             | Competency evidence review dashboard — central_admin reviews pending `competency_evidence` submissions from both Teachers Hub and Academic Hub. Approve/reject with reviewer notes. Reads `competency_evidence` collection filtered by `status === 'pending'`. |
| `national-alignment.html`          | `/national-alignment`           | Cambridge G7-12 ↔ Indonesian Kurikulum Merdeka mathematics alignment dashboard. Three views: Topic browser (master topic list with side-by-side Cambridge + KM coverage), Coverage matrix (per-grade G7-12 grid showing where each topic is taught in each curriculum), Gap list (KM-only / Cambridge-only / depth_mismatch buckets). Read-only viewer; data is seeded from JSON via `seed-curriculum-alignment.js` from monorepo root. Reads `curriculum_master_topics`, `km_curriculum`, and `cambridge_syllabus` collections. Math is the pilot subject; Sciences will be added later under the same data model. |
| `design-system.html`               | `/design-system`                | **Live design-system showcase** — palette (brand mor + companion cyan + ink/paper/semantic), brand gradient, typography (DM Sans / Lora / DM Mono + 9-step type scale), 8px spacing scale, shape (radius scale + pill), light + dark shadow tiers, component previews (buttons, badges, role badges, chips, prog-pill, spinner, page-header, page-breadcrumb, toast, modal), per-page accent override pattern, "don't do" list. Reads no Firestore data — pure visual reference. Linked from User Console dropdown. Pairs with `docs/DESIGN_SYSTEM.md` (rationale) and `shared-design/tokens.css` (the actual tokens). |

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
- **Role field is `role_centralhub`**, NOT the legacy `role` field. Always check `profile?.role_centralhub` only — the legacy `role` field has been fully removed from Firestore data and code.
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
const isAdmin = profile?.role_centralhub === 'central_admin';
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
