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

## Spacing & layout

8px-based scale — `--space-1` (4px) through `--space-20` (80px).

**Container:** `--container-max: 1200px`. Hero sections and page wrappers should respect this. Inline `max-width: 980px` etc. is a smell — use the token.

```css
.page-wrap {
  max-width: var(--container-max);
  margin: 0 auto;
  padding: var(--space-8) var(--space-10);
}
```

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
