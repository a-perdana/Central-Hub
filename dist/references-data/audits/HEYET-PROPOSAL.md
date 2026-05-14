# Eduversal Principal Development Programme (EPDP)
## Board Proposal — Closing the Ecosystem Loop

**Prepared by:** Eduversal Office of the Academic Director
**Date:** 2026-05-07
**Audience:** Eduversal Board of Directors + Yayasan Representatives + Partner-School Principal Council
**Decision sought:** Pilot approval (start July 2026) + 12-month full rollout (July 2027)

---

## 1. The proposal in one sentence

> **The Eduversal three-tier development ecosystem (HQ Specialists ↔ School Leadership ↔ Subject Teachers) is operating at the *teacher* and *HQ specialist* tiers; this proposal closes the missing loop by giving the *school leadership* tier — and specifically the school principal — the same evidence-anchored development infrastructure that teachers and specialists already enjoy.**

This is not a new product. It is the closing piece of a system that already exists.

---

## 2. The Eduversal Three-Tier Ecosystem (already in production)

```
┌──────────────────────────────────────────────────────────────────────┐
│  CENTRAL HUB (CH) — Eduversal HQ                                     │
│  ─ Directors (Primary / Secondary)                                   │
│  ─ Subject Specialists (Math / Eng / Bahasa / Phys / Chem / Bio /…)  │
│  ─ Coordinators (cross-functional)                                   │
│  Owns: school appraisals, network audit, framework definition,       │
│        page-access, mentor certification ledger, Mail Composer       │
└──────────────┬─────────────────────────────────────┬─────────────────┘
               │ visits + evaluates                  │ defines + reviews
               ▼                                     ▼
┌──────────────────────────────────────┐   ┌─────────────────────────┐
│  ACADEMIC HUB (AH) — Leadership      │   │  TEACHERS HUB (TH)      │
│  ─ Foundation Representative         │   │  ─ Subject Teacher      │
│  ─ School Principal                  │   │  ─ Subject Leader       │
│  ─ Academic Coordinator              │   │  ─ Interviewer          │
│  ─ Cambridge Exam Officer            │   │  ─ Hiring Manager       │
│  Owns: Teacher KPI evaluation,       │   │  Owns: own self-        │
│        Teacher Appraisal v2.1,       │   │        appraisal, KPI,  │
│        School Self-Appraisal v2,     │   │        weekly checklist,│
│        leadership weekly checklist   │   │        induction (Yr-1) │
└──────────────────┬───────────────────┘   └─────────┬───────────────┘
                   │ appraises + coaches             │
                   └─────────────────────────────────┘
```

### Two appraisal pathways already running

1. **Subject Specialists → Schools + Teachers.** During scheduled school visits, HQ Specialists evaluate the school as an institution (`school_appraisals_v2`, 5 domains × 31 aspects) and the teachers within their subject (`teacher_appraisals` v2.1).
2. **School Leadership → Teachers.** Principal / Academic Coordinator / Cambridge Exam Officer run KPI evaluations + Teacher Appraisal v2.1 + Classroom Walkthroughs against their own staff.

### What's already in production

| Layer | Subject Teacher (TH) | Subject Leader (TH) | School Leadership (AH) — 4 sub-roles | HQ Specialist (CH) |
|---|---|---|---|---|
| **KPI** | self-submit + AH evaluator | self-submit + AH evaluator | evaluator only | — |
| **Teacher Appraisal v2.1** | F1–F4, A–F band, level-aware | F1–F4 + F3L Leadership | appraiser only | — |
| **Walkthrough v2.0** | observed | observed | observer | observer |
| **School Appraisal v2** | — | — | self-rates own school (5 domains) | reviews + validates |
| **Competency Framework** | `teachers` track 6×24, CTS 2023 | `teachers` track | `leaders` track 6×24, CSL 2023 | `specialists` track 6×24, hybrid |
| **Induction (Year-1)** | `handbook_subject_teacher_v2`, 5 stages, 12 mo | mentor (cert holder) | **`eduversal_principal_v1`, Listen→Diagnose→Act→Anchor, 12 mo — already in production** | `eduversal_specialist_v1`, 12 mo |
| **Weekly Checklist** | TH `weekly-checklist` (subject_teacher tab) | TH (subject_leader tab) | AH `weekly-checklist` (4 sub-role tabs) | CH variant |
| **Mentor Certification ledger** | — | `mentor_base` cert | — | `specialist_mentor_endorsement` |

### Per-school packaging (already in production)

`partner_schools.enabled_systems[] ⊂ {kpi, appraisal, competency, induction}` — the four systems are opt-in per partner school via the Central Hub `/schools` admin UI. Missing field = all enabled (back-compat); empty array = all disabled. Both AH and TH dashboards honour this on `authReady` and hide cards for systems the school hasn't enabled. Admins always bypass.

This is the "different programmes for different schools" mechanism the board approved in the Phase-3 ops cycle and that is now active.

---

## 3. Where the loop is broken (the only gap)

The teacher tier and the specialist tier are fully closed — every audience has KPI / Appraisal / Competency / Induction wrapped around them, with the four-flag packaging controlling per-school rollout.

**The school leadership tier is half-closed.**

| Layer | Teachers ✓ | HQ Specialists ✓ | School Leadership ⚠ |
|---|---|---|---|
| Competency Framework | ✓ `teachers` track | ✓ `specialists` track | ✓ `leaders` track |
| Induction (Year-1) | ✓ subject-teacher handbook | ✓ specialist handbook | ✓ principal handbook |
| Weekly Checklist UI | ✓ tab + tasks seeded | ✓ tasks seeded | ⚠ **tabs exist, tasks not seeded for school_principal** |
| Formal Summative Appraisal | ✓ Teacher Appraisal v2.1 | (specialists don't appraise themselves; appraised by Director) | ⚠ **principal has no appraisal — they only appraise others** |
| Formative Observation Rubric | ✓ Walkthrough v2.0 | — | ⚠ **no leadership observation rubric** |
| Coaching Cycle | ✓ via mentor (Year-1) + appraisal cycles | ✓ via Director + walkthrough cycle | ⚠ **no post-induction principal coaching cycle** |

**The principal is the one node in the network that evaluates everyone but is never evaluated, observed, or coached on a structured cadence after their first 12 months.** That breaks the ecosystem loop. EPDP closes it.

---

## 4. The two source files driving EPDP

The Office of the Academic Director has authored two production-grade JSON specifications:

### 4.1 Principal Operating Cadence ([`Academic Hub/resources/principal-operating-cadence.json`](../../Academic%20Hub/resources/principal-operating-cadence.json))
- 1529 lines; 83 tasks across 8 focus areas (P1–P8)
- 6 cadences: daily (10) · weekly (12) · monthly (19) · termly (17) · annually (21) · adhoc (4)
- 3 priority tiers: compliance (43) · core (30) · recommended (10)
- Each task carries: owner · regulatory anchor · evidence required · rubric indicator link · missed-threshold action
- 76 of 83 tasks (92%) link directly to a specific evidence indicator in the observation rubric

### 4.2 Principal Leadership Observation Rubric ([`Academic Hub/resources/principal-observation-rubric.json`](../../Academic%20Hub/resources/principal-observation-rubric.json))
- 457 lines; 8 focus areas × 55 evidence indicators
- 3 response codes: E (Established) · D (Developing) · N (Not Observed) — *formative, no numerical score*
- 5 narrative fields + 14 metadata fields
- Anchored to Permendiknas 13/2007 (5 competencies), 8 SNP, Cambridge Centre Approval, PSEL + Robinson + Hallinger + Bryk & Schneider + Fullan

These two files are the missing content that the existing Eduversal infrastructure has space for but has not yet been given.

---

## 5. EPDP — five components that complete the ecosystem

| # | Component | Status of underlying infrastructure | What EPDP adds |
|---|---|---|---|
| **1. Cadence-based Weekly Checklist** | AH `weekly-checklist.html` school_principal tab **already exists** | Seed the 83 cadence tasks (Phase 1 starts with 73 = compliance + core; recommended 10 in Phase 2) |
| **2. Leadership Observation Rubric** | AH `ObservationEntry.html` `?type=formal_evaluation` **already exists** for Q4 induction | Add `?type=principal_leadership` variant: 8 foci × E/D/N + 5 narrative + 14 metadata |
| **3. Principal Coaching Cycle** | Mentor-mentee infrastructure exists for Year-1 only | New `principal_coaching_sessions/{sessionId}` collection + `/principal-coaching` page; runs *post-induction* |
| **4. Principal Annual Appraisal Framework v1.0** | Teacher Appraisal Framework v2.1 schema **already exists** as template | New `principal-appraisal-framework-v1.json` (5 frameworks F1–F5, A–F band, level-aware) — schema cloned from Teacher v2.1 |
| **5. Principal 360° Feedback** | Survey infrastructure (Student/Staff/Parent) exists at school level | New `principal_360_cycles/{cycleId}/responses/{respondentUid}` — termly, anonymous, ≥5-respondent threshold |

**Already in production — no work needed:**
- ✅ Principal Induction Handbook (`eduversal_principal_v1`, 12 months, Listen→Diagnose→Act→Anchor)
- ✅ Cambridge Leadership Competency Framework (`leaders` track, 6×24, all 4 AH sub-roles gated)
- ✅ Principal-as-evaluator pages (Teacher Appraisal Entry, KPI evaluation, Walkthrough, School Self-Appraisal)
- ✅ Mentor Certification ledger including `principal_mentor_endorsement` cert type
- ✅ Per-school packaging via `partner_schools.enabled_systems[]`

---

## 6. How EPDP reinforces the existing programmes (mutual support)

This is the heart of why we propose EPDP now: the new layer **strengthens every existing programme** rather than competing with them.

### 6.1 EPDP ↔ Teacher KPI
- Cadence task **T-P5-002** (monthly Teacher KPI review with school principal as evaluator) is logged in `principal_progress`. Compliance with this task feeds the principal's own F1 framework (Operating Cadence Compliance, weight 0.25).
- *Outcome:* the principal who runs Teacher KPI evaluations on time gets credit; the one who skips them is visible in their own appraisal. KPI module's quality of execution becomes auditable upward.

### 6.2 EPDP ↔ Teacher Appraisal v2.1
- The leadership observation rubric P5 (Staff Supervision, Development & Wellbeing) explicitly requires the principal to demonstrate live use of Teacher Appraisal v2.1 + appraiser calibration.
- Inter-rater reliability scores from `calibration_sessions` flow into F1.
- *Outcome:* Teacher Appraisal v2.1 stops being a paper exercise — its quality of administration becomes a measured leadership outcome.

### 6.3 EPDP ↔ School Appraisal v2 (HQ Specialist visit cycle)
- During the scheduled HQ Specialist visit (which produces `school_appraisals_v2`), the visiting Specialist now also conducts a `principal_observations` entry against the leadership rubric. Two layers of evidence collected in one visit.
- The school's d1 Leadership & Governance domain rating is independently triangulated by the principal observation rubric.
- *Outcome:* school self-appraisal of "leadership" is now externally validated; the data triangulation makes the School Appraisal v2 result more trustworthy.

### 6.4 EPDP ↔ Cambridge Leadership Competency Framework
- The 8 rubric foci (P1–P8) cross-map to the 6 `leaders` track domains (`evsi/cial/pdpc/ewsc/eao/fcep`).
- Every observation visit's Priority Development Area auto-suggests a `leaders` track competency to advance to the next level.
- *Outcome:* the competency framework stops being decorative — it becomes the principal's personalised CPD path, surfaced from observation findings rather than self-selected.

### 6.5 EPDP ↔ Principal Induction (already running)
- The principal induction handbook (`eduversal_principal_v1`) is a 12-month onboarding. EPDP starts on day 366. No overlap, no contradiction.
- Charter NN1 (induction data does not feed appraisal) is preserved: induction completion certificate is binary; the first formal Principal Annual Appraisal is at the end of Year 2.
- The induction handbook's Q4 formal evaluation pattern is already an observation rubric in microcosm; EPDP's rubric is the same shape, made permanent.
- *Outcome:* induction graduates step into a continuing system, not a vacuum.

### 6.6 EPDP ↔ Mentor Certification ledger
- The `principal_mentor_endorsement` cert type already exists. EPDP gives it a job: every Lead-level principal (Year 7+) who carries this endorsement becomes eligible to mentor a Year-1 principal in `induction_assignments`.
- The annual appraisal F-Lead 0.10 weight specifically credits cross-school mentoring.
- *Outcome:* veteran principals get a path to network-level contribution; the network gets capacity to scale principal induction.

### 6.7 EPDP ↔ Per-school packaging (`enabled_systems[]`)
- EPDP slots cleanly into the existing 4-flag packaging. Recommendation: extend the `appraisal` and `induction` flags from "teacher-track only" to **audience-tiered** semantics:
  ```
  appraisal: ['teacher']                     → status quo
  appraisal: ['teacher', 'leader']           → enables Principal Annual Appraisal too
  induction: ['teacher']                     → status quo
  induction: ['teacher', 'leader']           → enables Principal Cadence Checklist + post-induction coaching
  ```
- A school can pilot teacher-track appraisal without leader-track appraisal, or vice versa.
- *Outcome:* the four-flag mental model the board approved stays intact; granularity within each flag respects pilot pacing.

---

## 7. Charter (5 Principles + 5 Non-Negotiables)

EPDP inherits the Charter pattern directly from the principal induction module already running:

### 5 Principles
1. **Formative-first.** The observation rubric does not produce a numerical score. Findings inform the development conversation; accountability alone is not the purpose.
2. **Evidence-anchored.** Every cadence task produces specific evidence; every observation judgment links to a specific evidence indicator.
3. **Regulation-coherent.** Permendikbud 6/2018, Permendikdasmen 7/11/13/2025, 8 SNP, Cambridge Centre Approval — all explicitly anchored.
4. **Cadence-based.** "Good principal" is not a static trait but a sustainable rhythm.
5. **Network-portable.** Cross-school calibration is regular; no school is alone.

### 5 Non-Negotiables

| # | Rule |
|---|---|
| **NN1** | **Principal induction data (the first 12 months) does not feed annual appraisal.** Direct counterpart of induction Charter NN1. |
| **NN2** | **The principal's weekly reflection journal is never read by HQ in named form.** Counterpart of induction Charter NN2 — `principal_journal` rule has `list:false`, `get` only by owner. |
| **NN3** | **Observers must be certified before assignment.** Reuses existing `mentor_certifications/{uid}_principal_observer` (new cert type, same schema family). |
| **NN4** | **`principal_observations` create requires three named uids:** principalUid + observerUid + schoolId. |
| **NN5** | **Annual appraisal output is a binary recommendation triplet** (`compositeScore + predicateBand + recommendation`) shared with yayasan in confidence. Item-level scores, observation notes, and 360 responses are never shared with yayasan. |

NN1+NN2 are hard-coded at the firestore.rules level. No admin can loosen them client-side.

---

## 8. Principal Annual Appraisal Framework v1.0 (detail)

Inherits the Eduversal Teacher Appraisal Framework v2.1 schema directly — same `id/title/description/weight/items + scoring_scale + predicate_bands + level_visibility + cambridge_alignment` shape, adapted to the leadership context.

### 5 weighted frameworks

| Code | Framework | Weight | Source | Collection timing |
|---|---|---|---|---|
| **F1** | **Operating Cadence Compliance** | **0.25** | Completion of 43 compliance + 30 core tasks (`weekly_progress` + `principal_progress`); cross-checked against KPI cycle and Teacher Appraisal cycle execution | Auto-aggregated across the year |
| **F2** | **Leadership Observation** | **0.40** | Weighted average of P1–P8 ratings (E=4, D=2, N=skip) from ≥2 scheduled visits per year, conducted alongside the existing School Appraisal v2 visit | Sept–Oct + Feb–Apr visit windows |
| **F3** | **Stakeholder 360° Feedback** | **0.15** | Termly cycle: staff (0.6) + parent komite (0.25) + student council (0.15) — ≥5 respondents per cohort threshold, anonymous | Termly collection, year-end aggregate |
| **F4** | **Outcome Indicators** | **0.15** | Rapor Pendidikan + EASE + Cambridge results + Student/Staff/Parent satisfaction surveys; auto-pulled from existing AH dashboards | End-of-Year Conference |
| **F5** | **Self-Assessment & Reflection** | **0.05** | Termly self-assessment + annual reflection narrative | End-of-Year Conference |

**Total = 1.00.** Composite 0–100, mapped to A–F predicate bands (identical to Teacher v2.1).

### Level-aware visibility (inherits Teacher v2.1 pattern)

| Level | Anchor | Item set |
|---|---|---|
| `induction` | Year-1 principal | F1 + F2 only (others zeroed and redistributed) — but no formal appraisal during induction (NN1) |
| `developing` | Years 2–3 | All 5 frameworks; F2 weight 0.45 (less experience, observation weighted higher) |
| `proficient` | Years 4–6 | All 5 frameworks; default weights |
| `lead` | Year 7+, mentor principals | All 5 frameworks + F-Lead 0.10 (cross-school mentoring + network leadership) — direct counterpart of Teacher v2.1 F3L |

### Output document

```
principal_annual_appraisals/{principalUid}_{academicYear}
├── frameworkScores: { F1: 78, F2: 84, F3: 72, F4: 81, F5: 90 }
├── compositeScore: 80.4
├── predicateBand: 'B' (Good)
├── recommendation: 'continue' | 'development_plan' | 'non_renewal'
├── narrative: { headline, priorities, agreed_actions, principal_reflection }
├── sourcesUsed: { observations: [obsIds], 360cycles: [cycleIds], cadenceWindow }
├── reviewedBy: { academicDirector, yayasanRep, principal }
└── confidentialNote: string (eduversal_internal_only)
```

---

## 9. Firestore Data Architecture (production-ready)

8 new collections in the `centralhub-8727b` project, all following the existing `induction_*` and `competency_*` rule patterns. No new security primitives.

```
principal_observations/{obsId}                         — leadership rubric visit form
principal_progress/{principalUid}_{taskId}             — cadence task completion
principal_journal/{entryId}                            — weekly private reflection (NN2)
principal_coaching_sessions/{sessionId}                — monthly coaching record
principal_360_cycles/{cycleId}                         — termly 360 cycle controller
  └── responses/{respondentUid}                        — anonymous subcollection
principal_annual_appraisals/{principalUid}_{academicYear} — F1–F5 composite + recommendation
mentor_certifications/{uid}_principal_observer         — new cert type, existing collection
```

Plus reuse of existing collections:
- `weekly_progress` (cadence checklist writes here with `school_principal` platform)
- `induction_*` family (untouched; principal induction handbook continues to run)
- `competency_framework/leaders` (CPD recommendations sourced from observation findings)
- `appraisal_cycles` (annual appraisal cycle metadata)

**Schema anchor:** `docs/architecture/FIRESTORE_SCHEMA.md` §17 (new section) to be added.
**Rule pattern:** existing `induction_*` and `competency_*` collection rules will be **copied directly**.

---

## 10. UI/UX — 5 new AH pages, all on existing patterns

Vanilla HTML/JS + Firebase modular SDK v10.7.1 + existing design-system tokens. No new framework.

| Page | Slug | Audience | Existing analogue |
|---|---|---|---|
| **My Principal Dashboard** | `/principal-dashboard` | school_principal | `TeamInduction.html` pattern |
| **Principal Observation Entry** | `/observation-entry?type=principal_leadership` | observer + central_admin | Existing `ObservationEntry.html` — type variant |
| **Principal Coaching** | `/principal-coaching` | school_principal + observer | `MyInduction.html` pattern |
| **Principal Annual Appraisal Entry** | `/principal-appraisal-entry` | central_admin (Academic Director) | `TeacherAppraisalEntry.html` pattern |
| **Principal Annual Appraisal View** | `/principal-annual-appraisal` | school_principal (read own) + central_admin | `SchoolAppraisalsDashboard.html` pattern |

Cambridge cross-ref popovers (CTS chips) auto-wire onto rubric P1–P8 + appraisal F1–F5 pages via the existing `cambridge-crossref.js` build injection.

---

## 11. Pilot Plan

### Phase 0 — Preparation (2026-05-07 → 2026-06-30)
- [ ] Board approval
- [ ] Pilot school selection (3 schools: 1 Cambridge Approved Centre + 1 pre-centre + 1 national-only)
- [ ] **Observer calibration training** for Academic Director + 2 backup observers (NN3) — uses existing `mentor_certifications` ledger
- [ ] Deploy Firestore rules for `principal_*` collections in CH (test mode)
- [ ] SHA-256-pin Cadence + Rubric + new Appraisal Framework JSON files (`docs/research/` pattern)
- [ ] Pilot Charter v1.0 signed (Eduversal + 3 yayasans)

### Phase 1 — Pilot (2026-07-01 → 2026-12-31, Semester 1)
- [ ] Onboard 3 principals to the cadence checklist (1-day workshop)
- [ ] Phase 1.A (Jul–Sep): cadence checklist + weekly journal live
- [ ] First **scheduled appraisal visit** (Sep–Oct window) — paired with the existing School Appraisal v2 visit cycle
- [ ] Phase 1.B (Oct–Dec): first coaching cycle (3 sessions) + termly self-assessment
- [ ] Pilot retrospective (end of December)

### Phase 2 — Pilot expansion (2027-01 → 2027-06, Semester 2)
- [ ] Scale 3 → 8 schools
- [ ] First **principal_360_cycle** (termly, 3 schools)
- [ ] Annual Appraisal v1.0 dry-run (pilot first cohort only — 3 schools)
- [ ] Cross-school calibration session (8 principals + Academic Director + Eduversal HQ)

### Phase 3 — Full rollout (2027-07-01)
- [ ] All 16 partner schools
- [ ] Existing `appraisal` and `induction` flags in `partner_schools.enabled_systems[]` extended to audience-tiered semantics (`['teacher','leader']`)
- [ ] Annual Appraisal v1.0 enters production
- [ ] Embedded into the annual Eduversal Principal Conference (July workshop)

---

## 12. Success Metrics

### Ecosystem coherence (the new layer)
- % of leadership rubric visits paired with the same-day School Appraisal v2 visit: target ≥ 80% (single-trip efficiency)
- Inter-rater reliability between independent observers on F2 Leadership Observation: ≥ 0.7 (Cohen's κ)
- % of Priority Development Areas mapped to a `leaders` track competency level: ≥ 90%

### Adoption health
- Weekly checklist completion rate: ≥ 75%
- Monthly coaching session miss rate: < 10%
- Agreed Follow-up Action update rate within 7 days post-visit: ≥ 80%

### Reinforcement of existing programmes
- Teacher KPI on-time submission rate (school-level): year-on-year improvement ≥ 10pp where principal is in EPDP
- Teacher Appraisal calibration κ (school-level): year-on-year improvement
- School Self-Appraisal d1 Leadership rating gap vs. independent observation: narrowing

### Regulatory + Cambridge
- Compliance-tier task completion rate (43 tasks): target 100%, watch threshold 95%
- Cambridge Centre re-approval findings count: declining year-on-year

### Stakeholder satisfaction
- Principal satisfaction with the programme (separate survey): ≥ 4.0 / 5.0
- Yayasan rating as "a meaningful accountability tool": ≥ 80%

---

## 13. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cadence task count balloons in the field (83 too many) | High | Medium | Phase 1 starts with core+compliance only (73); recommended (10) in Phase 2 |
| Principals perceive observation as inspection | Medium | High | Charter Principle 1 explicit in workshop; pilot-school yayasans briefed in advance; rubric never produces a numerical score |
| Academic Director's visit capacity insufficient | Medium | High | Pair with existing School Appraisal v2 visit (single trip); NN3 calibration trains 2 backup observers |
| Cambridge syllabus update ages rubric content | Low | Low | Annual review cycle (Eduversal Annual Workshop) |
| Yayasan tries to use annual appraisal as performance-management tool | High | Very high | NN5 + Charter Principle 1: yayasan-facing report is binary triplet only |
| Data leak (`confidential_note` field) | Low | Very high | Firestore rule: `eduversal_internal_only` field hard-coded admin-only |
| 360° feedback turns retaliatory | Medium | Medium | Anonymous + ≥5 respondents threshold + termly cycle + Academic Director moderation |
| F2 (observation) drifts from formative rubric | Medium | High | Calibration session before each appraisal cycle; ≥1 paired visit per cohort per year |
| Dual-flag packaging (`appraisal: ['teacher','leader']`) confuses school admins | Low | Medium | `/schools` UI shows tier checkboxes per system; back-compat reads array length 1 as `['teacher']` |

---

## 14. Cost and Resourcing

### Development (one-time)
- 5 new AH pages + Firestore rule updates + 4 seed scripts (cadence + rubric + appraisal framework + page-access) + audience-tier migration of `enabled_systems[]`: **~10 weeks** in-house
- Sealing Cadence + Rubric + Appraisal Framework JSON files (`docs/research/` pattern): **~3 days**

### Operations (annual, ongoing)
- ~30% of Academic Director's role → absorbed within scope, no additional FTE
- 2 scheduled visits per school per year × 16 schools = 32 visits/year — **paired with existing School Appraisal v2 visits**, so no new trip count
- Cloud Functions usage: within existing Blaze plan limits

### Training
- Pilot year: 3 schools × 2-day workshop + 1-day observer calibration = ~9 mentor-days
- Full-rollout year: 16 schools × 1-day onboarding + 2-day observer recalibration = ~20 mentor-days

**Total estimated incremental cost:** absorbable within the existing Eduversal budget; no new line item.

---

## 15. Decision Sought from the Board

Four specific decisions:

1. **In-principle pilot approval** — endorsement of EPDP as the closing piece of the three-tier ecosystem (start July 2026).
2. **Selection of 3 pilot schools** — Cambridge Approved + pre-centre + national-only mix from the Academic Director's 5-school shortlist.
3. **Charter v1.0 signing authority** — delegate to the Academic Director the authority to co-sign the 5 Principles + 5 Non-Negotiables with pilot-school yayasans.
4. **Audience-tiered packaging** — endorse extending `enabled_systems[]` from `['kpi','appraisal','competency','induction']` (single audience) to audience-tiered values (`appraisal: ['teacher','leader']` etc.) so schools can pilot per audience.

---

## Appendix A — File Provenance

| Source file | Location | Size | Author | Version |
|---|---|---|---|---|
| Operating Cadence | [`Academic Hub/resources/principal-operating-cadence.json`](../../Academic%20Hub/resources/principal-operating-cadence.json) | 1529 lines, 83 tasks | Eduversal Office of the Academic Director | 1.0, effective 2026-07-01 |
| Observation Rubric | [`Academic Hub/resources/principal-observation-rubric.json`](../../Academic%20Hub/resources/principal-observation-rubric.json) | 457 lines, 8 foci × 55 indicators | Eduversal Office of the Academic Director | 1.0, effective 2026-07-01 |
| Teacher Appraisal Framework (template) | [`Academic Hub/resources/appraisal-framework-v2.json`](../../Academic%20Hub/resources/appraisal-framework-v2.json) | F1–F4 + F3L, A–F bands, level-aware | Eduversal | 2.1, in production |
| School Appraisal Framework (paired with Specialist visit) | [`Central Hub/resources/school-appraisal-framework.json`](../../Central%20Hub/resources/school-appraisal-framework.json) | 5 domains × 31 aspects | Eduversal | in production |
| Principal Induction Handbook (already running) | [`docs/induction/handbook-principal-v1.json`](../induction/handbook-principal-v1.json) | 5 stages, 12-month, Listen→Diagnose→Act→Anchor | Eduversal | v1, in production |

**Audit trail:** all files SHA-256-hashed before pilot launch and pinned in `docs/research/principal-development/manifest.json`.

---

## Appendix B — Architecture Compatibility Matrix

| Existing Eduversal system | EPDP fit | Evidence (code reference) |
|---|---|---|
| Modular SDK v10.7.1 | EPDP also v10.7.1 | existing `auth-guard.js` |
| Per-platform role + sub-role | `school_principal` ⊂ `ah_sub_roles[]`, existing | [`Academic Hub/CLAUDE.md`](../../Academic%20Hub/CLAUDE.md) |
| Page-access gating | EPDP pages follow `page_access_config/{slug}` | existing |
| Charter NN1+NN2 rule pattern | EPDP NN1+NN2 copy directly | [`Central Hub/firestore.rules`](../../Central%20Hub/firestore.rules) "INDUCTION MODULE" |
| Cambridge cross-ref popover | rubric P1–P8 + appraisal F1–F5 chips auto-wired | existing `cambridge-crossref.js` |
| `weekly_progress` doc-id pattern | EPDP cadence checklist same pattern | `${uid}_${ACADEMIC_YEAR}_w${week}_school_principal` |
| `induction_*` collection family | `principal_*` is a direct copy | `docs/architecture/FIRESTORE_SCHEMA.md` §16 |
| Teacher Appraisal v2.1 schema | Principal Appraisal v1.0 same shape | `appraisal-framework-v2.json` |
| Mentor certification ledger | EPDP adds `principal_observer` cert type to existing collection | existing |
| Three-track competency (`teachers`/`leaders`/`specialists`) | EPDP sources Priority Development Area suggestions from `leaders` track | existing |
| School Appraisal v2 visit cycle | EPDP rubric visit pairs with same-day Specialist visit | existing |
| `partner_schools.enabled_systems[]` packaging | extended to audience-tiered semantics | existing |
| HTML allowlist sanitiser | Coaching + rubric + appraisal narrative use same sanitiser | existing |
| Build pipeline | EPDP HTML files pass through `Academic Hub/build.js` | existing |

---

*A PDF version of this document will be reviewed with the team before the board meeting. Questions: Office of the Academic Director.*
