/**
 * cambridge-crossref.js
 *
 * Phase 4 — surfaces Cambridge cross-references as a click-to-expand
 * popover on any CTS chip. Drop into any TH / AH / CH page that
 * renders a CTS chip; the chip becomes interactive without page-level
 * refactor.
 *
 * Usage:
 *   <span class="cts-chip" data-cts-ref="3.6"
 *         onclick="window.openCtsCrossref('3.6', this)">CTS 3.6</span>
 *
 * Or, more idiomatically, after rendering chips:
 *   document.querySelectorAll('[data-cts-ref]').forEach(el => {
 *     el.style.cursor = 'pointer';
 *     el.addEventListener('click', e => window.openCtsCrossref(el.dataset.ctsRef, el));
 *   });
 *
 * Dependencies:
 *   - window.db (Firestore instance, exposed by auth-guard)
 *   - The page's existing module-load of doc + getDoc from
 *     firebase-firestore.js v10. We dynamic-import these at first call
 *     so this file remains framework-agnostic.
 *
 * Caches the cambridge_crossref/index doc in memory for the session.
 */

(function () {
  if (window.__ctsCrossref) return; // singleton

  const cache = {
    indexDoc: null,
    inflight: null,
    popover: null,
  };

  async function loadIndex() {
    if (cache.indexDoc) return cache.indexDoc;
    if (cache.inflight) return cache.inflight;

    cache.inflight = (async () => {
      try {
        const { doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        const snap = await getDoc(doc(window.db, 'cambridge_crossref', 'index'));
        if (snap.exists()) cache.indexDoc = snap.data();
      } catch (err) {
        console.warn('[cts-crossref] index load failed', err);
      } finally {
        cache.inflight = null;
      }
      return cache.indexDoc;
    })();
    return cache.inflight;
  }

  function ensurePopoverEl() {
    if (cache.popover) return cache.popover;
    const el = document.createElement('div');
    el.className = '__cts-popover';
    el.setAttribute('role', 'dialog');
    el.style.cssText = `
      position: fixed; z-index: 9999;
      background: #fff; border: 1px solid #e5e0d8; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(28,28,46,.18);
      padding: 14px 16px; max-width: 360px; min-width: 280px;
      font-family: 'DM Sans', sans-serif; font-size: 12.5px; color: #1c1c2e;
      max-height: 60vh; overflow-y: auto;
      display: none;
    `;
    document.body.appendChild(el);
    cache.popover = el;

    // Dismiss on outside click + Escape.
    document.addEventListener('mousedown', (e) => {
      if (el.style.display === 'none') return;
      if (!el.contains(e.target) && !e.target.closest?.('[data-cts-ref]')) closePopover();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePopover();
    });
    return el;
  }

  function positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    const popW = 340; // approx; width clamps via maxWidth
    let left = rect.left;
    let top  = rect.bottom + 6;
    // Flip horizontally if overflow
    if (left + popW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - popW - 8);
    // Flip vertically if no room below
    if (top + 280 > window.innerHeight - 8 && rect.top > 280) {
      top = rect.top - 6 - 280;
    }
    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
  }

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function systemBadge(system) {
    const m = {
      kpi:        { bg: '#fef3c7', fg: '#92400e', label: 'KPI' },
      appraisal:  { bg: '#dbeafe', fg: '#1e40af', label: 'Appraisal' },
      competency: { bg: '#ede9fe', fg: '#5b21b6', label: 'Competency' },
    };
    const c = m[system] || { bg: '#f3f4f6', fg: '#374151', label: system };
    return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:${c.bg};color:${c.fg};letter-spacing:.05em;text-transform:uppercase;">${c.label}</span>`;
  }

  function trackLabel(item) {
    if (item.system !== 'competency') {
      if (item.track) return ` · ${item.track}`;
      return '';
    }
    const m = { teachers: 'Teachers', leaders: 'Leaders (AH)', specialists: 'Specialists (CH)' };
    return item.track ? ` · ${m[item.track] || item.track}` : '';
  }

  async function openCtsCrossref(ref, anchorEl) {
    const pop = ensurePopoverEl();
    pop.innerHTML = `<div style="color:#8888a8;font-size:12px;">Loading cross-references for CTS ${escHtml(ref)}…</div>`;
    pop.style.display = 'block';
    positionPopover(pop, anchorEl);

    const idx = await loadIndex();
    if (!idx || !idx.byStandard || !idx.byStandard[ref]) {
      pop.innerHTML = `
        <div style="font-weight:700;margin-bottom:6px;">CTS ${escHtml(ref)}</div>
        <div style="color:#8888a8;line-height:1.55;">No cross-references found for this Cambridge standard yet. The cross-ref index is built by an admin script and may be out of date.</div>
      `;
      return;
    }

    const entry = idx.byStandard[ref];
    const sourceText = entry.text || '';
    const items = Array.isArray(entry.items) ? entry.items : [];

    // Group by system for readable layout.
    const grouped = { kpi: [], appraisal: [], competency: [] };
    for (const it of items) (grouped[it.system] ||= []).push(it);

    const section = (system, list) => {
      if (!list.length) return '';
      return `
        <div style="margin-top:10px;">
          ${systemBadge(system)}
          <div style="margin-top:6px;">
            ${list.map(it => `
              <a href="${escHtml(it.link || '#')}" target="_self"
                 style="display:block;padding:6px 0;border-bottom:1px dashed #e5e0d8;color:#1c1c2e;text-decoration:none;line-height:1.5;">
                <span style="font-family:'DM Mono',monospace;font-size:10.5px;color:#8888a8;">${escHtml(it.id)}${escHtml(trackLabel(it))}</span>
                <div style="font-size:12.5px;font-weight:600;">${escHtml(it.label)}</div>
              </a>
            `).join('')}
          </div>
        </div>
      `;
    };

    pop.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px;">
        <div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:#5b21b6;font-weight:700;letter-spacing:.05em;">CAMBRIDGE TEACHER STANDARDS · CTS ${escHtml(ref)}</div>
          <div style="font-size:12.5px;color:#44445a;line-height:1.55;margin-top:4px;">${escHtml(sourceText)}</div>
        </div>
        <button onclick="window.__ctsCrossref.close()"
                style="background:none;border:1px solid #e5e0d8;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;color:#8888a8;flex-shrink:0;"
                aria-label="Close">✕</button>
      </div>
      <div style="border-top:1px solid #e5e0d8;padding-top:6px;">
        <div style="font-size:11px;color:#8888a8;margin-bottom:4px;">${items.length} sibling item${items.length === 1 ? '' : 's'} across the 3 systems:</div>
        ${section('kpi', grouped.kpi)}
        ${section('appraisal', grouped.appraisal)}
        ${section('competency', grouped.competency)}
      </div>
    `;
  }

  function closePopover() {
    if (cache.popover) cache.popover.style.display = 'none';
  }

  // Auto-wire: find any element that looks like a CTS chip (title contains
  // "Cambridge Teacher Standards" + a "CTS X.Y" pattern in its text) and
  // make it clickable. Pages that have already added explicit
  // onclick="openCtsCrossref(...)" handlers continue to work.
  function autowire(root) {
    const candidates = (root || document).querySelectorAll('[title*="Cambridge Teacher Standards"]');
    candidates.forEach(el => {
      if (el.dataset.ctsWired === '1') return;
      const m = (el.textContent || '').match(/CTS\s+([0-9]+\.[0-9]+)/);
      if (!m) return;
      const ref = m[1];
      el.dataset.ctsWired = '1';
      el.style.cursor = 'pointer';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openCtsCrossref(ref, el);
      });
    });
  }

  // First pass + observe for chips added later (modal opens, accordion expands).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => autowire());
  } else {
    autowire();
  }
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) autowire(document);
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  window.openCtsCrossref = openCtsCrossref;
  window.__ctsCrossref = { open: openCtsCrossref, close: closePopover };
})();
