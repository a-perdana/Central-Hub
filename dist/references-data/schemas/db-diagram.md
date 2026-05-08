# Firestore ER Diagram — `centralhub-8727b`

Visual companion to [`FIRESTORE_SCHEMA.md`](FIRESTORE_SCHEMA.md). The schema doc is authoritative for fields and rules; this doc is the picture you scan when you want to **see** how things connect.

GitHub renders the Mermaid blocks below as diagrams. In a code editor without Mermaid, install the [Markdown Preview Mermaid Support](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid) extension or use [mermaid.live](https://mermaid.live).

> **Cardinality notation** (Mermaid):
> `||--o{` = one to many ·
> `||--o|` = one to optional one ·
> `}o--o{` = many to many.
> Lines are labelled with the FK field name on the child side.

---

## 1. Identity Core

The shape every other diagram hangs off. `users` and `partner_schools` are referenced by almost everything else.

```mermaid
erDiagram
    users {
        string uid PK
        string email
        string displayName
        string schoolId FK
        string school "denormalised name"
        string role_centralhub
        string role_academichub
        string role_teachershub
        string role_researchhub
        array  ch_sub_roles
        array  ah_sub_roles
        array  th_sub_roles
        string approval_status_academichub
        string approval_status_teachershub
        array  subjects "TH only"
        array  classes "TH only"
        timestamp createdAt
        timestamp lastLoginAt
    }
    partner_schools {
        string schoolId PK
        string name
        string domain "drives email auto-default"
        string city
        string status
    }
    classes {
        string classId PK
        string name
        int    grade
        string section
    }

    partner_schools ||--o{ users          : "users.schoolId"
    partner_schools ||--o{ classes        : "subcollection"
```

---

## 2. Pacing & Progress

Teachers track their week-by-week progress against admin-managed pacing structures. `userProgress` is the single cumulative doc per teacher; `weekly_progress` is per-week per-teacher per-platform.

```mermaid
erDiagram
    users ||--o| userProgress             : "doc id = uid"
    users ||--o{ weekly_progress          : "userId"
    partner_schools ||--o{ userProgress   : "schoolId (denormalised)"
    partner_schools ||--o{ weekly_progress : "schoolId (sometimes)"

    math_pacing ||..|| userProgress       : "subject keyed pacingDone"
    biology_pacing ||..|| userProgress    : ""
    chemistry_pacing ||..|| userProgress  : ""
    physics_pacing ||..|| userProgress    : ""
    asalevel_math_pacing ||..|| userProgress : ""
    checkpoint_math_pacing ||..|| userProgress : ""

    weekly_templates ||..o{ weekly_progress : "platform + week"
    weekly_essentials ||..o{ weekly_progress : "platform"

    userProgress {
        string uid PK
        string schoolId FK
        string subject
        string subjectKey
        int    overallPct
        map    statuses "{ci-ti: pending|inprogress|done|revisit}"
        map    pacingDone_subject
        timestamp lastUpdatedAt
    }

    weekly_progress {
        string docId PK "userId_year_wNN_platform"
        string userId FK
        string schoolId FK
        int    weekNumber
        string academicYear
        string platform
        map    items
        map    essentials
        string journalHtml
        int    completedCount
        int    totalCount
        timestamp updatedAt
    }
```

**Key cardinalities:**
- `users 1—1 userProgress` — exactly one cumulative doc per teacher (doc id == uid).
- `users 1—N weekly_progress` — one doc per (week × platform) per teacher.
- The `*_pacing` collections are reference data (one doc per year), each `userProgress.pacingDone_<subject>` is a denormalised slice of the relevant pacing's status.

---

## 3. Appraisals

Three parallel appraisal flows: formal (`teacher_appraisals`), self (`teacher_self_appraisals`), and walkthrough (`teacher_walkthroughs`).

```mermaid
erDiagram
    users {
        string uid PK
    }
    partner_schools {
        string schoolId PK
    }
    appraisal_cycles {
        string cycleId PK
        string name
        date   startDate
        date   endDate
        string status
    }
    teacher_appraisals {
        string id PK
        string teacherUid FK
        string appraiserUid FK
        string schoolId FK
        string subject
        string teacherName "denormalised"
        string status "draft|shared|acknowledged|finalised"
        bool   disputed
    }
    teacher_self_appraisals {
        string docId PK "userId_year"
        string userId FK
        string displayName "denormalised"
        string status "draft|submitted"
    }
    teacher_walkthroughs {
        string id PK
        string teacherUid FK
        string observerUid FK
        string schoolId FK
        array  tags
    }
    school_appraisals_v2 {
        string id PK
        string schoolId FK
        map    domains "1..5 ratings + evidence"
        string status
    }
    calibration_sessions {
        string docId PK "userId_year"
        string userId FK
    }

    users ||--o{ teacher_appraisals       : "teacherUid"
    users ||--o{ teacher_appraisals       : "appraiserUid"
    users ||--o{ teacher_self_appraisals  : "userId"
    users ||--o{ teacher_walkthroughs     : "teacherUid"
    users ||--o{ teacher_walkthroughs     : "observerUid"
    users ||--o{ calibration_sessions     : "userId"

    partner_schools ||--o{ teacher_appraisals    : "schoolId"
    partner_schools ||--o{ teacher_walkthroughs  : "schoolId"
    partner_schools ||--o{ school_appraisals_v2  : "schoolId"

    appraisal_cycles ||..o{ teacher_appraisals : "informational; not enforced"
```

**Notes:**
- `teacher_self_appraisals.docId` follows the pattern `{uid}_{academicYear}` so an evaluator can construct the doc id deterministically and `get` it without a list query.
- `teacher_appraisals.teacherName` is denormalised; refresh policy lives in the schema doc.

---

## 4. KPI System

Two KPI tracks: **school-level** (`kpi_*`, `school_performance_kpi`, `kpi_school_submissions`) and **teacher-level** (`teacher_kpi_*`). They use overlapping config but different submission flows.

```mermaid
erDiagram
    users {
        string uid PK
        string schoolId FK
    }
    partner_schools {
        string schoolId PK
    }

    kpi_config {
        string kpiId PK
        string title
        string criterion
    }
    kpi_settings {
        string semId PK
        string semesterName
    }
    school_performance_kpi {
        string semId "parent path"
        string schoolId "child path = doc id"
        map    scores
    }
    kpi_school_submissions {
        string submId PK
        string schoolId FK
        string semesterId FK
        string status "pending|approved|rejected|under_review"
    }

    teacher_kpi_config {
        string kpiId PK
        string title
        string criterion
    }
    teacher_kpi_settings {
        string periodId PK
        string periodName
        date   periodStart
        date   periodEnd
    }
    teacher_kpi_submissions {
        string submId PK "userId_periodId"
        string userId FK
        string schoolId FK
        string periodId FK
        map    assessments
        string status
    }
    teacher_kpi_evaluations {
        string submId PK "matches submission id"
        string evaluatorUid FK
        map    ratings
        string status
    }
    kpi_meeting_proposals {
        string proposalId PK
        string submissionId FK
        string teacherUid FK
        string evaluatorUid FK
        string status "pending|confirmed|declined"
    }

    partner_schools ||--o{ school_performance_kpi  : "schoolId path"
    partner_schools ||--o{ kpi_school_submissions  : "schoolId"
    kpi_settings ||--o{ school_performance_kpi    : "semId path"
    kpi_settings ||--o{ kpi_school_submissions    : "semesterId"

    users ||--o{ teacher_kpi_submissions          : "userId"
    partner_schools ||--o{ teacher_kpi_submissions : "schoolId"
    teacher_kpi_settings ||--o{ teacher_kpi_submissions : "periodId"

    teacher_kpi_submissions ||--o| teacher_kpi_evaluations : "1:1 by id"
    users ||--o{ teacher_kpi_evaluations          : "evaluatorUid"

    teacher_kpi_submissions ||--o{ kpi_meeting_proposals : "submissionId"
    users ||--o{ kpi_meeting_proposals            : "teacherUid"
    users ||--o{ kpi_meeting_proposals            : "evaluatorUid"
```

**Critical invariant:** `teacher_kpi_submissions` REQUIRES a `schoolId` field on every write. The Firestore rule rejects writes where `schoolId != userProfile().schoolId`. The composite index `(periodId, schoolId)` is required by the AH evaluator query.

---

## 5. Comms, Surveys, Documents

The flat content collections every user reads.

```mermaid
erDiagram
    users {
        string uid PK
    }
    announcements {
        string annId PK
        string title
        string body
        string category
        bool   pinned
    }
    comments {
        string commentId PK
        string body
        string authorId FK
    }
    announcement_reads {
        string docId PK "annId__uid"
        string annId FK
        string userId FK
        timestamp readAt
    }
    topics {
        string topicId PK
        string title
        string body
        string author "email"
        string status
    }
    replies {
        string replyId PK
        string body
        string authorId FK
    }
    surveys {
        string surveyId PK
        string title
        array  platforms
        string status "draft|published"
        bool   allowResponses
    }
    survey_responses {
        string respId PK
        string surveyId FK
        string userId FK
        string platform
        array  answers
    }
    documents {
        string docId PK
        string title
        string fileUrl
        string subject
    }
    central_documents {
        string docId PK
        string title
        string fileUrl
    }
    library {
        string resourceId PK
        string title
        string url
    }
    doc_likes {
        string likeId PK
        string userId FK
        string docId FK
    }
    doc_ratings {
        string ratingId PK
        string userId FK
        string docId FK
        int    rating
    }
    feedback {
        string fbId PK
        string body
        string status
    }
    feedbacks {
        string fbId PK
        string body
    }

    announcements ||--o{ comments           : "subcollection"
    announcements ||--o{ announcement_reads : "annId"
    users ||--o{ announcement_reads         : "userId"
    users ||--o{ comments                   : "authorId"

    topics ||--o{ replies                   : "subcollection"
    users ||..o{ topics                     : "author = email"
    users ||--o{ replies                    : "authorId"

    surveys ||--o{ survey_responses         : "surveyId"
    users ||--o{ survey_responses           : "userId"

    documents ||--o{ doc_likes              : "docId"
    documents ||--o{ doc_ratings            : "docId"
    users ||--o{ doc_likes                  : "userId"
    users ||--o{ doc_ratings                : "userId"
    users ||--o{ feedback                   : "userId (loose)"
    users ||--o{ feedbacks                  : "userId (loose)"
```

**Note:** `feedback` and `feedbacks` are still two separate collections — see the standardisation backlog.

---

## 6. Configuration & Access Control

```mermaid
erDiagram
    users {
        string uid PK
        array  ah_sub_roles
        array  th_sub_roles
        array  ch_sub_roles
    }
    page_access_config {
        string pageKey PK
        string platform
        string label
        array  visible_to "sub-role values"
    }
    ah_categories {
        string catId PK
        string name
        array  visible_to
    }
    th_resource_sections {
        string secId PK
        string name
        array  visible_to
    }
    nav_config {
        string platform PK "centralhub|academichub|teachershub"
        array  items "{key,label,group,order,hidden}"
    }
    sidebar_config {
        string docId PK
        array  order
    }
    weekly_essentials {
        string platform PK "doc id = platform/sub-role"
        array  items
    }
    weekly_templates {
        string docId PK
        string platform
        int    weekNumber
        array  tasks
    }

    users ||..o{ page_access_config    : "ah_sub_roles ∩ visible_to (UI gate)"
    users ||..o{ ah_categories         : "ah_sub_roles ∩ visible_to (UI gate)"
    users ||..o{ th_resource_sections  : "th_sub_roles ∩ visible_to (UI gate)"
    users ||..o{ weekly_essentials     : "platform / sub-role"
    weekly_templates ||..o{ weekly_progress : "informational"
```

**Note:** All four of these `visible_to`-style references are **client-side filters** today — Firestore rules don't enforce the intersection. See the standardisation backlog.

---

## 7. Cambridge Curriculum (read-only reference)

```mermaid
erDiagram
    cambridge_syllabus {
        string docId PK "subjectCode_syllabusCode"
        string code
        string title
        string tier "Core|Extended"
        string topicArea
        string subjectCode
    }
    cambridge_scheme_of_work {
        string docId PK "subjectCode_code"
        string code
        string title
        array  learningObjectives
        array  teachingActivities
        array  resources
    }
    cambridge_syllabus_progression {
        string subjectCode PK
        array  rows "stage7|stage8|stage9 mapping"
    }
    km_curriculum {
        string docId PK "km-subject-kelas-N-bab-M"
        string subject
        string fase
        int    grade
        string textbook
        string bab_title
    }
    curriculum_master_topics {
        string docId PK "topic-subject-TOPIC_ID"
        string topic_name
        string concept_family
        array  cambridge_coverage
        array  km_coverage
        map    comparison
    }

    cambridge_syllabus ||..o{ cambridge_scheme_of_work : "same docId convention"
    cambridge_syllabus_progression ||..o{ cambridge_syllabus : "rows reference codes"
    curriculum_master_topics ||..o{ cambridge_syllabus : "cambridge_coverage[].codes[]"
    curriculum_master_topics ||..o{ km_curriculum   : "km_coverage[].km_curriculum_doc_id"
```

---

## 8. Activities Board

```mermaid
erDiagram
    users {
        string uid PK
    }
    activity_projects {
        string projectId PK
        string title
        string status
    }
    activity_tasks {
        string taskId PK
        string projectId FK
        string title
        string status
        array  assigneeUids
    }
    activity_groups {
        string groupId PK
        string name
        array  memberUids
    }

    activity_projects ||--o{ activity_tasks : "projectId"
    users ||..o{ activity_tasks            : "assigneeUids[]"
    users ||..o{ activity_groups           : "memberUids[]"
```

---

## 9. Calendar & Events

```mermaid
erDiagram
    users {
        string uid PK
    }
    partner_schools {
        string schoolId PK
    }
    calendar_settings {
        string docId PK "always 'current'"
        date   academicYearStart
        int    totalTeachingWeeks
        array  terms
    }
    calendar_events {
        string docId PK
        string title
        string category
        date   date_start
        date   date_end
    }
    cambridge_calendar {
        string docId PK
        date   examStart
        date   examEnd
        string series
    }
    school_events {
        string eventId PK
        string schoolId FK
        string schoolName "denormalised"
        string title
        date   date_start
        date   date_end
        string createdBy FK
    }
    teaching_schedule {
        string docId PK
        array  weeks
    }
    timeline_activities {
        string actId PK
        string title
        date   date
    }
    timeline_completions {
        string compId PK
        string activityId FK
        string userId FK
        timestamp completedAt
    }

    partner_schools ||--o{ school_events       : "schoolId"
    users ||--o{ school_events                 : "createdBy"
    timeline_activities ||--o{ timeline_completions : "activityId"
    users ||--o{ timeline_completions          : "userId"
```

---

## 10. Competency Framework

```mermaid
erDiagram
    users {
        string uid PK
    }
    user_competencies {
        string uid PK "doc id = uid"
        map    earned "TH"
        map    matDone
        map    earned_academic "AH"
        map    matDone_academic
    }
    competency_evidence {
        string evId PK
        string userId FK
        string platform "teachers|academic"
        string compId
        string status "pending|approved|rejected"
        string fileUrl
    }
    comments_evidence {
        string commentId PK
        string body
        string authorUid FK
    }
    competency_certificates {
        string certId PK
        string userId FK
        string compId
        date   issuedAt
    }
    central_certificates {
        string certId PK
        string title
        string awardeeName
    }
    framework_config {
        string docId PK
        string title
        array  sampleDocs
    }
    content_overrides_academic {
        string docId PK "compId_lvl"
        string body
    }
    content_overrides_teachers {
        string docId PK "compId_lvl"
        string body
    }

    users ||--o| user_competencies            : "doc id = uid"
    users ||--o{ competency_evidence          : "uid"
    competency_evidence ||--o{ comments_evidence : "subcollection"
    users ||--o{ comments_evidence            : "authorUid"
    users ||--o{ competency_certificates      : "uid"
```

---

## 11. Audit, Recruitment, Misc

```mermaid
erDiagram
    users ||--o{ platform_usage    : "userId"
    users ||--o{ networkAudits     : "testerUid"
    partner_schools ||--o{ school_visits : "schoolId (in payload)"

    platform_usage {
        string docId PK
        string userId FK
        string platform
        string role
        timestamp ts
    }
    networkAudits {
        string auditId PK
        string testerUid FK
        map    results
    }
    school_visits {
        string visitId PK
        string schoolId
        date   visitDate
        string visitor
    }
    teacher_contacts {
        string contactId PK
        string name
        string email
    }
    mail_campaigns {
        string campaignId PK
        string subject
        int    recipientCount
        timestamp sentAt
    }

    orientation_resources {
        string docId PK
        string title
        string type
    }
    orientation_questions {
        string docId PK
        string question
    }
    orientation_registrations {
        string docId PK
        string applicantName
        string email
    }
    pathwaySubmissions {
        string docId PK
        string applicantName
    }
```

`teacher_contacts`, `mail_campaigns`, `orientation_*`, and `pathwaySubmissions` have no FKs into authenticated users — they are external-prospect data. `mail_campaigns` is written by the Railway mail service via the Admin SDK (bypasses rules).

---

## How to update this diagram

1. **Adding a new collection?**
   - Add a card to [`FIRESTORE_SCHEMA.md`](FIRESTORE_SCHEMA.md) first.
   - Pick the diagram section above that best fits its domain (or add a new one).
   - Use the same `||--o{` / `||..o{` cardinality conventions and label every relationship with the FK field name.
2. **Renaming a field?** Search this file for the old name and update both the entity definition and the relationship label.
3. **Big restructure?** Render the diagrams locally (mermaid.live) before committing — it's easy to introduce syntax errors that GitHub silently fails to render.

---

_Last sync with rules: 2026-05-03_
