# Eduversal Design System

**Single source of truth** for visual identity across the five-app monorepo. Read this before adding a new HTML page, picking a color, or shipping a button style.

> Pairs with [`shared-design/tokens.css`](../shared-design/tokens.css) (the actual CSS variables) and per-app `base.css` files (component recipes).

---

## Brand at a glance

| Token | Value | Usage |
|---|---|---|
| `--brand` | `#6c5ce7` | Primary mor — buttons, active state, brand chrome |
| `--brand-dk` | `#5a4bd1` | Darker mor — hover, focus, active background |
| `--brand-2` | `#ede9fe` | Light tint — selected pill, badge background |
| `--secondary` | `#0891b2` | Companion cyan — secondary action, accent badge |
| `--secondary-dk` | `#0e7490` | Darker cyan — hover |
| `--secondary-2` | `#ccfbf1` | Cyan tint |
| `--brand-gradient` | `linear-gradient(135deg, #7c3aed, #0891b2)` | Hero CTAs, primary save buttons |

**Why mor + cyan?** Mor is in the Eduversal favicon and was already canonical in Teachers Hub. Cyan is Central Hub's existing accent. Pairing the two preserves both apps' visual memory while giving every Eduversal product a recognisable family identity (the gradient seals it). Academic Hub previously had no consistent accent — it adopts the same family.

---

## Typography

| Token | Family | Use |
|---|---|---|
| `--font-body` | DM Sans | Everything by default — body text, buttons, form inputs, navbar |
| `--font-title` | Lora (serif) | `.page-title`, hero `<h1>`, prominent section headings |
| `--font-mono` | DM Mono | Code, doc-IDs, badges with technical content |

**Type scale** (in `tokens.css`): `--text-xs` (11px) … `--text-5xl` (40px).
**Weights**: `--fw-normal` 400 / `--fw-medium` 500 / `--fw-semibold` 600 / `--fw-bold` 700.

**Rule:** body copy uses DM Sans. Use Lora ONLY for hero titles / page-level h1. Don't sprinkle serif/sans mixing on the same screen.

---

## Color palette

### Foreground (text)

| Token | Value | Use |
|---|---|---|
| `--ink` | `#1c1c2e` | Primary text |
| `--ink-2` | `#44445a` | Secondary text, labels |
| `--ink-3` | `#8888a8` | Tertiary text, captions, placeholder |

### Background (surface)

| Token | Value | Use |
|---|---|---|
| `--white` | `#ffffff` | Cards, modal background, input fills |
| `--paper` | `#f7f6f3` | Page background, table headers |
| `--paper-2` | `#efede8` | Striped rows, hover states |
| `--border` | `#e0ddd6` | Card borders, dividers |

### Semantic

| Token | Value | Use |
|---|---|---|
| `--green` `/-2` | `#059669` `/ #d1fae5` | Success, "approved", positive deltas |
| `--red` `/-2` | `#dc2626` `/ #fee2e2` | Error, destructive, "rejected" |
| `--amber` `/-2` | `#b07800` `/ #fef8e7` | Warning, "pending" |
| `--blue` `/-2` | `#1a5fa8` `/ #e8f0fb` | Info, neutral notification |

### Per-page accent overrides

Some pages have their own thematic accent (red for math pacing, green for biology, amber for appraisals, etc.). These override `--accent` only, NOT `--brand`. The pattern in a page `<style>` block:

```css
:root {
  --accent:    #c0392b;   /* math red */
  --accent-dk: #a93224;
  --accent-2:  #fdf0ef;
}
```

**`--brand` always remains mor**, so even a red-accented pacing page still uses mor for the navbar avatar gradient and global brand chrome.

---

### Role tags — one colour per position, network-wide

The appraisal model names **positions**, not people (`"Biology SS"`, `"Director of Primary"`), and those labels surface as tags wherever a role is shown — the supervisor pair on `/school-appraisals`, visit-team chips, domain-lead pickers. Each position has **one canonical colour, used on every surface**. Source of truth: [`Central Hub/partials/subject-config.js`](../../Central%20Hub/partials/subject-config.js) → `ROLE_TAG_COLORS` + `roleTagStyle(role)`.

Two rules generate the palette, and the first one is the important one:

1. **A subject specialist inherits its SUBJECT's colour.** `"Biology SS"` is Biology's green — the same green `/department-workspace` and `/department-artifacts` already use via `SUBJECT_ACCENT`. Giving roles a fresh independent palette would make Biology green on one page and something else on another, which is worse than no colour coding at all.
2. **Non-subject roles take their category colour** from [`roles-positions.json`](../../Central%20Hub/resources/roles-positions.json) → `categories`. The two Directors are `academic_leadership` (`#6c5ce7`, brand mor).

**Pairs that share a scope share a hue, split by depth, not by hue.** English SS Primary / Secondary, and Director of Primary / Secondary, are the same function at different school levels — a different hue would imply they are unrelated.

| Role | Fill | Basis |
|---|---|---|
| Biology SS | `#047857` | biology green |
| Chemistry SS | `#b45309` | chemistry amber |
| Physics SS | `#7c3aed` | physics violet |
| Bahasa SS | `#e11d48` | bahasa rose |
| Religion SS | `#4f46e5` | religion indigo |
| EduSTEAM SS | `#0e7490` | edu_steam cyan-deep |
| English SS Primary | `#be185d` | english pink |
| English SS Secondary | `#9d174d` | english pink, deepened |
| Director of Primary | `#6c5ce7` | academic_leadership mor |
| Director of Secondary | `#3730a3` | academic_leadership, deepened |
| *(unknown role)* | `#64748b` | neutral fallback |

**Fills are saturated, never 50-level tints.** A first pass used pale tints (`#d1fae5` etc.) and they were measurably indistinguishable at chip size — Physics SS and Director of Primary came out at **dE 0.0**, literally the same colour, because pale tints of different hues all collapse toward white.

**Editing the table means re-checking both axes — they trade off against each other:**
- **contrast** — white-on-fill ≥ 4.5 (WCAG AA, small bold text). Current range 4.70–9.93.
- **distinctness** — CIE76 dE ≥ 10 against *every* other fill. Current closest pair is 12.0 (the two English roles), which is intended.

Darkening a fill to fix contrast pushes it toward its neighbours and can break distinctness; the two constraints must be verified together, not in sequence.

**Applying it:** call `roleTagStyle(role)` and drop the result into a `style` attribute — it emits `color` / `background` / `border-color` plus `--role-ink` (the role's deep tone), so an *outlined* variant can keep the role's hue as its text colour instead of falling back to grey. Matching is exact but case- and whitespace-insensitive; an unknown role returns the neutral fallback rather than guessing, so a roster change degrades to grey instead of silently colliding with an existing colour.

**A `<select>` cannot be colour-coded per option across browsers.** Where a role is *chosen* rather than displayed, put a `.vt-swatch` circle beside the select and repaint it on `change` — see the visit-team editor and the supervision-plan modal on `/school-appraisals`.

---

## Spacing & layout

8px-based scale — `--space-1` (4px) through `--space-20` (80px).

**Container:** `--container-max: 1200px`. Every body-column wrapper on a page — `.hero-inner` / `.page-hero__inner` / `.page-wrap` / `.toolbar` / `.content` / `.summary-row` / `.page-footer__inner` / `.page-footer__meta` / any other top-level content column — MUST land at exactly 1200 px **measured content width**.

**Correct pattern** (works in practice, measures 1200 in DevTools at viewport ≥ 1280):
```css
.hero-inner /* or .page-wrap / .toolbar / .content / etc. */ {
  width: 100%;                       /* CRITICAL — see note below */
  max-width: var(--container-max);   /* = 1200 */
  margin: 0 auto;
  padding: 0;                        /* horizontal padding ZERO */
}
.hero { padding: 44px 0; }           /* vertical padding stays on outer */
```

**The `width: 100%` is not optional — applies to EVERY direct child of `<body>`, including the hero outer.** Pages shipping `<footer class="page-footer">` activate base.css's `body:has(> .page-footer) { display: flex; flex-direction: column }` sticky-footer rule. Inside a flex column, block-level children DO NOT auto-stretch to the parent's content width — they shrink to their own intrinsic content width unless explicitly told otherwise.

Apply `width: 100%` to:
- `.hero` / `.page-hero` (outer hero band — gradient bg may still appear full-bleed via `::before` overlay, but the actual wrapper collapses without this, dragging `.hero-inner` narrower than the body content below)
- `.hero-inner` / `.page-hero__inner` (so it stretches to fill the now-100% hero before clamping to `max-width: var(--container-max)`)
- `.toolbar`, `.content`, `.page-wrap`, any other top-level body-child wrapper

Without it at EVERY level, the cascade breaks somewhere — either hero collapses (body content wider than hero) or body wrappers collapse (hero wider than body). Both produce the same complaint from Alif. Don't trust intuition on flex-column stretch behavior; explicit `width: 100%` on every body-child wrapper is the only safe pattern.

For canonical `.page-hero__inner` + `.page-footer__inner` (which carry `var(--container-max)` clamp + their own 40 px padding in base.css), pages need a **page-local override** to strip that inner padding so content measures 1200:

```css
.page-hero__inner,
.page-footer__inner,
.page-footer__meta {
  max-width: var(--container-max);
  padding-left: 0;
  padding-right: 0;
}
```

**Patterns that LOOK correct on paper but fail in practice** (all flagged by Alif on 2026-05-25, multiple iterations):

1. **`max-width: 1280px` / `1320px` literal** — legacy, untokenised. Drift from earlier conventions; ships content wider than the rest of the network. Easy to spot.
2. **`max-width: calc(var(--container-max) + 80px)` + `padding: 0 40px`** — the "outer +80 padding × 2 → math 1200" pattern. Math says 1280 outer − 40 padding × 2 = 1200 content. **In practice it measures ~1022 px in DevTools** at viewport ≥ 1280. Don't trust the math; measure. This is the OVER-CORRECTION trap — once Alif flags "body content 1200 değil", do NOT reach for the calc(+80) pattern; reach for the **zero-padding** pattern above.
3. **Inconsistent rail across hero / body / footer** — even when each individual wrapper measures 1200, mixing the canonical `.page-hero__inner` (which carries its own padding) with a page-local `.page-wrap` (no padding) without the override above leaves a 40 px asymmetry. All three rails need the same `max-width: var(--container-max); padding: 0` envelope (or the page-local override on canonical wrappers).

**First-pass grep before claiming a page is design-system-compliant** — must return ZERO matches:
```
grep -nE 'max-width:\s*(1[0-9]{3}px|calc\(var\(--container-max\)\s*\+)' page.html
```
This catches literal `1200px` / `1280px` / `1320px` AND the calc(+80) over-correction. Only `max-width: var(--container-max)` (paired with horizontal padding 0 on outer + appropriate page-local overrides on canonical wrappers) is correct.

**Past incidents (all 2026-05-25, same page, same complaint, three rounds):**
- AH `/references` Phase 2 shell: shipped at 1120 content (literal `var(--container-max)` outer + inherited 40 padding from canonical wrappers). User: "body content de 1200 olmali". Round 1.
- Fixed `/references` to `calc(+80)` + `padding: 0 40px`. Math 1200, measured 1022. User: "halen ayni". Round 2.
- Fixed `/references` final: outer `var(--container-max)` + horizontal padding ZERO. Measured 1200 in DevTools. User: "nicin anlamiyorsun" → memory note [[references-three-rails-1200]] created.
- AH `/curriculum-map` + `/syllabus-coverage` went through the SAME 3-round arc within the same session because I missed the memory note. Final fix matches the /references three-rails pattern.

See [`references-three-rails-1200`](../../C:/Users/maliu/.claude/projects/c--Users-maliu-Desktop-Eduversal-Web/memory/feedback_references_three_rails_1200.md) memory note for the original specification this generalises.

```css
.page-wrap {
  max-width: var(--container-max);
  margin: 0 auto;
  padding: var(--space-8) var(--space-10);
}
```

**Hero ↔ page-wrap alignment — both wrappers must clamp + pad identically.** The hero block is full-bleed (gradient touches the viewport edges) but its inner text column AND the page content column below it must share the exact same left edge. The pitfall: applying horizontal padding on the **outer** `.hero` (clamp happens AFTER padding) and on the **inner** `.page-wrap` (clamp happens BEFORE padding) leaves the hero text 40 px to the left of the content column on viewports > 1280 px — visible misalignment, even though both wrappers nominally read 1200 px wide.

**Rule:** keep horizontal padding on the INNER wrappers (`.hero-inner` + `.page-wrap`), not on the outer `.hero`. Both inner wrappers carry `max-width: var(--container-max); margin: 0 auto; padding: 0 var(--space-10)` (40 px) — content left-edges then line up bit-perfect at every viewport.

```css
/* CORRECT — both wrappers clamp-then-pad in the same order */
.hero { padding: var(--space-9) 0 0; /* vertical only */ }
.hero-inner {
  max-width: var(--container-max);
  margin: 0 auto;
  padding: 0 var(--space-10);
}
.page-wrap {
  max-width: var(--container-max);
  margin: 0 auto;
  padding: var(--space-7) var(--space-10) var(--space-16);
}

/* WRONG — hero padding is outside the clamp, page-wrap padding is inside */
.hero { padding: var(--space-9) var(--space-10) 0; }
.hero-inner { max-width: var(--container-max); margin: 0 auto; }
```

Past incident 2026-05-21 on CH `/checklist-admin`: the page shipped with the WRONG pattern; widening the container 1100 → 1200 made the 40 px misalignment between hero title and the task-grid kart kolonları visible. Fix: move padding from `.hero` onto `.hero-inner` (commit `9f62bfb` in CH).

---

## Shadows

Two scales depending on background lightness:

```css
/* Light surface (default) — for cards, dropdowns, modals on white/paper bg */
box-shadow: var(--shadow-sm);   /* 0 1px 4px rgba(28,28,46,.07) */
box-shadow: var(--shadow);      /* 0 3px 14px rgba(28,28,46,.10) */
box-shadow: var(--shadow-lg);   /* 0 10px 40px rgba(28,28,46,.16) */

/* Dark surface — for hero / landing sections with dark bg */
box-shadow: var(--shadow-dark-sm);
box-shadow: var(--shadow-dark);
box-shadow: var(--shadow-dark-lg);
```

If a page invents its own `box-shadow` value, prefer wrapping it as a token and adding it here.

---

## Shape

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 6px | Small buttons, inline tags |
| `--radius` | 10px | Default — cards, inputs, dropdowns |
| `--radius-lg` | 16px | Large cards, modals |
| `--radius-xl` | 24px | Hero panels |

**Pill** (chip / badge): `border-radius: 100px`.

---

## Motion

```css
--transition:      0.2s ease;     /* hover, focus, common UI */
--transition-slow: 0.4s ease;     /* modal slide-in, larger reveals */
```

Avoid arbitrary durations.

---

## Z-index scale

```css
--z-dropdown: 100;
--z-modal:    200;
--z-toast:    300;
```

If you need `z-index: 9999`, you're fighting the system. Stop and check whether your element should actually be a toast (use `--z-toast`).

---

## Page families & canonical hero

Feature pages (user-facing content surfaces) AND admin/authoring tools belong to one of **eight semantic families**. The family chooses the hero gradient + accent by **function group**; the page does not pick its own colour scheme.

**Why this exists:** the 2026-05-19 audit found 6 bespoke hero gradients across 6 CH pages, each carrying 50-300 lines of hero CSS — collapsed to 3 canonical gradients (cyan/mor/dark). But by 2026-05-27 those 3 had become catch-alls: "mor" = references + admin + certs + department, "dark" = every appraisal/KPI/coaching surface. The colour signal was lost, so the set was expanded to **8 function-mapped families**. Each maps to a CH navbar function group (`groupKeys` in `Central Hub/partials/navbar.html`).

| Family | Accent | Function | Pages | Hero variant |
|---|---|---|---|---|
| **Communication** — feeds, threads, broadcast | cyan `#0891b2` | comms | `message-board`, `announcements`, `notifications`, `surveys` | `data-accent="cyan"` → `--hero-grad-cyan` |
| **Knowledge** — read/browse, reference, taxonomy | mor `#6c5ce7` | pd | `references`, `handbook`, `library`, `roles-positions`, `competency-framework`, `chip-families` | `data-accent="mor"` → `--hero-grad-mor` |
| **My Work** — per-uid CPD / induction / coaching | mor on dark | specialist | `my-induction`, `learning-path`, `specialist-portfolio/certificates`, `principal-coaching-*` | `data-accent="dark"` → `--hero-grad-dark` |
| **Assessment** — appraisal + KPI | amber `#d97706` | appraisals/KPI | `school/teacher-appraisals`, `school/teacher-kpi-admin`, `principal-appraisals/observations/360-admin` | `data-accent="amber"` → `--hero-grad-amber` |
| **Curriculum** — syllabus + authoring | teal `#14b8a6` | curriculum | `igcse/as-alevel/checkpoint syllabus`, `curriculum-map`, `national-*-alignment`, `teaching-progress`, `chapter-test-author`, `question-bank`, `ease-*`, `practice-*`, `diagrams` | `data-accent="teal"` → `--hero-grad-teal` |
| **People** — directory + credentials | rose `#e11d48` | comms (people) | `schools`, `staff`, `students-overview`, `certificates`, `certificate-verify` | `data-accent="rose"` → `--hero-grad-rose` |
| **Department** — live coordinator workflow | violet `#7c3aed` | deptoffice | `coordinators-meetings/directory/decisions`, `department-workspace/artifacts`, `activities`, `walkthroughs`, `walkthrough-review`, `weekly-checklist` | `data-accent="violet"` → `--hero-grad-violet` |
| **Operations** — config + record-keeping | slate `#475569` | admin | `console`, `page-access`, `rules-viewer`, `mail-composer`, `schedule-settings`, `feedback-management`, `survey-console`, `reports`, `inventory`, `pilot-enrolment`, `network-health`, `induction/orientation/competency/checklist-admin` | `data-accent="slate"` → `--hero-grad-slate` |
| *Subject* (sub-family) | per-subject | pacing | the 14 pacing pages | bespoke per-subject gradient via `build.js` `{{HERO_GRADIENT}}` — **sanctioned exception**, do NOT flatten to teal |

**Note on People + Operations:** these two families are *hand-curated semantics*, not derived 1:1 from a single `groupKeys` array (People pulls from comms + admin; Operations spans comms `inventory` + admin). Accepted by design — don't "fix" them by forcing a groupKeys match.

**Note on Operations:** Operations used to mean "no hero — plain `<h1>`". As of 2026-05-27 Operations pages DO carry a canonical slate `.page-hero` (inventory + reports already had mor heroes; the rest were migrated). The old "no hero" rule is retired.

**Canonical markup** (in any feature page that has a hero):

```html
<header class="page-hero" data-accent="cyan">
  <div class="page-hero__inner">
    <div class="page-hero__icon" aria-hidden="true"><!-- optional 64px square --></div>
    <div class="page-hero__text">
      <p class="page-hero__eyebrow">Platform Activity · CentralHub</p>
      <h1 class="page-hero__title">Notifications</h1>
      <p class="page-hero__desc">All platform activity in one place...</p>
    </div>
    <aside class="page-hero__kpis"><!-- optional: 1–4 .page-hero__kpi tiles --></aside>
  </div>
</header>
```

Don't write a new gradient. Don't override `.page-hero` background in a page `<style>` block. If a future page genuinely needs a **9th** family, add it to this table FIRST and add `--hero-grad-<name>` + `--paper-tinted-<name>` + `--hero-fade-<name>` + `--hero-kpi-bg-primary-<name>` to `tokens.css` AND the matching selector rows to all 3 hub stylesheets — page-level invention is forbidden.

The same discipline applies to **shared chrome under the hero** — `.page-toolbar` (sticky filter/search bar) and `.page-empty` (empty state with icon + title + desc) live in `shared-styles.css`; don't fork them per page.

### Liveliness pass (2026-05-29)

The 8 families gave every page a distinct *hue*, but each page still read **flat**: one static gradient band + a single faint radial blob + KPI tiles, then white cards. The 2026-05-29 pass added depth, brightness and motion **entirely through the canonical `.page-hero` block in `shared-styles.css`** — zero per-page edits, every page lit up at once. Four levers, all keyed off the `data-accent` / `data-page-accent` the page already declares:

1. **Richer hero texture.** `.page-hero::before` now layers a family **mesh** (two vivid radial blobs, top-right + bottom-left — `--hero-mesh-*`) under a fine white **dot-grid** (`--hero-dot-grid`, 22px) under the original soft radial-light. Brightens the deep base gradient and adds visible depth without changing the family identity.
2. **Brighter, family-keyed accent.** Each family exposes a bright **`--hero-vivid-*`** (the gradient's vivid stop) wired through a local `--hero-vivid` custom prop on the hero. It drives a **3px top accent rule + soft inset glow**, a **title text-shadow glow**, and the **icon tile tint**.
3. **Hero icon + motion.** `.page-hero__icon` is a family-tinted glass tile with a glow ring (via `color-mix(... var(--hero-vivid) ...)`) that lifts on hero hover. The hero fades+rises in on load; `.page-hero__text` / `.page-hero__kpis` stagger; KPI tiles get a family-vivid left bar + hover lift. All motion is disabled under `prefers-reduced-motion: reduce`.
4. **Accent bleed into content.** A **dedicated** `--family-accent` / `--family-soft` pair (per family, set on `body[data-page-accent]`) carries the hue past the hero: shared `.card` hover top-rule, `.page-toolbar` underline, `.page-info-strip` top rule. **It does NOT touch the global `--accent`** — many pages deliberately set their own `--accent` (AI-framework = orange, pacing = subject colour), and clobbering those would change page intent. New body-accent components should reach for `--family-accent`, not re-bind `--accent`.

**Tokens added to `tokens.css`:** `--hero-vivid-{8}`, `--hero-mesh-{8}`, `--accent-soft-{8}`, `--hero-dot-grid`. A future family must ship all four alongside the existing `--hero-grad-*` / `--paper-tinted-*` / `--hero-fade-*` / `--hero-kpi-bg-primary-*` set. **Currently CH-only** — the canonical block lives in `Central Hub/shared-styles.css`; AH/TH `base.css` get the same treatment when their next design-system pass runs (the tokens are already in the shared `tokens.css` source, so the cross-hub rollout is CSS-only).

**Reminder on padding placement:** when a page is built on `.hero` + `.hero-inner` + `.page-wrap` (the older 3-wrapper pattern still in use on `checklist-admin`, `kpi-admin`, etc.) keep horizontal padding on the INNER wrappers — see "Hero ↔ page-wrap alignment" under §Spacing & layout. The canonical `.page-hero` already does this correctly; the gotcha only bites legacy pages that haven't been migrated yet.

**Reminder on navbar clearance:** every hub ships a `position: fixed` navbar that occupies the top 62px of the viewport. The canonical `.page-hero` does NOT compensate for this — so any page using `.page-hero` must add `body { padding-top: 62px; }` in its page-local `<style>`. Mirror what `MyInduction.html` / `CompetencyFramework.html` / `LearningPath.html` already do; `base.css` doesn't add this globally because other layouts (dashboards, plain admin tools) set their own offsets. Past incident 2026-05-24 on AH `/references` + `/ai-prompts`: shipped first refactor without padding-top, hero rendered behind the navbar.

---

## Page background tint — match the hero family

Every page using the canonical `.page-hero` should also opt into the **family-tinted body background** so the hero gradient flows into a same-family wash instead of an abrupt edge against the default `#f7f6f3` paper. Opt-in is a single attribute on `<body>`:

```html
<body data-page-accent="cyan">    <!-- pairs with <header class="page-hero" data-accent="cyan"> -->
```

The attribute value MUST match the hero's `data-accent` value verbatim. Mismatch (hero `cyan` + body `mor`) defeats the purpose — the visual handoff between hero and body content will read as broken family.

**How it composes:**

1. **Body tint** (~3-4% saturated off-white) replaces the default `--paper`. Cards (`var(--white)`) still read as elevated above the tint.
2. **`.page-hero::after` fade** — a 40px gradient overlay rendered just BELOW the hero on the body background, picking up the same accent. Gives the hero → content handoff a soft gradient bleed instead of a hard edge.

Both are wired by the canonical CSS in each hub's `base.css` / `shared-styles.css`:

```css
body[data-page-accent="cyan"] { background: var(--paper-tinted-cyan); }
body[data-page-accent="mor"]  { background: var(--paper-tinted-mor); }
body[data-page-accent="dark"] { background: var(--paper-tinted-dark); }

.page-hero[data-accent="cyan"]::after { background: var(--hero-fade-cyan); }
.page-hero[data-accent="mor"]::after  { background: var(--hero-fade-mor); }
.page-hero[data-accent="dark"]::after { background: var(--hero-fade-dark); }
```

**Tokens** (in `shared-design/tokens.css`):

| Token | Value | Use |
|---|---|---|
| `--paper-tinted-cyan` | `#e6eef5` | ice — Communication family body |
| `--paper-tinted-mor`  | `#ece5f6` | lavender — Knowledge family body |
| `--paper-tinted-dark` | `#e9e5ec` | charcoal — My Work family body |
| `--paper-tinted-amber`  | `#f3ece2` | sand — Assessment family body |
| `--paper-tinted-teal`   | `#e3efed` | mint — Curriculum family body |
| `--paper-tinted-rose`   | `#f4e7eb` | blush — People family body |
| `--paper-tinted-violet` | `#ebe6f6` | iris — Department family body |
| `--paper-tinted-slate`  | `#e8ebef` | steel — Operations family body |
| `--hero-fade-{cyan,mor,dark}` | linear-gradient accent→tint | 40px bleed below the hero |
| `--hero-fade-{amber,teal,rose,violet,slate}` | linear-gradient accent→tint | 40px bleed below the new-family heroes (2026-05-27) |
| `--hero-kpi-bg-primary-{amber,teal,rose,violet,slate}` | alpha gradient of the family hue | primary-KPI tile tint so the highlighted stat picks up the family colour, not stray mor-purple (2026-05-27) |

**My CPD per-page accents** (2026-05-24, AH-specific so far) — `learning` / `portfolio` / `certificates` / `induction` get their own tint + fade variants. The `induction` variant reuses Knowledge's lavender (`#ece5f6`) so My-Induction sits visually next to References. New per-page accents must add **both** the body-tint and the hero-fade tokens, then the `body[data-page-accent="…"]` + `.page-hero[data-accent="…"]::after` rules — adding only one half breaks the bleed.

**Discipline:**

- ❌ Don't override `background` on `body` in a page `<style>` block — that defeats the `data-page-accent` rule. Use the attribute.
- ❌ Don't invent a new accent value (e.g. `data-page-accent="brand"`) — every value must have matching `--paper-tinted-*` AND `--hero-fade-*` tokens.
- ❌ Don't omit the attribute "because it's subtle" — the family handoff is part of the design system, not a nice-to-have. Without the attribute the page reads as un-themed against the default cream paper.
- ✅ If a page wants the family hero but explicitly NOT the tinted body (rare — usually a content-heavy reader page that wants white cards on neutral), leave `data-page-accent` off and document the exception in the page `<style>` block with a one-line comment.

Past incident 2026-05-24 on AH `/references` + `/ai-prompts`: refactor adopted `.page-hero` but forgot `data-page-accent` on body. Hero rendered correctly but the cyan/mor wash terminated abruptly at the hero edge against cream paper. Added in a follow-up commit alongside the navbar-clearance padding + canonical footer.

---

## Canonical footer

Every Communication / Knowledge / My Work page should ship the canonical `.page-footer` (already wired in each hub's `base.css` / `shared-styles.css`). The footer is what closes the page narratively — a forward-flow CTA + 1-2 nav columns pointing to logically-next surfaces, then a meta row.

**Markup** (direct child of `<body>`):

```html
<footer class="page-footer" role="contentinfo">
  <div class="page-footer__inner">
    <div class="page-footer__cta">
      <span class="page-footer__cta-eyebrow">{Family · Scope}</span>
      <h2 class="page-footer__cta-title">{Short one-line nudge.}</h2>
      <p class="page-footer__cta-desc">{Two sentences max. What this page invites the reader to do next.}</p>
      <a href="{relevant /slug}" class="page-footer__cta-btn">{Open X} <span aria-hidden="true">→</span></a>
    </div>
    <nav class="page-footer__nav" aria-label="{Page} footer navigation">
      <div class="page-footer__nav-group">
        <span class="page-footer__nav-heading">{Group A — e.g. My Hub}</span>
        <a href="..." class="page-footer__nav-link">...</a>
      </div>
      <div class="page-footer__nav-group">
        <span class="page-footer__nav-heading">{Group B — e.g. References}</span>
        <a href="..." class="page-footer__nav-link">...</a>
      </div>
    </nav>
  </div>
  <div class="page-footer__meta">
    <span class="page-footer__meta-left">© Eduversal · {Hub name}</span>
    <span class="page-footer__meta-right">{One-line page tagline}</span>
  </div>
</footer>
```

**Sticky-footer behaviour** is automatic via:

```css
body:has(> .page-footer) {
  display: flex; flex-direction: column; min-height: 100vh;
}
body:has(> .page-footer) > .page-footer { margin-top: auto; }
```

The footer pushes to the bottom on short pages without affecting tall pages. **The footer MUST be a direct child of `<body>`** — wrapping it in any intermediate `<div>` breaks the selector. JS modules / overlays / modals / drawer markup can sit anywhere; only the footer itself needs body-level placement.

**Family-matched CTA gradient:** the default `.page-footer__cta-btn` background is the mor gradient (`linear-gradient(135deg, #7c3aed 0%, #5a4bd1 100%)`). Knowledge family pages keep the default. **Communication / My Work / per-page-accent pages override** in the page `<style>` block to match accent:

```css
/* Communication family — cyan accent */
.page-footer__cta-btn {
  background: linear-gradient(135deg, #0891b2 0%, #0e7490 100%);
  box-shadow: 0 4px 14px rgba(8,145,178,0.35);
}
.page-footer__cta-btn:hover { box-shadow: 0 6px 18px rgba(8,145,178,0.45); }
```

For the My CPD per-page accents (`learning` / `portfolio` / `certificates` / `induction`), `tokens.css` ships matched `--footer-grad-*` / `--footer-radial-*-a` / `--footer-radial-*-b` / `--footer-cta-grad-*` / `--footer-cta-shadow-*` token sets — use them via:

```css
.page-footer { background: var(--footer-grad-induction); }
.page-footer::before { background: var(--footer-radial-induction-a), var(--footer-radial-induction-b); }
.page-footer__cta-btn { background: var(--footer-cta-grad-induction); box-shadow: var(--footer-cta-shadow-induction); }
```

**Content discipline:**

- **Eyebrow** = family + scope, max 4-5 words. Mirrors the hero's eyebrow style.
- **Title** = one short imperative sentence, not a question. "Anchor every decision in a source." not "Need to look something up?"
- **Desc** = two sentences max — what the page invites next, plus optionally one piece of context (read-only, confidential, etc.).
- **CTA button** = single action verb + the destination. "Open Principal Handbook →" not "Click here →".
- **Nav groups** = 2 groups × 3-4 links each is the sweet spot. Forward-flow (where to go next) > exhaustive (every related slug).
- **Meta tagline** = one short editorial line that hints at the page's discipline (e.g. "Read-only · Source of truth lives in docs/", "Listen → Diagnose → Act → Anchor · Charter NN1 + NN2 honoured"). NOT generic ("Updated 2026-05-24" — version info goes in commit history, not the footer).

**Discipline:**

- ❌ Don't wrap the footer in any div — sticky-footer breaks.
- ❌ Don't fork the gradient — use the family default or override only the `.page-footer__cta-btn` accent. The dark hero gradient on `.page-footer` itself is intentional across all families (closing tone), only My CPD per-page accents earn their own footer gradient via `--footer-grad-*`.
- ❌ Don't put admin-only actions in the footer CTA — admin actions live in `.page-hero__actions`. Footer CTAs are visitor-facing forward flow.
- ❌ Don't omit the footer "because the page is short". The sticky rule handles short pages; an Operations-family page (no hero) is the only legitimate footer-less case.

Past incident 2026-05-24 on AH `/references` + `/ai-prompts`: shipped first refactor without footer; added in same follow-up as the navbar-clearance padding and `data-page-accent` body tint.

---

## Per-app status

| App | Has shared `tokens.css`? | Has `base.css`? | Brand consistency |
|---|---|---|---|
| Teachers Hub | ✅ via `base.css` `@import` | ✅ Refactored 2026-04-06 | High |
| Central Hub | ✅ via `shared-styles.css` | ⚠️ uses `shared-styles.css` (similar, less component-rich) | Medium |
| Academic Hub | ✅ but loaded inline per page | ❌ | Low — Step 15 fixes this |

The 2026-05-03 design rollout (Steps 13–17):
- **Step 13 — Shared tokens** (this doc): one `tokens.css` in `shared-design/`, copied into each hub's dist.
- **Step 14**: Central Hub's `shared-styles.css` consumes the shared tokens via `@import` instead of duplicating them.
- **Step 15**: Academic Hub gets a `base.css` modeled on Teachers Hub's, removing the inline-style sprawl.
- **Step 16**: Cross-app navbar pattern reconciliation.
- **Step 17**: Mobile responsive QA pass.

---

## Adding a new component

1. Open the relevant hub's `base.css` (TH) or `shared-styles.css` (CH).
2. Reuse existing tokens — don't introduce raw hex values for color, padding or radius.
3. If you genuinely need a new value:
   - For one-off page accent: override `--accent` in that page's `<style>`.
   - For a colour or dimension that should be consistent everywhere: add it to `shared-design/tokens.css` and document it here.
4. Run `npm run lint:firestore` (catches some structural issues; CSS lint isn't here yet).
5. Push — every other hub gets the token on its next build.

---

## Don't do

- ❌ Hard-coded colors (`#6c5ce7`, `#7c3aed`, `rgba(28,28,46,.07)`) outside `tokens.css`.
- ❌ Per-page redefinition of `--brand` (override `--accent` instead).
- ❌ Mixing serif and sans on the same screen, except hero h1 = serif.
- ❌ Inline `<style>` blocks longer than ~50 lines — extract to a stylesheet.
- ❌ `z-index: 9999` ad-hoc values.
- ❌ Deleting tokens you don't use yourself — another hub probably does.

---

_Last sync with `shared-design/tokens.css`: 2026-05-03_
