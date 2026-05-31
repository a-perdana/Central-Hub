# Eduversal Professional Development — Operational Guides (`docs/pd/`)

**What this folder is:** the *delivery layer* for Eduversal's professional-development (PD) sessions — facilitator session plans, participant one-pagers, slide-deck outlines, and calibration workbooks. The Eduversal Academic Board uses these to run face-to-face and online PD with partner-school teachers and leadership teams.

**What this folder is NOT:** it is not a set of frameworks, handbooks, or checklists. Those already exist elsewhere in the repo and are the *source content*. The PD guides here only package that content into a form a facilitator can deliver in a room (or on a video call) in a fixed amount of time.

| If you want… | Go to |
|---|---|
| To *run a session* in front of educators | **`docs/pd/`** (here) |
| To know *why a role exists + how to ramp in 90 days* | `docs/handbooks/` (role-operational handbooks) |
| To know *what to do this week* in a role | `docs/weekly-checklists/` |
| The *frameworks themselves* (appraisal, KPI, competency) | `shared-design/frameworks/`, `docs/kpi/`, `competency_framework` (Firestore) |
| The *verbatim standards* we cite | `docs/research/` (Cambridge, Permendiknas, ES, AICF) |

---

## Index

```
docs/pd/
├── README.md                      ← this file
├── _facilitator-conventions.md    ← shared facilitation playbook — read once, applies to every session
├── 00-program-overview/
│   ├── july-pd-program-map.md             [planned]
│   └── three-rating-systems-at-a-glance.md  ⭐ participant one-pager
├── teachers/      [planned]   ← Teachers Hub audience
├── leaders/                   ← Academic Hub audience
│   ├── session-observer-calibration-f2.md   ⭐ facilitator session guide
│   └── workbook-f2-calibration-exercise.md  ⭐ participant workbook
├── specialists/   [planned]   ← Central Hub audience (train-the-trainer)
└── slides/        [planned]   ← slide-deck outlines (markdown, slide-shaped)
```

⭐ = flagship documents authored first (format reference for the rest).

---

## How to use a PD guide

Each **session guide** (`session-*.md`) is self-contained. A facilitator can read it once and run the session. It carries:

- **Learning objectives** — what participants can do by the end.
- **Materials & setup** — with separate notes for face-to-face and online.
- **Run-of-show** — a timed table (minute-by-minute blocks).
- **Facilitator talking points** — what to say, with the source cited for every claim.
- **Activities** — instructions, including the online breakout-room variant.
- **Common questions** — answers written in simple English.
- **Exit ticket** — a quick check that the session worked.

**One-pagers** (`onepager-*.md`) and **workbooks** (`workbook-*.md`) are participant-facing. They are printable and written in simple English (CEFR B1–B2) for an audience of Indonesian educators teaching in English.

---

## Authoring rules (for anyone editing this folder)

1. **Never re-write the frameworks.** Cite them. If a number, weight, or rubric line is needed, pull it from the source file and cite the path — do not paraphrase a standard into new "Eduversal text" (root `CLAUDE.md` Common Mistakes #9, #45).
2. **Cite source-file + path inline.** Example forms used throughout:
   - `(appraisal-framework-v2.json → F2 D3)` — a framework item
   - `(KPI: progress-monitoring — teacher-kpi-v1.json)` — a KPI
   - `(CTS 3.2 — cambridge/teacher-standards-2023.json)` — a Cambridge Teacher Standard
   - `(ES 7.3 — academic-standards/section-07.json)` — an Eduversal Academic Standards madde
   - Validate every `ES x.y` against `docs/research/eduversal/academic-standards/manifest.json` before committing (root `CLAUDE.md` #49). A reference that does not resolve is a publication blocker.
3. **Write in ESL / EAL English — the whole corpus, not only handouts.** All material is in English, but always *ESL / EAL* English (EAL = English as an Additional Language, the Cambridge-preferred term — for many participants English is a third language). Short sentences, active voice, common words first, every term glossed on first use, acronyms spelled out the first time in *each* document. Participant-facing text targets CEFR **B1–B2**. Facilitator notes may carry more professional terms (the reader is a trainer) but stay in plain, short-sentence English. The full rule is `_facilitator-conventions.md` §1 — read it before authoring.
4. **Naming.** Use "Eduversal" — never "HQ" or "headquarters" in participant-facing prose. Roles are "Eduversal Director / Specialist / Coordinator".
5. **Freshness.** Each guide's frontmatter lists `provenance[]` with the publish date of every standard it cites, so a reader can see at a glance whether the anchor is current (Cambridge 2023, Permendikdasmen 10/2025 SKL, UNESCO AI-CFT 2024, etc.). When a newer standard lands, re-check the guide before re-using it.
6. **Boundary.** A PD guide may *reference* a handbook anchor or a weekly-checklist task ID, but it must never copy their prose (root `CLAUDE.md` #46).

---

## Source frameworks these guides draw on (verified current)

| Framework | Source of truth | Shape (verified 2026-05-31) |
|---|---|---|
| **Teacher Appraisal v2.1** | `shared-design/frameworks/appraisal-framework-v2.json` | F1 (9 items, 20%) · F2 (45 items in 4 domains, **50%**) · F3 (10 items, 20%) + F3L leadership add-on (10) · F4 student survey (17, informative-only, 10%). Scale 1–4 (Distinguished→Unsatisfactory) → composite → A–F band. |
| **Teacher KPI** | `docs/kpi/teacher-kpi-v1.json` | **15 KPIs**, weighted to 100%. Each carries numeric half-year + full-year targets. |
| **Competency Framework v3** | `competency_framework/{teachers,leaders,specialists}` (Firestore) | teachers **7×28** (incl. `aid` AI & Digital Literacy domain), leaders 6×29, specialists 6×29. 4-level CPD ladder (Awareness → Practitioner → Advanced → Lead). |
| **AICF v1.0** | `docs/research/eduversal/ai-competency-framework/` + `…/practical/` | Teacher / student / institutional parts + practical playbooks (prompt library, classroom activities, decision trees, weekly tips). |

> Note on figures: an earlier project memory records "KPI 11" and "competency 6×24" — those are the legacy v1/v2 shapes. The numbers above are the live v3 figures, verified against the source files on 2026-05-31. Always confirm against the source file before quoting a count in a new guide.
