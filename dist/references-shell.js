/* references-shell.js — runtime for the /references reader, shared by
 * Central / Academic / Teachers Hub.
 *
 * Source of truth: monorepo-root /shared-design/references-shell/. Each
 * hub copies into its own root via sync-tokens.js (same pattern as
 * tokens.css, nav-edit-simple.js).
 *
 * Public API:
 *   initReferencesPage(MANIFEST, options) — wires the whole page once
 *     DOM + auth are ready. Caller passes hub-specific options:
 *       roleField              'role_centralhub' | 'role_academichub' | 'role_teachershub'
 *       adminValue             'central_admin'   | 'academic_admin'   | 'teachers_admin'
 *       subRoleField           'ch_sub_roles'    | 'ah_sub_roles'     | 'th_sub_roles'
 *       loadHandbooks          true (default) | false — false skips the handbook facet entirely
 *       handbookAudienceFilter null (CH, show all) | ['academic'] (AH) | ['teachers'] (TH)
 *       roleRailMatcher        function(role, category, item) -> bool — null disables the rail
 *       searchIndexUrl         'references-search-index.json' (default)
 *
 * The host page provides:
 *   - the canonical HTML skeleton (.page-hero, .ref-toolbar, .ref-facets,
 *     .ref-section blocks per facet, .doc-modal-overlay, etc.). Each facet
 *     in MANIFEST must have a matching <details class="ref-section"
 *     data-cat="<facetKey>"> with a #grid<Capitalized> child.
 *   - inline <link rel="stylesheet" href="references-shell.css"> + module
 *     <script type="module">import { initReferencesPage } from
 *     './references-shell.js'; initReferencesPage(MANIFEST, options);</script>
 *
 * Behaviour invariants (do not break without a 3-hub smoke test):
 *   - URL params: ?cat= (facet), ?q= (search), ?doc= (deep-link), ?tag=
 *     (back-compat alias for ?q=), ?tab= (back-compat alias for ?cat=).
 *   - localStorage MRU: key 'ref:recent:v1', max 5, dedup, MRU first.
 *   - Modal nav: visible-cards walk (post-facet, post-search), arrow keys
 *     don't fire inside input/textarea/contenteditable.
 *   - Schema-aware JSON viewer prefers window.EduversalReferencesViewer
 *     (loaded via references-viewer.js); falls back to pretty-printed pre.
 */

import { collection, getDocs, query, limit }
  from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

/* ── Utilities ───────────────────────────────────────────────────── */
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ── PD / facilitation markdown enrichment ───────────────────────────
   PD docs (docs/pd/**) carry a YAML front-matter block and — for the
   slide decks — a "## Slide N" + Speaker note / Visual structure that
   raw marked.parse() dumps as flat text. These helpers lift the
   front-matter into a metadata card and turn slide blocks into cards.   */

/* Lightweight, dependency-free front-matter splitter. We only support
   the small subset of YAML our PD authoring uses: scalars (quoted or
   bare), inline arrays (["a","b"]), and one level of nested mappings /
   sequences (references:, provenance:, etc.). Anything we can't model
   cleanly is preserved verbatim under the key so nothing is lost. */
function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: null, body: text };
  const raw = m[1];
  const body = text.slice(m[0].length);
  const data = {};
  const lines = raw.split(/\r?\n/);
  const unquote = (v) => {
    v = v.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    return v;
  };
  const parseInlineArray = (v) => v.slice(1, -1).split(',')
    .map(x => unquote(x)).filter(x => x !== '');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!top) { i++; continue; }
    const key = top[1];
    let rest = top[2];
    if (rest === '') {
      // Nested block: gather indented child lines.
      const children = [];
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i])) {
        children.push(lines[i]); i++;
      }
      // Sequence of mappings ("- source: …") → array of objects.
      if (children.some(c => /^\s*-\s/.test(c))) {
        const arr = [];
        let cur = null;
        for (const c of children) {
          const item = /^\s*-\s*(.*)$/.exec(c);
          if (item) {
            if (cur) arr.push(cur);
            cur = {};
            const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(item[1]);
            if (kv) cur[kv[1]] = unquote(kv[2]);
            else cur._value = unquote(item[1]);
          } else if (cur) {
            const kv = /^\s*([A-Za-z0-9_]+):\s*(.*)$/.exec(c);
            if (kv) cur[kv[1]] = unquote(kv[2]);
          }
        }
        if (cur) arr.push(cur);
        data[key] = arr.map(o => (o._value !== undefined && Object.keys(o).length === 1) ? o._value : o);
      } else {
        // Mapping of scalars / inline-arrays.
        const obj = {};
        for (const c of children) {
          const kv = /^\s*([A-Za-z0-9_]+):\s*(.*)$/.exec(c);
          if (!kv) continue;
          const v = kv[2].trim();
          obj[kv[1]] = (v.startsWith('[') && v.endsWith(']')) ? parseInlineArray(v) : unquote(v);
        }
        data[key] = obj;
      }
      continue;
    }
    rest = rest.trim();
    if (rest.startsWith('[') && rest.endsWith(']')) data[key] = parseInlineArray(rest);
    else data[key] = unquote(rest);
    i++;
  }
  return { data, body };
}

/* Glyph + readable label for the docType front-matter value. */
const PD_DOCTYPE_META = {
  'slide-outline':   { glyph: '🎤', label: 'Slide outline' },
  'session-guide':   { glyph: '🗂', label: 'Session guide' },
  'one-pager':       { glyph: '📄', label: 'One-pager' },
  'onepager':        { glyph: '📄', label: 'One-pager' },
  'workbook':        { glyph: '✏️', label: 'Workbook' },
  'program-map':     { glyph: '🗺', label: 'Program map' },
  'train-the-trainer': { glyph: '🎓', label: 'Train-the-trainer' },
};

function pdMetaPills(data) {
  const pills = [];
  const push = (label, val, cls) => {
    if (val === undefined || val === null || val === '') return;
    pills.push(`<span class="pd-meta-pill ${cls || ''}">${escapeHtml(label)}${val === true ? '' : ': ' + escapeHtml(String(val))}</span>`);
  };
  if (data.audience)    push('audience', data.audience, 'pd-pill-audience');
  if (Array.isArray(data.participants) && data.participants.length) {
    push('for', data.participants.join(' · '), 'pd-pill-audience');
  }
  if (data.duration)    push('⏱', data.duration);
  if (data.mode)        push('mode', data.mode);
  if (data.language)    push('lang', data.language);
  return pills.join('');
}

function renderPdMetaCard(data) {
  if (!data) return '';
  const dt = (data.docType || '').toString();
  const meta = PD_DOCTYPE_META[dt] || { glyph: '📘', label: dt || 'Document' };
  const pills = pdMetaPills(data);

  // References (framework / cambridge / eduversal / aicf …) as small chips.
  let refChips = '';
  if (data.references && typeof data.references === 'object') {
    const groups = [];
    for (const [grp, vals] of Object.entries(data.references)) {
      const list = Array.isArray(vals) ? vals : [vals];
      for (const v of list) {
        groups.push(`<span class="pd-ref-chip" title="${escapeHtml(grp)}">${escapeHtml(String(v).replace(/\.json$/, ''))}</span>`);
      }
    }
    if (groups.length) refChips = `<div class="pd-meta-refs"><span class="pd-meta-refs-label">References</span>${groups.join('')}</div>`;
  }

  const purpose = data.purpose
    ? `<p class="pd-meta-purpose">${escapeHtml(data.purpose)}</p>` : '';
  const langNote = data.languageNote
    ? `<p class="pd-meta-langnote">🗣 ${escapeHtml(data.languageNote)}</p>` : '';

  return `
    <div class="pd-meta-card">
      <div class="pd-meta-head">
        <span class="pd-meta-glyph">${meta.glyph}</span>
        <div class="pd-meta-headtext">
          <span class="pd-meta-eyebrow">${escapeHtml(meta.label)}</span>
          ${data.title ? `<span class="pd-meta-title">${escapeHtml(data.title)}</span>` : ''}
        </div>
      </div>
      ${purpose}
      ${pills ? `<div class="pd-meta-pills">${pills}</div>` : ''}
      ${langNote}
      ${refChips}
    </div>`;
}

/* Rewrite a slide-deck body so each "## Slide N — title" block becomes a
   card with the slide number badge, on-screen bullets, and a styled
   Speaker note / Visual footer. Returns markdown-with-embedded-HTML that
   marked.parse() passes through untouched (HTML blocks are preserved). */
function transformSlideDeck(body) {
  const lines = body.split(/\r?\n/);
  const out = [];
  // Keep any leading content (title H1, intro blockquote) before the first slide.
  let slideStarted = false;
  let buf = null;          // current slide's inner lines

  const flush = () => {
    if (!buf) return;
    const { num, title, content } = buf;
    // Pull Speaker note / Visual footer lines out of the bullet body.
    const footer = [];
    const bodyLines = [];
    for (const l of content) {
      const sp = /^\*\*Speaker note:\*\*\s*(.*)$/.exec(l);
      const vi = /^\*\*Visual:\*\*\s*(.*)$/.exec(l);
      if (sp) { footer.push(`<div class="pd-slide-note"><span class="pd-slide-note-tag">🎤 Speaker</span><span class="pd-slide-note-text">${escapeHtml(sp[1])}</span></div>`); }
      else if (vi) { footer.push(`<div class="pd-slide-note pd-slide-visual"><span class="pd-slide-note-tag">🖼 Visual</span><span class="pd-slide-note-text">${escapeHtml(vi[1])}</span></div>`); }
      else bodyLines.push(l);
    }
    out.push(`<div class="pd-slide-card">`);
    out.push(`<div class="pd-slide-badge">Slide ${escapeHtml(String(num))}${title ? ` <span class="pd-slide-badge-title">${escapeHtml(title)}</span>` : ''}</div>`);
    out.push('');
    // Bullets stay as markdown so marked renders bold / chips inside them.
    out.push(bodyLines.join('\n').trim());
    out.push('');
    if (footer.length) out.push(`<div class="pd-slide-footer">${footer.join('')}</div>`);
    out.push(`</div>`);
    out.push('');
    buf = null;
  };

  for (const line of lines) {
    const slide = /^##\s+Slide\s+(\d+)\s*[—–-]?\s*(.*)$/i.exec(line);
    if (slide) {
      flush();
      slideStarted = true;
      buf = { num: slide[1], title: slide[2].trim(), content: [] };
      continue;
    }
    if (buf) buf.content.push(line);
    else out.push(line);   // pre-first-slide preamble passes through
  }
  flush();
  // If we never found a slide block, return the original untouched.
  return slideStarted ? out.join('\n') : body;
}

/* Slugify a heading's text into a DOM-safe id for TOC anchors. */
function slugifyHeading(text, used) {
  let base = String(text).toLowerCase()
    .replace(/<[^>]+>/g, '')           // strip any inline HTML from the heading
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  let slug = base, n = 2;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

/* Post-process rendered markdown HTML: inject ids onto h2/h3 headings and
   build a table-of-contents. Only worth showing for longer multi-section
   docs (handbooks, audits, charters). Returns { html, toc } — toc is '' when
   there are too few headings to bother. Slide decks are excluded by caller. */
function buildMarkdownToc(html) {
  const used = new Set();
  const entries = [];
  const out = html.replace(/<(h[23])>([\s\S]*?)<\/\1>/g, (m, tag, inner) => {
    const id = slugifyHeading(inner, used);
    entries.push({ level: tag === 'h2' ? 2 : 3, id, text: inner });
    return `<${tag} id="${id}">${inner}</${tag}>`;
  });
  // Need at least 3 h2s for a TOC to earn its space.
  const h2count = entries.filter(e => e.level === 2).length;
  if (h2count < 3) return { html, toc: '' };
  const items = entries.map(e =>
    `<li class="md-toc-item md-toc-l${e.level}"><a href="#${e.id}" data-toc-id="${e.id}">${e.text}</a></li>`
  ).join('');
  const toc = `
    <nav class="md-toc" aria-label="On this page">
      <div class="md-toc-label">On this page</div>
      <ul class="md-toc-list">${items}</ul>
    </nav>`;
  return { html: out, toc };
}

/* All MANIFEST facet keys that hold an array of items. Handbooks is
   present but loaded asynchronously from Firestore — callers usually
   want to treat it specially. The 'handbooks' inclusion is controlled
   via the second arg. */
function manifestFacetKeys(MANIFEST, { includeHandbooks = true } = {}) {
  return Object.keys(MANIFEST).filter(k => {
    if (k === 'handbooks' && !includeHandbooks) return false;
    return Array.isArray(MANIFEST[k]);
  });
}

/* ── Card / grid rendering ───────────────────────────────────────── */
function catClassFor(panel) {
  // Per-facet card icon background colour. Extra keys (e.g.
  // 'cat-eduversalStandards') match the chip-family palette used by
  // cambridge-crossref.js so the card icon and the popover read as one.
  return ({
    handbooks:          'cat-induction',
    frameworks:         'cat-framework',
    audits:             'cat-audit',
    cambridge:          'cat-cambridge',
    permen:             'cat-permen',
    schemas:            'cat-schema',
    organization:       'cat-organization',
    eduversalStandards: 'cat-eduversalStandards',
    aiFramework:        'cat-aiFramework',
    // Legacy AH/TH naming kept so hubs that pre-date the shell still resolve.
    aicf:               'cat-aiFramework',
  })[panel] || '';
}

function iconFor(kind /* , panel */) {
  if (kind === 'external') return '↗';
  if (kind === 'md')       return '📄';
  if (kind === 'json')     return '{ }';
  if (kind === 'firestore')return '🔥';
  if (kind === 'index')    return '📋';
  return '📎';
}

function renderTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  const chips = tags.map(t => {
    const fam =
      /^NN[1-5]$/.test(t)             ? 'fam-nn'   :
      /^CTS\b/i.test(t)               ? 'fam-cts'  :
      /^F[1-5L]$|^F_LEAD$/i.test(t)   ? 'fam-f'    :
      /^SKL\b/i.test(t)               ? 'fam-skl'  :
      /^PIGP\b/i.test(t)              ? 'fam-pigp' : '';
    return `<span class="ref-tag ${fam}" role="button" tabindex="0" data-tag="${escapeHtml(t)}" title="Filter to &quot;${escapeHtml(t)}&quot;">${escapeHtml(t)}</span>`;
  }).join('');
  return `<div class="ref-tags">${chips}</div>`;
}

function renderWhenToConsult(text) {
  if (!text) return '';
  return `<div class="ref-card-consult"><span class="ref-card-consult-label">When to consult</span>${escapeHtml(text)}</div>`;
}

/* Cross-reference chip strip — resolves each id via findManifestById so
   stale ids in MANIFEST.connectedTo are silently dropped. */
function renderConnections(MANIFEST, connectedTo) {
  if (!Array.isArray(connectedTo) || !connectedTo.length) return '';
  const chips = connectedTo
    .map(id => ({ id, ref: findManifestById(MANIFEST, id) }))
    .filter(x => x.ref)
    .map(({ id, ref }) =>
      `<span class="ref-conn-chip" role="button" tabindex="0" data-action="open-conn" data-id="${escapeHtml(id)}" title="${escapeHtml(ref.title)}">${escapeHtml(ref.title)}</span>`
    )
    .join('');
  if (!chips) return '';
  return `<div class="ref-conn"><span class="ref-conn-label">Connects to</span>${chips}</div>`;
}

function renderCard(MANIFEST, panel, item) {
  const catCls  = catClassFor(panel);
  const icon    = iconFor(item.kind, panel);
  const meta    = (item.meta || []).map(m => {
    const cls = m === 'JSON' ? 'json'
      : m === 'MD' ? 'md'
      : m === 'live' ? 'live'
      : (m.toLowerCase().includes('forward') || m.toLowerCase().includes('binding') ? 'firestore' : '');
    return `<span class="pill ${cls}">${escapeHtml(m)}</span>`;
  }).join('');
  const consult = renderWhenToConsult(item.whenToConsult);
  // External-kind cards navigate to a sibling page instead of opening
  // the in-modal viewer. Real <a href> with no data-action so the global
  // open-doc handler doesn't intercept it.
  if (item.kind === 'external') {
    return `
      <a class="ref-card ${catCls}" href="${escapeHtml(item.path)}" data-path="${escapeHtml(item.path)}">
        <div class="ref-card-head">
          <div class="ref-card-icon">${icon}</div>
          <div><div class="ref-card-title">${escapeHtml(item.title)}</div></div>
        </div>
        <div class="ref-card-desc">${escapeHtml(item.desc)}</div>
        ${consult}
        <div class="ref-card-meta">${meta}</div>
        ${renderTags(item.tags)}
        ${renderConnections(MANIFEST, item.connectedTo)}
      </a>
    `;
  }
  return `
    <a class="ref-card ${catCls}" href="#" data-action="open-doc" data-path="${escapeHtml(item.path)}" data-kind="${escapeHtml(item.kind)}" data-title="${escapeHtml(item.title)}">
      <div class="ref-card-head">
        <div class="ref-card-icon">${icon}</div>
        <div><div class="ref-card-title">${escapeHtml(item.title)}</div></div>
      </div>
      <div class="ref-card-desc">${escapeHtml(item.desc)}</div>
      ${consult}
      <div class="ref-card-meta">${meta}</div>
      ${renderTags(item.tags)}
      ${renderConnections(MANIFEST, item.connectedTo)}
    </a>
  `;
}

function renderIndexCard(MANIFEST, panel, item) {
  const catCls = catClassFor(panel);
  const subList = item.subItems.map(s =>
    `<a href="#" class="ref-sub-chip" data-action="open-sub" data-path="${escapeHtml(s.path)}" data-title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</a>`
  ).join('');
  const meta = (item.meta || []).map(m => `<span class="pill">${escapeHtml(m)}</span>`).join('');
  return `
    <div class="ref-card ${catCls}" style="cursor:default;">
      <div class="ref-card-head">
        <div class="ref-card-icon">📋</div>
        <div><div class="ref-card-title">${escapeHtml(item.title)}</div></div>
      </div>
      <div class="ref-card-desc">${escapeHtml(item.desc)}</div>
      <div class="ref-card-meta">${meta}</div>
      ${renderTags(item.tags)}
      <div class="ref-sub-list">${subList}</div>
      ${renderConnections(MANIFEST, item.connectedTo)}
    </div>
  `;
}

function renderGrid(MANIFEST, ctx, panel, items) {
  const grid    = document.getElementById('grid' + capitalize(panel));
  const countEl = document.getElementById('cnt'  + capitalize(panel));
  if (!grid) return;
  if (countEl) countEl.textContent = items.length;
  grid.innerHTML = items.map(item =>
    item.kind === 'index'
      ? renderIndexCard(MANIFEST, panel, item)
      : renderCard(MANIFEST, panel, item)
  ).join('');
  grid.querySelectorAll('[data-action="open-doc"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      ctx.openDoc({ path: el.dataset.path, kind: el.dataset.kind, title: el.dataset.title });
    });
  });
  grid.querySelectorAll('[data-action="open-sub"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      ctx.openDoc({ path: el.dataset.path, kind: 'json', title: el.dataset.title });
    });
  });
  // Connected-doc chips — same modal. External-kind targets navigate.
  grid.querySelectorAll('[data-action="open-conn"]').forEach(el => {
    const fire = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = el.dataset.id;
      const target = findManifestById(MANIFEST, id);
      if (!target) return;
      if (target.kind === 'external') { window.location.href = target.path; return; }
      ctx.openDoc({ path: target.path, kind: target.kind, title: target.title });
    };
    el.addEventListener('click', fire);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') fire(e);
    });
  });
}

/* ── Manifest lookup ──────────────────────────────────────────────── */
function flatManifest(MANIFEST) {
  const out = [];
  for (const cat of manifestFacetKeys(MANIFEST, { includeHandbooks: false })) {
    for (const item of (MANIFEST[cat] || [])) {
      if (item.kind === 'index') continue;
      out.push({ ...item, _cat: cat });
    }
  }
  return out;
}

function findManifestById(MANIFEST, id) {
  for (const panel of manifestFacetKeys(MANIFEST, { includeHandbooks: false })) {
    const items = MANIFEST[panel] || [];
    for (const item of items) {
      if (item.id === id) {
        if (item.kind === 'index' && item.subItems && item.subItems.length) {
          const first = item.subItems[0];
          return { id: item.id, title: item.title, path: first.path, kind: 'json' };
        }
        return item;
      }
      if (item.subItems) {
        const sub = item.subItems.find(s => s.id === id);
        if (sub) return { ...sub, kind: 'json' };
      }
    }
  }
  return null;
}

function idForPath(MANIFEST, path) {
  for (const panel of manifestFacetKeys(MANIFEST, { includeHandbooks: false })) {
    const items = MANIFEST[panel] || [];
    for (const it of items) {
      if (it.path === path) return it.id;
      if (it.subItems) {
        const sub = it.subItems.find(s => s.path === path);
        if (sub) return sub.id;
      }
    }
  }
  return null;
}

/* ── Search ──────────────────────────────────────────────────────── */
function indexHits(_searchIndex, q) {
  const hits = new Set();
  const idx = _searchIndex && _searchIndex.docs;
  if (!idx) return hits;
  const ql = q.toLowerCase();
  for (const [path, entry] of Object.entries(idx)) {
    const inTokens   = (entry.tokens   || []).some(t => t.toLowerCase().includes(ql));
    const inHeadings = (entry.headings || []).some(h => h.toLowerCase().includes(ql));
    if (inTokens || inHeadings) hits.add(path);
  }
  return hits;
}

/* ── Recently viewed (localStorage MRU, max 5, dedup) ────────────── */
const RECENT_KEY = 'ref:recent:v1';

function recordRecent(ctx, item) {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const existing = list.findIndex(r => r.path === item.path);
    if (existing !== -1) list.splice(existing, 1);
    list.unshift({ path: item.path, kind: item.kind, title: item.title });
    if (list.length > 5) list.length = 5;
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    renderRecentBar(ctx);
  } catch (e) { /* localStorage unavailable — silently skip */ }
}

function renderRecentBar(ctx) {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) {}
  const bar  = document.getElementById('recentBar');
  const slot = document.getElementById('recentChips');
  if (!bar || !slot) return;
  if (!list.length) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  slot.innerHTML = list.map(r =>
    `<button class="ref-shelf-chip recent" type="button"
             data-path="${escapeHtml(r.path)}"
             data-kind="${escapeHtml(r.kind)}"
             data-title="${escapeHtml(r.title)}"
             title="${escapeHtml(r.title)}"><span>${escapeHtml(r.title)}</span></button>`
  ).join('');
  slot.querySelectorAll('.ref-shelf-chip').forEach(el => {
    el.addEventListener('click', () => ctx.openDoc({
      path: el.dataset.path, kind: el.dataset.kind, title: el.dataset.title
    }));
  });
}

/* ── Curated rail: "For your role" ───────────────────────────────── */
function effectiveRole(opts) {
  const p = window.userProfile || {};
  if (p[opts.roleField] === opts.adminValue) return 'director';
  const subs = Array.isArray(p[opts.subRoleField]) ? p[opts.subRoleField] : [];
  if (subs.includes('director')) return 'director';
  // CH only — subject specialist composite role.
  const subjects = Array.isArray(p.ch_subjects) ? p.ch_subjects : [];
  if (subs.includes('coordinator') && subjects.length === 1) {
    return `${subjects[0]}_specialist`;
  }
  if (subs.includes('coordinator')) return 'coordinator';
  // AH leadership sub-roles
  for (const r of ['school_principal', 'academic_coordinator', 'cambridge_coordinator', 'foundation_representative']) {
    if (subs.includes(r)) return r;
  }
  // TH sub-roles
  for (const r of ['subject_leader', 'subject_teacher']) {
    if (subs.includes(r)) return r;
  }
  return 'plain_user';
}

function renderQuickAccess(MANIFEST, ctx, opts) {
  if (typeof opts.roleRailMatcher !== 'function') return;
  const host    = document.getElementById('refQuick');
  const chipBox = document.getElementById('refQuickChips');
  const label   = document.getElementById('refQuickLabel');
  if (!host || !chipBox || !label) return;

  const role = effectiveRole(opts);
  const all  = flatManifest(MANIFEST);
  const roleHits = all.filter(it =>
    opts.roleRailMatcher(role, it._cat, it) ||
    (Array.isArray(it.pinFor) && it.pinFor.includes(role))
  ).slice(0, 8);

  if (!roleHits.length) { host.style.display = 'none'; return; }
  host.style.display = '';

  const roleLabel = ({
    director: 'Director',
    coordinator: 'Coordinator',
    plain_user: 'User',
  })[role] || role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  label.textContent = `For your role — ${roleLabel}`;
  host.open = role === 'director';

  chipBox.innerHTML = roleHits.map(it => `
    <button class="ref-shelf-chip role" type="button"
            data-path="${escapeHtml(it.path)}"
            data-kind="${escapeHtml(it.kind)}"
            data-title="${escapeHtml(it.title)}"
            title="${escapeHtml(it.title)}"><span>${escapeHtml(it.title)}</span></button>
  `).join('');
  chipBox.querySelectorAll('.ref-shelf-chip').forEach(el => {
    el.addEventListener('click', () => ctx.openDoc({
      path: el.dataset.path, kind: el.dataset.kind, title: el.dataset.title
    }));
  });
}

/* ── Handbooks (Firestore induction_programs) ─────────────────────── */
async function loadHandbooks(MANIFEST, ctx, opts) {
  const grid = document.getElementById('gridHandbooks');
  if (!grid) return;
  grid.innerHTML = '<div class="doc-loading">Loading handbooks…</div>';
  try {
    const snap = await getDocs(query(collection(window.db, 'induction_programs'), limit(50)));
    let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Audience filter: AH leadership sees handbooks where audience.platform
    // matches 'academic'; TH teachers see 'teachers'; CH sees everything
    // (handbookAudienceFilter null/undefined).
    if (Array.isArray(opts.handbookAudienceFilter) && opts.handbookAudienceFilter.length) {
      docs = docs.filter(d => {
        const plat = d.audience?.platform;
        // No platform → visible to all (defensive — older induction docs)
        if (!plat) return true;
        return opts.handbookAudienceFilter.includes(plat);
      });
    }

    ctx.handbookCache = docs;
    const cntEl = document.getElementById('cntHandbooks');
    if (cntEl) cntEl.textContent = docs.length;

    if (!docs.length) {
      grid.innerHTML = '<div class="doc-error">No matching induction_programs docs found for this audience.</div>';
      return;
    }

    const sorted = [...docs].sort((a, b) => {
      const aKind = a.handbookKind || 'induction';
      const bKind = b.handbookKind || 'induction';
      if (aKind === bKind) return (a.title || a.id).localeCompare(b.title || b.id);
      return aKind === 'induction' ? -1 : 1;
    });

    // Cross-hub handbook reader URL: CH renders the handbook reader at
    // /handbook?id=…; AH+TH cross-link to CH for the canonical view.
    const handbookHrefBase = opts.handbookHrefBase || 'handbook';
    const handbookHrefTarget = opts.handbookHrefTarget || '_self';

    grid.innerHTML = sorted.map(hb => {
      const audience = [
        hb.audience?.platform,
        hb.audience?.subRole || (Array.isArray(hb.audience?.subRoleValues) ? hb.audience.subRoleValues.join(',') : null)
      ].filter(Boolean).join(' · ');
      const stages = Array.isArray(hb.stages) ? hb.stages.length : 0;
      const isRoleOp = hb.handbookKind === 'role-operational';
      const icon   = isRoleOp ? '🛡' : '📕';
      const catCls = isRoleOp ? 'cat-handbook-roleop' : 'cat-induction';
      const days   = hb.duration?.totalDays;
      const checklistLink = hb.weeklyChecklistLink;
      return `
        <a class="ref-card ${catCls}" href="${handbookHrefBase}?id=${encodeURIComponent(hb.id)}" data-id="${escapeHtml(hb.id)}" data-action="open-handbook" target="${handbookHrefTarget}">
          <div class="ref-card-head">
            <div class="ref-card-icon">${icon}</div>
            <div><div class="ref-card-title">${escapeHtml(hb.title || hb.id)}</div></div>
          </div>
          <div class="ref-card-desc">${escapeHtml(hb.subtitle || '')}</div>
          <div class="ref-card-meta">
            ${audience ? `<span class="pill">${escapeHtml(audience)}</span>` : ''}
            ${hb.version ? `<span class="pill">v${escapeHtml(hb.version)}</span>` : ''}
            ${days ? `<span class="pill">${days}d</span>` : (stages ? `<span class="pill">${stages} stages</span>` : '')}
            ${checklistLink ? `<span class="pill" style="background:#cffafe;color:#0e7490;">📅 ${escapeHtml(checklistLink)}</span>` : ''}
            <span class="pill firestore">induction_programs</span>
          </div>
        </a>
      `;
    }).join('');
  } catch (err) {
    console.error('handbook load', err);
    grid.innerHTML = `<div class="doc-error">Could not load handbooks: ${escapeHtml(err.message || err.code || 'unknown')}</div>`;
  }
}

/* ── Build-time content search index (best-effort) ────────────────── */
async function loadSearchIndex(ctx, opts) {
  if (ctx._searchIndex !== null) return ctx._searchIndex;
  try {
    const res = await fetch(opts.searchIndexUrl || 'references-search-index.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    ctx._searchIndex = json;
    return json;
  } catch (err) {
    console.warn('Search index unavailable; falling back to DOM-only search.', err);
    ctx._searchIndex = { docs: {} };
    return ctx._searchIndex;
  }
}

/* ── Facet + search ──────────────────────────────────────────────── */
function applyFacet(MANIFEST, ctx, cat, opts = {}) {
  ctx._activeFacet = cat || 'all';
  // Sync chip active state
  document.querySelectorAll('.ref-facet').forEach(b => {
    const on = b.dataset.cat === ctx._activeFacet;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  // Show/hide sections; accordion behaviour: facet pick auto-opens.
  document.querySelectorAll('.ref-section').forEach(sec => {
    const show = ctx._activeFacet === 'all' || sec.dataset.cat === ctx._activeFacet;
    sec.classList.toggle('is-hidden', !show);
    sec.open = (ctx._activeFacet !== 'all' && show);
  });
  // URL sync
  if (!opts.silent) {
    const url = new URL(window.location.href);
    url.searchParams.delete('tab');
    if (ctx._activeFacet === 'all') url.searchParams.delete('cat');
    else url.searchParams.set('cat', ctx._activeFacet);
    window.history.replaceState({}, '', url);
  }
  // Re-run active search so per-section counts reflect new facet scope.
  const sInput = document.getElementById('refSearchInput');
  applySearch(MANIFEST, ctx, sInput ? sInput.value : '');
}

function applySearch(MANIFEST, ctx, qRaw) {
  const q = qRaw.trim().toLowerCase();
  const sClear = document.getElementById('refSearchClear');
  const sInfo  = document.getElementById('refSearchInfo');
  if (sClear) sClear.style.display = q ? '' : 'none';

  // URL sync
  const url = new URL(window.location.href);
  const trimmed = qRaw.trim();
  url.searchParams.delete('tag');
  if (trimmed) url.searchParams.set('q', trimmed);
  else url.searchParams.delete('q');
  window.history.replaceState({}, '', url);

  const idxPaths = q ? indexHits(ctx._searchIndex, q) : new Set();

  let totalMatches = 0;
  let extraFromIndex = 0;
  const emptyState = document.getElementById('refResultsEmpty');

  document.querySelectorAll('.ref-section').forEach(sec => {
    const sectionCat = sec.dataset.cat;
    const inFacet = ctx._activeFacet === 'all' || ctx._activeFacet === sectionCat;
    let sectionMatches = 0;
    sec.querySelectorAll('.ref-card').forEach(card => {
      if (!inFacet) { card.classList.add('filtered-out'); return; }
      if (!q) { card.classList.remove('filtered-out'); sectionMatches++; return; }
      const text = (card.textContent || '').toLowerCase();
      const path = card.dataset.path;
      const matchText  = text.includes(q);
      const matchIndex = path && idxPaths.has(path);
      const match = matchText || matchIndex;
      card.classList.toggle('filtered-out', !match);
      if (match) {
        sectionMatches++;
        if (!matchText && matchIndex) extraFromIndex++;
      }
    });
    const hideSection = !inFacet || (q && sectionMatches === 0);
    sec.classList.toggle('is-hidden', hideSection);
    if (q) {
      sec.open = inFacet && sectionMatches > 0;
    } else {
      sec.open = (ctx._activeFacet !== 'all' && inFacet);
    }
    const countEl = sec.querySelector('[data-count-for]');
    if (countEl) countEl.textContent = sectionMatches;
    if (inFacet) totalMatches += sectionMatches;
  });

  if (emptyState) emptyState.classList.toggle('visible', q !== '' && totalMatches === 0);

  if (!sInfo) return;
  if (!q) {
    sInfo.textContent = ctx._activeFacet === 'all' ? '' : `${totalMatches} in this facet`;
    return;
  }
  const extra = extraFromIndex > 0 ? ` (+${extraFromIndex} from doc body)` : '';
  sInfo.textContent = `${totalMatches} match${totalMatches === 1 ? '' : 'es'}${extra}`;
}

/* ── Cross-ref chip injection (inline CTS / SKL / PIGP / ES / AICF) ─ */
function injectCrossrefChips(html) {
  let out = html;
  out = out.replace(/\bCTS\s+(\d+\.\d+)\b/g, (m, n) => `<span class="task-chip cts" title="Cambridge Teacher Standards CTS ${n}">CTS ${n}</span>`);
  out = out.replace(/\bPIGP\s+((?:pasal|lampiran)-[A-Za-z0-9-]+)/gi, (m, n) => `<span class="hb-tag pigp">PIGP ${n}</span>`);
  out = out.replace(/\bSKL[:\s]+([a-z_]+)\b/gi, (m, n) => `<span class="hb-tag skl">SKL: ${n}</span>`);
  return out;
}

/* ── Document modal ──────────────────────────────────────────────── */
function buildReverseIndex(MANIFEST, ctx) {
  if (ctx._reverseIndex) return ctx._reverseIndex;
  const idx = {};
  for (const cat of manifestFacetKeys(MANIFEST, { includeHandbooks: false })) {
    for (const item of (MANIFEST[cat] || [])) {
      if (!Array.isArray(item.connectedTo)) continue;
      if (item.kind === 'index') continue;
      for (const targetId of item.connectedTo) {
        (idx[targetId] = idx[targetId] || []).push({
          id: item.id, title: item.title, path: item.path, kind: item.kind
        });
      }
    }
  }
  ctx._reverseIndex = idx;
  return idx;
}

function renderBackChips(MANIFEST, ctx, currentId) {
  const idx = buildReverseIndex(MANIFEST, ctx);
  const incoming = idx[currentId] || [];
  if (!incoming.length) return '';
  const chips = incoming.map(it =>
    `<span class="doc-back-chip" role="button" tabindex="0" data-action="open-back" data-path="${escapeHtml(it.path)}" data-kind="${escapeHtml(it.kind)}" data-title="${escapeHtml(it.title)}" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</span>`
  ).join('');
  const noun = incoming.length === 1 ? 'doc' : 'docs';
  return `<div class="doc-back"><span class="doc-back-label">Referenced by ${incoming.length} ${noun}</span>${chips}</div>`;
}

function visibleDocsInGrid() {
  const cards = document.querySelectorAll(
    '.ref-section[open]:not(.is-hidden) .ref-card[data-action="open-doc"][data-path]:not(.filtered-out)'
  );
  return [...cards].map(c => ({
    path: c.dataset.path, kind: c.dataset.kind, title: c.dataset.title
  }));
}

function updateModalNav(ctx) {
  const prevBtn = document.getElementById('docNavPrev');
  const nextBtn = document.getElementById('docNavNext');
  const posEl   = document.getElementById('docNavPos');
  if (!prevBtn || !nextBtn) return;
  const docs = visibleDocsInGrid();
  const idx = docs.findIndex(d => d.path === ctx._currentDocPath);
  if (idx === -1 || docs.length <= 1) {
    prevBtn.disabled = true; nextBtn.disabled = true;
    if (posEl) posEl.textContent = '';
    return;
  }
  prevBtn.disabled = (idx === 0);
  nextBtn.disabled = (idx === docs.length - 1);
  if (posEl) posEl.textContent = `${idx + 1} / ${docs.length}`;
}

function navDoc(ctx, delta) {
  const docs = visibleDocsInGrid();
  const idx = docs.findIndex(d => d.path === ctx._currentDocPath);
  if (idx === -1) return;
  const next = idx + delta;
  if (next < 0 || next >= docs.length) return;
  ctx.openDoc(docs[next]);
}

async function openDoc(MANIFEST, ctx, { path, kind, title }) {
  const overlay = document.getElementById('docModalOverlay');
  const titleEl = document.getElementById('docModalTitle');
  const metaEl  = document.getElementById('docModalMeta');
  const bodyEl  = document.getElementById('docModalBody');
  if (!overlay || !bodyEl) return;

  if (titleEl) titleEl.textContent = title;
  if (metaEl)  metaEl.textContent = `${kind.toUpperCase()} · references-data/${path}`;
  bodyEl.innerHTML = '<div class="doc-loading">Loading…</div>';
  overlay.classList.add('open');
  ctx._currentDocPath = path;
  updateModalNav(ctx);

  recordRecent(ctx, { path, kind, title });

  const id = idForPath(MANIFEST, path);
  if (id) {
    const url = new URL(window.location.href);
    url.searchParams.set('doc', id);
    window.history.replaceState({}, '', url);
  }

  const backStrip = id ? renderBackChips(MANIFEST, ctx, id) : '';

  try {
    const url = `references-data/${path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const text = await res.text();

    if (kind === 'md') {
      const { data: fm, body: mdBody } = parseFrontmatter(text);
      const metaCard = renderPdMetaCard(fm);
      const isSlideDeck = fm && (fm.docType === 'slide-outline');
      const source = isSlideDeck ? transformSlideDeck(mdBody) : mdBody;
      let html = window.marked ? window.marked.parse(source) : `<pre>${escapeHtml(source)}</pre>`;
      // TOC for long, multi-section prose docs (handbooks, audits, charters).
      // Slide decks navigate by card, so skip them.
      let toc = '';
      if (!isSlideDeck && window.marked) {
        const built = buildMarkdownToc(html);
        html = built.html; toc = built.toc;
      }
      const renderClass = isSlideDeck ? 'md-render pd-slide-render' : 'md-render';
      const bodyHtml = `<div class="${renderClass}">${injectCrossrefChips(html)}</div>`;
      const layout = toc
        ? `<div class="md-doc-layout">${toc}<div class="md-doc-main">${bodyHtml}</div></div>`
        : bodyHtml;
      bodyEl.innerHTML = `${backStrip}${metaCard}${layout}`;
      // Smooth-scroll the modal body to the heading on TOC click.
      bodyEl.querySelectorAll('.md-toc a[data-toc-id]').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const target = bodyEl.querySelector('#' + CSS.escape(a.dataset.tocId));
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    } else if (kind === 'json') {
      const viewer = window.EduversalReferencesViewer;
      let inner;
      if (viewer && typeof viewer.renderSchemaAware === 'function') {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) {}
        inner = parsed === null
          ? `<pre class="json-render">${injectCrossrefChips(escapeHtml(text))}</pre>`
          : viewer.renderSchemaAware(parsed);
      } else {
        let pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
        inner = `<pre class="json-render">${injectCrossrefChips(escapeHtml(pretty))}</pre>`;
      }
      bodyEl.innerHTML = `${backStrip}${inner}`;
    } else {
      bodyEl.innerHTML = `${backStrip}<pre>${escapeHtml(text)}</pre>`;
    }

    bodyEl.querySelectorAll('[data-action="open-back"]').forEach(el => {
      const fire = (e) => {
        e.preventDefault();
        if (el.dataset.kind === 'external') {
          window.location.href = el.dataset.path;
          return;
        }
        ctx.openDoc({ path: el.dataset.path, kind: el.dataset.kind, title: el.dataset.title });
      };
      el.addEventListener('click', fire);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') fire(e);
      });
    });
  } catch (err) {
    console.error('openDoc', err);
    bodyEl.innerHTML = `<div class="doc-error">Could not load: ${escapeHtml(err.message || 'unknown')}<br><br>Make sure <code>build.js</code> copied the file into <code>dist/references-data/</code>.</div>`;
  }
}

function closeDoc(ctx) {
  const overlay = document.getElementById('docModalOverlay');
  if (overlay) overlay.classList.remove('open');
  ctx._currentDocPath = null;
  const url = new URL(window.location.href);
  if (url.searchParams.has('doc')) {
    url.searchParams.delete('doc');
    window.history.replaceState({}, '', url);
  }
}

/* ── Public entrypoint ───────────────────────────────────────────── */
export async function initReferencesPage(MANIFEST, options = {}) {
  // Defaults — CH-shape so existing CH refactor stays minimal.
  const opts = {
    roleField:              'role_centralhub',
    adminValue:             'central_admin',
    subRoleField:           'ch_sub_roles',
    loadHandbooks:          true,
    handbookAudienceFilter: null,
    roleRailMatcher:        null,
    searchIndexUrl:         'references-search-index.json',
    handbookHrefBase:       'handbook',
    handbookHrefTarget:     '_self',
    ...options,
  };

  // Per-page rendering context — kept inside this closure so multiple
  // invocations (theoretical; we never expect more than one /references
  // per page) wouldn't collide on the module-level state.
  const ctx = {
    _activeFacet:    'all',
    _currentDocPath: null,
    _searchIndex:    null,
    _reverseIndex:   null,
    handbookCache:   [],
    openDoc:         (args) => openDoc(MANIFEST, ctx, args),
  };

  /* Hero "Last build" KPI — short date. Reads "now" (no build-time
     timestamp injection yet). */
  const heroBuild = document.getElementById('heroKpiBuild');
  if (heroBuild) {
    heroBuild.textContent = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }

  /* Facet chips */
  document.querySelectorAll('.ref-facet').forEach(btn => {
    btn.addEventListener('click', () => applyFacet(MANIFEST, ctx, btn.dataset.cat));
  });

  /* Restore facet from URL (+ back-compat ?tab=) */
  const params = new URLSearchParams(window.location.search);
  const cat = params.get('cat') || params.get('tab') || 'all';
  applyFacet(MANIFEST, ctx, cat, { silent: true });

  /* Sticky-toolbar shadow */
  const toolbar = document.getElementById('refToolbar');
  if (toolbar) {
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none;';
    toolbar.parentNode.insertBefore(sentinel, toolbar);
    try {
      new IntersectionObserver(
        ([e]) => toolbar.classList.toggle('is-stuck', !e.isIntersecting),
        { threshold: 0 }
      ).observe(sentinel);
    } catch (_) { /* IO unsupported — toolbar still works, just no shadow */ }
  }

  /* Modal close + prev/next + arrow keys */
  const modalClose = document.getElementById('docModalClose');
  if (modalClose) modalClose.addEventListener('click', () => closeDoc(ctx));
  const modalOverlay = document.getElementById('docModalOverlay');
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'docModalOverlay') closeDoc(ctx);
    });
  }
  const navPrev = document.getElementById('docNavPrev');
  const navNext = document.getElementById('docNavNext');
  if (navPrev) navPrev.addEventListener('click', () => navDoc(ctx, -1));
  if (navNext) navNext.addEventListener('click', () => navDoc(ctx, +1));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDoc(ctx); return; }
    if (!modalOverlay || !modalOverlay.classList.contains('open')) return;
    const inField = e.target.matches && e.target.matches('input, textarea, [contenteditable]');
    if (inField) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); navDoc(ctx, -1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); navDoc(ctx, +1); }
  });

  /* Render every static facet (iterate MANIFEST keys; handbooks comes
     in async after Firestore loads). */
  for (const facet of manifestFacetKeys(MANIFEST, { includeHandbooks: false })) {
    renderGrid(MANIFEST, ctx, facet, MANIFEST[facet]);
  }

  /* Curated rail (only if hub passed a matcher) */
  renderQuickAccess(MANIFEST, ctx, opts);

  /* Search index — non-awaited so the page paints immediately. */
  loadSearchIndex(ctx, opts);

  /* Handbooks (Firestore) — awaited so the total counters that follow
     include the handbook count. Hubs can pass loadHandbooks:false to
     skip entirely (e.g. if a hub doesn't surface handbooks here). */
  if (opts.loadHandbooks) {
    await loadHandbooks(MANIFEST, ctx, opts);
  }

  /* Total counters — populates hero KPIs + 'All' facet chip + section
     count badges. Iterates MANIFEST keys so additions land for free. */
  const staticTotal = manifestFacetKeys(MANIFEST, { includeHandbooks: false })
    .reduce((n, cat) => n + (MANIFEST[cat] || []).length, 0);
  const total = staticTotal + (ctx.handbookCache?.length || 0);

  const bindingCount = manifestFacetKeys(MANIFEST, { includeHandbooks: false })
    .flatMap(c => MANIFEST[c] || [])
    .filter(it => Array.isArray(it.meta) && it.meta.some(m => /binding|authoritative/.test(m)))
    .length;

  const heroTotal   = document.getElementById('heroKpiTotal');
  const heroBinding = document.getElementById('heroKpiBinding');
  const cntAll      = document.getElementById('cntAll');
  if (heroTotal)   heroTotal.textContent = total;
  if (heroBinding) heroBinding.textContent = bindingCount;
  if (cntAll)      cntAll.textContent = total;

  /* Seed every section count badge. */
  const seedSectionCount = (cat, n) => {
    const el = document.querySelector(`.ref-section[data-cat="${cat}"] [data-count-for]`);
    if (el) el.textContent = n;
  };
  if (opts.loadHandbooks) seedSectionCount('handbooks', ctx.handbookCache?.length || 0);
  for (const cat of manifestFacetKeys(MANIFEST, { includeHandbooks: false })) {
    seedSectionCount(cat, MANIFEST[cat].length);
  }

  /* Hide empty facet chips */
  document.querySelectorAll('.ref-facet').forEach(b => {
    const facetCat = b.dataset.cat;
    if (facetCat === 'all') return;
    const cntEl = document.getElementById('cnt' + capitalize(facetCat));
    const n = parseInt(cntEl?.textContent || '0', 10);
    b.classList.toggle('is-empty', n === 0);
  });

  /* Search wiring */
  const sInput = document.getElementById('refSearchInput');
  const sClear = document.getElementById('refSearchClear');
  if (sInput) {
    sInput.placeholder = `Search ${total} docs — try "NN3", "F3L", "mentor-cert"…`;
    sInput.addEventListener('input', () => applySearch(MANIFEST, ctx, sInput.value));
  }
  if (sClear) {
    sClear.addEventListener('click', () => {
      if (sInput) { sInput.value = ''; applySearch(MANIFEST, ctx, ''); sInput.focus(); }
    });
  }

  /* Restore search/filter from URL */
  const initialQuery = params.get('q') || params.get('tag') || '';
  if (initialQuery && sInput) {
    sInput.value = initialQuery;
    applySearch(MANIFEST, ctx, initialQuery);
  }

  /* Tag click → drive search. Document-level delegation, capture phase
     so it fires BEFORE parent-card bubble-phase openDoc. */
  const triggerTagSearch = (tag) => {
    if (!sInput) return;
    sInput.value = tag;
    applySearch(MANIFEST, ctx, tag);
    if (modalOverlay && modalOverlay.classList.contains('open')) closeDoc(ctx);
    sInput.focus();
    sInput.select();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  document.addEventListener('click', (e) => {
    const tagEl = e.target.closest && e.target.closest('.ref-tag[data-tag]');
    if (!tagEl) return;
    e.preventDefault(); e.stopPropagation();
    triggerTagSearch(tagEl.dataset.tag);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tagEl = e.target.closest && e.target.closest('.ref-tag[data-tag]');
    if (!tagEl) return;
    e.preventDefault(); e.stopPropagation();
    triggerTagSearch(tagEl.dataset.tag);
  }, true);

  /* MRU bar */
  renderRecentBar(ctx);

  /* Deep-link ?doc=<id> */
  const docParam = params.get('doc');
  if (docParam) {
    const item = findManifestById(MANIFEST, docParam);
    if (item) {
      if (item.kind === 'external') {
        window.location.href = item.path;
        return;
      }
      ctx.openDoc({ path: item.path, kind: item.kind, title: item.title });
    }
  }
}
