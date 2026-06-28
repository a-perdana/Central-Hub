/* references-viewer.js — schema-aware document viewer for the
 * /references modal across Central / Academic / Teachers Hub.
 *
 * Source of truth: monorepo-root /shared-design/. Each hub copies this
 * into its dist/ at build time (with a local-copy override for
 * standalone deploys, mirroring the nav-edit-simple.js pattern).
 *
 * Public API (window.EduversalReferencesViewer):
 *   .renderSchemaAware(parsed)       → HTML string for the modal body.
 *                                      Top-level recognised keys render
 *                                      as prose-style cards; the rest go
 *                                      inside a collapsible Raw JSON block.
 *   .renderRawJson(value)            → pretty syntax-highlighted JSON
 *                                      (no schema awareness; used when
 *                                      the doc isn't an object).
 *   .injectCrossrefChips(html)       → post-process escaped HTML to add
 *                                      CTS / SKL / PIGP cross-ref chips.
 *                                      Safe: only inserts static literals.
 *   .escapeHtml(s)                   → standard HTML-escape helper.
 *
 * Required CSS: load /references-viewer.css (or shared-design copy)
 * BEFORE the first call so all .doc-view-* classes resolve.
 */
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* Post-process rendered HTML and convert inline Cambridge / Permendiknas
     references into chip elements that cambridge-crossref.js auto-wires.
     Operates on already-escaped HTML so we never re-introduce unsafe markup —
     all replaced tokens are static literals. */
  function injectCrossrefChips(html) {
    let out = html;
    out = out.replace(/\bCTS\s+(\d+\.\d+)\b/g, (m, n) => `<span class="task-chip cts" title="Cambridge Teacher Standards CTS ${n}">CTS ${n}</span>`);
    out = out.replace(/\bPIGP\s+((?:pasal|lampiran)-[A-Za-z0-9-]+)/gi, (m, n) => `<span class="hb-tag pigp">PIGP ${n}</span>`);
    out = out.replace(/\bSKL[:\s]+([a-z_]+)\b/gi, (m, n) => `<span class="hb-tag skl">SKL: ${n}</span>`);
    return out;
  }

  function richString(s) {
    return injectCrossrefChips(escapeHtml(String(s ?? '')));
  }

  function humaniseKey(k) {
    return String(k)
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  }

  /* Pretty-print a JSON value into syntax-highlighted HTML. */
  function formatJsonHtml(value, indent) {
    indent = indent || 0;
    const pad = '  '.repeat(indent);
    const padNext = '  '.repeat(indent + 1);
    if (value === null) return '<span class="jh-null">null</span>';
    const t = typeof value;
    if (t === 'boolean') return `<span class="jh-bool">${value}</span>`;
    if (t === 'number')  return `<span class="jh-num">${value}</span>`;
    if (t === 'string') {
      const escaped = escapeHtml(value);
      const withChips = injectCrossrefChips(escaped);
      return `<span class="jh-quote">"</span><span class="jh-str">${withChips}</span><span class="jh-quote">"</span>`;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return '<span class="jh-punc">[]</span>';
      const items = value.map(v => `${padNext}${formatJsonHtml(v, indent + 1)}`).join('<span class="jh-punc">,</span>\n');
      return `<span class="jh-punc">[</span>\n${items}\n${pad}<span class="jh-punc">]</span>`;
    }
    if (t === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 0) return '<span class="jh-punc">{}</span>';
      const items = keys.map(k => {
        const keyHtml = `<span class="jh-quote">"</span><span class="jh-key">${escapeHtml(k)}</span><span class="jh-quote">"</span>`;
        return `${padNext}${keyHtml}<span class="jh-punc">:</span> ${formatJsonHtml(value[k], indent + 1)}`;
      }).join('<span class="jh-punc">,</span>\n');
      return `<span class="jh-punc">{</span>\n${items}\n${pad}<span class="jh-punc">}</span>`;
    }
    return escapeHtml(String(value));
  }

  function renderDocHeader(obj) {
    const titleSrc = obj.title || obj.documentTitle || obj.name;
    if (!titleSrc) return '';
    const version = obj.version || obj.edition;
    const date    = obj.effective_date || obj.publishedOn || obj.downloadedOn;
    const publisher = obj.publisher;
    const status  = obj.status;
    const desc    = obj.description || obj.subtitle || obj.purposeForEduversal;
    const meta = [
      version   && `<span><strong>Version</strong> ${escapeHtml(version)}</span>`,
      date      && `<span><strong>Date</strong> ${escapeHtml(date)}</span>`,
      publisher && `<span><strong>Publisher</strong> ${escapeHtml(publisher)}</span>`,
      status    && `<span><strong>Status</strong> ${escapeHtml(status)}</span>`,
    ].filter(Boolean).join('');
    return `
      <header class="doc-view-header">
        <h2>${escapeHtml(titleSrc)}</h2>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        ${desc ? `<p>${richString(desc)}</p>` : ''}
      </header>`;
  }

  function renderStringArraySection(label, items) {
    if (!Array.isArray(items) || !items.length || !items.every(x => typeof x === 'string')) return null;
    const lis = items.map(s => `<li>${richString(s)}</li>`).join('');
    return `
      <section class="doc-view-section">
        <h3>${escapeHtml(label)} <span class="count">${items.length}</span></h3>
        <ul class="doc-view-bullets">${lis}</ul>
      </section>`;
  }

  function renderRefArraySection(label, items) {
    if (!Array.isArray(items) || !items.length) return null;
    const cards = [];
    for (const it of items) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
      const code  = it.code || it.standard || it.id || it.anchor;
      const title = it.title || it.name || it.label;
      const body  = it.relevance || it.description || it.note || it.rationale;
      if (!code && !title && !body) return null;
      cards.push(`
        <div class="doc-view-ref">
          ${code  ? `<span class="code">${escapeHtml(code)}</span>` : ''}
          ${title ? `<div class="title">${richString(title)}</div>` : ''}
          ${body  ? `<div class="body">${richString(body)}</div>`   : ''}
        </div>`);
    }
    return `
      <section class="doc-view-section">
        <h3>${escapeHtml(label)} <span class="count">${items.length}</span></h3>
        <div class="doc-view-refs">${cards.join('')}</div>
      </section>`;
  }

  /* Render a single object-field value. Primitives render inline; arrays
     of primitives render as a comma list (or a count chip if long); nested
     objects render as a compact key:value run (or a count chip). This keeps
     card fields readable without dumping rich structure to Raw JSON. */
  // depth guards against pathological nesting; past ~3 levels we stop
  // recursing and fall back to the "object · N keys" summary so the modal
  // can't blow up on a deeply-nested doc. Most reference JSONs (e.g.
  // coaching-questions: item -> {title, questions -> {level: [strings]}})
  // are 2-3 deep — recursing makes their actual content visible instead of
  // a useless "object · 2 keys" placeholder.
  const MAX_FIELD_DEPTH = 3;
  function renderFieldValue(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return '<span class="dv-empty">—</span>';
    if (Array.isArray(v)) {
      if (!v.length) return '<span class="dv-empty">—</span>';
      const primOnly = v.every(x => x === null || typeof x !== 'object');
      if (primOnly && v.length <= 8) return v.map(x => richString(x)).join(', ');
      if (primOnly) return `<span class="doc-view-kv-nested">${v.length} items</span>`;
      // Array of objects: name/label/title preview + count.
      const names = v.map(o => (o && (o.name || o.label || o.title || o.id || o.code)))
        .filter(Boolean).slice(0, 4);
      if (names.length) {
        return `<span class="dv-list">${names.map(n => `<span class="dv-tag">${richString(n)}</span>`).join('')}</span>${v.length > names.length ? ` <span class="doc-view-kv-nested">+${v.length - names.length}</span>` : ''}`;
      }
      // No identity field to preview — recurse into the first few entries
      // rather than showing a bare "N entries" count.
      if (depth < MAX_FIELD_DEPTH) {
        const shown = v.slice(0, 6).map(item =>
          `<div class="dv-nest-item">${renderFieldValue(item, depth + 1)}</div>`).join('');
        return `<div class="dv-nest">${shown}${v.length > 6 ? `<span class="doc-view-kv-nested">+${v.length - 6} more</span>` : ''}</div>`;
      }
      return `<span class="doc-view-kv-nested">${v.length} entries</span>`;
    }
    if (typeof v === 'object') {
      const subKeys = Object.keys(v);
      const allPrim = subKeys.every(sk => v[sk] === null || typeof v[sk] !== 'object');
      if (allPrim && subKeys.length <= 4) {
        return subKeys.map(sk => `<span class="dv-subk">${escapeHtml(humaniseKey(sk))}:</span> ${richString(v[sk])}`).join('<br>');
      }
      // Nested object with object/array children — recurse so the reader
      // sees the actual structure (e.g. questions -> {induction:[…]}).
      if (depth < MAX_FIELD_DEPTH) {
        const rows = subKeys.map(sk =>
          `<div class="dv-nest-row"><span class="dv-subk">${escapeHtml(humaniseKey(sk))}:</span> <div class="dv-nest-val">${renderFieldValue(v[sk], depth + 1)}</div></div>`).join('');
        return `<div class="dv-nest">${rows}</div>`;
      }
      return `<span class="doc-view-kv-nested">object · ${subKeys.length} key${subKeys.length === 1 ? '' : 's'}</span>`;
    }
    return richString(v);
  }

  function renderObjectArraySection(label, items) {
    if (!Array.isArray(items) || !items.length) return null;
    if (!items.every(it => it && typeof it === 'object' && !Array.isArray(it))) return null;
    const cards = items.map(it => {
      // Lead with an identity line (name/label/title/id/code) if present,
      // so each card reads as a titled unit rather than an anonymous grid.
      const titleKey = ['name', 'label', 'title', 'id', 'code'].find(k => typeof it[k] === 'string');
      const titleHtml = titleKey
        ? `<div class="doc-view-object-title">${richString(it[titleKey])}</div>` : '';
      const fields = Object.entries(it)
        .filter(([k, v]) => k !== titleKey && v !== null && v !== undefined && v !== '')
        .slice(0, 10)
        .map(([k, v]) => `
          <div class="field">
            <div class="field-label">${escapeHtml(humaniseKey(k))}</div>
            <div class="field-value">${renderFieldValue(v)}</div>
          </div>`).join('');
      return `<div class="doc-view-object">${titleHtml}${fields}</div>`;
    }).join('');
    return `
      <section class="doc-view-section">
        <h3>${escapeHtml(label)} <span class="count">${items.length}</span></h3>
        <div class="doc-view-objects">${cards}</div>
      </section>`;
  }

  function renderFlatObjectSection(label, obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const entries = Object.entries(obj);
    if (!entries.length) return null;
    const rows = entries.map(([k, v]) => {
      let valueHtml;
      if (v === null || v === undefined) {
        valueHtml = '<span style="color:var(--ink-3);font-style:italic;">—</span>';
      } else if (Array.isArray(v)) {
        const primOnly = v.every(x => x === null || typeof x !== 'object');
        if (primOnly && v.length <= 6) valueHtml = v.map(x => richString(x)).join(', ');
        else valueHtml = renderFieldValue(v, 1);  // recurse into array-of-objects / long arrays
      } else if (typeof v === 'object') {
        const subKeys = Object.keys(v);
        const allPrim = subKeys.every(sk => v[sk] === null || typeof v[sk] !== 'object');
        if (allPrim && subKeys.length <= 3) {
          valueHtml = subKeys.map(sk => `<b style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink-3);">${escapeHtml(sk)}:</b> ${richString(v[sk])}`).join(' &nbsp;·&nbsp; ');
        } else {
          valueHtml = renderFieldValue(v, 1);  // recurse into nested object (e.g. coaching item -> questions)
        }
      } else {
        valueHtml = richString(v);
      }
      return `<dt>${escapeHtml(humaniseKey(k))}</dt><dd>${valueHtml}</dd>`;
    }).join('');
    return `
      <section class="doc-view-section">
        <h3>${escapeHtml(label)}</h3>
        <dl class="doc-view-kv">${rows}</dl>
      </section>`;
  }

  function renderRefOrFlatSection(label, value) {
    return renderRefArraySection(label, value) || renderFlatObjectSection(label, value);
  }
  function renderObjArrayOrFlat(label, value) {
    return renderObjectArraySection(label, value) || renderFlatObjectSection(label, value);
  }

  const META_FIELDS = [
    ['schema_version',  'Schema',          false],
    ['version',         'Version',         false],
    ['edition',         'Edition',         false],
    ['effective_date',  'Effective',       false],
    ['publishedOn',     'Published',       false],
    ['downloadedOn',    'Downloaded',      false],
    ['lastUpdated',     'Last Updated',    false],
    ['id',              'Section ID',      false],
    ['publisher',       'Publisher',       false],
    ['status',          'Status',          false],
    ['track',           'Track',           false],
    ['platform',        'Platform',        false],
    ['platform_label',  'Platform',        false],
    ['hub',             'Hub',             false],
    ['language',        'Language',        false],
    ['academic_year',   'Academic Year',   false],
    ['total_weeks',     'Weeks',           false],
    ['priority_levels', 'Priority Levels', false],
    ['copyright',       'Copyright',       false],
    ['shortName',       'Short Name',      false],
    ['source',          'Source',          true],
    ['officialUrl',     'Official URL',    true],
    ['localPdfPath',    'Local PDF',       false],
    ['localPdfSha256',  'PDF SHA-256',     false],
    ['$schema',         'JSON Schema',     true],
    ['applies_to',      'Applies To',      false],
  ];

  function renderDocMetaStrip(obj) {
    const chips = [];
    const consumed = [];
    for (const [key, label, isLink] of META_FIELDS) {
      if (!(key in obj)) continue;
      const v = obj[key];
      if (v === null || v === undefined || typeof v === 'object') continue;
      const display = String(v);
      const short = display.length > 60 ? display.slice(0, 56) + '…' : display;
      const valueHtml = (isLink && /^https?:\/\//i.test(display))
        ? `<a class="value" href="${escapeHtml(display)}" target="_blank" rel="noopener" title="${escapeHtml(display)}">${escapeHtml(short)}</a>`
        : `<span class="value" title="${escapeHtml(display)}">${escapeHtml(short)}</span>`;
      chips.push(`<span class="doc-view-meta-chip"><span class="label">${escapeHtml(label)}</span>${valueHtml}</span>`);
      consumed.push(key);
    }
    if (!chips.length) return { html: '', consumed: [] };
    return { html: `<div class="doc-view-meta-strip">${chips.join('')}</div>`, consumed };
  }

  function renderTheoryBasisSection(label, obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const primary = obj.primary;
    const refs = Array.isArray(obj.references) ? obj.references.filter(r => typeof r === 'string') : [];
    if (!primary && !refs.length) return null;
    const refsHtml = refs.length
      ? `<ul class="refs">${refs.map(r => `<li>${richString(r)}</li>`).join('')}</ul>`
      : '';
    return `
      <section class="doc-view-section">
        <h3>${escapeHtml(label)}</h3>
        <div class="doc-view-theory">
          ${primary ? `<div class="primary">${richString(primary)}</div>` : ''}
          ${refsHtml}
        </div>
      </section>`;
  }

  function renderWeightsSection(label, obj, extraOut) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const chips = [];
    let nestedTiming = null;
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'collection_timing' && v && typeof v === 'object' && !Array.isArray(v)) {
        nestedTiming = v;
        continue;
      }
      if (typeof v === 'number') {
        const pct = (v >= 0 && v <= 1) ? `${(v * 100).toFixed(0)}%` : String(v);
        chips.push(`<span class="w-chip"><span class="w-key">${escapeHtml(k)}</span><span class="w-val">${escapeHtml(pct)}</span></span>`);
      } else if (typeof v === 'string') {
        chips.push(`<span class="w-chip"><span class="w-key">${escapeHtml(k)}</span><span class="w-val">${escapeHtml(v)}</span></span>`);
      }
    }
    if (!chips.length && !nestedTiming) return null;
    const main = chips.length
      ? `<section class="doc-view-section">
          <h3>${escapeHtml(label)}</h3>
          <div class="doc-view-weights">${chips.join('')}</div>
        </section>`
      : '';
    if (nestedTiming && extraOut) {
      const t = renderObjArrayOrFlat('Collection Timing', nestedTiming);
      if (t) extraOut.push(t);
    }
    return main || ' ';
  }

  function renderLevelVisibilitySection(label, obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const note = typeof obj.note === 'string' ? obj.note : '';
    const order = Array.isArray(obj.order) ? obj.order.filter(o => typeof o === 'string') : [];
    if (!note && !order.length) return null;
    const flowHtml = order.length
      ? `<div class="doc-view-levels-flow">${
          order.map((o, i) => `<span class="lvl">${escapeHtml(o)}</span>${i < order.length - 1 ? '<span class="arrow">→</span>' : ''}`).join('')
        }</div>`
      : '';
    return `
      <section class="doc-view-section">
        <h3>${escapeHtml(label)}</h3>
        ${note ? `<div class="doc-view-levels-note">${richString(note)}</div>` : ''}
        ${flowHtml}
      </section>`;
  }

  function renderFrameworkArraySection(label, items) {
    if (!Array.isArray(items) || !items.length) return null;
    if (!items.every(it => it && typeof it === 'object' && (it.id || it.title || it.name))) return null;
    const cards = items.map(it => {
      const id    = it.id || '';
      const title = it.title || it.name || it.label || '';
      const desc  = it.description || it.summary || it.note || '';
      const stats = [];
      if (typeof it.weight === 'number') {
        const pct = (it.weight >= 0 && it.weight <= 1) ? `${(it.weight * 100).toFixed(0)}%` : String(it.weight);
        stats.push(`Weight <strong>${escapeHtml(pct)}</strong>`);
      }
      if (Array.isArray(it.items)) stats.push(`<strong>${it.items.length}</strong> item${it.items.length === 1 ? '' : 's'}`);
      if (Array.isArray(it.competencies)) stats.push(`<strong>${it.competencies.length}</strong> competenc${it.competencies.length === 1 ? 'y' : 'ies'}`);
      if (Array.isArray(it.tasks)) stats.push(`<strong>${it.tasks.length}</strong> task${it.tasks.length === 1 ? '' : 's'}`);
      if (typeof it.items_note === 'string' && it.items_note) stats.push(escapeHtml(it.items_note));
      const statsHtml = stats.length
        ? `<div class="doc-view-fw-card-stats">${stats.map(s => `<span class="doc-view-fw-card-stat">${s}</span>`).join('')}</div>`
        : '';
      return `
        <div class="doc-view-fw-card">
          <div class="doc-view-fw-card-head">
            ${id ? `<span class="doc-view-fw-card-id">${escapeHtml(id)}</span>` : ''}
            <div class="doc-view-fw-card-title">${richString(title)}</div>
          </div>
          ${desc ? `<div class="doc-view-fw-card-desc">${richString(desc)}</div>` : ''}
          ${statsHtml}
        </div>`;
    }).join('');
    return `
      <section class="doc-view-section">
        <h3>${escapeHtml(label)} <span class="count">${items.length}</span></h3>
        <div class="doc-view-fw-grid">${cards}</div>
      </section>`;
  }

  /* Eduversal Academic Standards section shape:
       { id, title, lastUpdated, subsections: [{ id, title, content: [...] }] }
     Content block types: 'text' {text,title?} · 'list' {items[],title?} ·
                          'process' {steps[],title?} · 'table' {headers[],rows[][],title?}.
     Renders subsection cards (id chip + title + typed content blocks) instead
     of raw JSON. */
  function renderContentBlock(block) {
    if (!block || typeof block !== 'object') return '';
    const t = block.type;
    const titleHtml = (typeof block.title === 'string' && block.title.trim())
      ? `<div class="doc-view-block-title">${richString(block.title)}</div>`
      : '';
    if (t === 'text' && typeof block.text === 'string') {
      return `<div class="doc-view-block doc-view-block-text">${titleHtml}<p>${richString(block.text)}</p></div>`;
    }
    if (t === 'list' && Array.isArray(block.items) && block.items.length) {
      const lis = block.items
        .filter(x => typeof x === 'string')
        .map(s => `<li>${richString(s)}</li>`).join('');
      return `<div class="doc-view-block doc-view-block-list">${titleHtml}<ul>${lis}</ul></div>`;
    }
    if (t === 'process' && Array.isArray(block.steps) && block.steps.length) {
      const lis = block.steps
        .filter(x => typeof x === 'string')
        .map((s, i) => `<li><span class="step-num">${i + 1}</span><span class="step-body">${richString(s)}</span></li>`).join('');
      return `<div class="doc-view-block doc-view-block-process">${titleHtml}<ol class="doc-view-process">${lis}</ol></div>`;
    }
    if (t === 'table' && Array.isArray(block.headers) && Array.isArray(block.rows)) {
      const th = block.headers.map(h => `<th>${richString(h)}</th>`).join('');
      const tr = block.rows.map(row => {
        if (!Array.isArray(row)) return '';
        const tds = row.map(cell => `<td>${richString(cell)}</td>`).join('');
        return `<tr>${tds}</tr>`;
      }).join('');
      return `<div class="doc-view-block doc-view-block-table">${titleHtml}<div class="doc-view-table-scroll"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div></div>`;
    }
    return '';
  }

  function renderSubsectionsSection(label, items) {
    if (!Array.isArray(items) || !items.length) return null;
    if (!items.every(it => it && typeof it === 'object' && Array.isArray(it.content))) return null;
    /* Native <details> accordion: only the first subsection opens by default —
       keeps long policy sections (ES 5 has 17 subsections) scannable. Users can
       expand others one at a time without JS overhead. */
    const cards = items.map((sub, idx) => {
      const id    = typeof sub.id === 'string' ? sub.id : '';
      const title = typeof sub.title === 'string' ? sub.title : '';
      const blocks = sub.content.map(renderContentBlock).filter(Boolean).join('');
      const openAttr = idx === 0 ? ' open' : '';
      return `
        <details class="doc-view-subsection"${openAttr}>
          <summary class="doc-view-subsection-head">
            ${id ? `<span class="doc-view-subsection-id">${escapeHtml(id)}</span>` : ''}
            ${title ? `<span class="doc-view-subsection-title">${richString(title)}</span>` : ''}
            <span class="doc-view-subsection-chevron" aria-hidden="true">▸</span>
          </summary>
          ${blocks ? `<div class="doc-view-subsection-body">${blocks}</div>` : ''}
        </details>`;
    }).join('');
    return `
      <section class="doc-view-section">
        <h3>${escapeHtml(label)} <span class="count">${items.length}</span></h3>
        <div class="doc-view-subsections">${cards}</div>
      </section>`;
  }

  function renderProseOrStructured(label, value) {
    if (typeof value === 'string') {
      if (!value.trim()) return null;
      return `<section class="doc-view-section">
        <h3>${escapeHtml(label)}</h3>
        <div class="doc-view-theory"><div class="primary">${richString(value)}</div></div>
      </section>`;
    }
    return renderObjArrayOrFlat(label, value);
  }

  function renderProvenanceFooter(obj) {
    const blocks = [];
    ['provenance', 'last_extended'].forEach(key => {
      if (!(key in obj)) return;
      const v = obj[key];
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;
      const bits = [];
      for (const [k, val] of Object.entries(v)) {
        if (val === null || val === undefined) continue;
        if (Array.isArray(val)) {
          const allPrim = val.every(x => x === null || typeof x !== 'object');
          if (allPrim && val.length <= 8) bits.push(`<b>${escapeHtml(humaniseKey(k))}:</b> <code>${escapeHtml(val.join(', '))}</code>`);
          else bits.push(`<b>${escapeHtml(humaniseKey(k))}:</b> <code>${val.length} entries</code>`);
        } else if (typeof val !== 'object') {
          bits.push(`<b>${escapeHtml(humaniseKey(k))}:</b> <code>${escapeHtml(String(val))}</code>`);
        }
      }
      if (bits.length) {
        blocks.push(`<div class="doc-view-provenance"><span><b>${escapeHtml(humaniseKey(key))}:</b></span>${bits.join('')}</div>`);
      }
    });
    return blocks.length ? blocks.join('') : null;
  }

  function buildSchemaAwareSections(obj) {
    const consumed = new Set();
    const out = [];

    const headerKeys = ['title','documentTitle','name','version','edition','effective_date','publishedOn','downloadedOn','publisher','status','description','subtitle','purposeForEduversal'];
    const headerHtml = renderDocHeader(obj);
    if (headerHtml) {
      headerKeys.forEach(k => k in obj && consumed.add(k));
      out.push(headerHtml);
    }

    const meta = renderDocMetaStrip(obj);
    if (meta.html) {
      meta.consumed.forEach(k => consumed.add(k));
      out.push(meta.html);
    }

    const patterns = [
      ['design_principles',         'Design Principles',          renderStringArraySection],
      ['principles',                'Principles',                 renderStringArraySection],
      ['regulatory_alignment',      'Regulatory Alignment',       renderRefArraySection],
      ['regulatory_anchors',        'Regulatory Anchors',         renderRefArraySection],
      ['framework_anchors',         'Framework Anchors',          renderRefOrFlatSection],
      ['cambridge_alignment',       'Cambridge Alignment',        renderRefOrFlatSection],
      ['theory_basis',              'Theory Basis',               renderTheoryBasisSection],
      ['weights',                   'Weights',                    (l, v) => renderWeightsSection(l, v, out)],
      ['level_visibility',          'Level Visibility',           renderLevelVisibilitySection],
      ['frameworks',                'Frameworks',                 renderFrameworkArraySection],
      ['domains',                   'Domains',                    renderFrameworkArraySection],
      ['nonNegotiables',            'Non-Negotiables',            renderObjArrayOrFlat],
      ['charter_compliance',        'Charter Compliance',         renderObjArrayOrFlat],
      ['scoring_scale',             'Scoring Scale',              renderObjArrayOrFlat],
      ['predicate_bands',           'Predicate Bands',            renderObjArrayOrFlat],
      ['cohort_definitions',        'Cohort Definitions',         renderObjArrayOrFlat],
      ['question_bank',             'Question Bank',              renderObjArrayOrFlat],
      ['narrative_fields',          'Narrative Fields',           renderObjArrayOrFlat],
      ['rolesAndCommitments',       'Roles & Commitments',        renderObjArrayOrFlat],
      ['session_structure',         'Session Structure',          renderObjArrayOrFlat],
      ['session_focus_areas_year_1','Session Focus — Year 1',     renderObjArrayOrFlat],
      ['session_focus_areas_year_2_plus','Session Focus — Year 2+', renderObjArrayOrFlat],
      ['modes_of_operation',        'Modes of Operation',         renderObjArrayOrFlat],
      ['observer_roles',            'Observer Roles',             renderObjArrayOrFlat],
      ['response_options',          'Response Options',           renderObjArrayOrFlat],
      ['foci',                      'Foci',                       renderObjArrayOrFlat],
      ['metadata_fields',           'Metadata Fields',            renderObjArrayOrFlat],
      ['data_sources',              'Data Sources',               renderObjArrayOrFlat],
      ['task_categories',           'Task Categories',            renderObjArrayOrFlat],
      ['priority_levels',           'Priority Levels',            renderObjArrayOrFlat],
      ['recurring_tasks',           'Recurring Tasks',            renderObjArrayOrFlat],
      ['monthly_tasks',             'Monthly Tasks',              renderObjArrayOrFlat],
      ['termly_tasks',              'Termly Tasks',               renderObjArrayOrFlat],
      ['yearly_arc',                'Yearly Arc',                 renderObjArrayOrFlat],
      ['induction_overlay',         'Induction Overlay',          renderObjArrayOrFlat],
      ['cambridgeTeacherAttributes','Cambridge Teacher Attributes', renderObjArrayOrFlat],
      ['structure',                 'Structure',                  renderRefOrFlatSection],
      ['output',                    'Output',                     renderRefOrFlatSection],
      ['purpose',                   'Purpose',                    renderRefOrFlatSection],
      ['context',                   'Context',                    renderRefOrFlatSection],
      ['entries',                   'Entries',                    renderObjArrayOrFlat],
      ['post_backfill_state',       'Post-Backfill State',        renderRefOrFlatSection],
      ['openItems',                 'Open Items',                 renderStringArraySection],
      ['items',                     'Items',                      renderObjArrayOrFlat],
      ['relevanceToEduversal',      'Relevance to Eduversal',     (l, v) => typeof v === 'string' ? `<section class="doc-view-section"><h3>${escapeHtml(l)}</h3><div class="doc-view-theory"><div class="primary">${richString(v)}</div></div></section>` : null],
      ['audience_description',      'Audience',                   renderProseOrStructured],
      ['scope',                     'Scope',                      renderProseOrStructured],
      ['purposeNote',               'Purpose',                    renderProseOrStructured],
      ['globalRationale',           'Global Rationale',           renderProseOrStructured],
      ['domainRationale',           'Domain Rationale',           renderObjArrayOrFlat],
      ['rationale',                 'Rationale',                  renderProseOrStructured],
      ['definitions',               'Definitions',                renderObjArrayOrFlat],
      ['articles',                  'Articles',                   renderObjArrayOrFlat],
      ['lampiran',                  'Lampiran',                   renderObjArrayOrFlat],
      ['eightDimensions',           'Eight Dimensions',           renderObjArrayOrFlat],
      ['perJenjang',                'Per Jenjang',                renderObjArrayOrFlat],
      ['progressionAcrossJenjang',  'Progression Across Jenjang', renderObjArrayOrFlat],
      ['fivePerformanceCategories', 'Five Performance Categories', renderObjArrayOrFlat],
      ['fourCompetencePillarsAnchor','Four Competence Pillars',   renderObjArrayOrFlat],
      ['fourPillars',               'Four Pillars',               renderObjArrayOrFlat],
      ['relevantPenutupArticles',   'Relevant Penutup Articles',  renderObjArrayOrFlat],
      ['eduversalCompliancePosture','Eduversal Compliance',       renderProseOrStructured],
      ['publisherContext',          'Publisher Context',          renderProseOrStructured],
      ['definitionOfMentoring',     'Definition of Mentoring',    renderProseOrStructured],
      ['valueForMentee',            'Value for Mentee',           renderObjArrayOrFlat],
      ['valueForMentor',            'Value for Mentor',           renderObjArrayOrFlat],
      ['responsibilities',          'Responsibilities',           renderObjArrayOrFlat],
      ['whenToHaveAMentor',         'When to Have a Mentor',      renderProseOrStructured],
      ['firstMeetingChecklist',     'First Meeting Checklist',    renderObjArrayOrFlat],
      ['practicalArrangementsHeaders','Practical Arrangements',   renderObjArrayOrFlat],
      ['conversationCycle',         'Conversation Cycle',         renderObjArrayOrFlat],
      ['listeningSkills',           'Listening Skills',           renderObjArrayOrFlat],
      ['questioningSkills',         'Questioning Skills',         renderObjArrayOrFlat],
      ['smartObjectives',           'SMART Objectives',           renderObjArrayOrFlat],
      ['growTechnique',             'GROW Technique',             renderObjArrayOrFlat],
      ['mentoringChallenges',       'Mentoring Challenges',       renderObjArrayOrFlat],
      ['noFaultTerminationPrinciple','No-Fault Termination',      renderProseOrStructured],
      ['mentorCertificationCurriculumDraft','Mentor Cert Curriculum', renderObjArrayOrFlat],
      ['qualificationContext',      'Qualification Context',      renderProseOrStructured],
      ['designPrinciples',          'Design Principles',          renderStringArraySection],
      ['certificateAims',           'Certificate Aims',           renderStringArraySection],
      ['module1',                   'Module 1',                   renderObjArrayOrFlat],
      ['assessmentCriteria',        'Assessment Criteria',        renderObjArrayOrFlat],
      ['supportResources',          'Support Resources',          renderObjArrayOrFlat],
      ['source_inheritance',        'Source Inheritance',         renderProseOrStructured],
      ['category_mapping',          'Category Mapping',           renderObjArrayOrFlat],
      ['cadence_to_week_expansion', 'Cadence → Week Expansion',   renderObjArrayOrFlat],
      ['week_specific_overrides',   'Week-Specific Overrides',    renderObjArrayOrFlat],
      ['fortnightly_tasks',         'Fortnightly Tasks',          renderObjArrayOrFlat],
      ['platform_label_alt',        'Platform (Alt Label)',       renderProseOrStructured],
      ['applies_when_school',       'Applies When (School)',      renderProseOrStructured],
      ['applies_when_user',         'Applies When (User)',        renderProseOrStructured],
      ['naming_clarification',      'Naming Clarification',       renderProseOrStructured],
      ['parent_rubric',             'Parent Rubric',              renderProseOrStructured],
      ['cadence_periods',           'Cadence Periods',            renderObjArrayOrFlat],
      ['indonesian_calendar_anchors','Indonesian Calendar',       renderObjArrayOrFlat],
      ['cambridge_calendar_anchors','Cambridge Calendar',         renderObjArrayOrFlat],
      ['eduversal_calendar_anchors','Eduversal Calendar',         renderObjArrayOrFlat],
      ['eduversal_network_anchors', 'Eduversal Network Anchors',  renderObjArrayOrFlat],
      ['ease_assessment_windows',   'EASE Assessment Windows',    renderObjArrayOrFlat],
      ['governance_rhythm_anchors', 'Governance Rhythm',          renderObjArrayOrFlat],
      ['induction_window_alignment','Induction Window Alignment', renderObjArrayOrFlat],
      ['reference_documents',       'Reference Documents',        renderObjArrayOrFlat],
      ['tasks',                     'Tasks',                      renderObjArrayOrFlat],
      ['system_integration',        'System Integration',         renderObjArrayOrFlat],
      ['academic_year_template',    'Academic Year Template',     renderObjArrayOrFlat],
      ['semester_split',            'Semester Split',             renderObjArrayOrFlat],
      ['usage_notes',               'Usage Notes',                renderProseOrStructured],
      ['school_appraisal_v2_to_principal_rubric','School v2 → Principal Rubric', renderObjArrayOrFlat],
      ['principal_rubric_to_school_appraisal','Principal → School v2',           renderObjArrayOrFlat],
      ['triangulation_protocol',    'Triangulation Protocol',     renderObjArrayOrFlat],
      ['gaps_with_no_principal_rubric_coverage','Coverage Gaps',  renderObjArrayOrFlat],
      ['principal_foci_mapping_density','Foci Mapping Density',   renderObjArrayOrFlat],
      ['implementation_notes',      'Implementation Notes',       renderProseOrStructured],
      ['domain',                    'Domain',                     renderProseOrStructured],
      ['linkedDocuments',           'Linked Documents',           renderObjArrayOrFlat],
      ['collections',               'Collections',                renderObjArrayOrFlat],
      ['additionalUserFields',      'Additional User Fields',     renderObjArrayOrFlat],
      ['rolesUsedByRules',          'Roles Used by Rules',        renderObjArrayOrFlat],
      ['stateMachine',              'State Machine',              renderObjArrayOrFlat],
      ['publishedBy',               'Published By',               renderProseOrStructured],
      ['escalationRoute',           'Escalation Route',           renderObjArrayOrFlat],
      ['review',                    'Review',                     renderObjArrayOrFlat],
      ['data_model',                'Data Model',                 renderObjArrayOrFlat],
      ['evidence_lineage',          'Evidence Lineage',           renderObjArrayOrFlat],
      ['session_outcome_metrics_tracked','Session Outcome Metrics', renderObjArrayOrFlat],
      ['common_failure_modes',      'Common Failure Modes',       renderObjArrayOrFlat],
      ['ui_implementation_phase_2', 'UI Implementation Phase 2',  renderObjArrayOrFlat],
      ['cycle_calendar',            'Cycle Calendar',             renderObjArrayOrFlat],
      ['data_aggregation_rules',    'Data Aggregation Rules',     renderObjArrayOrFlat],
      ['phase_2_implementation',    'Phase 2 Implementation',     renderObjArrayOrFlat],
      ['merges_into',               'Merges Into',                renderObjArrayOrFlat],
      ['merge_policy',              'Merge Policy',               renderProseOrStructured],
      ['cross_module_links',        'Cross-Module Links',         renderObjArrayOrFlat],
      ['cross_module_audit',        'Cross-Module Audit',         renderObjArrayOrFlat],
      ['weight_audit',              'Weight Audit',               renderObjArrayOrFlat],
      ['format_fidelity_notes',     'Format Fidelity Notes',      renderProseOrStructured],
      ['audiences',                 'Audiences',                  renderObjArrayOrFlat],
      ['scopeNote',                 'Scope Note',                 renderProseOrStructured],
      ['distributedLeadership',     'Distributed Leadership',     renderObjArrayOrFlat],
      ['rationaleByDomain',         'Rationale by Domain',        renderObjArrayOrFlat],
      ['relationToOtherStandards',  'Relation to Other Standards', renderObjArrayOrFlat],
      ['bibliography',              'Bibliography',               renderObjArrayOrFlat],
      ['scoring',                   'Scoring',                    renderRefOrFlatSection],
      ['indonesian_competency_mapping','Indonesian Competency Mapping', renderObjArrayOrFlat],
      ['tugas_pokok_mapping',       'Tugas Pokok Mapping',        renderObjArrayOrFlat],
      ['snp_mapping',               'SNP Mapping',                renderObjArrayOrFlat],
      ['visit_types',               'Visit Types',                renderObjArrayOrFlat],
      ['derivative_modules',        'Derivative Modules',         renderObjArrayOrFlat],
      ['source',                    'Source',                     renderProseOrStructured],
      ['ditetapkanDi',              'Ditetapkan Di',              renderProseOrStructured],
      ['ditetapkanTanggal',         'Ditetapkan Tanggal',         renderProseOrStructured],
      ['diundangkanTanggal',        'Diundangkan Tanggal',        renderProseOrStructured],
      ['berita_negara',             'Berita Negara',              renderProseOrStructured],
      ['supersedes',                'Supersedes',                 renderProseOrStructured],
      ['menimbang',                 'Menimbang',                  renderObjArrayOrFlat],
      ['intendedFirestoreShape',    'Intended Firestore Shape',   renderObjArrayOrFlat],
      ['regulation',                'Regulation',                 renderProseOrStructured],
      ['issuer',                    'Issuer',                     renderProseOrStructured],
      ['datePromulgated',           'Date Promulgated',           renderProseOrStructured],
      ['level_determination',       'Level Determination',        renderProseOrStructured],
      ['levels',                    'Levels',                     renderObjArrayOrFlat],
      ['appraisal_calendar',        'Appraisal Calendar',         renderObjArrayOrFlat],
      ['firestore_integration',     'Firestore Integration',      renderObjArrayOrFlat],
      ['schema_lineage',            'Schema Lineage',             renderObjArrayOrFlat],
      ['teachers_track_entries',    'Teachers Track Entries',     renderObjArrayOrFlat],
      ['leaders_track_entries',     'Leaders Track Entries',      renderObjArrayOrFlat],
      ['audience',                  'Audience',                   renderProseOrStructured],
      ['_continuation_note',        'Continuation Note',          renderProseOrStructured],
      ['merge_protocol',            'Merge Protocol',             renderProseOrStructured],
      ['polished_readings',         'Polished Readings',          renderObjArrayOrFlat],
      ['meta',                      'Meta',                       renderRefOrFlatSection],
      ['level_order',               'Level Order',                renderStringArraySection],
      ['subsections',               'Subsections',                renderSubsectionsSection],
    ];
    for (const [key, label, fn] of patterns) {
      if (!(key in obj)) continue;
      const html = fn(label, obj[key]);
      if (html) { if (html.trim()) out.push(html); consumed.add(key); }
    }

    const provHtml = renderProvenanceFooter(obj);
    if (provHtml) {
      if ('provenance'    in obj) consumed.add('provenance');
      if ('last_extended' in obj) consumed.add('last_extended');
      out.push(provHtml);
    }

    return { html: out.join(''), consumed };
  }

  /* Competency-framework shape: a top-level ARRAY of
       { id, levels: { <levelName>: { reading, keyTakeaways[], selfAssessment[],
                                      activity:{task,output,duration,evidence} } } }
     Used by teaching-/leadership-competency-framework.json. Without this the
     whole array falls through to raw JSON (renderSchemaAware bails on arrays).
     Renders each competency as a card whose CPD levels are a <details>
     accordion (first level open), mirroring renderSubsectionsSection. */
  const COMPETENCY_LEVEL_LABELS = {
    awareness:    'Awareness',
    practitioner: 'Practitioner',
    advanced:     'Advanced',
    lead:         'Lead / Mentor',
    expert:       'Expert',
  };
  // Stable display order — render whatever subset of these keys is present,
  // in CPD-ladder order, then any unrecognised level keys after.
  const COMPETENCY_LEVEL_ORDER = ['awareness', 'practitioner', 'advanced', 'lead', 'expert'];

  function isCompetencyArray(arr) {
    return Array.isArray(arr) && arr.length > 0 && arr.every(e =>
      e && typeof e === 'object' && !Array.isArray(e) &&
      typeof e.id === 'string' &&
      e.levels && typeof e.levels === 'object' && !Array.isArray(e.levels) &&
      Object.values(e.levels).some(l => l && typeof l === 'object'));
  }

  function renderCompetencyLevelBody(level) {
    if (!level || typeof level !== 'object') return '';
    const parts = [];
    if (typeof level.reading === 'string' && level.reading.trim()) {
      parts.push(`<div class="doc-view-block doc-view-block-text"><p>${richString(level.reading)}</p></div>`);
    }
    const ktSection = renderStringArraySection('Key Takeaways', level.keyTakeaways);
    if (ktSection) parts.push(ktSection);
    const saSection = renderStringArraySection('Self-Assessment', level.selfAssessment);
    if (saSection) parts.push(saSection);
    const act = level.activity;
    if (act && typeof act === 'object' && !Array.isArray(act)) {
      const rows = [
        act.task     && `<div class="dv-act-row"><span class="dv-act-k">Task</span><span class="dv-act-v">${richString(act.task)}</span></div>`,
        act.output   && `<div class="dv-act-row"><span class="dv-act-k">Output</span><span class="dv-act-v">${richString(act.output)}</span></div>`,
        act.duration && `<div class="dv-act-row"><span class="dv-act-k">Duration</span><span class="dv-act-v">${richString(act.duration)}</span></div>`,
        act.evidence && `<div class="dv-act-row"><span class="dv-act-k">Evidence</span><span class="dv-act-v">${richString(act.evidence)}</span></div>`,
      ].filter(Boolean).join('');
      if (rows) {
        parts.push(`<section class="doc-view-section"><h3>Activity</h3><div class="doc-view-activity">${rows}</div></section>`);
      }
    }
    return parts.join('');
  }

  function renderCompetencyArray(arr, title) {
    const orderedKeys = (levels) => {
      const present = Object.keys(levels);
      const known = COMPETENCY_LEVEL_ORDER.filter(k => present.includes(k));
      const extra = present.filter(k => !COMPETENCY_LEVEL_ORDER.includes(k));
      return known.concat(extra);
    };
    const cards = arr.map(comp => {
      const levelKeys = orderedKeys(comp.levels);
      const levelHtml = levelKeys.map((lk, idx) => {
        const label = COMPETENCY_LEVEL_LABELS[lk] || humaniseKey(lk);
        const body  = renderCompetencyLevelBody(comp.levels[lk]);
        const openAttr = idx === 0 ? ' open' : '';
        return `
          <details class="doc-view-subsection"${openAttr}>
            <summary class="doc-view-subsection-head">
              <span class="doc-view-subsection-title">${escapeHtml(label)}</span>
              <span class="doc-view-subsection-chevron" aria-hidden="true">▸</span>
            </summary>
            ${body ? `<div class="doc-view-subsection-body">${body}</div>` : ''}
          </details>`;
      }).join('');
      const compTitle = comp.title || comp.name || comp.label || '';
      return `
        <section class="doc-view-competency">
          <div class="doc-view-competency-head">
            <span class="doc-view-competency-id">${escapeHtml(comp.id)}</span>
            ${compTitle ? `<span class="doc-view-competency-title">${richString(compTitle)}</span>` : ''}
            <span class="doc-view-competency-levelcount">${levelKeys.length} level${levelKeys.length === 1 ? '' : 's'}</span>
          </div>
          <div class="doc-view-subsections">${levelHtml}</div>
        </section>`;
    }).join('');
    const header = title
      ? `<header class="doc-view-header"><h2>${escapeHtml(title)}</h2><p>${arr.length} competencies · expand each to read its CPD ladder (Awareness → Practitioner → Advanced → Lead).</p></header>`
      : '';
    return `<div class="doc-view doc-view-competencies">${header}${cards}</div>`;
  }

  function renderSchemaAware(parsed, title) {
    if (isCompetencyArray(parsed)) {
      return renderCompetencyArray(parsed, title);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return `<pre class="json-render">${formatJsonHtml(parsed)}</pre>`;
    }
    const result = buildSchemaAwareSections(parsed);
    const remainingKeys = Object.keys(parsed).filter(k => !result.consumed.has(k));
    let rawBlock = '';
    if (remainingKeys.length) {
      const remainder = {};
      for (const k of remainingKeys) remainder[k] = parsed[k];
      const open = result.consumed.size === 0 ? ' open' : '';
      const summaryLabel = result.consumed.size === 0
        ? 'JSON contents'
        : `Raw JSON · ${remainingKeys.length} more key${remainingKeys.length === 1 ? '' : 's'}`;
      rawBlock = `
        <details class="doc-view-raw"${open}>
          <summary>${escapeHtml(summaryLabel)}</summary>
          <pre class="json-render">${formatJsonHtml(remainder)}</pre>
        </details>`;
    }
    return `<div class="doc-view">${result.html}${rawBlock}</div>`;
  }

  function renderRawJson(value) {
    return `<pre class="json-render">${formatJsonHtml(value)}</pre>`;
  }

  window.EduversalReferencesViewer = {
    renderSchemaAware,
    renderRawJson,
    injectCrossrefChips,
    escapeHtml,
  };
})();
