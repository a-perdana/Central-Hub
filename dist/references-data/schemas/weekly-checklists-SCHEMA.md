# Weekly Checklist JSON Schema — v1.0

Source-of-truth for the `weekly_templates/{academicYear}_w{NN}_{platform}` Firestore docs that power the **weekly-checklist** module across CH / AH / TH.

## Why JSON-first

Eight sub-role tabs already exist in the UI (`Academic Hub/weekly-checklist.html`, `Teachers Hub/weekly-checklist.html`, `Central Hub/weekly-checklist.html`). Each tab's task list is currently **empty by default** — admins are expected to populate every week, every year, by hand. That has not happened in production. The result: empty UI, no governance value.

This folder fixes that. One JSON per sub-role, version-controlled. A seed script expands each JSON into the 40 weekly Firestore docs the UI already reads from. Admins keep the right to edit / add / hide tasks per school via the existing admin panel — but they start from a Network Default, not from a blank slate.

## File naming

```
docs/weekly-checklists/
├── SCHEMA.md                          ← this file
├── README.md                          ← provenance + how to seed
├── _academic-year-arc.json            ← shared calendar anchors (Indonesian + Cambridge)
├── subject-teacher.json               (TH platform key: 'teachers')
├── subject-leader.json                (TH platform key: 'subject_leader')
├── school-principal.json              (AH platform key: 'school_principal')
├── academic-coordinator.json          (AH platform key: 'academic_coordinator')
├── cambridge-coordinator.json         (AH platform key: 'cambridge_coordinator')
├── foundation-representative.json     (AH platform key: 'foundation_representative')
├── subject-specialist.json            (CH platform key: 'coordinator')
└── director.json                      (CH platform key: 'director')
```

The `platform` value matches the existing `data-tab` attribute and the doc-id segment in `weekly_templates/{year}_w{NN}_{platform}` and `weekly_progress/{uid}_{year}_w{NN}_{platform}`.

## Top-level JSON shape

```json
{
  "schema_version": "1.0",
  "platform": "subject_teacher",
  "platform_label": "Subject Teacher",
  "hub": "teachershub",
  "audience_description": "Classroom teachers in partner schools delivering Cambridge + national curriculum.",
  "version": "1.0",
  "effective_date": "2026-07-01",
  "academic_year": "2026-2027",
  "total_weeks": 40,

  "regulatory_anchors": [
    { "code": "PERMENDIKBUD_6_2018", "title": "...", "relevance": "..." }
  ],

  "framework_anchors": {
    "cambridge_teacher_standards_2023": "Used for D1 Professional Knowledge tasks",
    "appraisal_framework_v2_1": "F1-F4 evidence accumulates through these tasks",
    "competency_framework_track": "teachers"
  },

  "task_categories": {
    "C1": "Lesson Planning & Curriculum",
    "C2": "Instructional Practice",
    "C3": "Assessment & Feedback",
    "C4": "Professional Development",
    "C5": "Compliance & Administration",
    "C6": "Stakeholder Engagement"
  },

  "priority_levels": {
    "compliance": "Legally required or contractually required by Cambridge / Eduversal. Non-negotiable.",
    "core": "Essential to effective performance of the role. Strongly expected.",
    "recommended": "Best practice. Adopt where school context allows."
  },

  "recurring_tasks": [
    {
      "id": "TT-C1-001",
      "title": "Submit lesson plans for the coming week",
      "description": "Plain-language description of what 'done' looks like for someone new to the role.",
      "category": "C1",
      "priority": "compliance",
      "cadence": "weekly",
      "applies_to_weeks": "all",
      "specific_timing": "Friday by 16:00 of the preceding week",
      "duration_estimate_minutes": 90,
      "evidence_required": [
        "Lesson plans submitted via the school LMS for every period in the coming week"
      ],
      "regulatory_anchor": ["PERMENDIKBUD_6_2018 (perencanaan)"],
      "framework_anchor": ["appraisal_v2_1 F2", "CTS 4.1", "CTS 4.2"],
      "first_time_guide": "Step-by-step for a teacher in their first month — what tools, what fields, who reviews.",
      "missed_threshold_action": "If submitted late on three consecutive Fridays, the HoD initiates a Lesson Plan Support Plan (Section 6 of the Academic Leadership Governance Handbook).",
      "competency_link": "smc-2"
    }
  ],

  "yearly_arc": {
    "1": {
      "week_label": "Orientation Week",
      "phase": "August — Tahun ajaran baru begins",
      "focus": "Establishing routines, learning student names, baseline diagnostic",
      "tasks": [
        {
          "id": "TT-W01-001",
          "title": "Establish 3 non-negotiable classroom routines",
          "description": "...",
          "category": "C2",
          "priority": "core",
          "evidence_required": ["Routine notes filed in the teacher's IPDL"],
          "first_time_guide": "..."
        }
      ]
    },
    "2": { },
    "...": "...",
    "40": { }
  },

  "induction_overlay": {
    "applies_when": "users.induction_status in {pre_arrival, first_week, foundation, mastery_building, integration}",
    "extra_tasks_first_12_weeks": [
      {
        "id": "TT-IND-001",
        "title": "First fortnightly mentor meeting",
        "description": "...",
        "applies_to_weeks": [2, 4, 6, 8, 10, 12],
        "category": "C4",
        "priority": "compliance"
      }
    ]
  },

  "data_sources": {
    "writes_to": [
      "weekly_progress/{uid}_{academicYear}_w{NN}_{platform}",
      "competency_evidence/{evId} (when task uploads evidence)"
    ],
    "reads_from": [
      "weekly_templates/{academicYear}_w{NN}_{platform}",
      "weekly_essentials/{platform}"
    ]
  }
}
```

## Field semantics

### `recurring_tasks[]`
Tasks that repeat every week (or every Nth week). The seeder expands these into every applicable week. A task with `cadence: "weekly"` lands in all 40 weeks; `cadence: "fortnightly"` lands on even weeks; `cadence: "monthly"` on weeks 4, 8, 12, 16, 20, 24, 28, 32, 36, 40; `cadence: "termly"` on weeks 1, 18 (Sem-1 start, Sem-2 start); `cadence: "annually"` lands once on the week specified in `applies_to_weeks`.

### `yearly_arc.{NN}.tasks[]`
Tasks that belong to a specific week because of where they sit in the academic calendar (e.g. baseline diagnostic in W2, parent-teacher conference prep in W12, end-of-semester moderation in W18). These are **additive** to the recurring tasks.

### `induction_overlay`
For roles with a Year-1 induction track (`subject_teacher`, `school_principal`, `coordinator` (CH Subject Specialist)), an extra layer of tasks appears in the first 12 weeks for users whose `induction_status` is non-completed. This connects the Weekly Checklist module to the Induction module without duplicating content.

### `competency_link`
String slug that maps the task to a `competency_framework/{trackId}.competencies[].id` doc — when the user marks the task complete, the UI can suggest "this counts as evidence toward competency XYZ at level practitioner". Optional but powerful: it converts daily ritual into competency-framework progress.

### `first_time_guide`
The Eduversal-specific innovation. Every task has a 2-3 sentence description aimed at someone in their **first three months** in the role. Names tools, file paths, named contacts ("see your HoD"), where outputs are filed. This is the difference between a checklist and a step-by-step rehber.

## ID convention

```
{ROLE_PREFIX}-{CATEGORY}-{NNN}        for recurring tasks
{ROLE_PREFIX}-W{NN}-{NNN}             for week-specific tasks
{ROLE_PREFIX}-IND-{NNN}               for induction-overlay tasks
```

Role prefixes:
- `TT` — Subject Teacher
- `SL` — Subject Leader
- `SP` — School Principal (cross-references existing `T-P{N}-{NNN}` ids in `principal-operating-cadence.json`)
- `AC` — Academic Coordinator
- `CC` — Cambridge Coordinator (Cambridge Exam Officer)
- `FR` — Foundation Representative
- `SS` — Subject Specialist (CH)
- `DR` — Director (CH)

## How the seeder uses this

The seed script `scripts/weekly-checklists/seed-weekly-checklists.js` reads each role JSON and:

1. For week `NN ∈ {1..40}`, computes the union of:
   - all `recurring_tasks` whose cadence matches `NN`
   - all tasks in `yearly_arc[NN].tasks[]`
   - all `induction_overlay.extra_tasks_first_12_weeks` (only flagged for induction-status users — the UI filters at read time)
2. Writes the resulting task array to `weekly_templates/{academicYear}_w{padNN}_{platform}` with `merge: true`
3. Writes the role's standing-essential tasks to `weekly_essentials/{platform}`
4. Logs every doc written for audit-trail

Re-running is safe — `merge: true` preserves admin overrides; admins can hide a network-default task at school level via the existing admin UI (the read path layers school overrides on top of templates).

## Multi-school overrides

A school admin who wants to remove or replace a network-default task does NOT edit the JSON. They edit the rendered template in the existing admin UI (which writes to `weekly_templates_overrides/{schoolId}_{academicYear}_w{NN}_{platform}` — to be added in Phase 2). The read order is:

1. `weekly_templates_overrides/{schoolId}_..._{platform}` (school-specific)
2. `weekly_templates/{academicYear}_w{NN}_{platform}` (network default)
3. `weekly_essentials/{platform}` (standing items, all weeks)

Phase 1 (now): network-default seeding only. Phase 2: per-school overrides UI.

## Provenance

Each JSON file ends with a `provenance` block listing every external source quoted, summarised, or paraphrased — Permendikbud / Permendikdasmen articles, Cambridge documents, Semesta Academic Leadership Governance Handbook (where adopted), Eduversal Network Standards. Provenance is mandatory: no task may exist without a regulatory or framework anchor traceable to a primary document.

## Status

| Role | JSON file | Status |
|---|---|---|
| Subject Teacher | `subject-teacher.json` | drafting |
| Subject Leader | `subject-leader.json` | drafting |
| School Principal | `school-principal.json` | derived from `principal-operating-cadence.json` |
| Academic Coordinator | `academic-coordinator.json` | drafting |
| Cambridge Coordinator | `cambridge-coordinator.json` | drafting |
| Foundation Representative | `foundation-representative.json` | drafting |
| Subject Specialist (HQ) | `subject-specialist.json` | drafting |
| Director (HQ) | `director.json` | drafting |
