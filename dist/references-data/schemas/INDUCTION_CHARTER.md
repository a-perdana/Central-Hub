# Eduversal Induction Charter

**Version 1.0 — published 2026-05-04 by Eduversal HQ.**

How we welcome, support, and grow first-year staff across the Eduversal partner-school network.

This Charter is the constitution of Eduversal's induction system. The three role-specific handbooks (subject teacher, school principal, subject specialist) sit underneath it. Where any handbook or system behaviour conflicts with this Charter, the Charter wins.

The machine-readable version of this document — used by the system to enforce non-negotiables and surface commitments to mentees and mentors — lives at [`INDUCTION_CHARTER.json`](INDUCTION_CHARTER.json) in the same folder. Edit both together.

---

## Scope

**Applies to:**
- First-year subject teachers at any Eduversal partner school
- First-year school principals at any Eduversal partner school
- First-year HQ subject specialists at Eduversal central

**Does not apply to:** second-year and beyond staff (covered by the network-wide KPI / Appraisal / Competency systems), and non-Eduversal contractors, observers, or visiting consultants.

**Duration:** 12 months from hire date for all three audiences. Subject teachers may receive a 6-month extension on mentor + school-leader recommendation.

---

## Purpose

To give every first-year hire across the Eduversal network a structured, dignified, evidence-informed first year — one that produces both a confident practitioner and a sound professional record.

Alongside that primary purpose, the Charter exists to:

- Make implicit mentoring culture explicit and trainable, so the quality of first-year support does not depend on which school or which mentor a new hire happens to land with.
- Produce structured first-year data that lets Eduversal HQ identify systemic gaps (workload, mentor availability, retention risk) and act on them at network level.
- Free the network-wide systems (KPI, Appraisal, Competency) from carrying induction weight they were not designed for.

---

## The Five Principles

### 1. Induction is care, not surveillance.

First-year data — journals, weekly pulses, mentor reflections, observation notes — exists to inform support, not to judge. None of it feeds the network-wide Appraisal or KPI scoring during the induction year. Mentees see this guarantee from day one, in writing, in their dashboard.

**What this means in practice:**
- `induction_journal` entries are private to the mentee, the assigned mentor, and the assigned school leader. No HQ role reads named entries; HQ sees only anonymous aggregates.
- Weekly pulse data is anonymised at school level before any HQ dashboard surfaces it.
- Induction completion is binary (completed / extension / withdrew); no induction year produces an A-F predicate or a numeric score that follows the teacher into year 2.
- Anything mentee-authored that the mentee marks 'private' is invisible to the school leader — only the mentor sees it.

**Why:** if first-year data feeds appraisal, mentees rationally hide weakness, which is exactly what induction needs to surface to support.

### 2. Mentorship is a craft we train, not assume.

A subject leader given a mentee without mentor training will replicate whatever mentoring they themselves received — good or bad. Eduversal trains every assigned mentor before pairing them with a mentee, using a 2-hour internal Mentor Onboarding adapted from Cambridge PDQ Getting Started with Mentoring (gswment) plus our own Indonesian-context case studies.

**What this means in practice:**
- Central Hub maintains a `mentor_certifications` collection. A user without an active mentor certification cannot be assigned as a mentor.
- Mentor certification expires after 24 months and requires a 1-hour refresher.
- First-time mentors are paired with a senior mentor as a buddy for their first cycle — the senior mentor reviews the new mentor's first observation write-up before it is shared with the mentee.
- Mentor capacity is published per school (how many mentees a single subject leader can supervise — soft cap of 2, hard cap of 3) and enforced at assignment time.

**Why:** pilot data from 2025-26 indicated that mentor quality variance — not mentee variance — was the largest predictor of first-year retention.

### 3. First-year data is a learning resource, not a judgment.

Year-one observations, reflections, and pulses build a portrait of the mentee's growth. That portrait is for the mentee, the mentor, the school leader, and Eduversal HQ as a network-improvement tool. It is never used as input to the network-wide Appraisal scoring engine, the predicate calculation, or any retention decision in year one.

**What this means in practice:**
- `induction_observations` are stored in their own collection and rubric; they do not write to `teacher_appraisal_results`.
- Year-one mentees are excluded from the network appraisal cycle (their `teacher_kpi_submissions` and `teacher_self_appraisals` are optional, not required).
- Year-one completion produces an Induction Completion Certificate in `competency_certificates` with a fixed level (no Distinguished / Proficient gradation). This celebrates the mentee finishing the year, nothing more.
- Retention decisions inside year one are made against a separate, written 'Significant Concern' policy that requires multi-party sign-off (mentor + school leader + HQ). They are rare and never automatic.

**Why:** conflating formative and summative assessment in induction destroys the formative value. We separate them deliberately.

### 4. Three audiences, three paths — but one charter.

A new subject teacher needs survival skills then mastery-building. A new school principal needs to listen before acting. A new HQ subject specialist needs to map the network before coaching it. The handbook content differs by role; the principles, the data discipline, the certificate, the dignity — do not.

**What this means in practice:**
- Three `induction_programs` templates: `handbook_subject_teacher_v1`, `eduversal_principal_v1`, `eduversal_specialist_v1`. Same shape, different stages and tasks.
- Same Firestore collections (`induction_assignments`, `induction_progress`, `induction_observations`, `induction_journal`) serve all three audiences.
- All three end with the same kind of Induction Completion Certificate — the certificate is platform-neutral.

**Why:** a single shared schema lets HQ compare cohort completion across roles; a single shared certificate signals that all three induction tracks are equally serious commitments.

### 5. Induction is a two-way contract.

Eduversal commits to specific support: a trained mentor, weekly mentor time, structured observation cycles, protected induction tasks. The mentee commits to specific work: completing the journal, attending mentor sessions, engaging honestly with reflections. Both sides can flag the other when commitments slip; neither side gets to silently breach.

**What this means in practice:**
- Mentor and mentee both sign a digital Induction Agreement at the start of stage 1 — visible inside the induction dashboard.
- If three consecutive scheduled mentor sessions are missed (by either side), the school leader is automatically notified.
- If a mentor leaves the school mid-induction, HQ is notified within 7 days and a replacement mentor must be assigned within 14 days.

**Why:** induction quality erodes silently when nobody has a structured way to flag drift. We make the agreement and the drift-detection both explicit.

---

## Non-Negotiables

These five rules are encoded directly in Firestore rules and admin tooling. Bypassing them in the system is not possible without a Charter version bump and HQ sign-off.

1. **Year-one induction data never feeds network appraisal scoring.**
2. **Mentee journal entries are not visible to anyone the mentee has not explicitly granted access to** (mentor + school leader by default; HQ never).
3. **No user without active Mentor Certification can be assigned as a mentor.**
4. **An induction assignment requires three named parties at creation:** mentee, mentor, school leader. No assignment can be created with any of these missing.
5. **An Induction Completion Certificate is binary and platform-neutral.** It does not record a numeric score, a predicate, or a quality band.

---

## Roles and Commitments

### The mentee commits to:
- completing the assigned induction tasks within the published windows
- attending scheduled mentor sessions (or rescheduling at least 24 hours in advance)
- engaging honestly with reflections and weekly pulses, even when the honest answer is "this was hard"
- raising concerns about mentor or school-leader conduct through the published escalation route

### The mentor commits to:
- holding active Mentor Certification before being assigned
- spending at least 1 hour per week with the mentee in scheduled mentor time during stages 1 and 2; at least 30 minutes per week in stage 3
- completing the structured monthly observation write-up within 7 days of the observation
- raising concerns about mentee progress, wellbeing, or school-leader support through the published escalation route

### The school leader commits to:
- personally welcoming the mentee on day 1 (in person or, if remote start, via live video)
- ensuring the mentee's first-week timetable is reduced by at least 20% to allow for induction tasks
- conducting the Q4 formal evaluation in person and writing the post-conference feedback within 14 days
- monitoring the school's induction dashboard at least weekly during stages 1 and 2, monthly thereafter

### Eduversal HQ commits to:
- providing the induction dashboard, scheduling tools, observation rubric, and mentor training to every partner school free of charge
- publishing anonymised network-level induction completion and retention data once per academic year
- reviewing and revising this Charter at least once per academic year against pilot data and partner feedback
- providing escalation support when in-school mentor or school-leader pairings break down

---

## Escalation Route

1. **Level 1.** Mentee raises a concern with mentor (or vice versa).
2. **Level 2.** Either party raises a concern with the school leader.
3. **Level 3.** Any party raises a concern with the Eduversal HQ Induction Coordinator (a designated `central_admin` sub-role).
4. **Level 4.** HQ Induction Coordinator escalates to the school's Foundation Representative if the school-leader is the source of the concern.

**Principle:** an escalation never disadvantages the person raising it. Retaliation is a Significant Concern in itself.

---

## Review

This Charter is reviewed annually every May, before the next academic year's cohort intake. The HQ Induction Coordinator publishes a year-end review note alongside the next year's cohort planning. The Charter version is bumped only on substantive change.

**Next review due:** 2027-05-01.

---

## Open Items

These four items must be resolved before pilot start (target: 2026-07).

- [ ] Define the Significant Concern policy referenced in Principle 3 — separate document, drafted before pilot start.
- [ ] Publish the Mentor Certification curriculum (2-hour internal session, adapted from Cambridge gswment).
- [ ] Define the soft / hard cap for mentor capacity (currently 2 / 3 — confirm with pilot data).
- [ ] Specify the induction extension criteria — what counts as a reason for the optional 6-month extension.
