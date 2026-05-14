# Cross-Module Index — Eduversal Network

**Last reconciled:** 2026-05-08
**Maintained alongside:** every change that touches a JSON source-of-truth must update this index.

This is the single canonical map of how Eduversal modules link to each other. If you are about to add a new task, KPI, appraisal item, competency, or rubric indicator — find your audience here first, follow the link chain, ensure your new content joins the chain rather than creates a parallel one.

## The Five Audiences

| Code | Audience | Primary Hub | Sub-role keys | Count (typical school) |
|---|---|---|---|---|
| **ST** | Subject Teacher | TH | `teachers` (default) | 30–50 per school |
| **SL** | Subject Leader | TH | `subject_leader` | 5–10 per school |
| **AL** | Academic Leadership | AH | `school_principal`, `academic_coordinator`, `cambridge_coordinator`, `foundation_representative` | 4–6 per school |
| **HQS** | HQ Subject Specialist | CH | `coordinator` + `ch_subjects[]` | 7 per network |
| **HQD** | HQ Director | CH | `director` | 2 per network (Primary, Secondary) |

> **Role-by-role applicability matrix:** open the **Competency × Role Heatmap** tab on CH `/roles-positions` for the live view of which rating system / competency track applies to each of the ~115 catalogued positions. The catalogue itself (reportsTo, careerPathway, cambridgeRefs, certificationTier, teachingHoursModel) lives in [`Central Hub/resources/roles-positions.json`](../../Central%20Hub/resources/roles-positions.json) and is sourced from the **School Organizational & Meeting Framework v1.0 (2026)** + partner-school **Lampiran V**.

## The Four Pilot Flags

`partner_schools/{schoolId}.enabled_systems[]` controls per-school module rollout. Audience-tier expansion (per EPDP §6.7) is Phase-2 — current implementation is single-flag-per-system.

| Flag | Default behaviour | Audiences using when ON |
|---|---|---|
| `kpi` | Hidden when set; visible when missing | ST submits, AL evaluates |
| `appraisal` | Hidden when set; visible when missing | ST receives, SL+AL appraises, HQS appraises cross-school |
| `competency` | Hidden when set; visible when missing | ST/SL on `teachers` track, AL on `leaders` track, HQS on `specialists` track |
| `induction` | Hidden when set; visible when missing | Year-1 ST, Year-1 Principal, Year-1 HQS |

`partner_schools.enabled_systems` missing = all enabled (back-compat). Empty array = all disabled. Admin always bypasses.

---

## The Four Module Stacks per Audience

### Subject Teacher (ST)

| Layer | Source-of-truth | Firestore | UI |
|---|---|---|---|
| Practice rhythm | `docs/weekly-checklists/subject-teacher.json` | `weekly_templates/{year}_w{NN}_teachers` + `weekly_essentials/teachers` | TH `weekly-checklist.html` (teachers tab) |
| Self-assessment & KPI | `kpi-admin.html` hardcoded fallback (15 items as of 2026-05-08) | `teacher_kpi_config/*` + `teacher_kpi_submissions/{uid}_{periodId}` | TH `teacher-kpi-results.html`; AH `teacher-kpi-evaluation.html` |
| Summative appraisal | `Academic Hub/resources/appraisal-framework-v2.json` | `teacher_appraisals/{docId}` + `teacher_self_appraisals/{uid}_{year}` | AH `TeacherAppraisalEntry.html`; TH `teacher-appraisal-results.html` |
| Competency CPD | `Central Hub/resources/teaching-competency-framework.json` (24 × 4 = 96 entries) | `competency_framework/teachers` (+ `levels/` subcoll) | TH `learning-path.html`, `my-portfolio.html`, `my-certificates.html` |
| Year-1 induction | `docs/induction/handbook-subject-teacher-v2.json` | `induction_programs/handbook_subject_teacher_v2` + `induction_assignments/{menteeUid}` + `induction_progress/...` | TH `my-induction.html` |

### Subject Leader (SL)

| Layer | Source-of-truth | Firestore | UI |
|---|---|---|---|
| Practice rhythm | `docs/weekly-checklists/subject-leader.json` | `weekly_templates/{year}_w{NN}_subject_leader` | TH `weekly-checklist.html` (subject_leader tab) |
| Self-assessment & KPI | (same as ST teacher KPI — SL self-submits) | (same) | (same) |
| Summative appraisal | `appraisal-framework-v2.json` (incl. F3L L1-L10 leadership items) | `teacher_appraisals/{docId}` w/ leadership flag | AH `TeacherAppraisalEntry.html` |
| Competency CPD | `teaching-competency-framework.json` (`teachers` track) — SL uses leader-tier evidence | `competency_framework/teachers` | TH `learning-path.html` |
| Mentor cert | `docs/induction/MENTOR_CERTIFICATION_CURRICULUM.md` | `mentor_certifications/{uid}_mentor_base` | CH `induction-admin.html` |

### Academic Leadership (AL) — 4 sub-roles

Per-sub-role weekly checklists; shared appraisal/competency.

| Layer | Source-of-truth | Firestore | UI |
|---|---|---|---|
| Practice rhythm | `docs/weekly-checklists/{school-principal,academic-coordinator,cambridge-coordinator,foundation-representative}.json` (+ `principal-operating-cadence.json`) | `weekly_templates/{year}_w{NN}_{platform}` × 4 sub-roles | AH `weekly-checklist.html` (4 tabs) |
| Summative appraisal | (Principal only) `Academic Hub/resources/principal-appraisal-framework-v1.json` | `principal_annual_appraisals/{principalUid}_{academicYear}` | AH `principal-appraisal-entry.html` (to-build) |
| Formative observation | `Academic Hub/resources/principal-observation-rubric.json` (P1-P8, E/D/N) | `principal_observations/{obsId}` | AH `ObservationEntry.html?type=principal_leadership` (to-build) |
| 360° feedback | `docs/cross-module/principal-360-framework-v1.json` (TBD next) | `principal_360_cycles/{cycleId}/responses/{respondentUid}` | AH `principal-360.html` (to-build) |
| Competency CPD | `Central Hub/resources/leadership-competency-framework.json` (24 × 4 = 96 entries) | `competency_framework/leaders` (+ `levels/` subcoll) | AH `LearningPath.html`, `MyPortfolio.html`, `MyCertificates.html` |
| Year-1 induction | (Principal only) `docs/induction/handbook-principal-v1.json` | `induction_programs/eduversal_principal_v1` + `induction_assignments/{principalUid}` | AH `MyInduction.html`, `TeamInduction.html` |
| Coaching cycle | `docs/cross-module/principal-coaching-framework-v1.json` | `principal_coaching_sessions/{sessionId}` | AH `principal-coaching.html` (to-build) |

### HQ Subject Specialist (HQS)

| Layer | Source-of-truth | Firestore | UI |
|---|---|---|---|
| Practice rhythm | `docs/weekly-checklists/subject-specialist.json` | `weekly_templates/{year}_w{NN}_coordinator` | CH `weekly-checklist.html` (coordinator tab) |
| Visit cycle (school appraisal) | `Central Hub/resources/school-appraisal-framework.json` (5 domains × 31 aspects) | `school_appraisals_v2/{docId}` | CH + AH `school-appraisals.html` |
| Visit cycle (teacher appraisal) | `appraisal-framework-v2.json` | `teacher_appraisals/{docId}` (cross-school write) | AH `TeacherAppraisalEntry.html` |
| Competency CPD | (specialists track — generated content currently) | `competency_framework/specialists` (24 × 4 = 96 generated entries) | CH `learning-path.html` |
| Year-1 induction | `docs/induction/handbook-specialist-v1.json` | `induction_programs/eduversal_specialist_v1` | CH `my-induction.html`, `my-mentees.html` |

### HQ Director (HQD)

| Layer | Source-of-truth | Firestore | UI |
|---|---|---|---|
| Practice rhythm | `docs/weekly-checklists/director.json` | `weekly_templates/{year}_w{NN}_director` | CH `weekly-checklist.html` (director tab) |
| Network strategic reports | (no JSON — admin-managed) | `subject_specialist_reports`, `principal_appraisal v1` (Director leads) | CH dashboards (TBD) |
| Mentor role | `MENTOR_CERTIFICATION_CURRICULUM.md` (`principal_mentor_endorsement`) | `mentor_certifications/{uid}_principal_mentor_endorsement` | CH `induction-admin.html` |

---

## Cross-Reference Network — Module-by-Module Link Chains

### Chain 1: Weekly task → Competency progression

```
weekly_templates task.competency_link  →  competency_framework/{trackId}.competencies[].id
                                              ↓
                                      learning-path.html displays "this task contributes to XYZ at level N"
```

| Audience | Source links | Target framework |
|---|---|---|
| ST (subject_teacher.json) | 13 links: smc-2, afl-1/2/3, lcp-2, cce-2/3, icp-2 | `competency_framework/teachers` (24 ids) |
| SL (subject-leader.json) | 5 links: pdpc-1/2/3, cial-2/3 | `competency_framework/leaders` (24 ids) |
| Other 6 roles | 0 links currently — opportunity for Phase 2 expansion | — |

**Lint command:**
```bash
node -e "const fs=require('fs'),p=require('path');const T=require('./Central Hub/resources/teaching-competency-framework.json'),L=require('./Central Hub/resources/leadership-competency-framework.json');const ids={teachers:new Set(T.map(c=>c.id)),leaders:new Set(L.map(c=>c.id))};const root='docs/weekly-checklists';let bad=0;fs.readdirSync(root).filter(f=>f.endsWith('.json')&&!f.startsWith('_')).forEach(f=>{const j=JSON.parse(fs.readFileSync(p.join(root,f),'utf8'));const t=JSON.stringify(j.framework_anchors?.competency_framework_track||'').includes('leaders')?'leaders':'teachers';const ls=[];(function s(o){if(Array.isArray(o))o.forEach(s);else if(o&&typeof o==='object'){if(o.competency_link)ls.push(o.competency_link);Object.values(o).forEach(s)}})(j);const b=ls.filter(l=>!ids[t].has(l));bad+=b.length;console.log(f+': '+ls.length+' links, '+b.length+' broken')});console.log('TOTAL broken:',bad)"
```

### Chain 2: Weekly task → Appraisal evidence

```
weekly_templates task  →  appraisal_v2_1 F-item OR principal_appraisal_v1 F-item
       (via framework_anchor[] field)
```

| Audience | Source field | Target |
|---|---|---|
| ST | `framework_anchor: ["appraisal_v2_1 F2", "CTS 4.1"]` | F1, F2, F3, F4 of teacher appraisal |
| SL | task ids (SL-C1-001 etc.) referenced in F3L L7-L10 `weekly_checklist_link[]` | F3L (within F3 weighting) |
| Principal | task ids (T-P1-001 etc.) in cadence-file → principal-appraisal-v1 F1 data_source | F1 of principal appraisal |

### Chain 3: KPI → Multiple targets

```
teacher_kpi_config[id]  →  cambridge_standard_refs[]   (CTS chips)
                       →  competency_link               (CPD link)
                       →  appraisal_link[]              (F-evidence)
                       →  weekly_checklist_link         (task that produces this KPI's evidence)
```

Currently 4 of 15 teacher KPIs carry the full link chain (the 4 added 2026-05-08). Phase 2 work: backfill the original 11 with the same field set.

### Chain 4: Observation rubric → Appraisal aggregation

```
principal_observations.fociResponses.{P1..P8}  →  principal_appraisal_v1 F2 (data_source)
                                                       weighted average (E=4, D=2, N=skip)
```

Same pattern for teacher_walkthroughs feeding teacher_appraisals (informal, formative-only per Charter NN1).

### Chain 5: Induction → No-feed-forward to Appraisal

Charter NN1 — explicit. Year-1 induction data NEVER feeds appraisal. Tested at firestore rule level: `induction_observations` has `list:false` for non-induction-party reads, and `principal_annual_appraisals` data_source explicitly excludes `induction_*` collections.

This is a **deliberate disconnection** in the chain. It is NOT a tutarsızlık — it is a non-negotiable design principle.

---

## The Three Cross-Module Disciplines

### Discipline A: AH+TH copy parity for `appraisal-framework-v2.json`

Two physical copies exist:
- `Academic Hub/resources/appraisal-framework-v2.json`
- `Teachers Hub/resources/appraisal-framework-v2.json`

These MUST be byte-identical. CLAUDE.md root convention. After any edit, `diff -q` must produce no output. The standard protocol is: edit in AH, copy to TH (`cp <ah-path> <th-path>`), commit both.

### Discipline B: 6-Domain Teaching Quality (Semesta) ↔ CTS 2023 (Eduversal-canonical)

Eduversal canonicalises Cambridge Teacher Standards 2023 (27 standards). Semesta uses simpler 6-Domain framework (D1 Knowledge / D2 Planning / D3 Delivery / D4 Environment / D5 Assessment / D6 Practice). Where Semesta-pattern content adopted, the cross-walk is implicit:

| Semesta Domain | Maps to Cambridge Teacher Standards |
|---|---|
| D1 Professional Knowledge | CTS 1.x, 3.1-3.3 |
| D2 Instructional Planning | CTS 4.1-4.5 |
| D3 Instructional Delivery | CTS 4.2, 4.3, 4.4 |
| D4 Learning Environment | CTS 4.6 |
| D5 Assessment & Feedback | CTS 5.1-5.3 |
| D6 Professional Practice | CTS 6.1-6.3 |

Walkthrough notes use Semesta D1-D6 for simplicity; appraisal items use CTS for Cambridge re-approval audit trail. Both viewpoints are valid; the cross-walk above is the bridge.

### Discipline C: Induction stage ↔ Appraisal level

| Year | Induction stage (Subject Teacher) | Induction stage (Principal) | Appraisal level |
|---|---|---|---|
| 0 | preparation | preparation | NO appraisal (induction overlay) |
| Year 1 | familiarization → foundation → mastery_building → integration | listen → diagnose → act → anchor | NO formal appraisal (Charter NN1) |
| Year 1 end | Induction completion certificate (binary) | Induction completion certificate (binary) | — |
| Year 2 | (no induction overlay) | (no induction overlay) | `developing` (first formal appraisal) |
| Years 3 | (no overlay) | (no overlay) | `developing` |
| Years 4-6 | (no overlay) | (no overlay) | `proficient` |
| Years 7+ | (no overlay) | (no overlay) | `lead` (with Mentor cert may engage F_LEAD) |

**Implementation note:** the weekly-checklist `induction_overlay.applies_when` clause must be `users.induction_status in {pre_arrival, ...}` for in-induction users; once induction completion certificate is issued, the user transitions to `developing`-level treatment in the next academic year. Code: this transition is currently NOT automated — `central_admin` updates `users.{uid}.appraisal_level` field manually after induction completion. Phase-2 work: a Cloud Function triggers on induction completion to set this field automatically.

---

## Module health snapshot — 2026-05-09

| Module | Production state | Content depth | Cross-link integrity |
|---|---|---|---|
| **Weekly checklists** (8 roles) | ✓ live — 320 docs + 1 essentials. Cards now structured: priority strip · category names · timing/duration/framework chips · Cambridge cross-ref chips (auto-wired) · expandable detail | Full | ✓ 18/18 competency_link, 11/11 F3L weekly_checklist_link, all CTS/PIGP/SKL refs surfaced as clickable chips |
| **KPI** | ✓ live (15 items) | Full | ✓ all 15 items fully cross-linked |
| **Teacher Appraisal v2.1** | ✓ live | Full (87 items + L7-L10 added) | ✓ |
| **Principal Appraisal v1.0** | ✓ live (`/principal-appraisal-entry`) — F1-F5 + F_LEAD weighted composite + A-F band, doc id `{principalUid}_{academicYear}`, immutable on submit | Full | ✓ Cambridge SLS chips clickable in framework cards |
| **Teacher Competency** (`teachers` track) | ✓ live | 96/96 hand-authored entries | — (read-only target) |
| **Leader Competency** (`leaders` track) | ✓ live | 96/96 hand-authored entries | — (read-only target) |
| **Specialist Competency** (`specialists` track) | ✓ live | 96/96 hand-authored entries; reading length 94% of TH+AH baseline; Indonesia-context density 67% (audit MINOR gap) | — (read-only target) |
| **Subject Teacher Induction** | ✓ live | Full | ✓ |
| **Principal Induction** | ✓ live | Full | ✓ |
| **Specialist Induction** | ✓ live | Full | ✓ |
| **Principal Observation Rubric** | ✓ live (`/principal-observation-entry`) — 8 foci × E/D/N + 4 narrative fields, no score, immutable on submit | Full | ✓ |
| **Principal Operating Cadence** | ✓ live, surfaces in weekly-checklist | Full | ✓ |
| **Principal 360°** | ✓ UI live (`/principal-360-respond` + `/principal-360-results` + CH `/principal-360-admin`) — anonymous respond + threshold-gated aggregate view + cycle launch admin. Cloud Function `aggregatePrincipal360Responses` deployed 2026-05-09 (write-trigger; weight redistribution for below-threshold cohorts; persists no respondent uid). | Full | ✓ NN5 enforced (no respondent uid persisted; aggregator never reads respondent identifier) |
| **Principal Coaching cycle** | ✓ live — CH `/principal-coaching-session` (mentor form, HQ Director only) + AH `/principal-coaching-view` (coachee read-only). 5-stage agenda · Foundation Reps EXCLUDED at rule level | Full | ✓ |
| **School Appraisal v2 ↔ Principal Rubric mapping** | ✓ ([file](school-appraisal-x-principal-rubric-mapping.json)) | — | — |
| **References & Standards hub** (CH /references; narrowed AH+TH variants) | ✓ live — 49 docs in CH (full superset) · 16 in AH · 15 in TH. Modal viewer auto-wires CTS/SKL/PIGP chips | Full | ✓ |

Items resolved 2026-05-08:
- ✓ school_appraisals_v2 d1 ↔ Principal Rubric explicit mapping ([file](school-appraisal-x-principal-rubric-mapping.json))
- ✓ Principal 360° framework spec + question bank ([file](principal-360-framework-v1.json))
- ✓ KPI legacy-11 backfill with full link-chain (all 15 items now CTS + competency + appraisal + weekly)
- ✓ Teacher + Leader competency content backfill (35 entries hand-authored — 16 TH + 19 AH; both tracks now at 96/96 coverage)
- ✓ Specialist competency content backfill (96 hand-authored entries replacing 72 generated; Indonesia-context density 0 → 1.0)
- ✓ Specialist competency polish round (43 entries expanded; reading length 70% → 94% of TH+AH baseline; audit moves from MARGINAL to MINOR gap)
- ✓ Principal Coaching cycle framework spec ([file](principal-coaching-framework-v1.json)) — 2 modes (year-1 induction overlay + year-2+ ongoing), 5-stage 60-min agenda, charter NN1+NN2+NN3+NN5 compliant, full evidence lineage to F2/F5

All Phase-2 UIs landed 2026-05-09 (form/skeleton level). Remaining work is functional rounding rather than authoring:

1. ✓ Principal Observation Rubric UI — `/principal-observation-entry` (Phase-2 D, 2026-05-09)
2. ✓ Principal 360° respond + results UIs — `/principal-360-respond`, `/principal-360-results` (Phase-2 E, 2026-05-09). Cloud Function `aggregatePrincipal360Responses` still pending — until it ships, results show empty state.
3. ✓ Principal Coaching cycle UIs — CH `/principal-coaching-session` (mentor) + AH `/principal-coaching-view` (coachee) (Phase-2 F, 2026-05-09). Admin audit page deferred (HQ Director can read all sessions via direct doc URL — no urgent need for a list view yet).
4. ✓ Principal Annual Appraisal UI — `/principal-appraisal-entry` (Phase-2 G, 2026-05-09). Composite + A-F band auto-computed.

Pending follow-up work:
- ✓ Cloud Function `aggregatePrincipal360Responses` for principal_360_responses → principal_360_aggregates (2026-05-09 — write-trigger, threshold-aware cohort gating, weight redistribution for below-threshold cohorts, no respondent uid touched). Code in [`Central Hub/functions/index.js`](../../Central%20Hub/functions/index.js) — deploy requires Blaze billing.
- ✓ CH `/principal-360-admin` cycle launch UI (2026-05-09 — central_admin tooling: create cycle, open/close, copy cohort-specific invite links, monitor per-cohort response counts + composite F3). Replaces "admin manually creates cycle docs in Firestore" workflow.
- /principal-coaching-history admin audit page (low priority — direct URL access works for now)
- Wire Phase-2 navigation entries into AH navbar Induction & Reference column (currently URL-direct only)

---

## Maintenance protocol

1. **Adding a new task / KPI / appraisal item / competency / rubric indicator:** locate the correct chain above; add the link fields to your new content; run the lint command from Chain 1; never create a parallel chain.
2. **Renaming an id** in any source-of-truth: grep across `docs/`, `Academic Hub/resources/`, `Central Hub/resources/`, `Teachers Hub/resources/` for the old id; update all references; re-run lints.
3. **Adding a new audience / sub-role:** add the row to "The Five Audiences" table; create a weekly-checklist JSON; map all four module stacks; update `enabled_systems` policy if relevant.
4. **Audit cadence:** this index re-validated quarterly (W11, W19, W30, W39 of the academic year). Discrepancy log filed in this folder.

---

*Authored 2026-05-08 as the canonical map of cross-module integrity. Maintained alongside every JSON source-of-truth change.*
