---
title: "The Three Rating Systems — At a Glance"
audience: participant
readers: ["teacher", "subject_leader", "school_principal", "academic_coordinator"]
mode: both
docType: one-pager
language: en
languageNote: "ESL/EAL English — CEFR B1–B2. Short sentences, active voice, every term glossed on first use."
publishedOn: "2026-05-31"
publishedBy: Eduversal
purpose: "Single printable page that explains how KPI, Appraisal, and Competency differ and how they fit together. Resolves the most common confusion among staff."
provenance:
  - source: "Cambridge Teacher Standards 2023"
    publishedDate: "2023"
    note: "The shared anchor across all three systems."
references:
  framework: ["appraisal-framework-v2.json", "teacher-kpi-v1.json", "competency_framework (Firestore)"]
  cambridge: ["teacher-standards-2023.json"]
---

# The Three Rating Systems — At a Glance

Eduversal uses **three** systems to support your growth. People often mix them up. They are **separate on purpose**. Each one does a different job. This page explains all three in one place.

> **The one-sentence version:** **KPI** measures your *results this year*. **Appraisal** measures your *teaching practice* in a formal observation. **Competency** is your *long-term growth* as a professional. All three point back to the same Cambridge Teacher Standards.

---

## Side by side

| | **KPI** | **Appraisal (v2.1)** | **Competency Framework** |
|---|---|---|---|
| **What it asks** | "Did you reach your targets this year?" | "How strong is your teaching practice?" | "Where are you on your growth journey?" |
| **Who owns it** | Your school | The Eduversal network (same for all schools) | You — it is your own development path |
| **Who rates you** | Your school leader (you also self-submit) | Your appraiser (a school leader), in a formal observation | You self-assess; a reviewer confirms your evidence |
| **The scale** | Targets with numbers (e.g. "≥90%") + weights, total 100% | Each item scored **1–4**; the scores combine into one number, which becomes a letter band **A–F** | A **4-level ladder**: Awareness → Practitioner → Advanced → Lead |
| **How often** | Half-year and full-year check | Once a year (formal), with coaching in between | Ongoing — you move up when you are ready |
| **Does it "score" me?** | Yes — against your targets | Yes — A to F | No single score — you *earn* levels with evidence |
| **Where it lives** | Teachers Hub / Academic Hub → KPI pages | Teachers Hub / Academic Hub → Appraisal pages | Teachers Hub / Academic Hub / Central Hub → Competency Framework + Learning Path |

---

## What each one is, in plain words

### 1. KPI — *your results this year*
KPI stands for **Key Performance Indicator**. It is a list of **15 things your school cares about this year** — for example student academic performance, classroom engagement, attendance, inclusive teaching, and lesson-plan discipline. Each one has a **number target** and a **weight** (how much it counts). The weights add up to 100%.

Your school sets the targets. You and your leader check progress at the half-year point and again at the end of the year.

*Source: 15 KPIs with weights and targets — `teacher-kpi-v1.json`.*

### 2. Appraisal — *your teaching practice*
The **Eduversal Teacher Appraisal v2.1** looks closely at *how you teach*. It has four parts:

- **F1 — Administration** (20%): your records, plans, and compliance with school systems.
- **F2 — Class Observation** (**50%** — the biggest part): your actual teaching, watched in one formal lesson of 35–40 minutes, across four areas — Lesson Planning, Classroom Management, Instructional Process, and Assessment (45 points in total).
- **F3 — Work Inspection** (20%): a review of your work at the end-of-year meeting.
- **F4 — Student Survey** (10%): what your students say. *This part is shared with you for information — it does not change your final score.*

Your scores (each 1–4) combine into one number, which becomes a letter band from **A (Excellent)** to **F**. After the observation, your appraiser gives you feedback using **Glow / Grow / Go** (one strength, one area to grow, one next step).

*Source: four frameworks + weights + 1–4 scale + A–F bands — `appraisal-framework-v2.json`.*

### 3. Competency Framework — *your long-term growth*
The **Competency Framework** is not about one year. It is your **professional development map**. Your teaching practice is described across domains (for teachers, there are now **7 domains** — including a new **AI & Digital Literacy** domain — covering **28 competencies**).

For each competency, you move up a **4-level ladder**: **Awareness → Practitioner → Advanced → Lead**. You do not get a mark. You *earn* a level by showing evidence of your practice. You move at your own pace, over years.

*Source: live framework in Firestore — `competency_framework/teachers` (7×28), `…/leaders` (6×29), `…/specialists` (6×29).*

---

## How they fit together

```
                 Cambridge Teacher Standards 2023
                 (the shared backbone of all three)
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
      ┌──────┐          ┌───────────┐        ┌──────────────┐
      │ KPI  │          │ APPRAISAL │        │  COMPETENCY  │
      │results│         │ practice  │        │   growth     │
      │ THIS  │         │ ONE formal│        │  OVER YEARS  │
      │ YEAR  │         │ observation│       │              │
      └──────┘          └───────────┘        └──────────────┘
   numbers & targets    1–4 → A–F band     4-level ladder, by evidence
```

- **They share one backbone.** Every KPI, every appraisal item, and every competency points back to a **Cambridge Teacher Standard** (e.g. CTS 3.2 — *plan coherent, authentic and engaging lessons*). So they are different lenses on the *same* picture of good teaching, not three unrelated checklists.
- **They run on different clocks.** KPI = this year. Appraisal = a yearly snapshot of practice. Competency = a multi-year journey.
- **A school can use any one of them on its own.** They are built to be independent. Your school may pilot one, two, or all three.

---

## Common questions

**"If I get an A on Appraisal, do I automatically reach 'Lead' on Competency?"**
No. They are separate. A strong appraisal is good evidence *toward* a competency level, but Competency also asks for things an appraisal does not — like mentoring others or leading change over time.

**"Does my KPI score change my Appraisal letter?"**
No. They do not feed into each other. Your KPI is about targets; your Appraisal letter comes only from F1–F4.

**"Which one decides my future at the school?"**
Ask your school leader — each school decides how it uses these. The systems *describe* your work; how a school acts on them is a school decision.

**"This feels like a lot of measuring."**
The point is not to measure you more. It is to make growth **fair and clear**: the same standards for everyone, evidence instead of opinion, and support (coaching, a learning path) attached to each one.

---

*Keep this page. Bring it to any session about KPI, Appraisal, or the Competency Framework.*

*Anchored to: Cambridge Teacher Standards 2023 (`cambridge/teacher-standards-2023.json`); `appraisal-framework-v2.json`; `teacher-kpi-v1.json`; `competency_framework` (Firestore). Figures verified 2026-05-31.*
