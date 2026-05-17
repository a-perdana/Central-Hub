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

#### `students/{uid}`
**PK:** Firebase Auth UID (Google SSO). Owned by **Students Hub**.
**Fields:** `uid`, `email`, `emailLower` (lookup key), `displayName`, `photoURL`, `schoolId →partner_schools.id` (nullable until class picker resolves), `school` (denormalised), `classId →partner_schools/{id}/classes/{classId}` (nullable until class picker), `className` (denormalised), `gradeLevel` (number), `status` (`'needs_class'` | `'pending_approval'` | `'active'` | `'rejected'` | `'graduated'`), `is_hq_observer` (bool, optional — when `true` the SH runners reveal the HQ Observer Strip so the student can flag bad questions; set by `central_admin` via Firebase Console for pilot QA), `createdAt`, `classPickedAt`, `approvedAt`, `approvedBy →users.uid`, `lastLoginAt`.
**FKs:** `schoolId → partner_schools.id` · `classId → partner_schools/{id}/classes/{classId}` · `approvedBy → users.uid` (the teacher / admin who approved).
**Writers:**
- Self-CREATE on first Google SSO. Rule pins `uid == auth.uid`, `emailLower == lowercase(token.email)`, `status == 'needs_class'` so a student can't bootstrap themselves to `active` or impersonate another uid.
- Self-UPDATE in two narrow envelopes: (1) class picker transition `needs_class → pending_approval` (affected keys ⊂ `{schoolId, school, classId, className, gradeLevel, status, classPickedAt}`); (2) login touch (affected keys ⊂ `{lastLoginAt, displayName, photoURL}`).
- Admin / TH admin / AH admin can update freely (used for `pending_approval → active|rejected` and `active → graduated`).
**Read:** owner (self) · `central_admin` · `academic_admin` · `teachers_admin` · same-school AH leadership (`school_principal` / `academic_coordinator` / `cambridge_coordinator`) for AH `/student-roster` · same-school TH staff (`subject_teacher` / `subject_leader`) for TH `/student-approvals` and per-class views. `list` gates on role+sub-role only and trusts the client query's `where('schoolId','==',ownSchool)` filter (same trust-the-filter pattern as `chapter_test_attempts.list`); `get` enforces the same-school constraint per-doc.
**Indexes:** none yet.
**Notes:**
- **Distinct from `users/{uid}`** — students are NOT tracked in `users/{uid}` and do not have any `role_*hub` / sub-role / approval fields. Hub selection is the discriminator: a person who signs into `studentshub.eduversal.org` becomes a student; same email signing into `teachershub.eduversal.org` follows the staff path. Both records can co-exist for hybrid edge cases without conflict.
- **Domain whitelist is runtime-derived** from `partner_schools.domain`. Students Hub `auth-guard.js` queries `partner_schools where domain == emailDomain limit 2` at sign-in; 0 matches → reject, 1 → schoolId pre-filled, 2+ → multi-school domain (the picker shows a school step first).
- **Class picker filter** (`Students Hub/class-picker.html`): `ALLOWED_GRADES = [7, 8]` for the Grade-7-8 pilot. Bump when expanding.
- **Trust-but-verify enrolment** — a student's class pick lands them in `pending_approval`, not `active`. A class teacher confirms membership via TH (Phase 1.5 `/student-approvals` page; Phase 1 stopgap = direct Firestore Console flip).
- **No deletion at end of year** — `status='graduated'` preserves growth history. Hard-delete only via admin Cloud Function on explicit school request.

#### `user_notes/{noteId}`
**PK:** auto-id. Personal post-it / notepad scratch space.
**Fields:** `userId →users.uid` (owner; pinned by rule on create), `userDisplayName` (denormalised for public listings), `title` (≤120 chars), `body` (≤4000 chars), `color` (`'yellow'`|`'pink'`|`'green'`|`'blue'`|`'violet'`|`'orange'`), `pinned` (bool, default false), `done` (bool, default false), `isPublic` (bool, default false), `attachments[]` (array of `{ name, url, size, contentType, path, addedAt }`), `createdAt`, `updatedAt`. Step-3 link fields (planned): `schoolId →partner_schools.id` (nullable), `linkedUserId →users.uid` (nullable), `tags[]`.
**FKs:** `userId → users.uid`.
**Writers:** owner only — create requires `userId == auth.uid`; update/delete requires `resource.data.userId == auth.uid`. No admin override.
**Read:** owner reads own (any visibility). When `isPublic == true`, every authorised CH user can read (HQ-wide "Team Notes"). Edit/delete/upload always stay owner-only — public is read-only sharing.
**Indexes:** composite `(userId asc, pinned desc, done asc, updatedAt desc)` — owner widget query; composite `(isPublic asc, updatedAt desc)` — Team Notes feed. Both deployed 2026-05-12.
**Storage:** attachments live at `user_notes/{uid}/{noteId}/{ts}_{filename}` (≤10 MB per file). Storage rule: any signed-in user can read (file URLs are surfaced only via the rule-gated Firestore note doc); only the owning uid can write/delete.
**Notes:**
- Step 1 (2026-05-12): Dashboard widget on CH `index.html` — top notes, inline contentEditable title + body, colour swatch, hover delete (3-second double-click confirm — never `confirm()`), done toggle (dim + strikethrough + bottom-sorted), private/public chip, multi-file attachments (10 MB each).
- Step 2 (planned): `/notes` full page with markdown, search, archive view.
- Step 3 (planned): optional `schoolId` / `linkedUserId` link + per-school view from `schools.html`.

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
**PK:** stable slug — `handbook_subject_teacher_v2`, `eduversal_principal_v1`, `eduversal_specialist_v1`, `eduversal_director_first_90_days_v1`, `eduversal_student_handbook_v1`, etc.
**Fields:** `handbookId`, `handbookKind` (discriminator — see below), `version`, `targetRole` (where applicable), `audience{platform, role, subRole, primaryReader}`, `duration{}` (induction + role-operational kinds), `stages[]` OR `sections[]` (induction + role-operational use `stages[]` for time-windowed phases; school-facing uses `sections[]` for topic chapters), `linkedFrameworks{}`, `openItems[]`, `customizationModel`, `internationalAnchorsSummary[]`, `indonesianAnchorsSummary[]`, `createdAt`, `updatedAt`.
**`handbookKind` enum** — three values:
- `'induction'` — Year-1 mentee journey (subject teacher, principal, specialist). Charter NN1-NN5 bound. Source: [`docs/induction/handbook-*.json`](induction/).
- `'role-operational'` — Specialist role 90-day onboarding (DSL, Cambridge Coordinator, Academic Coordinator, Subject Leader, Director, Subject Specialist, Foundation Rep). Pairs with weekly checklists. Source: [`docs/handbooks/*-first-90-days-v1.json`](handbooks/).
- `'school-facing'` — Partner-school audience documents (Student / Teacher / Parent Handbook + Staff Code of Conduct). Network-uniform core + hybrid school customization slots. Source: [`docs/handbooks/school-facing/*.json`](handbooks/school-facing/).
**Writers:** `central_admin` (populated by `scripts/induction/seed-induction-programs.js` from the JSON handbooks).
**Read scope:** any signed-in user (mentees and mentors must read their program; school-facing docs are read by every audience: students via SH, teachers via TH, parents via portal links, staff via CH/AH/TH).
**Notes:** Source of truth is always the JSON in `docs/`. Firestore docs are populated by the seed script. Hand-edits in Firestore that diverge from the JSON are reverted on next seed run. `stages[]` and `sections[]` are functionally equivalent for reader rendering — both contain ordered content blocks; the reader checks which is present and renders accordingly.

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

### 19. Chapter Tests + Sessions (Students Hub assessment delivery, 2026-05-10)

The student-side delivery system. Chapter tests are network-uniform mastery checks authored by HQ Subject Specialists; sessions schedule them for one class at a time; attempts are per-student records that flow from `draft → in_progress → submitted/scored`. EASE Growth (adaptive cross-grade) catalogued at the bottom of this section as part of Phase 2 (2026-05-10).

#### `chapter_tests/{testId}`
**PK:** Slugged composite `{subjectId}_{stage}_{unitCode}_v{version}` (e.g. `math_7_7ni-04_v1`). Lowercased, non-alphanumeric → `-`.
**Fields:** `subjectId`, `stage` (Year number 7..12 — field name historical, UI labels it "Year" since Eduversal partner schools are Indonesian; "Stage" terminology only relevant inside Cambridge syllabus references), `unitCode`, `unitTitle`, `version` (default 1), `description`, `durationMin` (default 30), `passThresholdPct` (default 60), `itemCount`, `totalMarks`, `itemIds[]` (ordered string array → `chapter_test_items.id`), `status` (`'draft' | 'published' | 'archived'`), `authorUid →users.uid`, `createdAt`, `updatedAt`.
**Subcollections:**
- `chapter_tests/{testId}/items/{itemId}` — **DEPRECATED 2026-05-11**. Pre-migration items still live here for rollback safety; new tests write item refs into `itemIds[]` and item content into top-level `chapter_test_items`. Subcollection rule kept allow-all for reads; will be dropped once readers complete the cutover.

**FKs:** `authorUid → users.uid` · `itemIds[] → chapter_test_items.id`. The `unitCode` informally references `*_pacing` collection units but is not an enforced FK — Specialists type the code freehand.
**Writers:** `central_admin` and `central_user` with `coordinator` sub-role (CH `chapter-test-author.html`).
**Read scope:**
- `get`/`list` for any authorised staff (CH/AH/TH browse + scheduling).
- `get` for **active students** when `status == 'published'` — needed by the test runner to load the test definition for an attempt the student owns.
- Items: see `chapter_test_items` rule (same active-student `get`/`list` scope).
**Notes:**
- Network-uniform: every partner school's students take the same items. Version bump (`v2`) is recommended over in-place edits once a test has live attempts.
- Subject specialty filter is applied client-side via `ch_subjects[]`; rules don't gate on subject (kept simple — admin/coordinator can author across subjects if needed).

---

#### `chapter_test_items/{itemId}`
**PK:** Auto-id (preserved across migration so existing `chapter_test_attempts.responses` keys stay valid).
**Fields:** `subjectId`, `stage` (7..12), `unitCode`, `unitTitle`, `type` (`'mcq' | 'numeric' | 'short'`), `stem` (markdown + LaTeX), `stemImagePath` (Storage path, optional — kept for back-compat; canonical lookup is `diagramId → chapter_test_diagrams.storagePath`), `stemImageBucket` (bucket host — only set when image lives in a non-default bucket. Added 2026-05-12 with the IGCSE biology migration; cleared on items linked to a `chapter_test_diagrams` doc since the binary then lives in the CH bucket.), `diagramId` (→ `chapter_test_diagrams.id` — set when the item references a pooled reusable diagram. The reverse index lives on the diagram doc as `usedInItemIds[]`. Added 2026-05-12.), `diagramPlacement` (`'after' | 'before' | 'inline'`, default `'after'` — controls where the diagram renders relative to the stem. `after` is the legacy / migration default and what every imported IGCSE biology item lands as; `before` is for items that lead with a figure; `inline` requires a `{{diagram}}` placeholder somewhere inside the stem text, replaced at render time. If `inline` is set but the token is missing, the renderer falls back to `after` with a visible warning chip. Added 2026-05-12.), `options[]` (mcq), `correctIdx` (mcq), `correctAnswer` (numeric/short — null on IGCSE-imported items pending HQ answer-key fill), `tolerance` (numeric — ±value, default 0 = exact), `acceptedAnswers[]` (short — synonym list), `marks` (default 1), `difficulty` (`'easy' | 'medium' | 'hard'`), `difficultyStars` (1..3, optional), `commandWord` (Cambridge command word, optional), `assessmentObjective` (`'AO1' | 'AO2' | 'AO3'`, optional), `syllabusObjective` (e.g. `'C4.1 – Define the term acid'`, optional), `cambridgeStandardRefs[]` (e.g. `['7Ni.04']`), `markScheme` (M1/A1/B1 notation, optional), `explanation`, `status` (`'draft' | 'published' | 'archived'`), `version` (default 1), `parentItemId` (→ self, set when `version > 1`), `usedInTestIds[]` (denormalised reverse index → `chapter_tests.id`), `searchTokens[]` (lowercase alphanumeric tokens ≥3 chars derived from `stem`, stop-words filtered, capped at 60 — drives bank-wide search on `/question-bank` via `array-contains`. Same algorithm shared with `ease_items.searchTokens`. Added 2026-05-12.), `source` (`'hq' | 'igcse-tools'` — set on imported items; null/undefined for HQ-authored. Added 2026-05-12 with the IGCSE biology migration), `sourceCollection` (origin Firestore collection on the source project, e.g. `'importedQuestions'`), `sourceUid` (e.g. `'biol_0001'`), `pastPaperRef` (e.g. `'0610/12/F/M/2024-1'` — full Cambridge paper reference), `pastPaperCode` (paper-level, e.g. `'0610/12/F/M/2024'`), `pastPaperYear`, `pastPaperSession` (`'F/M' | 'M/J' | 'O/N' | 'SP'`), `pastPaperPaper` (`'1' | '2' | 'specimen'`), `pastPaperQuestionNumber`, `authorUid →users.uid`, `createdAt`, `updatedAt`.
**FKs:** `authorUid → users.uid` · `parentItemId → chapter_test_items.id` · `usedInTestIds[] → chapter_tests.id` · `diagramId → chapter_test_diagrams.id`.
**Writers:** `central_admin` (create/update/delete) and `central_user` with `coordinator` sub-role (create/update only; delete is admin-only since 2026-05-12 to match ease_items policy).
**Read scope:** any authorised staff; active students read items their attempt references.
**Notes:**
- Top-level since 2026-05-11 — enables item reuse across tests, standalone question bank, versioning, and parallel use by EASE-style aggregators.
- Editing a published item that has `usedInTestIds.size() > 0`: UI should bump `version`, write a new doc with `parentItemId` set, and atomically swap the id in the affected `chapter_tests.itemIds[]`. The rule does not enforce this — discipline lives in the editor.
- **IGCSE Biology import (2026-05-12):** 900 Cambridge IGCSE Biology (0610) past-paper MCQs migrated from the `igcse-tools` Firestore project's `importedQuestions` collection via [`scripts/migration/import-igcse-biology-to-chapter-bank.js`](scripts/migration/import-igcse-biology-to-chapter-bank.js). Deterministic doc id `igcse_${uid}` so re-runs are idempotent. All landed `status: 'draft'` because upstream answer keys are missing — HQ promotes to `published` as `correctAnswer` is filled in `/question-bank`. 448/900 carry `stemImagePath` pointing at the `igcse-tools.firebasestorage.app` bucket (kept verbatim; `stemImageBucket` field tags the cross-bucket case so UI can render with the correct origin or fall back to a placeholder). One source doc has `year='2402'` (upstream data-entry error) — passed through; HQ can fix in-place.

---

#### `chapter_test_diagrams/{diagramId}`
**PK:** Deterministic `igcse_${diagramPoolId}` for IGCSE-migrated entries; auto-id for HQ-created ones.
**Fields:** `imageName` (original filename, e.g. `'image141.png'`), `storagePath` (path within `centralhub-8727b.firebasestorage.app/diagrams/{subjectId}/...`, kept verbatim from IGCSE Tools layout), `imageURL` (public download URL — `https://storage.googleapis.com/centralhub-8727b.firebasestorage.app/{path}`), `subjectId` (`'biology' | 'math' | 'physics' | …` — canonical lowercase), `topics[]` (Cambridge syllabus topics this diagram is associated with — e.g. `['Characteristics and classification of living organisms']`), `tags[]` (free-form authoring tags), `description` (short human-readable caption — optional), `category` (`'diagram' | 'graph' | 'photo' | 'table' | 'other'`), `usedInItemIds[]` (denormalised reverse index → `chapter_test_items.id`; arrayUnion'd as items link the diagram), `width`, `height` (px, optional — read from Storage metadata when available), `source` (`'hq' | 'igcse-tools'`), `sourceId` (original `diagramPool.id` from IGCSE Tools), `authorUid →users.uid` (or sentinel for migrated entries), `createdAt`, `updatedAt`.
**FKs:** `authorUid → users.uid` · `usedInItemIds[] → chapter_test_items.id`.
**Writers:** `central_admin` and `central_user` with `coordinator` sub-role. Delete admin-only.
**Read:** any authorised staff; active students (so diagrams render inside chapter test attempts).
**Notes:**
- **IGCSE Tools migration (2026-05-12):** 463 reusable diagram entries pulled from `igcse-tools/diagramPool` via [`scripts/migration/import-igcse-diagrams-to-chapter-bank.js`](scripts/migration/import-igcse-diagrams-to-chapter-bank.js) — 448 biology + 15 math. Binaries copied to CH bucket in step 1 ([`copy-igcse-diagrams-to-ch-bucket.js`](scripts/migration/copy-igcse-diagrams-to-ch-bucket.js)) at the same path; this step writes the Firestore registry.
- **Reuse semantics:** one diagram can back N chapter_test_items via the FK `chapter_test_items.diagramId → chapter_test_diagrams.id`. The reverse `usedInItemIds[]` is maintained denormalised so the gallery UI can render a "used in N items" badge without a collection-group query.
- Path convention `diagrams/{subjectId}/{filename}` is shared with the Storage rule in `Central Hub/storage.rules`. Changing it breaks both directions.
- HQ-created diagrams (via `/diagrams` upload, future) get auto-id + `source: 'hq'`. The pool is platform-wide — eventually `ease_items` may also link diagrams via a parallel `diagramId` field.

---

#### `chapter_test_items_audit/{auditId}`
**PK:** Auto-id.
**Fields:** Same shape as `ease_items_audit`. `action` (`'delete' | 'bulk_delete' | 'restore' | 'create' | 'update' | 'import'`), `actorUid → users.uid` (or sentinel string for admin-SDK migrations, e.g. `'igcse-tools-import'`), `actorEmail`, `actorRole` (`'central_admin' | 'admin-sdk'`), `at` (serverTimestamp), `itemIds[]` (capped at 500 entries on bulk imports — forensic pointer, not a complete inventory), `itemSnapshots[]` (per-item small snapshot for `delete` actions: `{ id, subjectId, difficulty, type, status, stage, unitCode, usedInTestCount, stemPreview (first 200 chars) }`; empty `[]` on `import` actions where the items are being created, not destroyed), `reason` (optional), `chunkIndex` + `chunkTotal`. **`import`-specific fields:** `migrationSource` (e.g. `'igcse-tools/importedQuestions'`), `migrationSubject`, `migrationCount`, `migrationCreated`, `migrationUpdated`, `migrationForce`, `migrationLimit`.
**FKs:** `actorUid → users.uid` · each entry in `itemIds[]` was once a `chapter_test_items.id`.
**Writers:** `central_admin` (created inside the same `writeBatch` as the deletion).
**Read:** `central_admin`.
**Notes:**
- Append-only by rule (no update / no delete). Same audit-trail discipline as `ease_items_audit`.
- One audit doc per delete chunk (chunked at 400 items per Firestore's 500-op batch ceiling, +1 audit doc = 401 ops/batch).
- Snapshot carries `usedInTestCount` (length of `usedInTestIds[]` at delete time) so HQ can see if a deletion violated the in-use guard.

---

#### `scheduled_sessions/{sessionId}`
**PK:** Auto-id.
**Fields:** `testId →chapter_tests.id`, `testTitle` (denormalised), `subjectId`, `schoolId →partner_schools.id`, `classId →partner_schools/{id}/classes/{classId}`, `className` (denormalised), `gradeLevel`, `teacherUid →users.uid`, `teacherName`, `opensAt`, `closesAt`, `note`, `attemptCount` (count of pre-created attempts), `durationMin`, `cancelled` (boolean, default false), `cancelledAt`, `createdAt`.
**FKs:** `testId → chapter_tests.id` · `schoolId → partner_schools.id` · `classId → partner_schools/{id}/classes/{classId}` · `teacherUid → users.uid`.
**Writers:**
- **Create**: `central_admin` OR same-school `teachers_admin` / `teachers_user` with `subject_teacher` / `subject_leader` sub-role. The `teacherUid` field MUST equal the requester (rule-pinned).
- **Update**: same scope as create (used to flip `cancelled: true`).
- **Delete**: `central_admin` only.
**Read scope:**
- Any authorised staff (TH launcher list, AH school dashboards, CH cross-school monitoring).
- **Active students** read sessions where `schoolId == own schoolId AND className == own className` so the dashboard can show schedule cards.
**Notes:**
- A schedule launches a write batch: 1 `scheduled_sessions` doc + N `chapter_test_attempts` docs (one per active student in the class).
- `cancelled: true` is the soft-delete pattern — pre-created attempts remain so audit trail stays intact.
- Session "status" is computed client-side from the now-vs-window comparison (no `status` field) — schedule filtering is client-only.

---

#### `chapter_test_attempts/{attemptId}`
**PK:** Composite `{sessionId}_{studentUid}` — deterministic so a teacher pre-creates one attempt per student at schedule time and re-runs are idempotent.
**Fields:** `attemptId`, `sessionId →scheduled_sessions.id`, `testId →chapter_tests.id`, `testTitle` (denormalised), `studentUid →students.uid`, `studentName` (denormalised), `schoolId →partner_schools.id`, `classId`, `className`, `opensAt`, `closesAt`, `status` (`'draft' | 'in_progress' | 'submitted' | 'scored' | 'flagged' | 'cancelled'`), `startedAt`, `submittedAt`, `responses[]` (per-item: `{ itemId, seq, answer, isCorrect, marks, type }`), `rawScorePct`, `earnedMarks`, `totalMarks`, `passed` (boolean), `autoSubmit` (boolean — true if timer ran out), `tabSwitches` (lockdown counter), `lockdownEvents[]` (light-kiosk event trail — `{kind, at, ...}` where kind ∈ `tab_hidden / fullscreen_exit / copy_blocked / paste_blocked / context_blocked / devtools_keyguess` — added 2026-05-11), `createdAt`, `updatedAt`.
**FKs:** `sessionId → scheduled_sessions.id` · `testId → chapter_tests.id` · `studentUid → students.uid` · `schoolId → partner_schools.id`.
**Writers:**
- **Create**: `central_admin` OR same-school teacher (write batch from `scheduled_sessions` create). Students CANNOT create their own attempts.
- **Update (student self)**: ONLY when own attempt + `status ∈ ['draft','in_progress']` + affected keys ⊂ `{status, startedAt, submittedAt, responses, rawScorePct, earnedMarks, totalMarks, passed, autoSubmit, tabSwitches, lockdownEvents, updatedAt}` + `studentUid` / `testId` / `sessionId` immutable. Once `submitted` / `scored` / `flagged`, the doc is **immutable for students** (rule-enforced).
- **Update (teacher / admin)**: same-school teachers OR admin can update freely (used for Phase 2 essay regrading + status overrides).
- **Delete**: admin only.
**Read scope:**
- Owner (student) gets own attempts.
- Any authorised staff lists/reads (admin scoping via TH/AH dashboards).
**Notes:**
- Auto-scoring runs client-side at submit (MCQ exact match, numeric numeric-equality + string fallback, short text case-insensitive trim). Phase 2 will add server-side re-grade via Cloud Function for essay flagging.
- The `tabSwitches` counter is informational, not a hard kill switch — heavy lockdown (Safe Exam Browser-style) is a Phase 2 conversation.
- `responses[]` is denormalised into the attempt doc instead of a subcollection because all-at-once read is more common than per-response reads, and item count is bounded (typically 5–25 per chapter test).

---

#### `chapter_mastery/{studentUid}_{subjectId}_{unitCode}`
**PK:** Composite `{studentUid}_{subjectId}_{unitCode}`, sanitised lowercase.
**Fields:** `studentUid →students.uid`, `subjectId`, `unitCode`, `testId →chapter_tests.id`, `testTitle` (denormalised), `schoolId →partner_schools.id`, `classId`, `className`, `latestAttemptId →chapter_test_attempts.id`, `scorePct`, `passed`, `masteryLevel` (`'emerging' | 'developing' | 'secure' | 'exceeding'`), `attemptsCount`, `firstAttemptAt`, `lastAttemptAt`, `updatedAt`.
**Writers:** **Cloud Function `onChapterAttemptWritten` only.** No client-side write path — keeps the aggregate canonical. Admin SDK bypasses rules. Triggered on every `chapter_test_attempts` write whose post-status is `'scored' | 'submitted' | 'flagged'`.
**Read:** owner (student) · same-school staff (admin, AH leadership, TH teachers) · admin.
**Notes:**
- Denormalised aggregate so pacing dashboards + `class-assessment` heatmap can read mastery without re-scanning attempts.
- Same student retaking a chapter overwrites the prior result (`attemptsCount` increments, `latestAttemptId` flips). Past attempts remain in `chapter_test_attempts` for audit.
- Mastery band thresholds match `class-assessment.html` UI: <40 emerging, 40-60 developing, 60-80 secure, >80 exceeding.

---

#### `ease_items/{itemId}`
**PK:** Auto-id (HQ-authored) OR `latihan_{uuid}` (imported from latihan.id — deterministic for idempotent re-import).
**Fields:** `subjectId` (`'math' | 'english' | 'science' | 'physics' | 'chemistry' | 'biology'`), `discipline` (`'physics' | 'chemistry' | 'biology' | null` — set on every imported science-track item; null for math/english/IPA/Combined Science items. Cambridge stage-split: SMP-PHY/CHE/BIO with `stage_min<9` gets `subjectId='science'` + `discipline=<raw>`; `stage_min>=9` (and all SMA discipline lessons) gets `subjectId=<raw discipline>` + matching `discipline`. Added 2026-05-12 with the SMP-PHY/CHE/BIO import.), `strandCode` (e.g. `'algebra'`, `'reading'`, `'cell-biology'`), `difficulty` (`'easy' | 'medium' | 'hard'`), `type` (`'mcq' | 'numeric' | 'short'`), `stem`, `stemHtml` (sanitised HTML — optional, set when the source ships rich content), `searchTokens[]` (lowercase alphanumeric tokens ≥3 chars derived from `stem`, stop-words filtered, capped at 60 unique — drives bank-wide search on `/ease-item-author` via `array-contains`. Algorithm shared between [Central Hub/ease-item-author.html](Central%20Hub/ease-item-author.html) `buildSearchTokens` + [scripts/ease/import-latihan-bank.js](scripts/ease/import-latihan-bank.js) `buildSearchTokens` + [scripts/ease/backfill-search-tokens.js](scripts/ease/backfill-search-tokens.js); change in one, mirror to all three. Added 2026-05-12.), `options[]` (mcq), `correctIdx` (mcq), `correctAnswer` (numeric/short), `tolerance` (numeric, ±value, optional — added 2026-05-11), `acceptedAnswers[]` (short synonym list — added 2026-05-11), `commandWord` (Cambridge command word, optional — added 2026-05-11), `assessmentObjective` (`'AO1' | 'AO2' | 'AO3'`, optional — added 2026-05-11), `syllabusObjective` (optional — added 2026-05-11), `markScheme` (Cambridge M1/A1/B1 notation, optional — added 2026-05-11), `explanation`, `cambridgeStandardRefs[]`, `stage_min` (Year 7..), `stage_max` (Year 12), `pilotPhase` (`true` while uncalibrated — flipped to `false` by `calibrateEaseItems` Cloud Function), `seenCount` (server-maintained by `onEaseResponseCreated`), `correctRate` (running average 0..1, server-maintained), `calibratedLogit` (Phase 3, written by weekly batch — preferred over `DIFF_LOGIT[difficulty]` once present), `discrimination` (Phase 3, 0.5..2.5), `calibratedAt`, `calibrationResponseCount`, `cognitiveTag` (Knowing / Conceptual / Quantitative / Analysis / Interpretation / Evaluating / Applying / Understanding — from upstream `cognitive`, optional), `source` (`'hq' | 'latihan'`), `sourceId` (e.g. `latihan.id uuid` — set when `source = 'latihan'`), `sourceLessonCode` (upstream lesson code, e.g. `EASE-SMP-MAT`), `sourceLessonName` (human-readable upstream lesson name, e.g. `'Mathematics'`, `'Biology'` — added 2026-05-12), `sourceAnswerKey` (raw upstream `answer_key` — `'C'` for choice, free text for short — added 2026-05-12, audit/debug), `optionsLetters[]` (original A/B/C/D mapping per option for choice items — added 2026-05-12, preserves upstream layout if we ever shuffle), `sourceP` (upstream-reported correct percentage / 100 — useful initial logit estimate), `authorUid`, `createdAt`, `updatedAt`.
**FKs:** `authorUid → users.uid`.
**Writers:** `central_admin` and `central_user` with `coordinator` sub-role (CH `ease-item-author.html`). Imports from latihan.id run through `scripts/ease/import-latihan-bank.js` (admin SDK; bypasses rules).
**Read:** any authorised staff; active students (current MVP reads the bank as needed).
**Notes:**
- Author-assigned difficulty bands MVP. Phase 3 Cloud Function will calibrate per-item logit + discrimination from response data and fold those onto the doc, leaving `difficulty` as a bootstrap.
- Imported items use composite doc id `latihan_{uuid}` so the importer is naturally idempotent — re-runs `set(..., { merge: true })` instead of creating duplicates. Manual author edits on imported items stick (last-write-wins on field merge).
- `sourceP` is upstream's observed correct-rate. Phase 3 calibration will use it as a starting logit estimate (`theta ≈ -log(p / (1-p))`), then refine from our own response data.
- **Import volume snapshot (2026-05-12, post SMP + SMA Core 5 expansion):** 23,124 latihan items + 36 HQ-authored = **23,160 total**.
  - SMP Y7-9 (10,971): math 2,383 · english 4,423 · science (IPA+flipped) 2,664 · physics 498 (Y9) · chemistry 495 (Y9) · biology 508 (Y9).
  - SMA Y10-12 (12,153): math 2,196 · english 3,580 · physics 2,178 · chemistry 2,025 · biology 2,174.
  - By subjectId total: math 4,579 · english 8,003 · science 2,664 · physics 2,676 · chemistry 2,520 · biology 2,682.
  - By stage_min: Y7 3,872 · Y8 3,755 · Y9 3,342 · Y10 4,703 · Y11 4,834 · Y12 2,616.
  - Upstream pool ceilings: SMP MAT 2,895 / ENG 5,817 / IPA 648 / PHY 1,705 / CHE 1,707 / BIO 1,424 · SMA MAT 2,874 / ENG 4,591 / BIO 2,309 / CHE 2,588 / PHY 2,722.
- **Default importer scope:** `--subjects=math,english,science,physics,chemistry,biology --grades=7,8,9` covers all 6 SMP-* lessons. SMA / SD / A-LEVEL lessons listed in `LESSON_SUBJECT_MAP` (incl. SMA-PHY/CHE/BIO) but require explicit `--lessons=` to import.

---

#### `ease_items_audit/{auditId}`
**PK:** Auto-id.
**Fields:** `action` (`'delete'` initially; extensible to `'bulk_delete'`, `'restore'`, `'create'`, `'update'`), `actorUid → users.uid`, `actorEmail`, `actorRole` (`'central_admin'`), `at` (serverTimestamp), `itemIds[]` (Firestore doc ids of items affected in this audit record — one entry per item in the chunk), `itemSnapshots[]` (per-item small snapshot at deletion time: `{ id, subjectId, difficulty, type, source, sourceCode, sourceLessonCode, stage_min, stage_max, stemPreview (first 200 chars of stem) }` — enough metadata for HQ to identify what was lost and to seed a manual restore from latihan import for `source:'latihan'` items), `reason` (optional free text — UI doesn't capture this yet but the field is reserved), `chunkIndex` + `chunkTotal` (when a bulk delete spans more than one writeBatch chunk — currently chunks at 400 items per Firestore's 500-op limit, with the audit doc included in each batch).
**FKs:** `actorUid → users.uid` · each entry in `itemIds[]` was once an `ease_items.id`.
**Writers:** `central_admin` (created inside the same `writeBatch` as the deletion, so the audit record can't go missing if the delete commits).
**Read:** `central_admin`.
**Notes:**
- Append-only by rule (no update / no delete). Treat as immutable audit trail.
- One audit doc per delete chunk, NOT per item — keeps Firestore write costs proportional to the action's footprint, and lets HQ scan "this admin deleted 47 items at 14:32" as one row.
- For HQ-authored items the snapshot is the only path back; for `source:'latihan'` items HQ can re-run the importer (doc id is deterministic `latihan_{uuid}`) — but seenCount / correctRate / any manual HQ edits are still lost.
- Future Cloud Function `onEaseItemDeleted` may also fan out per-item rows; current MVP keeps the write client-side inside the existing batch.

---

#### `ease_test_windows/{windowId}`
**PK:** Composite `{academicYear}_{window}` (e.g. `2025-2026_term1`).
**Fields:** `academicYear`, `window` (`'term1' | 'term2' | 'term3'`; legacy `'fall' | 'winter' | 'spring'` accepted on existing docs for back-compat), `subjects[]`, `opensAt`, `closesAt`, `description`, `status` (`'draft' | 'open' | 'closed'`), `itemCountTarget` (default 25), `seStopThreshold` (default 0.4), `createdAt`, `updatedAt`.
**Writers:** `central_admin`.
**Read:** any authorised staff; active students.
**Notes:** Three windows per academic year. Students start a fresh `ease_sessions` doc per window per subject. Naming switched to Term 1/2/3 on 2026-05-12; one legacy pilot doc (`2025-2026_spring`, holding 1 session) was kept rather than migrated to avoid losing the session's `windowId` FK.

---

#### `ease_sessions/{sessionId}`
**PK:** Auto-id (composite `{studentUid}_{windowId}_{subjectId}` is conceptually unique but auto-id keeps re-attempts flexible).
**Fields:** `studentUid →students.uid`, `schoolId →partner_schools.id`, `subjectId`, `windowId →ease_test_windows.id`, `startedAt`, `submittedAt`, `status` (`'in_progress' | 'submitted' | 'cancelled'`), `itemsAnswered`, `currentTheta` (logit, client-reported — used for resume), `currentSE` (client-reported), `serverTheta` (server-validated, written by `onEaseResponseCreated`), `serverSE`, `serverItemsAnswered`, `ritScore` (RIT-equivalent 100–300 scale on submit), `standardError`, `percentile` (within network), `cambridgeStageEquivalent` (e.g. `'Late Stage 8'` post-calibration), `tabSwitches` (light-kiosk audit count — added 2026-05-11), `lockdownEvents[]` (light-kiosk event trail — `{kind, at, ...}` where kind ∈ `tab_hidden / fullscreen_exit / copy_blocked / paste_blocked / context_blocked / devtools_keyguess` — added 2026-05-11).
**FKs:** `studentUid → students.uid` · `schoolId → partner_schools.id` · `windowId → ease_test_windows.id`.
**Writers:** student creates own session (rule pins `studentUid == auth.uid` and `schoolId == students/{uid}.schoolId`). Updates own session while `in_progress`. Once `submitted`, immutable for student.
**Read:** owner; same-school staff; admin.
**Notes:** Adaptive trail of individual responses lives in `ease_responses` keyed by `sessionId`.

---

#### `ease_responses/{responseId}`
**PK:** Auto-id.
**Fields:** `sessionId →ease_sessions.id`, `studentUid →students.uid`, `seq` (1..N), `itemId →ease_items.id`, `answerGiven`, `isCorrect` (client-reported), `serverIsCorrect` (server-validated by `onEaseResponseCreated`, written only when a correction was applied), `serverCorrectionApplied` (boolean — added 2026-05-11), `serverCorrectionAt`, `timeMs`, `theta_after` (logit), `se_after`, `createdAt`.
**FKs:** `sessionId → ease_sessions.id` · `studentUid → students.uid` · `itemId → ease_items.id`.
**Writers:** student appends own response while session is `in_progress`. **Immutable** after creation for students. Admin SDK (Cloud Function `onEaseResponseCreated`) can write `serverIsCorrect` / `serverCorrectionApplied` / `serverCorrectionAt` post-create.
**Read:** owner; same-school staff; admin.
**Notes:** Per-response row supports re-running calibration on historical data without re-asking students.

---

#### `ease_growth/{studentUid}_{subjectId}`
**PK:** Composite `{studentUid}_{subjectId}` — one doc per student per subject, accumulated across windows.
**Fields:** `studentUid →students.uid`, `subjectId`, `windows[]` (array of `{windowId, ritScore, percentile, growthVsPrev, submittedAt}`), `latestRit`, `projectedNextRit` (Phase 3), `alignedToTargetIGCSEGrade` (Phase 3), `updatedAt`.
**FKs:** `studentUid → students.uid`.
**Writers:** student writes own doc on submit (current MVP); Phase 3 Cloud Function recomputes server-side.
**Read:** owner; same-school staff; admin.
**Notes:** Cross-window comparability is unreliable until items are calibrated; UI must label early windows as "window-specific norm" before window 4. See `docs/architecture/STUDENTS-HUB-ARCHITECTURE.md` §7.

---

#### `parent_share_tokens/{token}`
**PK:** Random URL-safe token (≥24 chars).
**Fields:** `studentUid →students.uid`, `attemptId →chapter_test_attempts.id` OR `sessionId →ease_sessions.id` (one of), `expiresAt`, `createdAt`.
**Writers:** student creates own token; admin can manage.
**Read:** anyone with the token (rule allows `get` by id, blocks `list` even for admin). Token is the credential.
**Notes:** Used by Students Hub `/shared?token=…` parent-share landing. Tokens are short-lived (default 30 days) and student can revoke by deleting the doc.

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

### 20. Gamification — Points, Levels, Streaks, Leaderboards (Students Hub, 2026-05-11)

Mathletics-style engagement layer on top of chapter test + EASE submissions. Points are earned by completing assessments; a Cloud Function recomputes level / streak / leaderboard aggregates server-side so students cannot self-award. UI surfaces live in dashboard (preview) and `/leaderboard` (full 4-tab board).

**Charter notes (rule-enforced):**
- Students cannot self-write `student_points` or `school_leaderboards` — both are Cloud-Function-only writes. Self-read OK.
- Network-wide leaderboard reveals first name + school name + total points only. No `emailLower`, no `lastName`, no class/grade (`schoolId` + `displayName` first-name only). Privacy by minimisation.
- No "points purchased" path — points are purely behavioural rewards, never monetary.

#### `student_points/{uid}`
**PK:** student uid (1:1 with `students/{uid}`).
**Fields:**
- Identity (denormalised — for leaderboard queries without join): `studentUid →students.uid`, `displayName` (first name only when surfaced on network leaderboard), `photoURL`, `schoolId →partner_schools.id`, `schoolName`, `classId`, `className`, `gradeLevel`.
- Totals: `totalPoints`, `weeklyPoints`, `monthlyPoints`, `lastWeeklyResetAt`, `lastMonthlyResetAt`.
- Level: `level` (1-100), `levelXp` (XP into current level), `levelXpRequired` (XP needed for next), `levelProgress` (0-100 %).
- Streak: `streak{current, longest, lastDay, lastDayISO}`.
- Badges: `badges[{id, earnedAt, source}]`.
- Activity counters: `chapterTestsCompleted`, `easeSessionsCompleted`, `perfectScores` (100% chapter tests).
- Audit: `createdAt`, `updatedAt`, `recomputedAt`.
**FKs:** `students.uid` (PK), `partner_schools.id`, `partner_schools/{schoolId}/classes/{classId}`.
**Writers:** **Cloud Functions only** — `awardChapterTestPoints` (on `chapter_test_attempts` write with status flipping to `scored`) and `awardEaseSessionPoints` (on `ease_sessions` write to `submitted`). Admin SDK bypasses rules.
**Read scope:** owner (self) · `central_admin` · same-school `teachers_admin` / `academic_admin` for own students. Leaderboard list queries (filtered by `classId` / `schoolId` / `gradeLevel`) are allowed for any active student — fields exposed are intentionally minimal (displayName, photoURL, totalPoints, level).
**Notes:** Weekly + monthly buckets reset by daily scheduled Cloud Function `resetLeaderboardWindows` (Monday 00:00 Asia/Jakarta for weekly; first of month for monthly). Streak day rolls over at 04:00 student local time (defaulted to Asia/Jakarta in MVP). Doc may not exist for brand-new students who have not yet submitted an assessment — clients render zero-state gracefully.

#### Point-award rules (informational — implemented in Cloud Function)
| Event | Base | Bonus |
|---|---|---|
| Chapter test scored | **+50 pts** | +0.5 × `rawScorePct` (so 100% = +100 total); +25 if first attempt; +50 if `rawScorePct >= 100` ("perfect score" badge progress) |
| EASE session submitted | **+100 pts** | +50 if RIT growth ≥ +5 vs prior window; +25 if growth ≥ 0 |
| Daily login (touchOnAuthReady) | **+10 pts** | +100 milestone at 7-day streak, +250 at 30-day |
| Badge earned | **+25 pts** | (one-time) |

Level curve: `levelXpRequired(level) = 100 + (level-1) × 50`. Level 1 → 2 takes 100 XP; level 10 → 11 takes 550 XP. Capped at level 100.

#### Badges (informational — IDs writable by Cloud Function)
Stable IDs (slugs): `first_chapter_clear`, `perfect_score`, `streak_7`, `streak_30`, `ease_window_done`, `class_top_3_weekly`, `subject_champion_math`, `subject_champion_english`, `subject_champion_science`, `school_top_10_monthly`.

#### `school_leaderboards/{boardId}`
**PK:** `{scope}_{scopeId}_{period}` — e.g. `class_y8a-fatih_weekly`, `school_partner-fatih_monthly`, `network_all_alltime`. Scope ∈ `class | grade | school | network`. Period ∈ `weekly | monthly | alltime`.
**Fields:** `scope`, `scopeId`, `period`, `entries[{rank, studentUid, displayName, schoolName, classId, totalPoints, weeklyPoints, monthlyPoints, photoURL, level, delta}]` (top 100), `computedAt`, `nextRecomputeAt`.
**FKs:** `students.uid` (via entries[].studentUid). `partner_schools.id` (via scopeId for school-scope rows).
**Writers:** **Cloud Function only** — `rebuildLeaderboards` scheduled run + on-demand recompute when a student's `totalPoints` crosses a threshold.
**Read scope:** any active student. The network board reveals only `displayName` (first name) + `schoolName` + score — no class/grade/email.
**Notes:** Stored as one doc per (scope, scopeId, period) tuple with the top 100 inline in `entries[]`. Avoids fanning out per-student rank docs. Stale within `nextRecomputeAt` window; clients show `computedAt` timestamp.

---

### 21. Practice Bank (supplemental items for SH tournaments / leaderboards / gamification, 2026-05-12)

Curriculum-adjacent question bank kept **separate from** `chapter_test_items` (which is the network-uniform formal chapter-test bank authored by HQ Subject Specialists) and **separate from** `ease_items` (which is the calibrated EASE growth bank). `practice_questions` holds items that are pedagogically useful but not Cambridge-mapped — today populated entirely from the IGCSE Tools `questions` collection's `source: 'examview'` slice (Pearson Pre-Algebra / Algebra 1 / Algebra 2 / Geometry / Pre-Calculus textbook chapters). Future imports (other ExamView decks, paraphrased third-party content) land in the same collection.

**Design intent:**
- Never wired into the formal assessment flow (`scheduled_sessions` / chapter-test attempts / EASE growth). Reading these never affects `chapter_mastery` or `ease_growth`.
- Reserved for SH-side **tournaments, leaderboards, daily-challenge gamification** — modes where item-level Cambridge alignment is nice-to-have, not load-bearing.
- Ham `topic` strings preserved verbatim from upstream (e.g. `'1-5 Adding Integers'`). Cambridge `unitCode` mapping is **deferred** — HQ Math Specialist tags items in `/practice-bank-admin` (future) when an item is promoted into a gamification pool.

#### `practice_questions/{itemId}`
**PK:** Deterministic `igcse_${sourceId}` for IGCSE-Tools-imported items (where `sourceId = questions.{id}` upstream). Auto-id for hand-added or future-source items.
**Fields:**
- Content: `subjectId` (lowercase canonical — `'math'` / `'english'` / `'science'`), `type` (`'mcq' | 'short_answer'`), `stem` (markdown + LaTeX), `stemHtml` (rich source if upstream provided HTML; null when upstream is plain text), `options[]` (mcq), `optionsHtml[]` (rich source), `correctAnswer` (mcq → letter `'A'..'D'`; short_answer → freeform string or null), `marks` (default 1), `commandWord`, `assessmentObjective` (`'AO1' | 'AO2' | 'AO3'` — sparse, ~26% of imported items), `markScheme` (sparse — upstream rarely has it), `explanation`.
- Tagging: `difficultyStars` (1-3 — upstream `L1/L2/L3` rating preserved), `difficulty` (`'easy' | 'medium' | 'hard'` — derived from stars), `topic` (verbatim upstream string, e.g. `'1-5 Adding Integers'`), `topicSlug` (kebab-case of `topic`), `topicGroup` (`'number' | 'algebra' | 'geometry' | 'statistics' | 'probability' | 'problem-solving' | 'mixed' | null` — coarse heuristic bucket, used by leaderboard "Algebra Champion" / "Geometry Champion" segmentation. **Filled at import** by keyword match on `topic`. Null = unclassified (today mostly `'Uncategorised'` upstream entries — explicit decision to leave them null for HQ sweep). Later HQ tagging in `/practice-bank-admin` rewrites this).
- Cambridge mapping (deferred — null at import time): `cambridgeStandardRefs[]`, `cambridgeUnitCode`, `cambridgeStage` (7..12). HQ Math Specialist fills these as items are curated.
- Diagrams: `hasDiagram`, `diagramUrl` (full HTTPS URL — CH bucket after the storage copy step has run; `null` until then), `diagramOriginalUrl` (verbatim upstream URL on `igcse-tools.firebasestorage.app` for forensics + rollback), `diagramStoragePath` (CH bucket path within `centralhub-8727b.firebasestorage.app/practice-diagrams/{subjectId}/...`).
- Lifecycle: `status` (`'active' | 'archived' | 'flagged'` — default `'active'`. Promoted-to-tournament items stay `'active'`; HQ flags items with copyright/quality concerns as `'flagged'`).
- Provenance (always set on IGCSE-Tools imports): `source` (`'igcse-tools-examview' | 'hq' | string`), `sourceCollection` (e.g. `'questions'`), `sourceUid` (upstream doc id), `sourceFile` (e.g. `'Pre_Algebra_Chapter_0'` — original ExamView ZIP filename, used for "which textbook" filters), `sourceId` (e.g. `'question_42_1'` — upstream QTI id), `sourceUserId` (upstream uploader's IGCSE Tools uid — provenance only; the user who originally imported the ZIP).
- Search: `searchTokens[]` (same `buildSearchTokens()` algorithm as `chapter_test_items.searchTokens` + `ease_items.searchTokens` — `array-contains` queries on `/practice-bank-admin`).
- Audit: `authorUid` (sentinel `'igcse-tools-examview-import'` for migration; future HQ-authored items carry actual uid), `createdAt`, `updatedAt`, `importedAt`.

**FKs:** `authorUid → users.uid` (sentinel for migrated entries).
**Writers:** `central_admin` (full CRUD) and `central_user` with `coordinator` sub-role (create + update, no delete — matches `ease_items` and `chapter_test_items` policy since 2026-05-12).
**Read scope:**
- Any authorised staff (CH/AH/TH browse for admin + future curation UIs).
- Active students (`isActiveStudent()`) — list + get. SH gamification surfaces (`/tournaments`, `/daily-challenge`, future `/practice` page) read this collection directly. Privacy is not a concern: items are themselves the product, like a textbook.
- Public read: **no.** Even though upstream `questions` had `isPublic` flag, we keep this auth-gated — student-account or staff-account is the minimum bar.

**Notes:**
- **IGCSE Tools ExamView import (2026-05-12):** 805 math items from `igcse-tools.questions` filtered by `source == 'examview'` migrated via [`scripts/migration/import-igcse-examview-math-to-practice-bank.js`](scripts/migration/import-igcse-examview-math-to-practice-bank.js). Deterministic doc id so re-runs are idempotent. Includes 570 MCQs (with `correctAnswer` letter populated) + 235 short_answer (open-ended, `correctAnswer` typically null — gamification surfaces filter by `type == 'mcq' AND correctAnswer != null` for auto-gradability).
- **Image binaries:** 436/805 items reference raster diagrams. Pre-step [`scripts/migration/copy-igcse-math-images-to-ch-bucket.js`](scripts/migration/copy-igcse-math-images-to-ch-bucket.js) copies the binary from `igcse-tools.firebasestorage.app` into `centralhub-8727b.firebasestorage.app/practice-diagrams/math/{filename}`; the import script then writes `diagramUrl` + `diagramStoragePath` accordingly. Items whose source image fails to copy land with `diagramUrl: null` + `hasDiagram: true` — gamification UI must render a "diagram missing" placeholder and skip the item from grading pools.
- **`topicGroup` coarse heuristic:** Topics matching `/integer|decimal|fraction|percent|ratio|number/i` → `'number'`. `/algebra|equation|expression|inequalit|polynomial|exponent|radical|coordinate plane/i` → `'algebra'`. `/geometry|angle|triangle|polygon|perimeter|area|volume|pythagorean|translation|reflection|rotation/i` → `'geometry'`. `/mean|median|mode|histogram|bar graph|line graph|stem.and.leaf|box.and.whisker|statistic/i` → `'statistics'`. `/probabilit|combinatori|permutation/i` → `'probability'`. `/mixed/i` → `'mixed'`. Otherwise `null`. **Heuristic is intentionally loose — it just bootstraps the leaderboard buckets. HQ rewrites in `/practice-bank-admin`.**
- **Copyright posture:** Pearson textbook origin is internal-pilot-only. Do NOT expose any `practice_questions` doc with `source: 'igcse-tools-examview'` on a public unauth route. The active-student `read` rule is the strictest layer that lets the gamification flow work. If HQ paraphrases a question, set `source: 'hq'` (and recommend writing a new doc, not in-place editing — preserves audit).
- **Future imports** (e.g. ExamView English / Science decks) follow the same shape: `source: 'igcse-tools-examview'` with `subjectId` differing; the import script supports `--subject=` flag.

#### `practice_questions_audit/{auditId}`
**PK:** Auto-id.
**Fields:** Same shape as `chapter_test_items_audit` / `ease_items_audit`. `action` (`'import' | 'create' | 'update' | 'delete' | 'flag' | 'unflag'`), `actorUid → users.uid` (or sentinel `'igcse-tools-examview-import'` for the bulk migration), `actorEmail`, `actorRole` (`'central_admin' | 'admin-sdk'`), `at` (serverTimestamp), `itemIds[]` (capped at 500 entries on bulk imports), `itemSnapshots[]` (small per-item snapshot for delete actions only), `reason`. **`import`-specific fields:** `migrationSource` (e.g. `'igcse-tools/questions/source=examview'`), `migrationSubject`, `migrationCount`, `migrationCreated`, `migrationUpdated`, `migrationForce`, `migrationLimit`.
**FKs:** `actorUid → users.uid` · each entry in `itemIds[]` was once a `practice_questions.id`.
**Writers:** `central_admin` (created inside the same `writeBatch` as the action).
**Read:** `central_admin`.
**Notes:** Append-only by rule (no update / no delete). One audit doc per chunk on bulk imports (chunked at 400 items per Firestore's 500-op batch ceiling).

---

### 22. Practice Assessments (HQ-composed bundles of practice items + AI-assisted authoring, 2026-05-12)

Practice items (§21) get composed into reusable **assessments** here. Distinct from `chapter_tests` (formal network-uniform tests fed into `chapter_mastery`) and `ease_sessions` (per-student adaptive runs fed into `ease_growth`). Practice assessments are the source pool for Students Hub tournaments / leaderboards / daily-challenge gamification — they NEVER write to `chapter_mastery` or `ease_growth`. Reuse via `itemIds[]` references (no cloning — `practice_questions` is already reuse-safe).

Three collections + one Cloud Function:

#### `practice_assessments/{assessmentId}`
**PK:** Auto-id (firestore default).
**Fields:**
- `title` (string, required)
- `description` (string)
- `subjectId` (string, `'math' | 'english' | 'science'`)
- `mode` (string, `'practice' | 'tournament' | 'daily_challenge'`)
- `itemIds[]` (array of `practice_questions.id`)
- `itemCount` (number — denormalised `itemIds.length` for filter queries)
- `difficultyMix` (map — `{ easy: number, medium: number, hard: number }` denormalised counts)
- `topicGroups[]` (array — denormalised union of selected items' `topicGroup` for filter queries)
- `cambridgeStage` (number `7..12 | null`)
- `timeLimitSec` (number — soft client-side timer; SH tournament engine reads this)
- `status` (string, `'draft' | 'published' | 'archived'`)
- `aiAssisted` (boolean — true if any items came from a `practiceBankAiSuggest` call during authoring)
- `aiSuggestionIds[]` (array of `practice_ai_audit.id` for this assessment — author trail)
- `createdBy → users.uid`
- `createdAt`, `updatedAt`, `publishedAt` (timestamp | null)

**FKs:** `createdBy → users.uid` · each `itemIds[i] → practice_questions.id`.
**Writers:** `central_admin` OR CH `coordinator` / `director`.
**Read:** authorised CH/AH/TH users OR `isActiveStudent()` when `status == 'published'`.
**Delete:** `central_admin` only.
**Notes:** Items referenced by id — never cloned. Deleting an underlying `practice_questions` doc orphans the reference (client-side filter at read time skips missing docs); this is acceptable because practice items follow a soft-delete pattern (`status: 'archived'`) by convention. `aiAssisted` lets the SH analytics tab segment "AI-composed vs hand-picked" performance.

#### `practice_ai_audit/{auditId}`
**PK:** Auto-id.
**Fields:**
- `actorUid → users.uid`
- `actorEmail`
- `actorRole` (`'central_admin' | 'coordinator' | 'director'`)
- `assessmentId → practice_assessments.id | null` (null if the call happened before the draft was saved)
- `subjectId`
- `intent` (string — free-text prompt from the user)
- `params` (map — structured filters: `targetCount`, `difficultyMix`, `topicGroups[]`, `cambridgeStage`)
- `candidatePoolSize` (number — how many items matched the hard filter before being sent to the model)
- `candidateIdsSentToModel[]` (capped at 100 — exactly what was sent)
- `returnedIds[]` (model's ranked output)
- `rationale[]` (string per returned id, model's 1-line justification)
- `model` (string — e.g. `'claude-sonnet-4-6'`)
- `tokenUsage` (map — `{ input, output, total }`)
- `latencyMs` (number)
- `cacheHit` (boolean)
- `error` (string | null)
- `at` (serverTimestamp)

**Writers:** Cloud Function only (server-side append).
**Read:** `central_admin`.
**Notes:** Append-only (no update / no delete via rules). Lets HQ audit AI cost + model behaviour + which intents produce useful suggestions. Drives future fine-tuning decisions.

#### `ai_suggestion_cache/{cacheId}`
**PK:** Deterministic — `sha256(subjectId + targetCount + difficultyMix + topicGroups + cambridgeStage + intent + model + candidatePoolFingerprint).slice(0, 40)`. `candidatePoolFingerprint` = sha256 of the sorted candidate id list (so a cache hit is invalidated automatically when the candidate pool changes — e.g. a new item gets imported or an item gets archived).
**Fields:**
- `returnedIds[]`
- `rationale[]`
- `model`
- `tokenUsage` (map — original call cost; replayed hits are zero-cost)
- `createdAt` (serverTimestamp)
- `expiresAt` (timestamp — `createdAt + 24h`; client filters expired entries, eventual TTL policy via Firestore TTL field)

**Writers / Read:** Cloud Function only (rule denies all client access).
**Notes:** 24h soft TTL. The candidate-pool fingerprint is the key invariant — without it, an item archive/import would silently leak stale suggestions for up to 24h.

#### Cloud Function: `practiceBankAiSuggest` (asia-southeast1, callable)
**Auth gate:** `request.auth` exists AND profile has `role_centralhub == 'central_admin'` OR `'director' ∈ ch_sub_roles[]` OR `'coordinator' ∈ ch_sub_roles[]`. Coordinators additionally constrained to subjects in their `ch_subjects[]`.
**Secret:** `ANTHROPIC_API_KEY` (Secret Manager).
**Default model:** `claude-sonnet-4-6` (cost-effective for ranking; Opus is overkill for metadata ranking).
**Flow:**
1. Validate args (`subjectId`, `targetCount: 1..50`, `difficultyMix`, optional `topicGroups[]` / `cambridgeStage` / `intent`).
2. Query `practice_questions where subjectId==X and status=='active'` (+ optional stage / topicGroup hard filters). Cap candidate pool at 100 (most-recent-imported first).
3. Compute cache fingerprint. If `ai_suggestion_cache/{fp}` exists AND `expiresAt > now`, return cached `returnedIds[]` + write a `practice_ai_audit` row with `cacheHit: true`.
4. Otherwise: send candidate metadata only (`{id, topic, topicGroup, difficulty, commandWord, stemPreview}` where `stemPreview = stem.slice(0, 200)`) to Anthropic with a structured prompt asking for ranked ids + rationale. Never send full HTML, image URLs, or correct answers.
5. Persist `ai_suggestion_cache/{fp}` + write `practice_ai_audit` row with `cacheHit: false` + full token usage.
6. Return `{ returnedIds[], rationale[], cacheHit, auditId }` to the caller.

**Failure modes:** Anthropic 429 / 5xx → log + audit row with `error` field + throw to client; client retries with backoff. Empty candidate pool → return empty list with no LLM call.

**FKs:** see individual collections above.
**Auth gate (client-side caveat):** the caller must already hold a valid sub-role at the time of the call; client UI hides the "AI Suggest" tab when not entitled, but server gate is the source of truth.

---

### 23. Practice Attempts + Daily Challenges (Students Hub engagement, 2026-05-13)

Two collections that wire the Practice Bank + Practice Assessments into student-facing self-paced runs. Same intent-and-boundary as §21 + §22: NEVER feeds `chapter_mastery` or `ease_growth`. Lives at the SH-engagement tier — point awards flow through `student_points` via a future Cloud Function trigger.

#### `practice_attempts/{attemptId}`
**PK:** Auto-id.
**Fields:**
- `studentUid → students.uid`
- `studentName` (denormalised — keeps leaderboard render zero-join)
- `schoolId → partner_schools.id` (denormalised at create — needed for scope filtering)
- `classId → partner_schools.classes.id` (denormalised — used by class-scope queries)
- `gradeLevel` (number — denormalised)
- `subjectId` (`'math' | 'english' | 'science'`)
- `mode` (`'practice' | 'daily_challenge' | 'tournament'`)
- `sourceType` (`'free' | 'assessment' | 'challenge'`)
  - `'free'`: ad-hoc picker run (no parent assessment, `itemIds[]` chosen client-side from `practice_questions`)
  - `'assessment'`: ran an existing `practice_assessments/{id}` bundle (`assessmentId` populated)
  - `'challenge'`: ran today's `daily_challenges/{challengeId}` (`challengeId` populated)
- `assessmentId → practice_assessments.id | null`
- `challengeId → daily_challenges.id | null`
- `itemIds[]` (array of `practice_questions.id` — the actual items the runner served; for `'assessment'`/`'challenge'` this mirrors the parent's `itemIds[]` at attempt-start time so subsequent edits to the parent don't desync this run)
- `topicGroup` (string — denormalised for free-mode runs by topic)
- `responses[]` (map array — `{ itemId, answer, isCorrect, timeSpentMs, answeredAt }`)
- `status` (`'in_progress' | 'submitted' | 'scored'`)
- `correctCount` (number)
- `attemptedCount` (number)
- `rawScorePct` (number — `correctCount / itemIds.length * 100`)
- `streakBest` (number — longest consecutive correct streak in this attempt, drives "🔥 perfect run" UI cues)
- `pointsAwarded` (number — set by Cloud Function on submit; null until then)
- `createdAt`, `submittedAt`

**FKs:** `studentUid → students.uid` · `schoolId → partner_schools.id` · `classId` · `assessmentId → practice_assessments.id` · `challengeId → daily_challenges.id` · `itemIds[i] → practice_questions.id`.
**Writers:** owning student creates own draft (`status=='in_progress'`, `studentUid==auth.uid`); owner can update fields while `in_progress`; once `submitted`/`scored` doc is immutable for student. `central_admin` can update freely (for manual regrade or moderation).
**Read:** any authorised CH/AH/TH user (admin / staff lens) OR owning student (`studentUid==auth.uid`).
**Notes:** Mirrors the `chapter_test_attempts` lifecycle but **never writes back to mastery**. The Cloud Function that maintains `student_points` reads this collection and applies a per-mode multiplier (e.g. practice 1×, daily_challenge 1.5×, tournament 2×).

#### `daily_challenges/{challengeId}`
**PK:** Deterministic `{YYYY-MM-DD}_{subjectId}` (e.g. `2026-05-13_math`). Lets the SH client compute today's id without a query.
**Fields:**
- `dateKey` (string — `'YYYY-MM-DD'`)
- `subjectId` (`'math' | 'english' | 'science'`)
- `title` (string — e.g. "Friday Algebra Sprint")
- `description` (string)
- `itemIds[]` (array of `practice_questions.id` — typically 5 items)
- `itemCount` (number — denormalised)
- `difficultyMix` (map)
- `topicGroups[]` (denormalised union)
- `opensAt`, `closesAt` (timestamps — typically `dateKey 00:00..23:59` local)
- `status` (`'draft' | 'open' | 'closed'`)
- `createdBy → users.uid | 'system'` (`'system'` when a future Cloud Function rotates challenges automatically)
- `createdAt`, `updatedAt`

**FKs:** `createdBy → users.uid` (or sentinel `'system'`) · each `itemIds[i] → practice_questions.id`.
**Writers:** `central_admin` OR CH `coordinator` / `director`.
**Read:** any authorised user OR `isActiveStudent()`.
**Notes:** One challenge doc per (date × subject). The deterministic id makes "did I do today's?" a `get` not a `where`. A future Cloud Function may auto-rotate challenges from the published `practice_assessments` pool at midnight; until that lands, HQ authors today's challenge from `/practice-assessment-author` and writes the `daily_challenges` doc by hand (the same HQ surface composes both `practice_assessments` and `daily_challenges`).

#### `practice_question_flags/{flagId}` — HQ observer bug reports (2026-05-13)
**PK:** Auto-id.
**Fields:**
- `itemId` (string — references the flagged item's doc id, but **not a strong FK** — item may be archived / renamed between flag time and triage)
- `collection` (`'practice_questions' | 'chapter_test_items' | 'ease_items'` — tells the triage queue which authoring page to deeplink to)
- `subjectId` · `topicGroup` · `difficulty` · `type` — denormalised facets so the queue page can filter without fetching item docs
- `reason` (string — one of `formatting`, `ambiguous`, `wrong_answer`, `off_curriculum`, `culturally_inappropriate`, `duplicate`, `other`)
- `note` (string — free-text, max 280 chars)
- `stemSnapshot` (string — first 500 chars of the stem at flag time; survives item rewrites/archive)
- `flaggerUid → users.uid | students.uid`
- `flaggerName` · `flaggerEmail` — denormalised so the queue table doesn't N+1
- `schoolId → partner_schools.id | null` — denormalised; future "flags per school" stat
- `status` (`'open' | 'triaged' | 'fixed' | 'wontfix' | 'duplicate'`)
- `triagedBy → users.uid | null` (`null` until status leaves `open`)
- `triageNote` (string)
- `triagedAt` (timestamp | null)
- `createdAt` (serverTimestamp)

**FKs:** `itemId → {practice_questions | chapter_test_items | ease_items}.id` (loose); `flaggerUid → students.uid`; `schoolId → partner_schools.id`; `triagedBy → users.uid`.
**Writers:** Observer students (`students/{uid}.is_hq_observer == true` AND `status == 'active'`) can create rows with `status: 'open'`. CH reviewers (`central_admin` OR `ch_sub_roles ∈ {director, coordinator}`) can update `status` + `triageNote` + `triagedAt` + `triagedBy`; flagger / item / createdAt fields are immutable. `central_admin` only for delete.
**Read:** CH reviewers only (`central_admin` OR `director` OR `coordinator`). Students cannot read each other's flags or their own back.
**Notes:** Generic across all 3 question banks so the same observer-strip + triage queue covers chapter tests, EASE growth, and practice. The collection name kept the `practice_question_flags` slug for back-compat with the first SH surface (practice-run), even though it routes flags for chapter tests + EASE items too. NEVER deleted by client — admin triages by flipping status. Stem snapshot is the audit trail when the upstream item is rewritten/archived between flag time and review.

#### `practice_question_endorsements/{itemId_specialistUid}` — HQ observer good-question stars (2026-05-14)
**PK:** Deterministic `{itemId}_{specialistUid}`. Idempotent — re-saving the same (item, specialist) pair updates in place; specialists can edit their tag set or comment without producing duplicate rows.
**Fields:**
- `itemId` (string — references the endorsed item's doc id)
- `collection` (`'practice_questions' | 'chapter_test_items' | 'ease_items'` — tells the browse page which authoring page to deeplink to)
- `subjectId` · `topicGroup` · `difficulty` · `type` — denormalised facets so the browse page can filter without fetching item docs
- `stemSnapshot` (string — first 500 chars of the item's `stemHtml` (preferred) or `stem`; mirrors `practice_question_flags.stemSnapshot` so the CH browse page can render a 3-line preview without N+1-fetching every item)
- `sourceCode` (string | null — denormalised from the item)
- `specialistUid → students.uid` (the HQ observer; rule pins it to `auth.uid`)
- `specialistName` · `specialistEmail` — denormalised for the queue
- `comment` (string — free-text, max 280 chars)
- `tags[]` (`'curriculum-aligned' | 'exam-style' | 'conceptual'` — subset of 3, rule-validated)
- `createdAt` · `updatedAt`

**FKs:** `itemId → {practice_questions | chapter_test_items | ease_items}.id` (loose, same as flags); `specialistUid → students.uid` (HQ observer's student doc).
**Writers:** Observer students (`students/{uid}.is_hq_observer == true` AND `status == 'active'`). Doc id must match `{itemId}_{auth.uid}` so a specialist can't write under someone else's id. Re-saving updates in place. Owner can delete own row to retract the endorsement; `central_admin` can delete any (moderation).
**Read:** CH reviewers (`central_admin` OR `director` OR `coordinator`) can list + get; observer can `get` own row for the prefill / edit flow. No cross-observer read for students.
**Notes:** Companion to `practice_question_flags` — same observer-student gate + same browse charter, but the relationship is "I like this question" not "this question has a problem". The host item doc gets a denormalised `endorseCount` (number) + `endorsedBy[]` (uid[]) field via a separate back-write — per-collection rule (`practice_questions` / `chapter_test_items` / `ease_items`) lets observer students update those two fields only (`hasOnly(['endorseCount', 'endorsedBy'])`). Best-effort: if a back-write fails (e.g. concurrent admin write rejects the increment), the count drifts. A future CH cron / Cloud Function can re-derive from this canonical collection.

**`{practice_questions | chapter_test_items | ease_items}.endorseCount` + `.endorsedBy[]`** — denormalised aggregate fields on the host item, maintained client-side by the SH observer strip. NOT load-bearing — the source of truth is `practice_question_endorsements`. Don't read these in trust-sensitive code paths; re-aggregate from the canonical collection when accuracy matters (e.g. on a CH ranking page that affects what assessments specialists select). For SH leaderboard-style display where ~off-by-one drift is harmless, reading the denormalised count is fine.

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
| `practice_assessments` | `subjectId ASC, status ASC, updatedAt DESC` | `practice-assessment-author.html` left-rail list (filter by subject + status, recent first) |
| `practice_assessments` | `status ASC, mode ASC, publishedAt DESC` | future SH tournament/leaderboard pickers (published practice/tournament/daily-challenge by recency) |
| `practice_ai_audit` | `actorUid ASC, at DESC` | HQ "my AI calls" audit pane |
| `practice_attempts` | `studentUid ASC, submittedAt DESC` | SH "my recent practice runs" list |
| `practice_attempts` | `classId ASC, mode ASC, submittedAt DESC` | SH class-scope daily-challenge leaderboard |
| `daily_challenges` | `subjectId ASC, status ASC, dateKey DESC` | SH "today's challenge" lookup (filter by subject + open status, recent first) |

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

### 24. AI Competency Framework — Self-Assessment + Maturity (2026-05-17 — Phase 2)

Three collections supporting the Eduversal AI Competency Framework v1.0 (Phase 2 of the AI Framework rollout — see `docs/research/eduversal/ai-competency-framework/manifest.json`). Phase 1 (read-only reader pages + AICF chip family) shipped 2026-05-17 with no Firestore writes. Phase 2 adds the data layer for annual self-assessment + line-manager validation.

**Scope boundary:** these collections track AI **competency** progression (per Eduversal AICF v1.0). They do NOT replace KPI (`teacher_kpi_submissions`), Appraisal (`teacher_self_appraisals` / `teacher_appraisals`), or Competency Framework (`user_competencies`) — those remain the canonical three rating systems. AICF self-assessment is a **fourth, parallel track** focused exclusively on AI use. No write paths cross between AICF and the three rating systems.

#### `ai_competency_self_assessments/{uid}_{academicYear}`
**PK:** composite — `{userId}_{academicYear}` (e.g. `abc123_2026-2027`). Append-only by design — annual submission creates a fresh doc per academic year so historical progression is preserved.
**Scope:** per-teacher annual self-assessment of Eduversal AICF v1.0 Part 1 (Teacher AI Competency).
**Fields:**
- Identity: `userId →users.uid`, `userEmail` (denormalised for audit), `displayName`, `platform` (`'teachers' | 'academic' | 'central'` — denormalised — the assessor's primary hub), `schoolId →partner_schools.id | null` (null for CH HQ staff).
- Cycle: `academicYear` (e.g. `'2026-2027'`), `cycleStartedAt`, `submittedAt`, `status` (`'draft' | 'submitted' | 'validated'`).
- Self-rating: `ratings` (nested map; the canonical shape `ratings[part][level][domain] = ratingValue`). Today only `part = 'teacher'`. Example: `ratings.teacher.foundation.domainA = 'achieved'`. Levels: `foundation | practitioner | leader`. Domains: `domainA | domainB | domainC | domainD | domainE`. Rating values: `not_yet | developing | achieved`.
- Self-declared level: `selfDeclaredLevel` (`'foundation' | 'practitioner' | 'leader'`) — computed client-side as the highest level where the majority of the 5 domains are `achieved`. Server validates on write.
- Free-text reflection: `strengths[]`, `growthAreas[]`, `professionalLearningGoals[]` — each ≤ 5 entries, each entry ≤ 280 chars.
- Validation: `validation` (nested map, only writable by line manager):
  - `validatedBy →users.uid` (line manager — typically AH `school_principal` / `academic_admin` for same-school AH+TH staff, CH `coordinator` / `director` / `central_admin` for CH staff)
  - `validatedAt` (Timestamp)
  - `agreedLevel` (`'foundation' | 'practitioner' | 'leader'`) — may differ from `selfDeclaredLevel`
  - `managerNotes` (string ≤ 1000 chars)

**FKs:** `users.uid` (via `userId`); `partner_schools.id` (via `schoolId` for school-scoped rule queries).
**Indexes:** composite on `(schoolId, academicYear)` for line-manager queries listing same-school direct reports per cycle; composite on `(platform, academicYear, status)` for network-level aggregate Cloud Function.
**Write scope:**
- **Self-CREATE + self-UPDATE while `status == 'draft'`:** the user (`request.auth.uid == userId`). The user may resubmit drafts as many times as needed before the line manager validates.
- **Self-SUBMIT (flip `status` → `'submitted'`):** the user. After submission, `ratings` / `selfDeclaredLevel` / `strengths` / `growthAreas` / `professionalLearningGoals` become immutable.
- **Line-manager validate (write `validation.*` + flip `status` → `'validated'`):** for same-school AH leadership (`school_principal` / `academic_admin`) when the assessor is at the same school; for `coordinator` / `director` / `central_admin` when the assessor is CH staff. Other fields immutable at this stage.
- **Delete:** `central_admin` only.

**Read scope:**
- Owner (self) always.
- Same-school AH `school_principal` / `academic_admin` (when both sides' `schoolId` matches).
- CH `director` / `coordinator` / `central_admin` (network-wide).
- Append-only history preserved: historical years' docs visible to line managers for trend analysis.

**Notes:**
- Doc id deterministic by `{userId}_{academicYear}` — re-running the seed or re-opening a submitted assessment routes back to the same doc (idempotent against accidental duplicates).
- `validation` sub-map remains absent until the line manager fills it in. Reader UI shows "Not yet validated" if missing.
- 5 domains × 3 levels = 15 rating cells. Client validates that submission requires at least the 5 Foundation-level cells to be filled (rating ∈ `not_yet | developing | achieved`); Practitioner + Leader cells are optional (a teacher genuinely at Foundation marks Foundation and leaves higher cells empty).

#### `ai_maturity_assessments/{schoolId}_{academicYear}`
**PK:** composite — `{schoolId}_{academicYear}`. One doc per school per academic year. Append-only across years.
**Scope:** per-school annual institutional maturity self-assessment (Eduversal AICF v1.0 Part 3 — 5 maturity levels × 6 domains). Validated by Eduversal Academic Directorate during the school appraisal visit.
**Fields:**
- Identity: `schoolId →partner_schools.id`, `schoolName` (denormalised), `academicYear`.
- Submission: `submittedBy →users.uid` (typically `school_principal` or `academic_admin`), `submittedAt`, `status` (`'draft' | 'submitted' | 'appraised'`).
- Domain ratings: `domainRatings` (nested map, shape `domainRatings[domainId]` = `{ currentLevel, evidence[], strengths[], improvementAreas[], targetLevel }`). The 6 domain IDs: `strategy_leadership | policy_compliance | staff_capability | teaching_learning | student_outcomes | infrastructure_resources`. Each `currentLevel` and `targetLevel` is an integer 1-5. `evidence[]` items are ≤ 500 chars each, ≤ 8 entries per domain. `strengths[]` and `improvementAreas[]` are ≤ 5 entries each, ≤ 280 chars each.
- Computed: `overallLevel` (integer 1-5, rounded average across 6 domains — computed client-side, server validates).
- Priority actions: `priorityActions[]` (≤ 6 entries, ≤ 280 chars each) — what the school commits to advance for the coming year.
- Appraisal (only writable by CH appraiser):
  - `appraisal.appraiserUid →users.uid` (CH `director` / `central_admin`)
  - `appraisal.appraisedAt` (Timestamp)
  - `appraisal.validatedDomainRatings` (same shape as `domainRatings`; appraiser-adjusted)
  - `appraisal.validatedOverallLevel` (integer 1-5)
  - `appraisal.appraiserNotes` (string ≤ 2000 chars)
  - `appraisal.recommendations[]` (≤ 8 entries, ≤ 280 chars each) — Eduversal-level recommendations for the school

**FKs:** `partner_schools.id` (PK component); `users.uid` (via `submittedBy` and `appraisal.appraiserUid`).
**Indexes:** composite on `(academicYear, status)` for network-level reporting; composite on `(schoolId, academicYear)` for school-level history queries.
**Write scope:**
- **CREATE + UPDATE while `status == 'draft' | 'submitted'`:** AH `school_principal` / `academic_admin` for own school (`request.auth.uid` writes to a doc whose `schoolId` matches their `users/{uid}.schoolId`); CH `central_admin` for any school.
- **Appraisal validate (write `appraisal.*` + flip `status` → `'appraised'`):** CH `director` / `central_admin`. After appraisal, all fields except `appraisal.*` immutable.
- **Delete:** `central_admin` only.

**Read scope:**
- Same-school AH leadership (`school_principal` / `academic_coordinator` / `foundation_representative` / `academic_admin`).
- CH `director` / `coordinator` (network-wide for benchmarking) / `central_admin`.
- Submitted but pre-appraisal docs visible to appraisers via CH `/ai-maturity-admin` triage queue.

**Notes:**
- Schools self-assess honestly even if Level 1-2. Eduversal v1.0 explicitly accepts that "most schools in 2026 honestly sit at Level 1-2 on most domains" (`leader-playbook.json#institutionalMaturity`). Inflation is a red line (`redFlagsAndRedlines.json#rl_10_no_inflated_self_assessment`).
- Two-domain rule (Eduversal v1.0): each school targets at-most-two domains per year for level advancement. `priorityActions[]` typically names two.
- Appraisal team often adjusts `validatedDomainRatings` down from `domainRatings` when evidence does not support the self-rating. Adjustment up is rarer but possible.

#### `ai_competency_aggregates/{aggregateId}`
**PK:** two namespaces in the same collection:
- School-level: `{schoolId}_{academicYear}` (e.g. `partner-fatih_2026-2027`).
- Network-level: `network_{academicYear}` (e.g. `network_2026-2027`).
**Scope:** Cloud-Function-maintained read-only summaries powering school benchmarking dashboards and network-level AI integration reports. Saves clients from on-the-fly aggregation across thousands of self-assessments.
**Fields (school-level docs):**
- Identity: `schoolId →partner_schools.id`, `academicYear`, `schopeKind: 'school'`.
- Staff competency distribution: `staffCounts` (nested map; shape `staffCounts[selfDeclaredLevel] = number`, e.g. `{ foundation: 18, practitioner: 5, leader: 1, unsubmitted: 3 }`). `submissionRate` (decimal — submitted ÷ eligible staff).
- Validation lag: `pendingValidationCount`, `medianDaysToValidation`.
- Institutional maturity: `institutionalCurrentLevel` (overall), `institutionalDomainLevels[6]`, `institutionalAppraised` (boolean — true if the school's `ai_maturity_assessments` doc for this year reached `appraised` status).
- Trend (year-on-year, when 2+ years of data): `previousOverallLevel`, `levelDelta`, `previousStaffPractitionerCount`, `practitionerDelta`.
- Audit: `recomputedAt`, `recomputedBy` (Cloud Function name).

**Fields (network-level docs):**
- Identity: `academicYear`, `scopeKind: 'network'`.
- Network-wide staff counts: same shape as school-level but summed across all partner schools.
- Network-wide institutional ladder: `schoolsByMaturityLevel` (shape `{ 1: 4, 2: 8, 3: 2, 4: 0, 5: 0 }` — count of schools at each level).
- Domain heatmap: `networkDomainMedian[6]` (median current level across schools per domain).
- Top + bottom schools per domain (anonymised — `schoolId` only, no names; used for appraiser benchmarking): `topSchoolsByDomain[domainId][]` (top 3 schoolIds), `bottomSchoolsByDomain[domainId][]` (bottom 3 schoolIds).
- Audit: `recomputedAt`.

**FKs:** `partner_schools.id` (school-level docs only).
**Indexes:** none required (queried by exact docId).
**Writers:** **Cloud Function only** — `rebuildAiCompetencyAggregates` runs on a weekly schedule (Mondays 02:00 Asia/Jakarta) and on-demand when an `ai_maturity_assessments` doc flips to `appraised`. Admin SDK bypasses rules.
**Read scope:**
- School-level docs: same-school AH leadership + all CH `director` / `coordinator` / `central_admin`.
- Network-level docs: CH `director` / `coordinator` / `central_admin` only (network-comparative data not intended for school-side audiences).

**Notes:**
- Aggregates are **stale by design** — clients display `recomputedAt` so users know the data may be up to a week old. Real-time querying across all schools would be cost-prohibitive (Firestore read amplification).
- The `topSchoolsByDomain` / `bottomSchoolsByDomain` arrays exist to support appraiser benchmarking conversations ("School X at Level 4 on Staff Capability has these patterns we can share"), not for public ranking — Eduversal v1.0 explicitly avoids school ranking as a tool of comparison.

**Phase 3 wiring (forward reference):** Phase 3 adds the appraisal UI surfaces — AH `/ai-maturity-self-assessment` (school-side submission) + CH `/ai-maturity-admin` (Academic Directorate triage queue) + the `rebuildAiCompetencyAggregates` Cloud Function deploy. Phase 2 only ships the data shape + rules. The two phases can ship a week apart without breaking each other.

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

_Last sync with rules: 2026-05-11 — `Central Hub/firestore.rules`_
