/**
 * cambridge-crossref.js  (build: 2026-05-23r2 — switched fetch to no-cache)
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
    // CSLS — Cambridge School Leader Standards 2023 (AH only)
    csls: null,
    inflightCsls: null,
    // PMD — Permendiknas No.16/2007 four-pillar competency definitions
    pmd: null,
    inflightPmd: null,
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
        // 'no-cache' = always revalidate with the server (still uses cached
        // body if 304 Not Modified). Required because earlier deploys 404'd
        // on no-16-2007.json + school-leader-standards-2023.json, and any
        // browser that cached those failures with the previous 'force-cache'
        // semantics would keep returning the cached 404 forever. 2026-05-23.
        const res = await fetch(path, { cache: 'no-cache' });
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
  // CSLS — Cambridge School Leader Standards 2023 (AH leadership track anchor).
  // Same JSON shape as CTS but separate file. AH framework + appraisal chips
  // carry CSLS X.Y pattern.
  const loadCsls       = () => loadJson('/research/cambridge/school-leader-standards-2023.json', 'csls', 'inflightCsls');
  // PMD — Permendiknas No.16/2007 Four Pillars (kompetensi pedagogik, profesional,
  // sosial, kepribadian). Static lookup; small JSON, single fetch caches all four.
  const loadPmd        = () => loadJson('/research/permendiknas/no-16-2007.json',  'pmd',  'inflightPmd');

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
          !e.target.closest?.('[data-cts-ref],[data-skl-ref],[data-pigp-ref],[data-es-ref],[data-aicf-ref],[data-csls-ref],[data-pmd-ref],[data-ped-ref]')) {
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
  // CSLS popover — Cambridge School Leader Standards 2023 (AH track)
  // Mirrors openCtsCrossref but pulls from school-leader-standards-2023.json
  // instead of the CTS Firestore index. Same chip click → verbatim standard
  // text + Cambridge link pattern.
  // ──────────────────────────────────────────────────────────────────

  async function openCslsCrossref(ref, anchorEl) {
    const pop = ensurePopoverEl();
    pop.innerHTML = `<div style="color:#8888a8;font-size:12px;">Loading Cambridge School Leader Standard <code>${escHtml(ref)}</code>…</div>`;
    pop.style.display = 'block';
    positionPopover(pop, anchorEl);

    const data = await loadCsls();
    if (!data || data.__loadError) {
      pop.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
          <div style="font-weight:700;">CSLS · ${escHtml(ref)}</div>
          ${closeBtn()}
        </div>
        <div style="color:#8888a8;line-height:1.55;">Cambridge School Leader Standards JSON is not available offline.</div>
      `;
      return;
    }

    // ref format: "1.1", "4.6" — first digit = domain id, rest = standard id.
    const domainId = String(ref).split('.')[0];
    const domain = (data.domains || []).find(d => d.id === domainId);
    const standard = domain ? (domain.standards || []).find(s => s.id === ref) : null;

    if (!domain || !standard) {
      pop.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
          <div style="font-weight:700;">CSLS · ${escHtml(ref)}</div>
          ${closeBtn()}
        </div>
        <div style="color:#8888a8;line-height:1.55;">
          Standard <code>${escHtml(ref)}</code> not found in Cambridge School Leader Standards 2023.
          Check the tag spelling — valid forms look like <code>CSLS 1.1</code>, <code>CSLS 4.6</code>.
        </div>
      `;
      return;
    }

    pop.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px;">
        <div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:#0f766e;font-weight:700;letter-spacing:.05em;">CAMBRIDGE SCHOOL LEADER STANDARDS 2023 · CSLS ${escHtml(ref)}</div>
          <div style="font-size:11px;color:#8888a8;margin-top:2px;">Domain ${escHtml(domain.id)} · ${escHtml(domain.name)}</div>
        </div>
        ${closeBtn()}
      </div>
      <div style="border-top:1px solid #e5e0d8;padding-top:8px;">
        <div style="font-size:13px;color:#1c1c2e;line-height:1.55;font-weight:500;">${escHtml(standard.text)}</div>
        ${domain.summary ? `<div style="font-size:11.5px;color:#64748b;line-height:1.5;margin-top:8px;font-style:italic;">Domain ${escHtml(domain.id)} summary: ${escHtml(domain.summary)}</div>` : ''}
      </div>
      <div style="margin-top:10px;font-size:11px;color:#8888a8;line-height:1.5;">
        Cambridge International, ${escHtml(data.edition || 'School Leader Standards 2023')}. ${escHtml(data.publisher || 'Cambridge Assessment International Education')}.
      </div>
    `;
  }

  // ──────────────────────────────────────────────────────────────────
  // PMD popover — Permendiknas No.16/2007 Four Pillars
  // Static lookup against fourPillars map. Chip text is the pillar label
  // (e.g. "Kompetensi Pedagogik"); we slug it to the JSON key.
  // ──────────────────────────────────────────────────────────────────

  function slugifyPillar(s) {
    // "Kompetensi Pedagogik" → "pedagogik"; "kepribadian" → "kepribadian"
    const last = String(s).toLowerCase().trim().split(/\s+/).pop();
    return last.replace(/[^a-z]/g, '');
  }

  async function openPmdCrossref(ref, anchorEl) {
    const pop = ensurePopoverEl();
    pop.innerHTML = `<div style="color:#8888a8;font-size:12px;">Loading Permendiknas pillar <code>${escHtml(ref)}</code>…</div>`;
    pop.style.display = 'block';
    positionPopover(pop, anchorEl);

    const data = await loadPmd();
    if (!data || data.__loadError) {
      pop.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
          <div style="font-weight:700;">Permendiknas · ${escHtml(ref)}</div>
          ${closeBtn()}
        </div>
        <div style="color:#8888a8;line-height:1.55;">Permendiknas No.16/2007 source JSON is not available offline.</div>
      `;
      return;
    }

    const key = slugifyPillar(ref);
    const pillar = (data.fourPillars || {})[key];

    if (!pillar) {
      pop.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
          <div style="font-weight:700;">Permendiknas · ${escHtml(ref)}</div>
          ${closeBtn()}
        </div>
        <div style="color:#8888a8;line-height:1.55;">
          Pillar <code>${escHtml(key)}</code> not found. Expected one of: pedagogik, profesional, sosial, kepribadian.
        </div>
      `;
      return;
    }

    pop.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px;">
        <div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:#92400e;font-weight:700;letter-spacing:.05em;">PERMENDIKNAS NO.16/2007 · PILLAR</div>
          <div style="font-size:13px;font-weight:700;color:#1c1c2e;margin-top:4px;">${escHtml(pillar.label)}</div>
        </div>
        ${closeBtn()}
      </div>
      <div style="border-top:1px solid #f1ece4;padding-top:8px;">
        <div style="font-size:12.5px;color:#44445a;line-height:1.55;">${escHtml(pillar.definition)}</div>
        ${Array.isArray(pillar.competencies) && pillar.competencies.length ? `
          <div style="margin-top:10px;font-size:11px;color:#8888a8;">
            ${pillar.competencies.length} core competencies + indicators (full text in /references → Permendiknas 16/2007).
          </div>
        ` : ''}
      </div>
      <div style="margin-top:10px;font-size:11px;color:#8888a8;line-height:1.5;">
        Standar Kualifikasi Akademik dan Kompetensi Guru (Indonesian teacher academic qualifications + four-pillar competency standard, promulgated ${escHtml(data.datePromulgated || '2007')}).
      </div>
    `;
  }

  // ──────────────────────────────────────────────────────────────────
  // PED popover — Research bibliography (free-text citation chips)
  // No structured JSON source — the chip's title attribute carries the
  // full citation, the chip text carries the short form ("Robinson 2008").
  // Popover shows the full citation + a one-line "what this is" hint.
  // Primary value: kills click bubbling to the card AND surfaces the
  // full citation for the ESL audience that may not recognise the short form.
  // ──────────────────────────────────────────────────────────────────

  // Brief lookup map for the well-known secondary research anchors that
  // appear on the framework page's grounded-band. Each entry: { what, why }.
  // Match logic: try exact key first, then case-insensitive substring.
  // Unknown anchors fall through to the generic "bibliographic reference"
  // copy (so unknown chips still get the bubbling-stop + popover).
  const ANCHOR_BRIEFS = {
    'Danielson FfT': {
      what: 'Charlotte Danielson Framework for Teaching (4 domains × 22 components).',
      why: 'The North-American observation rubric Eduversal\'s Walkthrough Rubric was structurally modeled on. Used as the cross-walk anchor when calibrating observers across hubs.'
    },
    'Kraft 2018': {
      what: 'Kraft, Blazar & Hogan (2018) — meta-analysis of 60 causal studies on teacher coaching. Effect sizes: +0.49 SD on practice, +0.18 SD on student achievement.',
      why: 'Foundational evidence base for Specialist + Subject Leader coaching cycles. Cited to defend network investment in observation + Glow/Grow/Go protocols.'
    },
    'EEF Effective PD 2024': {
      what: 'Education Endowment Foundation — 14 mechanisms for effective professional development (4 families: build knowledge, motivate teachers, develop teaching techniques, embed practice).',
      why: 'Workshop + module design discipline. Every Specialist workshop maps to at least one mechanism per family — without that mapping, EEF evidence predicts <30% landing rate.'
    },
    'EEF Implementation 2024': {
      what: 'Education Endowment Foundation — School\'s Guide to Implementation 2024 (Explore / Prepare / Deliver / Sustain cycle).',
      why: 'Frame for multi-year CPD pathway design + annual workshop programmes at department + network scale.'
    },
    'Cambridge GenAI Coursework Policy': {
      what: 'Cambridge International 2024 GenAI in Coursework policy. Requires student declaration of AI use + draft-version capture + in-class supervised drafting.',
      why: 'Coursework moderation discipline anchor. Undeclared AI use = malpractice; the policy is the line every Specialist coaches partner schools against.'
    },
    'UNESCO AI-CFT 2024': {
      what: 'UNESCO AI Competency Framework for Teachers (2024) — 5 aspects × 3 levels (acquire / deepen / create).',
      why: 'International alignment anchor for Eduversal\'s AICF v1.0 + xen-5 Cambridge AI authenticity work. Multi-framework triangulation expected at Lead-stage publication.'
    },
    'Wenger CoP': {
      what: 'Etienne Wenger (1998) — Communities of Practice framework. Communities develop shared practice through cumulative joint engagement.',
      why: 'Theoretical backbone of the subject CoP discipline. Justifies the structured-facilitation rule: CoPs producing shared repertoire outperform conversational CoPs 3-4× on practice change.'
    },
    'Lesson Study': {
      what: 'Japanese collaborative lesson research tradition (jugyō kenkyū). Cycles of plan → teach → observe → refine.',
      why: 'Reference pattern for moderated lesson observation work + co-design protocols. Cited as evidence for the network\'s structured observation cadence.'
    },
    'Robinson 2007': {
      what: 'Viviane Robinson (2007) — Student-Centred Leadership meta-analysis. 5 dimensions; Dimension 1 (Establishing Goals + Expectations) has largest effect size on student outcomes.',
      why: 'Foundational evidence for AH leadership track. Cited extensively in evsi (vision + strategy) domain.'
    },
    'Leithwood 2020': {
      what: 'Kenneth Leithwood (2020) — Seven Strong Claims About Successful School Leadership.',
      why: 'AH leadership track anchor. Claim 2 (shared vision) underpins evsi-1; claims 3-5 underpin pdpc domain.'
    },
    'Kotter Leading Change': {
      what: 'John Kotter — 8-step change framework. Establish urgency, form coalition, develop vision, communicate, empower, generate quick wins, consolidate, anchor.',
      why: 'AH change-leadership reference for evsi-4 (Leading Change & Sustaining Improvement).'
    },
    'Bruner spiral': {
      what: 'Jerome Bruner — Spiral Curriculum: same concept revisited at deeper levels each stage.',
      why: 'Curriculum-architecture anchor for cqa domain + Cambridge syllabus vertical alignment work.'
    },
    'Wiggins & McTighe': {
      what: 'Wiggins & McTighe — Understanding by Design (backward design). Define mastery → design assessments → design lessons.',
      why: 'Scheme-of-work design + curriculum review reference across all 3 hubs.'
    },
    'Rosenshine Principles': {
      what: 'Barak Rosenshine (2012) — 17 Principles of Instruction. Daily review, model, ask questions, scaffold, monitor, weekly + monthly review.',
      why: 'Operational backbone for partner-school classroom routines + Specialist coaching diagnoses.'
    },
    'Karpicke 2008': {
      what: 'Karpicke & Roediger (2008) — Retrieval Practice. Recalling from memory consolidates learning more than re-reading.',
      why: 'Evidence base for daily warm-up routines + Command Word of the Day discipline.'
    },
    'Sweller CLT': {
      what: 'John Sweller — Cognitive Load Theory. Working memory is limited; new techniques compete for it.',
      why: 'Sequencing + scheme-of-work pacing reference. Justifies the "no more than one new technique per lesson" rule.'
    },
    'Cummins BICS/CALP': {
      what: 'Jim Cummins — Basic Interpersonal Communication Skills vs Cognitive Academic Language Proficiency. ESL learners may develop BICS in 1-2 years but CALP takes 5-7.',
      why: 'ESL command-word + academic-writing pedagogy anchor. Frames why Cambridge command-word teaching needs daily routine, not one-off lesson.'
    },
    'City et al. Instructional Rounds': {
      what: 'City, Elmore, Fiarman & Teitel (2009) — Instructional Rounds in Education. Low-inference scripting + structured pattern-naming.',
      why: 'Discipline reference for cof-1 (Lesson Observation Technique). Imported into education from medical rounds.'
    },
    'Knight Impact Cycle': {
      what: 'Jim Knight (2017) — The Impact Cycle. Facilitative coaching model (teacher diagnoses gap, coach scaffolds).',
      why: 'Coaching style anchor — strongest for experienced teachers (paired with Bambrick for new teachers).'
    },
    'Bambrick-Santoyo': {
      what: 'Paul Bambrick-Santoyo (2016) — Get Better Faster. Directive coaching style (coach names gap, prescribes concrete action).',
      why: 'Coaching style anchor — strongest for new teachers + concrete classroom-management gaps.'
    },
    'BERA Ethics': {
      what: 'British Educational Research Association — Ethical Guidelines for Educational Research.',
      why: 'Standard for practitioner research at Lead-stage (xen-4, cof-4_lead). Required for video coaching libraries + research publication.'
    }
  };

  function lookupAnchorBrief(label) {
    if (ANCHOR_BRIEFS[label]) return ANCHOR_BRIEFS[label];
    const lower = String(label).toLowerCase();
    for (const k of Object.keys(ANCHOR_BRIEFS)) {
      if (lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)) return ANCHOR_BRIEFS[k];
    }
    return null;
  }

  function openPedCrossref(ref, anchorEl) {
    const pop = ensurePopoverEl();
    // ref is the FULL citation text passed at wire time (from title attribute).
    pop.style.display = 'block';
    const brief = lookupAnchorBrief(ref);
    const briefHtml = brief
      ? `
        <div style="font-size:12.5px;color:#1c1c2e;line-height:1.55;margin-bottom:8px;">${escHtml(brief.what)}</div>
        <div style="font-size:11.5px;color:#64748b;line-height:1.55;font-style:italic;border-left:3px solid #cbd5e1;padding-left:10px;">${escHtml(brief.why)}</div>
      `
      : `<div style="font-size:11.5px;color:#64748b;line-height:1.55;">Bibliographic reference anchoring this competency to research, regulation, or framework. The framework lists this as evidence the level descriptor draws on — open the relevant CPD reading in the Learning Path modal for the full Eduversal interpretation.</div>`;
    pop.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px;">
        <div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:#475569;font-weight:700;letter-spacing:.05em;">📖 RESEARCH ANCHOR</div>
          <div style="font-size:13px;font-weight:600;color:#1c1c2e;margin-top:4px;line-height:1.4;">${escHtml(ref)}</div>
        </div>
        ${closeBtn()}
      </div>
      <div style="border-top:1px solid #e5e0d8;padding-top:8px;">
        ${briefHtml}
      </div>
    `;
    positionPopover(pop, anchorEl);
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
    scope.querySelectorAll('.hb-tag.aicf, [data-aicf-ref], .aicf-pill').forEach(el => {
      if (el.dataset.aicfWired === '1') return;
      const ref = el.dataset.aicfRef;
      if (!ref) return; // no text fallback for AICF
      el.dataset.aicfWired = '1';
      el.title = el.title || 'Eduversal AI Competency Framework v1.0 — click for verbatim canonical content.';
      makeClickable(el, ref, openAicfCrossref);
    });

    // CSLS chips — Cambridge School Leader Standards 2023 (AH leadership track).
    //   Accepted forms: ".csls-pill" + data-csls-ref OR "CSLS X.Y" text pattern.
    scope.querySelectorAll('.csls-pill, [data-csls-ref]').forEach(el => {
      if (el.dataset.cslsWired === '1') return;
      let ref = el.dataset.cslsRef;
      if (!ref) {
        const m = (el.textContent || '').match(/CSLS\s+([0-9]+\.[0-9]+)/);
        if (!m) return;
        ref = m[1];
        el.dataset.cslsRef = ref;
      }
      el.dataset.cslsWired = '1';
      el.title = el.title || `Cambridge School Leader Standard ${ref} — click for verbatim text.`;
      makeClickable(el, ref, openCslsCrossref);
    });

    // PMD chips — Permendiknas No.16/2007 four-pillar competency labels.
    //   Chip text is the pillar label ("Kompetensi Pedagogik" / "Kompetensi Profesional"
    //   / "Kompetensi Sosial" / "Kompetensi Kepribadian"); we slugify to JSON key.
    scope.querySelectorAll('.perm-pill, [data-pmd-ref]').forEach(el => {
      if (el.dataset.pmdWired === '1') return;
      const ref = el.dataset.pmdRef || (el.textContent || '').trim();
      if (!ref) return;
      el.dataset.pmdWired = '1';
      el.title = el.title || `Permendiknas No.16/2007 four-pillar competency — click for verbatim definition.`;
      makeClickable(el, ref, openPmdCrossref);
    });

    // PED chips — free-text research bibliography. No structured JSON source;
    //   the chip's title attribute carries the FULL citation (chip text shows
    //   short form "Robinson 2008"). Wire so the chip click opens a popover
    //   with the full citation AND kills bubbling to the parent comp-row card.
    scope.querySelectorAll('.ped-pill, [data-ped-ref]').forEach(el => {
      if (el.dataset.pedWired === '1') return;
      // Prefer data-ped-ref, then existing title attribute, then text content.
      const ref = el.dataset.pedRef || el.getAttribute('title') || (el.textContent || '').replace(/^📖\s*/, '').trim();
      if (!ref) return;
      el.dataset.pedWired = '1';
      el.dataset.pedRef   = ref;
      makeClickable(el, ref, openPedCrossref);
    });

    // Grounded-band secondary research anchors — chips in the framework
    // page's "Secondary research anchors per competency" strip. Re-uses
    // openPedCrossref + the ANCHOR_BRIEFS lookup so well-known anchors
    // (Danielson, Kraft 2018, EEF, UNESCO etc.) get a brief instead of
    // the generic "bibliographic reference" copy.
    scope.querySelectorAll('.grounded-anchor').forEach(el => {
      if (el.dataset.gndWired === '1') return;
      const ref = (el.textContent || '').trim();
      if (!ref) return;
      el.dataset.gndWired = '1';
      el.dataset.pedRef   = ref;
      el.title = el.title || `Click for a brief on ${ref}.`;
      makeClickable(el, ref, openPedCrossref);
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
  window.openCslsCrossref = openCslsCrossref;
  window.openPmdCrossref  = openPmdCrossref;
  window.openPedCrossref  = openPedCrossref;
  window.__ctsCrossref = {
    open:     openCtsCrossref,
    openSkl:  openSklCrossref,
    openPigp: openPigpCrossref,
    openEs:   openEsCrossref,
    openAicf: openAicfCrossref,
    openCsls: openCslsCrossref,
    openPmd:  openPmdCrossref,
    openPed:  openPedCrossref,
    close:    closePopover,
  };
})();
