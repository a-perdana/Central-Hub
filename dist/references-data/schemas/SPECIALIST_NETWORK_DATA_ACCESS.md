# Specialist Network-Data Access Pattern

**Version 1.0 — published 2026-05-31 by Eduversal.**

This document closes the New Subject Specialist Handbook open item: *"Network-data access pattern needs Firestore-rule formalisation (specialist sees subject-filtered EASE / appraisal aggregates)."*

It records the **decision** about how a Subject Specialist sees network-wide, subject-filtered EASE and appraisal data — and, importantly, why that decision is *not* a new Firestore rule.

---

## The need

A new Subject Specialist roves the network (≈15 partner schools) in their subject. To coach teachers and to propose KPI / appraisal item revisions (Window 4), they need to see **aggregated** EASE growth and teacher-appraisal patterns **across schools**, **filtered to their own subject(s)** (`users/{uid}.ch_subjects[]`).

This is genuinely different from the default read scope, which for `ease_growth` and `teacher_appraisals` is *owner + same-school staff + admin*. A specialist is Eduversal, belongs to no partner school, and needs cross-school visibility — but only in their subject, and only as aggregates.

## The decision: page-access + client-side subject filter, NOT a new rule

Since the **2026-05-20 CH authorization flattening** (root CLAUDE.md Common Mistake #51), Central Hub has exactly one rule-level bypass — `central_admin`. Every other CH user (director, coordinator, plain `central_user`, and therefore every Subject Specialist) is authorised by the **`/page-access` UI**, and the rule layer trusts that decision: whoever the admin lets onto a page can read and write what that page exposes. Sub-roles and `ch_subjects[]` are scoping labels for the UI, not rule-level capabilities.

The specialist network-data access pattern follows that model exactly:

1. **Page-access** decides whether a specialist reaches the EASE / appraisal aggregate surface at all. The admin grants the relevant CH page (e.g. a network-EASE or network-appraisal analytics view) to the specialist sub-roles.
2. **The page filters client-side** to `window.userProfile.ch_subjects[]` — a Math Specialist sees Math aggregates, a Science Specialist sees the combined-science set, etc. This mirrors the existing pattern used on pacing dashboards and the Department Workspace (`department-core.js` filters by `ch_subjects[]`; rule helper `isSubjectOwner()` exists for *write* paths to `department_notes`, not for cross-school aggregate reads).
3. **The rule layer is not changed.** Adding a bespoke "specialist sees cross-school subject-filtered `ease_growth` / `teacher_appraisals`" read rule would re-introduce exactly the sub-role-keyed rule complexity that 2026-05-20 deliberately removed. It would also be redundant: an active CH `central_user` is HR-onboarded `@eduversal.org` staff, and the threat model (Common Mistake #51) assumes they do not bypass the UI to read raw collections via DevTools.

**Net:** the access pattern is *formalised* — but as a page-access + client-filter pattern, which is the current architecture, not as a new Firestore rule. The handbook's open item asked for "Firestore-rule formalisation"; the correct 2026-post-flattening answer is "this is page-access-formalised, and that is by design."

## Boundaries (Charter)

- **Aggregates only.** The specialist sees subject-filtered *patterns* (school-level / cohort-level), never individual named-teacher appraisal scores from another school used as a ranking.
- **NN1 — never an appraisal input.** What a specialist observes on walkthroughs and reads in aggregates informs *coaching* and *KPI/appraisal item proposals*. It never feeds an individual teacher's appraisal score. The specialist's own induction walkthroughs are developmental and confidential (NN2).
- **Subject-scoped.** Empty `ch_subjects[]` = no subject data access. `central_admin` bypasses the subject filter (sees all), consistent with the unchanged subject-specialty gate.

## If a future requirement genuinely needs a rule

If audit pressure or a non-staff QA account ever requires rule-level enforcement of subject-scoped cross-school reads, the precedent is the pacing pattern: a helper like `isCHSubjectSpecialist(subjects)` already exists in `Central Hub/firestore.rules` (used by `*_pacing` write rules). A read rule could reuse it — but that is a deliberate re-introduction of sub-role-keyed rules and must be decided explicitly against the 2026-05-20 flattening, not added casually. Until then, page-access + client filter is the formalised pattern.

## Related

- New Subject Specialist Handbook — [`handbook-specialist-v1.json`](handbook-specialist-v1.json) (Window 1 network learning; Window 4 KPI/appraisal contribution).
- Root CLAUDE.md — "Authorization model (since 2026-05-20)" + Common Mistake #51 + `Central Hub/CLAUDE.md` "Authorization model".
- [Induction Charter](INDUCTION_CHARTER.md) — NN1 (induction/observation data never feeds appraisal), NN2 (confidentiality).
- [KPI_APPRAISAL_REVISION_WORKFLOW.md](KPI_APPRAISAL_REVISION_WORKFLOW.md) — what the specialist does with the patterns they find.
