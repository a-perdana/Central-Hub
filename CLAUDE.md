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

For full schema + collection catalogue, see [`docs/architecture/FIRESTORE_SCHEMA.md`](../docs/architecture/FIRESTORE_SCHEMA.md) and the root `CLAUDE.md`.

---

## Auth Pattern

Every protected page (all except `login.html`) loads `auth-guard.js` as a module. **Use plain `<body>` — never `<body style="display:none">`** (CH auth-guard toggles `visibility`, not `display` — see Common Mistakes #14):
```html
<body>
  <script src="firebase-config.js"></script>
  <script type="module" src="auth-guard.js"></script>
```

> **Listen for `authReady` on `document`, not `window`** — see Common Mistakes #13. Past silent-failure mode.

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

**Subject specialty (CH only):** `ch_subjects[] ⊂ {math, biology, chemistry, physics, science, english, bahasa, religion}`. `science` is the combined-science specialty (Lower Secondary / Primary Checkpoint). Checkpoint Science **also accepts** any of `biology` / `chemistry` / `physics` specialists — a Biology Coordinator can enter the Science syllabus + pacing pages to see how their subject builds up at lower-secondary level. The reverse is not true: a `science` specialist does NOT see IGCSE / AS-A-Level Biology, Chemistry, or Physics (those remain single-subject).

**Authorization model (since 2026-05-20):**
- `central_admin` → bypass everything (page-access, rule-level write capacity, subject-specialty gate). Full management.
- `central_user` → page-access UI is the SOLE authorization mechanism. Whoever the admin lets onto a page can read AND write whatever the page exposes. Sub-roles (`director`, `coordinator`) are pure UI labels for `/page-access` scoping; they grant NO rule-level capabilities. Plain `central_user` (no sub-role) reaches pages with `visible_to: []` (open) just like director/coordinator.
- **Subject-specialty gate** (`ch_subjects[]`) stays separate and unchanged — pacing pages remain filtered against the user's subject(s) regardless of sub-role. Admin bypasses this too.

This replaces the pre-2026-05-20 "director bypasses page-access" model. See `memory/project_ch_role_simplification_2026_05_20.md` for the full migration write-up.

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

**Page-access since 2026-05-20:** `central_admin` is the sole bypass. Every other user — director, coordinator, plain central_user — is filtered through `page_access_config.visible_to[]`. The `/page-access` UI exposes a Director column AND a Coordinator column on the CH tab; toggling either narrows visibility. Empty `visible_to[]` (default seed) is open to every signed-in central_user.

**Critical-page guard (at `/page-access` save time):** restricting `visible_to[]` on admin tooling pages opens a confirm modal — `central_admin` bypasses anyway, but every other sub-role can be locked out without explicit acknowledgement. CRITICAL_PAGES: `page-access`, `console`, `rules-viewer`, `design-system`, `kpi-admin`, `competency-admin`, `orientation-admin`, `checklist-admin`, `schedule-settings`, `mail-composer`, `feedback-management`, `induction-admin`, `careers-admin`, `careers-compare`.

---

## Navigation

`index.html` has **no sidebar** — the shared navbar (`partials/navbar.html`) is the sole navigation surface. Removed 2026-05-05 because navbar dropdowns (Network / Communications / Curriculum / Operations / Admin / My Specialist CPD) already cover every page; the sidebar duplicated them.

The legacy `sidebar_config/order` doc + the `dsb-*` CSS / `SIDEBAR_*` JS / `dash-sidebar` markup are gone. Page-access gating still happens through navbar `[data-nav-key]` / `[data-nav-page]` attributes; auth-guard's `.dsb-section-wrap` / `.dsb-section-label` handling was removed at the same time.

---

## Firestore Collections (CH-touching)

CH is the **rules host + cross-platform admin tool**. It touches almost every collection in the system. Full catalogue in [`docs/architecture/FIRESTORE_SCHEMA.md`](../docs/architecture/FIRESTORE_SCHEMA.md). Below is the CH-specific perspective.

| Collection | Purpose | CH role |
|---|---|---|
| `users/{uid}` | Profile + 4 platform role fields + sub-role arrays + approval flags + `ch_subjects[]` | central_admin manages all from `/console` |
| `partner_schools/{schoolId}` | School directory + `domain` + `enabled_systems[]` + `classes/{classId}` subcoll | central_admin manages from `/schools` |
| `staff/{staffId}` | Network-wide teacher / leadership directory + join table to `users`. Doc id `sha1(emailLower).slice(0,20)` (deterministic so seed + auth-guard auto-create stay idempotent). Bridge fields `userId →users.uid`, `linkedAt`, `invited`, `source` (`csv-seed-…` or `auth-guard-autocreate`). 463+ rows seeded 2026-05-09 from network MailSender CSV; `auth-guard.js applyStaffBridge()` auto-creates rows for users HQ never seeded. See root CLAUDE.md "Staff Directory & ↔ users Bridge". | central_admin (full); user (self-CREATE with `source:'auth-guard-autocreate'` only; self-UPDATE on `userId`/`linkedAt`/`invited` only) |
| `announcements` · `central_documents` · `topics` · `surveys` · `central_certificates` · `activity_projects` · `activity_tasks` | Standard CH content collections | central_admin |
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
| `principal_observations` · `principal_annual_appraisals` · `principal_coaching_sessions` · `principal_360_cycles` · `principal_360_responses` · `principal_360_aggregates` | **Principal Evaluation Module (Phase-2, 2026-05-09).** Annual leadership cycle. Submitted forms immutable. Coaching collection's read-rule excludes Foundation Reps (confidentiality). 360 responses persist NO respondent uid (NN5). Cloud Function `aggregatePrincipal360Responses` deployed 2026-05-09 — write-trigger maintains `principal_360_aggregates/{cycleId}` with threshold-aware cohort gating + weight redistribution. See root CLAUDE.md "Principal Evaluation Module" + `docs/architecture/FIRESTORE_SCHEMA.md §17`. | various |
| `students/{uid}` · `chapter_tests/{testId}` · `chapter_test_items/{itemId}` (top-level since 2026-05-11) · `scheduled_sessions/{sessionId}` · `chapter_test_attempts/{attemptId}` | **Assessment System Phase 1 (2026-05-10) + Question Bank refactor (2026-05-11).** Students Hub user docs + chapter test envelope (`chapter_tests.itemIds[]` → top-level `chapter_test_items`) + per-class sessions + per-student attempts. Rule helpers `studentDocExists()` / `studentDoc()` / `isActiveStudent()` and `isTeacherAtSchool(schoolId)` defined in this rules file. Items support reuse across tests, versioning, Cambridge metadata (commandWord / AO / syllabusObjective / cambridgeStandardRefs[] / markScheme / tolerance / acceptedAnswers). Schema cards in `docs/architecture/FIRESTORE_SCHEMA.md` §1 + §19. | various — see root CLAUDE.md "Students Hub & Assessment System" |
| `ease_items` · `ease_test_windows` · `ease_sessions` · `ease_responses` · `ease_growth` · `parent_share_tokens` | **EASE Growth Phase 2 (2026-05-10) + Latihan.id import (2026-05-11).** Adaptive cross-grade item bank + window-orchestrated student sessions + per-response audit trail + per-(student, subject) growth aggregate + parent share tokens. Tokens are get-by-id only; list:false even for admin (NN5). `parent_share_tokens` listed in lint `PUBLIC_COLLECTIONS` allow-list. **`ease_items` now carries imported docs** (doc id `latihan_{uuid}`, fields `source`/`sourceId`/`sourceCode`/`sourceLessonCode`/`sourceP`/`cognitiveTag`/`stemHtml`/`optionsHtml[]`/`hasDeadImage`) seeded by `scripts/ease/import-latihan-bank.js`. Cloud Function `easeBankProxy` (asia-southeast1) acts as a server-side proxy for the live CH `/ease-bank-browser` viewer — bearer token in Secret Manager `LATIHAN_API_TOKEN`. | central_admin / coordinator (authoring) · active student (own session) · public-by-token (parent share) |
| `practice_questions` · `practice_questions_audit` | **Practice Bank (2026-05-12).** Curriculum-adjacent supplemental items kept separate from `chapter_test_items` (formal chapter tests) and `ease_items` (EASE growth). Today populated entirely by the IGCSE Tools ExamView math slice (805 items: 570 MCQ + 235 short_answer from Pearson Pre-Algebra / Algebra / Geometry / Pre-Calc). Doc id `igcse_{upstreamId}` (deterministic, idempotent re-import). Authoring boundary mirrors `chapter_test_items` (admin + CH coordinator write; admin-only delete). Active students can read directly — intended for SH tournaments / leaderboards / daily-challenge gamification. **NEVER wired into formal assessment flow** (no `chapter_mastery` / `ease_growth` writes). See root CLAUDE.md "Practice Bank" section + `docs/architecture/FIRESTORE_SCHEMA.md §21`. Migration playbook in `scripts/migration/` (2-step: storage copy → Firestore import). | central_admin / coordinator (authoring) · active student (read for gamification) |
| `practice_assessments` · `practice_ai_audit` · `ai_suggestion_cache` | **Practice Assessment Author + AI ranker (2026-05-12).** HQ-composed bundles of `practice_questions` items, intended for SH tournaments / leaderboards / daily-challenge gamification. `itemIds[]` references — no cloning. Same boundary as `practice_questions`: **NEVER feeds `chapter_mastery` or `ease_growth`**. Composer page: `/practice-assessment-author`. AI ranker: `practiceBankAiSuggest` Cloud Function (asia-southeast1, Anthropic Claude via Secret Manager `ANTHROPIC_API_KEY`, default model `claude-sonnet-4-6`). Audit log appended for every call (cache hit OR miss); cache key embeds a candidate-pool fingerprint so imports/archives auto-invalidate downstream stale suggestions. See root CLAUDE.md "Practice Assessment Author" + `docs/architecture/FIRESTORE_SCHEMA.md §22`. | central_admin / coordinator / director (compose + run AI) · active student (read when status==published, via SH gamification) · Cloud Function (cache + audit writes) |
| `practice_question_flags` | **HQ Observer Flag System (2026-05-13).** Mid-runner bug-report channel. Generic across all 3 question banks — `collection ∈ {practice_questions, chapter_test_items, ease_items}` discriminates. Observer students (`students/{uid}.is_hq_observer == true`) create rows from SH runners; CH reviewers (`central_admin` OR `ch_sub_roles ∈ {director, coordinator}`) triage from CH `/practice-bank-flags`. See root CLAUDE.md "HQ Observer Flag System" + `docs/architecture/FIRESTORE_SCHEMA.md`. | observer student create · CH reviewer read + update · `central_admin` delete |
| `page_access_config/{slug}` | Per-page sub-role visibility (all 3 hubs). Edited via `/page-access`. Seeded by `scripts/page-access/seed-{ah,th,ch}-page-access.js`. | central_admin |
| `nav_config/{docId}` | Admin-editable navbar config. **PK is mixed:** `nav_config/v1` for CH (legacy, supports columns + nested submenu groups, in-place editor in `partials/navbar.html`); `nav_config/academichub` and `nav_config/teachershub` for AH/TH (flat shape `{platform, items:[{key,label,hidden}], updatedAt}`, edited via shared `shared-design/nav-edit-simple.js`). | each hub's admin |
| `school_appraisals_archive_v1/{docId}` | **Tombstone (retired 2026-05-03).** No client code reads/writes; central_admin only for forensics. Active appraisal collection is `school_appraisals_v2`. | central_admin only |
| `teacher_kpi_submissions/{uid}_{periodId}` | TH self-assessment (CH is rules host). Requires `schoolId` on write; composite index `(periodId, schoolId)` registered. | TH owner |
| `job_positions` · `interview_question_sets` · `job_applications` · `interview_scorecards` · `job_application_audit` | **Careers Module** (TH-owned). CH only matters as rules host. Helpers `hasTHSubRole`, `isInterviewer`, `isHiringManager`, `hasHiringPower`, `isHiringMgrSameSchool` live in `firestore.rules` "CAREERS + INTERVIEW MODULE" block. | TH-owned |
| `mail/{auto}` | **Retired 2026-05-06.** Legacy Firebase Trigger Email queue — replaced by Resend mail-service (see "Mail Composer + Resend Mail-Service" section). Kept readable for forensics; do NOT enqueue new docs. | central_admin (forensic only) |
| `chapter_test_diagrams/{diagramId}` | Diagram binaries referenced by `chapter_test_items.diagramRefs[]`. Mirrored from IGCSE Tools by `scripts/migration/copy-igcse-diagrams-to-ch-bucket.js` + `import-igcse-diagrams-to-chapter-bank.js`. Migration audit doc lives in same migration script trio. | central_admin (migration scripts) |
| `student_points/{uid}` · `school_leaderboards/{boardId}` · `daily_challenges/{date}` · `practice_attempts/{attemptId}` · `chapter_mastery/{studentUid}_{subjectId}_{unitCode}` | **SH Gamification + mastery aggregates (2026-05-12 / 2026-05-13).** Cloud-Function-only writes for `student_points` + `school_leaderboards` (`awardChapterTestPoints` / `awardEaseSessionPoints` / `awardPracticeAttemptPoints` / `rebuildLeaderboards` / `resetLeaderboardWindows` / `rotateDailyChallenges` triggers). `practice_attempts` is student-self-write while `status:'in_progress'`, immutable post-submit. `chapter_mastery` is `onChapterAttemptWritten` Cloud Function only. **NEVER feeds formal grading** — boundary same as `practice_questions` (root CLAUDE.md #33). Read by SH `/leaderboard`, `/daily-challenge`, `/practice*`, `/index`, `/how-points-work`. Schema: `docs/architecture/FIRESTORE_SCHEMA.md` §20. | various (Cloud Function for the aggregates; student for own `practice_attempts`) |

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

**Network:** `schools` (writes `partner_schools`, UI label kept as "Schools"), `staff`, `roles-positions`, `event-calendar` (= `school-events.html`), `academic-calendar` (admin **⚙ Year Settings** writes `calendar_settings/current` — single source of truth for all date/term data), `network-health`, `pilot-enrolment`

**Communications:** `announcements`, `messageboard`, `documents` (`central_documents`), `library`, `mail-composer`, `notifications`

**Curriculum:** `igcse-syllabus`, `as-alevel-syllabus`, `primary-checkpoint-syllabus`, `secondary-checkpoint-syllabus`, `curriculum-map`, `national-alignment` (Cambridge ↔ KM), `igcse-{math,biology,chemistry,physics}-pacing` (IGCSE), `checkpoint-{math,english,science}-pacing` (Lower Secondary, also has Progression Grid tab), `as-alevel-{math,biology,chemistry,physics}-pacing`, `teaching-progress` (real-time across all 11 subjects)

**Operations:** `appraisals`, `school-appraisals`, `teacher-appraisals`, `activities` (kanban), `school-visits`, `kpi-admin`, `reports`. **Legacy / retired:** `ease-system` (4-cycle handbook, kept as historical reference — superseded 2026-05-11 by EASE Growth + chapter tests); `assessments` (retired landing-page stub, redirects to `index`). **Moved to Curriculum:** `assessment-management` → "Pacing Assessments" (lives under Curriculum > Pacing Assessments since 2026-05-11).

**Survey + Certificates:** `surveys`, `survey-console`, `certificates`, `certificate-verify` (no auth guard)

**Admin tooling:** `console`, `page-access`, `competency-admin`, `induction-admin`, `orientation-admin`, `checklist-admin`, `schedule-settings`, `feedback-management`, `rules-viewer`, `design-system`, `weekly-checklist`, `settings`, `diagrams` (per-subject diagram repository)

**Specialist CPD (4-page set for HQ Subject Specialists):** `specialist-framework`, `specialist-path`, `specialist-portfolio`, `specialist-certificates`

**Induction (HQ-side):** `induction-admin`, `my-induction`, `handbook` — `handbook` is **dual-mode** (2026-05-14): `/handbook` no-params is the browser catalogue of all 10 docs (3 induction `docs/induction/` + 7 role-operational `docs/handbooks/`) with handbookKind / hub / sub-role filter chips; `/handbook?id=<programId>` is the reader (sticky TOC + scroll-spy + 5 chip families: CTS / SKL / PIGP / CL / NN). NN chips load from [`docs/induction/INDUCTION_CHARTER.json`](../docs/induction/INDUCTION_CHARTER.json). See root CLAUDE.md "Handbook Ecosystem" for cross-link discipline.

**Activities + Cambridge:** `cambridge-calendar`, `cambridge-standards`

**References & Standards (2026-05-09, expanded 2026-05-14):** `references` — single HQ surface for every framework / audit / handbook / Cambridge standard / Indonesian regulation. 6 tabs · 52 docs (the **"Handbooks" facet** now covers all 10 handbooks: 3 induction + 7 role-operational) · search + `?doc=<id>` deep-link + localStorage MRU-5 recently-viewed. References-data lives in `dist/references-data/` (build copies from monorepo `docs/` + AH/CH `resources/`). AH and TH `/references` fetch this cross-origin (CORS-open). Deep-links handbook cards into `/handbook?id=<programId>` reader.

**Principal Evaluation Module (Phase-2, 2026-05-09):**
- `principal-coaching-hub` — mentor's overview of all assigned coaching relationships (per-coachee cards + cycle progress + last-session date + quick-launch button into `principal-coaching-session`). `ch_sub_roles.director` only.
- `principal-coaching-session` — mentor session form, `ch_sub_roles.director` only. 5-stage agenda from `principal-coaching-framework-v1.json`. Logged sessions immutable. Foundation Reps **excluded at rule level** for coaching confidentiality. Doc id: `{principalUid}_{YYYY-MM-DD}`.
- `principal-360-admin` — central_admin tooling for 360 cycle launch. Create cycle (`{principalUid}_{academicYear}_{window}` doc id), open/close, generate cohort-specific respond links, monitor per-cohort response counts + composite F3. Replaces "admin manually creates cycle docs in Firestore". Director sees in navbar via page-access seed.
- AH-side principal pages (`principal-observation-entry`, `principal-appraisal-entry`, `principal-360-respond`, `principal-360-results`, `principal-coaching-view`) live in Academic Hub but write to collections whose rules are hosted here. See `firestore.rules` "Principal Evaluation Module" block.

**Assessment System Authoring (2026-05-10 — Phase 1 + 2):** the CH-side surfaces of the network-wide chapter test + EASE Growth pipeline. Student-facing runner lives in Students Hub. Schema host: §17 of FIRESTORE_SCHEMA.md.
- `chapter-test-author` — Chapter test CRUD + items subcollection. MCQ / numeric / short-text. Draft / published / archived lifecycle. visible_to=[director, coordinator]. Subject filter applied client-side (Phase 2 onwards: removed — every authoring user sees every test). Body content wrapped in `.modal-body` so the modal scrolls independently of sticky title + footer (CH global pattern). Year selector reads "Year 7" through "Year 12" — Cambridge "Stage" terminology dropped per partner-school convention. **Field name `stage` (number 7..12) is kept** for back-compat; UI label only. **Browse-bank picker has two modes** (2026-05-12): "Chapter Test Bank" reuses existing `chapter_test_items` docs (`bankSourced:true`, shared across tests via `arrayUnion` on `usedInTestIds[]`); "Latihan Archive" queries `ease_items where source=='latihan'` and **clones** each selection into a fresh `chapter_test_items` doc on save (carries `clonedFromEaseId` / `clonedFromSource:'latihan'` / `clonedFromSourceCode` / `clonedFromLessonCode` / `clonedFromDiscipline` for audit). HQ edits on the clone never write back to the upstream archive. Discipline filter only appears in Latihan mode; numeric type option disabled (Latihan ships MCQ + short only).
- `ease-item-author` — 3-band item bank (easy / medium / hard). MCQ / numeric / short-text. Strand + stage range. `pilotPhase: true` until calibrated (Phase 3 Cloud Function). visible_to=[director, coordinator]. **Pagination (post-2026-05-11):** dropped the `onSnapshot(collection)` realtime stream once the bank hit ~5.6k docs; now cursor-paginates 25 rows/page with `getCountFromServer` for stat totals and per-filter result counts. Stem column ships a 2-line clamp + MathJax typeset; `<table>` tags stripped (replaced by inline "table" pill); preview eye button opens a read-only modal that renders rich `stemHtml` + `optionsHtml[]` with safe sanitiser (allowed tags + https-only `<img>`). Row actions hover-reveal. Filter bar: stem-search-first, then Subject / Difficulty / Type / Source; `source` filter splits `latihan` (imported) vs `hq` (HQ-authored). Item code (`sourceCode` or doc-id prefix) shown in first column.
- `ease-window-admin` — Open/close the three EASE windows in an academic year (Term 1 / Term 2 / Term 3). Doc id `{academicYear}_{window}` where `window ∈ {'term1', 'term2', 'term3'}`. Legacy `fall` / `winter` / `spring` docs continue to load (option is dynamically injected into the dropdown when editing them) and render with a "(legacy)" tag in the list; new docs always use the term1/2/3 keys. Subjects multi-select + item count target + SE stop threshold. visible_to=central_admin only. Status `draft` hides from students; `open` reveals; `closed` is read-only.
- `ease-bank-browser` (2026-05-11) — Read-only live viewer into the upstream latihan.id question archive. Surfaced in the navbar as "Latihan Browser" since 2026-05-11; URL slug kept as `ease-bank-browser` for bookmark stability. 49 lessons × ~42k items grouped by SD / SMP / SMA / A-LEVEL. Filters: grade (client-side — upstream `grades[]` is broken), question_type, year, per_page. Lazy code-search index per lesson on first non-empty query. Cards render MathJax LaTeX + sanitised HTML + live `latihan.id/storage/` images; dead `eduversal.s3.…` images get an SVG placeholder + "Image 404" pill. Calls go through Cloud Function `easeBankProxy` (asia-southeast1) so the bearer token stays in Secret Manager (`LATIHAN_API_TOKEN`). visible_to=[director, coordinator]. See root CLAUDE.md "Latihan.id Question Bank" for the full upstream contract + quirks.
- `question-bank` (2026-05-11) — Standalone bank for **`chapter_test_items` only**. Subject / Year / Type / Difficulty / Status filters, draft → published → archived lifecycle, `usedInTestIds[]` in-use guard, versioning via `parentItemId`. URL slug kept as `question-bank` for stability + page-access doc id; surfaced in the navbar as "Chapter Test Item Bank" since 2026-05-11. Same `chapter_test_items` collection that `chapter-test-author` writes to — Chapter Test Author composes items into a test envelope (`chapter_tests.itemIds[]`) and can inline-create new items, while this page is the standalone CRUD + reuse surface across all tests. **EASE items are out of scope here** — they need a pilotPhase / seenCount / correctRate calibration bootstrap at create time, so `ease_items` writes are routed exclusively through `ease-item-author`. visible_to=[director, coordinator].
- `practice-assessment-author` (2026-05-12) — 3-panel composer for `practice_assessments`. Left rail = user's draft/published/archived list. Middle = picker with two tabs: **Manual Browse** (paginated table over `practice_questions` with subject + difficulty + topic group + type filters + stem-token array-contains search) and **AI Suggest** (free-text intent + structured difficulty mix + topic-group chips → `practiceBankAiSuggest` callable → ranked suggestions with rationale + per-row "Add" + "Add all"). Right rail = basket (drag-stale ordering preserved by `itemIds[]` order; live difficulty-mix preview; remove buttons). Save / Publish / Archive / Delete in the basket footer. Items referenced by id — no cloning. visible_to=[director, coordinator]. Same `sanitisePreviewHtml()` allowlist + MathJax config as `practice-bank-admin.html` (`$…$` is NEVER inline math — currency / variable literals).
- `practice-bank-flags` (2026-05-13) — HQ Observer triage queue for `practice_question_flags`. Realtime onSnapshot capped at 200 newest rows, 5 status tabs (open / triaged / fixed / wontfix / duplicate) × 2 filter selects (bank + reason). Each row deeplinks to the right authoring page per `collection`: `practice_questions` → `/practice-bank-admin`, `chapter_test_items` → `/question-bank`, `ease_items` → `/ease-item-author`. Triage actions flip `status` + `triagedAt` + `triagedBy` + optional 280-char `triageNote`. visible_to=[director, coordinator]; admin/director bypass page-access. Build manifest entry in `build.js`; navbar entry in the Pacing Assessments dropdown column (under "Practice Questions" subheader) — see root CLAUDE.md "HQ Observer Flag System" for the full end-to-end flow.
- `practice-bank-admin` (2026-05-12) — CRUD page for `practice_questions`. Subject / topicGroup / difficulty / type / status filters; archive/unarchive; per-row preview modal; import audit. visible_to=[director, coordinator]. Same MathJax + sanitiser config as `practice-assessment-author` (`$…$` is NEVER inline math).
- `practice-bank-endorsements` (post-2026-05-13) — HQ "verified" endorsement queue: tags individual practice items with `cambridgeStandardRefs[]` + `endorsedBy` + `endorsedAt` so SH leaderboard / tournament UIs can prefer endorsed items. Read-only for non-endorsers. visible_to=[director, coordinator].
- `daily-challenge-admin` (post-2026-05-13) — Manual override + monitoring for `rotateDailyChallenges` Cloud Function. Force-rotate today's challenge, preview tomorrow's, lock a specific `practice_assessments` bundle as the next pick. visible_to=[director, coordinator].

**Students-Hub admin surfaces (2026-05-13):**
- `students-overview` — HQ network-wide student roster (cross-school, cross-grade). Filter by school + grade + status + observer flag. Row actions: open student profile · flip `is_hq_observer` · graduate · reactivate. central_admin only — TH/AH already cover own-school flows; this is the network-wide HQ surface.

**Pilot helper scripts** in `scripts/chapter-tests/`:
- `seed-sample-chapter-tests.js` — 3 published Year 7 chapter tests (Math 7Ni.01 Integers, English 7E.01 Reading, Science 7Bp.01 Cells), 8 items each, mix of types so all auto-grading paths run during smoke test. `--dry` / `--wipe`.
- `check-pilot-readiness.js` — Audits a school's `partner_schools.domain` + Year 7-8 classes subcollection + active `students/{uid}` count. Run before pilot day-1.

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
- **`.page-hero` + `.page-toolbar` + `.page-empty`** — canonical feature-page chrome (2026-05-19). See "Page Hero Standard" below.

**Page-specific `<style>` blocks should contain ONLY:**
- `:root` accent overrides (e.g. `--accent: #7c3aed` for assessments, `#d97706` for appraisals)
- Component styles unique to that page
- Override rules differing from shared defaults
- `display: none` overrides for admin-only elements
- **NEVER** override `.page-hero` background, `.page-hero__inner` layout, or `.page-hero__kpi*` chrome — those come from tokens. Page-local extras (a title stripe, a custom pill in the eyebrow row) must use page-local class names.

### Page Hero Standard (2026-05-19)

Every CH feature page (user-facing content surface — NOT dashboard, NOT admin tool) belongs to one of four families and uses the canonical `.page-hero` markup. See root [`CLAUDE.md`](../CLAUDE.md) "Design System — Page Families" + [`docs/architecture/DESIGN_SYSTEM.md`](../docs/architecture/DESIGN_SYSTEM.md) "Page families & canonical hero" for the family table + markup snippet.

**Adopted (7):** notifications, references, roles-positions, messageboard, announcements, my-induction, my-school-visits.

**Intentionally skipped (3):**
- `handbook.html` — `handbook-reader.css` is shared with AH+TH via [`shared-design/`](../shared-design/), so swapping `.hero` → `.page-hero` here breaks AH+TH handbook rendering. Cross-hub refactor required (sync canonical CSS into all 3 hubs' handbook-reader.css first).
- `library.html` — Featured Bookshelf is embedded *inside* the hero block. Canonical `.page-hero__inner` is a flex container with title + KPI slots; the bookshelf grid doesn't fit. Either extract the shelf to a separate section (UX change) or extend the canonical with a `.page-hero__extras` slot first.
- `inventory.html` — Already Operations-family compliant (no hero, plain `<h1>` in `.main-header`). No refactor needed.

**When adding a new feature page**, default to the canonical hero. The only legitimate reason to skip is one of the three above (cross-hub coupling, embedded non-canonical content, Operations family). Inventing a new gradient in a page `<style>` block is a regression — see root CLAUDE.md Common Mistake #50.

---

## Mail Composer + Resend Mail-Service

Network-wide newsletter sender. CH-only page (`mail-composer.html`, `central_admin` gated). Talks to a separate Resend-backed Express service hosted on Railway (NOT in this monorepo — repo at https://github.com/a-perdana/Mail-Service, cloned at `c:/Users/maliu/Desktop/Mail-Service/`).

**Live infrastructure (2026-05-06):**
- **Service URL:** `https://mail-service-production-e9e7.up.railway.app`
- **Resend domain:** `eduversal.org` Verified — SPF + DKIM + MX live on Cloudflare DNS
- **FROM:** `Eduversal Education <noreply@eduversal.org>` (DKIM-signed)
- **Reply-To default:** `careers@eduversal.org` (Railway env `DEFAULT_REPLY_TO`; per-call `replyTo` overrides)
- **Auth:** Bearer token (`MAIL_SERVICE_SECRET`), CORS allowlisted to `centralhub.eduversal.org` + `teachershub.eduversal.org` + Vercel preview origins
- **Env vars** (set in Vercel for both CH and TH): `MAIL_SERVICE_URL`, `MAIL_SERVICE_SECRET`. Build-time substitution propagates to `window.ENV.*` via `firebase-config.js` substitution.

**Endpoints:**
| Endpoint | Used by |
|---|---|
| `GET /health` | Liveness probe |
| `GET /recipients?platform=&role=&subRole=&schoolId=` | Mail-composer recipient panel — joins `users` + `teacher_contacts` |
| `GET /campaigns` | Mail-composer history table |
| `POST /send-test` | Mail-composer "Send Test Email" button |
| `POST /send-campaign` | Mail-composer "Send Campaign" — async batched, writes `mail_campaigns/{id}` Firestore record |
| `POST /send-transactional` | TH careers (apply confirmation, interview, offer, reject) — one-to-one with branded variant templates |

**`mail-composer.html` UI features:**
- Two-source recipient model: platform chips (filtered query) + manual search-add. Final list = `chipRecipients ∪ manualRecipients` minus `excludedEmails`.
- **Import emails from list** (added 2026-05-06): paste OR upload `.txt` / `.csv` of external addresses. Parser handles bare emails, `Name <email>`, comma/semicolon Outlook-style, CSV with/without header. Imported addresses tagged `source:'manual'`, flow through the same `/send-campaign` pipeline. xlsx not supported — instruct user to "Save As CSV" first.
- "View & Edit Recipients" modal lets admin uncheck individual recipients before send.
- Quill rich-text editor for body. Build pipeline wraps via `buildEmailHtml()` (gradient header + footer with unsubscribe placeholder).

**Two distinct email wrappers in the service:**
- `buildEmailHtml()` — newsletter wrapper (cyan/navy gradient, unsubscribe footer)
- `buildTransactionalHtml({ templateName })` — one-to-one wrapper with 4 variants: `application_received` (mor), `interview` (mor), `offer` (green), `reject` (neutral grey). Each carries an eyebrow label + colour-coded gradient header. Used by TH careers via `partials/mailer.js` helper.

**Updating the service:** edit `c:/Users/maliu/Desktop/Mail-Service/index.js` → commit + push → Railway auto-deploys in ~30-60 seconds. Confirm deploy via `GET /health` + send a probe to your own Gmail.

---

## Cambridge Competency Framework — CH dual role

CH owns two roles in the 3-track system:
1. **Reviewer** for all 3 tracks via `competency-admin.html` (track filter chips, heatmap, cohort, issue tabs all support `teachers` / `academic` / `central`)
2. **Author of CH Specialist track** via the 4 `specialist-*.html` pages

**CH-specific:**
- The Specialist track is **hybrid by design** — coaching-observer (cof / tpd) + subject-deepening (csm / cqa) + network strategy (nls / xen). v2 refresh (2026-05-19) widened to **29 competencies** (added csm-5 AS/A-Level, cof-5 NEA Moderation, tpd-5 Subject CoP, nls-5 Charter NN1+NN2 Boundary, xen-5 Cambridge AI & Coursework Authenticity). 11/27 CTS covered (intentional — Specialists work *with* teachers, not *as* teachers).
- **v2 schema (2026-05-19)** — every competency now carries:
  - `cambridgeStandardRefs[]` (CTS chips, mor)
  - `permendiknasRefs[]` (yellow)
  - `eduversalStandardRefs[]` (ES madde chips, cyan — validated against `docs/research/eduversal/academic-standards/manifest.json`)
  - `aicfRefs[]` (AI Competency Framework chips, orange — **canonical refId format `teacher.{foundation|practitioner|leader}.{domainA-E}` or `unesco_aicft.{acquire|deepen|create}`** — wired by `cambridge-crossref.js` to popovers)
  - `pedagogyRefs[]` (📖 slate chips — Rosenshine / EEF / Kraft 2018 / Wenger / Schoenfeld / Driver / Wiliam / Lesson Study free-text bibliographic anchors)
- **Hand-authored v2 content** in `docs/competency/specialist-content-backfill-v2-part{1,2,3}.json` (89 entries × 29 competencies). Seeder: `scripts/competency/seed-specialist-content-v2.js`. Source field `hand_authored_v2` distinguishes from legacy v1. Legacy v1 backfills + seeders archived under `docs/competency/legacy/` + `scripts/competency/legacy/` (see README in each).
- **Auditable quality**: `node scripts/competency/audit-specialist-content.js` runs against live Firestore and reports Indonesia density + freshness density (post-2007 regulation + named modern sources) + pedagogy density per track. v2 targets: freshness ≥ 0.50/entry, pedagogy ≥ 0.30/entry, Indonesia ≥ 2.0/entry. Specialist track currently passes all 3 with margin (6.00 / 1.00 / 1.00).
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
| `partials/navbar.html` | **Hardcoded** navbar HTML+CSS+JS injected via `<!-- SHARED_NAVBAR -->`. The rendered menu (desktop dropdowns + mobile drawer) is literal HTML in this file — NOT generated from `nav_config/v1`. Also hosts the bespoke in-place editor (admin only, toggled via `#btnNavEdit`) which writes admin's drag-reorder + rename edits to `nav_config/v1` — but those writes only feed back into the editor's own source-of-truth + page-access lint, NOT the rendered HTML. To add/remove/reorder a real navbar link you MUST edit this file directly. See Common Mistakes #12. |
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
- **All outbound email goes through the Resend mail-service.** Don't write to `mail/{auto}` (legacy Firebase Trigger Email path — retired). For newsletters use `mail-composer.html` (UI). For programmatic sends from new CH pages, POST to `MAIL_SERVICE_URL/send-transactional` with bearer auth — see [Mail Composer + Resend Mail-Service](#mail-composer--resend-mail-service) section above.
- **`staff.html` writes both `schoolId` (FK) and `school` (denormalised name).** `<select>` value = `partner_schools.id`. Don't revert to free-text. Page renders 463+ rows with pagination (25/page, windowed buttons), filters (school, role, status, **level**, **linked**), and a 7-column grid (Name / Role / School / Department / Levels chip row / Status / Linked badge). Filter changes always reset to page 1.
- **Staff ↔ users bridge runs in `auth-guard.js`'s `applyStaffBridge()` — keep it in sync with the AH and TH copies.** First login looks up `staff` by `emailLower`; match copies fields onto `users/{uid}` + back-links via `userId` / `linkedAt` / `invited:false`; no match auto-creates a staff row keyed by deterministic SHA-1 (`sha1(emailLower).slice(0,20)`) and stamped `source:'auth-guard-autocreate'`. The rule block in `firestore.rules` allows both self-paths only when `emailLower == auth.token.email` AND `userId == auth.uid`. Tighten with care — silent breakage of new-user signup is the failure mode.
- **`/page-access` critical-page guard** opens confirm modal at save time before narrowing visibility on admin tooling pages. central_admin bypasses; other power users (director / coordinator) get explicit acknowledgement.
- **In-place navbar editor lives in `partials/navbar.html`** (CH only — bespoke). Writes to `nav_config/v1`. Don't fork into AH/TH — their navbars are flat and use `shared-design/nav-edit-simple.js` writing to `nav_config/{platform}`. **CH navbar is hardcoded HTML — `nav_config/v1` does NOT drive rendering.** To add a new link to the rendered navbar you MUST edit the HTML in `partials/navbar.html` directly (both desktop dropdown + mobile drawer); rebuild propagates via the `<!-- SHARED_NAVBAR -->` placeholder. AH/TH behave differently — their `nav_config/{platform}` doc IS the rendering source. See Common Mistakes #12.
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
Never `getDocs(collection(...))` unbounded. Always `limit(N)` + "Load more" UI. Past bug: `loadTopics()` had no limit. Also: drop `onSnapshot(collection)` realtime streams on near-static large collections — `ease-item-author.html` was streaming all 5.6k `ease_items` docs every page-open before the cursor-paginated rewrite. Cursor + `getCountFromServer` for stat totals is the pattern (~25 reads / page-open + 1 count/cell vs 5.6k full-stream).

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

### 12. CH navbar is HARDCODED HTML — `nav_config/v1` does not drive rendering, **BUT it does override item LABELS at runtime**
The CH navbar (`partials/navbar.html`) is bespoke literal HTML for both desktop dropdowns and the mobile drawer. `nav_config/v1` in Firestore is **not** the rendering source for structure (add/remove/reorder/section-header changes) — but the editor's `applyConfig()` runs on `authReady` and **re-writes the `.nav-item-label` textContent** + submenu-trigger labels from the saved doc, overwriting whatever was hardcoded in HTML. Net effect:
- **STRUCTURE** (which items exist, in what column, under what section header) → driven by hardcoded HTML in `partials/navbar.html`. Writing to `nav_config/v1` does NOT change structure on the rendered menu.
- **ITEM LABELS** (the text inside `.nav-item-label` for every desktop dropdown item + submenu trigger label) → driven by `nav_config/v1` IF the doc exists AND has an entry for that slug. Hardcoded HTML label is the bootstrap that admin first sees; once admin has Saved the in-place editor at any point, the doc carries an entry for every visible item and `applyConfig()` reasserts those labels on every page load.
- Mobile drawer labels are NOT touched by `applyConfig()` (the editor only walks desktop dropdown panels). So mobile drawer labels are driven by HTML only — a HTML-only rename will show on mobile but get overwritten back on desktop.

**To rename a desktop nav item permanently you must do BOTH:**
1. Edit the `<span class="nav-item-label">…</span>` text in `partials/navbar.html` (desktop AND mobile blocks — they're separate elements).
2. Update `nav_config/v1.{panelId}.items[].label` for the same `key`. Either open `/page-access` → click "✎ Edit Navigation" → fix the label inline → Save (writes the whole config back), OR script it directly via firebase-admin (`scripts/` style — fetch doc, mutate `items[]`, `set()`).

**To rename a mobile-only label or a structure-only change** (add/remove/reorder, change section header): hardcoded HTML edit is enough — `nav_config/v1` has no schema slot for section headers or for the mobile drawer, so it can't override them.

**To actually add / remove / reorder a navbar entry you must edit three things in `partials/navbar.html`:**
1. The desktop dropdown HTML inside the relevant `<div class="ch-dd-panel" id="chDdPanel-...">` block (find the right `<div class="ch-dd-col">` column + section header). Use `<div class="ch-dd-divider"></div>` + `<div class="ch-dd-col-header">` to start a new section.
2. The mobile drawer block lower in the same file — a `<div class="mob-nav-subheader">…</div>` + `<a class="mobile-nav-link" data-mob-page="…" href="…">…</a>` pair.
3. The `groupKeys` map near the bottom (~line 1900) — add the new slug to the relevant panel's array so the dropdown trigger highlights when the page is active.

Then run `node build.js` to propagate the updated `partials/navbar.html` into every `dist/*.html` via `<!-- SHARED_NAVBAR -->`. Forgetting any one of the three causes a silent partial regression: link works on desktop but not mobile, or trigger doesn't highlight on the page, etc.

**Past incidents:**
- 2026-05-12: First attempt to add `/practice-bank-admin` to the navbar wrote a new entry to `nav_config/v1` and the rendered menu didn't change — structure isn't driven by the doc.
- 2026-05-19: Renamed Documents→Inventory + Document Library→Library by editing only the HTML (desktop + mobile + dist rebuilt + deployed). Canlıda mobile drawer doğru, ama desktop dropdown'da hâlâ "Documents" + "Document Library" görünüyordu çünkü `nav_config/v1.chDdPanel-comms.items[]` doc'unda eski label'lar kayıtlıydı ve her sayfa yüklemesinde `applyConfig()` HTML'in üzerine eski label'ları yazıyordu. Fix: doc'taki ilgili iki entry'nin label alanlarını da güncellemek (`documents → Inventory`, `library → Library`). Yapılış şekli: bir kerelik firebase-admin script (`fetch → mutate items[] → set`). Pattern aynı: **rename = HTML + nav_config/v1 ikilisi**.

AH/TH navbars are the opposite: their `nav_config/{platform}` doc IS the rendering source for structure too (flat shape, `shared-design/nav-edit-simple.js`). Don't carry CH's hardcoded-HTML assumption into AH/TH or vice versa.

### 13. CH `auth-guard.js` dispatches `authReady` on `document`, NOT `window`
Listen with `document.addEventListener('authReady', …)` in every CH page. Listening on `window` makes the listener never fire — the page renders the empty shell because the init code that wires UI / starts onSnapshot / fetches data never runs, and the failure is **silent** (no errors, no toast, no network rejection — Firestore just never gets called).

Past incident 2026-05-13: `/practice-bank-flags` first ship listened on `window`. Triage queue rendered blank even though the Firestore doc was already in the collection and the rule + query both worked when probed via the REST API. Took several rounds of "is it the rule? the query? the data?" before pinning the cause to the listener target.

SH `auth-guard.js` uses `window.addEventListener('authReady', …)` instead, so when porting code between hubs always check the target. Easy to miss because both forms are valid JS — only one matches the dispatcher.

### 14. Don't put `<body style="display:none">` on CH pages
CH `auth-guard.js` toggles `document.body.style.visibility` (hidden → visible) — it never touches `display`. If you inline `display:none` on the body, the `visibility:visible` flip can't override the stronger `display` rule and the page stays blank forever. The example in this CLAUDE.md's `## Auth Pattern` section showing `<body style="display:none">` is **wrong** for CH — use plain `<body>` to match the working pattern on `practice-bank-admin.html`, `question-bank.html`, etc. Past incident 2026-05-13: `practice-bank-flags.html` shipped with the inline style copied from the example, blank-paged in production until removed.
