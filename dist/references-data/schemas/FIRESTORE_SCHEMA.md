# Firestore Schema — `centralhub-8727b`

**Single source of truth** for every collection in the shared Firestore project. Read this before adding a new collection, renaming a field, or writing a security rule.

This document is the SQL-style schema reference the project lacked. It pairs with [`db-diagram.md`](db-diagram.md) (Mermaid ER diagram) and the live `Central Hub/firestore.rules` (the actual enforcement).

> **Scope.** Five apps share this project: Central Hub, Academic Hub, Teachers Hub, Research Hub. (IGCSE Tools uses its own `igcse-tools` project — out of scope here.) Total: **74 collections** including subcollections.

---

## Conventions

### Naming
| Concept | Field name | Notes |
|---|---|---|
| User reference | **`userId`** when referencing a user from another doc. <br> **`uid`** ONLY when the doc id IS the uid (e.g. `users/{uid}`, `userProgress/{uid}`, `user_competencies/{uid}`). | Standardised 2026-05-03 (Step 7). |
| Author / actor | **`authorUid`** for content authored by a user (topics, replies, comments). | Standardised 2026-05-03. |
| Semantic role | `teacherUid`, `appraiserUid`, `observerUid`, `evaluatorUid`, `testerUid`, `createdBy`, `respondedBy`. | Kept where the doc has multiple user refs and the role matters. |
| School reference | `schoolId` → `partner_schools/{id}` | Always pointer-style. `school` (denormalised display name) MAY also be present but is never used as a key. |
| Subject reference | `subjectId` (free-text key like `'math'`, `'biology'`) | Not yet a Firestore doc — see future work. |
| Period reference | `periodId` → `teacher_kpi_settings/{id}` | KPI evaluation periods. |
| Created timestamp | `createdAt` (always; `serverTimestamp()`) | Legacy `timestamp` was renamed; do not reintroduce. |
| Updated timestamp | `updatedAt` | Same convention. |

### Doc ID patterns
Three doc-ID patterns are used; pick the one that matches your access pattern.

| Pattern | When to use | Example |
|---|---|---|
| **Auto-id** (`addDoc`) | Many records per "owner", no natural unique key | `announcements/{id}`, `topics/{id}` |
| **Composite key** (`{uid}_{period}`) | Strict 1-per-(user, scope) and clients can construct the key deterministically | `teacher_kpi_submissions/{uid}_{periodId}` |
| **Stable slug** (`pageKey`, `subjectCode`) | Human-readable lookup, often shared across apps | `cambridge_syllabus/0580_C1.1`, `page_access_config/cambridge-exams` |

### FK semantics
Firestore has **no foreign key constraints** — these are documented relationships only. The rules layer enforces some via `get()` calls (e.g. `isAHUserAtSameSchool`), but most are conventions the application code maintains.

### Denormalisation policy
- Display strings (`schoolName`, `teacherName`, `displayName`) are denormalised onto reading docs to avoid an extra read per row. They **drift** if the source changes; refresh policy is documented per collection.
- Aggregates (counts, percentages) are denormalised when used by dashboards.

### Read scope vocabulary
- **Owner** — the doc's `uid` / `userId` field equals the requesting user.
- **Same-school** — both the requester and the target user point at the same `partner_schools/{id}`. Enforced by the `isAHUserAtSameSchool(targetUid)` rules helper.
- **Sub-role gated** — requester must hold one of a named set in their `*_sub_roles[]` array.

### Why not a single `users` SQL-style table?
Each platform's role/sub-role/approval state lives on the same `users/{uid}` doc, so platform admins can adjust roles independently. The doc therefore has up to **15 platform-prefixed fields** (4 `role_*` + 4 `*_sub_roles[]` + 4 `approval_status_*` + `schoolId` + `school` + name/email).

---

## Collections by Domain

The catalogue below groups collections by the business domain they serve. Within each card:

- **PK** — doc ID format
- **Fields** — key fields with type and FK arrows
- **FKs** — outgoing references (use `→ collection.field`)
- **Writers** — who can `create`/`update`/`delete` per the live rule
- **Read scope** — who can `get` and `list`
- **Indexes** — composite indexes (single-field auto-indexes are not listed)
- **Notes** — gotchas, denormalisation, history

---

### 1. Identity & Org

#### `users/{uid}`
**PK:** `uid` (Firebase Auth UID)
**Fields:** `email`, `displayName`, `photoURL`, `createdAt`, `lastLoginAt`, `schoolId →partner_schools.id`, `school` (denormalised display name), `position`, plus per-platform fields below.

| Per-platform field | Values | Set by |
|---|---|---|
| `role_centralhub` | `central_user` \| `central_admin` | console.html (CH admin) |
| `role_academichub` | `academic_user` \| `academic_admin` | console.html |
| `role_teachershub` | `teachers_user` \| `teachers_admin` | console.html |
| `role_researchhub` | `research_user` \| `research_admin` | console.html |
| `ch_sub_roles[]` | `director`, `coordinator` | console.html |
| `ah_sub_roles[]` | `foundation_representative`, `school_principal`, `academic_coordinator`, `cambridge_coordinator` | first login (AH auth-guard) + console.html |
| `th_sub_roles[]` | `subject_teacher`, `subject_leader` | first login (TH auth-guard) + console.html |
| `approval_status_academichub` | `pending` \| `approved` \| `rejected` | console.html |
| `approval_status_teachershub` | same | console.html |
| `subjects[]` (TH) | `math`, `biology`, ... + custom | TH profile prompt |
| `classes[]` (TH) | level keys (`igcse`, `checkpoint`, `asalevel`) | TH profile prompt |
| `{level}_{subject}_classes[]` (TH) | e.g. `igcse_math_classes` — array of class names | TH settings.html |
| `ch_subjects[]` (CH) | subset of `math`, `biology`, `chemistry`, `physics`, `science`, `english`, `bahasa`, `religion`. Specialty subjects for HQ Subject Specialists; drives subject-scoped pacing rules + dashboards. `science` = combined-science (checkpoint), separate from individual biology/chemistry/physics specialists. Checkpoint Science syllabus + pacing accept any of `biology`/`chemistry`/`physics`/`science` (matches `checkpoint_science_pacing` rule). Empty for Directors / cross-subject coordinators. | console.html |

**FKs:** `schoolId → partner_schools.id` · `staffId → staff.id` (only set if the user matched a seeded `staff/{...}` row at first login; see "Staff ↔ users bridge" on the `staff` card below).
**Writers:** owner (write own doc), `central_admin` (write any). First login auto-creates with default role + `pending` approval.
**Read:** `get` — owner or admin. `list` — `central_admin`, AH admin, CH coordinator (for console + appraisal teacher search).
**Indexes:** none (no compound queries).
**Notes:**
- The legacy single `role` field is **fully removed**.
- `schoolId` is REQUIRED for AH and TH users (auth-guard re-prompts until set, unless prefilled from a matching `staff` row at first login).
- HQ users live under `partner_schools/eduversal_hq` (a virtual school).

---

#### `partner_schools/{schoolId}`
**PK:** Auto-id (e.g. `Dy5r9txPnrBNbyYDleDf`); HQ uses literal `eduversal_hq`.
**Fields:** `name`, `domain` (e.g. `fatih.sch.id` — drives email-based auto-default in AH/TH auth-guards), `city`, `status`, `createdAt`, `enabled_systems[]` (Phase 3 ops — pilot enrolment per school, optional. Allowed values: `'kpi'`, `'appraisal'`, `'competency'`, `'induction'` (added Phase 5). **Missing field = all systems enabled** (back-compat for schools that pre-date pilot). **Empty array `[]` = all systems explicitly disabled** for that school).
**Subcollections:**
- `partner_schools/{id}/classes/{classId}` — `name`, `grade`, `section`. Read by TH pacing pages and `settings.html`.

**FKs:** none.
**Writers:** `central_admin` or `academic_admin` (write the school doc); any signed-in user can `create`/`update` a class subcollection doc; only `central_admin` can `delete` a class.
**Read:** any authorised user.
**Notes:**
- Single canonical school directory. The legacy parallel `schools/` collection was migrated and deleted; do not recreate it.
- 16 docs total (15 partner schools + `eduversal_hq`).
- When a partner school's email domain changes, update the `domain` field directly (or via `scripts/page-access/migrate-schools-to-partner.js`'s `DOMAIN_MAP`).
- Multi-school domains (e.g. `semesta.sch.id` for two campuses) leave the auth-guard picker empty so the user picks manually.

---

#### `staff/{staffId}`
**PK:** Deterministic `sha1(emailLower).slice(0,20)` for seeded teachers; auto-id for hand-added rows. Deterministic ids let `seed-staff.js` re-run idempotently.
**Fields:** `name`, `email`, `emailLower` (lookup key), `phone`, `role` (`'teacher'`/`'admin'`/`'staff'`/`'coordinator'`), `status` (`'active'`/`'pending'`/`'inactive'`), `schoolId →partner_schools.id`, `school` (denormalised display name), `department`, `position`, `notes`, `gender`, `nationality`, `levels[]` (e.g. `['SMP','SMA']`), `createdAt`, `source`.
**Bridge fields:** `userId →users.uid` (null until first login), `linkedAt` (null until first login), `invited` (`true` while a seeded row is unclaimed; flips to `false` when the matching user signs in for the first time).
**FKs:** `schoolId → partner_schools.id` · `userId → users.uid` (set at first login by each hub's `auth-guard.js applyStaffBridge()`).
**Writers:** `central_admin` for everything. Two self-managed paths for the matching user themselves: (1) **self-CREATE** with id `sha1(emailLower).slice(0,20)` and `source:'auth-guard-autocreate'` (used when a user logs in but no HQ-seeded row exists for them — auth-guard writes one); (2) **self-UPDATE** restricted to `userId` / `linkedAt` / `invited` (used when an HQ-seeded row matches and is being linked). Both paths require `emailLower == auth.token.email` AND `userId == auth.uid`.
**Read:** any authorised user.
**Notes:**
- Seeded by [`scripts/staff/seed-staff.js`](../scripts/staff/seed-staff.js) from a network-wide MailSender CSV — 463 teachers across 13 partner schools as of 2026-05-09.
- The bridge fields enable a **staff ↔ users** join without an Auth account precondition: HQ seeds rows for every contracted teacher; the first time a teacher signs in (any of TH/AH/CH), their auth-guard looks up `staff` by `emailLower`, copies `schoolId`/`school`/`displayName`/`title`/`phone` onto the new `users/{uid}` doc, and writes `userId`/`linkedAt` back here. Both records stay in sync from then on.

---

### 2. Communication & Content

#### `announcements/{annId}`
**PK:** auto-id.
**Fields:** `title`, `body`, `category`, `pinned`, `featured`, `attachmentUrl`, `createdAt`, `updatedAt`, `authorUid →users.uid`.
**Subcollection:** `announcements/{id}/comments/{commentId}` — `body`, `authorUid →users.uid`, `authorName`, `createdAt`.
**Writers:** `central_admin` for the announcement; comment author can create their own comment + delete it (or admin).
**Read:** any authorised user.

#### `announcement_reads/{readId}`
**PK:** `{annId}__{uid}` (composite).
**Fields:** `userId →users.uid`, `annId →announcements.id`, `readAt`.
**Writers:** the user reading (own doc only).
**Read:** `central_admin`.

#### `topics/{topicId}` + `topics/{topicId}/replies/{replyId}` (message board)
**PK:** auto-id.
**Fields (topic):** `title`, `body`, `author` (email), `category`, `status`, `createdAt`, `pinned`.
**Writers:** any authorised user can create; author or admin can update; admin only can delete.
**Read:** any authorised user.
**Index:** `(status, createdAt DESC)`.

#### `feedbacks/{fbId}`
**PK:** auto-id. **Single canonical collection** (consolidated 2026-05-03 — was `feedback` + `feedbacks`).
**Fields:** `subject`, `message`, `userId →users.uid` (or `uid` on legacy TH docs), `email` / `userEmail`, `createdAt`, `__src` ('centralhub'|'academichub'|'teachershub'), `status` (CH-only, optional), `page` (some pages), `__migratedFrom` + `__migratedAt` (legacy CH docs that came from the old `feedback` collection).
**Writers:** any authorised user (creates only). **Read/update/delete:** central_admin via `feedback-management.html`.
**Notes:** `feedback-management.html` discriminates source by `__src` first, falls back to field-presence heuristics for pre-2026-05-03 docs that lack the marker. Migration script: `scripts/feedback-merge/merge-feedback-into-feedbacks.js`.

#### `library/{resourceId}`
**PK:** auto-id.
**Fields:** `title`, `description`, `url`, `type`, `tags[]`, `createdAt`.
**Writers:** AH admin. **Read:** any authorised user.

#### `documents/{docId}` (Academic Hub)
**PK:** auto-id.
**Fields:** `title`, `description`, `fileUrl`, `category`, `subject`, `tags[]`, `createdAt`, `uploaderUid →users.uid`.
**Writers:** AH admin. **Read:** any authorised user.

#### `central_documents/{docId}`
Central Hub's own document repository. Same shape as `documents` but admin-managed for HQ-wide files. **Renamed from `documents` historically** — the old name now belongs to AH.

#### `doc_likes/{likeId}` + `doc_ratings/{ratingId}` (AH)
**Fields:** `userId →users.uid`, `docId →documents.id`, plus `liked` (bool) or `rating` (1–5).
**Writers:** any authorised user (own row only).

#### `prompts/{promptId}` (AH AIPrompts)
**PK:** auto-id.
**Fields:** `title`, `body`, `category`, `uses` (counter), `createdAt`.
**Writers:** AH admin (full); any authorised user can increment `uses` only.

---

### 3. Surveys

#### `surveys/{surveyId}`
**PK:** auto-id.
**Fields:** `title`, `description`, `platforms[]` (`'centralhub'`/`'academichub'`/`'teachershub'`), `status` (`'draft'`/`'published'`), `allowResponses` (bool), `questions[]`, `createdAt`.
**Writers:** `central_admin` only.
**Read:** any signed-in user (gated further at response time).

#### `survey_responses/{responseId}`
**PK:** auto-id.
**Fields:** `userId →users.uid`, `surveyId →surveys.id`, `platform`, `answers[]`, `createdAt`.
**Writers:** the user (own doc) — payload is validated against `surveys/{surveyId}.platforms[]` and `status === 'published'` at rule level.
**Read:** any signed-in user (rule is permissive; intended for cross-platform aggregation).

---

### 4. Calendar & Scheduling

#### `calendar_events/{docId}`
**PK:** auto-id.
**Fields:** `title`, `category`, `department`, `date_start` (ISO YYYY-MM-DD), `date_end`, `description`, `createdAt`.
**Writers:** `central_admin`. **Read:** any authorised user.

#### `calendar_settings/current` (single doc)
**PK:** literal `current`.
**Fields:** `academicYearStart` (ISO), `totalTeachingWeeks` (int), `terms[]` (`{label, start, end}`).
**Writers:** `central_admin`. **Read:** any authorised user.
**Notes:** **Single source of truth** for academic year configuration. Never duplicate `termStart`/`totalWeeks` elsewhere.

#### `teaching_schedule/{docId}`
Pre-computed teaching weeks per subject, written by an admin Sync. `central_admin` write; any authorised read.

#### `cambridge_calendar/{docId}`
Cambridge exam deadline dates per series. `central_admin` write; any authorised read.

#### `school_events/{eventId}`
Partner Schools Event Calendar. Fields: `schoolId →partner_schools.id`, `schoolName` (denormalised), `title`, `category`, `date_start`, `date_end`, `description`, `createdBy →users.uid`, `createdAt`.
**Writers:** any Central Hub user (create/update/delete). **Read:** any authorised user.

---

### 5. Cambridge Curriculum (reference data)

All seeded from `scripts/scheme-of-work/`, `scripts/progression/`, etc. Read-open to any authenticated user; writes by `central_admin` only.

#### `cambridge_syllabus/{docId}`
**PK:** `{subjectCode}_{syllabusCode}` e.g. `0580_C1.1`, `0862_7Ni.02`.
**Fields:** `code` (display, e.g. `C1.1`), `title`, `tier` (`Core`/`Extended`), `topicArea`, `description`, `content`, `notes`, `paper` (Stage 7/8/9 for checkpoint), `subjectCode`.
**Notes:** Autocomplete in pacing pages must search `entry.code`, NOT the doc ID.

#### `cambridge_scheme_of_work/{docId}`
**PK:** `{subjectCode}_{code}` e.g. `0580_C1.1`, `0862_7Ni.01`, `9709_1.1`.
**Fields:** `subjectCode`, `code`, `tier`, `title`, `topicArea`, `learningObjectives[]`, `teachingActivities[{body, tags[]}]`, `resources[{title, url, type}]`, `sdgLinks[{goals[], suggestion}]`, `syllabusVersion`, `schemeOfWorkVersion`, `examFromYear`, `examToYear`. **0862** also has `stage`, `unit`, `commonMisconceptions[]`, `keyVocabulary[]`. **9709** also has `paper`, `commonMisconceptions[]`, `keyVocabulary[]`.
**Seeded so far:** 0580 (125), 0862 stages 7–9 (179), 9709 (38) = 342 total.

#### `cambridge_syllabus_progression/{subjectCode}`
**PK:** `subjectCode` (e.g. `0862`, `0893`).
**Fields:** `subjectCode`, `rows: [{component, topicArea, stage7, stage8, stage9}]`.
**Used by:** Progression Grid tab on checkpoint pacing pages.

#### `km_curriculum/{docId}`
**PK:** `km-{subject}-kelas-{grade}-bab-{n}` (or `…-tl` for Matematika Tingkat Lanjut).
**Fields:** `subject`, `fase` (`'D'`/`'E'`/`'F'`/`'F+'`), `grade` (7..12), `track`, `textbook`, `bab_number`, `bab_title`, `bab_title_en`, `sections[]`, `concept_tags[]`, `source`, `createdAt`.

#### `curriculum_master_topics/{docId}`
**PK:** `topic-{subject}-{TOPIC_ID}`.
**Fields:** `subject`, `topic_id`, `topic_name`, `concept_family`, `cambridge_coverage[{level, subjectCode, codes[], depth, notes?}]`, `km_coverage[{fase, grade, track, km_curriculum_doc_id, depth, notes?}]`, `comparison{cambridge_first_grade, km_first_grade, status, notes}`, `createdAt`. Status enum: `covered`, `partial`, `km_only`, `cambridge_only`, `depth_mismatch`.

---

### 6. Pacing (subject-level teaching plans)

14 collections following the same shape: `{subject}_pacing/{yearKey}` (one doc per year-cohort).

| Collection | Year key | Writers |
|---|---|---|
| `math_pacing` `biology_pacing` `chemistry_pacing` `physics_pacing` | `year9-10` | `central_admin` / CH coordinator / matching CH Subject Specialist |
| `asalevel_math_pacing` `asalevel_biology_pacing` `asalevel_chemistry_pacing` `asalevel_physics_pacing` | (per page) | + `teachers_admin` |
| `checkpoint_math_pacing` `checkpoint_english_pacing` `checkpoint_science_pacing` | (per page) | + `teachers_admin` |
| `primary_math_pacing` `primary_english_pacing` `primary_science_pacing` | (per page) | + `teachers_admin` |

**Doc shape:** `chapters[]`, `classes[]`, `objPrefixes[]`, `weeklyHours`, plus per-topic week/hour metadata.
**Read:** any authorised user.

**Subject scoping (Step 10, 2026-05-03):** Each `*_pacing` collection's write rule restricts subject specialists to their own subject via the `isCHSubjectSpecialist(subjects)` helper. A central_user with `ch_subjects: ['math']` can write `math_pacing` / `asalevel_math_pacing` / `checkpoint_math_pacing` / `primary_math_pacing` but NOT biology / chemistry / etc. Combined-science pacing (`checkpoint_science_pacing`, `primary_science_pacing`) accepts any of biology / chemistry / physics specialists. central_admin and CH coordinators (`ch_sub_roles: ['coordinator']`) bypass the subject scope entirely.

**Client-side gating (Step 11, 2026-05-03):** Central Hub `auth-guard.js` mirrors the same subject mapping in `SUBJECT_PAGE_MAP` and:
- Redirects direct URL access to a non-allowed pacing page → `/?denied=<slug>` (yellow toast on dashboard)
- Hides any `[data-nav-key]` / `[data-nav-page]` link or `<a class="card" href]` element that targets a pacing page outside the user's `ch_subjects[]`
- A `MutationObserver` re-runs gating whenever new matching elements appear (async navbar mounts, dynamically inserted cards)

Bypass list is identical to the rule layer (admin / coordinator / director). Empty `ch_subjects[]` on a central_user means **no specialty** — they cannot reach any subject-specific pacing page (the rule blocks writes too). Add at least one subject in `console.html` for them to gain access.

#### `userProgress/{uid}`
**PK:** `uid` = teacher's UID (one cumulative doc per teacher).
**Fields:** `statuses{ci-ti: 'pending'/'inprogress'/'done'/'revisit'}`, `statuses_<className>{}`, `pacingDone_<subjectKey>{}`, `overallPct`, `completionPct`, `schoolId →partner_schools.id`, `subject`/`subjectKey`, `lastUpdatedAt`.
**FKs:** `schoolId → partner_schools.id` (denormalised).
**Writers:** owner only.
**Read:** owner; `central_admin`; CH coordinator; `isAHUserAtSameSchool(uid)` (AH user from the same school).
**Notes:** Cumulative — one doc per teacher, never per period. `schoolId` is denormalised so dashboards can group by school cheaply.

---

### 7. Weekly Checklists (HQ + AH + TH)

#### `weekly_essentials/{platform}`
**PK:** `platform` (`'centralhub'`/`'academichub'`/`'teachershub'`/sub-role keys).
**Fields:** `items[]` — standing recurring checklist items.
**Writers:** `central_admin`. **Read:** any authorised user.

#### `weekly_templates/{docId}`
**PK:** auto-id.
**Fields:** `platform`, `weekNumber`, `tasks[]`, `createdAt`.
**Writers:** `central_admin`. **Read:** any authorised user.

#### `weekly_progress/{docId}`
**PK:** `{uid}_{academicYear}_w{NN}_{platform}` (e.g. `abc123_2025-26_w15_teachers`).
**Fields:** `userId →users.uid`, `weekNumber`, `academicYear`, `platform`, `items{taskId: bool}`, `essentials{taskId: bool}`, `journalHtml`, `completedCount`, `totalCount`, `weekDate`, `schoolId →partner_schools.id` (set by some clients, not all), `updatedAt`.
**FKs:** `userId →users.uid`, optional `schoolId →partner_schools.id`.
**Writers:** owner only (rule enforces `request.resource.data.userId == auth.uid`).
**Read:**
- `get`: owner / `central_admin` / CH coordinator / same-school AH leadership (`school_principal` or `academic_coordinator`)
- `list`: `central_admin` / CH coordinator only
**Notes:** Per-week per-user — high doc count (800 teachers × ~40 weeks = ~32k). Dashboard reads scoped to last 30 days + `limit(2000)` (Step 1.6).

---

### 8. Appraisals & Walkthroughs

#### `school_appraisals_v2/{docId}`
**PK:** auto-id.
**Fields:** `schoolId →partner_schools.id`, `domains{1..5: {rating, evidence, strengths, improvements}}`, `review`, `recommendations`, `status`, `createdAt`.
**Writers:** `central_admin` (any field); AH admin / AH user with same `schoolId` (own school's ratings/evidence/strengths/improvements).
**Read:** any Central Hub or Academic Hub user.

#### `school_appraisals_archive_v1/{docId}` ✅ retired 2026-05-03
The legacy school-appraisals collection (pre-`_v2`) was retired. It held a single misplaced doc (`main_handbook`, a handbook record that belonged in `ease_system/main_handbook`); no client code read or wrote it. The doc was moved here as `school_appraisals_archive_v1/main_handbook` (with `__archivedAt` + `__archivedFrom` markers) for historical reference, and the source collection was dropped from Firestore + rules. **Read/write: central_admin only.** No new code should reference this; it's a tombstone. Migration script: `scripts/school-appraisals-cleanup/inspect-and-archive.js`.

#### `appraisal_cycles/{docId}`
**PK:** auto-id.
**Fields:** `name`, `startDate`, `endDate`, `status`, `createdAt`.
**Writers:** `central_admin`. **Read:** any signed-in user.

#### `teacher_appraisals/{docId}` (Formal Appraisal v2.0)
**PK:** auto-id.
**Fields:** `teacherUid →users.uid`, `appraiserUid →users.uid`, `schoolId →partner_schools.id`, `subject`, `teacherName` (denormalised), `domains{}`, `status` (`draft`/`shared`/`acknowledged`/`finalised`), `teacherResponse`, `disputed`, `disputeReason`, `disputedAt`, `disputeStatus`, `createdAt`, `updatedAt`.
**Writers:**
- create: AH admin or AH user with `school_principal`/`academic_coordinator`/`cambridge_coordinator` sub-role.
- update: appraiser (own records, sub-role gated); the teacher can flip status from `shared`→`acknowledged` or set dispute fields when `finalised`.
- delete: `central_admin`.

**Read:** `central_admin`, AH admin, TH admin, the teacher themselves, the appraiser themselves.

#### `teacher_self_appraisals/{docId}`
**PK:** `{uid}_{academicYear}` (e.g. `abc123_2025-26`).
**Fields:** `userId →users.uid`, `displayName` (denormalised), `domains{}`, `status` (`draft`/`submitted`), `createdAt`, `updatedAt`.
**Writers:** owner only (lock when `status === 'submitted'`); `central_admin` can delete.
**Read:**
- `get`: owner / admins / same-school AH evaluator (`school_principal`/`academic_coordinator`/`cambridge_coordinator` sub-role)
- `list`: admins only (no app code lists this collection — evaluators look up by deterministic doc ID)

#### `teacher_walkthroughs/{docId}` (Classroom Walkthrough v2.0)
**PK:** auto-id.
**Fields:** `teacherUid →users.uid`, `observerUid →users.uid`, `schoolId →partner_schools.id`, `notes`, `tags[]`, `createdAt`, `updatedAt`.
**Writers:** AH admin or AH user with appraiser sub-role; observer can update own; AH admin or `central_admin` can delete.
**Read:** the teacher, the observer, AH admin, TH admin, `central_admin`.

#### `calibration_sessions/{docId}` + `calibration_group_sessions/{sessionCode}`
Inter-rater reliability sessions for AH appraisers. PK uses `{uid}_{year}` for solo and 6-char codes for group sessions. Owner-write; same-school read or AH admin.

---

### 9. KPI System

A semi-overlapping family of collections — be careful when modifying.

#### `kpi_config/{kpiId}` and `kpi_settings/{semId}` (school-level KPI)
Criteria definitions and per-semester settings. AH admin write; AH user read.

#### `school_performance_kpi/{semId}/schools/{schoolId}` (subcollection)
**PK (parent):** `semId`. **PK (child):** `schoolId →partner_schools.id`.
**Read/Write:** AH admin, or `academic_user` whose `userProfile.schoolId` matches the doc's `{schoolId}` path segment.

#### `kpi_school_submissions/{submId}`
**PK:** auto-id.
**Fields:** `schoolId →partner_schools.id`, `semesterId`, payload, `status` (`pending`/`approved`/`rejected`/`under_review`).
**Writers:** AH admin OR AH user with matching `schoolId`. Status updates by `central_admin`.

#### `teacher_kpi_config/{kpiId}` and `teacher_kpi_settings/{periodId}`
Teacher KPI criteria definitions and evaluation periods.
**Fields on `teacher_kpi_config/{kpiId}`:** `aspect`, `indicator`, `weight`, `targetNumerical`, `unit`, `order`, `target`, `halfAY`, `fullAY`, `rationale`, `cambridge_standard_refs[]` (Track A — Cambridge Teacher Standards 2023 IDs e.g. `["3.6", "4.1"]`; validated against `competency_framework/teachers.cambridgeStandards` lookup at write time), `active`.
`central_admin` write; any authorised read.

#### `teacher_kpi_submissions/{submissionId}`
**PK:** `{uid}_{periodId}` (composite).
**Fields:** `userId →users.uid`, `email`, `schoolId →partner_schools.id` (REQUIRED on write), `periodId →teacher_kpi_settings.id`, `periodName`, `teacherInfo{...}`, `assessments{}`, `status`, `submittedAt`, `evaluatedAt`, `updatedAt`.
**FKs:** `userId → users`, `schoolId → partner_schools`, `periodId → teacher_kpi_settings`.
**Writers:** owner teacher (must include matching `schoolId`); AH evaluator can flip workflow fields only (`status`, `evaluatedAt`, `updatedAt`).
**Read:** owner / `central_admin` / TH admin / AH admin / same-school AH evaluator (`school_principal` or `academic_coordinator`).
**Indexes:** `(periodId, schoolId)` composite — REQUIRED by AH evaluator query.

#### `teacher_kpi_evaluations/{submissionId}`
**PK:** matches `teacher_kpi_submissions.id` (1:1).
**Fields:** `evaluatorInfo{evaluatorUid →users.uid}`, ratings, comments, `status`, `createdAt`, `updatedAt`.
**Writers:** AH admin or AH user with `school_principal`/`academic_coordinator` sub-role.
**Read:** the evaluator (own evals), `central_admin`, AH admin/user, TH admin, the teacher (own).

#### `kpi_meeting_proposals/{proposalId}`
**PK:** auto-id.
**Fields:** `submissionId →teacher_kpi_submissions.id`, `teacherUid →users.uid`, `evaluatorUid →users.uid`, `proposedDate`, `time`, `location`, `note`, `status` (`pending`/`confirmed`/`declined`), `respondedAt`, `respondedBy`.
**Writers:** AH admin or AH user with `school_principal`/`academic_coordinator` (create/update); teacher can update only `status`/`respondedAt`/`respondedBy`.

---

### 10. Activities Board (Central Hub kanban)

#### `activity_projects/{projectId}` + `activity_tasks/{taskId}` + `activity_groups/{docId}`
Kanban board. Tasks reference projects via `projectId →activity_projects.id`. Groups define assignee buckets. `central_admin` writes; any authorised user can read; tasks updatable by any authorised user (status changes).

**Index:** `activity_tasks(projectId, createdAt)`, `activity_projects(status, createdAt)`.

---

### 11. Competency Framework

#### `cambridge_crossref/index`
Single-doc aggregator (Phase 4). For every Cambridge Teacher Standards (2023) ID that any Eduversal artefact tags, lists every sibling item across KPI / Appraisal / Competency tracks.
**Fields:** `byStandard{id: {text, items[]}}`, `standardCount`, `totalRefs`, `generatedFrom{kpiCount, appraisalCount, competencyTracksScanned[]}`, `updatedAt`.
**Source:** Built by `scripts/competency/build-crossref-index.js` from `teacher_kpi_config.cambridge_standard_refs[]` + `Teachers Hub/resources/appraisal-framework-v2.json` F-items + `competency_framework/{trackId}.competencies[].cambridgeStandardRefs[]`. Re-run any time those source tags change.
**Writers:** `central_admin` only (Admin SDK). Read open to any authorised user.

#### `competency_framework/{trackId}`
**PK:** `trackId` (string slug — `'teachers'`, `'leaders'`, `'specialists'`).
**Fields:** `trackId`, `platform`, `audience`, `basis`, `sources{cambridgeTeacherStandards, permendiknas, ...}`, `levelOrder[]`, `levelLabels{}`, `levelDescriptors{}`, `domains[]`, `competencies[]` (each carries `id`, `domainId`, `name`, `levels[]`, `intent`, `cambridgeStandardRefs[]`, `cambridgeStandardTexts[]`, `permendiknasRefs[]`, `permendiknasTexts[]`), `cambridgeStandards{}`, `cambridgeAttributes[]`, `permendiknasPillars{}`, `updatedAt`.
**Source:** Verbatim Cambridge / Permendiknas text comes from `docs/research/cambridge/*.json` and `docs/research/permendiknas/*.json` — see `docs/research/README.md` for provenance and SHA-256 hashes. Seeded by `scripts/competency/seed-{th,ah,ch}-competency-framework.js`.
**Writers:** `central_admin` only (seeded via Admin SDK). Read open to any authorised user.

**Subcollection:** `competency_framework/{trackId}/levels/{compId}_{level}` — per-(competency, level) base learning-path content. Doc ID format `{compId}_{level}` e.g. `smc-1_awareness`, `evsi-1_practitioner`. Fields: `trackId`, `compId`, `level`, `reading` (long-form prose ~200-400 words), `keyTakeaways[]`, `selfAssessment[]` (5 self-rating statements), `activity{task, output, duration, evidence}`, `source` (pointer to seed source JSON), `updatedAt`. Lazy-fetched by learning-path pages on modal open. Admin overrides remain in `content_overrides_{teachers,academic}/{compId}_{lvl}` and are layered on top of this base. Seeded by `scripts/competency/seed-competency-content.js`.

#### `user_competencies/{uid}`
**PK:** `uid`.
**Fields:** `earned{compId: {level, date}}`, `matDone{matId: bool}` (TH); `earned_academic{}`, `matDone_academic{}` (AH).
**Writers:** owner only.

#### `competency_evidence/{evId}`
**PK:** auto-id.
**Fields:** `userId →users.uid`, `platform` (`'teachers'`/`'academic'`), `compId`, `compName`, `domain`, `level`, `description`, `fileUrl`, `fileName`, `status` (`pending`/`approved`/`rejected`), `reviewerNote`, `createdAt`, `updatedAt`.
**Subcollection:** `competency_evidence/{evId}/comments/{commentId}` — reviewer thread.
**Writers:** owner (create); `central_admin` (update status, reviewerNote).
**Read:** owner reads own; `central_admin` reads/lists all.

#### `competency_certificates/{certId}`
Issued certificates. `central_admin` create + delete; owner can read own.

#### `central_certificates/{certId}`
Workshop certificate records (separate from competency_certificates). `central_admin` write; any authorised read.

#### `framework_config/{docId}` + `content_overrides_academic/{docId}` + `content_overrides_teachers/{docId}`
Admin-edited reading text + sample document links for the appraisal framework. Doc ID format `{compId}_{lvl}` e.g. `evsi-1_awareness`. Read open; AH admin or TH admin write.

---

### 12. Configuration & Feature Flags

#### `page_access_config/{pageKey}`
**PK:** clean-URL slug (e.g. `school-performance-kpi`).
**Fields:** `pageKey`, `platform` (`'academichub'`), `label`, `visible_to[]` (sub-role values; empty = open to all), `description`, `updatedAt`.
**Writers:** `central_admin` only (via `/page-access` admin UI).
**Read:** any signed-in user (auth-guard reads on every navigation).
**Notes:** See monorepo CLAUDE.md "Page Access System" for full enforcement model.

#### `nav_config/{docId}`
**PK convention (mixed for historical reasons):**
- `nav_config/v1` — Central Hub. Predates the per-platform convention; in-place editor in `Central Hub/partials/navbar.html` writes here.
- `nav_config/academichub` — Academic Hub.
- `nav_config/teachershub` — Teachers Hub.

**Fields (CH `v1` shape):** keyed by panel id (`chDdPanel-schools` / `chDdPanel-ops` / `chDdPanel-academics`); each entry has `submenus[{key,label,col}]` and `items[{key,label,col,submenu}]`. Supports columns + nested submenu groups (Academics dropdown).

**Fields (AH / TH simple shape):**
- `platform` — same as doc id, redundant for query convenience
- `items[]` — array of `{ key, label, hidden }` ordered by array index:
  - `key` — slug matching `data-nav-key` in the navbar partial
  - `label` — display text (admin-editable)
  - `hidden` — if `true`, runtime hook hides the item; admin can untoggle
- `updatedAt` — serverTimestamp

**Writers:** `central_admin` (CH) or each hub's admin role from in-place editor on the hub's own navbar.
**Read:** any signed-in user. Each hub's navbar JS reads its own doc on auth-ready and applies label/order/hidden overrides to the static partial markup.
**Notes:**
- Item set is **not** admin-editable — adding a new item requires shipping a page + navbar partial update. Admins rename, reorder, and hide existing items.
- Sub-role / subject-specialty gating remains the source of truth for *who* sees an item; this collection only changes *how* the item is presented.
- AH/TH editor is intentionally simpler than CH's (no columns, no submenu groups) because their navbars are flat. CH retains the full column/submenu editor.

#### `sidebar_config/{docId}` — **Retired 2026-05-05**
Was the Central Hub `index.html` dashboard-sidebar order. Sidebar removed because the navbar already covers all navigation; no client reads or writes this collection anymore. Existing docs are inert; safe to ignore. Rules retained for backward read access until cleanup.

#### `ah_categories/{catId}` + `th_resource_sections/{secId}`
Dashboard category configuration. `visible_to[]` field filters to matching sub-roles. **Enforced at rule layer (Step 12, 2026-05-03)** — non-admin clients must run two `where()` queries (`visible_to == []` for open + `visible_to array-contains-any mySubRoles` for targeted) and merge results client-side. Admins use a single unfiltered listener. The rule rejects per-doc reads where neither branch matches, so devtools snooping can no longer enumerate gated category names.

#### `weekly_essentials/{platform}` (also under §7)
See above.

---

### 13. Orientation & Recruitment (public pages)

#### `orientation_resources/{docId}` + `orientation_questions/{docId}` + `orientation_registrations/{docId}`
Public handbook + competency quiz questions + recruitment form submissions. Read open to anyone (no auth); only `central_admin` can manage. `orientation_registrations` write open to anyone (form submission); only admin can read.

`orientation_questions/{docId}` fields: `question`, `options[]`, `order`, `createdAt`, **optional** `cambridge_standard_refs[]` (Cambridge Teacher Standards 2023 IDs, e.g. `["1.4", "3.1"]` — anchors the question to the same shared Cambridge framework used by KPI / Appraisal / Competency). Empty / missing = no anchor (back-compat).

`orientation_registrations/{docId}` fields: `firstName`, `lastName`, `email`, `school`, `subjects`, `levels[]`, `photoUrl?`, `quizAnswers{}`, `quizNotes{}`, **optional** `cambridge_familiarity` (1–5 Likert self-rating), `createdAt`.

#### `pathwaySubmissions/{docId}`
Cambridge Pathway Simulator public submissions. Anyone can create; `central_admin` reads/manages.

---

### 14. Audit / Analytics

#### `platform_usage/{docId}`
**PK:** auto-id.
**Fields:** `userId →users.uid`, `platform`, `role`, `ts`.
**Writers:** any signed-in user (own login event only).
**Read:** `central_admin` only.

#### `networkAudits/{auditId}`
**PK:** auto-id.
**Fields:** `testerUid →users.uid`, audit results, `createdAt`.
**Writers:** any authorised user (own audit). **Read:** owner or `central_admin`. **List:** `central_admin` only.

#### `teacher_contacts/{contactId}`
Unregistered teacher mailing list (external prospects). `central_admin` only.

#### `mail_campaigns/{campaignId}`
Newsletter campaign history. **Written by Railway mail service via Admin SDK** (bypasses rules); frontend only reads (`mail-composer.html`).

#### `mail_templates/{templateId}`
Reusable newsletter templates saved from `mail-composer.html` ("Save as Template" action). Fields: `name`, `subject`, `bodyHtml`, `createdAt`, `createdBy`. `central_admin` read/write.

---

### 15. Misc / Side-features

#### `school_visits/{visitId}` — Visit & Audit Management
`central_admin` write; CH user read.

#### `timeline_activities/{actId}` + `timeline_completions/{compId}`
AH Academic Calendar feature. Activities are admin-managed; completions are per-user. `userId →users.uid` on completions; user writes own.

#### `section_overrides/{sectionId}` + subcollection `subsections/{subId}`
Academic Standards inline edits. AH admin write.

#### `ease_system/{docId}`
EASE assessment configuration. `central_admin` write; any authorised read.

---

### 16. Induction Module (2026-05-04)

The 7 collections that implement the Eduversal Induction Charter (subject teacher / school principal / HQ subject specialist first-year journeys). Specification source: [`docs/induction/firestore-schema.json`](induction/firestore-schema.json) and [`docs/induction/INDUCTION_CHARTER.md`](induction/INDUCTION_CHARTER.md). Firestore rules in [`Central Hub/firestore.rules`](../Central Hub/firestore.rules) under "INDUCTION MODULE".

#### `induction_programs/{programId}` — Handbook templates
**PK:** stable slug — `handbook_subject_teacher_v2`, `eduversal_principal_v1`, `eduversal_specialist_v1`.
**Fields:** `handbookId`, `version`, `targetRole` (`'subject_teacher'`/`'school_principal'`/`'subject_specialist'`), `audience{platform, role, subRole}`, `duration{}`, `stages[]` (with nested tasks, observation cycles, deliverables), `linkedFrameworks{}` (Cambridge ICTL 5881, PIGP, SKL refs), `openItems[]`, `createdAt`, `updatedAt`.
**Writers:** `central_admin` (populated by `scripts/induction/seed-induction-programs.js` from the JSON handbooks).
**Read scope:** any signed-in user (mentees and mentors must read their program).
**Notes:** Source of truth is the JSON in [`docs/induction/handbook-*.json`](induction/). Firestore docs are populated by the seed script. Hand-edits in Firestore that diverge from the JSON are reverted on next seed run.

#### `induction_assignments/{menteeUid}` — Three-party induction record
**PK:** mentee `uid` (composite-style — one active induction per user).
**Fields:** `uid →users.uid`, `programId →induction_programs.handbookId`, `hireDate` (Timestamp), `mentorUid →users.uid`, `schoolLeaderUid →users.uid`, `schoolId →partner_schools.id`, `status` (`'pre_arrival'`/`'active'`/`'paused'`/`'completed'`/`'extended'`/`'withdrew'`), `currentStageId`, `agreementSignedByMentor`, `agreementSignedByMentee`, `extensionGrantedBy →users.uid`, `extensionEndDate`, `createdAt`, `startedAt`, `completedAt?`.
**FKs:** `users.uid`, `induction_programs.handbookId`, `partner_schools.id`.
**Writers:** `central_admin` only. Charter NN3+NN4 enforced at create: rule checks all three party uids are set AND `mentor_certifications/{mentorUid}_mentor_base.active == true`.
**Read scope:** owner (mentee), `mentorUid`, `schoolLeaderUid`, `central_admin`. List: `central_admin` only.
**Indexes:** `(schoolId ASC, status ASC)` for school-leader team-induction view. `(mentorUid ASC, status ASC)` for mentor my-mentees view. `(status ASC, hireDate ASC)` for HQ cohort dashboard.
**Notes:** Charter Non-Negotiable 4 — assignment cannot be created with any of mentee/mentor/schoolLeader missing. Status transitions follow a controlled state machine; see schema JSON.

#### `induction_progress/{uid}_{taskId}` — Per-task completion
**PK:** composite `{uid}_{taskId}`.
**Fields:** `uid →users.uid`, `programId →induction_programs.handbookId`, `stageId`, `taskId`, `completedAt?`, `completedBy →users.uid` (may differ from `uid`), `mentorSignedOffAt?`, `mentorUid?`, `schoolLeaderSignedOffAt?`, `schoolLeaderUid?`, `reflectionHtml?` (sanitised allowlist: P/BR/STRONG/EM/UL/OL/LI/H3/H4), `evidenceUrl?` (Firebase Storage path — see storage rules note below, ≤25 MB), `evidenceFileName?`, `createdAt`, `updatedAt`.
**FKs:** `users.uid`, `induction_programs.handbookId`.
**Writers:** owner (mentee) for self-owned tasks; mentor for mentor-owned; school leader for school-leader-owned. `central_admin` always.
**Read scope:** owner / mentor (via `isMentorOf(uid)`) / school leader (via `isInductionSchoolLeaderOf(uid)`) / `central_admin`. List: `central_admin`.
**Notes:** Doc only created when task is acted on; absence = not yet started. `mentorSignOffRequired = true` tasks require `mentorSignedOffAt` set; client UI gates this.

#### `induction_observations/{obsId}` — Stage 3 monthly + Q4 formal
**PK:** auto-id.
**Fields:** `menteeUid →users.uid`, `observerUid →users.uid`, `observerRole` (`'mentor'`/`'school_leader'`/`'specialist'`/`'specialist_mentor'`), `programId →induction_programs.handbookId`, `stageId`, `observationType` (`'co_teach'`/`'mentor_observes_mentee'`/`'mentee_observes_mentor'`/`'mentee_observes_other_teacher'`/`'formal_evaluation'`/`'specialist_walkthrough'`), `observationNumber` (month 2-9 for teacher cycle, walkthrough 1-10 for specialist), `observationDate`, `preObservationFocus`, `scored` (boolean — co-teach + mentee-observes types are unscored), `domainScores{planning, management, instruction, assessment}` (1-4, required iff `scored=true`), `overallRubricLevel` (`'unsatisfactory'`/`'basic'`/`'proficient'`/`'distinguished'`), `narrativeGlow`, `narrativeGrow`, `narrativeGo`, `actionPlan`, `menteeReflection?`, `createdAt`, `updatedAt`, `completedAt?` (set when observer marks write-up final; expected within 7 days per Charter).
**FKs:** `users.uid`, `induction_programs.handbookId`.
**Writers:** observer only (create + update until `completedAt` set).
**Read scope:** mentee, observer, mentor, school leader, `central_admin`. List: `central_admin` (clients filter by menteeUid or observerUid).
**Indexes:** `(menteeUid ASC, observationDate DESC)` for mentee history. `(observerUid ASC, observationDate DESC)` for own-authored. `(programId ASC, observationType ASC, completedAt DESC)` for HQ cycle telemetry.
**Notes:** Charter Non-Negotiable 1 — this collection NEVER feeds `teacher_appraisal_results`. There is no automatic propagation. Year-1 mentee data is induction-scope only.

#### `induction_journal/{uid}_{date}_{slot}` — Mentee's private reflections
**PK:** composite `{uid}_{date}_{slot}` where slot ∈ `'morning'|'evening'|'weekly'|'taskId-XXX'`.
**Fields:** `uid →users.uid`, `programId →induction_programs.handbookId`, `stageId`, `entryType` (`'daily_3_sentence'`/`'weekly_micro_reflection'`/`'monthly_conference_prep'`/`'task_reflection'`/`'stage_end_reflection'`), `entryDate`, `promptSet`, `responses{}` (keyed by prompt key), `visibility` (`'mentee_only'`/`'mentee_and_mentor'`/`'mentee_mentor_school_leader'`, default `'mentee_and_mentor'`), `createdAt`, `updatedAt`.
**FKs:** `users.uid`, `induction_programs.handbookId`.
**Writers:** owner (mentee) only.
**Read scope:** owner always; mentor if `visibility >= mentee_and_mentor`; school leader if `visibility == mentee_mentor_school_leader`; `central_admin` NEVER reads named entries (rule explicitly blocks). HQ uses `induction_journal_aggregates` instead.
**Notes:** Charter Non-Negotiable 2 — most-protected collection. No `list` allowed; mentor reads via specific gets only. Aggregate analysis via Cloud-Function-maintained `induction_journal_aggregates`.

#### `induction_pulses/{uid}_{isoWeek}` — Weekly mood pulse
**PK:** composite `{uid}_{isoWeekStart}`.
**Fields:** `uid →users.uid`, `programId →induction_programs.handbookId`, `schoolId →partner_schools.id`, `stageId`, `weekStartDate`, `score` (1-5: 1=very hard, 5=very good), `comment?`, `createdAt`.
**FKs:** `users.uid`, `induction_programs.handbookId`, `partner_schools.id`.
**Writers:** owner (mentee) only.
**Read scope:** owner / mentor / school leader. `central_admin` reads aggregated view only (rule routes named queries through Cloud Function that anonymises).
**Indexes:** `(uid ASC, weekStartDate DESC)` for mentee history. `(schoolId ASC, weekStartDate DESC)` for school-leader school pulse roll-up.
**Notes:** Two-consecutive-low-score alarm: a Cloud Function watches creates and on second-consecutive `score <= 2` sends notification to `mentorUid + schoolLeaderUid`. Mentee is informed in advance that this alarm exists (Charter Principle 1).

#### `mentor_certifications/{uid}_{certificationType}` — Mentor Certification ledger
**PK:** composite `{uid}_{certificationType}` where certificationType ∈ `'mentor_base'|'principal_mentor_endorsement'|'specialist_mentor_endorsement'`.
**Fields:** `uid →users.uid`, `certificationType`, `issuedAt`, `validUntil` (issuedAt + 24 months), `active` (false if revoked or expired — cron updates), `issuedBy →users.uid` (`central_admin`), `completionEvidence{date, score, notes}`, `createdAt`, `updatedAt`.
**FKs:** `users.uid`.
**Writers:** `central_admin` only.
**Read scope:** owner; `central_admin`; AH school leaders (to verify mentor candidates within their school). HQ Director (specialist mentor candidates).
**Indexes:** `(uid ASC, active ASC)` for fast certification check at assignment time. `(validUntil ASC, active ASC)` for expiry sweeper cron.
**Notes:** Charter Non-Negotiable 3 — the `induction_assignments` create rule reads this collection at assignment time. Without an active `_mentor_base` certification, no user can be assigned as mentor.

#### `induction_journal_aggregates/{programId}_{stageId}_{isoWeek}` — Anonymous HQ telemetry
**PK:** composite `{programId}_{stageId}_{isoWeek}`.
**Fields:** `programId →induction_programs.handbookId`, `stageId`, `isoWeek`, `totalMentees`, `menteesWithJournalEntryThisWeek`, `averageEntriesPerMentee`, `updatedAt`.
**FKs:** `induction_programs.handbookId`.
**Writers:** Cloud Function only (admin SDK bypasses rules).
**Read scope:** any authorised user (HQ telemetry — strictly no PII).
**Indexes:** `(programId ASC, isoWeek DESC)` for HQ dashboard.
**Notes:** Aggregator that satisfies HQ analytics needs without violating Charter Non-Negotiable 2 (no named journal reads at HQ).

#### `induction_alarms/{uid}_{weekStartDate}` — Two-week low-pulse alarms
**PK:** composite `{uid}_{weekStartDate}`.
**Fields:** `uid →users.uid` (mentee), `mentorUid →users.uid`, `schoolLeaderUid →users.uid`, `schoolId →partner_schools.id`, `weekStartDate`, `kind` (currently always `'two_consecutive_low_pulse'`), `currentScore`, `previousScore`, `acknowledged` (boolean — set true when mentor/school leader handles the alarm), `createdAt`.
**FKs:** `users.uid`, `partner_schools.id`.
**Writers:** Cloud Function only (`onPulseWritten`). Mentors / school leaders / admin can `update` to set `acknowledged: true`.
**Read scope:** mentee / mentor / school leader / `central_admin`.
**Notes:** Created by the `onPulseWritten` Cloud Function when a mentee records `score <= 2` two consecutive weeks. Read by `Academic Hub/TeamInduction.html` to surface alarm rows. Charter Principle 1 — alarms exist to enable intervention, not to surveil; mentee is informed in advance that the alarm system runs.

---

### 17. Principal Evaluation Module (2026-05-09 — Phase-2)

Annual / termly principal leadership evaluation. **Distinct from
induction_observations** (NN1) — that collection is year-1 mentee-scope
only and never feeds appraisal scoring. This module is the principal-
side annual cycle: observation → 360 → coaching → annual appraisal.

The first sub-collection (`principal_observations`) is wired in 2026-05;
the others (`principal_360_responses`, `principal_coaching_sessions`,
`principal_annual_appraisals`) ship as the matching UIs land.

#### `principal_observations/{obsId}` — 8-foci formative observation
**PK:** auto-id (`{principalUid}_{timestamp}`).
**Fields:** `principalUid →users.uid`, `schoolId →partner_schools.id`, `observerUid →users.uid`, `observerName`, `observerRole` (`'foundation_representative'`/`'academic_admin'`/`'central_admin'`), `visitDate`, `visitType` (`'scheduled_appraisal_visit'`/`'termly_check_in'`/`'follow_up_visit'`/`'thematic_review'`/`'joint_eduversal_yayasan_visit'`/`'pre_centre_readiness_visit'`), `foci{P1..P8: { code: 'E'|'D'|'N', notes: string }}`, `narratives{PNF1..PNF4: string}`, `rubricVersion`, `status` (`'draft'`/`'submitted'`), `updatedAt`, `submittedAt?`.
**FKs:** `users.uid`, `partner_schools.id`.
**Writers:** observer (`observerUid`) — create + update while `status != 'submitted'`. Submitted docs are immutable at the rule level. `central_admin` may delete.
**Read scope:** principal (own); observer (own); same-school AH leadership; `central_admin`.
**Notes:** No score is computed (`scoring: 'none_formative'` per the rubric JSON). This collection feeds the upcoming `principal_annual_appraisals` (Phase-2 G) — observer evidence summarised in F2 of that framework. Source rubric: `Academic Hub/resources/principal-observation-rubric.json` (v1.0, 8 foci × 55 evidence indicators × E/D/N).

#### `principal_annual_appraisals/{principalUid}_{academicYear}` — Annual leadership appraisal
**PK:** composite `{principalUid}_{academicYear}` (one appraisal per principal per year).
**Fields:** `principalUid →users.uid`, `schoolId →partner_schools.id`, `academicYear` (e.g. `'2025-2026'`), `appraiserUid →users.uid`, `appraiserName`, `appraiserRole` (`'foundation_representative'`/`'academic_admin'`/`'central_admin'`), `scores{itemId: 1-4}` keyed by framework item id (F1-1, F2-1, …, F_LEAD-1), `narratives{PNF1..PNF6: string}`, `composite` (1-4 weighted average), `compositePercent` (0-100, computed `(composite-1)/3*100`), `band` (A-F predicate), `frameworkVersion`, `status` (`'draft'`/`'submitted'`), `updatedAt`, `submittedAt?`.
**FKs:** `users.uid`, `partner_schools.id`.
**Writers:** appraiser (`appraiserUid`) — create + update while `status != 'submitted'`. Submitted is immutable. `central_admin` may delete.
**Read scope:** principal (own); appraiser (own); same-school AH leadership; `central_admin`.
**Notes:** Source framework: `Academic Hub/resources/principal-appraisal-framework-v1.json` (v1.0, F1-F5 + F_LEAD with weighted composite). Composite + band auto-computed client-side and persisted; the inputs (per-item scores) remain authoritative.

#### `principal_coaching_sessions/{principalUid}_{YYYY-MM-DD}` — Coaching session log
**PK:** composite `{principalUid}_{YYYY-MM-DD}`.
**Fields:** `principalUid →users.uid` (coachee), `mentorUid →users.uid` (HQ Director), `mentorName`, `schoolId →partner_schools.id`, `sessionDate`, `mode` (`'year_1_induction'`/`'year_2_plus'`), `agenda{1_check_in: { notes }, 2_review_commitments: { commitment, outcome, outcome_reason }, 3_focus_topic: { notes }, 4_strategic_horizon: { notes }, 5_close_and_log: { notes }}`, `newCommitments[{ text, dueWeek }]`, `mentorReflection`, `status` (`'draft'`/`'logged'`), `updatedAt`, `loggedAt?`.
**FKs:** `users.uid`, `partner_schools.id`.
**Writers:** mentor (`mentorUid`) — must hold `ch_sub_roles.director` OR be `central_admin`. Update allowed until `status='logged'` (then immutable).
**Read scope:** coachee (own); mentor (own); `central_admin`. **Foundation Reps explicitly EXCLUDED** to preserve coaching confidentiality (per framework `data_model.access_control`).
**Notes:** Source framework: `docs/cross-module/principal-coaching-framework-v1.json`. Stage `1_check_in` is the personal check-in — UI surfaces it with a private treatment but rule-level access is the same as the rest of the doc; the privacy is operational ("HQ won't audit this stage") not technical. Audit access for `central_admin` is by design.

#### `principal_360_cycles/{cycleId}` — Survey window
**PK:** auto-id or `{principalUid}_{academicYear}_{window}` (W17 / W38).
**Fields:** `principalUid →users.uid`, `schoolId →partner_schools.id`, `academicYear`, `window` (`'W17'`/`'W38'`/`'mid_year'`/`'end_year'`), `status` (`'planned'`/`'open'`/`'closed'`), `openedAt?`, `closedAt?`, `eligibleCohorts[]` (`['staff','parent','student']`), `inviteToken?` (random — used in survey link), `createdAt`.
**FKs:** `users.uid`, `partner_schools.id`.
**Writers:** `central_admin` only (cycle launch is governed).
**Read scope:** any signed-in user (so respondents can verify cycle is open).
**Notes:** Source framework: `docs/cross-module/principal-360-framework-v1.json`. NN5: status='open' is the only state in which `principal_360_responses` accepts new docs (rule reads cycles to gate respond writes).

#### `principal_360_responses/{respId}` — Anonymous individual response
**PK:** auto-id.
**Fields:** `cycleId →principal_360_cycles.id`, `principalUid →users.uid` (denormalised for queries), `schoolId →partner_schools.id`, `cohort` (`'staff'`/`'parent'`/`'student'`), `responses{questionId: 0-4}`, `narratives{nfId: string}`, `submittedAt`. **Notably absent:** any field identifying the respondent.
**FKs:** `principal_360_cycles.id`, `users.uid`, `partner_schools.id`.
**Writers:** any signed-in user (create only). No update/delete except admin.
**Read scope:** **`central_admin` only** (forensic). `list` is rule-blocked — even admin lists go through aggregator. Charter NN5.
**Notes:** No respondent uid persisted. Idempotency hint via client-side `localStorage[360responded:cycleId:uid]` — Cloud Function-side dedup TBD. Cloud Function `aggregatePrincipal360Responses` (planned) reads this collection on every write and updates the corresponding `principal_360_aggregates` doc.

#### `principal_360_aggregates/{cycleId}` — Computed summary
**PK:** same as cycleId (`{principalUid}_{academicYear}_{window}`).
**Fields:** `cycleId`, `principalUid →users.uid`, `schoolId →partner_schools.id`, `cohortStats{cohortId: { respondentCount, perFocusMean{P1..P8: 0-4}, narrativesCount }}`, `composite{F3_360_score: 0-4}` (weighted across cohorts per framework), `aboveThreshold{cohortId: bool}` (true iff respondentCount >= min_respondents_to_report), `lastAggregatedAt`.
**FKs:** `users.uid`, `partner_schools.id`.
**Writers:** Cloud Function only.
**Read scope:** principal (own); same-school AH leadership; `central_admin`. NEVER exposed when below threshold.
**Notes:** This is the only collection a human reads for 360 results. NN5 enforced: `aboveThreshold[c] === false` → cohort hidden in UI.

---

### 18. Careers + Interview Module (2026-05-04)

Public teacher recruitment + structured interview scoring. Lives in Teachers Hub `/careers` (public) and `/careers-admin` + `/interview-scorecard` (auth'd). Backed by 6 Firestore collections + 1 mail-extension queue. Two new `th_sub_roles` values: `interviewer` and `hiring_manager`.

#### `job_positions/{positionId}` — Open vacancies
**PK:** auto-id.
**Fields:** `title`, `schoolId →partner_schools.id`, `schoolName`, `subjects[]`, `gradeLevel` (`'primary' | 'secondary' | 'igcse' | 'asalevel'`), `mode` (`'in_person' | 'online' | 'hybrid'`), `meetingUrl`, `questionSetId →interview_question_sets.setId`, `status` (`'draft' | 'open' | 'closed'`), `description`, `requirements`, `applicationDeadline` (ISO date), `createdBy`, `createdAt`, `updatedAt`.
**FKs:** `partner_schools.id`, `interview_question_sets.setId`.
**Writers:** `central_admin`, `teachers_admin`, or `hiring_manager` for own school.
**Read scope:** **public** for `status:'open'` docs (no auth required); admin / hiring power for drafts.
**Notes:** Public read enables the unauthenticated `/careers` listing page. Drafts hidden from public. Position cards link to `/careers-apply?position=<id>`.

#### `interview_question_sets/{setId}` — Question + rubric bundle
**PK:** stable slug (e.g. `'primary-default-v1'`).
**Fields:** `name`, `version`, `language`, `scoreScale: {min, max}`, `passingAverage`, `categories[{id, name, weight}]`, `questions[{id, categoryId, text, hasRubric, rubricRef, orderIndex}]`, `rubrics{ <ref>: {name, levels[{score, label, description}]} }`.
**Writers:** `central_admin` / `teachers_admin` (via seed scripts under `scripts/careers/`).
**Read scope:** any signed-in user (interviewers + admin).
**Notes:** First seed `primary-default-v1` derived from CSV: 18 questions × 4 categories (Strong English / Commitment to Stay / Classroom Management / Scenario), 1-5 scale, 3 rubrics (Scenario uses flag chips, no rubric). Edit via JSON source-of-truth at `scripts/careers/primary-default-questions.json`.

#### `job_applications/{applicationId}` — Candidate submissions
**PK:** auto-id.
**Fields:** `positionId →job_positions.id`, `positionTitle` (denorm), `schoolId →partner_schools.id` (denorm), `schoolName` (denorm), `applicantEmail` (lowercase), `applicantToken` (32-byte hex secret), `applicant{firstName, lastName, phone, citizenship, currentLocation, willingToRelocate, yearsExperience, highestQualification, institution, languages[], references[], motivationLetter, cvUrl, cvFilename, cvSize}`, `status` (`'submitted' | 'under_review' | 'shortlisted' | 'interview_scheduled' | 'interview_done' | 'offered' | 'hired' | 'rejected' | 'withdrew'`), `rejectionReason`, `interviewSchedule{scheduledAt, mode, meetingUrl, interviewerUids[], completedAt}`, `scorecard{averageScore, totalSubmittedScorecards, meetsCriteria, perCategoryAverage{}}` (server-aggregated denorm), `finalDecision{outcome, decidedBy, decidedAt, note}`, `source` (always `'careers'`), `ipAddressHash`, `createdAt`, `updatedAt`.
**FKs:** `job_positions.id`, `partner_schools.id`, `users.uid` (in `interviewSchedule.interviewerUids`).
**Writers:**
- **Public create** (unauth) — required keys + email-shape validated by rule. Status forced to `'submitted'`.
- **Admin / hiring_manager (own school) update** — all fields.
- **Applicant update** — `status` only, value must be `'withdrew'` (Firebase Auth verified email match).
**Read scope:** admin / `teachers_admin` / `hiring_manager` (own school) / `interviewer` (assigned only) / applicant (own — Firebase Auth verified email match).
**Notes:** CV stored at Storage path `careers/cv/{positionId}/{timestamp}_{filename}` (≤10 MB; PDF/DOC/DOCX). After submit, the apply form sends a Firebase Auth email-link (magic-link) so the applicant can return to `/careers-status` to track their application.

#### `interview_scorecards/{applicationId}_{interviewerUid}` — Per-interviewer scoring
**PK:** composite `{applicationId}_{interviewerUid}`.
**Fields:** `applicationId →job_applications.id`, `positionId →job_positions.id`, `interviewerUid →users.uid`, `interviewerName`, `schoolId →partner_schools.id` (denorm), `questionSetId →interview_question_sets.setId`, `questionSetVersion`, `scores{q1..q18: 1..5}`, `notes{q1..q18: string}`, `scenarioFlags{q16..q18: 'strong' | 'acceptable' | 'concerning'}`, `totalScore`, `averageScore`, `meetsCriteria`, `recommendation` (`'strong_yes' | 'yes' | 'no' | 'strong_no'`), `status` (`'draft' | 'submitted'`), `startedAt`, `lastSavedAt`, `submittedAt`.
**FKs:** `job_applications.id`, `job_positions.id`, `users.uid`, `partner_schools.id`, `interview_question_sets.setId`.
**Writers:** the scoring `interviewer` themselves only (uid match enforced). Drafts mutable; **submitted docs are immutable** (rule blocks all field changes once `status:'submitted'`).
**Read scope:** admin / `teachers_admin` / `hiring_manager` (same school) / scoring interviewer (own).
**Indexes:** `(applicationId, status)` for `/careers-admin` candidate drawer; `(interviewerUid, status)` for interviewer's own list.
**Notes:** N interviewers per application — final candidate score is the average of submitted scorecards (denormalised onto `job_applications.scorecard`). Composite key prevents duplicate scoring by the same interviewer.

#### `job_application_audit/{auditId}` — Append-only event log
**PK:** auto-id.
**Fields:** `applicationId →job_applications.id`, `action` (`'status_changed' | 'interviewer_assigned' | 'interview_scheduled' | 'decision_recorded'`), `byUid →users.uid`, `byEmail`, `before`, `after`, `at`.
**FKs:** `job_applications.id`, `users.uid`.
**Writers:** any signed-in user with hiring power (admin / `teachers_admin` / `hiring_manager`). Append-only — no updates or deletes.
**Read scope:** admin / `teachers_admin` / `hiring_manager`.
**Notes:** Required for legal retention (Indonesia PDP) — every status change must be traceable. Read from `/careers-admin` drawer's Activity tab.

#### `mail/{mailId}` — Firebase Trigger Email queue
**PK:** auto-id.
**Fields:** `to`, `message{subject, html, text}`, `attachments[]`, plus `delivery{...}` written by the extension.
**Writers:** any user (including unauth) can create — required by the public apply form to enqueue the "application received" magic-link mail; rule trusts that abuse is bounded by Storage size limits and reCAPTCHA at the form. Admin reads the queue. Extension (server) updates `delivery`.
**Read scope:** `central_admin`.
**Notes:** This is the [Trigger Email from Firestore](https://firebase.google.com/products/extensions/firestore-send-email) extension — the project does not write its own email-sending Cloud Function. Templates live inline in `partials/careers-shared.js` (M4). Used for: (1) "application received" + magic-link, (2) interview scheduled, (3) decision: offered, (4) decision: rejected.

---

## Indexes (composite)

Single-field indexes are auto-created by Firestore. Composites must be declared in `Central Hub/firestore.indexes.json`.

| Collection | Fields | Used by |
|---|---|---|
| `activity_tasks` | `projectId ASC, createdAt ASC` | `activities.html` per-project task list |
| `activity_projects` | `status ASC, createdAt ASC` | `activities.html` filtered project list |
| `topics` | `status ASC, createdAt DESC` | message board active topics |
| `teacher_kpi_submissions` | `periodId ASC, schoolId ASC` | AH evaluator query (`teacher-kpi-evaluation.html`) |
| `classes` (subcollection) | `grade ASC, section ASC` | TH pacing class list |
| `competency_certificates` | `platform ASC, userId ASC, issuedAt DESC` | MyCertificates queries |
| `competency_evidence` | `platform ASC, userId ASC, createdAt DESC` | MyPortfolio queries |
| `teacher_appraisals` | `appraiserUid ASC, createdAt DESC` | MyObservations |
| `teacher_appraisals` | `appraiserUid ASC, teacherUid ASC, createdAt DESC` | (legacy — auto-created) |
| `teacher_appraisals` | `teacherUid ASC, academicYear ASC` | TeacherAppraisalEntry lookup |
| `teacher_appraisals` | `teacherUid ASC, academicYear ASC, f2Status ASC` | TeacherAppraisalEntry F2 lookup |
| `teacher_kpi_config` | `active ASC, order ASC` | KPI admin enabled-criteria list |
| `teacher_walkthroughs` | `academicYear ASC, teacherUid ASC, visitDate DESC` | walkthrough history per teacher |
| `teacher_walkthroughs` | `observerUid ASC, createdAt DESC` | MyObservations |
| `users` | `role_teachershub ASC, displayName ASC` | console + appraisal teacher search |
| `partner_schools` | `status ASC, name ASC` | reports filtered active-school list |
| `surveys` | `status ASC, createdAt DESC` | surveys list (published only) |
| `school_appraisals_v2` | `schoolId ASC, academicYear ASC` | SchoolSelfAppraisal lookup |
| `induction_assignments` | `schoolId ASC, status ASC` | Academic Hub team-induction view |
| `induction_assignments` | `mentorUid ASC, status ASC` | Teachers Hub my-mentees view |
| `induction_assignments` | `status ASC, hireDate ASC` | HQ cohort completion dashboard |
| `induction_observations` | `menteeUid ASC, observationDate DESC` | mentee observation history |
| `induction_observations` | `observerUid ASC, observationDate DESC` | observer's own observations |
| `induction_observations` | `programId ASC, observationType ASC, completedAt DESC` | HQ cycle telemetry |
| `induction_progress` | `uid ASC, stageId ASC` | mentee my-induction by-stage view |
| `induction_progress` | `programId ASC, stageId ASC` | HQ stage completion analytics |
| `induction_pulses` | `uid ASC, weekStartDate DESC` | mentee pulse history |
| `induction_pulses` | `schoolId ASC, weekStartDate DESC` | school pulse roll-up |
| `mentor_certifications` | `uid ASC, active ASC` | fast certification check at assignment time |
| `mentor_certifications` | `validUntil ASC, active ASC` | expiry sweeper cron |
| `induction_journal_aggregates` | `programId ASC, isoWeek DESC` | HQ journal-engagement dashboard |

All indexes are tracked in `Central Hub/firestore.indexes.json` and deployed via `firebase deploy --only firestore:indexes`. The local file is the **single source of truth** — `firebase deploy --force` will delete any index not present in the local file.

---

## FK Graph (text)

A condensed reference of which docs point at which. Read as `child.field → parent`.

```
users
 └─ schoolId → partner_schools

partner_schools
 └─ classes/* → (subcollection)

userProgress              (id = uid)         .schoolId → partner_schools
weekly_progress           .userId → users    .schoolId → partner_schools (sometimes)
teacher_kpi_submissions   .userId → users    .schoolId → partner_schools    .periodId → teacher_kpi_settings
teacher_kpi_evaluations   (id matches teacher_kpi_submissions.id; .evaluatorInfo.evaluatorUid → users)
teacher_self_appraisals   .userId → users
teacher_appraisals        .teacherUid → users  .appraiserUid → users  .schoolId → partner_schools
teacher_walkthroughs      .teacherUid → users  .observerUid  → users  .schoolId → partner_schools
school_appraisals_v2      .schoolId → partner_schools
school_performance_kpi/{semId}/schools/{schoolId}   .schoolId → partner_schools (path)
kpi_school_submissions    .schoolId → partner_schools
kpi_meeting_proposals     .submissionId → teacher_kpi_submissions  .teacherUid → users  .evaluatorUid → users
school_events             .schoolId → partner_schools  .createdBy → users
calibration_sessions      .userId → users
activity_tasks            .projectId → activity_projects
announcement_reads        .annId → announcements  .userId → users
doc_likes / doc_ratings   .userId → users  .docId → documents
survey_responses          .userId → users  .surveyId → surveys
timeline_completions      .userId → users  .activityId → timeline_activities
platform_usage            .userId → users
networkAudits             .testerUid → users  .schoolId → partner_schools (sometimes)
staff                     .schoolId → partner_schools  (.school is denormalised display name)
competency_evidence       .userId → users
competency_certificates   .userId → users
user_competencies         (id = uid)
topics + replies + comments  .authorUid → users
```

---

## Standardisation Backlog

Things this schema knows are inconsistent. Prioritise these in upcoming refactors.

### FK naming
✅ **Standardised on 2026-05-03 (Step 7).** Convention is documented in the Naming table above. The migration affected:

- 4 collections renamed `uid` field → `userId` (data + rules + client code): `weekly_progress`, `teacher_kpi_submissions`, `teacher_self_appraisals`, `platform_usage` (~3427 docs total).
- `competency_evidence`, `competency_certificates`, `calibration_sessions` (empty in production) — rules + future client writes use `userId`.
- `topics` + `topics/{id}/replies` + `competency_evidence/{id}/comments` — author field standardised to `authorUid`.
- `staff.school` text → added `staff.schoolId` FK (display `school` text retained as denormalised name).
- `teacher_appraisals.schoolId` — 1 broken doc remapped, 3 "asd" junk docs left for manual cleanup in Firestore Console.
- `networkAudits.schoolId` — added FK where the free-text `school` matched a partner school name; 7 junk values ("Alif Home" etc.) left as-is.

### Duplicate / overlapping collections
| Pair | Issue |
|---|---|
| ~~`feedback` + `feedbacks`~~ | ✅ **Consolidated 2026-05-03.** All hubs now write to `feedbacks` with `__src` discriminator; old `feedback` rule removed; data migrated by `scripts/feedback-merge/merge-feedback-into-feedbacks.js`. |
| ~~legacy school appraisals collection~~ | ✅ **Retired 2026-05-03.** The legacy collection (pre-`_v2`) had a single misplaced doc (a handbook); archived to `school_appraisals_archive_v1` and source deleted. Only `school_appraisals_v2` remains in active use. |
| `central_documents` + `documents` | Different purposes (HQ docs vs. AH docs) but the name overlap is confusing — consider renaming `documents` to `academic_documents`. |
| `competency_certificates` + `central_certificates` | Different purposes; names invite confusion. |

### Missing required fields
| Collection | Field | Why |
|---|---|---|
| ~~`weekly_progress` `schoolId`~~ | ✅ **Standardised 2026-05-03.** All 9 client writers (CH/AH/TH `weekly-checklist.html`, three writers each) now stamp `schoolId: window.userProfile?.schoolId \|\| null` on every save. CH HQ users write `null` (they have no school); AH/TH users write their `partner_schools` doc id. The `isAHUserAtSameSchool(userId)` helper in firestore.rules can now read `resource.data.schoolId` directly when present, saving an extra `get()`. |
| ~~`staff` `schoolId`~~ | ✅ **Fixed 2026-05-03.** UI dropdown now uses `partner_schools.id` as the option value; saves write both `schoolId` (FK) and `school` (denormalised display name). Edit form falls back to a name lookup for legacy docs without `schoolId`. |

### Denormalisation refresh policy
- `teacherName`, `displayName`, `schoolName` are denormalised on appraisal docs and progress docs. Today nothing refreshes them when the source changes. Add an admin tool or Cloud Function to re-stamp these when a user/school is renamed.

### Sub-collection candidates
Some top-level collections logically belong as subcollections:
- `activity_tasks/{taskId}` could become `activity_projects/{id}/tasks/{taskId}` — clearer ownership, simpler rules, automatic cascading delete.
- `timeline_completions/{compId}` could become `timeline_activities/{id}/completions/{uid}`.

These are **not blocking** — defer until a real reason to refactor.

---

## How to use this document

- **Adding a collection?** Add a card in the right domain section here BEFORE writing the Firestore rule. Include the FK arrows so the next reader knows what links where.
- **Renaming a field?** Update this doc + every CLAUDE.md that mentions the field + the rule + any seed scripts. Push as one commit so the docs and code don't drift.
- **Writing a rule?** Cross-check the "Read scope" section here to make sure the rule matches the documented intent. If you're tightening, update both.
- **Confused about a relationship?** Look at the FK Graph at the bottom; the docs above tell you the field-level detail.

---

_Last sync with rules: 2026-05-03 — `Central Hub/firestore.rules`_
