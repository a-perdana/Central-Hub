/**
 * cambridge-crossref.js
 *
 * Click-to-expand popover runtime for five chip families that surface
 * across induction handbooks, KPI / appraisal / competency UIs, and the
 * AI Competency Framework reader pages:
 *
 *   1. CTS chips           — Cambridge Teacher / School-Leader Standards
 *                            (cross-ref via cambridge_crossref/index Firestore doc).
 *   2. SKL chips           — Indonesian graduate-profile dimensions
 *                            (Permendikdasmen 10/2025, 8 dimensions).
 *   3. PIGP chips          — Indonesian induction articles + lampiran sections
 *                            (Permendiknas 27/2010, statutory induction framework).
 *   4. ES chips            — Eduversal Academic Standards madde id anchors
 *                            (23-section network-wide standards manual,
 *                             docs/research/eduversal/academic-standards/).
 *   5. AICF chips          — Eduversal AI Competency Framework v1.0 refIds
 *                            (3 parts × competency blocks + UNESCO selections,
 *                             docs/research/eduversal/ai-competency-framework/).
 *                            Accepted refId forms:
 *                              teacher.foundation.domainA
 *                              student.lower_secondary.strand2
 *                              institutional.staff_capability.level3
 *                              unesco_aicft.acquire
 *                              appendix.A_teacher_self_assessment
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
 *   - /research/eduversal/academic-standards/manifest.json     (ES chips)
 *   - /research/eduversal/academic-standards/search-blurbs.json (ES chip preview)
 *
 * Each hub's build.js copies the JSONs into dist/research/.
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
    esManifest: null,         // ES manifest.json — flat madde id index
    inflightEsManifest: null,
    esBlurbs: null,           // ES search-blurbs.json — popover preview text
    inflightEsBlurbs: null,
    esSections: {},           // ES section-NN.json — fetched on demand for "view full"
    // AICF — Eduversal AI Competency Framework v1.0 reference layer
    aicfPart1: null,          // eduversal-v1-part1-teacher.json
    inflightAicfPart1: null,
    aicfPart2: null,          // eduversal-v1-part2-student.json
    inflightAicfPart2: null,
    aicfPart3: null,          // eduversal-v1-part3-institutional.json
    inflightAicfPart3: null,
    aicfAppendices: null,     // eduversal-v1-appendices.json
    inflightAicfAppendices: null,
    aicfUnesco: null,         // unesco-ai-cft-2024.json
    inflightAicfUnesco: null,
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

  const loadPigp       = () => loadJson('/research/permendiknas/no-27-2010-pigp.json', 'pigp', 'inflightPigp');
  const loadSkl        = () => loadJson('/research/permendiknas/no-10-2025-skl.json',  'skl',  'inflightSkl');
  const loadEsManifest = () => loadJson('/research/eduversal/academic-standards/manifest.json',     'esManifest', 'inflightEsManifest');
  const loadEsBlurbs   = () => loadJson('/research/eduversal/academic-standards/search-blurbs.json', 'esBlurbs',   'inflightEsBlurbs');

  // AICF loaders — 5 reference files in docs/research/eduversal/ai-competency-framework/reference/
  // build.js copies these to dist/research/eduversal/ai-competency-framework/reference/
  const loadAicfPart1      = () => loadJson('/research/eduversal/ai-competency-framework/reference/eduversal-v1-part1-teacher.json',      'aicfPart1',      'inflightAicfPart1');
  const loadAicfPart2      = () => loadJson('/research/eduversal/ai-competency-framework/reference/eduversal-v1-part2-student.json',      'aicfPart2',      'inflightAicfPart2');
  const loadAicfPart3      = () => loadJson('/research/eduversal/ai-competency-framework/reference/eduversal-v1-part3-institutional.json','aicfPart3',      'inflightAicfPart3');
  const loadAicfAppendices = () => loadJson('/research/eduversal/ai-competency-framework/reference/eduversal-v1-appendices.json',         'aicfAppendices', 'inflightAicfAppendices');
  const loadAicfUnesco     = () => loadJson('/research/eduversal/ai-competency-framework/reference/unesco-ai-cft-2024.json',              'aicfUnesco',     'inflightAicfUnesco');

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
          !e.target.closest?.('[data-cts-ref],[data-skl-ref],[data-pigp-ref],[data-es-ref],[data-aicf-ref]')) {
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
  // ES popover (Eduversal Academic Standards — 23-section network manual)
  // ──────────────────────────────────────────────────────────────────
  //
  // Ref forms accepted:
  //   "7.3"      → subsection inside Section 07
  //   "15.1.1"   → 3-level madde inside Section 15
  //   "07"       → whole section (rare — usually tag at madde level)
  //
  // Manifest lookup is O(1) via flat maddeIndex. "View full madde"
  // button deep-links to /references?doc=eduversal-standards-section-07
  // so the reader-side viewer (built next) can render the full content.

  function parseEsRef(ref) {
    const s = String(ref || '').trim();
    if (!s) return null;
    // "ES-7.3.1" / "ES 7.3.1" / "es:7.3.1" — strip prefix if author wrote it.
    return s.replace(/^ES[\s:_-]*/i, '');
  }

  function esSectionIdFromMadde(maddeId) {
    // "7.3.1" → "07"; "15" → "15"; "5.15b" → "05".
    const m = String(maddeId).match(/^(\d+)/);
    if (!m) return null;
    return String(parseInt(m[1], 10)).padStart(2, '0');
  }

  async function openEsCrossref(rawRef, anchorEl) {
    const pop = ensurePopoverEl();
    const ref = parseEsRef(rawRef) || rawRef;
    pop.innerHTML = `<div style="color:#8888a8;font-size:12px;">Loading Eduversal Standard <code>${escHtml(ref)}</code>…</div>`;
    pop.style.display = 'block';
    positionPopover(pop, anchorEl);

    const manifest = await loadEsManifest();
    if (!manifest || manifest.__loadError) {
      pop.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
          <div style="font-weight:700;">ES · ${escHtml(ref)}</div>
          ${closeBtn()}
        </div>
        <div style="color:#8888a8;line-height:1.55;">Eduversal Academic Standards manifest is not available offline.</div>
      `;
      return;
    }

    // Check whole-section reference first (e.g. "07" or "7").
    const sectionId = String(parseInt(ref, 10) || 0).toString().padStart(2, '0');
    const sectionMeta = (manifest.sections || []).find(s => s.id === sectionId);
    const isWholeSection = /^\d{1,2}$/.test(ref) && sectionMeta;

    let sectionTitle = '';
    let maddeTitle   = '';
    let resolvedSectionId = '';

    if (isWholeSection) {
      sectionTitle      = sectionMeta.title;
      resolvedSectionId = sectionMeta.id;
    } else {
      const entry = (manifest.maddeIndex || {})[ref];
      if (!entry) {
        pop.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
            <div style="font-weight:700;">ES · ${escHtml(ref)}</div>
            ${closeBtn()}
          </div>
          <div style="color:#8888a8;line-height:1.55;">
            Madde <code>${escHtml(ref)}</code> not found in the Eduversal Academic Standards manifest.
            Check the tag spelling — valid forms look like <code>ES 1.2</code>, <code>ES 7.3</code>, <code>ES 15.1.1</code>.
          </div>
        `;
        return;
      }
      sectionTitle      = entry.sectionTitle;
      maddeTitle        = entry.maddeTitle;
      resolvedSectionId = entry.sectionId;
    }

    const blurbsDoc = await loadEsBlurbs();
    const blurb     = !isWholeSection && blurbsDoc && !blurbsDoc.__loadError
      ? (blurbsDoc.blurbs || {})[ref] || ''
      : '';

    const sectionSlug = `section-${resolvedSectionId}`;
    const deepLink    = `/references?doc=eduversal-standards-${sectionSlug}`;

    pop.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px;">
        <div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:#0e7490;font-weight:700;letter-spacing:.05em;">EDUVERSAL ACADEMIC STANDARDS · ES ${escHtml(ref)}</div>
          <div style="font-size:11px;color:#8888a8;margin-top:2px;">Section ${escHtml(resolvedSectionId)} · ${escHtml(sectionTitle)}</div>
        </div>
        ${closeBtn()}
      </div>
      <div style="border-top:1px solid #e5e0d8;padding-top:8px;">
        ${maddeTitle ? `<div style="font-size:13px;font-weight:600;color:#1c1c2e;margin-bottom:6px;">${escHtml(maddeTitle)}</div>` : ''}
        ${blurb ? `<div style="font-size:12.5px;color:#44445a;line-height:1.55;">${escHtml(blurb)}</div>` : `<div style="font-size:12px;color:#8888a8;line-height:1.55;font-style:italic;">No preview text available — open the full madde for the complete content.</div>`}
        <div style="margin-top:10px;">
          <a href="${escHtml(deepLink)}" target="_self"
             style="display:inline-block;padding:6px 10px;border:1px solid #0891b2;border-radius:6px;color:#0e7490;text-decoration:none;font-size:11.5px;font-weight:600;letter-spacing:.02em;">
            Open full madde in /references →
          </a>
        </div>
      </div>
      <div style="margin-top:10px;font-size:11px;color:#8888a8;line-height:1.5;">
        Eduversal Academic Standards is the network-wide source of truth for governance, curriculum, assessment, safeguarding, QA, and operations. Tag a handbook task / framework item / competency descriptor with the relevant madde id to anchor it to the standard.
      </div>
    `;
  }

  // ──────────────────────────────────────────────────────────────────
  // AICF popover — Eduversal AI Competency Framework v1.0
  //   refId routing:
  //     teacher.*           → eduversal-v1-part1-teacher.json
  //     student.*           → eduversal-v1-part2-student.json
  //     institutional.*     → eduversal-v1-part3-institutional.json
  //     appendix.*          → eduversal-v1-appendices.json
  //     unesco_aicft.*      → unesco-ai-cft-2024.json
  // ──────────────────────────────────────────────────────────────────

  // Walk a JSON tree looking for a node whose refId matches the target.
  function findByRefId(node, targetRefId) {
    if (!node || typeof node !== 'object') return null;
    if (node.refId === targetRefId) return node;
    for (const key of Object.keys(node)) {
      if (key.startsWith('_')) continue; // skip _meta, _indexing, _purpose
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          const hit = findByRefId(item, targetRefId);
          if (hit) return hit;
        }
      } else if (child && typeof child === 'object') {
        const hit = findByRefId(child, targetRefId);
        if (hit) return hit;
      }
    }
    return null;
  }

  function aicfSourceBadge(refIdPrefix) {
    const m = {
      teacher:       { bg: '#fef3c7', fg: '#92400e', label: 'AICF · Teacher' },
      student:       { bg: '#dbeafe', fg: '#1e40af', label: 'AICF · Student' },
      institutional: { bg: '#ede9fe', fg: '#5b21b6', label: 'AICF · Institutional' },
      appendix:      { bg: '#f3f4f6', fg: '#374151', label: 'AICF · Appendix' },
      unesco_aicft:  { bg: '#dcfce7', fg: '#166534', label: 'UNESCO AI CFT 2024' },
    };
    return m[refIdPrefix] || { bg: '#f3f4f6', fg: '#374151', label: 'AICF' };
  }

  async function openAicfCrossref(rawRef, anchorEl) {
    const ref = String(rawRef || '').trim();
    if (!ref) return;

    const pop = ensurePopoverEl();
    pop.innerHTML = `<div style="color:#8888a8;font-size:12px;">Loading AI Competency Framework reference…</div>`;
    pop.style.display = 'block';
    positionPopover(pop, anchorEl);

    const prefix = ref.split('.')[0];
    let doc = null;
    let loaderName = '';
    if (prefix === 'teacher')             { doc = await loadAicfPart1();      loaderName = 'Part 1 — Teacher'; }
    else if (prefix === 'student')        { doc = await loadAicfPart2();      loaderName = 'Part 2 — Student'; }
    else if (prefix === 'institutional')  { doc = await loadAicfPart3();      loaderName = 'Part 3 — Institutional'; }
    else if (prefix === 'appendix')       { doc = await loadAicfAppendices(); loaderName = 'Appendices'; }
    else if (prefix === 'unesco_aicft')   { doc = await loadAicfUnesco();     loaderName = 'UNESCO AI CFT 2024'; }

    if (!doc || doc.__loadError) {
      pop.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
          <div style="font-weight:700;">${escHtml(ref)}</div>
          ${closeBtn()}
        </div>
        <div style="color:#8888a8;line-height:1.55;">Source not available offline. Reference layer files for the AI Competency Framework are under docs/research/eduversal/ai-competency-framework/reference/.</div>
      `;
      return;
    }

    const node = findByRefId(doc, ref);
    if (!node) {
      pop.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
          <div style="font-weight:700;">${escHtml(ref)}</div>
          ${closeBtn()}
        </div>
        <div style="color:#8888a8;line-height:1.55;">No matching block found in ${escHtml(loaderName)}. Check the refId pattern.</div>
      `;
      return;
    }

    const badge = aicfSourceBadge(prefix);
    const title = node.title || node.summary || ref;
    // verbatim may be a string or an array of paragraphs
    let bodyHtml = '';
    if (node.verbatim) {
      if (Array.isArray(node.verbatim)) {
        bodyHtml = node.verbatim.map(p => `<p style="margin:0 0 8px 0;line-height:1.55;color:#1c1c2e;">${escHtml(p)}</p>`).join('');
      } else {
        bodyHtml = `<p style="margin:0 0 8px 0;line-height:1.55;color:#1c1c2e;">${escHtml(node.verbatim)}</p>`;
      }
    } else if (node.summary) {
      bodyHtml = `<p style="margin:0 0 8px 0;line-height:1.55;color:#1c1c2e;">${escHtml(node.summary)}</p>`;
    } else {
      bodyHtml = `<p style="color:#8888a8;line-height:1.55;">(No verbatim text or summary in this block.)</p>`;
    }

    // Deep-link to reader page when implemented (Phase 1c-1e). For now, link to /references.
    const deepLink = (() => {
      if (prefix === 'teacher')             return '/ai-framework-teacher?ref=' + encodeURIComponent(ref);
      if (prefix === 'student')             return '/ai-framework-student?ref=' + encodeURIComponent(ref);
      if (prefix === 'institutional')       return '/ai-framework-institutional?ref=' + encodeURIComponent(ref);
      if (prefix === 'appendix')            return '/references?doc=aicf-appendices&ref=' + encodeURIComponent(ref);
      if (prefix === 'unesco_aicft')        return '/references?doc=unesco-ai-cft-2024&ref=' + encodeURIComponent(ref);
      return '/references';
    })();

    pop.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px;">
        <div style="flex:1;min-width:0;">
          <span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:${badge.bg};color:${badge.fg};letter-spacing:.05em;text-transform:uppercase;">${escHtml(badge.label)}</span>
          <div style="font-weight:700;margin-top:6px;color:#e67e22;">${escHtml(title)}</div>
          <div style="font-size:10.5px;color:#8888a8;margin-top:2px;font-family:'JetBrains Mono',monospace;">${escHtml(ref)}</div>
        </div>
        ${closeBtn()}
      </div>
      <div style="border-top:1px solid #f1ece4;padding-top:8px;">
        ${bodyHtml}
      </div>
      <div style="margin-top:10px;border-top:1px dashed #e5e0d8;padding-top:8px;font-size:11px;">
        <a href="${escHtml(deepLink)}" style="color:#e67e22;text-decoration:none;font-weight:600;">Open full reference →</a>
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

    // ES chips — handbook + framework + competency render <span class="hb-tag es">ES 7.3.1</span>
    //   Accepted forms: "ES 7.3", "ES 15.1.1", "ES-1.2", "ES:5.15b".
    //   Whole-section refs ("ES 7") also work; popover shows section header only.
    scope.querySelectorAll('.hb-tag.es, [data-es-ref]').forEach(el => {
      if (el.dataset.esWired === '1') return;
      let ref = el.dataset.esRef;
      if (!ref) {
        const m = (el.textContent || '').match(/ES[\s:_-]+([0-9]+(?:\.[0-9]+){0,2}[a-z]?)/i);
        if (!m) return;
        ref = m[1];
        el.dataset.esRef = ref;
      }
      el.dataset.esWired = '1';
      el.title = el.title || 'Eduversal Academic Standards — click for the madde anchor + deep-link into /references.';
      makeClickable(el, ref, openEsCrossref);
    });

    // AICF chips — AI Competency Framework v1.0 reference blocks
    //   Accepted forms (the refId is verbatim, not parsed from text):
    //     <span class="hb-tag aicf" data-aicf-ref="teacher.foundation.domainA">Foundation · Domain A</span>
    //     <span data-aicf-ref="student.lower_secondary.strand2">Using AI Responsibly (LS)</span>
    //     <span data-aicf-ref="unesco_aicft.acquire">UNESCO · Acquire</span>
    //   refId pattern is more structured than ES/CTS so text-pattern matching is unreliable.
    //   The chip MUST carry data-aicf-ref explicitly — text-only chips are NOT auto-wired.
    scope.querySelectorAll('.hb-tag.aicf, [data-aicf-ref]').forEach(el => {
      if (el.dataset.aicfWired === '1') return;
      const ref = el.dataset.aicfRef;
      if (!ref) return; // no text fallback for AICF
      el.dataset.aicfWired = '1';
      el.title = el.title || 'Eduversal AI Competency Framework v1.0 — click for verbatim canonical content.';
      makeClickable(el, ref, openAicfCrossref);
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
  window.openEsCrossref   = openEsCrossref;
  window.openAicfCrossref = openAicfCrossref;
  window.__ctsCrossref = {
    open:     openCtsCrossref,
    openSkl:  openSklCrossref,
    openPigp: openPigpCrossref,
    openEs:   openEsCrossref,
    openAicf: openAicfCrossref,
    close:    closePopover,
  };
})();
