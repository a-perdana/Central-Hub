/* Eduversal Handbook Reader — shared design module
 * Canonical source: Central Hub/handbook.html
 * Synced to AH/TH via npm run sync:handbook
 * Edit this file, then run sync to propagate.
 */
(function () {
  'use strict';

  // ── Module-private state, populated by init() ──────────────────────
  let _hub = 'ch';
  let _charterUrl = 'references-data/schemas/INDUCTION_CHARTER.json';
  let _audienceFilter = null;     // (handbookArr) => filteredArr
  let _onAuthReady = null;
  let _booted = false;

  // ── Audience filters (per hub) ─────────────────────────────────────
  // CH: pass-through (all docs).
  // AH: handbooks where audience.platform === 'academichub' OR
  //     handbookKind ∈ {'school-facing','policy-topic','aicf-companion'}.
  // TH: handbooks where audience.platform === 'teachershub' OR
  //     handbookKind ∈ {'school-facing','policy-topic','aicf-companion'}.
  const SHARED_KINDS = ['school-facing', 'policy-topic', 'aicf-companion'];
  const DEFAULT_FILTERS = {
    ch: (arr) => arr,
    ah: (arr) => arr.filter(hb =>
      hb.audience?.platform === 'academichub'
      || SHARED_KINDS.includes(hb.handbookKind)
    ),
    th: (arr) => arr.filter(hb =>
      hb.audience?.platform === 'teachershub'
      || SHARED_KINDS.includes(hb.handbookKind)
    ),
  };

  function _applyAudienceFilter(arr) {
    if (typeof _audienceFilter === 'function') return _audienceFilter(arr) || [];
    const fn = DEFAULT_FILTERS[_hub] || DEFAULT_FILTERS.ch;
    return fn(arr) || [];
  }

  // ── Firestore SDK indirection ──────────────────────────────────────
  // Callers wire window.__firestoreSdk = { collection, doc, getDoc, getDocs,
  // query, limit, orderBy, where } from a <script type="module"> tag BEFORE
  // loading this file. We pull them into module scope on first boot.
  let collection, doc, getDoc, getDocs, query, limit, orderBy, where;

  let allHandbooks = [];
  let db;

  // ── Public entry point ─────────────────────────────────────────────
  // Call once from the page <script type="module"> that loaded the
  // Firestore SDK. opts:
  //   hub             — 'ch' | 'ah' | 'th'                      (default 'ch')
  //   charterUrl      — path to INDUCTION_CHARTER.json           (default 'references-data/schemas/INDUCTION_CHARTER.json')
  //   audienceFilter  — (arr) => arr; overrides default per hub  (optional)
  //   onAuthReady     — () => void; runs once when boot starts   (optional)
  function init(opts) {
    opts = opts || {};
    if (opts.hub) _hub = String(opts.hub).toLowerCase();
    if (opts.charterUrl) _charterUrl = opts.charterUrl;
    if (typeof opts.audienceFilter === 'function') _audienceFilter = opts.audienceFilter;
    if (typeof opts.onAuthReady === 'function') _onAuthReady = opts.onAuthReady;
    // Show the right shell + a loading spinner IMMEDIATELY — before authReady
    // fires and before the (network-bound) getDocs resolves. On a slow
    // connection the gap between page-load and Firestore-resolve can run
    // several seconds; without this the page sits blank and reads as broken.
    // (Past report 2026-05-31: a handbook "didn't open" — it was just loading
    //  with no visible feedback.) We pick the mode from the URL ?id= param so
    //  the correct view (reader vs browser) is visible during the wait.
    _showBootLoading();
    document.addEventListener('authReady', _boot);
  }

  // Pre-resolve loading state: classes the body so exactly one view shows,
  // then paints a spinner into whichever containers that view exposes. Safe
  // to call before Firestore data exists — _boot() overwrites these nodes.
  function _showBootLoading() {
    const requestedId = new URLSearchParams(window.location.search).get('id');
    const inReaderMode = !!requestedId;
    document.body.classList.add(inReaderMode ? 'is-reader-mode' : 'is-browser-mode');
    const spinner = (label) =>
      `<div class="hb-loading"><span class="hb-spinner" aria-hidden="true"></span>${escapeHtml(label)}</div>`;
    if (inReaderMode) {
      const content = document.getElementById('hbContent');
      if (content) content.innerHTML = spinner('Loading handbook…');
    } else {
      // Browser mode: paint a spinner into each bookshelf rail until the
      // spines render. Shelf labels stay so the page reads as "loading
      // the library", not "broken".
      ['hbShelfInduction', 'hbShelfRole', 'hbShelfSchool'].forEach((railId) => {
        const rail = document.getElementById(railId);
        if (rail) rail.innerHTML = spinner('Loading…');
      });
    }
  }

  async function _boot() {
    if (_booted) return;
    _booted = true;
    const sdk = window.__firestoreSdk || {};
    collection = sdk.collection;
    doc        = sdk.doc;
    getDoc     = sdk.getDoc;
    getDocs    = sdk.getDocs;
    query      = sdk.query;
    limit      = sdk.limit;
    orderBy    = sdk.orderBy;
    where      = sdk.where;
    db = window.db;
    if (typeof _onAuthReady === 'function') {
      try { _onAuthReady(); } catch (_) { /* host hook is best-effort */ }
    }
      try {
        const snap = await getDocs(query(collection(db, 'induction_programs'), limit(50)));
        allHandbooks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          allHandbooks = _applyAudienceFilter(allHandbooks);

        const params = new URLSearchParams(window.location.search);
        const requestedId = params.get('id');
        const inReaderMode = !!requestedId && allHandbooks.find(h => h.id === requestedId);

        // Reconcile the body mode-class. _showBootLoading() set one
        // optimistically from the URL before data existed; now that we know
        // whether the requested id actually resolved, swap to the real mode
        // (a bad/stale ?id= falls back to the browser).
        if (inReaderMode) {
          document.body.classList.remove('is-browser-mode');
          document.body.classList.add('is-reader-mode');
          bootReaderMode(requestedId);
        } else {
          document.body.classList.remove('is-reader-mode');
          document.body.classList.add('is-browser-mode');
          bootBrowserMode();
        }
      } catch (err) {
        console.error('boot', err);
        // Surface error in whichever container is visible — reader mode
        // by default since that's the legacy code-path. Browser mode
        // users get the banner injected into the first bookshelf rail
        // (which is always present in the shipped HTML shell).
        const errBanner = `<div class="hb-loading" style="color:#991b1b;">Could not load: ${escapeHtml(err.message || err.code || 'unknown')}</div>`;
        const readerEl = document.getElementById('hbContent');
        const browserEl = document.getElementById('hbShelfInduction');
        if (readerEl) readerEl.innerHTML = errBanner;
        if (browserEl) browserEl.innerHTML = errBanner;
      }
  }


/* ── Reader mode (existing single-handbook detail view) ──────────── */
// Group spec shared by the dropdown population + the toolbar kind badge.
// Native <optgroup> renders label as bold-italic-grey (browser default);
// visual richness is intentionally minimal — semantic grouping is what
// unblocks scanning the 28-item flat list. Kind badge in the toolbar
// surfaces the active handbook's family with a colour-coded pill so the
// reader's mental model stays in sync with /handbook browser facets.
const HANDBOOK_GROUPS = [
  { kind: 'induction',        emoji: '📕', short: 'Induction',         long: 'Induction (Year-1 mentee tracks)' },
  { kind: 'role-operational', emoji: '🛡', short: 'Role-Operational',  long: 'Role & Operational (specialist quick-refs)' },
  { kind: 'aicf-companion',   emoji: '🤖', short: 'AICF',              long: 'AICF Companion (AI use playbooks)' },
  { kind: 'school-facing',    emoji: '🏫', short: 'School-Facing',     long: 'School-Facing (student / teacher / parent / staff)' },
  { kind: 'policy-topic',     emoji: '📜', short: 'Policy-Topic',      long: 'Policy-Topic (safeguarding / behaviour / assessment …)' },
];

function updateKindBadge(handbookId) {
  const badge = document.getElementById('hbReaderKindBadge');
  if (!badge) return;
  const hb = allHandbooks.find(h => h.id === handbookId);
  if (!hb) { badge.hidden = true; return; }
  const kind = hb.handbookKind || 'induction';
  const group = HANDBOOK_GROUPS.find(g => g.kind === kind);
  if (group) {
    badge.dataset.kind = group.kind;
    badge.innerHTML = `<span class="emoji">${group.emoji}</span><span>${group.short}</span>`;
  } else {
    badge.dataset.kind = 'other';
    badge.innerHTML = `<span class="emoji">❔</span><span>Other</span>`;
  }
  badge.hidden = false;
}

function applyHandbookFilter(query) {
  const select = document.getElementById('hbSelect');
  if (!select) return;
  const q = (query || '').trim().toLowerCase();
  Array.from(select.querySelectorAll('optgroup')).forEach(og => {
    let visibleInGroup = 0;
    Array.from(og.querySelectorAll('option')).forEach(opt => {
      const match = !q || (opt.textContent || '').toLowerCase().includes(q);
      opt.hidden = !match;
      // Disabled keeps the option un-selectable when hidden — some browsers
      // ignore [hidden] on <option> but honour [disabled] for keyboard nav.
      opt.disabled = !match;
      if (match) visibleInGroup += 1;
    });
    og.hidden = visibleInGroup === 0;
  });
}

function bootReaderMode(requestedId) {
  const select = document.getElementById('hbSelect');
  select.innerHTML = '';
  // 5-way partition by handbookKind — mirrors bootBrowserMode().
  const GROUPS = HANDBOOK_GROUPS.map(g => ({ kinds: [g.kind], label: `${g.emoji} ${g.long}` }));
  const seenIds = new Set();
  GROUPS.forEach(group => {
    const members = allHandbooks
      .filter(hb => group.kinds.includes(hb.handbookKind || 'induction'))
      .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
    if (!members.length) return;
    const og = document.createElement('optgroup');
    og.label = `${group.label} (${members.length})`;
    members.forEach(hb => {
      const opt = document.createElement('option');
      opt.value = hb.id;
      opt.textContent = hb.title || hb.id;
      og.appendChild(opt);
      seenIds.add(hb.id);
    });
    select.appendChild(og);
  });
  // Catch-all for any future handbookKind that isn't in the partition above —
  // surfaces it as "Other" rather than silently dropping. Same defensive
  // posture as bootBrowserMode where unknown kinds fall through.
  const orphans = allHandbooks
    .filter(hb => !seenIds.has(hb.id))
    .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
  if (orphans.length) {
    const og = document.createElement('optgroup');
    og.label = `❔ Other (${orphans.length})`;
    orphans.forEach(hb => {
      const opt = document.createElement('option');
      opt.value = hb.id;
      opt.textContent = hb.title || hb.id;
      og.appendChild(opt);
    });
    select.appendChild(og);
  }
  select.value = requestedId;
  select.addEventListener('change', () => {
    const newId = select.value;
    const url = new URL(window.location.href);
    url.searchParams.set('id', newId);
    window.history.replaceState({}, '', url);
    renderHandbook(newId);
    updateKindBadge(newId);
  });
  renderHandbook(requestedId);
  updateKindBadge(requestedId);
  document.getElementById('btnPrint').addEventListener('click', () => window.print());

  // Filter input — only shown once dropdown is populated (avoids a useless
  // empty box on the half-second between auth-guard load and Firestore
  // resolve). debounce-free because list is small (≤30 handbooks) so
  // every-keystroke re-filter is cheap.
  const filterInput = document.getElementById('hbFilter');
  if (filterInput) {
    filterInput.hidden = false;
    filterInput.addEventListener('input', (ev) => applyHandbookFilter(ev.target.value));
    // Esc clears the filter
    filterInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        filterInput.value = '';
        applyHandbookFilter('');
      }
    });
  }

  initNNPopover();
}

/* ── Charter NN popover ───────────────────────────────────────────
   Single-instance popover anchored to the clicked .hb-tag.nn chip.
   INDUCTION_CHARTER.json fetched lazily on first click; cached for
   the page lifetime. Click outside / Escape closes. Click another
   chip re-anchors. */
let _charterCache = null;
let _nnPopoverEl = null;
async function loadCharter() {
  if (_charterCache) return _charterCache;
  try {
    const res = await fetch(_charterUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _charterCache = await res.json();
    return _charterCache;
  } catch (err) {
    console.warn('NN popover: charter fetch failed', err);
    _charterCache = { nonNegotiables: [] };
    return _charterCache;
  }
}
function getOrCreateNNPopover() {
  if (_nnPopoverEl) return _nnPopoverEl;
  _nnPopoverEl = document.createElement('div');
  _nnPopoverEl.className = 'hb-nn-popover';
  _nnPopoverEl.setAttribute('role', 'tooltip');
  document.body.appendChild(_nnPopoverEl);
  return _nnPopoverEl;
}
function positionNNPopover(chip) {
  const pop = getOrCreateNNPopover();
  const rect = chip.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  // Anchor below chip; flip above if it would overflow viewport.
  const scrollY = window.scrollY || window.pageYOffset;
  const scrollX = window.scrollX || window.pageXOffset;
  let top = rect.bottom + scrollY + 6;
  let left = rect.left + scrollX;
  if (left + popRect.width > scrollX + window.innerWidth - 12) {
    left = scrollX + window.innerWidth - popRect.width - 12;
  }
  if (left < scrollX + 12) left = scrollX + 12;
  // If bottom-half placement would clip below viewport, flip above.
  if (rect.bottom + 6 + popRect.height > window.innerHeight - 12) {
    top = rect.top + scrollY - popRect.height - 6;
  }
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
}
function closeNNPopover() {
  if (!_nnPopoverEl) return;
  _nnPopoverEl.classList.remove('open');
  document.querySelectorAll('.hb-tag.nn[aria-expanded="true"]').forEach(c => c.setAttribute('aria-expanded', 'false'));
}
async function openNNPopover(chip) {
  const nnId = (chip.dataset.nn || '').toLowerCase(); // e.g. "nn1"
  if (!nnId) return;
  const charter = await loadCharter();
  const entry = (charter.nonNegotiables || []).find(n => (n.id || '').toLowerCase() === nnId);
  const pop = getOrCreateNNPopover();
  const idLabel = nnId.toUpperCase();
  if (!entry) {
    pop.innerHTML = `
      <div class="hb-nn-popover-head">Charter <span class="hb-nn-popover-id">${escapeHtml(idLabel)}</span></div>
      <div class="hb-nn-popover-rule" style="color:var(--ink-3);font-style:italic;">Charter entry not found. Verify INDUCTION_CHARTER.json is current.</div>
    `;
  } else {
    pop.innerHTML = `
      <div class="hb-nn-popover-head">Charter Non-Negotiable <span class="hb-nn-popover-id">${escapeHtml(idLabel)}</span></div>
      <div class="hb-nn-popover-rule">${escapeHtml(entry.rule || '')}</div>
      <div class="hb-nn-popover-source">Source: <code>docs/induction/INDUCTION_CHARTER.json</code> · rule-enforced at <code>firestore.rules</code></div>
    `;
  }
  pop.classList.add('open');
  // Reset other chip states + mark this one open
  document.querySelectorAll('.hb-tag.nn[aria-expanded="true"]').forEach(c => c.setAttribute('aria-expanded', 'false'));
  chip.setAttribute('aria-expanded', 'true');
  // Position after content set (so popRect width is accurate)
  positionNNPopover(chip);
}
function initNNPopover() {
  // Delegated handler — chips are re-rendered on handbook switch, so
  // a one-shot delegated listener survives every render.
  if (window._nnPopoverWired) return;
  window._nnPopoverWired = true;
  document.addEventListener('click', (e) => {
    const chip = e.target.closest && e.target.closest('.hb-tag.nn[data-nn]');
    if (chip) {
      e.preventDefault();
      e.stopPropagation();
      const wasOpen = chip.getAttribute('aria-expanded') === 'true';
      if (wasOpen) closeNNPopover();
      else openNNPopover(chip);
      return;
    }
    // Click outside chip + outside popover → close
    if (_nnPopoverEl && !_nnPopoverEl.contains(e.target)) closeNNPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNNPopover();
    // Enter / Space on focused chip
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = e.target.closest && e.target.closest('.hb-tag.nn[data-nn]');
    if (!chip) return;
    e.preventDefault();
    const wasOpen = chip.getAttribute('aria-expanded') === 'true';
    if (wasOpen) closeNNPopover();
    else openNNPopover(chip);
  });
  // Close on scroll/resize (anchor would otherwise drift)
  window.addEventListener('scroll', closeNNPopover, { passive: true });
  window.addEventListener('resize', closeNNPopover);
}

/* ── Browser mode (partitioned by handbookKind) ─────────────────── */
function bootBrowserMode() {
  // 5-way partition by handbookKind: induction (default), role-operational,
  // school-facing, policy-topic, aicf-companion. The 'role' bucket collects
  // BOTH role-operational (DSL/AC/CC/SL/DR/SS/FR — operational guides) AND
  // aicf-companion (Teacher Playbook / Prompt Library / Red Lines / Decision
  // Trees / Weekly Tips / Classroom Activities — AI operational guides);
  // both are operational layers for working teachers. The 'school' bucket
  // collects school-facing (Student/Teacher/Parent/Staff CoC) AND policy-topic
  // (Safeguarding/Behaviour/Anti-Bullying). Cards inside each grid are
  // visually distinct via sectionGlyph + handbookKind-driven cardCls below.
  const partition = (...kinds) => allHandbooks.filter(hb => {
    const k = hb.handbookKind || 'induction';
    return kinds.includes(k);
  });
  const induction = partition('induction');
  const role = partition('role-operational', 'aicf-companion');
  const school = partition('school-facing', 'policy-topic');

  // Hero KPIs — total + per-category breakdown.
  document.getElementById('heroKpiTotal').textContent = allHandbooks.length;
  document.getElementById('heroKpiInduction').textContent = induction.length;
  document.getElementById('heroKpiRole').textContent = role.length;
  const heroKpiSchool = document.getElementById('heroKpiSchoolFacing');
  if (heroKpiSchool) heroKpiSchool.textContent = school.length;

  if (!allHandbooks.length) {
    // Empty-bank case — bookshelf rails get a single muted "no books"
    // line via renderShelfRail's own empty branch. No accordion to fill.
    document.querySelectorAll('.hb-shelf-rail').forEach(r => {
      r.innerHTML = '<div style="padding:12px 4px;color:var(--ink-3);font-size:12px;font-style:italic;">No handbooks indexed yet. Run <code>scripts/induction/seed-induction-programs.js</code>.</div>';
    });
    return;
  }

  // Bookshelf strip (2026-05-26) — sole browse surface since the
  // accordion+card grid was retired. Each shelf rail renders its
  // bucket's handbooks as vertical spines so the eye reads "N books
  // across 3 categories" at a glance. Spine click opens the preview
  // modal (openSpineModal); modal's "Open handbook" CTA opens the full
  // reader in a new tab.
  renderShelfRail('hbShelfInduction', induction);
  renderShelfRail('hbShelfRole', role);
  renderShelfRail('hbShelfSchool', school);
  const setShelfCount = (id, n) => {
    const el = document.getElementById(id);
    if (el) el.textContent = n;
  };
  setShelfCount('shelfCntInduction', induction.length);
  setShelfCount('shelfCntRole', role.length);
  setShelfCount('shelfCntSchool', school.length);
  // Empty shelves hide entirely so we don't render a wood-edge with no
  // books on it.
  document.querySelectorAll('.hb-shelf').forEach(shelf => {
    const railId = shelf.querySelector('.hb-shelf-rail')?.id;
    const n = railId === 'hbShelfInduction' ? induction.length
            : railId === 'hbShelfRole'      ? role.length
            : railId === 'hbShelfSchool'    ? school.length : 0;
    shelf.classList.toggle('is-empty', n === 0);
  });

  // Seed facet chip counts. Section-count badges (data-count-for) are
  // gone with the accordion — bookshelf carries its own per-shelf count
  // (#shelfCnt*) seeded above.
  document.getElementById('cntAll').textContent = allHandbooks.length;
  document.getElementById('cntInduction').textContent = induction.length;
  document.getElementById('cntRole').textContent = role.length;
  const cntSchool = document.getElementById('cntSchool');
  if (cntSchool) cntSchool.textContent = school.length;
  // Dim facet chip when its category is empty (defensive — if role
  // section is empty during early Round 2 transitions).
  document.querySelectorAll('.hb-facet').forEach(b => {
    const cat = b.dataset.cat;
    if (cat === 'all') return;
    const n = parseInt(document.getElementById('cnt' + cat.charAt(0).toUpperCase() + cat.slice(1))?.textContent || '0', 10);
    b.classList.toggle('is-empty', n === 0);
  });

  // Wire facets, search, sticky-toolbar shadow.
  document.querySelectorAll('.hb-facet').forEach(btn => {
    btn.addEventListener('click', () => applyBrowserFacet(btn.dataset.cat));
  });
  const sInput = document.getElementById('hbBrowserSearch');
  const sClear = document.getElementById('hbBrowserSearchClear');
  sInput.addEventListener('input', () => applyBrowserSearch(sInput.value));
  sClear.addEventListener('click', () => { sInput.value = ''; applyBrowserSearch(''); sInput.focus(); });

  // Sticky-shadow IntersectionObserver — same pattern as /references.
  const toolbar = document.getElementById('hbToolbar');
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none;';
  toolbar.parentNode.insertBefore(sentinel, toolbar);
  try {
    new IntersectionObserver(
      ([e]) => toolbar.classList.toggle('is-stuck', !e.isIntersecting),
      { threshold: 0 }
    ).observe(sentinel);
  } catch (_) { /* IO unsupported — no shadow, harmless */ }

  // Spine click → preview modal (2026-05-26). Delegated handler so spines
  // re-rendered after filter changes still wire up automatically. Anchor
  // preventDefault keeps "open in new tab" working via middle-click +
  // ctrl/cmd-click (the anchor's own href takes over for those).
  document.querySelectorAll('.hb-shelf-rail').forEach(rail => {
    rail.addEventListener('click', ev => {
      const spine = ev.target.closest('.hb-spine');
      if (!spine) return;
      // Honour ctrl/cmd/middle-click + shift = native browser navigation.
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button === 1) return;
      ev.preventDefault();
      const id = new URL(spine.href, window.location.href).searchParams.get('id');
      if (id) openSpineModal(id);
    });
  });

  // Modal close wiring — close button, backdrop click, Escape key.
  const modal = document.getElementById('hbModal');
  if (modal) {
    const closeIds = ['hbModalClose', 'hbModalCloseBtn'];
    closeIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', closeSpineModal);
    });
    modal.addEventListener('click', ev => {
      if (ev.target === modal) closeSpineModal();
    });
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && !modal.hasAttribute('hidden')) closeSpineModal();
    });
  }
}

/* ── Spine preview modal (2026-05-26) ────────────────────────────────
   Click on a bookshelf spine opens this modal pre-populated with the
   handbook's metadata; the "Open handbook" anchor opens the full reader
   in a new tab so the modal stays available for cross-handbook
   comparison (Compact spec per user request). */
function openSpineModal(handbookId) {
  const hb = allHandbooks.find(h => h.id === handbookId);
  const modal = document.getElementById('hbModal');
  if (!hb || !modal) return;

  const kind = hb.handbookKind || 'induction';
  const dataKind = (kind === 'role-operational' || kind === 'aicf-companion') ? 'role'
                 : (kind === 'school-facing' || kind === 'policy-topic') ? 'school'
                 : 'induction';
  // Use the SPECIFIC kind for modal accent so a policy-topic doc gets
  // the amber palette + a aicf-companion gets the orange one — the spine
  // band on the shelf already uses the specific kind, modal mirrors it.
  modal.querySelector('.hb-modal').setAttribute('data-kind',
    kind === 'aicf-companion' ? 'aicf-companion'
    : kind === 'policy-topic' ? 'policy-topic'
    : dataKind);

  const kindEmoji = kind === 'aicf-companion' ? '🤖'
                  : kind === 'policy-topic'   ? '📜'
                  : kind === 'school-facing'  ? '🧭'
                  : kind === 'role-operational' ? '🛡' : '📕';
  const kindLabel = kind === 'aicf-companion' ? 'AICF Companion'
                  : kind === 'policy-topic'   ? 'Policy / Topic'
                  : kind === 'school-facing'  ? 'School-facing'
                  : kind === 'role-operational' ? 'Role / Operational' : 'Induction';

  document.getElementById('hbModalIcon').textContent = kindEmoji;
  document.getElementById('hbModalEyebrow').textContent = kindLabel;
  document.getElementById('hbModalTitle').textContent = hb.title || hb.id;
  document.getElementById('hbModalDesc').textContent = hb.subtitle || '';

  // Meta pills — audience + version + thickness + Firestore collection.
  // Same data the old .hb-card-meta showed; modal has more room so we
  // can lean on the longer audience string (platform · subRole) instead
  // of the spine's tight subRole-only fallback.
  const audience = [
    hb.audience?.platform,
    hb.audience?.subRole
      || (Array.isArray(hb.audience?.subRoleValues) ? hb.audience.subRoleValues.join(', ') : null)
      || hb.audience?.primaryReader,
  ].filter(Boolean).join(' · ');
  const stages = Array.isArray(hb.stages) ? hb.stages.length : 0;
  const sections = Array.isArray(hb.sections) ? hb.sections.length : 0;
  const hasSections = dataKind === 'school' || kind === 'aicf-companion';
  const thicknessLabel = hasSections
    ? (sections ? `${sections} sections` : '')
    : (stages ? `${stages} stages` : '');
  const metaParts = [];
  if (audience)       metaParts.push(`<span class="pill">${escapeHtml(audience)}</span>`);
  if (hb.version)     metaParts.push(`<span class="pill">v${escapeHtml(hb.version)}</span>`);
  if (thicknessLabel) metaParts.push(`<span class="pill">${escapeHtml(thicknessLabel)}</span>`);
  metaParts.push(`<span class="pill firestore">induction_programs</span>`);
  document.getElementById('hbModalMeta').innerHTML = metaParts.join('');

  // Chip-family hints — same detection the spine uses, no cap so the
  // modal shows every applicable family (spine truncates to 3).
  const chips = detectSpineChips(hb);
  document.getElementById('hbModalChips').innerHTML = chips.map(c =>
    `<span class="hb-modal-chip" data-chip="${c.k}" title="${escapeHtml(c.t)}">${c.label}</span>`
  ).join('');

  // Open-in-new-tab CTA — full reader URL.
  const openLink = document.getElementById('hbModalOpen');
  if (openLink) openLink.href = `handbook?id=${encodeURIComponent(hb.id)}`;

  modal.removeAttribute('hidden');
  document.body.style.overflow = 'hidden';
}

function closeSpineModal() {
  const modal = document.getElementById('hbModal');
  if (!modal) return;
  modal.setAttribute('hidden', '');
  document.body.style.overflow = '';
}

/* ── Bookshelf spine rendering (2026-05-26) ───────────────────────────
   Each handbook is rendered as a vertical "spine" — kind-coloured cloth
   band on the left + Lora vertical title + audience subline + thickness
   pill + up-to-3 chip-family hints (CTS / AICF / ES / NN). The spine
   anchor uses the same href contract as .hb-card so click semantics
   stay identical. Empty rails are rendered as a single muted line so
   the wood-shelf edge below still reads as a real shelf rather than a
   stray border. */
function renderShelfRail(railId, handbooks) {
  const rail = document.getElementById(railId);
  if (!rail) return;
  if (!handbooks.length) {
    rail.innerHTML = '<div style="padding:8px 4px;color:var(--ink-3);font-size:11px;font-style:italic;">No books on this shelf yet.</div>';
    return;
  }
  rail.innerHTML = handbooks.map(hb => {
    const kind = hb.handbookKind || 'induction';
    // Bucket spine-band colour by the same partition the grid uses:
    // role-operational + aicf-companion share the role band; school-facing
    // + policy-topic share the school band. Specific kinds keep their own
    // band when they need to read distinctly (policy-topic amber, aicf
    // orange) — CSS [data-kind] selectors above pick the right hue.
    const dataKind = (kind === 'role-operational' || kind === 'aicf-companion') ? 'role'
                   : (kind === 'school-facing' || kind === 'policy-topic') ? 'school'
                   : 'induction';
    const kindEmoji = kind === 'aicf-companion' ? '🤖'
                    : kind === 'policy-topic'   ? '📜'
                    : kind === 'school-facing'  ? '🧭'
                    : kind === 'role-operational' ? '🛡' : '📕';
    // Audience: prefer subRole label (terse) over platform — spine real
    // estate is tight. Falls back to primaryReader, then platform.
    const audienceShort =
      hb.audience?.subRole
      || (Array.isArray(hb.audience?.subRoleValues) ? hb.audience.subRoleValues[0] : null)
      || hb.audience?.primaryReader
      || hb.audience?.platform
      || '';
    // Thickness pill: stages for induction+role; sections for the rest.
    // Glyph + count reads as a content-volume cue ("how thick is this
    // book?") at a glance — much clearer than the earlier "13 sec" which
    // some readers parsed as "13 seconds".
    const stages = Array.isArray(hb.stages) ? hb.stages.length : 0;
    const sections = Array.isArray(hb.sections) ? hb.sections.length : 0;
    const hasSections = dataKind === 'school' || kind === 'aicf-companion';
    const thickness = hasSections
      ? (sections ? `📑 ${sections}` : '')
      : (stages ? `📚 ${stages}` : '');
    const chips = detectSpineChips(hb).slice(0, 3);
    const title = hb.title || hb.id;
    return `
      <a class="hb-spine" data-kind="${dataKind}" href="handbook?id=${encodeURIComponent(hb.id)}" title="${escapeHtml(title)}">
        <span class="hb-spine-kind">${kindEmoji}</span>
        <span class="hb-spine-title">${escapeHtml(title)}</span>
        <span class="hb-spine-audience">${escapeHtml(audienceShort)}</span>
        ${thickness ? `<span class="hb-spine-thickness">${escapeHtml(thickness)}</span>` : ''}
        ${chips.length
          ? `<span class="hb-spine-chips">${chips.map(c =>
              `<span class="hb-spine-chip" data-chip="${c.k}" title="${escapeHtml(c.t)}">${c.label}</span>`
            ).join('')}</span>`
          : ''}
      </a>
    `;
  }).join('');
}

/* Detect which chip families this handbook actually anchors to by
   walking its stages/sections/tasks/items for the canonical ref-field
   names. Each detected family contributes ONE chip, capped at 3 to
   protect spine real estate. Pure data inspection — no Firestore reads. */
function detectSpineChips(hb) {
  const chips = [];
  if (handbookHasField(hb, 'cambridge_standard_refs')
      || handbookHasField(hb, 'cambridgeStandardRefs')
      || hb.linkedFrameworks?.cts) {
    chips.push({ k: 'cts', label: 'CTS', t: 'Cambridge Teacher Standards' });
  }
  // CSLS — leadership-track anchor (principal induction handbook). Distinct
  // from CTS; surfaced as its own spine chip so the bookshelf is honest
  // about which Cambridge standard set the handbook is tagged against.
  if (handbookHasField(hb, 'cambridgeSchoolLeaderStandardRefs')
      || hb.linkedFrameworks?.cambridgeSchoolLeaderStandards2023) {
    chips.push({ k: 'csls', label: 'CSLS', t: 'Cambridge School Leader Standards' });
  }
  if (handbookHasField(hb, 'aicfRefs')) {
    chips.push({ k: 'aicf', label: 'AICF', t: 'AI Competency Framework' });
  }
  if (handbookHasField(hb, 'eduversalStandardRefs')) {
    chips.push({ k: 'es', label: 'ES', t: 'Eduversal Academic Standards' });
  }
  if (handbookHasField(hb, 'charterNonNegotiables')) {
    chips.push({ k: 'nn', label: 'NN', t: 'Charter Non-Negotiables' });
  }
  if (handbookHasField(hb, 'skl_refs') || handbookHasField(hb, 'sklRefs')) {
    chips.push({ k: 'skl', label: 'SKL', t: 'Standar Kompetensi Lulusan' });
  }
  if (handbookHasField(hb, 'pigp_refs') || handbookHasField(hb, 'pigpRefs')) {
    chips.push({ k: 'pigp', label: 'PIGP', t: 'Permendiknas 27/2010 PIGP' });
  }
  return chips;
}

/* Recursive any-node-carries-field check. Walks stages[].tasks[] and
   sections[].items[] and any nested arrays of objects looking for a
   truthy value on the named field. Stops at the first hit (chip
   detection doesn't need counts). */
function handbookHasField(hb, fieldName) {
  const seen = new WeakSet();
  function walk(node) {
    if (!node || typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) if (walk(item)) return true;
      return false;
    }
    const v = node[fieldName];
    if (Array.isArray(v) ? v.length > 0 : !!v) return true;
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child && typeof child === 'object') if (walk(child)) return true;
    }
    return false;
  }
  return walk(hb);
}

let _browserActiveFacet = 'all';

function applyBrowserFacet(cat) {
  _browserActiveFacet = cat || 'all';
  document.querySelectorAll('.hb-facet').forEach(b => {
    const on = b.dataset.cat === _browserActiveFacet;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  // Bookshelf is the sole browse surface — non-matching shelves dim to
  // grey so the "selected category" reads at a glance, but stay visible
  // so the user can still scan the whole collection. (Accordion +
  // .hb-section visibility logic retired 2026-05-26 along with the
  // card grid.)
  document.querySelectorAll('.hb-shelf').forEach(shelf => {
    const inFacet = _browserActiveFacet === 'all' || shelf.dataset.cat === _browserActiveFacet;
    shelf.classList.toggle('is-dimmed', !inFacet);
  });
  const sInput = document.getElementById('hbBrowserSearch');
  applyBrowserSearch(sInput ? sInput.value : '');
}

function applyBrowserSearch(qRaw) {
  const q = qRaw.trim().toLowerCase();
  const sClear = document.getElementById('hbBrowserSearchClear');
  const sInfo  = document.getElementById('hbBrowserSearchInfo');
  sClear.style.display = q ? '' : 'none';

  // Bookshelf-only filter: count visible spines per shelf, dim out-of-
  // facet shelves, toggle .filtered-out on individual spines when the
  // search term doesn't match their text content.
  let totalMatches = 0;
  document.querySelectorAll('.hb-shelf').forEach(shelf => {
    const shelfCat = shelf.dataset.cat;
    const inFacet = _browserActiveFacet === 'all' || _browserActiveFacet === shelfCat;
    shelf.classList.toggle('is-dimmed', !inFacet);
    let shelfMatches = 0;
    shelf.querySelectorAll('.hb-spine').forEach(spine => {
      if (!inFacet) { spine.classList.add('filtered-out'); return; }
      if (!q) { spine.classList.remove('filtered-out'); shelfMatches++; return; }
      const text = (spine.textContent || '').toLowerCase();
      const match = text.includes(q);
      spine.classList.toggle('filtered-out', !match);
      if (match) shelfMatches++;
    });
    if (inFacet) totalMatches += shelfMatches;
  });

  const emptyState = document.getElementById('hbShelvesEmpty');
  if (emptyState) emptyState.classList.toggle('visible', q !== '' && totalMatches === 0);

  if (!q) {
    sInfo.textContent = _browserActiveFacet === 'all' ? '' : `${totalMatches} in this facet`;
  } else {
    sInfo.textContent = `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`;
  }
}

/* ── renderHandbook ─ populates hero KPI tiles + TOC + content sections ── */
let _scrollSpyObserver = null;   // disposed + recreated per render

function renderHandbook(id) {
  const hb = allHandbooks.find(h => h.id === id);
  const content = document.getElementById('hbContent');
  if (!hb) {
    content.innerHTML = '<div class="hb-loading">Pick a handbook from the dropdown.</div>';
    document.getElementById('hbTocList').innerHTML = '';
    return;
  }

  // Hero — eyebrow + title + subtitle + 3 KPI tiles
  const audienceLine = [
    hb.audience?.platform,
    hb.audience?.subRole
      || (Array.isArray(hb.audience?.subRoleValues) ? hb.audience.subRoleValues.join(',') : null)
      || hb.audience?.primaryReader,
  ].filter(Boolean).join(' · ');
  // School-facing + policy-topic + aicf-companion handbooks use sections[]
  // (topic chapters); induction + role-operational use stages[] (time-windowed
  // phases). Reader treats both as an ordered list of content blocks —
  // renderStage and renderSection produce compatible HTML.
  const handbookKind = hb.handbookKind || 'induction';
  const isSchoolFacing = handbookKind === 'school-facing';
  const isPolicyTopic = handbookKind === 'policy-topic';
  const isAicfCompanion = handbookKind === 'aicf-companion';
  const hasSectionsArr = isSchoolFacing || isPolicyTopic || isAicfCompanion;
  const stagesArr = hasSectionsArr
    ? (Array.isArray(hb.sections) ? hb.sections : [])
    : (Array.isArray(hb.stages) ? hb.stages : []);
  const stageLabelPlural = hasSectionsArr ? 'Sections' : 'Stages';

  const eyebrowLabel = isAicfCompanion
    ? 'Eduversal AI Companion Handbook'
    : (isPolicyTopic
      ? 'Eduversal Policy Handbook'
      : (isSchoolFacing
        ? 'Eduversal School-Facing Handbook'
        : (handbookKind === 'role-operational' ? 'Eduversal Operational Handbook' : 'Eduversal Induction Handbook')));
  document.getElementById('hbReaderEyebrow').textContent =
    `${eyebrowLabel} · v${hb.version || '?'}`;
  document.getElementById('hbReaderTitle').textContent = hb.title || hb.id;
  document.getElementById('hbReaderSubtitle').textContent = hb.subtitle || '';

  // Hero KPI tiles: standard 3 (Days / Stages / Audience). If handbook
  // declares a weeklyChecklistLink, add a 4th tile that deep-links to
  // the matching /weekly-checklist surface on the audience's hub.
  // Pairs with the anchoredWeeks + weeklyChecklistTaskIds strips inside
  // each stage — handbook = "why+how", checklist = "what to do this week".
  //
  // Cross-hub URL routing: each hub has its own weekly-checklist.html;
  // pick the right host by audience.platform.
  const weeklyChecklistTile = (() => {
    if (!hb.weeklyChecklistLink) return '';
    const host = ({
      academichub:  'https://academichub.eduversal.org',
      teachershub:  'https://teachershub.eduversal.org',
      centralhub:   'https://centralhub.eduversal.org',
    })[hb.audience?.platform] || '';
    const platformParam = hb.weeklyChecklistLink.replace(/-/g, '_');
    const url = host
      ? `${host}/weekly-checklist?platform=${encodeURIComponent(platformParam)}`
      : `weekly-checklist?platform=${encodeURIComponent(platformParam)}`;
    const sameHub = hb.audience?.platform === 'centralhub';
    const targetAttr = sameHub ? '' : 'target="_blank" rel="noopener"';
    return `
      <a class="hero-kpi" href="${url}" ${targetAttr}
         style="text-decoration:none;border-color:rgba(165,243,252,0.5);background:linear-gradient(135deg, rgba(14,116,144,0.32) 0%, rgba(14,116,144,0.18) 100%);"
         title="Open the matching weekly checklist">
        <div class="hero-kpi-num" style="font-size:1rem;font-family:'DM Sans',sans-serif;color:#cffafe;">Weekly Checklist ↗</div>
        <div class="hero-kpi-lbl" style="color:rgba(207,250,254,0.85);">Paired with</div>
        <div class="hero-kpi-sub" style="color:rgba(207,250,254,0.6);">${escapeHtml(hb.weeklyChecklistLabel || hb.weeklyChecklistLink)}</div>
      </a>
    `;
  })();
  document.getElementById('hbReaderKpis').innerHTML = `
    <div class="hero-kpi hero-kpi-primary">
      <div class="hero-kpi-num">${hb.duration?.totalDays || '—'}</div>
      <div class="hero-kpi-lbl">Days</div>
      <div class="hero-kpi-sub">${hb.duration?.totalMonths ? hb.duration.totalMonths + ' months' : 'Year-1 induction'}</div>
    </div>
    <div class="hero-kpi">
      <div class="hero-kpi-num">${stagesArr.length}</div>
      <div class="hero-kpi-lbl">${stageLabelPlural}</div>
      <div class="hero-kpi-sub">${hb.publishedOn || ''}</div>
    </div>
    <div class="hero-kpi">
      <div class="hero-kpi-num" style="font-size:1.1rem;font-family:'DM Sans',sans-serif;">${escapeHtml(audienceLine || 'Network')}</div>
      <div class="hero-kpi-lbl">Audience</div>
      <div class="hero-kpi-sub">platform · sub-role</div>
    </div>
    ${weeklyChecklistTile}
  `;

  // Content — single column, section anchors id'd for TOC + scroll-spy.
  // Section id pattern: hb-sec-<key>; stage ids: hb-sec-stage-<index>
  // (we reuse the stage id scheme for school-facing + policy-topic sections
  // too so the TOC + scroll-spy work unchanged).
  const stageBlocks = stagesArr.map((s, i) =>
    hasSectionsArr ? renderSection(s, i) : renderStage(s, i)
  ).join('');

  content.innerHTML = `
    ${hasSectionsArr ? `
      <aside class="hb-charter hb-charter-school" id="hb-sec-charter">
        <div>
          <strong>${isAicfCompanion ? 'AICF companion — navigable wrapper for the canonical AICF practical layer.' : (isPolicyTopic ? 'Network policy handbook.' : 'Network handbook for partner schools.')}</strong>
          ${isAicfCompanion
            ? `Full corpus lives in <code>docs/research/eduversal/ai-competency-framework/practical/*.json</code>. This handbook is the navigable reading guide. Edits go to the canonical JSON; this handbook is regenerated from it.`
            : (hb.customizationModel === 'hybrid'
              ? `This handbook is the network-uniform core. Your school adds school-specific information in the clearly-marked slots. Eduversal sets the framing; your school sets the local detail.`
              : `Edits go through <code>docs/handbooks/${isPolicyTopic ? 'policy-topic' : 'school-facing'}/*.json</code> + <code>scripts/induction/seed-induction-programs.js</code> — never Firestore directly.`)}
        </div>
      </aside>
    ` : `
      <aside class="hb-charter" id="hb-sec-charter">
        <div>
          <strong>This handbook sits under the Eduversal Induction Charter.</strong>
          Year-1 induction data does not feed network appraisal scoring. Mentor + mentee + school leader all read the same source. Edits go through <code>docs/induction/handbook-*.json</code> + <code>scripts/induction/seed-induction-programs.js</code> — never Firestore directly.
        </div>
      </aside>
    `}

    ${hb.designPhilosophy ? renderDesignPhilosophy(hb.designPhilosophy) : ''}
    ${hb.rolesAndResponsibilities ? renderRoles(hb.rolesAndResponsibilities) : ''}
    ${hb.escalationLadder ? renderEscalationLadder(hb.escalationLadder) : ''}
    ${hb.keyContacts ? renderKeyContacts(hb.keyContacts) : ''}

    <section class="hb-sec" id="hb-sec-stages">
      <h2 class="hb-sec-h">${stageLabelPlural} <span class="count">${stagesArr.length}</span></h2>
      ${stageBlocks || `<div class="hb-task-desc">No ${stageLabelPlural.toLowerCase()} defined.</div>`}
    </section>

    ${hb.openItems?.length ? `
      <section class="hb-sec" id="hb-sec-open">
        <h2 class="hb-sec-h">Open items <span class="count">${hb.openItems.length}</span></h2>
        <ul class="hb-open-items">
          ${hb.openItems.map(o => `<li>${escapeHtml(o)}</li>`).join('')}
        </ul>
      </section>
    ` : ''}
  `;

  buildTOC(hb, stagesArr);
  initScrollSpy();
  initProgress(hb, stagesArr);
  // If the URL already targets a collapsed stage (deep-link landing
  // like /handbook?id=X#hb-sec-stage-2), open it so the scroll lands
  // inside the content, not above a closed summary.
  if (window.location.hash) {
    const tgt = document.querySelector(window.location.hash);
    if (tgt && tgt.tagName === 'DETAILS') {
      tgt.open = true;
      requestAnimationFrame(() => tgt.scrollIntoView({ block: 'start' }));
    }
  }
  // Scroll to top whenever a new handbook is loaded (handles select-
  // dropdown switching between handbooks mid-scroll).
  else window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/* ── Reading-progress bar + per-task checkbox persistence ─────────
   Companion features (2026-05-15) — turns the reader into a personal
   companion: a sticky bar at the top shows which stage you're in +
   a 0-100% fill driven by localStorage task ticks, and every task
   row gets a checkbox you can tick to mark "done by me".
   Personal-use only; never written to Firestore. */

let _progressState = null;   // { hbId, stages: [{id, label, days, glyph, taskIds:Set}], allTaskIds:Set }

function progressStorageKey(hbId) { return `hb:done:${hbId}`; }
function loadProgressTicks(hbId) {
  try { return new Set(JSON.parse(localStorage.getItem(progressStorageKey(hbId)) || '[]')); }
  catch (_) { return new Set(); }
}
function saveProgressTicks(hbId, set) {
  try { localStorage.setItem(progressStorageKey(hbId), JSON.stringify([...set])); }
  catch (_) { /* quota — silently skip */ }
}

function initProgress(hb, stagesArr) {
  const bar = document.getElementById('hbProgress');
  if (!bar) return;
  // Build a stage→taskIds index from the rendered DOM (covers stages
  // + subStages without re-walking the JSON).
  const stages = stagesArr.map((s, i) => {
    const el = document.getElementById(`hb-sec-stage-${i}`);
    const taskIds = new Set(
      [...(el ? el.querySelectorAll('.hb-task[data-task-id]') : [])]
        .map(n => n.dataset.taskId)
        .filter(Boolean)
    );
    return {
      id: `hb-sec-stage-${i}`,
      index: i,
      label: s.label || s.stageId || `Stage ${i + 1}`,
      days: (s.dayStart != null && s.dayEnd != null) ? `Day ${s.dayStart} → ${s.dayEnd}` : '',
      glyph: stageGlyph(s.label || s.stageId),
      taskIds,
    };
  });
  const allTaskIds = new Set();
  stages.forEach(st => st.taskIds.forEach(id => allTaskIds.add(id)));

  _progressState = { hbId: hb.id, kind: hb.handbookKind || '', stages, allTaskIds };

  // Show the bar whenever there's at least one stage/section to track.
  // School-facing handbooks (Parent / Student / Teacher / Staff CoC)
  // carry prose-only sections without task ids; we still want the
  // Section N / Total chip + scroll-position updates even though
  // there's nothing to tick. Tickless mode = fill stays at 0% and
  // the per-task checkbox JS is a no-op.
  if (!stages.length) { bar.hidden = true; return; }
  bar.hidden = false;

  // Restore previous ticks from localStorage onto the rendered
  // checkboxes. Filter out tasks no longer in this handbook revision
  // so the stored set doesn't grow stale forever.
  const stored = loadProgressTicks(hb.id);
  const restored = new Set();
  document.querySelectorAll('.hb-task-check[data-task-id]').forEach(cb => {
    const id = cb.dataset.taskId;
    if (stored.has(id)) { cb.checked = true; restored.add(id); }
  });
  if (restored.size !== stored.size) saveProgressTicks(hb.id, restored);

  // Wire checkbox change → persist + recompute progress.
  document.querySelectorAll('.hb-task-check[data-task-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const set = loadProgressTicks(hb.id);
      if (cb.checked) set.add(cb.dataset.taskId);
      else set.delete(cb.dataset.taskId);
      saveProgressTicks(hb.id, set);
      updateProgressFill();
    });
  });

  // Reset button — clears all ticks for this handbook (with a quick
  // double-click guard so a misclick doesn't nuke 50 hand-ticked
  // tasks). 3-second confirmation window via data-armed attribute.
  const resetBtn = document.getElementById('hbProgressReset');
  if (resetBtn) {
    let timeoutId = null;
    resetBtn.addEventListener('click', () => {
      if (resetBtn.dataset.armed === '1') {
        // Confirmed — clear everything.
        saveProgressTicks(hb.id, new Set());
        document.querySelectorAll('.hb-task-check').forEach(cb => { cb.checked = false; });
        updateProgressFill();
        resetBtn.textContent = 'Reset';
        resetBtn.dataset.armed = '';
        clearTimeout(timeoutId);
      } else {
        resetBtn.dataset.armed = '1';
        resetBtn.textContent = 'Click again to clear';
        timeoutId = setTimeout(() => {
          resetBtn.textContent = 'Reset';
          resetBtn.dataset.armed = '';
        }, 3000);
      }
    });
  }

  // Initial fill + stage label.
  updateProgressFill();
  updateProgressStage();

  // Re-run stage label on scroll so the bar tracks the active stage
  // alongside the existing scrollSpy TOC highlight. Throttled by RAF.
  if (window._hbProgressScrollWired) return;
  window._hbProgressScrollWired = true;
  let raf = null;
  window.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; updateProgressStage(); });
  }, { passive: true });
}

function updateProgressFill() {
  if (!_progressState) return;
  const done = loadProgressTicks(_progressState.hbId);
  const total = _progressState.allTaskIds.size;
  const doneCount = [..._progressState.allTaskIds].filter(id => done.has(id)).length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  const fill = document.getElementById('hbProgressFill');
  const doneEl = document.getElementById('hbProgressDone');
  const totalEl = document.getElementById('hbProgressTotal');
  if (fill) fill.style.width = pct + '%';
  if (doneEl) doneEl.textContent = doneCount;
  if (totalEl) totalEl.textContent = total;
}

function updateProgressStage() {
  if (!_progressState || !_progressState.stages.length) return;
  // Find the stage whose section is currently most prominent in the
  // viewport. Use the first stage whose top is below 120px from the
  // top edge (matches the scrollspy offset).
  let active = _progressState.stages[0];
  for (const st of _progressState.stages) {
    const el = document.getElementById(st.id);
    if (!el) continue;
    const top = el.getBoundingClientRect().top;
    if (top <= 120) active = st;
    else break;
  }
  const glyphEl = document.getElementById('hbProgressGlyph');
  const numEl = document.getElementById('hbProgressNum');
  const nameEl = document.getElementById('hbProgressName');
  const daysEl = document.getElementById('hbProgressDays');
  if (glyphEl) glyphEl.textContent = active.glyph;
  // School-facing handbooks read as "Section N / Total"; induction
  // and role-operational ones read as "Stage N / Total". The schema
  // discriminator (handbookKind) is in _progressState.kind.
  const unit = _progressState.kind === 'school-facing' ? 'Section' : 'Stage';
  if (numEl)   numEl.textContent   = `${unit} ${active.index + 1} / ${_progressState.stages.length}`;
  if (nameEl)  nameEl.textContent  = active.label;
  if (daysEl)  daysEl.textContent  = active.days;
}

function renderDesignPhilosophy(dp) {
  // Schema variants across handbooks: induction tracks use fourPhases /
  // fourWindows; operational quick-refs (DSL etc.) use a generic phases[].
  // Accept all three.
  const phasesOrWindows = dp.fourPhases || dp.fourWindows || dp.phases;
  const count = Array.isArray(phasesOrWindows) ? phasesOrWindows.length : 0;
  return `
    <section class="hb-sec" id="hb-sec-design">
      <h2 class="hb-sec-h">Design philosophy${count ? ` <span class="count">${count} windows</span>` : ''}</h2>
      ${dp.summary ? `<p class="hb-sec-text hb-sec-text--compact">${escapeHtml(dp.summary)}</p>` : ''}
      ${Array.isArray(phasesOrWindows) ? `
        <div class="hb-timeline" style="--windows: ${count};">
          ${phasesOrWindows.map(p => `
            <div class="hb-tl-cell">
              <div class="hb-tl-label">${escapeHtml(p.label)}</div>
              <div class="hb-tl-days">${escapeHtml(p.weeks || p.days || '')}</div>
              ${p.cognitivePriority ? `<div class="hb-tl-priority">${escapeHtml(p.cognitivePriority)}</div>` : ''}
              ${p.leadershipPriority ? `<div class="hb-tl-priority">${escapeHtml(p.leadershipPriority)}</div>` : ''}
              ${p.successSignal ? `<div class="hb-tl-success"><b>Success:</b> ${escapeHtml(p.successSignal)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      ` : ''}
    </section>
  `;
}

function renderRoles(rar) {
  // Known taxonomy first (induction handbooks); append any handbook-
  // specific keys (e.g. DSL operational handbook adds dsl/deputyDsl/
  // principal/foundationRep/externalAgencies) after the known order so
  // new schemas don't drop roles or require code changes.
  const knownOrder = ['mentee', 'mentor', 'schoolLeader', 'foundationRepresentative', 'eduversalHQ',
                      'dsl', 'deputyDsl', 'principal', 'foundationRep', 'externalAgencies'];
  const knownPresent = knownOrder.filter(k => rar[k]);
  const extraKeys = Object.keys(rar).filter(k => !knownOrder.includes(k));
  const present = [...knownPresent, ...extraKeys];
  const cards = present
    .map(k => {
      const r = rar[k];
      const items = Array.isArray(r.responsibilities) ? r.responsibilities : [];
      return `
        <div class="hb-role">
          <div class="hb-role-label">${roleLabelFor(k)}</div>
          <div class="role-name">${escapeHtml(r.label || k)}</div>
          ${r.ownership ? `<div class="role-ownership"><strong>Ownership:</strong> ${escapeHtml(r.ownership)}</div>` : ''}
          ${items.length ? `<ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
        </div>
      `;
    }).join('');
  return `
    <section class="hb-sec" id="hb-sec-roles">
      <h2 class="hb-sec-h">Roles &amp; responsibilities <span class="count">${present.length}</span></h2>
      <div class="hb-roles">${cards}</div>
    </section>
  `;
}

function roleLabelFor(k) {
  return ({
    mentee: 'Mentee',
    mentor: 'Mentor',
    schoolLeader: 'School Leader',
    foundationRepresentative: 'Foundation Rep',
    eduversalHQ: 'Eduversal',
    dsl: 'DSL',
    deputyDsl: 'Deputy DSL',
    principal: 'Principal',
    foundationRep: 'Foundation Rep',
    externalAgencies: 'External agencies',
  })[k] || k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
}

// Window glyph inference — handbook stage labels often contain a
// window verb (Listen / Diagnose / Act / Anchor) or a stage type
// keyword (Survival / Foundation / Mastery / Integration / Pre-arrival /
// Sense-making / Apprenticeship / Solo / Strategic). Map the most
// common keywords to expressive emoji so each stage banner reads at
// a glance. Falls back to 📕 (handbook book) when nothing matches.
function stageGlyph(label) {
  const s = String(label || '').toLowerCase();
  // Four-window AH principal arc
  if (/\blisten\b/.test(s))                  return '🌱';
  if (/\bdiagnose\b/.test(s))                return '🔍';
  if (/\bact\b/.test(s))                     return '🎯';
  if (/\banchor\b/.test(s))                  return '⚓';
  // TH subject-teacher arc
  if (/\bsurvival\b/.test(s))                return '🛟';
  if (/\bfoundation\b/.test(s))              return '🧱';
  if (/\bmastery\b/.test(s))                 return '🎓';
  if (/\bintegration\b/.test(s))             return '🔗';
  if (/\bfamiliariz/.test(s))                return '👋';
  if (/\bmeeting\b|\bpreparation\b/.test(s)) return '📝';
  // CH specialist arc
  if (/\bsense.?making\b/.test(s))           return '🧭';
  if (/\bapprentice/.test(s))                return '🤝';
  if (/\bsolo\b|\bpractice\b/.test(s))       return '🚶';
  if (/\bstrategic\b|\bcontribution\b/.test(s)) return '♟';
  // Generic stage types
  if (/\bpre.?arrival\b|\bstage 0\b/.test(s)) return '🛬';
  if (/\bobserv/.test(s))                    return '👁';
  if (/\breflection\b|\bretrospect/.test(s)) return '🪞';
  return '📕';
}

// School-facing section glyph inference — section titles cover wider
// territory than induction stage labels (welcome, values, safeguarding,
// restorative, inclusion, wellbeing, AI literacy, climate, …) so this
// map is broader. Falls back to a generic 🧭 compass when no keyword
// matches. Sections can also set `glyph` in JSON to override the infer.
function sectionGlyph(section) {
  if (section && typeof section.glyph === 'string' && section.glyph.trim()) {
    return section.glyph.trim();
  }
  const s = String(section?.title || '').toLowerCase();
  if (/\bwelcome\b|\bintroduction\b|\boverview\b/.test(s))    return '👋';
  if (/\bvalue|\bshared\b|\bpromise|\bcommitment/.test(s))     return '💚';
  if (/\bcambridge\b|\bstandard|\bteacher standard/.test(s))   return '🎯';
  if (/\bdaily\b|\bpractice\b|\bclassroom\b/.test(s))          return '☀️';
  if (/\bsafeguard|\bchild protection\b/.test(s))              return '🛡';
  if (/\brestorative\b|\bdiscipline\b|\bbehaviour\b/.test(s))  return '🤝';
  if (/\binclus|\bneurodivers|\bsen\b|\bspecial needs/.test(s)) return '🌈';
  if (/\bwellbeing\b|\bmental health\b|\bself.?care\b/.test(s)) return '🌿';
  if (/\bai\b|\bartificial intel|\bdigital citizen|\btechnology\b/.test(s)) return '🤖';
  if (/\bclimate\b|\bsustain|\beco\b|\benvironment\b/.test(s)) return '🌍';
  if (/\bassess|\bgrade|\bmark|\breport card/.test(s))         return '📊';
  if (/\bcurriculum\b|\blesson plan|\bscheme of work/.test(s)) return '📚';
  if (/\bparent|\bfamily|\bcommunic/.test(s))                  return '👨‍👩‍👧';
  if (/\bsafety\b|\bemergency\b|\bfire\b|\bevacuat/.test(s))   return '🚨';
  if (/\bstaff\b|\bcolleague\b|\bteam\b/.test(s))              return '👥';
  if (/\bprofessional develop|\bcpd\b|\bgrowth\b/.test(s))     return '📈';
  if (/\bconduct\b|\bethic|\bintegrity\b/.test(s))             return '⚖';
  if (/\bdata\b|\bprivacy\b|\bconfidential/.test(s))           return '🔒';
  if (/\bhealth\b|\bmedical\b|\bfirst aid\b/.test(s))          return '🩺';
  if (/\bleaving\b|\boffboard|\bend of year/.test(s))          return '👋';
  if (/\bschool fills\b|\byour school\b|\blocal\b/.test(s))    return '🏫';
  return '🧭';
}

function renderStage(stage, index) {
  const tasks = Array.isArray(stage.tasks) ? stage.tasks : [];
  const subStages = Array.isArray(stage.subStages) ? stage.subStages : [];
  const cycle = stage.observationCycle || stage.walkthroughCycle;
  const totalTaskCount = tasks.length + subStages.reduce((acc, ss) => acc + (Array.isArray(ss.tasks) ? ss.tasks.length : 0), 0);

  // Weekly-checklist cross-ref strip: shows where this stage sits on
  // the 40-week academic year arc AND which checklist tasks the
  // mentee will hit during this stage's days. Skipped silently when
  // neither field is set (induction handbooks omit it).
  const anchoredWeeks = stage.anchoredWeeks;
  const stageClTaskIds = Array.isArray(stage.weeklyChecklistTaskIds) ? stage.weeklyChecklistTaskIds : [];
  const clStrip = (anchoredWeeks || stageClTaskIds.length) ? `
    <div class="hb-stage-cl-strip">
      <span class="label">Weekly checklist</span>
      ${anchoredWeeks ? `<span class="week-anchor">${escapeHtml(anchoredWeeks)}</span>` : ''}
      ${stageClTaskIds.map(id => `<span class="cl-task-id">${escapeHtml(id)}</span>`).join('')}
    </div>
  ` : '';

  const stageName = stage.label || stage.stageId;
  const stageGly  = stageGlyph(stageName);
  const stageNum  = String(index + 1).padStart(2, '0');

  return `
    <details class="hb-stage" id="hb-sec-stage-${index}">
      <summary class="hb-stage-head">
        <span class="hb-stage-caret" aria-hidden="true">▸</span>
        <span class="hb-stage-num" aria-hidden="true">${stageNum}</span>
        <span class="hb-stage-glyph" aria-hidden="true">${stageGly}</span>
        <span class="hb-stage-name-block">
          <span class="hb-stage-eyebrow">Stage ${index + 1}</span>
          <h3 class="hb-stage-name">${escapeHtml(stageName)}</h3>
        </span>
        <span class="hb-stage-days">Day ${stage.dayStart} → ${stage.dayEnd}</span>
        ${totalTaskCount ? `<span class="hb-stage-tasks-pill">${totalTaskCount} task${totalTaskCount === 1 ? '' : 's'}</span>` : ''}
      </summary>
      ${stage.narrative ? `<div class="hb-stage-narrative">${escapeHtml(stage.narrative)}</div>` : ''}
      ${clStrip}
      ${tasks.map(renderTask).join('')}
      ${cycle ? renderObservationCycle(cycle) : ''}
      ${subStages.map(ss => `
        <div class="hb-substage-h">${escapeHtml(ss.label || ss.subStageId)}</div>
        ${(ss.tasks || []).map(renderTask).join('')}
      `).join('')}
    </details>
  `;
}

/* renderSection — school-facing handbook section renderer. Sections
   are topic chapters (not time-windowed phases like stages). Each
   section has: title, summary, body (multi-paragraph with markdown-
   lite **bold** + ## headings + - bullets + > blockquotes),
   callouts[] (school_slot_inline / side_reference / quick_ref_card /
   if_violated), schoolSlot flag, schoolSlotGuidance text.

   We reuse the .hb-stage / hb-sec-stage-{index} DOM hooks so the
   existing TOC + scroll-spy + reading-progress infrastructure works
   unchanged. The visual styling shifts (no day range, no task list)
   to a reading-doc layout via the .hb-sec-school class. */
function renderSection(section, index) {
  const sectionTitle = section.title || section.sectionId || `Section ${index + 1}`;
  const sectionNum   = String(section.order || (index + 1)).padStart(2, '0');
  const isSchoolSlot = section.schoolSlot === true;
  const slotBadge    = isSchoolSlot
    ? `<span class="hb-stage-tasks-pill" style="background:#fef3c7;color:#92400e;border-color:#fde68a;">school adds</span>`
    : '';

  const calloutsHtml = Array.isArray(section.callouts)
    ? section.callouts.map(renderCallout).join('')
    : '';

  // Guidance box visible when the section is a school slot — tells
  // partner-school editors what to fill in.
  const guidanceBox = (isSchoolSlot && section.schoolSlotGuidance)
    ? `<div class="hb-section-slot-guide">
        <strong>Your school fills this in.</strong> ${escapeHtml(section.schoolSlotGuidance)}
      </div>`
    : '';

  // Week-mapped reading cycle badge (Teacher Handbook v0.4+ / Staff CoC v0.4+).
  // Renders alongside the "Section N" eyebrow when the section carries a
  // weekNumber field (one-section-per-week PD cycle / microread cycle).
  // Student + Parent handbooks are reference docs — no weekNumber on sections.
  const weekBadge = (typeof section.weekNumber === 'number')
    ? `<span class="hb-week-pill" title="Read in Week ${section.weekNumber} of Semester 1">Week ${section.weekNumber}</span>`
    : '';

  return `
    <details class="hb-stage hb-sec-school" id="hb-sec-stage-${index}">
      <summary class="hb-stage-head">
        <span class="hb-stage-caret" aria-hidden="true">▸</span>
        <span class="hb-stage-num" aria-hidden="true">${sectionNum}</span>
        <span class="hb-stage-glyph" aria-hidden="true">${sectionGlyph(section)}</span>
        <span class="hb-stage-name-block">
          <span class="hb-stage-eyebrow">Section ${section.order || (index + 1)}${weekBadge ? ' · ' + weekBadge : ''}</span>
          <h3 class="hb-stage-name">${escapeHtml(sectionTitle)}</h3>
        </span>
        ${slotBadge}
      </summary>
      ${section.summary ? `<div class="hb-stage-narrative">${escapeHtml(section.summary)}</div>` : ''}
      ${guidanceBox}
      ${section.body ? `<div class="hb-section-body">${renderBodyMarkdown(section.body)}</div>` : ''}
      ${calloutsHtml}
    </details>
  `;
}

/* Lightweight markdown renderer for section bodies. Supports:
   - ## Heading 2 / ### Heading 3
   - **bold** + *italic*
   - - bullet lists
   - 1. numbered lists
   - > blockquote
   - --- horizontal rule
   - blank-line paragraph separator
   Output is HTML-escape-safe — we escape everything first, then
   apply the markup transforms. No HTML passthrough allowed. */
function renderBodyMarkdown(text) {
  if (!text) return '';
  // Step 1: escape everything for safety
  let s = escapeHtml(String(text));
  // Step 2: split into paragraphs by blank line
  const paragraphs = s.split(/\n\s*\n/);
  return paragraphs.map(p => renderParagraphBlock(p)).join('');
}

/* A single blank-line-separated paragraph can contain mixed content:
   an intro line followed by bullets, or a heading-shaped first line.
   This walks the lines and emits a sequence of HTML blocks. */
function renderParagraphBlock(p) {
  const trimmed = p.trim();
  if (!trimmed) return '';

  // Whole-block matches first (heading / hr / blockquote / pure list)
  if (/^###\s+/.test(trimmed)) {
    return `<h4 class="hb-body-h4">${inlineMd(trimmed.replace(/^###\s+/, ''))}</h4>`;
  }
  if (/^##\s+/.test(trimmed)) {
    return `<h3 class="hb-body-h3">${inlineMd(trimmed.replace(/^##\s+/, ''))}</h3>`;
  }
  if (/^---+$/.test(trimmed)) {
    return `<hr class="hb-body-hr">`;
  }
  if (/^&gt;\s+/.test(trimmed) && trimmed.split('\n').every(l => /^&gt;\s?/.test(l) || l.trim() === '')) {
    const quoted = trimmed.split('\n').map(l => l.replace(/^&gt;\s?/, '')).join(' ');
    return `<blockquote class="hb-body-quote">${inlineMd(quoted)}</blockquote>`;
  }

  // Block-level value cards — every line starts with `\d+. **Title.**`.
  // Promotes a numbered value list with bold titles into a card grid
  // (visually distinct from <ol>, makes 6-promise / 5-commitment lists
  // far more scannable).
  const blockLines = trimmed.split('\n').filter(Boolean);
  if (blockLines.length >= 2 && blockLines.every(l => /^\d+\.\s+\*\*[^*]+\*\*/.test(l))) {
    const cards = blockLines.map(l => {
      const m = l.match(/^(\d+)\.\s+\*\*([^*]+)\*\*\s*(.*)$/);
      if (!m) return '';
      const num = m[1];
      const title = inlineMd(m[2].trim());
      const body = inlineMd(m[3].trim().replace(/^[-—–:.\s]+/, ''));
      return `<div class="hb-value-card${body ? '' : ' no-body'}">
        <div class="hb-value-card-num">${num}</div>
        <div class="hb-value-card-title">${title}</div>
        ${body ? `<div class="hb-value-card-body">${body}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="hb-value-grid">${cards}</div>`;
  }

  // Inline value cards — single paragraph with ≥2 `(N) X` enumerations.
  // Pre-(1) text becomes a small uppercase lead-in when short, or a
  // normal paragraph when long.
  const inlineMatches = trimmed.match(/\((\d)\)\s+/g);
  if (inlineMatches && inlineMatches.length >= 2 && !/\n/.test(trimmed)) {
    const firstIdx = trimmed.indexOf('(1) ');
    if (firstIdx >= 0) {
      const leadin = firstIdx > 0 ? trimmed.slice(0, firstIdx).trim() : '';
      const rest = trimmed.slice(firstIdx);
      const parts = rest.split(/\((\d)\)\s+/).filter(x => x !== '');
      if (parts.length >= 4 && parts.length % 2 === 0) {
        const cards = [];
        for (let i = 0; i < parts.length; i += 2) {
          const num = parts[i];
          const body = parts[i + 1].trim().replace(/\s+/g, ' ');
          if (!body) continue;
          let title = body, rationale = '';
          const dashSplit = body.match(/^([^—–\-]+?)\s+[—–\-]\s+(.+)$/);
          if (dashSplit) {
            title = dashSplit[1].trim();
            rationale = dashSplit[2].trim();
          }
          cards.push(`<div class="hb-value-card${rationale ? '' : ' no-body'}">
            <div class="hb-value-card-num">${num}</div>
            <div class="hb-value-card-title">${inlineMd(title)}</div>
            ${rationale ? `<div class="hb-value-card-body">${inlineMd(rationale)}</div>` : ''}
          </div>`);
        }
        if (cards.length >= 2) {
          let leadinHtml = '';
          if (leadin) {
            const stripped = leadin.replace(/[.:]\s*$/, '');
            if (leadin.length <= 80) {
              leadinHtml = `<div class="hb-value-leadin">${inlineMd(stripped)}</div>`;
            } else {
              leadinHtml = `<p class="hb-body-p">${inlineMd(leadin)}</p>`;
            }
          }
          return `${leadinHtml}<div class="hb-value-grid is-inline">${cards.join('')}</div>`;
        }
      }
    }
  }

  // Mixed content: walk the lines and group them.
  // Buffers: collecting consecutive lines of the same kind, flushing on kind-change.
  const lines = trimmed.split('\n');
  const out = [];
  let buf = [];
  let kind = null; // 'p' | 'ul' | 'ol'
  const flush = () => {
    if (!buf.length) return;
    if (kind === 'ul') {
      out.push('<ul class="hb-body-ul">' + buf.map(l => `<li>${inlineMd(l.replace(/^[-•*]\s+/, ''))}</li>`).join('') + '</ul>');
    } else if (kind === 'ol') {
      out.push('<ol class="hb-body-ol">' + buf.map(l => `<li>${inlineMd(l.replace(/^\d+\.\s+/, ''))}</li>`).join('') + '</ol>');
    } else {
      // Paragraph — collapse internal newlines into <br>
      out.push(`<p class="hb-body-p">${inlineMd(buf.join('<br>'))}</p>`);
    }
    buf = [];
  };
  for (const line of lines) {
    const lineKind =
      /^[-•*]\s+/.test(line)   ? 'ul' :
      /^\d+\.\s+/.test(line)   ? 'ol' :
      'p';
    if (lineKind !== kind && buf.length) flush();
    kind = lineKind;
    buf.push(line);
  }
  flush();
  return out.join('');
}
function inlineMd(s) {
  // Order matters:
  //   1. Inline code first — its body must NOT be re-interpreted as bold /
  //      italic / link. Stash code spans before the other transforms run,
  //      restore them at the end.
  //   2. Links — [label](url) — supports relative paths + http(s). Body of
  //      label still flows through bold/italic after restore, but URL is
  //      treated as opaque. Allows /references?doc=... query strings.
  //   3. Bold (**…**) before italic (*…*) so '**' doesn't match the italic
  //      pattern (legacy ordering).
  //
  // Input is already HTML-escaped, so '<' and '>' are safe to inject.
  const codeStash = [];
  let out = s.replace(/`([^`]+)`/g, (_, body) => {
    codeStash.push(body);
    return ` CODE${codeStash.length - 1} `;
  });
  // Markdown link [label](url). URL must be http(s) or start with '/' or '#'
  // to be considered safe — anything else renders as plain text label.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
    const safe = /^(https?:\/\/|\/|#)/.test(url);
    if (!safe) return label;
    const isExternal = /^https?:\/\//.test(url);
    const attrs = isExternal ? ' target="_blank" rel="noopener"' : '';
    return `<a class="hb-body-link" href="${url}"${attrs}>${label}</a>`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  // Restore code spans last so their literal content isn't re-formatted.
  out = out.replace(/ CODE(\d+) /g, (_, idx) => `<code class="hb-body-code">${codeStash[+idx]}</code>`);
  return out;
}

/* renderCallout — sidebar boxes inside a section body. Four types,
   each with a distinct visual: school_slot_inline (yellow),
   side_reference (cyan), quick_ref_card (mor card), if_violated (red). */
function renderCallout(c) {
  if (!c || !c.type) return '';
  const items = Array.isArray(c.items) ? c.items : [];
  // Defensive guard: strip leading "1. " / "2. " etc. from items so that
  // hand-authored JSON that prefixed each line never double-numbers when
  // rendered inside an <ol>. Past bug 2026-05-18: quick_ref_card on Staff
  // CoC s2 rendered "1. 1. Stop. Listen." Caused by <ol> + prefixed string.
  const cleanItem = (s) => typeof s === 'string' ? s.replace(/^\s*\d+\.\s+/, '') : s;
  const itemsHtml = items.map(x => `<li>${escapeHtml(cleanItem(x))}</li>`).join('');
  const label = escapeHtml(c.label || '');
  switch (c.type) {
    case 'school_slot_inline':
      return `<div class="hb-callout hb-callout-slot">
        <div class="hb-callout-label">📋 ${label}</div>
        <ul>${itemsHtml}</ul>
      </div>`;
    case 'side_reference':
      return `<div class="hb-callout hb-callout-ref">
        <div class="hb-callout-label">📖 ${label}</div>
        <ul>${itemsHtml}</ul>
      </div>`;
    case 'quick_ref_card':
      return `<div class="hb-callout hb-callout-quickref">
        <div class="hb-callout-label">⚡ ${label}</div>
        <ol>${itemsHtml}</ol>
      </div>`;
    case 'if_violated':
      return `<div class="hb-callout hb-callout-violated">
        <div class="hb-callout-label">🚨 ${label}</div>
        <ul>${itemsHtml}</ul>
      </div>`;
    default:
      return `<div class="hb-callout">
        ${label ? `<div class="hb-callout-label">${label}</div>` : ''}
        <ul>${itemsHtml}</ul>
      </div>`;
  }
}

// Task category glyph — inferred from evidenceType field, with
// generic ◆ fallback when missing. Keeps the row aligned even if
// authoring forgot to set evidenceType.
function taskGlyph(t) {
  const ev = String(t.evidenceType || '').toLowerCase();
  if (ev === 'observation' || ev === 'walkthrough') return '👁';
  if (ev === 'meeting' || ev === 'briefing')        return '🗣';
  if (ev === 'journal' || ev === 'reflection')      return '✍';
  if (ev === 'report' || ev === 'document')         return '📋';
  if (ev === 'plan' || ev === 'planning')           return '🗺';
  if (ev === 'delivery' || ev === 'execute')        return '🎯';
  if (ev === 'review' || ev === 'feedback')         return '🔄';
  if (ev === 'training' || ev === 'cpd')            return '🎓';
  if (ev === 'audit' || ev === 'check')             return '✅';
  if (ev === 'survey' || ev === 'pulse')            return '📊';
  if (ev === 'data' || ev === 'analysis')           return '📈';
  return '◆';
}

function renderTask(t) {
  const cts  = Array.isArray(t.cambridgeStandardRefs) ? t.cambridgeStandardRefs : [];
  // CSLS — Cambridge School Leader Standards 2023 (leadership-track anchor,
  // e.g. the principal induction handbook). Distinct chip family from CTS:
  // CSLS 1.4 ≠ CTS 1.4. cambridge-crossref.js auto-wires "CSLS X.Y" text +
  // data-csls-ref into the CSLS popover (school-leader-standards-2023.json).
  const csls = Array.isArray(t.cambridgeSchoolLeaderStandardRefs) ? t.cambridgeSchoolLeaderStandardRefs : [];
  const skl  = Array.isArray(t.skl_dimensions) ? t.skl_dimensions : [];
  const pigp = Array.isArray(t.pigp_articleRefs) ? t.pigp_articleRefs : [];
  // ES — Eduversal Academic Standards madde refs (4th chip family,
  // 2026-05-15). Same schema convention as cambridgeStandardRefs[].
  // cambridge-crossref.js auto-wires .hb-tag.es chips into the ES
  // popover (manifest.json lookup + deep-link to /references).
  const es   = Array.isArray(t.eduversalStandardRefs) ? t.eduversalStandardRefs : [];
  // Task-level cross-ref to specific weekly-checklist task IDs (e.g.
  // CC-W08-001). Optional — most tasks don't have it; lights up only
  // for stages that explicitly map to checklist rows.
  const cl   = Array.isArray(t.weeklyChecklistTaskIds) ? t.weeklyChecklistTaskIds : [];
  // Charter Non-Negotiables (NN1..NN5). Click → popover with verbatim
  // rule from INDUCTION_CHARTER.json. Rule-enforced at firestore.rules;
  // chip is informational, not gating. Schema: charterNonNegotiables[]
  // — case-normalised; accepts "NN1"/"nn1"/"1" formats from authoring.
  const nnRaw = Array.isArray(t.charterNonNegotiables) ? t.charterNonNegotiables : [];
  const nn = nnRaw.map(n => String(n).toUpperCase().replace(/^NN/, '').replace(/[^0-9]/g, ''))
                  .filter(Boolean).map(n => 'NN' + n);
  const tid = t.taskId || '';
  return `
    <div class="hb-task has-check"${tid ? ` data-task-id="${escapeHtml(tid)}"` : ''}>
      <input type="checkbox" class="hb-task-check" aria-label="Mark task done"${tid ? ` data-task-id="${escapeHtml(tid)}"` : ''}>
      <span class="hb-task-glyph" aria-hidden="true">${taskGlyph(t)}</span>
      <div class="hb-task-title">${escapeHtml(t.title || t.taskId)}</div>
      ${t.description ? `<div class="hb-task-desc">${escapeHtml(t.description)}</div>` : ''}
      <div class="hb-task-meta">
        ${t.ownerRole ? `<span class="hb-tag role">${escapeHtml(t.ownerRole)}</span>` : ''}
        ${t.mentorRequired ? `<span class="hb-tag mentor">Mentor required</span>` : ''}
        ${t.mentorSignOffRequired ? `<span class="hb-tag signoff">Mentor sign-off</span>` : ''}
        ${t.schoolLeaderSignOffRequired ? `<span class="hb-tag signoff">School-leader sign-off</span>` : ''}
        ${t.estimatedMinutes ? `<span class="hb-tag minutes">${t.estimatedMinutes >= 60 ? Math.round(t.estimatedMinutes/60) + ' hr' : t.estimatedMinutes + ' min'}</span>` : ''}
        ${cts.map(c => `<span class="hb-tag cts">CTS ${escapeHtml(c)}</span>`).join('')}
        ${csls.map(c => `<span class="hb-tag csls csls-pill" data-csls-ref="${escapeHtml(c)}">CSLS ${escapeHtml(c)}</span>`).join('')}
        ${skl.map(s => `<span class="hb-tag skl">SKL: ${escapeHtml(s)}</span>`).join('')}
        ${pigp.map(p => `<span class="hb-tag pigp">PIGP ${escapeHtml(p)}</span>`).join('')}
        ${es.map(e => `<span class="hb-tag es">ES ${escapeHtml(e)}</span>`).join('')}
        ${nn.map(n => `<span class="hb-tag nn" role="button" tabindex="0" data-nn="${escapeHtml(n)}" title="Charter ${escapeHtml(n)} — click for full rule">${escapeHtml(n)}</span>`).join('')}
        ${cl.map(c => `<span class="hb-tag cl" title="Weekly-checklist task ${escapeHtml(c)}">${escapeHtml(c)}</span>`).join('')}
      </div>
    </div>
  `;
}

/* ── Escalation ladder (DSL handbook + future policy docs) ────────
   Renders a vertical ladder with level numbers + label + description.
   Visually conveys "go up one rung" hierarchy. */
function renderEscalationLadder(el) {
  const levels = Array.isArray(el.levels) ? el.levels : [];
  if (!levels.length) return '';
  return `
    <section class="hb-sec" id="hb-sec-escalation">
      <h2 class="hb-sec-h">Escalation ladder <span class="count">${levels.length} levels</span></h2>
      ${el.description ? `<p class="hb-sec-text hb-sec-text--compact">${escapeHtml(el.description)}</p>` : ''}
      <ol class="hb-ladder">
        ${levels.map(l => `
          <li class="hb-ladder-step">
            <span class="hb-ladder-num">L${l.level}</span>
            <div class="hb-ladder-body">
              <div class="hb-ladder-label">${escapeHtml(l.label || '')}</div>
              ${l.description ? `<div class="hb-ladder-desc">${escapeHtml(l.description)}</div>` : ''}
            </div>
          </li>
        `).join('')}
      </ol>
    </section>
  `;
}

/* ── Key contacts (DSL handbook + future operational handbooks) ──── */
function renderKeyContacts(kc) {
  const cats = Array.isArray(kc.categories) ? kc.categories : [];
  if (!cats.length) return '';
  return `
    <section class="hb-sec" id="hb-sec-contacts">
      <h2 class="hb-sec-h">Key contacts <span class="count">${cats.length}</span></h2>
      ${kc.description ? `<p class="hb-sec-text hb-sec-text--compact">${escapeHtml(kc.description)}</p>` : ''}
      <div class="hb-contacts">
        ${cats.map(c => `
          <div class="hb-contact">
            <div class="hb-contact-id">${escapeHtml(c.id || '')}</div>
            <div class="hb-contact-label">${escapeHtml(c.label || '')}</div>
            ${c.purpose ? `<div class="hb-contact-purpose">${escapeHtml(c.purpose)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function renderObservationCycle(c) {
  const rotation = Array.isArray(c.rotation) ? c.rotation : [];
  const totalLabel = c.totalObservations
    ? `${c.totalObservations} observations`
    : (c.totalWalkthroughs ? `${c.totalWalkthroughs} walkthroughs` : 'Rotation');
  return `
    <div class="hb-obs-cycle">
      <h4>${escapeHtml(totalLabel)} — rotation</h4>
      <ol>
        ${rotation.map(r => `
          <li>
            ${r.month ? `<b>Month ${r.month}</b> · ` : ''}
            ${r.walkthroughs ? `<b>Walkthroughs ${r.walkthroughs}</b> · ` : ''}
            ${escapeHtml(r.label || r.type || '')}${r.scored === false ? ' (unscored)' : (r.scored === true ? ' (scored)' : '')}
            ${r.description ? `<br><span style="color:var(--ink-3);">${escapeHtml(r.description)}</span>` : ''}
          </li>
        `).join('')}
      </ol>
    </div>
  `;
}

/* ── TOC + scroll-spy ─────────────────────────────────────────────
   TOC items are <a href="#hb-sec-...">; scroll-spy highlights the
   anchor whose target is most visible in the viewport. Smooth-scroll
   to anchor on click; rely on browser-native behavior + CSS
   scroll-margin-top on each section to clear the sticky toolbar. */
function buildTOC(hb, stages) {
  const list = document.getElementById('hbTocList');
  const kind = hb.handbookKind || 'induction';
  const isSchoolFacing = kind === 'school-facing' || kind === 'policy-topic' || kind === 'aicf-companion';
  const stageLabelPlural = isSchoolFacing ? 'Sections' : 'Stages';
  const items = [];
  items.push(`<li><a href="#hb-sec-charter">Charter</a></li>`);
  if (hb.designPhilosophy) items.push(`<li><a href="#hb-sec-design">Design philosophy</a></li>`);
  if (hb.rolesAndResponsibilities) items.push(`<li><a href="#hb-sec-roles">Roles &amp; responsibilities</a></li>`);
  if (hb.escalationLadder) items.push(`<li><a href="#hb-sec-escalation">Escalation ladder</a></li>`);
  if (hb.keyContacts) items.push(`<li><a href="#hb-sec-contacts">Key contacts</a></li>`);
  if (stages.length) {
    items.push(`<li style="margin-top:8px;"><a href="#hb-sec-stages"><strong>${stageLabelPlural}</strong></a></li>`);
    stages.forEach((s, i) => {
      // School-facing handbooks ship sections with {sectionId, order, title};
      // induction/role-operational ship stages with {stageId, label}.
      // Read whichever pair is present so the sub-link always has text.
      const linkText  = s.title || s.label || s.sectionId || s.stageId || `Item ${i + 1}`;
      const ordNum    = String(s.order || (i + 1)).padStart(2, '0');
      const prefix    = isSchoolFacing
        ? `<span class="toc-num">${ordNum}</span>`
        : '';
      items.push(`<li><a class="toc-sub" href="#hb-sec-stage-${i}" data-toc-text="${escapeHtml(linkText.toLowerCase())}">${prefix}<span class="toc-label">${escapeHtml(linkText)}</span></a></li>`);
    });
  }
  if (Array.isArray(hb.openItems) && hb.openItems.length) {
    items.push(`<li class="hb-toc-divider" aria-hidden="true"></li>`);
    items.push(`<li><a href="#hb-sec-open">Open items</a></li>`);
  }
  list.innerHTML = items.join('');

  // Stages now render collapsed by default; when the user clicks a TOC
  // anchor that points to a <details>, open it before the browser scrolls
  // so the target lands visible instead of jumping past a closed summary.
  list.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', () => {
      const tgt = document.querySelector(a.getAttribute('href'));
      if (tgt && tgt.tagName === 'DETAILS') tgt.open = true;
    });
  });

  // Show + wire the filter input when the section list is long enough
  // to justify it (>8 sub-items). Filter matches against the lowercase
  // title cached on each sub-link via data-toc-text.
  const filterWrap = document.getElementById('hbTocFilterWrap');
  const filterInput = document.getElementById('hbTocFilter');
  if (filterWrap && filterInput) {
    const subCount = list.querySelectorAll('a.toc-sub').length;
    if (subCount >= 8) {
      filterWrap.hidden = false;
      filterInput.value = '';
      filterInput.oninput = () => {
        const q = filterInput.value.trim().toLowerCase();
        list.querySelectorAll('a.toc-sub').forEach(a => {
          const hit = !q || (a.dataset.tocText || '').includes(q);
          a.parentElement.style.display = hit ? '' : 'none';
        });
      };
    } else {
      filterWrap.hidden = true;
    }
  }
}

function initScrollSpy() {
  if (_scrollSpyObserver) _scrollSpyObserver.disconnect();
  const anchors = document.querySelectorAll('#hbTocList a[href^="#"]');
  if (!anchors.length) return;
  const targets = [...anchors]
    .map(a => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);
  if (!targets.length) return;

  const setActive = (id) => {
    anchors.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
  };

  _scrollSpyObserver = new IntersectionObserver((entries) => {
    // Pick the topmost intersecting entry — gives a stable active
    // highlight when multiple sections are visible at once.
    const visible = entries
      .filter(e => e.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible[0]) setActive(visible[0].target.id);
  }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 });

  targets.forEach(t => _scrollSpyObserver.observe(t));
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
  // ── Expose ─────────────────────────────────────────────────────────
  window.HandbookReader = { init };
})();
