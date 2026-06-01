# Eduversal School Data Pack Template

**Version 1.0 — published 2026-05-31 by Eduversal.**

This document closes the New School Principal Handbook open item: *"School data pack template (EASE / appraisal / retention summary) to be standardised — currently Eduversal assembles ad-hoc per school."*

---

## What this is

When a new principal starts, Eduversal hands them a **read-only data pack** on day 1 (handbook Stage 0 task `p_stage_0_data_pack_assembled`). It is the factual baseline the principal reads during Window 1 (Listen) and returns to in Window 2 (Diagnose) when picking priorities.

Until now each pack was assembled by hand, so two new principals could receive different shapes of pack. This template fixes the shape: **the same five sections, in the same order, every time.** It also names exactly which Firestore collection each number comes from, so the pack can be generated consistently — and, where possible, exported directly from Central Hub `/reports` → "School Data Pack" card (see [Generating the pack](#generating-the-pack) below).

**Audience of the pack:** the new principal (primary), their Eduversal-assigned mentor, and the Foundation Representative. Read-only.

**The pack describes the school, not the people.** It is a *starting picture*, never a scorecard. See [Boundaries](#boundaries).

---

## The five sections

Every School Data Pack has exactly these five sections. A section with no data shows "No data available for the last 2 years" — it is never silently dropped, because an empty section is itself a finding for Window 1.

### Section 1 — School at a glance

A one-screen header so the principal knows the shape of what they are leading.

| Field | Source |
|---|---|
| School name + city | `partner_schools/{schoolId}` |
| Grade range / divisions (SMP / SMA) | `partner_schools/{schoolId}.classes` subcollection |
| Number of active classes | `partner_schools/{schoolId}.classes` |
| Number of teaching staff | `staff` where `schoolId == this school` AND `status: 'active'` |
| Cambridge programmes offered | `partner_schools/{schoolId}` (or curriculum config) |
| Enabled Eduversal systems (KPI / appraisal / competency / induction / aicf) | `partner_schools/{schoolId}.enabled_systems[]` |

### Section 2 — EASE growth (last 2 windows)

How students are growing, by subject. EASE is the network growth measure (Math / English / Science).

| Field | Source |
|---|---|
| Average RIT-equivalent by subject, current window | `ease_growth/{studentUid}_{subjectId}` aggregated to school level |
| Average RIT-equivalent by subject, prior window | same, prior window |
| Growth direction per subject (↑ / → / ↓) | derived from the two windows |
| % of students with at least one completed EASE session | `ease_growth` count vs. active-student count |

> **Pilot-norm caveat:** the first three EASE windows use a window-specific norm, so cross-window growth claims are interim until window 4. The pack repeats this caveat verbatim next to Section 2 so a new principal does not over-read an early trend. (Same rule the `growth.html` badge enforces.)

### Section 3 — Teacher appraisal aggregates (last 2 cycles)

Where teaching practice sits, **at department level only** — never named individuals.

| Field | Source |
|---|---|
| Department-level appraisal composite, current cycle | `teacher_appraisals` where `schoolId == this school`, grouped by department |
| Department-level appraisal composite, prior cycle | same, prior cycle |
| Number of completed appraisals vs. expected | `teacher_appraisals` count vs. staff count |

> **Anonymity rule:** the pack carries appraisal data **named at department level, anonymised at individual level** (handbook task wording). A new principal does not start the year holding individual appraisal scores — they form their own view first (Window 1), and the appraisal system stays the property of the appraisal track, not induction. See [Boundaries](#boundaries).

### Section 4 — Staff retention (last 2 years)

The single strongest early signal of school health.

| Field | Source |
|---|---|
| Year-on-year staff retention % | `staff` joined / left dates (or HR retention record) for this school |
| Number of teachers in their induction year | `induction_assignments` where school == this school AND active |
| Number of mentor-certified staff on site | `mentor_certifications` active, cross-referenced to this school's staff |

### Section 5 — Parent satisfaction + network position

How families see the school, and where the school sits in the network.

| Field | Source |
|---|---|
| Most recent parent-satisfaction summary | parent satisfaction survey responses for this school |
| Network-comparison snapshot for the school's grade range | anonymised network medians (see Section "network benchmark" of `/reports`) |
| Position vs. network median per Section 2–4 metric (below / on par / above) | derived — never names other schools |

---

## Generating the pack

Two ways, in order of preference:

1. **Central Hub `/reports` → "School Data Pack / Network Benchmark" card** (2026-05-31). Pick a school, click Generate, and the card runs live aggregate queries for Sections 1–5 and shows the school's position against the **anonymised network median** for each metric. Click CSV to export a board-ready file. This is also the source for the Window-2 `p_w2_network_benchmarking` task — the principal sees where the school is below / on / above the network median, with no other school ever named.
2. **Manual assembly** following this template, only when a metric the card does not yet cover is needed. Keep the five-section order; cite the source collection for each number so the pack stays auditable.

Either way, the assembled pack is uploaded to the principal's induction (handbook `p_stage_0_data_pack_assembled`, `evidenceType: evidence_upload`) so it is available from day 1.

---

## Boundaries

The data pack is bound by the same Induction Charter logic that governs everything else in the year-1 system.

- **Section 3 (appraisal) is department-level, anonymised at individual level.** Handing a new principal individual appraisal scores on day 1 would make them judge before they listen — the opposite of the Listen-first design. The appraisal track stays the appraisal track.
- **The pack is read-only and descriptive.** It is a starting picture, not a target sheet. Nothing in the pack feeds the principal's own appraisal (Charter NN1 spirit — induction data and appraisal data do not cross).
- **Network comparison is anonymised.** The pack shows "below / on par / above the network median," never "School X scored higher than you." Naming other schools would turn a development tool into a league table.
- **No student-level identifiable data leaves the aggregate.** EASE and parent data appear as school-level aggregates only.

---

## Related

- New School Principal Handbook — [`handbook-principal-v1.json`](handbook-principal-v1.json), task `p_stage_0_data_pack_assembled` (Stage 0) + `p_w2_network_benchmarking` (Window 2).
- Central Hub `/reports` — "School Data Pack / Network Benchmark" card (live generation + CSV export).
- [Induction Charter](INDUCTION_CHARTER.md) — Charter NN1 (induction data never feeds appraisal scoring).
