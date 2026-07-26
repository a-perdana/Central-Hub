// Programme Hub orchestrator.
//
// One module, eight hubs. Each programme hub HTML (/ease-growth, and the 7
// siblings to come) is a thin shell that imports this and calls
// initProgrammeHub('<programKey>') on authReady.
//
// The hub renders a stacked-section layout (the /department-workspace feel):
//   1. overview        Read-only KPI strip + PIC pills + related-tool links.
//                      For ease_growth, KPIs come from ease_test_windows
//                      (active window) + a getCountFromServer on ease_items.
//   2. documentation   department_artifacts where programKey==KEY. Versioned
//                      docs (reuses the existing artifactType/status/version
//                      shape). Add/edit stamps programKey + createdBy.
//   3. calendar        calendar_events read orderBy('date_start') then filtered
//                      programKey===KEY IN JS (no composite index). Add/edit
//                      writes the standard calendar shape + programKey.
//   4. meetings        coordinators_meetings where programKey==KEY, the SAME
//                      pool /coordinators-meetings reads. "New meeting" stamps
//                      programKey; full agenda editing links out to
//                      /coordinators-meetings.
//
// Data model note: programKey is a plain discriminator field on shared
// ecosystem collections — the rules for all four are permissive (no field
// allowlist), so writing programKey needs no rules change. Boundary discipline:
// this hub AGGREGATES + LINKS existing tools; it does NOT touch the EASE
// engine / scoring path.

import {
  collection, query, where, orderBy, onSnapshot,
  doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, setDoc, serverTimestamp, limit,
  getCountFromServer
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

import {
  PROGRAMME_LABELS, PROGRAMME_ACRONYM, PROGRAMME_TAGLINE, PROGRAMME_EMOJI,
  PROGRAMME_ACCENT, PROGRAMME_ACCENT_COLOR, PROGRAMME_PICS, PROGRAMME_LINKS,
  PROGRAMME_ES_REFS, PROGRAMME_SIBLINGS, PROGRAMME_BOUNDARY,
  isValidProgramme, programmeLabel
} from './programme-config.js';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let db = null;
let currentUser = null;
let userProfile = null;
let isAdmin = false;
let canWrite = false;      // rules gate = isDeptOfficeMember() = admin || central_user
let programKey = null;

let unsubFns = [];         // Firestore listener cleanup
let editingArtifactId = null;
let editingEventId = null;
let calendarEventsCache = [];   // full calendar_events set (client-filtered by programKey)
let notesEditing = false;       // true while the Notes Quill editor is open
let notesData = null;           // latest programme_notes/notes snapshot data

// ---------------------------------------------------------------------------
// Utilities (copied from department-core.js — the ecosystem convention is that
// each surface ships its own tiny helper set rather than sharing a util module)
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function safeUrl(url) { return /^https?:\/\//i.test(url) ? url : '#'; }

// programKey → its hub page slug. The eight hub pages are named after their
// key with underscores swapped for hyphens (verified 2026-07-26: all 8 exist).
function hubSlug(key) { return String(key || '').replace(/_/g, '-'); }

function showToast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

function clearListeners() {
  unsubFns.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
  unsubFns = [];
}

// Firestore Timestamp | Date | ISO-string → "12 Aug 2026" (en-GB per CH convention).
function fmtDate(v) {
  if (!v) return '—';
  let d = null;
  if (v && typeof v.toDate === 'function') d = v.toDate();
  else if (v instanceof Date) d = v;
  else if (typeof v === 'string') { const p = new Date(v); if (!isNaN(p)) d = p; }
  if (!d || isNaN(d)) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtRelative(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : (ts instanceof Date ? ts : null);
  if (!d) return '—';
  const diffMs = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return 'today';
  if (diffMs < 2 * day) return 'yesterday';
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// HTML allowlist sanitiser for the Notes rich text (ported from
// coordinators-meetings.html sanitiseAgendaHtml). Runs on SAVE and RENDER so
// stored HTML is always clean and no stored markup can inject script/attrs.
const NOTES_ALLOWED_TAGS = new Set([
  'P', 'BR', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'STRIKE',
  'UL', 'OL', 'LI',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'A', 'BLOCKQUOTE', 'CODE', 'PRE', 'SPAN', 'DIV',
]);
const NOTES_ALLOWED_ATTRS = {
  A: new Set(['href', 'title', 'target', 'rel']),
  '*': new Set([]),
};

function sanitiseNotesHtml(html) {
  if (!html) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html);
  (function walk(node) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType !== 1) continue;
      if (!NOTES_ALLOWED_TAGS.has(child.tagName)) {
        // Lift children up + drop the disallowed tag itself.
        while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      const okSet = NOTES_ALLOWED_ATTRS[child.tagName] || NOTES_ALLOWED_ATTRS['*'];
      for (const attr of [...child.attributes]) {
        if (!okSet.has(attr.name)) child.removeAttribute(attr.name);
      }
      if (child.tagName === 'A') {
        const href = child.getAttribute('href') || '';
        if (!/^(https?:|mailto:|\/|#)/i.test(href)) child.removeAttribute('href');
        child.setAttribute('rel', 'noopener noreferrer');
        if (/^https?:/i.test(href)) child.setAttribute('target', '_blank');
      }
      walk(child);
    }
  })(tpl.content);
  return tpl.innerHTML.trim();
}

// Is the sanitised HTML effectively empty (Quill leaves "<p><br></p>")?
function isBlankHtml(html) {
  return !html || /^(\s|<p>|<\/p>|<br\s*\/?>)*$/i.test(html);
}

// ---------------------------------------------------------------------------
// Entry point — called by <programme>-hub.html on authReady
// ---------------------------------------------------------------------------

export function initProgrammeHub(key) {
  db = window.db;
  currentUser = window.currentUser;
  userProfile = window.userProfile || {};

  if (!isValidProgramme(key)) {
    renderFatal(`Unknown programme "${key}".`);
    return;
  }
  programKey = key;

  isAdmin = userProfile.role_centralhub === 'central_admin';
  // Ecosystem write gate mirrors isDeptOfficeMember() = admin || central_user.
  // Page-access (auth-guard) is the real authorization boundary; this is a UX
  // guard on the edit affordances.
  canWrite = isAdmin || userProfile.role_centralhub === 'central_user';

  // Fill the hero identity (title/desc/accent) from config so the shell stays generic.
  paintHero();
  renderHub();
  deepLinkScroll();
}

function renderFatal(msg) {
  const host = $('hubRoot');
  if (host) host.innerHTML = `<div class="dw-empty"><div class="dw-empty-title">Could not start hub.</div><div class="dw-empty-desc">${escHtml(msg)}</div></div>`;
}

// ---------------------------------------------------------------------------
// Hero — driven by config so every hub shell is identical HTML
// ---------------------------------------------------------------------------

function paintHero() {
  const label = programmeLabel(programKey);
  const grad = PROGRAMME_ACCENT[programKey];
  const emoji = PROGRAMME_EMOJI[programKey] || '📦';
  const tagline = PROGRAMME_TAGLINE[programKey] || '';

  const titleEl = $('heroTitle');
  const descEl = $('heroDesc');
  const iconEl = $('heroIcon');
  if (titleEl) titleEl.textContent = label;
  if (descEl) descEl.textContent = PROGRAMME_ACRONYM[programKey] || '';
  if (iconEl) iconEl.textContent = emoji;

  // Info-strip body (config-driven, so every hub shell is byte-identical).
  const stripBody = $('hubStripBody');
  if (stripBody) {
    // "Which surface do I write this on?" — stated once, here. Without it the
    // same decision ends up duplicated across Notes, Documents and Meetings and
    // the three drift apart within a revision (the discipline behind
    // Common Mistake #46, applied to this hub's four content sections).
    const boundary = PROGRAMME_BOUNDARY[programKey] || '';
    stripBody.innerHTML = `The programme hub for <strong>${escHtml(label)}</strong> — a single home for its <strong>notes, documentation, calendar, and meeting records</strong>${tagline ? ` (${escHtml(tagline)})` : ''}. Meetings join the shared <a href="coordinators-meetings">Coordinators Meetings</a> pool; decisions surface on <a href="decisions-register">Decisions</a>.
      <div class="prog-strip-rule"><strong>Where things go:</strong> Notes = working thinking · Documents = the approved version · Meetings = what was discussed and who took it on.</div>
      ${boundary ? `<div class="prog-strip-boundary">${escHtml(boundary)}</div>` : ''}`;
  }

  // Footer CTA (config-driven).
  const fEyebrow = $('hubFooterEyebrow');
  if (fEyebrow) fEyebrow.textContent = `Programme Hub · ${label}`;
  const fDesc = $('hubFooterDesc');
  if (fDesc) fDesc.textContent = `Notes, documentation, calendar, and meeting records for ${label} in one place${tagline ? ` — ${tagline}` : ''}.`;

  // Thread the programme accent onto the root so any accent hook picks it up.
  const root = $('hubRoot');
  if (root && grad) root.style.setProperty('--prog-grad', grad);
  document.title = `${label} — CentralHub`;
}

// ---------------------------------------------------------------------------
// Section scaffold
// ---------------------------------------------------------------------------

function renderHub() {
  const host = $('hubRoot');
  if (!host) return;

  const pics = (PROGRAMME_PICS[programKey] || [])
    .map(n => `<span class="prog-pic">${escHtml(n)}</span>`).join('');
  const picsBlock = pics
    ? `<div class="prog-pics"><span class="prog-pics-lbl">Lead Specialists</span>${pics}</div>`
    : '';

  const LINK_EMOJI = ['✍️', '🪟', '🔎', '🗣️', '⚖️', '🔗', '📌', '⭐'];
  const links = (PROGRAMME_LINKS[programKey] || []).map((l, i) => `
    <a class="prog-link-card" data-idx="${i % 6}" href="${escHtml(l.slug)}">
      <div class="prog-link-emoji" aria-hidden="true">${LINK_EMOJI[i % LINK_EMOJI.length]}</div>
      <div class="prog-link-title">${escHtml(l.label)} <span class="prog-link-arr" aria-hidden="true">→</span></div>
      <div class="prog-link-desc">${escHtml(l.desc || '')}</div>
    </a>`).join('');
  const linksBlock = links
    ? `<div class="prog-links-lbl">Related tools</div><div class="prog-links">${links}</div>`
    : '';

  // Eduversal Academic Standards anchors. data-es-ref is auto-wired by the
  // build-injected cambridge-crossref.js into a verbatim-text popover, so the
  // madde text is never duplicated here (Common Mistake #49a).
  // data-es-ref carries the BARE madde number ("6.14"), matching the convention
  // in chip-families.html / handbook readers; the visible text keeps the "ES "
  // prefix. cambridge-crossref.js reads the attribute, not the label.
  const esRefs = (PROGRAMME_ES_REFS[programKey] || []).map(r => {
    const bare = String(r).replace(/^ES[\s:_-]*/i, '');
    return `<span class="es-pill" data-es-ref="${escHtml(bare)}" role="button" tabindex="0"
      title="Eduversal Academic Standards madde ${escHtml(bare)}">ES ${escHtml(bare)}</span>`;
  }).join('');
  const esBlock = esRefs
    ? `<div class="prog-links-lbl">Grounded in Academic Standards</div>
       <div class="prog-es-row">${esRefs}</div>`
    : '';

  // Sibling programmes — keeps the eight modules reading as one system.
  const sibs = (PROGRAMME_SIBLINGS[programKey] || []).map(k =>
    `<a class="prog-sib" href="${escHtml(hubSlug(k))}">
       <span class="prog-sib-emoji" aria-hidden="true">${PROGRAMME_EMOJI[k] || '•'}</span>
       ${escHtml(programmeLabel(k))}</a>`).join('');
  const sibsBlock = sibs
    ? `<div class="prog-links-lbl">Related programmes</div><div class="prog-sibs">${sibs}</div>`
    : '';

  host.innerHTML = `
    ${sectionShell('overview', 'Overview',
      `<span class="dw-section-mode">Live · Read-only</span>`,
      `<div class="dw-kpi-grid" id="progKpiGrid">
        <div class="dw-kpi" data-kpi="window">
          <div class="dw-kpi-ico" aria-hidden="true">🗓️</div>
          <div class="dw-kpi-val" id="kpiWindow">—</div>
          <div class="dw-kpi-semester" id="kpiWindowSemester"></div>
          <div class="dw-kpi-lbl" id="kpiWindowLbl">Active Window</div>
          <div class="dw-kpi-sub" id="kpiWindowSub">Loading…</div>
        </div>
        <div class="dw-kpi" data-kpi="items">
          <div class="dw-kpi-ico" aria-hidden="true">🧩</div>
          <div class="dw-kpi-val" id="kpiItems">—</div>
          <div class="dw-kpi-lbl">Item Bank</div>
          <div class="dw-kpi-sub">calibrated + bootstrap</div>
        </div>
        <div class="dw-kpi" data-kpi="docs">
          <div class="dw-kpi-ico" aria-hidden="true">📄</div>
          <div class="dw-kpi-val" id="kpiDocs">—</div>
          <div class="dw-kpi-lbl">Documents</div>
          <div class="dw-kpi-sub">in this hub</div>
        </div>
        <div class="dw-kpi" data-kpi="meetings">
          <div class="dw-kpi-ico" aria-hidden="true">👥</div>
          <div class="dw-kpi-val" id="kpiMeetings">—</div>
          <div class="dw-kpi-lbl">Meetings</div>
          <div class="dw-kpi-sub">logged for this programme</div>
        </div>
      </div>
      ${picsBlock}
      <div id="progActions" class="prog-actions-slot"></div>
      ${linksBlock}
      ${esBlock}
      ${sibsBlock}`)}

    ${sectionShell('notes', 'Notes',
      `<span class="dw-section-mode">Rich text · Shared pad</span>`,
      `<div id="progNotes" class="dw-notes-slot"><div class="dw-loading">Loading…</div></div>`)}

    ${sectionShell('documentation', 'Documentation',
      `<div class="dw-section-actions">
        <span class="dw-section-mode">Versioned · Artifacts</span>
        ${canWrite ? `<button class="btn-add prog-add" type="button" id="btnAddDoc">+ Add document</button>` : ''}
      </div>`,
      `<div id="progDocs" class="prog-slot"><div class="dw-loading">Loading…</div></div>`)}

    ${sectionShell('calendar', 'Calendar',
      `<div class="dw-section-actions">
        <span class="dw-section-mode">Programme events</span>
        ${canWrite ? `<button class="btn-add prog-add" type="button" id="btnAddEvent">+ Add event</button>` : ''}
      </div>`,
      `<div id="progCalendar" class="prog-slot"><div class="dw-loading">Loading…</div></div>`)}

    ${sectionShell('meetings', 'Meeting Records',
      `<div class="dw-section-actions">
        <span class="dw-section-mode">Shared pool · Coordinators Meetings</span>
        ${canWrite ? `<button class="btn-add prog-add" type="button" id="btnAddMeeting">+ New meeting</button>` : ''}
      </div>`,
      `<div id="progMeetings" class="prog-slot"><div class="dw-loading">Loading…</div></div>`)}
  `;

  // Wire collapsible toggles (localStorage-persisted per section).
  wireCollapse(host);

  // Wire add buttons via delegation on hubRoot so it survives any section
  // re-render and never depends on the buttons existing at wire-time.
  if (canWrite) {
    host.addEventListener('click', (e) => {
      const btn = e.target.closest('#btnAddDoc, #btnAddEvent, #btnAddMeeting');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (btn.id === 'btnAddDoc') openDocModal(null);
      else if (btn.id === 'btnAddEvent') openEventModal(null);
      else if (btn.id === 'btnAddMeeting') createMeeting();
    });
  }

  // Bind data
  bindOverviewKpi();
  bindOpenActions();
  bindNotes();
  bindDocs();
  bindCalendar();
  bindMeetings();
}

// Per-section emoji icon — colour comes from CSS keyed on [data-section].
const SECTION_ICON = {
  overview: '📊',
  notes: '📝',
  documentation: '📄',
  calendar: '📅',
  meetings: '👥',
};

// Collapsible section shell — chevron + clickable title (left cluster) collapse
// the .dw-section-body; header actions stay in the right cluster. Default open;
// per-section collapsed state persisted in localStorage. Each section carries
// a colour identity via [data-section] (styled in ease-growth.html).
function sectionShell(key, title, headRight, bodyHtml) {
  const collapsed = getCollapsed(key);
  const icon = SECTION_ICON[key] || '•';
  // Count badge — filled by setSectionCount() once each bind resolves. Without
  // it a collapsed section says nothing: 0 documents and 40 documents look
  // identical until you expand. Starts blank (not "0") so it never flashes a
  // wrong zero while loading.
  const countBadge = COUNTED_SECTIONS.has(key)
    ? `<span class="dw-section-count" id="secCount-${key}" aria-hidden="true"></span>` : '';
  return `
    <section class="dw-section${collapsed ? ' is-collapsed' : ''}" data-section="${key}" aria-label="${escHtml(title)}">
      <div class="dw-section-head">
        <div class="dw-section-head-left" role="button" tabindex="0" data-collapse-toggle="${key}"
             aria-expanded="${collapsed ? 'false' : 'true'}">
          <svg class="dw-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span class="dw-section-icon" aria-hidden="true">${icon}</span>
          <h3 class="dw-section-title">${escHtml(title)}</h3>
          ${countBadge}
        </div>
        ${headRight || ''}
      </div>
      <div class="dw-section-body">${bodyHtml}</div>
    </section>`;
}

// Sections whose head carries a live count badge.
const COUNTED_SECTIONS = new Set(['documentation', 'calendar', 'meetings']);

// Write a section's count badge and mark the section empty (dimmed head) when
// it holds nothing — so the eye goes to the sections that have content.
function setSectionCount(key, n) {
  const el = $(`secCount-${key}`);
  if (el) el.textContent = String(n);
  const sec = document.querySelector(`.dw-section[data-section="${key}"]`);
  if (sec) sec.classList.toggle('is-empty', Number(n) === 0);
}

function collapseKey(key) { return `progHub:collapsed:${programKey}:${key}`; }

function getCollapsed(key) {
  // Overview is the page's only self-explaining section — the active window,
  // participation and related tools all live there. It always opens; a stored
  // "collapsed" from an earlier visit would otherwise leave the hub looking
  // completely empty on arrival.
  if (key === 'overview') return false;
  try { return localStorage.getItem(collapseKey(key)) === '1'; }
  catch (e) { return false; }  // default open
}

function setCollapsed(key, val) {
  try {
    if (val) localStorage.setItem(collapseKey(key), '1');
    else localStorage.removeItem(collapseKey(key));
  } catch (e) { /* ignore */ }
}

function wireCollapse(host) {
  host.querySelectorAll('[data-collapse-toggle]').forEach(toggle => {
    const key = toggle.dataset.collapseToggle;
    const section = toggle.closest('.dw-section');
    const apply = () => {
      const collapsed = section.classList.toggle('is-collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      setCollapsed(key, collapsed);
    };
    toggle.addEventListener('click', apply);
    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
    });
  });
}

function deepLinkScroll() {
  const targetHash = window.location.hash.replace(/^#/, '');
  if (!targetHash) return;
  setTimeout(() => {
    const target = document.querySelector(`[data-section="${CSS.escape(targetHash)}"]`);
    if (!target) return;
    // A deep-linked section should be open even if the user collapsed it before.
    if (target.classList.contains('is-collapsed')) {
      target.classList.remove('is-collapsed');
      const toggle = target.querySelector('[data-collapse-toggle]');
      if (toggle) toggle.setAttribute('aria-expanded', 'true');
      setCollapsed(target.dataset.section, false);
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 140);
}

// ---------------------------------------------------------------------------
// Section: Overview KPIs (read-only)
// ---------------------------------------------------------------------------

// 'term1' → 'Term 1'; legacy 'fall'/'winter'/'spring' → 'Fall' etc. Mirrors
// windowLabel() in /ease-window-admin so the two surfaces read identically.
function windowTermLabel(raw) {
  const s = String(raw || '').replace(/_/g, ' ').trim();
  const m = /^term\s*([123])$/i.exec(s);
  if (m) return `Term ${m[1]}`;
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// The academic period (semester + year) is network-wide — it comes from
// calendar_settings/current, NOT from any programme's own collection — so every
// hub shows it. Only the top "Term N" line is EASE-window-specific.
function renderPeriodKpi({ termLine, subLine, muted }) {
  const sem = (typeof window.getCurrentSemester === 'function')
    ? window.getCurrentSemester() : null;
  const ay = (typeof window.getCurrentAcademicYear === 'function')
    ? window.getCurrentAcademicYear() : '';

  // Big line: the EASE term when there is one, else fall back to the semester so
  // the tile still leads with something meaningful on non-EASE hubs.
  const big = termLine || (sem ? sem.label : '—');
  setText('kpiWindow', big);

  // A hub with no test window isn't showing a "window" — label it honestly.
  setText('kpiWindowLbl', termLine ? 'Active Window' : 'Academic Period');

  // Second line: semester — suppressed when it would just repeat the big line.
  const semText = sem ? sem.label : '';
  setText('kpiWindowSemester', semText && semText !== big ? semText : '');

  const sub = subLine || (ay ? `AY ${ay}` : 'no academic year set');
  setText('kpiWindowSub', sub);

  const el = $('kpiWindow');
  if (el) el.classList.toggle('dw-kpi-val--muted', !!muted);

  // Mirror into the hero so the page answers "which period are we in?" before
  // the reader expands anything. The hero tile stacks term + semester on one
  // line because it has no third row.
  const heroBig = (termLine && semText && semText !== termLine)
    ? `${termLine} · ${semText}` : big;
  setText('heroKpiPeriod', heroBig);
  setText('heroKpiPeriodLbl', termLine ? 'Active Window' : 'Academic Period');
  setText('heroKpiPeriodSub', sub);
  const hk = $('heroKpis');
  if (hk) hk.hidden = false;
}

// Reveal a hero KPI tile and fill it. Tiles stay hidden until their query
// resolves — an empty tile is worse than no tile.
function setHeroKpi(wrapId, numId, subId, num, sub) {
  const w = $(wrapId);
  if (w) w.hidden = false;
  setText(numId, num);
  if (subId) setText(subId, sub || '');
}

async function bindOverviewKpi() {
  // Active EASE window — the term line is ease_growth-only; the semester + AY
  // lines below it are network-wide and render on every programme hub.
  if (programKey === 'ease_growth') {
    try {
      const wq = query(
        collection(db, 'ease_test_windows'),
        where('status', '==', 'open'),
        limit(1)
      );
      const wsnap = await getDocs(wq);
      if (!wsnap.empty) {
        const w = wsnap.docs[0].data();
        const winLabel = w.window || w.windowLabel || wsnap.docs[0].id;
        renderPeriodKpi({
          termLine: windowTermLabel(winLabel),
          subLine: w.academicYear ? `AY ${w.academicYear}` : 'open now',
        });
        // Operational reach of the OPEN window — the questions a programme lead
        // actually arrives with. Fire-and-forget: never blocks the KPI strip.
        bindWindowReach(wsnap.docs[0].id, w);
      } else {
        renderPeriodKpi({ termLine: 'No open window', muted: true });
      }
    } catch (e) {
      renderPeriodKpi({ termLine: '—', muted: true });
    }

    // Item bank size — count query (cheap, no full read).
    try {
      const c = await getCountFromServer(
        query(collection(db, 'ease_items'), where('source', '==', 'latihan'))
      );
      const n = c.data().count;
      // Add HQ-authored on top if the count is small enough to matter; keep it simple:
      setText('kpiItems', n.toLocaleString('en-GB'));
    } catch (e) {
      setText('kpiItems', '—');
    }
  } else {
    // Non-EASE hubs have no test window, but the academic period still applies
    // to them — show semester + AY rather than a dead "—".
    renderPeriodKpi({});
    setText('kpiItems', '—');
  }
  // Docs + Meetings counts are filled by their own binds (bindDocs/bindMeetings).
}

// Open actions — who owes what, by when. A programme hub that lists documents
// but not commitments is an archive, not a management surface.
//
// Reads activity_tasks tagged with this programKey (the same discriminator
// pattern department_artifacts / coordinators_meetings / calendar_events
// already use). No task carries programKey yet — tagging happens in
// /activities — so the panel currently renders its empty state and starts
// filling itself the moment a task is tagged. Deliberately NOT a new
// collection: /activities stays the single place tasks are managed.
const TASK_OPEN_STATUSES = ['todo', 'in_progress', 'under_review'];

function bindOpenActions() {
  const slot = $('progActions');
  if (!slot) return;
  const qy = query(collection(db, 'activity_tasks'), where('programKey', '==', programKey), limit(50));
  const unsub = onSnapshot(qy, (snap) => {
    const open = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(t => TASK_OPEN_STATUSES.includes(t.status));
    if (!open.length) {
      slot.innerHTML = `
        <div class="prog-links-lbl">Open actions</div>
        <div class="prog-actions-empty">
          No open actions tagged to this programme.
          <a href="activities">Open Activities →</a>
        </div>`;
      return;
    }
    // Soonest due first; undated last.
    open.sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
    const todayIso = new Date().toISOString().slice(0, 10);
    slot.innerHTML = `
      <div class="prog-links-lbl">Open actions <span class="prog-actions-count">${open.length}</span></div>
      <div class="prog-actions">
        ${open.slice(0, 6).map(t => {
          const overdue = t.dueDate && String(t.dueDate) < todayIso;
          const who = Array.isArray(t.assignees) && t.assignees.length
            ? t.assignees.join(', ') : (t.assignee || 'Unassigned');
          return `
            <a class="prog-action" href="activities">
              <span class="prog-action-dot" data-st="${escHtml(t.status || '')}" aria-hidden="true"></span>
              <span class="prog-action-name">${escHtml(t.name || t.title || 'Untitled task')}</span>
              <span class="prog-action-who">${escHtml(who)}</span>
              <span class="prog-action-due${overdue ? ' is-overdue' : ''}">${escHtml(t.dueDate || '—')}</span>
            </a>`;
        }).join('')}
      </div>
      ${open.length > 6 ? `<a class="prog-actions-more" href="activities">View all ${open.length} in Activities →</a>` : ''}`;
  }, (err) => {
    console.warn('[bindOpenActions]', err);
    slot.innerHTML = '';   // non-fatal: the panel simply doesn't render
  });
  unsubFns.push(unsub);
}

// Operational reach of the currently-open EASE window: how many active students
// have actually sat it, how many schools have started, and how long is left.
//
// Reads ease_sessions filtered by windowId (== the ease_test_windows doc id) —
// sessions carry studentUid + schoolId, so participation and school coverage
// both come from the one query. Counted in JS off a capped read rather than a
// per-school count query, so cost stays flat as the network grows.
//
// Deliberately honest about small denominators: with a handful of active
// students a percentage is noise, so the tile shows the raw ratio instead.
async function bindWindowReach(windowId, win) {
  // 1. Time left in the window — pure date maths, no read needed.
  try {
    const closes = win?.closesAt?.toDate ? win.closesAt.toDate() : null;
    if (closes) {
      const days = Math.ceil((closes.getTime() - Date.now()) / 86400000);
      const dateStr = closes.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      let big, sub;
      if (days < 0)       { big = 'Overdue';           sub = `closed ${dateStr}`; }
      else if (days === 0){ big = 'Today';             sub = dateStr; }
      else if (days < 21) { big = `${days}d`;          sub = dateStr; }
      else                { big = `${Math.round(days / 7)}w`; sub = dateStr; }
      setHeroKpi('heroKpiClosesWrap', 'heroKpiCloses', 'heroKpiClosesSub', big, sub);
    }
  } catch (e) { /* non-fatal — the tile just stays hidden */ }

  // 2. Participation + school coverage.
  try {
    // `students` list/count is admin-only at the rule level (isAdmin() ||
    // isAHAdmin() || isTHAdmin() || AH leadership) — a plain CH director or
    // coordinator cannot read it. Only ask when we know it can succeed;
    // otherwise the tile drops the denominator instead of throwing.
    const canCountStudents = isAdmin;
    const [sesSnap, studentCount, schoolSnap] = await Promise.all([
      getDocs(query(collection(db, 'ease_sessions'), where('windowId', '==', windowId), limit(3000))),
      canCountStudents
        ? getCountFromServer(query(collection(db, 'students'), where('status', '==', 'active')))
            .then(c => c.data().count).catch(() => null)
        : Promise.resolve(null),
      getDocs(query(collection(db, 'partner_schools'), limit(60))).catch(() => null),
    ]);

    const students = new Set();
    const schools = new Set();
    sesSnap.forEach(d => {
      const s = d.data();
      if (s.studentUid) students.add(s.studentUid);
      if (s.schoolId) schools.add(s.schoolId);
    });

    // partner_schools includes the HQ pseudo-school — not a delivery site.
    const totalSchools = schoolSnap
      ? schoolSnap.docs.filter(d => d.id !== 'eduversal_hq').length : null;

    const sat = students.size;
    if (studentCount && studentCount >= 25) {
      const pct = Math.round((sat / studentCount) * 100);
      setHeroKpi('heroKpiReachWrap', 'heroKpiReach', 'heroKpiReachSub',
        `${pct}%`, `${sat.toLocaleString('en-GB')} of ${studentCount.toLocaleString('en-GB')} students`);
    } else {
      // Too few students for a percentage to mean anything — show the ratio.
      setHeroKpi('heroKpiReachWrap', 'heroKpiReach', 'heroKpiReachSub',
        String(sat), studentCount != null ? `of ${studentCount} active students` : 'students sat this window');
    }

    if (totalSchools) {
      const notStarted = Math.max(0, totalSchools - schools.size);
      setHeroKpi('heroKpiSchoolsWrap', 'heroKpiSchools', 'heroKpiSchoolsSub',
        `${schools.size} / ${totalSchools}`,
        notStarted ? `${notStarted} not started` : 'all schools started');
    }
  } catch (e) {
    console.warn('[bindWindowReach]', e);
  }
}

function setText(id, txt) { const el = $(id); if (el) el.textContent = txt; }

// ---------------------------------------------------------------------------
// Section: Notes — free-text G-Docs-style pad.
// programme_notes/{programKey}/sections/notes, contentMd. Mirrors the
// department-workspace Discussion Topics pattern but on a permissive
// (admin || central_user) collection so coordinators can write too.
// ---------------------------------------------------------------------------

function bindNotes() {
  const slot = $('progNotes');
  if (!slot) return;
  const ref = doc(db, 'programme_notes', programKey, 'sections', 'notes');
  const unsub = onSnapshot(ref, (snap) => {
    notesData = snap.exists() ? snap.data() : null;
    // While the editor is open, don't clobber the in-progress edit — the
    // save path re-renders explicitly on success. Only live-refresh the
    // read view.
    if (!notesEditing) renderNotesRead(slot, ref, notesData);
  }, (err) => {
    console.warn('[bindNotes]', err);
    slot.innerHTML = `<div class="dw-empty">Could not load notes (${escHtml(err.code || err.message || 'error')}).</div>`;
  });
  unsubFns.push(unsub);
}

// Read view: rendered rich HTML (sanitised) with an Edit affordance for writers.
function renderNotesRead(slot, ref, data) {
  const rawHtml = data?.contentHtml || '';
  const cleanHtml = sanitiseNotesHtml(rawHtml);
  const plain = data?.contentMd || '';
  const lastEdit = data?.lastEditedAt ? fmtRelative(data.lastEditedAt) : null;
  const lastBy = data?.lastEditedByName ? escHtml(data.lastEditedByName) : '';
  const hasContent = !isBlankHtml(cleanHtml) || !!plain;

  // Body: prefer sanitised rich HTML; fall back to plain text (legacy /
  // pre-rich saves) rendered with line breaks preserved.
  const bodyHtml = !isBlankHtml(cleanHtml)
    ? `<div class="dw-notes-rich">${cleanHtml}</div>`
    : (plain ? `<div class="dw-notes-body">${escHtml(plain)}</div>` : '');

  slot.innerHTML = `
    <div class="dw-notes-readonly">
      ${hasContent
        ? bodyHtml
        : `<div class="dw-empty"><div class="dw-empty-title">No notes yet.</div><div class="dw-empty-desc">${canWrite ? 'Use “Edit” to start the programme’s running notes — rich text, links, lists.' : 'Programme notes will appear here once added.'}</div></div>`}
      <div class="dw-notes-foot">
        <div class="dw-notes-meta">${lastEdit ? `Last edit ${lastEdit}${lastBy ? ` · by ${lastBy}` : ''}` : (canWrite ? 'Not saved yet' : '')}</div>
        ${canWrite ? `<div class="dw-notes-actions"><button class="dw-btn-primary" id="progNotesEdit" type="button">${hasContent ? 'Edit' : 'Add notes'}</button></div>` : ''}
      </div>
    </div>`;

  if (canWrite) {
    const btn = $('progNotesEdit');
    if (btn) btn.addEventListener('click', () => renderNotesEdit(slot, ref, data));
  }
}

// Edit view: Quill rich editor + Save / Cancel.
function renderNotesEdit(slot, ref, data) {
  notesEditing = true;
  const seedHtml = sanitiseNotesHtml(data?.contentHtml || '') || (data?.contentMd ? `<p>${escHtml(data.contentMd).replace(/\n/g, '<br>')}</p>` : '');

  slot.innerHTML = `
    <div class="dw-notes-editor">
      <div class="dw-notes-quill" id="progNotesQuill"></div>
      <div class="dw-notes-foot">
        <div class="dw-notes-meta">Rich text — bold, lists, links. Saved to everyone on this hub.</div>
        <div class="dw-notes-actions">
          <button class="dw-btn-secondary" id="progNotesCancel" type="button">Cancel</button>
          <button class="dw-btn-primary" id="progNotesSave" type="button">Save notes</button>
        </div>
      </div>
    </div>`;

  const mount = $('progNotesQuill');
  let quill = null;
  let fallbackTa = null;

  if (typeof Quill !== 'undefined') {
    quill = new Quill(mount, {
      theme: 'snow',
      placeholder: 'Working notes for this programme — running list, agenda seeds, reminders…',
      modules: {
        toolbar: [
          [{ header: [2, 3, false] }],
          ['bold', 'italic', 'underline'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link', 'blockquote', 'code-block'],
          ['clean'],
        ],
      },
    });
    if (seedHtml) quill.clipboard.dangerouslyPasteHTML(seedHtml);
    quill.focus();
    quill.setSelection(quill.getLength(), 0);
  } else {
    // CDN failed — degrade to a plain textarea so notes still work.
    mount.innerHTML = `<textarea class="dw-notes-textarea" id="progNotesFallback" rows="8">${escHtml(data?.contentMd || '')}</textarea>`;
    fallbackTa = $('progNotesFallback');
  }

  const finish = () => { notesEditing = false; renderNotesRead(slot, ref, notesData); };
  $('progNotesCancel').addEventListener('click', finish);

  $('progNotesSave').addEventListener('click', async () => {
    const btnSave = $('progNotesSave');
    let cleanHtml, plain;
    if (quill) {
      cleanHtml = sanitiseNotesHtml(quill.root.innerHTML);
      plain = quill.getText().replace(/\n+$/, '');
    } else {
      plain = fallbackTa ? fallbackTa.value : '';
      cleanHtml = plain ? `<p>${escHtml(plain).replace(/\n/g, '<br>')}</p>` : '';
    }
    btnSave.disabled = true;
    btnSave.textContent = 'Saving…';
    try {
      await setDoc(ref, {
        programKey,
        sectionId: 'notes',
        contentHtml: cleanHtml,
        contentMd: plain,
        lastEditedBy: currentUser.uid,
        lastEditedByName: userProfile.displayName || currentUser.email || 'Unknown',
        lastEditedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      showToast('Notes saved.');
      notesEditing = false;
      renderNotesRead(slot, ref, { ...(notesData || {}), contentHtml: cleanHtml, contentMd: plain });
    } catch (err) {
      console.warn('[notes save]', err);
      showToast('Save failed: ' + (err.code || err.message || 'error'));
      btnSave.disabled = false;
      btnSave.textContent = 'Save notes';
    }
  });
}

// ---------------------------------------------------------------------------
// Section: Documentation — department_artifacts where programKey==KEY
// ---------------------------------------------------------------------------

function bindDocs() {
  const slot = $('progDocs');
  if (!slot) return;
  const qy = query(
    collection(db, 'department_artifacts'),
    where('programKey', '==', programKey),
    limit(100)
  );
  const unsub = onSnapshot(qy, (snap) => {
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(d => (d.status || 'current') !== 'archived')
      .sort((a, b) => tsMillis(b.updatedAt) - tsMillis(a.updatedAt));
    setText('kpiDocs', String(docs.length));
    setSectionCount('documentation', docs.length);
    if (!docs.length) {
      slot.innerHTML = `<div class="dw-empty"><div class="dw-empty-title">No documents yet.</div><div class="dw-empty-desc">${canWrite ? 'Use “+ Add document” to attach a policy, plan, or report to this programme.' : 'Programme documents will appear here once added.'}</div></div>`;
      return;
    }
    slot.innerHTML = docs.map(renderDocRow).join('');
    // Wire per-row actions
    if (canWrite) {
      slot.querySelectorAll('[data-edit-doc]').forEach(b =>
        b.addEventListener('click', () => openDocModal(b.dataset.editDoc)));
      slot.querySelectorAll('[data-del-doc]').forEach(b =>
        b.addEventListener('click', () => deleteDocConfirm(b)));
    }
  }, (err) => {
    console.error('[bindDocs]', err);
    slot.innerHTML = `<div class="dw-empty"><div class="dw-empty-title">Could not load documents.</div><div class="dw-empty-desc">${escHtml(err.code || err.message)}</div></div>`;
  });
  unsubFns.push(unsub);
}

function renderDocRow(d) {
  const link = d.externalUrl || d.fileUrl;
  const openBtn = link
    ? `<a class="prog-row-open" href="${safeUrl(link)}" target="_blank" rel="noopener">Open ↗</a>`
    : '';
  const ver = d.version ? `<span class="prog-chip">v${escHtml(String(d.version))}</span>` : '';
  const type = d.artifactType ? `<span class="prog-chip">${escHtml(String(d.artifactType).replace(/_/g, ' '))}</span>` : '';
  const yr = d.academicYear ? `<span class="prog-chip">${escHtml(d.academicYear)}</span>` : '';
  const actions = canWrite
    ? `<div class="prog-row-actions">
         <button class="prog-row-btn" type="button" data-edit-doc="${escHtml(d.id)}">Edit</button>
         <button class="prog-row-btn prog-row-btn--danger" type="button" data-del-doc="${escHtml(d.id)}" data-confirming="0">Delete</button>
       </div>`
    : '';
  return `
    <div class="prog-row">
      <div class="prog-row-main">
        <div class="prog-row-title">${escHtml(d.title || 'Untitled')} ${openBtn}</div>
        <div class="prog-row-meta">${type}${yr}${ver}<span class="prog-row-date">updated ${escHtml(fmtRelative(d.updatedAt))}</span></div>
        ${d.description ? `<div class="prog-row-desc">${escHtml(d.description)}</div>` : ''}
      </div>
      ${actions}
    </div>`;
}

async function deleteDocConfirm(btn) {
  // Double-click confirm (no alert/confirm — Common Mistake #3).
  if (btn.dataset.confirming === '1') {
    try {
      await deleteDoc(doc(db, 'department_artifacts', btn.dataset.delDoc));
      showToast('Document deleted.');
    } catch (err) { showToast(`Delete failed: ${err.code || err.message}`); }
    return;
  }
  btn.dataset.confirming = '1';
  btn.textContent = 'Confirm?';
  setTimeout(() => { btn.dataset.confirming = '0'; btn.textContent = 'Delete'; }, 3000);
}

// ---------------------------------------------------------------------------
// Section: Calendar — calendar_events, filtered programKey in JS
// ---------------------------------------------------------------------------

function bindCalendar() {
  const slot = $('progCalendar');
  if (!slot) return;
  // Read the whole collection ordered by date_start (existing index) then filter
  // programKey in JS — matches how weekly-checklist reads calendar_events and
  // avoids needing a composite index.
  const qy = query(collection(db, 'calendar_events'), orderBy('date_start'), limit(500));
  const unsub = onSnapshot(qy, (snap) => {
    calendarEventsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const evts = calendarEventsCache.filter(e => e.programKey === programKey);
    setSectionCount('calendar', evts.length);
    if (!evts.length) {
      slot.innerHTML = `<div class="dw-empty"><div class="dw-empty-title">No programme events yet.</div><div class="dw-empty-desc">${canWrite ? 'Use “+ Add event” to put window openings, review days, or deadlines on this programme’s calendar.' : 'Programme calendar events will appear here once added.'}</div></div>`;
      return;
    }
    slot.innerHTML = evts.map(renderEventRow).join('');
    if (canWrite) {
      slot.querySelectorAll('[data-edit-evt]').forEach(b =>
        b.addEventListener('click', () => openEventModal(b.dataset.editEvt)));
      slot.querySelectorAll('[data-del-evt]').forEach(b =>
        b.addEventListener('click', () => deleteEventConfirm(b)));
    }
  }, (err) => {
    console.error('[bindCalendar]', err);
    slot.innerHTML = `<div class="dw-empty"><div class="dw-empty-title">Could not load calendar.</div><div class="dw-empty-desc">${escHtml(err.code || err.message)}</div></div>`;
  });
  unsubFns.push(unsub);
}

function renderEventRow(e) {
  const range = e.date_end && e.date_end !== e.date_start
    ? `${fmtDate(e.date_start)} → ${fmtDate(e.date_end)}`
    : fmtDate(e.date_start);
  const cat = e.category ? `<span class="prog-chip">${escHtml(e.category)}</span>` : '';
  const actions = canWrite
    ? `<div class="prog-row-actions">
         <button class="prog-row-btn" type="button" data-edit-evt="${escHtml(e.id)}">Edit</button>
         <button class="prog-row-btn prog-row-btn--danger" type="button" data-del-evt="${escHtml(e.id)}" data-confirming="0">Delete</button>
       </div>`
    : '';
  return `
    <div class="prog-row">
      <div class="prog-row-main">
        <div class="prog-row-title">${escHtml(e.title || 'Untitled event')}</div>
        <div class="prog-row-meta">${cat}<span class="prog-row-date">${escHtml(range)}</span></div>
        ${e.description ? `<div class="prog-row-desc">${escHtml(e.description)}</div>` : ''}
      </div>
      ${actions}
    </div>`;
}

async function deleteEventConfirm(btn) {
  if (btn.dataset.confirming === '1') {
    try {
      await deleteDoc(doc(db, 'calendar_events', btn.dataset.delEvt));
      showToast('Event deleted.');
    } catch (err) { showToast(`Delete failed: ${err.code || err.message}`); }
    return;
  }
  btn.dataset.confirming = '1';
  btn.textContent = 'Confirm?';
  setTimeout(() => { btn.dataset.confirming = '0'; btn.textContent = 'Delete'; }, 3000);
}

// ---------------------------------------------------------------------------
// Section: Meetings — coordinators_meetings where programKey==KEY
// ---------------------------------------------------------------------------

function bindMeetings() {
  const slot = $('progMeetings');
  if (!slot) return;
  const qy = query(
    collection(db, 'coordinators_meetings'),
    where('programKey', '==', programKey),
    limit(100)
  );
  const unsub = onSnapshot(qy, (snap) => {
    const mtgs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => tsMillis(b.meetingDate) - tsMillis(a.meetingDate));
    setText('kpiMeetings', String(mtgs.length));
    setSectionCount('meetings', mtgs.length);
    if (!mtgs.length) {
      slot.innerHTML = `<div class="dw-empty"><div class="dw-empty-title">No meetings logged yet.</div><div class="dw-empty-desc">${canWrite ? 'Use “+ New meeting” to open a record for this programme — it joins the shared Coordinators Meetings pool.' : 'Programme meeting records will appear here once logged.'}</div></div>`;
      return;
    }
    slot.innerHTML = mtgs.map(renderMeetingRow).join('');
  }, (err) => {
    console.error('[bindMeetings]', err);
    slot.innerHTML = `<div class="dw-empty"><div class="dw-empty-title">Could not load meetings.</div><div class="dw-empty-desc">${escHtml(err.code || err.message)}</div></div>`;
  });
  unsubFns.push(unsub);
}

function renderMeetingRow(m) {
  const status = m.status ? `<span class="prog-chip prog-chip--${escHtml(m.status)}">${escHtml(m.status)}</span>` : '';
  const attendees = Array.isArray(m.attendees) ? `${m.attendees.length} attendee${m.attendees.length === 1 ? '' : 's'}` : '';
  return `
    <div class="prog-row">
      <div class="prog-row-main">
        <div class="prog-row-title">${escHtml(m.title || 'Meeting')}</div>
        <div class="prog-row-meta">${status}<span class="prog-row-date">${escHtml(fmtDate(m.meetingDate))}</span>${attendees ? `<span class="prog-chip">${escHtml(attendees)}</span>` : ''}</div>
        ${m.summary ? `<div class="prog-row-desc">${escHtml(m.summary)}</div>` : ''}
      </div>
      <div class="prog-row-actions">
        <a class="prog-row-open" href="coordinators-meetings" title="Open the full meeting editor">Open editor ↗</a>
      </div>
    </div>`;
}

// New meeting — stamps programKey, joins the shared coordinators_meetings pool,
// then sends the user to the full editor for agenda-item depth.
async function createMeeting() {
  if (!canWrite) return;
  const today = new Date();
  const year = (window.getCurrentAcademicYear && window.getCurrentAcademicYear())
    || (today.getMonth() >= 6 ? `${today.getFullYear()}-${today.getFullYear() + 1}` : `${today.getFullYear() - 1}-${today.getFullYear()}`);
  const semester = today.getMonth() >= 6 && today.getMonth() <= 11 ? 'sem1' : 'sem2';
  const label = programmeLabel(programKey);
  try {
    await addDoc(collection(db, 'coordinators_meetings'), {
      title: `${label} Meeting · ${today.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
      meetingDate: today,
      academicYear: year,
      semester,
      meetingType: 'hq_internal',
      programKey,                       // <-- the shared-pool discriminator
      status: 'draft',
      summary: '',
      attendees: [{ uid: currentUser.uid, name: userProfile.displayName || currentUser.email, present: true }],
      createdBy: currentUser.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastEditedBy: currentUser.uid,
    });
    showToast('Meeting created — opening full editor…');
    setTimeout(() => { window.location.href = 'coordinators-meetings'; }, 700);
  } catch (err) {
    console.error('[createMeeting]', err);
    showToast(`Could not create: ${err.code || err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Modals — Documentation + Calendar (built on shared-styles .modal-*/.form-*)
// ---------------------------------------------------------------------------

function ensureModalHost() {
  let host = $('progModalHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'progModalHost';
    document.body.appendChild(host);
  }
  return host;
}

function closeModal() {
  const host = $('progModalHost');
  if (host) host.innerHTML = '';
  editingArtifactId = null;
  editingEventId = null;
}

// --- Documentation modal ---
async function openDocModal(id) {
  editingArtifactId = id || null;
  let d = { title: '', artifactType: 'subject_policy', academicYear: '', externalUrl: '', description: '' };
  if (id) {
    try {
      const snap = await getDoc(doc(db, 'department_artifacts', id));
      if (snap.exists()) d = { ...d, ...snap.data() };
    } catch (e) { /* fall through with blank */ }
  }
  const host = ensureModalHost();
  host.innerHTML = `
    <div class="modal-overlay open" id="docOverlay">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Document">
        <div class="modal-head">
          <span>${id ? 'Edit document' : 'Add document'}</span>
          <button class="modal-close" type="button" id="docClose" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="modal-error" id="docErr"></div>
          <div class="form-group">
            <label class="form-label" for="docTitle">Title</label>
            <input class="form-input" id="docTitle" value="${escHtml(d.title)}" placeholder="e.g. EASE Growth Blueprint 2026" />
          </div>
          <div class="form-group">
            <label class="form-label" for="docType">Type</label>
            <select class="form-select" id="docType">
              ${['annual_plan', 'subject_policy', 'department_handbook', 'dtp_report', 'blueprint', 'guide', 'report', 'other']
                .map(t => `<option value="${t}"${d.artifactType === t ? ' selected' : ''}>${t.replace(/_/g, ' ')}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="docYear">Academic year <span class="form-hint">optional</span></label>
            <input class="form-input" id="docYear" value="${escHtml(d.academicYear || '')}" placeholder="2026-2027" />
          </div>
          <div class="form-group">
            <label class="form-label" for="docUrl">Link <span class="form-hint">https:// — Drive, doc, or page</span></label>
            <input class="form-input" id="docUrl" value="${escHtml(d.externalUrl || '')}" placeholder="https://…" />
          </div>
          <div class="form-group">
            <label class="form-label" for="docDesc">Description <span class="form-hint">optional</span></label>
            <textarea class="form-textarea" id="docDesc" rows="3" placeholder="One line on what this document covers.">${escHtml(d.description || '')}</textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" type="button" id="docCancel">Cancel</button>
          <button class="btn-save" type="button" id="docSave">${id ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </div>`;
  const close = () => closeModal();
  $('docClose').addEventListener('click', close);
  $('docCancel').addEventListener('click', close);
  $('docOverlay').addEventListener('click', (e) => { if (e.target.id === 'docOverlay') close(); });
  $('docSave').addEventListener('click', saveDoc);
}

async function saveDoc() {
  const title = $('docTitle').value.trim();
  const artifactType = $('docType').value;
  const academicYear = $('docYear').value.trim();
  const externalUrl = $('docUrl').value.trim();
  const description = $('docDesc').value.trim();
  const err = $('docErr');
  if (!title) { err.textContent = 'Title is required.'; err.classList.add('visible'); return; }
  if (externalUrl && !/^https?:\/\//i.test(externalUrl)) {
    err.textContent = 'Link must start with http:// or https://'; err.classList.add('visible'); return;
  }
  const base = {
    programKey,
    subjectId: null,           // programme-scoped, not subject-scoped
    artifactType, title, academicYear, description,
    externalUrl,
    status: 'current',
    lastEditedBy: currentUser.uid,
    updatedAt: serverTimestamp(),
  };
  try {
    if (editingArtifactId) {
      await updateDoc(doc(db, 'department_artifacts', editingArtifactId), base);
      showToast('Document updated.');
    } else {
      base.version = 1;
      base.ownerUid = currentUser.uid;
      base.createdBy = currentUser.uid;
      base.createdAt = serverTimestamp();
      await addDoc(collection(db, 'department_artifacts'), base);
      showToast('Document added.');
    }
    closeModal();
  } catch (e) {
    console.error('[saveDoc]', e);
    err.textContent = `Save failed: ${e.code || e.message}`; err.classList.add('visible');
  }
}

// --- Calendar event modal ---
async function openEventModal(id) {
  editingEventId = id || null;
  let e = { title: '', category: 'Assessment', date_start: todayISO(), date_end: '', description: '' };
  if (id) {
    const found = calendarEventsCache.find(x => x.id === id);
    if (found) e = { ...e, ...found };
  }
  const host = ensureModalHost();
  host.innerHTML = `
    <div class="modal-overlay open" id="evtOverlay">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Calendar event">
        <div class="modal-head">
          <span>${id ? 'Edit event' : 'Add event'}</span>
          <button class="modal-close" type="button" id="evtClose" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="modal-error" id="evtErr"></div>
          <div class="form-group">
            <label class="form-label" for="evtTitle">Title</label>
            <input class="form-input" id="evtTitle" value="${escHtml(e.title)}" placeholder="e.g. EASE Growth Term 1 window opens" />
          </div>
          <div class="form-group">
            <label class="form-label" for="evtCat">Category</label>
            <input class="form-input" id="evtCat" value="${escHtml(e.category || 'Assessment')}" placeholder="Assessment" />
          </div>
          <div class="form-group">
            <label class="form-label" for="evtStart">Start date</label>
            <input class="form-input" id="evtStart" type="date" value="${escHtml(e.date_start || '')}" />
          </div>
          <div class="form-group">
            <label class="form-label" for="evtEnd">End date <span class="form-hint">optional</span></label>
            <input class="form-input" id="evtEnd" type="date" value="${escHtml(e.date_end || '')}" />
          </div>
          <div class="form-group">
            <label class="form-label" for="evtDesc">Description <span class="form-hint">optional</span></label>
            <textarea class="form-textarea" id="evtDesc" rows="3">${escHtml(e.description || '')}</textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" type="button" id="evtCancel">Cancel</button>
          <button class="btn-save" type="button" id="evtSave">${id ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </div>`;
  const close = () => closeModal();
  $('evtClose').addEventListener('click', close);
  $('evtCancel').addEventListener('click', close);
  $('evtOverlay').addEventListener('click', (ev) => { if (ev.target.id === 'evtOverlay') close(); });
  $('evtSave').addEventListener('click', saveEvent);
}

async function saveEvent() {
  const title = $('evtTitle').value.trim();
  const category = $('evtCat').value.trim() || 'Assessment';
  const date_start = $('evtStart').value;
  const date_end = $('evtEnd').value;
  const description = $('evtDesc').value.trim();
  const err = $('evtErr');
  if (!title) { err.textContent = 'Title is required.'; err.classList.add('visible'); return; }
  if (!date_start) { err.textContent = 'Start date is required.'; err.classList.add('visible'); return; }
  const base = {
    programKey,
    title, category, date_start,
    date_end: date_end || date_start,
    description,
    department: 'Academic',
    updatedAt: serverTimestamp(),
  };
  try {
    if (editingEventId) {
      await updateDoc(doc(db, 'calendar_events', editingEventId), base);
      showToast('Event updated.');
    } else {
      base.createdAt = serverTimestamp();
      await addDoc(collection(db, 'calendar_events'), base);
      showToast('Event added.');
    }
    closeModal();
  } catch (e) {
    console.error('[saveEvent]', e);
    err.textContent = `Save failed: ${e.code || e.message}`; err.classList.add('visible');
  }
}

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

function tsMillis(v) {
  if (!v) return 0;
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') { const p = new Date(v); return isNaN(p) ? 0 : p.getTime(); }
  return 0;
}
