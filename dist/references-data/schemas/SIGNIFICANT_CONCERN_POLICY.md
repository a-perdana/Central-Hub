# Eduversal Significant Concern Policy

**Version 1.0 — published 2026-05-04 by Eduversal HQ.**

This document closes [Induction Charter](INDUCTION_CHARTER.md) Open Item 1.

---

## Purpose

Every induction system needs a way to handle the rare cases where the relationship genuinely is not working — where a mentee is at risk, where a mentor's conduct is in question, or where the school environment around the induction is harming the mentee's first year. The Charter calls these **Significant Concerns**.

This document defines:

1. What counts as a Significant Concern.
2. How a Significant Concern is raised, reviewed, and resolved.
3. The protections that apply to whoever raises the concern.
4. The audit trail required.

The Charter's principles still hold throughout. In particular:

- **Charter Principle 1 — care, not surveillance.** A Significant Concern process is not a discipline mechanism dressed up as care. It is a structured way to bring extra resources to a situation that is not going well.
- **Charter Non-Negotiable 1 — year-1 induction data does not feed network appraisal scoring.** Even where a Significant Concern leads to a mentee withdrawing from induction, the underlying observation, journal, and pulse data does not propagate into the network appraisal record.

---

## What counts as a Significant Concern

A Significant Concern is a situation where, despite the routine support structures of the induction (weekly mentor sessions, monthly observations, weekly pulses, mentor sign-offs), at least one of the following is true:

### Category A — Mentee at risk
- The mentee has recorded a Score 1 ("very hard") on the weekly pulse for **three consecutive weeks** (the standard 2-week alarm has already fired and gone unaddressed).
- The mentee has missed **three or more consecutive scheduled mentor sessions** without rescheduling.
- The mentee has disclosed (in journal, in mentor session, or in school-leader 1:1) a wellbeing issue that they explicitly say they cannot manage alone.
- The mentee's Q4 formal evaluation rubric scores at **Unsatisfactory in 2 or more domains**, AND month-9 mentor observation also scored Unsatisfactory in those same domains.

### Category B — Mentor conduct
- The mentor has missed **three or more consecutive scheduled mentor sessions** without rescheduling.
- The mentor has not completed an observation write-up within **14 days** of the observation date (Charter expects 7 days).
- The mentee has reported, in writing, conduct by the mentor that breaches the Mentor commitments listed in the Charter — examples: breach of journal confidentiality (Charter NN2 violation), unprofessional behaviour, dismissiveness, retaliation against escalation.
- The mentor's certification has expired and they have not refreshed within **30 days** of expiry while still actively mentoring.

### Category C — School environment
- The school leader has not held the year-start three-party meeting within the first month.
- The school has not provided the **20% timetable reduction** for stage 1 that the Charter commits Eduversal HQ to.
- More than one mentee at the same school has raised Category-A or Category-B concerns within a 60-day window — suggesting a school-level issue rather than an individual issue.
- The school has rejected, ignored, or punished a mentee or mentor for raising an escalation through Charter levels 1–4.

### What is NOT a Significant Concern

A mentee finding their first year **hard** is not a Significant Concern. The induction system is built for first-year hires; difficulty is the normal state. The threshold is structural failure of support, not personal struggle.

A single missed mentor session, a single unscheduled mentor session, a single low pulse score — none of these on their own trigger this policy. The 2-week pulse alarm already exists for low pulses. The Significant Concern threshold is deliberately above the routine-friction threshold.

---

## Who can raise a Significant Concern

Any of:
- The **mentee** themselves.
- The **mentor**.
- The **school leader** (school principal, foundation representative).
- The **HQ Induction Coordinator** (`central_admin` with the induction sub-role).
- An **observer** — another adult at the school or HQ who has reasonable grounds.

Significant Concerns can be raised:
- About the mentee (Category A).
- About the mentor (Category B).
- About the school (Category C).
- About the HQ Induction Coordinator (Charter Escalation Level 4 — Foundation Rep handles).

**Anonymous concerns** are accepted but are harder to action; the policy below favours named concerns. An anonymous concern may still trigger a routine welfare check.

---

## How a Significant Concern is raised

For pilot Year 1 (2026–2027): **email** to `induction@eduversal.org` (or in-person to the HQ Induction Coordinator), with the following information:

1. Date.
2. Who is raising the concern (name + role; or "anonymous" if applicable).
3. Which category (A / B / C, plus the specific bullet that applies).
4. A factual description of what has occurred — what was observed, when, by whom. **Not** speculation about motives.
5. What support, if any, has already been tried (e.g. "the mentee already raised this with their mentor and the issue continued").
6. What outcome the concern-raiser is hoping for (more support / mentor change / school review / withdrawal).

For Year 2+: a structured form will be added to Central Hub `/induction-admin` that writes a `significant_concerns/{id}` Firestore doc. Until then, the email + manual ledger is sufficient for pilot scale.

---

## The 7-day review window

When a Significant Concern is received, the HQ Induction Coordinator has **7 calendar days** to:

1. **Acknowledge receipt** to the concern-raiser within 24 hours.
2. **Verify facts** by reading the relevant induction data (assignment, recent observations, recent pulses, journal **only with the mentee's consent**, mentor session logs).
3. **Speak with each named party separately** — mentee, mentor, school leader as relevant. Each conversation is recorded in writing in the HQ Induction Coordinator's notes.
4. **Determine which Charter Non-Negotiables, if any, are being violated.** The most common: NN2 (journal confidentiality), NN3 (uncertified mentor still actively mentoring), Charter Principle 1 (data being used as surveillance).
5. **Convene a review panel** if the determination is non-trivial (see next section).

If the 7-day window cannot be met, the HQ Induction Coordinator notifies the concern-raiser of the delay and sets a new deadline (max 14 days total).

---

## The review panel

For non-trivial concerns, a 3-person review panel is convened:

- **HQ Induction Coordinator** (lead).
- **One Foundation Representative** from a school **other than** the school in question — for objectivity.
- **One senior practitioner** — typically a senior subject specialist or experienced principal not directly involved in the concern.

The mentee and any other named parties are invited to speak to the panel if they choose. They may bring a colleague as a support person. They are **never required** to speak; their written statement carries equal weight.

The panel reaches one of these outcomes:

### Outcome 1 — Continue with additional support

The induction continues. The panel recommends specific additional resources: more frequent HQ check-ins, a co-mentor, an extension of the timetable reduction beyond stage 1, etc. The mentor and school leader are both informed of the panel's recommendation.

### Outcome 2 — Reassign mentor (no-fault)

Per Charter Principle 5, the mentor-mentee relationship is ended on no-fault terms. A replacement mentor is assigned within **14 days**. The original mentor's certification is unaffected unless Outcome 4 applies.

### Outcome 3 — Extend the induction

The mentee is granted the optional 6-month extension (Subject Teacher only) or pause-and-resume status (any track). The mentee retains their certification trajectory.

### Outcome 4 — Mentor certification revoked

The mentor's `mentor_certifications/{uid}_mentor_base.active` is set to false. No new assignments. Existing inductions transition per Outcome 2. Reinstatement requires repeating the full Mentor Certification curriculum after a minimum 6-month interval.

### Outcome 5 — School flagged for Foundation Rep review

The school's induction practice is referred to the Foundation Rep and Eduversal HQ Director. Possible actions: pause new mentee placements at that school for the rest of the academic year; require a school-wide induction review; in extreme cases (e.g. retaliation against escalators), withdraw Eduversal partnership.

### Outcome 6 — Mentee withdraws from induction

The mentee chooses not to continue induction. `induction_assignments.status` is set to `withdrew`. Year-1 data is retained for HQ network-improvement review (anonymised) but is **never** used in any future appraisal or hiring reference.

### Outcome 7 — No action

The concern is found unsubstantiated. The concern-raiser is informed in writing. **Anonymous unsubstantiated concerns do not generate any record on any party.** Named unsubstantiated concerns generate a private note that does NOT name any party other than the raiser, and is reviewed only if a pattern emerges.

---

## Protections for whoever raises a concern

Charter Principle 5 explicitly says: **retaliation against an escalator is itself a Significant Concern** (Category B or C depending on source).

Specifically:

- A mentee who raises a concern cannot have it count against their Q4 formal evaluation, their Year-2 reference, or their Induction Completion Certificate.
- A mentor who raises a concern about the school cannot have it count against their certification renewal or future mentee assignments.
- A school leader who raises a concern about HQ cannot have it count against the school's enrolment in network-wide systems (`partner_schools.enabled_systems[]`).

If retaliation is alleged, that allegation is itself processed under this policy as a Category B or C concern.

---

## Audit trail

Every Significant Concern, regardless of outcome, generates a private case file at HQ:

- Date raised, by whom (or "anonymous"), category.
- Names of all parties involved.
- The concern statement (verbatim).
- Notes from each separate conversation conducted by the HQ Induction Coordinator.
- The panel's deliberation and outcome decision.
- The action taken and by whom.
- The date the case was closed.

These files are retained for **7 years** for audit purposes (consistent with PIGP record-retention practice). Access is limited to the HQ Induction Coordinator, the HQ Director, and an external auditor on request. The mentee or any named party can request a copy of their own statements within the file at any time.

The case file is **not** stored in Firestore for Year 1 of the pilot. Until the dedicated `/induction-admin` flow exists, files are kept in HQ-internal Google Drive with restricted access. Year 2 will move them into a `significant_concerns/{id}` Firestore collection with rule access limited to `central_admin`.

---

## When this policy is revised

Annually, every May, alongside the [Induction Charter](INDUCTION_CHARTER.md) review.

The HQ Induction Coordinator publishes anonymised statistics in the year-end review note:
- Number of concerns raised.
- Distribution by category (A / B / C).
- Distribution by outcome (1 through 7).
- Median time to resolution.

These statistics, alongside pulse and observation aggregates, drive the next year's Charter and curriculum revisions.

---

## What this policy is not

- **It is not a teacher-evaluation discipline policy.** Year-1 mentees are not evaluated under this policy. They are supported. The network appraisal system handles Year-2+ teacher performance — and even there, performance management is a separate HR matter, not a Charter matter.

- **It is not a complaints-against-Eduversal policy.** Eduversal-wide grievances are handled by the Eduversal HR / governance process. This policy is specifically about the induction relationship.

- **It is not a substitute for safeguarding policy.** Where a concern relates to child protection or staff safeguarding (sexual harassment, child welfare, etc.), the school's existing safeguarding policy takes priority and law-enforcement reporting requirements apply. The HQ Induction Coordinator acknowledges receipt and refers immediately.

---

## Open items

- [ ] Set up the `induction@eduversal.org` distribution list and confirm only the HQ Induction Coordinator and Director receive it.
- [ ] Drafttwo example anonymised case studies (one Category A, one Category B) for use in HQ Induction Coordinator training.
- [ ] Year 2: build the `/induction-admin` "Concerns" tab + `significant_concerns/{id}` Firestore collection + rules.
