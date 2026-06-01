/* ================================================================
   keyboard-enabler.js — Eduversal SHARED keyboard-activation runtime
   Source of truth: monorepo /shared-design/keyboard-enabler.js
   ----------------------------------------------------------------
   WCAG 2.1.1 (Keyboard) — Step A4, 2026-06-01.

   Problem: many interactive controls are <div>/<span>/<li> with a JS
   click handler. A mouse user can click them; a keyboard user cannot
   activate them (Enter/Space do nothing on non-button elements).

   This singleton runtime fixes activation GLOBALLY: any element marked
   role="button" (or role="tab"/"link") that is NOT a native <button>/<a>
   gets Enter + Space -> synthetic click(). So a page author only has to
   add `role="button" tabindex="0"` to the element — no per-element JS.

   Delivery: this file is the canonical reference. A BYTE-IDENTICAL copy
   lives in each hub root (Central Hub/ , Academic Hub/ , Teachers Hub/)
   and is build-injected like cambridge-crossref.js. It is NOT pulled via
   build.js `..` (that path fails silently on AH/TH Vercel standalone
   deploys — see memory feedback_shared_assets_vercel_fallback). Edit the
   block here AND all 3 hub copies together (manual-sync discipline).

   Design notes:
   - Uses a SINGLE delegated keydown listener on document (capture=false)
     — works for elements added later (dynamic render) with zero rewiring,
     no MutationObserver needed.
   - Only acts on role in {button, tab, link} AND tag NOT in {BUTTON, A,
     INPUT, SELECT, TEXTAREA} — native controls already handle keys.
   - Space: preventDefault to stop page scroll (button semantics).
   - Enter on role="link": triggers click (link semantics: Enter only).
   - Does NOT add tabindex — that stays the author's responsibility, so we
     never make a decorative element focusable by accident. If an element
     has role="button" but no tabindex, we still activate it IF it somehow
     receives focus, but it won't be tab-reachable until the author adds
     tabindex="0". (Markup pass adds both together.)
   - Idempotent: guarded against double-install.
   ================================================================ */
(function () {
  if (window.__eduversalKeyboardEnabler) return;
  window.__eduversalKeyboardEnabler = true;

  var NATIVE = { BUTTON: 1, A: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1 };
  var ACTIVATABLE_ROLES = { button: 1, tab: 1, link: 1, menuitem: 1, option: 1, switch: 1, checkbox: 1 };

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;

    // CRITICAL: if a page's own keydown handler already handled this (it
    // calls preventDefault before the event bubbles up to document), do
    // nothing — otherwise we'd double-fire the action on the ~57 pages that
    // already wire their own Enter/Space -> fn() handlers (they call fn()
    // directly AND our el.click() would re-trigger their click handler).
    if (e.defaultPrevented) return;

    var el = e.target;
    if (!el || el.nodeType !== 1) return;

    // Native interactive elements already handle Enter/Space themselves.
    if (NATIVE[el.tagName]) return;

    var role = el.getAttribute && el.getAttribute('role');
    if (!role || !ACTIVATABLE_ROLES[role]) return;

    // Don't hijack typing inside editable regions.
    if (el.isContentEditable) return;

    var isSpace = (e.key === ' ' || e.key === 'Spacebar');
    // role="link" activates on Enter only (matches anchor semantics).
    if (role === 'link' && isSpace) return;

    e.preventDefault();   // stop Space-scroll / Enter default
    // Fire a real click so existing click handlers (inline or addEventListener) run.
    if (typeof el.click === 'function') {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  }, false);
})();
