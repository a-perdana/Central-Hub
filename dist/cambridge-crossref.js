/**
 * cambridge-crossref.js
 *
 * Click-to-expand popover runtime for three chip families that surface
 * across induction handbooks, KPI / appraisal / competency UIs:
 *
 *   1. CTS chips           — Cambridge Teacher / School-Leader Standards
 *                            (cross-ref via cambridge_crossref/index Firestore doc).
 *   2. SKL chips           — Indonesian graduate-profile dimensions
 *                            (Permendikdasmen 10/2025, 8 dimensions).
 *   3. PIGP chips          — Indonesian induction articles + lampiran sections
 *                            (Permendiknas 27/2010, statutory induction framework).
 *
 * UI is in English. PIGP + SKL source documents are in Bahasa Indonesia;
 * the popover shows the English summary first and exposes the verbatim
 * Bahasa text inside a collapsed <details> block so the original
 * statutory wording remains one click away (audit trail).
 *
 * Drop into any TH / AH / CH page that renders one of these chips; the
 * chip becomes interactive without per-page wiring.
 *
 * Dependencies:
 *   - window.db                    (Firestore — only required for CTS chips)
 *   - /research/permendiknas/no-27-2010-pigp.json     (PIGP chips)
 *   - /research/permendiknas/no-10-2025-skl.json      (SKL chips)
 *
 * Each hub's build.js copies the two JSONs into dist/research/permendiknas/.
 * If a JSON fails to load the popover degrades gracefully ("source not
 * available offline").
 */

(function () {
  if (window.__ctsCrossref) return; // singleton

  const cache = {
    indexDoc: null,           // CTS cross-ref index (Firestore)
    inflightCts: null,
    pigp: null,               // PIGP article lookup (research JSON)
    inflightPigp: null,
    skl: null,                // SKL dimension lookup (research JSON)
    inflightSkl: null,
    popover: null,
  };

  // ──────────────────────────────────────────────────────────────────
  // Source loaders
  // ──────────────────────────────────────────────────────────────────

  async function loadCtsIndex() {
    if (cache.indexDoc) return cache.indexDoc;
    if (cache.inflightCts) return cache.inflightCts;

    cache.inflightCts = (async () => {
      try {
        const { doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
        const snap = await getDoc(doc(window.db, 'cambridge_crossref', 'index'));
        if (snap.exists()) cache.indexDoc = snap.data();
      } catch (err) {
        console.warn('[crossref] CTS index load failed', err);
      } finally {
        cache.inflightCts = null;
      }
      return cache.indexDoc;
    })();
    return cache.inflightCts;
  }

  async function loadJson(path, cacheKey, inflightKey) {
    if (cache[cacheKey]) return cache[cacheKey];
    if (cache[inflightKey]) return cache[inflightKey];

    cache[inflightKey] = (async () => {
      try {
        const res = await fetch(path, { cache: 'force-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        cache[cacheKey] = await res.json();
      } catch (err) {
        console.warn('[crossref] failed to load ' + path, err);
        cache[cacheKey] = { __loadError: true };
      } finally {
        cache[inflightKey] = null;
      }
      return cache[cacheKey];
    })();
    return cache[inflightKey];
  }

  const loadPigp = () => loadJson('/research/permendiknas/no-27-2010-pigp.json', 'pigp', 'inflightPigp');
  const loadSkl  = () => loadJson('/research/permendiknas/no-10-2025-skl.json',  'skl',  'inflightSkl');

  // ──────────────────────────────────────────────────────────────────
  // Popover skeleton (shared across all 3 chip families)
  // ──────────────────────────────────────────────────────────────────

  function ensurePopoverEl() {
    if (cache.popover) return cache.popover;
    const el = document.createElement('div');
    el.className = '__cts-popover';
    el.setAttribute('role', 'dialog');
    el.style.cssText = `
      position: fixed; z-index: 9999;
      background: #fff; border: 1px solid #e5e0d8; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(28,28,46,.18);
      padding: 14px 16px; max-width: 380px; min-width: 300px;
      font-family: 'DM Sans', sans-serif; font-size: 12.5px; color: #1c1c2e;
      max-height: 65vh; overflow-y: auto;
      display: none;
    `;
    document.body.appendChild(el);
    cache.popover = el;

    document.addEventListener('mousedown', (e) => {
      if (el.style.display === 'none') return;
      if (!el.contains(e.target) &&
          !e.target.closest?.('[data-cts-ref],[data-skl-ref],[data-pigp-ref]')) {
        closePopover();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePopover();
    });
    return el;
  }

  function positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    const popW = 360;
    let left = rect.left;
    let top  = rect.bottom + 6;
    if (left + popW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - popW - 8);
    if (top + 320 > window.innerHeight - 8 && rect.top > 320) {
      top = rect.top - 6 - 320;
    }
    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
  }

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function closePopover() {
    if (cache.popover) cache.popover.style.display = 'none';
  }

  function closeBtn() {
    return `<button onclick="window.__ctsCrossref.close()"
              style="background:none;border:1px solid #e5e0d8;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;color:#8888a8;flex-shrink:0;"
              aria-label="Close">✕</button>`;
  }

  function verbatimDetails(label, idText) {
    if (!idText) return '';
    return `
      <details style="margin-top:8px;border-top:1px dashed #e5e0d8;padding-top:8px;">
        <summary style="cursor:pointer;font-size:11px;color:#8888a8;font-weight:600;letter-spacing:.04em;text-transform:uppercase;">
          ${escHtml(label)}
        </summary>
        <div lang="id" style="margin-top:6px;font-size:12px;color:#44445a;line-height:1.55;font-style:italic;white-space:pre-wrap;">${escHtml(idText)}</div>
      </details>
    `;
  }

  // ──────────────────────────────────────────────────────────────────
  // CTS popover
  // ──────────────────────────────────────────────────────────────────

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

    const idx = await loadCtsIndex();
    if (!idx || !idx.byStandard || !idx.byStandard[ref]) {
      pop.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
          <div style="font-weight:700;">CTS ${escHtml(ref)}</div>
          ${closeBtn()}
        </div>
        <div style="color:#8888a8;line-height:1.55;">No cross-references found for this Cambridge standard yet. The cross-ref index is built by an admin script and may be out of date.</div>
      `;
      return;
    }

    const entry = idx.byStandard[ref];
    const sourceText = entry.text || '';
    const items = Array.isArray(entry.items) ? entry.items : [];

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
        ${closeBtn()}
      </div>
      <div style="border-top:1px solid #e5e0d8;padding-top:6px;">
        <div style="font-size:11px;color:#8888a8;margin-bottom:4px;">${items.length} sibling item${items.length === 1 ? '' : 's'} across the 3 systems:</div>
        ${section('kpi', grouped.kpi)}
        ${section('appraisal', grouped.appraisal)}
        ${section('competency', grouped.competency)}
      </div>
    `;
  }

  // ──────────────────────────────────────────────────────────────────
  // SKL popover (Permendikdasmen 10/2025 — 8 graduate-profile dimensions)
  // ──────────────────────────────────────────────────────────────────

  async function openSklCrossref(ref, anchorEl) {
    const pop = ensurePopoverEl();
    pop.innerHTML = `<div style="color:#8888a8;font-size:12px;">Loading SKL dimension <code>${escHtml(ref)}</code>…</div>`;
    pop.style.display = 'block';
    positionPopover(pop, anchorEl);

    const data = await loadSkl();
    const dims = data?.eightDimensions?.dimensions || [];
    const dim  = dims.find(d => d.id === ref);

    if (data?.__loadError || !dim) {
      pop.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
          <div style="font-weight:700;">SKL · ${escHtml(ref)}</div>
          ${closeBtn()}
        </div>
        <div style="color:#8888a8;line-height:1.55;">${data?.__loadError
          ? 'SKL source document is not available offline.'
          : 'Dimension not found in Permendikdasmen 10/2025. Check the tag spelling.'}</div>
      `;
      return;
    }

    const headerNote = data?.eightDimensions?.intro_en || '';
    const sourceArt  = data?.eightDimensions?.sourceArticle || '';

    pop.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px;">
        <div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:#065f46;font-weight:700;letter-spacing:.05em;">SKL · ${escHtml((dim.label_en || ref).toUpperCase())}</div>
          <div style="font-size:11px;color:#8888a8;margin-top:2px;">Permendikdasmen 10/2025 · ${escHtml(sourceArt)}</div>
        </div>
        ${closeBtn()}
      </div>
      <div style="border-top:1px solid #e5e0d8;padding-top:8px;">
        <div style="font-size:13px;font-weight:600;color:#1c1c2e;margin-bottom:4px;">${escHtml(dim.label_en || dim.label_id || ref)}</div>
        <div style="font-size:12.5px;color:#44445a;line-height:1.55;">${escHtml(dim.summary_en || '')}</div>
        ${headerNote ? `<div style="margin-top:8px;font-size:11px;color:#8888a8;font-style:italic;">${escHtml(headerNote)}</div>` : ''}
        ${verbatimDetails('Verbatim (Bahasa Indonesia)', dim.verbatimDefinition_id)}
      </div>
      <div style="margin-top:10px;font-size:11px;color:#8888a8;line-height:1.5;">
        Tag this lesson dimension to articulate which Indonesian graduate profile attribute the lesson develops in students. Cambridge Teacher Standards describe what the <em>teacher</em> looks like; SKL describes what the <em>graduate</em> looks like.
      </div>
    `;
  }

  // ──────────────────────────────────────────────────────────────────
  // PIGP popover (Permendiknas 27/2010 — induction articles + lampiran)
  // ──────────────────────────────────────────────────────────────────

  async function openPigpCrossref(ref, anchorEl) {
    const pop = ensurePopoverEl();
    pop.innerHTML = `<div style="color:#8888a8;font-size:12px;">Loading PIGP <code>${escHtml(ref)}</code>…</div>`;
    pop.style.display = 'block';
    positionPopover(pop, anchorEl);

    const data = await loadPigp();
    if (data?.__loadError) {
      pop.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
          <div style="font-weight:700;">PIGP · ${escHtml(ref)}</div>
          ${closeBtn()}
        </div>
        <div style="color:#8888a8;line-height:1.55;">PIGP source document is not available offline.</div>
      `;
      return;
    }

    const articles = Array.isArray(data?.articles) ? data.articles : [];
    const lampiran = Array.isArray(data?.lampiran?.stages) ? data.lampiran.stages : [];

    // Reference can be an article id ("pasal-7") or a lampiran section id ("lampiran-B").
    let entry = articles.find(a => a.id === ref);
    let kind = 'article';
    if (!entry) {
      // Search lampiran stages + sub-sections.
      for (const st of lampiran) {
        if (st.id === ref) { entry = st; kind = 'lampiran'; break; }
        const subs = Array.isArray(st.subSections) ? st.subSections : [];
        const hit = subs.find(s => s.id === ref);
        if (hit) { entry = hit; kind = 'lampiran'; break; }
      }
    }

    if (!entry) {
      pop.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
          <div style="font-weight:700;">PIGP · ${escHtml(ref)}</div>
          ${closeBtn()}
        </div>
        <div style="color:#8888a8;line-height:1.55;">Reference not found in Permendiknas 27/2010. Check the tag spelling (e.g. <code>pasal-7</code>, <code>lampiran-B</code>).</div>
      `;
      return;
    }

    const eyebrow = kind === 'article' ? 'PIGP · ARTICLE' : 'PIGP · LAMPIRAN (ANNEX)';
    const verbatim = entry.verbatim_id || entry.verbatim_excerpt_id || entry.verbatim_id_excerpt || '';
    const summary  = entry.summary_en || '';

    pop.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px;">
        <div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:#991b1b;font-weight:700;letter-spacing:.05em;">${escHtml(eyebrow)}</div>
          <div style="font-size:11px;color:#8888a8;margin-top:2px;">Permendiknas 27/2010 · ${escHtml(data?.shortName || 'PIGP')}</div>
        </div>
        ${closeBtn()}
      </div>
      <div style="border-top:1px solid #e5e0d8;padding-top:8px;">
        <div style="font-size:13px;font-weight:600;color:#1c1c2e;margin-bottom:4px;">${escHtml(entry.label || ref)}</div>
        ${entry.timing ? `<div style="font-size:11px;color:#8888a8;margin-bottom:6px;">Timing: ${escHtml(entry.timing)}</div>` : ''}
        ${summary ? `<div style="font-size:12.5px;color:#44445a;line-height:1.55;">${escHtml(summary)}</div>` : ''}
        ${verbatimDetails('Verbatim (Bahasa Indonesia)', verbatim)}
      </div>
      <div style="margin-top:10px;font-size:11px;color:#8888a8;line-height:1.5;">
        PIGP is Indonesia's statutory induction framework for new teachers. Eduversal's Subject Teacher Handbook implements PIGP and goes beyond it (Charter Non-Negotiables 1, 3, 5).
      </div>
    `;
  }

  // ──────────────────────────────────────────────────────────────────
  // Auto-wire chips
  // ──────────────────────────────────────────────────────────────────

  function makeClickable(el, ref, opener) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      opener(ref, el);
    });
  }

  function autowire(root) {
    const scope = root || document;

    // CTS chips — anything with title containing "Cambridge Teacher Standards"
    // and a "CTS X.Y" pattern in its text. Matches existing usage across hubs.
    scope.querySelectorAll('[title*="Cambridge Teacher Standards"]').forEach(el => {
      if (el.dataset.ctsWired === '1') return;
      const m = (el.textContent || '').match(/CTS\s+([0-9]+\.[0-9]+)/);
      if (!m) return;
      el.dataset.ctsWired = '1';
      el.dataset.ctsRef = m[1];
      makeClickable(el, m[1], openCtsCrossref);
    });

    // SKL chips — handbook renders <span class="hb-tag skl">SKL: kewargaan</span>
    scope.querySelectorAll('.hb-tag.skl, [data-skl-ref]').forEach(el => {
      if (el.dataset.sklWired === '1') return;
      let ref = el.dataset.sklRef;
      if (!ref) {
        const m = (el.textContent || '').match(/SKL[:\s]+([a-z_]+)/i);
        if (!m) return;
        ref = m[1];
        el.dataset.sklRef = ref;
      }
      el.dataset.sklWired = '1';
      el.title = el.title || 'SKL · Permendikdasmen 10/2025 — click for the verbatim Indonesian dimension definition.';
      makeClickable(el, ref, openSklCrossref);
    });

    // PIGP chips — handbook renders <span class="hb-tag pigp">PIGP pasal-8</span>
    scope.querySelectorAll('.hb-tag.pigp, [data-pigp-ref]').forEach(el => {
      if (el.dataset.pigpWired === '1') return;
      let ref = el.dataset.pigpRef;
      if (!ref) {
        const m = (el.textContent || '').match(/PIGP\s+((?:pasal|lampiran)-[A-Za-z0-9-]+)/i);
        if (!m) return;
        ref = m[1].toLowerCase();
        el.dataset.pigpRef = ref;
      }
      el.dataset.pigpWired = '1';
      el.title = el.title || 'PIGP · Permendiknas 27/2010 — click for the verbatim Indonesian induction-law text.';
      makeClickable(el, ref, openPigpCrossref);
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

  window.openCtsCrossref  = openCtsCrossref;
  window.openSklCrossref  = openSklCrossref;
  window.openPigpCrossref = openPigpCrossref;
  window.__ctsCrossref = {
    open:     openCtsCrossref,
    openSkl:  openSklCrossref,
    openPigp: openPigpCrossref,
    close:    closePopover,
  };
})();
