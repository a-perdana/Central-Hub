/**
 * syllabus-core.js — shared logic for all three syllabus pages.
 *
 * Usage: import { initSyllabusPage } from './partials/syllabus-core.js';
 * Each page calls initSyllabusPage(config) with its own subject/feature config.
 *
 * Config shape:
 * {
 *   subjects:      { [key]: { label, code, collection, icon?, pacingUrl? } }
 *   docId:         string          // Firestore document ID, e.g. 'year7-8'
 *   years:         string[]        // e.g. ['Year 7','Year 8']
 *   glhTarget:     number          // Cambridge recommended GLH
 *   scheduleDocId: string          // teaching_schedule doc ID, e.g. 'main' | 'igcse' | 'asalevel'
 *   programmeLabel: string         // e.g. 'Cambridge Secondary Checkpoint'
 *   tierSessionKey: string|null    // sessionStorage key for tier filter, null = no tier filter
 *   settingsMode:  'inline'|'modal'// inline = replace content; modal = overlay panel
 *   features: {
 *     aoBadges:          boolean   // IGCSE AO1/AO2 inference badges
 *     paperBadges:       boolean   // Core/Extended paper badges
 *     cmdWords:          boolean   // Cambridge Command Words section in syllabus detail
 *     gradeFilter:       boolean   // Year 7 / Year 8 / All filter buttons
 *     subjectColorCoding:boolean   // data-subject CSS colour tokens
 *     calendarDates:     boolean   // topic date labels from teaching schedule
 *     holidayBanners:    boolean   // holiday break banners between chapters
 *     bufferTopics:      boolean   // ⏳ buffer row + Add Buffer button
 *     semesterChips:     boolean   // Sem I / Sem II chips on topic rows
 *     topicReorder:      boolean   // ↑↓ move buttons on topics and chapters
 *     nonAdminRead:      boolean   // allow central_user read access (not admin-only)
 *     teacherProgressBtn:boolean   // "View Progress Report" button
 *   }
 * }
 */

import {
  doc, getDoc, getDocs, collection, query, where,
  onSnapshot, setDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Sanitize rich HTML for display; falls back to escaping plain text if no HTML detected
function _sylSafeHtml(html) {
  if (!html) return '';
  if (typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(html);
  // Fallback: if it looks like HTML pass through, otherwise escape
  return /<[a-z]/i.test(html) ? html : escHtml(html);
}
// Convert plain text to RTE-compatible HTML (preserves existing HTML, wraps plain text)
function _sylToRteHtml(str) {
  if (!str) return '';
  if (/<[a-z]/i.test(str)) return str; // already HTML
  return str.split('\n').filter(Boolean).map(l => `<p>${escHtml(l)}</p>`).join('');
}
// RTE helpers for the syllabus editor
window._sylRteExec = function(id, cmd) {
  const el = document.getElementById(id);
  if (el) { el.focus(); document.execCommand(cmd, false, null); }
};
window._sylRteClear = function(id) {
  const el = document.getElementById(id);
  if (el) { el.innerHTML = ''; el.focus(); }
};
function safeUrl(url) {
  return /^https?:\/\//i.test(url) ? url : '#';
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function escapeRegex(q) {
  return q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function highlight(text, q) {
  if (!q) return escHtml(text);
  const safe = escHtml(text);
  return safe.replace(new RegExp(escapeRegex(q), 'gi'), m => `<mark class="hl">${m}</mark>`);
}
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function highlightInHtml(html, q) {
  if (!q) return html;
  const re = new RegExp(escapeRegex(q), 'gi');
  return html.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, text) => {
    if (tag) return tag;
    return text.replace(re, m2 => `<mark class="hl">${m2}</mark>`);
  });
}
function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// ─────────────────────────────────────────────────────────────────────────────
// AO Badges (IGCSE)
// ─────────────────────────────────────────────────────────────────────────────

const AO1_KEYWORDS = [
  'calculate','state','write down','give','find','work out',
  'construct','sketch','plot','draw','measure','complete','list',
  'convert','simplify','expand','factorise','substitute','solve',
  'use','apply','carry out','perform','recall','express',
  'write','evaluate','compute',
];
const AO2_KEYWORDS = [
  'interpret','analyse','show that','prove','derive','justify',
  'explain','describe','deduce','determine','predict','generalise',
  'compare','comment','reason','formulate','model','make connections',
  'identify pattern','identify strategy','select appropriate',
  'communicate','present','discuss',
];

function inferAO(t) {
  if (t.ao) return t.ao;
  const text = ((t.title || t.topic || '') + ' ' + (t.objectives || t.objective || '')).toLowerCase();
  const clean = text.replace(/<[^>]*>/g, ' ');
  const hasAO1 = AO1_KEYWORDS.some(k => clean.includes(k));
  const hasAO2 = AO2_KEYWORDS.some(k => clean.includes(k));
  if (hasAO1 && hasAO2) return 'AO1+AO2';
  if (hasAO2) return 'AO2';
  return 'AO1';
}

function renderAoBadges(t) {
  const ao = inferAO(t);
  if (ao === 'AO1+AO2') return `<span class="ao-badge ao12" title="AO1 + AO2">AO1+2</span>`;
  if (ao === 'AO2')     return `<span class="ao-badge ao2" title="AO2 — Analyse, Interpret &amp; Communicate">AO2</span>`;
  return `<span class="ao-badge ao1" title="AO1 — Knowledge &amp; Techniques">AO1</span>`;
}

function renderPaperBadge(t) {
  const refs = t.syllabusRefs || [];
  if (!refs.length) return '';
  const hasCore = refs.some(r => /^C/i.test(r));
  const hasExt  = refs.some(r => /^E/i.test(r));
  if (hasCore && hasExt) return `<span class="paper-badge both" title="Core + Extended: P1/2/3/4">All Papers</span>`;
  if (hasExt)  return `<span class="paper-badge extended" title="Extended: Paper 2 + Paper 4">P2+P4 Ext</span>`;
  if (hasCore) return `<span class="paper-badge core"     title="Core: Paper 1 + Paper 3">P1+P3 Core</span>`;
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Cambridge Command Words
// ─────────────────────────────────────────────────────────────────────────────

const CAMBRIDGE_CMD_WORDS = {
  'Calculate':   'Work out from given facts, figures or information.',
  'Construct':   'Make an accurate drawing.',
  'Determine':   'Establish with certainty.',
  'Describe':    'State the points of a topic / give characteristics and main features.',
  'Explain':     'Set out purposes or reasons / make relationships between things evident.',
  'Give':        'Produce an answer from a given source or recall/memory.',
  'Plot':        'Mark accurate points on a graph.',
  'Show (that)': 'Provide structured evidence that leads to a given result.',
  'Sketch':      'Make a simple freehand drawing showing the key features.',
  'State':       'Express in clear terms.',
  'Work out':    'Calculate from given information.',
  'Write':       'Give an answer in a specific form.',
  'Write down':  'Give an answer without showing working.',
};

function detectCmdWords(entry) {
  if (!entry) return [];
  const contentItems = Array.isArray(entry.content)
    ? entry.content
    : [stripHtml(entry.content || '')];
  const haystack = [
    entry.title || '',
    stripHtml(entry.description || ''),
    ...contentItems,
    ...(Array.isArray(entry.notes) ? entry.notes : [entry.notes || '']),
  ].join(' ').toLowerCase();
  return Object.keys(CAMBRIDGE_CMD_WORDS).filter(w => haystack.includes(w.toLowerCase()));
}

function renderCmdWordSection(entry) {
  const detected = detectCmdWords(entry);
  const chips = Object.keys(CAMBRIDGE_CMD_WORDS).map(w => {
    const isDetected = detected.includes(w);
    return `<span class="cmd-chip${isDetected ? ' detected' : ''}" title="${escHtml(CAMBRIDGE_CMD_WORDS[w])}">${escHtml(w)}</span>`;
  }).join('');
  return `<div class="cmd-words-wrap">
    <p class="cmd-words-label">Cambridge Command Words</p>
    <div class="cmd-word-chips">${chips}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main init function
// ─────────────────────────────────────────────────────────────────────────────

// Inject RTE styles once (shared across all syllabus pages)
(function _injectSylRteStyles() {
  if (document.getElementById('syl-rte-styles')) return;
  const s = document.createElement('style');
  s.id = 'syl-rte-styles';
  s.textContent = `
    /* Syllabus RTE editor */
    .syl-rte-wrap { border: 1px solid var(--border); border-radius: 8px; background: var(--white); transition: border-color 0.15s; margin-bottom: 0; }
    .syl-rte-wrap:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,58,237,0.08); }
    .syl-rte-toolbar { display: flex; gap: 2px; padding: 5px 8px; border-bottom: 1px solid var(--border); background: var(--paper); border-radius: 8px 8px 0 0; }
    .syl-rte-btn { background: none; border: none; cursor: pointer; padding: 3px 7px; border-radius: 5px; font-size: 0.82rem; color: var(--ink-2); transition: background 0.15s, color 0.15s; }
    .syl-rte-btn:hover { background: var(--accent-2); color: var(--accent-dk); }
    .syl-rte-sep { width: 1px; background: var(--border); margin: 3px 4px; align-self: stretch; }
    .syl-rte-editor { padding: 9px 12px; min-height: 90px; max-height: 260px; overflow-y: auto; font-family: 'DM Sans', sans-serif; font-size: 0.875rem; color: var(--ink); outline: none; line-height: 1.6; }
    .syl-rte-editor:empty:before { content: attr(data-placeholder); color: var(--ink-3); pointer-events: none; }
    .syl-rte-editor ul, .syl-rte-editor ol { padding-left: 20px; margin: 4px 0; }
    .syl-rte-editor li { margin: 2px 0; }
    .syl-rte-editor b, .syl-rte-editor strong { font-weight: 600; }
    .syl-rte-editor i, .syl-rte-editor em { font-style: italic; }
    /* Rich content display in detail panel */
    .syl-rich { font-size: 0.875rem; color: var(--ink-2); line-height: 1.65; }
    .syl-rich ul, .syl-rich ol { padding-left: 20px; margin: 4px 0; }
    .syl-rich li { margin: 3px 0; }
    .syl-rich b, .syl-rich strong { font-weight: 600; color: var(--ink); }
    .syl-rich i, .syl-rich em { font-style: italic; }
    .syl-description.syl-rich { background: var(--paper); border-radius: 8px; padding: 10px 14px; margin-bottom: 18px; border-left: 3px solid var(--accent); }
    /* Rich content in pacing guide inline reference */
    .srl-desc.syl-rich { display: block; margin-top: 3px; }
    .srl-desc.syl-rich ul, .srl-desc.syl-rich ol { padding-left: 16px; margin: 2px 0; }
    .srl-desc.syl-rich li { margin: 1px 0; }
  `;
  document.head.appendChild(s);
})();

export function initSyllabusPage(config) {
  const {
    subjects,
    docId,
    years,
    glhTarget,
    scheduleDocId = 'main',
    programmeLabel = 'Cambridge',
    tierSessionKey = null,
    settingsMode   = 'inline',
    features       = {},
  } = config;

  // Expose Firestore helpers for settings functions called from inline onclick
  window.__firestoreHelpers = { doc, getDoc, setDoc, serverTimestamp };

  // ── Inject excluded-topic CSS once per page ────────────────────────────────
  if (!document.getElementById('syllabus-excluded-css')) {
    const s = document.createElement('style');
    s.id = 'syllabus-excluded-css';
    s.textContent = `
      .topic-row.topic-excluded { opacity: 0.38; }
      .topic-row.topic-excluded .topic-title { text-decoration: line-through; color: var(--ink-3); }
      .topic-row.topic-excluded .chip-hours { background: #f1f5f9; color: #94a3b8; border-color: #e2e8f0; }
      .btn-exclude {
        font-family: 'DM Sans', sans-serif; font-size: 0.72rem; font-weight: 500;
        padding: 3px 9px; border-radius: 6px; border: 1px solid var(--border);
        background: var(--paper-2); color: var(--ink-3); cursor: pointer;
        transition: all 0.15s; white-space: nowrap; line-height: 1.4;
      }
      .btn-exclude:hover { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
      .topic-excluded .btn-exclude { background: #f1f5f9; color: #64748b; border-color: #e2e8f0; }
      .topic-excluded .btn-exclude:hover { background: #e0f2fe; color: #0369a1; border-color: #bae6fd; }
      #pagingToggleBtn.btn-active-state { background: var(--accent-2); color: var(--accent-dk); border-color: #6ee7b7; }
    `;
    document.head.appendChild(s);
  }

  // ── Conversion (checkpoint uses GLH = lesson hours × 2/3)
  const LESSON_TO_GLH = features.calendarDates ? (2 / 3) : 1;
  const toGlh = h => features.calendarDates ? Math.round(h * LESSON_TO_GLH * 10) / 10 : h;

  // ── State ─────────────────────────────────────────────────────────────────
  let currentSubject = Object.keys(subjects)[0];
  let chapters       = [];
  window.chapters    = chapters;
  let unsub          = null;
  let saving         = false;
  let isAdmin        = false;
  let isCoordinator  = false;

  // Modal state
  let modalMode         = null;
  let editChIdx         = null;
  let editTopIdx        = null;
  let modalResources    = [];
  let modalSyllabusRefs = [];
  let _modalDirty       = false;

  // Syllabus index
  let syllabusIndex  = {};
  let syllabusLoaded = false;

  // Settings state
  const defaultSettings = Object.fromEntries(
    Object.keys(subjects).map(k => [k, { classes: [], objPrefixes: '', weeklyHours: 0 }])
  );
  let settingsData      = defaultSettings;
  let settingsClassSubj = currentSubject;
  let settingsObjSubj   = currentSubject;

  // Calendar schedule state
  let teachingWeeks = [];
  let skippedWeeks  = [];

  // Teaching schedule modal cache
  let _schedData = null;
  let _calEvents = null;

  // Grade filter (checkpoint only)
  let activeYearFilter = years[0] || 'all';

  // Tier filter (igcse / asalevel)
  let currentTierFilter = tierSessionKey
    ? (sessionStorage.getItem(tierSessionKey) || 'all')
    : 'all';

  // Search
  let searchQuery = '';

  // Pagination
  const PAGE_SIZE = 5;
  let currentPage = 0;
  let noPaging = false;

  // GLH chart state
  let _glhChartOpen = false;

  // Assessment modal state
  let _asmntContext = null;
  let _asmntPdfFile = null;

  // Syllabus editor state
  let _sylEdCurrentKey = null;

  // Modal semester state
  let _modalSemester = 0;

  // ── Auth ─────────────────────────────────────────────────────────────────
  document.addEventListener('authReady', async ({ detail: { profile } }) => {
    const hasAccess = features.nonAdminRead
      ? ['central_user', 'central_admin'].includes(profile.role_centralhub)
      : profile.role_centralhub === 'central_admin';

    if (!hasAccess) {
      document.getElementById('accessDenied').style.display = '';
      return;
    }

    isAdmin = profile.role_centralhub === 'central_admin';
    isCoordinator = profile.role_centralhub === 'central_user' && Array.isArray(profile.ch_sub_roles) && profile.ch_sub_roles.includes('coordinator');
    document.getElementById('mainContent').style.display = '';

    // Build subject tabs dynamically if the container is empty (IGCSE uses dynamic tabs)
    const tabsContainer = document.querySelector('.subject-tabs');
    if (tabsContainer && tabsContainer.querySelectorAll('.subj-tab').length === 0) {
      const firstSubj = Object.keys(subjects)[0];
      Object.entries(subjects).forEach(([key, s]) => {
        const btn = document.createElement('button');
        btn.className = 'subj-tab' + (key === firstSubj ? ' active' : '');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('data-subj', key);
        btn.setAttribute('aria-selected', key === firstSubj ? 'true' : 'false');
        btn.innerHTML = `<span class="subj-icon">${s.icon || '📚'}</span> ${s.label}`;
        tabsContainer.appendChild(btn);
      });
      // Settings tab (admin only, appended after subjects)
      const settingsBtn = document.createElement('button');
      settingsBtn.className = 'subj-tab';
      settingsBtn.id = 'settingsTab';
      settingsBtn.setAttribute('role', 'tab');
      settingsBtn.setAttribute('data-subj', '__settings');
      settingsBtn.setAttribute('aria-selected', 'false');
      settingsBtn.style.cssText = 'margin-left:auto;flex:0 0 auto;color:var(--ink-3);display:none';
      settingsBtn.innerHTML = '<span class="subj-icon">⚙</span> Settings';
      tabsContainer.appendChild(settingsBtn);
    }

    if (isAdmin) {
      const stab = document.getElementById('settingsTab');
      if (stab) stab.style.display = '';
    } else {
      ['editSyllabusBtn', 'addChapterBtn', 'addFirstChapterBtn', 'settingsToggleBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
    }

    // Show teaching schedule button for all users
    const teachSchedBtn = document.getElementById('teachSchedBtn');
    if (teachSchedBtn) teachSchedBtn.style.display = '';

    // Paging toggle button — inject before editSyllabusBtn for admin/coordinator
    if (isAdmin || isCoordinator) {
      const editBtn = document.getElementById('editSyllabusBtn');
      const pagingBtn = document.createElement('button');
      pagingBtn.id = 'pagingToggleBtn';
      pagingBtn.className = 'btn btn-secondary';
      pagingBtn.title = 'Toggle chapter pagination';
      pagingBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg> All Chapters`;
      pagingBtn.addEventListener('click', () => {
        noPaging = !noPaging;
        currentPage = 0;
        pagingBtn.innerHTML = noPaging
          ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg> Paginate`
          : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg> All Chapters`;
        pagingBtn.classList.toggle('btn-active-state', noPaging);
        render();
      });
      if (editBtn) {
        editBtn.parentNode.insertBefore(pagingBtn, editBtn);
      }
    }

    // Subject tab clicks
    document.querySelectorAll('.subj-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.subj-tab').forEach(t => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        if (tab.dataset.subj === '__settings') {
          showSettingsPanel();
        } else {
          hideSettingsPanel();
          loadSubject(tab.dataset.subj);
        }
      });
    });

    // Tier filter init
    if (tierSessionKey && currentTierFilter !== 'all') {
      document.querySelectorAll('#tierFilter .tier-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tier === currentTierFilter);
      });
    }

    // Year filter init (checkpoint)
    if (features.gradeFilter) {
      const yfY = document.getElementById('yfY' + (years[0] === 'Year 7' ? '7' : '9'));
      if (yfY) yfY.className += ' active-y' + (years[0] === 'Year 7' ? '7' : '9');
    }

    // Populate year select in chapter modal
    rebuildYearSelect();

    // Start loading — calendar data must be ready before the first render
    const calReady = (features.calendarDates || features.holidayBanners)
      ? loadCalendarData()
      : Promise.resolve();

    calReady
      .then(() => { loadSubject(currentSubject); })
      .catch(err => { console.error('Calendar load error:', err); showToast('Failed to load calendar data.', true); });

    loadSyllabus()
      .then(() => { if (chapters.length) render(); })
      .catch(err => { console.error('Syllabus index load error:', err); });
  });

  // ── Rebuild year select ────────────────────────────────────────────────────
  function rebuildYearSelect() {
    const sel = document.getElementById('chYearSelect');
    if (!sel) return;
    sel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  }

  // ── Syllabus loader ────────────────────────────────────────────────────────
  async function loadSyllabus() {
    try {
      const subjectCodes = Object.values(subjects).map(s => s.code);
      // Single 'in' query instead of one getDocs per subject code
      const snap = await getDocs(
        query(collection(window.db, 'cambridge_syllabus'), where('subjectCode', 'in', subjectCodes))
      );
      snap.forEach(d => { syllabusIndex[d.id] = d.data(); });
      syllabusLoaded = true;
      const hint = document.getElementById('syllabusPickerHint');
      if (hint) hint.textContent = '';
    } catch (e) {
      console.warn('Could not load cambridge_syllabus:', e);
      const hint = document.getElementById('syllabusPickerHint');
      if (hint) hint.textContent = 'Syllabus data unavailable.';
    }
  }

  // ── Calendar data loader ───────────────────────────────────────────────────
  async function loadCalendarData() {
    const db = window.db;
    const schedSnap = await getDoc(doc(db, 'teaching_schedule', scheduleDocId)).catch(() => null);
    if (schedSnap && schedSnap.exists() && Array.isArray(schedSnap.data().weeks)) {
      const d = schedSnap.data();
      teachingWeeks = d.weeks.map(w => ({
        weekNo:    w.weekNo,
        semLabel:  w.semLabel  || '',
        semWeekNo: w.semWeekNo || w.weekNo,
        mon: new Date(w.mon + 'T00:00:00'),
        fri: new Date(w.fri + 'T00:00:00'),
      }));
      skippedWeeks = Array.isArray(d.skippedWeeks) ? d.skippedWeeks.map(w => ({
        mon:      new Date(w.mon + 'T00:00:00'),
        fri:      new Date(w.fri + 'T00:00:00'),
        semLabel: w.semLabel || '',
        reason:   w.reason   || 'Holiday',
      })) : [];
      const box = document.getElementById('syncStatusBox');
      if (box) box.textContent = `${teachingWeeks.length} teaching weeks loaded.`;
    } else {
      teachingWeeks = [];
      skippedWeeks  = [];
      const box = document.getElementById('syncStatusBox');
      if (box) box.textContent = 'No schedule synced yet — go to Academic Calendar → ⚙ Year Settings → Sync Teaching Weeks.';
    }
  }

  // ── Topic date label ───────────────────────────────────────────────────────
  function getTopicDateLabel(cumulativeBefore, duration, weeklyHours) {
    if (!teachingWeeks.length || !weeklyHours || weeklyHours <= 0) return null;
    const startWeekIdx = Math.floor(cumulativeBefore / weeklyHours);
    const endWeekIdx   = Math.floor((cumulativeBefore + duration - 1) / weeklyHours);
    const startW = teachingWeeks[startWeekIdx];
    const endW   = teachingWeeks[endWeekIdx];
    if (!startW) return '__beyond__';
    const fmt = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const semPrefix = startW.semLabel ? `${startW.semLabel} · ` : '';
    if (!endW || startWeekIdx === endWeekIdx) {
      return `${semPrefix}Week ${startW.semWeekNo}: ${fmt(startW.mon)} – ${fmt(startW.fri)}`;
    }
    if (startW.semLabel && endW.semLabel && startW.semLabel === endW.semLabel) {
      return `${semPrefix}Week ${startW.semWeekNo}–${endW.semWeekNo}: ${fmt(startW.mon)} – ${fmt(endW.fri)}`;
    }
    return `${semPrefix}Week ${startW.semWeekNo}: ${fmt(startW.mon)} – ${fmt(endW.fri)}`;
  }

  // ── Syllabus lookup helper ─────────────────────────────────────────────────
  function lookupSyllabus(subjCode, code) {
    const exact = `${subjCode}_${code}`;
    if (syllabusIndex[exact]) return { key: exact, entry: syllabusIndex[exact] };
    for (const suffix of ['_core', '_supplement', '_extended']) {
      const k = exact + suffix;
      if (syllabusIndex[k]) return { key: k, entry: syllabusIndex[k] };
    }
    return { key: exact, entry: undefined };
  }

  // ── Syllabus picker (topic modal) ──────────────────────────────────────────
  function initSyllabusPicker() {
    const input    = document.getElementById('syllabusSearchInput');
    const dropdown = document.getElementById('syllabusDropdown');
    if (!input || !dropdown) return;

    input.oninput = () => {
      const q = input.value.trim().toLowerCase();
      if (!q || !syllabusLoaded) { dropdown.classList.remove('open'); return; }
      const cfg = subjects[currentSubject];
      const results = Object.entries(syllabusIndex)
        .filter(([key, e]) => key.startsWith(cfg.code + '_') && !modalSyllabusRefs.includes(e.code || key.split('_').slice(1).join('_')))
        .filter(([, e]) => {
          const c = (e.code || '').toLowerCase();
          const t = (e.title || '').toLowerCase();
          const a = (e.topicArea || '').toLowerCase();
          return c.includes(q) || t.includes(q) || a.includes(q);
        }).slice(0, 12);

      if (!results.length) {
        dropdown.innerHTML = '<div class="syllabus-no-results">No matching objectives</div>';
      } else {
        dropdown.innerHTML = results.map(([key, e]) => {
          const tier = (e.tier || '').toLowerCase();
          const tierLabel = tier === 'core' ? 'C' : tier === 'extended' ? 'E' : tier === 'supplement' ? 'S' : '';
          const tierBadge = tierLabel ? `<span class="syl-tier-badge ${tier}" style="font-size:0.6rem;padding:0 4px">${tierLabel}</span>` : '';
          return `<div class="syllabus-option" data-code="${escHtml(e.code || key)}" data-key="${escHtml(key)}">
            <span class="opt-code">${escHtml(e.code || key)}</span>
            ${tierBadge}
            <span class="opt-topic">${escHtml(e.topicArea || '')}</span>
            <span class="opt-title">${escHtml(e.title || '')}</span>
          </div>`;
        }).join('');
        dropdown.querySelectorAll('.syllabus-option').forEach(opt => {
          opt.onclick = () => {
            addSyllabusChip(opt.dataset.code);
            input.value = '';
            dropdown.classList.remove('open');
          };
        });
      }
      dropdown.classList.add('open');
    };

    document.addEventListener('click', e => {
      if (!document.getElementById('syllabusPicker')?.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    }, { passive: true });
  }

  function addSyllabusChip(code) {
    if (modalSyllabusRefs.includes(code)) return;
    modalSyllabusRefs.push(code);
    renderSyllabusChips();
    _modalDirty = true;
  }

  function removeSyllabusChip(code) {
    modalSyllabusRefs = modalSyllabusRefs.filter(c => c !== code);
    renderSyllabusChips();
  }

  function renderSyllabusChips() {
    const wrap = document.getElementById('syllabusChips');
    const hint = document.getElementById('syllabusPickerHint');
    if (!wrap) return;
    wrap.innerHTML = modalSyllabusRefs.map(code => `
      <span class="syllabus-chip">${escHtml(code)}
        <button class="chip-remove" type="button" onclick="removeSyllabusChip('${escHtml(code)}')" aria-label="Remove ${escHtml(code)}">×</button>
      </span>`).join('');
    if (hint) hint.style.display = modalSyllabusRefs.length ? 'none' : '';
  }

  // ── Syllabus detail modal ──────────────────────────────────────────────────
  function openSyllabusDetail(indexKeyOrSubjCode, code) {
    let indexKey;
    if (code === undefined) {
      indexKey = indexKeyOrSubjCode;
    } else {
      const result = lookupSyllabus(indexKeyOrSubjCode, code);
      indexKey = result?.key || `${indexKeyOrSubjCode}_${code}`;
    }
    const entry   = syllabusIndex[indexKey];
    const modal   = document.getElementById('syllabusDetailModal');
    const bodyId  = document.getElementById('syllabusDetailBody') ? 'syllabusDetailBody' : 'sylDetailBody';
    const body    = document.getElementById(bodyId);
    const editBtn = document.getElementById('syllabusDetailEditBtn');
    if (!modal || !body) return;

    modal.dataset.currentKey = indexKey;
    if (editBtn) editBtn.style.display = '';

    if (!entry) {
      body.innerHTML = `<p class="syl-no-detail">No syllabus data found for <strong>${escHtml(indexKey)}</strong>.</p>`;
      if (editBtn) editBtn.style.display = 'none';
    } else {
      const displayCode = entry.code || indexKey.split('_').slice(1).join('_');
      const title       = entry.title || '';
      const topic       = entry.topicArea || entry.topic || '';
      const tier        = entry.tier || '';
      const description = entry.description || '';
      const rawContent  = entry.content;
      const notes       = Array.isArray(entry.notes) ? entry.notes : (entry.notes || '').split('\n').filter(Boolean);

      // description may be rich HTML (new) or plain text (legacy)
      const descHtml = description
        ? `<div class="syl-description syl-rich">${_sylSafeHtml(description)}</div>`
        : '';

      // content may be rich HTML string (new) or string array (legacy)
      const contentHtml = Array.isArray(rawContent)
        ? (rawContent.length
            ? `<ul class="syl-content-list">${rawContent.map(c => `<li>${escHtml(c)}</li>`).join('')}</ul>`
            : '')
        : (rawContent ? `<div class="syl-rich">${_sylSafeHtml(rawContent)}</div>` : '');

      const leftHtml = contentHtml
        ? `<p class="syl-section-label">Learning Objectives</p>${contentHtml}`
        : `<p class="syl-no-detail">No objectives listed.</p>`;
      const rightHtml = notes.length
        ? `<p class="syl-section-label">Notes &amp; Guidance</p>
           <ul class="syl-notes-list">${notes.map(n => `<li>${escHtml(n)}</li>`).join('')}</ul>`
        : '';

      const hasContent = contentHtml.length > 0;
      const colsHtml = (hasContent && notes.length)
        ? `<div class="syl-cols"><div class="syl-col">${leftHtml}</div><div class="syl-col">${rightHtml}</div></div>`
        : leftHtml + rightHtml || `<p class="syl-no-detail">No detailed content available.</p>`;

      // Command words section (if enabled)
      const cmdSection = features.cmdWords ? renderCmdWordSection(entry) : '';

      body.innerHTML = `
        <div class="syl-detail-header">
          <span class="syl-detail-code">${escHtml(displayCode)}</span>
          <div class="syl-detail-meta">
            ${title ? `<div class="syl-detail-title">${escHtml(title)}</div>` : ''}
            ${topic ? `<div class="syl-detail-topic">${escHtml(topic)}</div>` : ''}
          </div>
          ${tier ? `<span class="syl-detail-tier">${escHtml(tier)}</span>` : ''}
        </div>
        ${descHtml}
        ${colsHtml}
        ${cmdSection}`;
    }

    document.getElementById('syllabusDetailTitle').textContent = entry?.code || indexKey.split('_').slice(1).join('_');
    modal.classList.add('open');
    // Escape is handled by the global keydown listener at the bottom of init
  }

  function closeSyllabusDetail() {
    const modal = document.getElementById('syllabusDetailModal');
    if (modal) modal.classList.remove('open');
  }

  // ── Syllabus editor modal ──────────────────────────────────────────────────
  function openSyllabusEditor(selectKey = null) {
    const modal  = document.getElementById('syllabusEditorModal');
    const list   = document.getElementById('syllabusEditorList');
    const subjEl = document.getElementById('syllabusEditorSubj');
    if (!modal || !list) return;

    _sylEdCurrentKey = null;
    const form = document.getElementById('syllabusEditorForm');
    if (form) form.innerHTML = '';

    const cfg       = subjects[currentSubject];
    const subjCode  = cfg ? cfg.code  : '';
    const subjLabel = cfg ? cfg.label : '';
    if (subjEl) subjEl.textContent = `${subjLabel} — ${subjCode}`;

    const entries = Object.entries(syllabusIndex)
      .filter(([id]) => !subjCode || id.startsWith(subjCode + '_'))
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));

    list.innerHTML = entries.map(([id, entry]) => {
      const tier = (entry.tier || '').toLowerCase();
      const tierLabel = tier === 'core' ? 'C' : tier === 'extended' ? 'E' : tier === 'supplement' ? 'S' : '';
      const tierBadge = tierLabel ? `<span class="syl-tier-badge ${tier}">${tierLabel}</span>` : '';
      return `<div class="syl-ed-item" data-key="${escHtml(id)}">
         <span class="syl-ed-code">${escHtml(entry.code || id.split('_').slice(1).join('_'))}</span>
         ${tierBadge}
         <span class="syl-ed-title">${escHtml(entry.title || '')}</span>
       </div>`;
    }).join('') || `<p style="padding:16px;font-size:0.82rem;color:var(--ink-3)">No syllabus entries loaded.</p>`;

    list.onclick = e => {
      const item = e.target.closest('.syl-ed-item');
      if (!item) return;
      list.querySelectorAll('.syl-ed-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      _sylEdCurrentKey = item.dataset.key;
      renderSylEdForm(_sylEdCurrentKey);
    };

    modal.classList.add('open');
    // Escape is handled by the global keydown listener at the bottom of init

    if (selectKey) {
      const item = list.querySelector(`[data-key="${CSS.escape(selectKey)}"]`);
      if (item) { item.click(); item.scrollIntoView({ block: 'center' }); }
    } else if (entries.length) {
      list.querySelector('.syl-ed-item')?.click();
    }
  }

  function renderSylEdForm(key) {
    const form    = document.getElementById('syllabusEditorForm');
    const saveBtn = document.getElementById('syllabusEditorSaveBtn');
    const entry   = syllabusIndex[key];
    if (!form || !entry) return;

    const code    = entry.code    || key.split('_').slice(1).join('_');
    const title   = entry.title   || '';
    const topic   = entry.topicArea || entry.topic || '';
    const tier    = entry.tier    || '';
    const rawDesc    = entry.description || '';
    const rawContent = entry.content;
    const notes      = Array.isArray(entry.notes) ? entry.notes.join('\n') : (entry.notes || entry.notesExamples || '');

    // Convert legacy plain-text / array data to HTML for the RTE
    const descHtmlInit    = _sylToRteHtml(rawDesc);
    const contentHtmlInit = Array.isArray(rawContent)
      ? (rawContent.length ? `<ul>${rawContent.map(l => `<li>${escHtml(l)}</li>`).join('')}</ul>` : '')
      : _sylToRteHtml(rawContent || '');

    form.innerHTML = `
      <div class="syl-ed-entry-head">
        <span class="syl-ed-code">${escHtml(code)}</span>
        <strong style="font-size:0.95rem;color:var(--ink)">${escHtml(title)}</strong>
        ${tier ? `<span class="syl-detail-tier" style="margin-left:auto">${escHtml(tier)}</span>` : ''}
      </div>
      <label class="syl-ed-field-label" for="sylEdTitle">Title</label>
      <input class="form-input" id="sylEdTitle" value="${escHtml(title)}" style="margin-bottom:0">
      <label class="syl-ed-field-label" for="sylEdTopic">Topic Area</label>
      <input class="form-input" id="sylEdTopic" value="${escHtml(topic)}" style="margin-bottom:0">
      <label class="syl-ed-field-label" for="sylEdTier">Tier</label>
      <select class="form-input" id="sylEdTier" style="margin-bottom:0">
        <option value="Core"     ${tier==='Core'    ?'selected':''}>Core</option>
        <option value="Extended" ${tier==='Extended'?'selected':''}>Extended</option>
        <option value=""         ${!tier            ?'selected':''}>— Not set —</option>
      </select>
      <label class="syl-ed-field-label">Description</label>
      <div class="syl-rte-wrap">
        <div class="syl-rte-toolbar">
          <button type="button" class="syl-rte-btn" title="Bold" onclick="_sylRteExec('sylEdDescRte','bold')"><b>B</b></button>
          <button type="button" class="syl-rte-btn" title="Italic" onclick="_sylRteExec('sylEdDescRte','italic')"><i>I</i></button>
          <div class="syl-rte-sep"></div>
          <button type="button" class="syl-rte-btn" title="Bullet list" onclick="_sylRteExec('sylEdDescRte','insertUnorderedList')">&#8226; List</button>
          <div class="syl-rte-sep"></div>
          <button type="button" class="syl-rte-btn" title="Clear formatting" onclick="_sylRteClear('sylEdDescRte')">Clear</button>
        </div>
        <div class="syl-rte-editor" id="sylEdDescRte" contenteditable="true" data-placeholder="Short summary shown inline on the pacing guide…"></div>
      </div>
      <label class="syl-ed-field-label" style="margin-top:12px">Learning Objectives</label>
      <div class="syl-rte-wrap">
        <div class="syl-rte-toolbar">
          <button type="button" class="syl-rte-btn" title="Bold" onclick="_sylRteExec('sylEdContentRte','bold')"><b>B</b></button>
          <button type="button" class="syl-rte-btn" title="Italic" onclick="_sylRteExec('sylEdContentRte','italic')"><i>I</i></button>
          <div class="syl-rte-sep"></div>
          <button type="button" class="syl-rte-btn" title="Bullet list" onclick="_sylRteExec('sylEdContentRte','insertUnorderedList')">&#8226; List</button>
          <div class="syl-rte-sep"></div>
          <button type="button" class="syl-rte-btn" title="Clear formatting" onclick="_sylRteClear('sylEdContentRte')">Clear</button>
        </div>
        <div class="syl-rte-editor" id="sylEdContentRte" contenteditable="true" data-placeholder="Learning objectives for this syllabus point…"></div>
      </div>
      <label class="syl-ed-field-label" for="sylEdNotes" style="margin-top:12px">Notes and Guidance</label>
      <textarea class="syl-ed-textarea" id="sylEdNotes" rows="6" style="min-height:100px">${escHtml(notes)}</textarea>
      <p class="syl-ed-hint">One note per line.</p>`;

    // Set RTE content after injection (innerHTML can't be set via template safely)
    const descEl    = document.getElementById('sylEdDescRte');
    const contentEl = document.getElementById('sylEdContentRte');
    if (descEl)    descEl.innerHTML    = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(descHtmlInit)    : descHtmlInit;
    if (contentEl) contentEl.innerHTML = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(contentHtmlInit) : contentHtmlInit;

    if (saveBtn) saveBtn.style.display = isAdmin ? '' : 'none';
    // Non-admin: read-only view
    if (!isAdmin) {
      form.querySelectorAll('input,select,textarea,[contenteditable]').forEach(el => {
        if (el.hasAttribute('contenteditable')) el.setAttribute('contenteditable', 'false');
        else el.disabled = true;
      });
    }
  }

  async function saveSyllabusEntry() {
    if (!_sylEdCurrentKey) return;
    const saveBtn = document.getElementById('syllabusEditorSaveBtn');
    const title   = document.getElementById('sylEdTitle')?.value.trim()  || '';
    const topic   = document.getElementById('sylEdTopic')?.value.trim()  || '';
    const tier    = document.getElementById('sylEdTier')?.value          || '';
    const descRaw = document.getElementById('sylEdDescRte')?.innerHTML.trim()    || '';
    const contentRaw = document.getElementById('sylEdContentRte')?.innerHTML.trim() || '';
    const desc    = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(descRaw)    : descRaw;
    const content = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(contentRaw) : contentRaw;
    const notes   = (document.getElementById('sylEdNotes')?.value || '').split('\n').map(l => l.trim()).filter(Boolean);

    if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }
    try {
      const ref = doc(window.db, 'cambridge_syllabus', _sylEdCurrentKey);
      await updateDoc(ref, { title, topicArea: topic, tier, description: desc, content, notes });
      syllabusIndex[_sylEdCurrentKey] = { ...syllabusIndex[_sylEdCurrentKey], title, topicArea: topic, tier, description: desc, content, notes };
      const listItem = document.querySelector(`#syllabusEditorList [data-key="${CSS.escape(_sylEdCurrentKey)}"] .syl-ed-title`);
      if (listItem) listItem.textContent = title;
      showToast('Saved successfully');
    } catch (e) {
      console.error('saveSyllabusEntry:', e);
      showToast('Save failed: ' + e.message, true);
    } finally {
      if (saveBtn) { saveBtn.textContent = 'Save Changes'; saveBtn.disabled = false; }
    }
  }

  function closeSyllabusEditor() {
    const modal = document.getElementById('syllabusEditorModal');
    if (modal) modal.classList.remove('open');
    _sylEdCurrentKey = null;
    const saveBtn = document.getElementById('syllabusEditorSaveBtn');
    if (saveBtn) saveBtn.style.display = 'none';
  }

  // ── Teaching Schedule Modal ────────────────────────────────────────────────
  function openTeachingScheduleModal() {
    const modal = document.getElementById('teachSchedModal');
    if (!modal) return;
    modal.classList.add('open');

    const body = document.getElementById('teachSchedBody');
    if (!body) return;
    body.innerHTML = '<div style="padding:24px;text-align:center;color:#64748B">Loading…</div>';

    (async () => {
      try {
        if (!_schedData) {
          const snap = await getDoc(doc(window.db, 'teaching_schedule', scheduleDocId));
          _schedData = snap.exists() ? snap.data() : null;
        }
        if (!_calEvents) {
          const snap = await getDocs(query(
            collection(window.db, 'calendar_events'),
            where('category', '==', 'Public Holiday')
          ));
          _calEvents = snap.docs.map(d => d.data());
        }
        body.innerHTML = renderTeachingSchedule(_schedData, _calEvents);
      } catch(e) {
        body.innerHTML = `<div style="padding:24px;color:#DC2626">Failed to load: ${e.message}</div>`;
      }
    })();
  }

  function closeTeachingScheduleModal() {
    const modal = document.getElementById('teachSchedModal');
    if (modal) modal.classList.remove('open');
  }

  function renderTeachingSchedule(schedData, calEvents) {
    if (!schedData || !calEvents) {
      return '<div style="padding:24px;color:#64748B">No data available</div>';
    }

    const { academicYearStart, skippedWeekCount = 0, weeks = [], skippedWeeks = [] } = schedData;

    const weekHasHoliday = (mon, fri) => {
      return calEvents.filter(ev => {
        const start = ev.date_start, end = ev.date_end || ev.date_start;
        return start <= fri && end >= mon;
      });
    };

    const formatDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

    // Merge teaching weeks and skipped weeks in chronological order
    const allRows = [
      ...weeks.map(w => ({ type: 'teaching', data: w })),
      ...skippedWeeks.map(sw => ({ type: 'skipped', data: sw }))
    ].sort((a, b) => (a.data.mon || '').localeCompare(b.data.mon || ''));

    let html = `
      <div style="padding:24px">
        <div style="margin-bottom:20px;padding:16px;background:#F0F9FF;border:1px solid #BFDBFE;border-radius:8px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:14px">
            <div>
              <div style="color:#64748B;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:0.08em;margin-bottom:4px">Academic Year Start</div>
              <div style="color:#0F172A;font-weight:600">${formatDate(academicYearStart)}</div>
            </div>
            <div>
              <div style="color:#64748B;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:0.08em;margin-bottom:4px">Teaching Weeks</div>
              <div style="color:#0F172A;font-weight:600">${weeks.length} weeks${skippedWeekCount > 0 ? ` (${skippedWeekCount} skipped)` : ''}</div>
            </div>
          </div>
        </div>

        <h4 style="margin:20px 0 12px;font-size:14px;font-weight:700;color:#0F172A;text-transform:uppercase;letter-spacing:0.08em">Schedule Overview</h4>
        <div style="position:relative">
          <style>
            .ts-tooltip { position:relative;display:inline-block;cursor:help }
            .ts-tooltip .ts-tooltiptext {
              visibility:hidden;width:max-content;max-width:240px;background-color:#0F172A;color:#fff;text-align:center;border-radius:6px;padding:10px 14px;font-size:13px;line-height:1.4;
              position:absolute;z-index:10000;bottom:auto;top:calc(100% + 6px);left:50%;transform:translateX(-50%);white-space:normal;
              box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:none;opacity:0;transition:opacity 0.2s;margin:0
            }
            .ts-tooltip .ts-tooltiptext::after { content:'';position:absolute;bottom:100%;top:auto;left:50%;margin-left:-5px;border-width:5px;border-style:solid;border-color:transparent transparent #0F172A transparent }
            .ts-tooltip:hover .ts-tooltiptext { visibility:visible;opacity:1 }
          </style>
          <div style="border:1px solid #E2E8F0;border-radius:8px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="background:#F8FAFC">
                  <th style="padding:10px 12px;text-align:center;font-weight:700;color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid #E2E8F0;width:50px">Week</th>
                  <th style="padding:10px 12px;text-align:center;font-weight:700;color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid #E2E8F0;width:60px">Sem Week</th>
                  <th style="padding:10px 12px;text-align:left;font-weight:700;color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid #E2E8F0">Mon</th>
                  <th style="padding:10px 12px;text-align:left;font-weight:700;color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid #E2E8F0">Fri</th>
                </tr>
              </thead>
            <tbody>
              ${allRows.map((row, idx) => {
                const isSkipped = row.type === 'skipped';
                const w = row.data;
                const holidays = isSkipped ? [] : weekHasHoliday(w.mon, w.fri);
                const bgColor = isSkipped ? '#FEF2F2' : (idx % 2 === 0 ? 'white' : '#FAFBFC');
                const borderLeft = isSkipped ? '4px solid #DC2626' : 'none';

                if (isSkipped) {
                  return `
                    <tr style="background:${bgColor};border-bottom:1px solid #F1F5F9;border-left:${borderLeft};padding-left:4px">
                      <td style="padding:10px 12px;text-align:center;color:#DC2626;font-weight:700">—</td>
                      <td style="padding:10px 12px;text-align:center">
                        <div class="ts-tooltip">
                          <span style="font-size:13px;cursor:help;color:#DC2626;font-weight:700">ⓘ</span>
                          <span class="ts-tooltiptext">${w.reason || 'Skipped week'}</span>
                        </div>
                      </td>
                      <td style="padding:10px 12px;color:#334155;font-family:monospace;font-size:12px">${formatDate(w.mon)}</td>
                      <td style="padding:10px 12px;color:#334155;font-family:monospace;font-size:12px">${formatDate(w.fri)}</td>
                      <td></td>
                    </tr>
                  `;
                } else {
                  const hasHoliday = holidays.length > 0;
                  return `
                    <tr style="background:${bgColor};border-bottom:1px solid #F1F5F9">
                      <td style="padding:10px 12px;text-align:center;color:#0F172A;font-weight:700">${w.weekNo}</td>
                      <td style="padding:10px 12px;text-align:center;color:#64748B;font-size:12px">
                        ${hasHoliday
                          ? `<div class="ts-tooltip">
                              <span style="font-size:13px;cursor:help;color:#F59E0B;font-weight:700">ⓘ</span>
                              <span class="ts-tooltiptext">${holidays.map(h => h.title).join(', ')}</span>
                            </div>`
                          : w.semWeekNo || '—'
                        }
                      </td>
                      <td style="padding:10px 12px;color:#334155;font-family:monospace;font-size:12px">${formatDate(w.mon)}</td>
                      <td style="padding:10px 12px;color:#334155;font-family:monospace;font-size:12px">${formatDate(w.fri)}</td>
                      <td></td>
                    </tr>
                  `;
                }
              }).join('')}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    `;
    return html;
  }

  // ── Load subject ───────────────────────────────────────────────────────────
  function loadSubject(subj) {
    if (unsub) { unsub(); unsub = null; }
    currentSubject = subj;
    chapters = [];
    window.chapters = chapters;

    const cfg = subjects[subj];
    const mainContent = document.getElementById('mainContent');
    if (mainContent && features.subjectColorCoding) mainContent.dataset.subject = subj;

    document.getElementById('subjTitle').textContent = `${programmeLabel} ${cfg.label}`;
    document.getElementById('subjSub').textContent   = `${cfg.code} · ${years.join('–')}`;

    searchQuery = '';
    currentPage = 0;

    if (tierSessionKey) {
      currentTierFilter = sessionStorage.getItem(tierSessionKey) || 'all';
      document.querySelectorAll('#tierFilter .tier-btn').forEach(b => b.classList.toggle('active', b.dataset.tier === currentTierFilter));
    }

    if (features.gradeFilter) {
      activeYearFilter = years[0];
      _syncYearFilterButtons();
    }

    const searchInput = document.getElementById('pacingSearch');
    if (searchInput) { searchInput.value = ''; const cl = document.getElementById('pacingSearchClear'); if (cl) cl.style.display = 'none'; }

    document.getElementById('loadingState').style.display = '';
    document.getElementById('emptyState').style.display   = 'none';
    document.getElementById('chaptersList').style.display = 'none';

    // Teacher progress link
    const tpBtn = document.getElementById('teacherProgressBtn');
    if (tpBtn && features.teacherProgressBtn && cfg.pacingUrl) {
      tpBtn.href = cfg.pacingUrl;
    }

    const ref = doc(window.db, cfg.collection, docId);
    unsub = onSnapshot(ref, snap => {
      document.getElementById('loadingState').style.display = 'none';
      const data = snap.exists() ? snap.data() : {};
      chapters = Array.isArray(data.chapters) ? data.chapters : [];
      window.chapters = chapters;
      if (typeof data.weeklyHours === 'number') settingsData[subj].weeklyHours = data.weeklyHours;
      render();
    }, err => {
      document.getElementById('loadingState').style.display = 'none';
      console.error('Pacing snapshot error:', err);
      showToast('Failed to load pacing data.', true);
    });
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  function ensureIds() {
    chapters.forEach(ch => {
      if (!ch.id) ch.id = genId();
      (ch.topics || []).forEach(t => { if (!t.id) t.id = genId(); });
    });
  }

  async function saveChapters() {
    if (saving) return;
    saving = true;
    ensureIds();
    try {
      const cfg = subjects[currentSubject];
      await setDoc(doc(window.db, cfg.collection, docId), { chapters, updatedAt: serverTimestamp() }, { merge: true });
    } catch (err) {
      console.error('Save error:', err);
      showToast('Save failed. Check permissions.', true);
    } finally {
      saving = false;
    }
  }

  // ── Year filter (checkpoint) ───────────────────────────────────────────────
  function _syncYearFilterButtons() {
    years.forEach(y => {
      const suffix = y.replace('Year ', '');
      const btn = document.getElementById('yfY' + suffix);
      if (btn) btn.className = 'btn-year-filter' + (activeYearFilter === y ? ` active-y${suffix}` : '');
    });
    const allBtn = document.getElementById('yfAll');
    if (allBtn) allBtn.className = 'btn-year-filter' + (activeYearFilter === 'all' ? ' active-all' : '');
  }

  window.setYearFilter = function(val) {
    activeYearFilter = val;
    _syncYearFilterButtons();
    currentPage = 0;
    render();
  };

  // ── Tier filter ────────────────────────────────────────────────────────────
  window.setTierFilter = function(tier, btn) {
    currentTierFilter = tier;
    if (tierSessionKey) sessionStorage.setItem(tierSessionKey, tier);
    document.querySelectorAll('#tierFilter .tier-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPage = 0;
    render();
  };

  function topicMatchesTier(t) {
    if (currentTierFilter === 'all') return true;
    const refs = t.syllabusRefs || [];
    if (!refs.length) return currentTierFilter === 'all';
    if (currentTierFilter === 'core')     return refs.some(r => /^C/i.test(r));
    if (currentTierFilter === 'extended') return refs.some(r => /^E/i.test(r));
    return true;
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  (function bindSearch() {
    const input = document.getElementById('pacingSearch');
    const clear = document.getElementById('pacingSearchClear');
    if (!input) return;
    input.addEventListener('input', () => {
      searchQuery = input.value.trim().toLowerCase();
      if (clear) clear.style.display = searchQuery ? 'block' : 'none';
      currentPage = 0;
      render();
    });
    if (clear) clear.addEventListener('click', () => {
      input.value = '';
      searchQuery = '';
      clear.style.display = 'none';
      currentPage = 0;
      render();
      input.focus();
    });
  })();

  // ── Filtered chapters ──────────────────────────────────────────────────────
  function getFilteredChapters() {
    const hasSearch    = !!searchQuery;
    const hasTier      = tierSessionKey ? currentTierFilter !== 'all' : false;
    const hasYearFilter = features.gradeFilter && activeYearFilter !== 'all';
    if (!hasSearch && !hasTier && !hasYearFilter) return null;

    const q = searchQuery;
    const result = [];
    chapters.forEach((ch, ci) => {
      if (hasYearFilter && ch.year !== activeYearFilter) return;

      const chTitle  = (ch.chapter || ch.title || '').toLowerCase();
      const chMatch  = hasSearch && chTitle.includes(q);
      const matchedTopics = (ch.topics || []).filter(t => {
        if (hasTier && !topicMatchesTier(t)) return false;
        if (!hasSearch) return true;
        const title = (t.title || t.topic || '').toLowerCase();
        const obj   = stripHtml(t.objectives || t.objective || '').toLowerCase();
        const refs  = (t.syllabusRefs || []).join(' ').toLowerCase();
        return title.includes(q) || obj.includes(q) || refs.includes(q);
      });
      const tierAll = hasTier ? (ch.topics || []).filter(topicMatchesTier) : (ch.topics || []);

      if (chMatch || matchedTopics.length > 0) {
        result.push({ ...ch, _ci: ci, _matchedTopics: chMatch ? tierAll : matchedTopics });
      } else if (!hasSearch && (hasTier || hasYearFilter) && (ch.topics || []).length > 0) {
        if (hasTier && tierAll.length > 0) result.push({ ...ch, _ci: ci, _matchedTopics: tierAll });
      }
    });
    return result;
  }

  // ── GLH Banner ─────────────────────────────────────────────────────────────
  function getVisibleChapters() {
    if (!features.gradeFilter || activeYearFilter === 'all') return chapters;
    return chapters.filter(ch => ch.year === activeYearFilter);
  }

  function getEffectiveGlhTarget() {
    if (!features.gradeFilter) return glhTarget;
    return activeYearFilter === 'all' ? glhTarget : glhTarget / years.length;
  }

  function renderGlhBanner() {
    const banner = document.getElementById('glhBanner');
    if (!banner) return;
    if (!chapters.length) { banner.style.display = 'none'; return; }

    const visible = getVisibleChapters();
    let totalLH = 0;
    visible.forEach(ch => { (ch.topics || []).forEach(t => { if (!t.excluded) totalLH += (t.duration || t.hour || 1); }); });
    const totalPlanned   = toGlh(totalLH);
    const effectiveTarget = getEffectiveGlhTarget();
    const plannedPct      = Math.min(100, (totalPlanned / effectiveTarget) * 100);
    const diff            = Math.round((totalPlanned - effectiveTarget) * 10) / 10;
    const diffLabel       = diff >= 0 ? `+${diff}h over target` : `${Math.abs(diff)}h under target`;
    const threshold       = effectiveTarget > 200 ? 20 : 10;
    const diffClass       = diff > threshold ? 'over' : diff > 0 ? 'warn' : 'ok';
    const totalTopics     = visible.reduce((s, ch) => s + (ch.topics || []).length, 0);

    banner.innerHTML = `
      <div class="glh-banner-head">
        <span class="glh-banner-title">Guided Learning Hours (GLH)</span>
        <span class="glh-banner-nums">${totalPlanned}h planned · ${effectiveTarget}h Cambridge target</span>
      </div>
      <div class="glh-track">
        <div class="glh-fill glh-fill-planned" style="width:${plannedPct.toFixed(1)}%"></div>
      </div>
      <div class="glh-stat-row">
        <div class="glh-stat"><div class="glh-stat-num">${effectiveTarget}h</div><div class="glh-stat-label">GLH Target</div></div>
        <div class="glh-stat"><div class="glh-stat-num">${totalPlanned}h</div><div class="glh-stat-label">Total Planned</div></div>
        <div class="glh-stat ${diffClass}"><div class="glh-stat-num">${diffLabel}</div><div class="glh-stat-label">vs Cambridge</div></div>
        <div class="glh-stat"><div class="glh-stat-num">${totalTopics}</div><div class="glh-stat-label">Total Topics</div></div>
      </div>`;
    banner.style.display = '';
    renderGlhChart();
  }

  function renderGlhChart() {
    const body = document.getElementById('glhChartBody');
    const wrap = document.getElementById('glhChart');
    if (!body || !wrap) return;
    if (!chapters.length) { wrap.style.display = 'none'; return; }

    const visible = getVisibleChapters();
    const totals  = visible.map(ch => ({
      name:  ch.chapter || ch.title || 'Chapter',
      hours: toGlh((ch.topics || []).reduce((s, t) => s + (t.excluded ? 0 : (t.duration || t.hour || 0)), 0)),
    }));
    const maxH = Math.max(...totals.map(c => c.hours), 1);
    body.innerHTML = totals.map(c => {
      const pct = ((c.hours / maxH) * 100).toFixed(1);
      return `<div class="glh-bar-row">
        <div class="glh-bar-label" title="${escHtml(c.name)}">${escHtml(c.name)}</div>
        <div class="glh-bar-track"><div class="glh-bar-fill" style="width:${pct}%"></div></div>
        <div class="glh-bar-val">${c.hours}h</div>
      </div>`;
    }).join('');
    wrap.style.display = '';
  }

  window.toggleGlhChart = function() {
    _glhChartOpen = !_glhChartOpen;
    const body   = document.getElementById('glhChartBody');
    const toggle = document.getElementById('glhChartToggle');
    if (!body || !toggle) return;
    body.style.display = _glhChartOpen ? '' : 'none';
    toggle.innerHTML = `<span>${_glhChartOpen ? '▾' : '▸'}</span> Chapter Hours Breakdown`;
    toggle.classList.toggle('open', _glhChartOpen);
  };

  // ── Print View ─────────────────────────────────────────────────────────────
  window.openPrintView = function() {
    const cfg       = subjects[currentSubject];
    const subjLabel = cfg ? `${programmeLabel} — ${cfg.label} (${cfg.code})` : 'Syllabus Guide';
    const printChapters = features.gradeFilter && activeYearFilter !== 'all'
      ? chapters.filter(ch => ch.year === activeYearFilter)
      : chapters;
    const yearLabel  = features.gradeFilter && activeYearFilter !== 'all' ? activeYearFilter : years.join('–');
    const totalHours = toGlh(printChapters.reduce((s, ch) =>
      s + (ch.topics || []).reduce((ts, t) => ts + (t.duration || t.hour || 0), 0), 0));

    let tableRows = '';
    printChapters.forEach(ch => {
      const topics  = ch.topics || [];
      const chHours = toGlh(topics.reduce((s, t) => s + (t.duration || t.hour || 0), 0));
      tableRows += `<tr class="ch-row"><td colspan="5"><strong>${escHtml(ch.chapter || ch.title || '')}</strong>
        <span class="ch-meta-print"> — ${escHtml(ch.year || '')} · ${topics.length} topics · ${chHours}h</span>
      </td></tr>`;
      topics.forEach((t, ti) => {
        const refs  = (t.syllabusRefs || []).join(', ') || '—';
        const hours = (t.duration || t.hour) ?? '—';
        const week  = t.week ? 'Wk ' + t.week : '—';
        tableRows += `<tr>
          <td>${ti + 1}</td>
          <td>${escHtml(t.title || t.topic || '')}</td>
          <td style="font-size:.85em">${escHtml(refs)}</td>
          <td>${hours}h</td>
          <td>${week}</td>
        </tr>`;
      });
    });

    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${escHtml(subjLabel)} — Pacing Guide</title>
<style>
  body{font-family:Arial,sans-serif;font-size:11pt;color:#111;margin:20px}
  h1{font-size:14pt;margin-bottom:4px}
  .meta{font-size:9pt;color:#555;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{font-size:8pt;text-transform:uppercase;letter-spacing:.05em;background:#f3f3f3;padding:6px 8px;border:1px solid #ccc;text-align:left}
  td{padding:5px 8px;border:1px solid #ddd;vertical-align:top;font-size:10pt}
  .ch-row td{background:#e8f5e9;font-weight:700;font-size:10pt}
  .ch-meta-print{font-weight:400;color:#444;font-size:9pt}
  @media print{body{margin:0}}
</style></head><body>
<h1>${escHtml(subjLabel)}</h1>
<p class="meta">${escHtml(yearLabel)} · Total planned: ${totalHours}h · GLH target: ${getEffectiveGlhTarget()}h · ${printChapters.length} chapters · Printed ${new Date().toLocaleDateString('en-GB')}</p>
<table>
  <thead><tr><th style="width:28px">#</th><th style="width:34%">Topic</th><th style="width:18%">Codes</th><th style="width:7%">Hours</th><th>Week</th></tr></thead>
  <tbody>${tableRows}</tbody>
</table>
<script>window.print();<\/script>
</body></html>`;

    const w = window.open('', '_blank', 'width=900,height=700');
    if (w) { w.document.write(html); w.document.close(); }
  };

  // ── Holiday break helpers ──────────────────────────────────────────────────
  const fmtDate = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  function twEndDate(cumHoursEnd, wh) {
    if (!wh || cumHoursEnd < 0) return null;
    return teachingWeeks[Math.floor(cumHoursEnd / wh)]?.fri ?? null;
  }
  function twStartDate(cumHoursStart, wh) {
    if (!wh || cumHoursStart < 0) return null;
    return teachingWeeks[Math.floor(cumHoursStart / wh)]?.mon ?? null;
  }

  function renderBreakBanners(afterDate, beforeDate) {
    if (!afterDate || !beforeDate || beforeDate <= afterDate) return '';
    const breaks = skippedWeeks.filter(sw => sw.mon > afterDate && sw.mon < beforeDate);
    if (!breaks.length) return '';
    const groups = [];
    [...breaks].sort((a, b) => a.mon - b.mon).forEach(sw => {
      const last = groups[groups.length - 1];
      if (last && last.reason === sw.reason && sw.mon <= new Date(last.fri.getTime() + 8 * 86400000)) {
        last.fri = sw.fri;
      } else {
        groups.push({ reason: sw.reason, mon: new Date(sw.mon), fri: new Date(sw.fri) });
      }
    });
    return groups.map(g => {
      const isEase = /ease/i.test(g.reason);
      const isCamp = /camp/i.test(g.reason);
      const cls  = isEase ? 'ease' : isCamp ? 'camp' : '';
      const icon = isEase ? '📝' : isCamp ? '🏕️' : '🏖️';
      return `<div class="holiday-break ${cls}">
        <span class="holiday-break-icon">${icon}</span>
        <span class="holiday-break-body">
          <span class="holiday-break-label">${escHtml(g.reason)}</span>
          <span class="holiday-break-dates">${fmtDate(g.mon)} – ${fmtDate(g.fri)}</span>
        </span>
      </div>`;
    }).join('');
  }

  // ── Main render ────────────────────────────────────────────────────────────
  function render() {
    const list     = document.getElementById('chaptersList');
    const empty    = document.getElementById('emptyState');
    const pager    = document.getElementById('chapterPager');
    const info     = document.getElementById('pagerInfo');
    const btns     = document.getElementById('pagerBtns');
    const resCount = document.getElementById('searchResultCount');

    renderGlhBanner();

    if (chapters.length === 0) {
      if (list)     list.style.display     = 'none';
      if (pager)    pager.style.display    = 'none';
      if (empty)    empty.style.display    = '';
      if (resCount) resCount.style.display = 'none';
      return;
    }

    const filtered = getFilteredChapters();
    const workList = filtered ?? chapters.map((ch, i) => ({ ...ch, _ci: i, _matchedTopics: ch.topics || [] }));
    const isSearching = !!searchQuery;

    if (filtered !== null) {
      const topicCount = filtered.reduce((s, ch) => s + ch._matchedTopics.length, 0);
      if (resCount) {
        resCount.style.display = '';
        resCount.textContent = filtered.length === 0
          ? 'No results.'
          : `${filtered.length} chapter${filtered.length !== 1 ? 's' : ''}, ${topicCount} topic${topicCount !== 1 ? 's' : ''} found`;
      }
    } else {
      if (resCount) resCount.style.display = 'none';
    }

    if (workList.length === 0) {
      if (list)  list.style.display  = 'none';
      if (pager) pager.style.display = 'none';
      if (empty) empty.style.display = '';
      return;
    }

    if (empty) empty.style.display = 'none';
    if (list)  list.style.display  = '';

    let pageItems;
    if (isSearching || noPaging) {
      pageItems = workList;
      if (pager) pager.style.display = 'none';
    } else {
      const totalPages = Math.max(1, Math.ceil(workList.length / PAGE_SIZE));
      if (currentPage >= totalPages) currentPage = totalPages - 1;
      const start = currentPage * PAGE_SIZE;
      pageItems = workList.slice(start, start + PAGE_SIZE);

      if (!pager) {
        // no pager element
      } else if (totalPages <= 1) {
        pager.style.display = 'none';
      } else {
        pager.style.display = 'flex';
        const end = Math.min(start + PAGE_SIZE, workList.length);
        if (info) info.textContent = `Chapters ${start + 1}–${end} of ${workList.length}`;
        if (btns) {
          btns.innerHTML = '';
          for (let i = 0; i < totalPages; i++) {
            const b = document.createElement('button');
            b.textContent = i + 1;
            b.className = 'pg-btn' + (i === currentPage ? ' active' : '');
            b.addEventListener('click', () => { currentPage = i; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
            btns.appendChild(b);
          }
        }
      }
    }

    // Snapshot open chapters before wiping DOM
    const openIds = new Set([...document.querySelectorAll('.chapter-block:not(.collapsed)')].map(b => b.dataset.chid));

    // Pre-compute cumulative hours for calendar dates
    const wh = settingsData[currentSubject]?.weeklyHours || 0;
    const hasWeeklyHours = (features.calendarDates || features.holidayBanners) && wh > 0;
    const chapterCumulativeHours = [];
    if (hasWeeklyHours) {
      let running = 0;
      let lastYear = null;
      chapters.forEach((ch, ci) => {
        if (features.gradeFilter && lastYear !== null && ch.year !== lastYear) running = 0;
        chapterCumulativeHours[ci] = running;
        (ch.topics || []).forEach(t => { if (!t.excluded) running += (t.duration || t.hour || 0); });
        lastYear = ch.year;
      });
    }

    const htmlParts = pageItems.map(ch =>
      renderChapter(ch, ch._ci, searchQuery, ch._matchedTopics, hasWeeklyHours ? (chapterCumulativeHours[ch._ci] ?? null) : null)
    );

    if (list) {
      list.innerHTML = htmlParts.map((html, i) => {
        let breaks = '';
        if (features.holidayBanners && hasWeeklyHours && i > 0) {
          const afterCh    = pageItems[i - 1];
          const beforeCh   = pageItems[i];
          const afterCum   = chapterCumulativeHours[afterCh._ci];
          const beforeCum  = chapterCumulativeHours[beforeCh._ci];
          if (afterCum != null && beforeCum != null) {
            const afterHours    = (afterCh.topics || []).reduce((s, t) => s + (t.excluded ? 0 : (t.duration || t.hour || 0)), 0);
            const afterEndDate  = twEndDate(afterCum + afterHours - 1, wh);
            const beforeStart   = twStartDate(beforeCum, wh);
            breaks = renderBreakBanners(afterEndDate, beforeStart);
          }
        }
        return breaks + html;
      }).join('');
    }

    if (isSearching) {
      document.querySelectorAll('.chapter-block').forEach(b => b.classList.remove('collapsed'));
    } else if (openIds.size > 0) {
      document.querySelectorAll('.chapter-block').forEach(b => {
        if (openIds.has(b.dataset.chid)) b.classList.remove('collapsed');
      });
    }
  }

  // Collapse delegate — set up once
  (function setupCollapseDelegate() {
    const list = document.getElementById('chaptersList');
    if (!list || list.dataset.collapseDelegate) return;
    list.dataset.collapseDelegate = '1';
    list.addEventListener('click', e => {
      const btn    = e.target.closest('.ch-toggle');
      const header = btn ? null : e.target.closest('.ch-header');
      if (!btn && (!header || e.target.closest('.ch-actions'))) return;
      const target      = (btn || header).closest('.chapter-block');
      const isCollapsed = target.classList.contains('collapsed');
      document.querySelectorAll('.chapter-block').forEach(b => b.classList.add('collapsed'));
      if (isCollapsed) target.classList.remove('collapsed');
    });
  })();

  // ── renderChapter ──────────────────────────────────────────────────────────
  function renderChapter(ch, ci, q = '', matchedTopics = null, chapterStartHours = null) {
    const allTopics     = ch.topics || [];
    const displayTopics = matchedTopics ?? allTopics;

    // Per-topic cumulative hours
    const topicCumulative = [];
    let runningHours = chapterStartHours ?? null;
    allTopics.forEach(t => {
      topicCumulative.push(runningHours);
      if (runningHours !== null && !t.excluded) runningHours += (t.duration || t.hour || 0);
    });

    const wh = settingsData[currentSubject]?.weeklyHours || 0;
    let topicRows;
    if (displayTopics.length > 0) {
      const parts = displayTopics.map((t, dispIdx) => {
        const ti        = allTopics.indexOf(t);
        const topicHtml = renderTopic(t, ti, ci, q, topicCumulative[ti], wh);
        let banner = '';
        if (features.holidayBanners && dispIdx > 0 && wh && skippedWeeks.length) {
          const prevT   = displayTopics[dispIdx - 1];
          const prevTi  = allTopics.indexOf(prevT);
          const prevCum = topicCumulative[prevTi];
          const prevDur = prevT.duration || prevT.hour || 0;
          const curCum  = topicCumulative[ti];
          if (prevCum != null && curCum != null) {
            banner = renderBreakBanners(twEndDate(prevCum + prevDur - 1, wh), twStartDate(curCum, wh));
          }
        }
        return banner + topicHtml;
      });
      topicRows = `<div class="topics-list">${parts.join('')}</div>`;
    } else {
      topicRows = `<div class="no-topics">No topics yet.${isAdmin ? ' Add one below.' : ''}</div>`;
    }

    const reorderBtns = (isAdmin || isCoordinator) ? `
      <button class="btn-reorder" onclick="moveChapter(event,${ci},-1)" title="Move up" ${ci===0?'disabled':''}>↑</button>
      <button class="btn-reorder" onclick="moveChapter(event,${ci},1)"  title="Move down" ${ci===chapters.length-1?'disabled':''}>↓</button>` : '';

    const canEditCh = isAdmin || isCoordinator;
    const chDeleteBtn = isAdmin ? `<button class="btn btn-danger" onclick="deleteChapter(event,${ci})">Delete</button>` : '';
    const chActions = canEditCh ? `<div class="ch-actions">
      ${reorderBtns}
      <button class="btn btn-edit" onclick="editChapter(${ci})">Edit</button>
      ${chDeleteBtn}
    </div>` : '';

    const footer = isAdmin ? (features.bufferTopics ? `
      <div class="ch-footer" id="ch-footer-${ci}">
        <div class="ch-footer-form" id="ch-buffer-form-${ci}">
          <input type="text" id="ch-buffer-label-${ci}" placeholder="Review Time" maxlength="60" style="max-width:200px">
          <label>hrs:</label>
          <input type="number" id="ch-buffer-dur-${ci}" value="1" min="1" max="20" step="1">
          <button class="btn btn-primary btn-sm" onclick="saveBuffer(${ci})">Save</button>
          <button class="btn btn-cancel btn-sm" onclick="cancelBuffer(${ci})">Cancel</button>
        </div>
        <div class="ch-footer-btns" id="ch-footer-btns-${ci}" style="display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm" onclick="openAddTopicModal(${ci})">+ Add Topic</button>
          <button class="btn btn-secondary btn-sm" style="color:#b45309;border-color:#fcd34d;background:#fffbeb" onclick="openAddBuffer(${ci})">+ Add Buffer</button>
        </div>
      </div>` : `
      <div class="ch-footer">
        <button class="btn btn-secondary btn-sm" onclick="openAddTopicModal(${ci})">+ Add Topic</button>
      </div>`) : '';

    return `
      <div class="chapter-block${!q ? ' collapsed' : ''}" data-chid="${escHtml(ch.id || ch.chapter || String(ci))}">
        <div class="ch-header">
          <button class="ch-toggle" title="Toggle chapter" aria-label="Toggle chapter">&#8964;</button>
          <div class="ch-num" aria-hidden="true">${ci + 1}</div>
          <div class="ch-title">${highlight(ch.chapter || ch.title || '', q)}</div>
          <div class="ch-meta">
            ${ch.year ? `<span class="year-badge">${escHtml(ch.year)}</span>` : ''}
            <span class="topic-count">${allTopics.length} topic${allTopics.length !== 1 ? 's' : ''}</span>
          </div>
          ${chActions}
        </div>
        <div class="ch-body">
          ${topicRows}
          ${renderChapterAssessment(ch, ci)}
          ${footer}
        </div>
      </div>`;
  }

  // ── renderTopic ────────────────────────────────────────────────────────────
  function renderTopic(t, ti, ci, q = '', cumulativeBefore = null, wh = 0) {
    // Buffer row
    if (t.type === 'buffer') {
      const dur = t.duration || 0;
      return `<div class="buffer-row">
        <span class="buffer-icon">⏳</span>
        <span class="buffer-label">${escHtml(t.title || 'Buffer')}</span>
        <span class="buffer-hours">⏱ ${dur} Lesson Hour${dur === 1 ? '' : 's'}</span>
        ${isAdmin ? `<button class="btn btn-danger buffer-del btn-sm" onclick="deleteTopic(event,${ci},${ti})">Remove</button>` : ''}
      </div>`;
    }

    const objRaw = t.objectives || t.objective || '';
    const cfg      = subjects[currentSubject];
    const subjCode = cfg ? cfg.code : '';

    // Syllabus refs block
    let syllabusBlock = '';
    if (t.syllabusRefs && t.syllabusRefs.length) {
      const chipLines = t.syllabusRefs.map(code => {
        const { key: indexKey, entry } = lookupSyllabus(subjCode, code);
        const displayCode = q ? highlight(code, q) : escHtml(code);
        const titleText   = entry ? (q ? highlight(entry.title || '', q) : escHtml(entry.title || '')) : '';
        const topicText   = entry ? escHtml(entry.topicArea || '') : '';
        const rawC        = entry?.content;
        const contentArr  = Array.isArray(rawC) ? rawC : (rawC ? [stripHtml(rawC)] : []);
        const rawDesc     = entry?.description || '';
        // Prefer rich description; fall back to content items as plain text
        const descHtmlInline = rawDesc
          ? _sylSafeHtml(rawDesc)
          : (contentArr.length ? escHtml(contentArr.slice(0, 3).join(' · ') + (contentArr.length > 3 ? ' …' : '')) : '');
        return `<div class="syllabus-ref-line">
          <span class="srl-code" data-syl-key="${escHtml(indexKey)}" title="Click to view full detail">${displayCode}</span>
          <span class="srl-topic">${topicText}</span>
          <span class="srl-title">${titleText}</span>
          ${descHtmlInline ? `<div class="srl-desc syl-rich">${descHtmlInline}</div>` : ''}
        </div>`;
      }).join('');
      syllabusBlock = `<div class="topic-syllabus-block"><div class="topic-refs-list">${chipLines}</div></div>`;
    }

    // Objectives block (fallback if no syllabus refs)
    let objHtml = '';
    if (!syllabusBlock && objRaw) {
      if (/<[a-z]/i.test(objRaw)) {
        objHtml = `<div class="topic-objectives obj-rich">${q ? highlightInHtml(objRaw, q) : objRaw}</div>`;
      } else {
        objHtml = `<div class="topic-objectives">${highlight(objRaw, q)}</div>`;
      }
    }

    const dur = t.duration || t.hour;

    // Date label (calendar dates feature)
    let dateLabelHtml = '';
    if (features.calendarDates && cumulativeBefore !== null && dur != null) {
      if (wh > 0) {
        const label = getTopicDateLabel(cumulativeBefore, dur, wh);
        if (label === '__beyond__') {
          dateLabelHtml = `<span class="meta-chip chip-date chip-beyond" title="This topic falls beyond the current teaching schedule">📅 Beyond schedule</span>`;
        } else if (label) {
          dateLabelHtml = `<span class="meta-chip chip-date" title="Estimated teaching dates">📆 ${escHtml(label)}</span>`;
        }
      }
    }

    // Hours chip — clickable for admin or coordinator
    const hoursChip = (isAdmin || isCoordinator)
      ? `<span class="meta-chip chip-hours" title="Click to edit lesson hours" onclick="inlineEditChip(event,'hours',${ci},${ti})">⏱ ${dur != null ? dur + ' Lesson Hour' + (dur === 1 ? '' : 's') : '—'}</span>`
      : `<span class="meta-chip chip-hours">⏱ ${dur != null ? dur + ' Lesson Hour' + (dur === 1 ? '' : 's') : '—'}</span>`;

    // AO badges (IGCSE)
    const aoBadgeHtml = features.aoBadges ? renderAoBadges(t) : '';
    // Paper badges (IGCSE)
    const paperBadgeHtml = features.paperBadges ? renderPaperBadge(t) : '';

    const resources = (t.resources || []).map(r =>
      `<a href="${safeUrl(r.url)}" target="_blank" rel="noopener noreferrer" class="resource-link">${escHtml(r.name)}</a>`
    ).join('');

    const chipsLeft = [hoursChip, dateLabelHtml, aoBadgeHtml, paperBadgeHtml, resources].filter(Boolean).join('');

    // Right-side chips: week chip + semester widget for admin
    let chipsRight = '';
    if (isAdmin) {
      const weekChipRight = t.week != null
        ? `<span class="meta-chip chip-week" title="Click to edit week" onclick="inlineEditChip(event,'week',${ci},${ti})">📅 Week ${t.week}</span>`
        : `<span class="meta-chip chip-week" title="Click to edit week" onclick="inlineEditChip(event,'week',${ci},${ti})">📅 —</span>`;
      const semChip = t.semester === 1
        ? `<span class="meta-chip chip-sem1" title="Click to change semester" onclick="cycleSemesterChip(event,${ci},${ti})">Sem I</span>`
        : t.semester === 2
          ? `<span class="meta-chip chip-sem2" title="Click to change semester" onclick="cycleSemesterChip(event,${ci},${ti})">Sem II</span>`
          : `<span class="meta-chip" style="opacity:0.45" title="Click to set semester" onclick="cycleSemesterChip(event,${ci},${ti})">Sem —</span>`;
      chipsRight = [weekChipRight, semChip].join('');
    }

    // Activity button / link
    const activityHtml = t.activity
      ? `<a href="${safeUrl(t.activity.url)}" target="_blank" rel="noopener noreferrer"
            class="activity-chip ${escHtml(t.activity.type)}" title="${escHtml(t.activity.title)}"
          >${escHtml(t.activity.type === 'igcsetools' ? 'IGCSE Tools' : t.activity.type === 'pdf' ? 'PDF' : 'Link')} — ${escHtml(t.activity.title)}</a>
         ${isAdmin ? `<button class="btn btn-edit" style="font-size:0.7rem;padding:2px 7px"
           onclick="openAssessmentModal({type:'topic',ci:${ci},ti:${ti}},window.chapters[${ci}].topics[${ti}].activity)">Edit</button>
         <button class="btn btn-danger" style="font-size:0.7rem;padding:2px 7px"
           onclick="removeActivity(event,${ci},${ti})">Remove</button>` : ''}`
      : (isAdmin ? `<button class="btn btn-secondary btn-sm" style="font-size:0.7rem;padding:2px 8px"
           onclick="openAssessmentModal({type:'topic',ci:${ci},ti:${ti}})">+ Activity</button>` : '');

    // Topic reorder buttons
    const topicReorderHtml = (features.topicReorder && isAdmin) ? `
      <div style="display:flex;gap:3px">
        <button class="btn-reorder" onclick="moveTopic(${ci},${ti},-1)" title="Move up" ${ti===0?'disabled':''}>↑</button>
        <button class="btn-reorder" onclick="moveTopic(${ci},${ti},1)" title="Move down" ${ti===chapters[ci].topics.length-1?'disabled':''}>↓</button>
      </div>` : '';

    const canEditHours = isAdmin || isCoordinator;
    const excludeBtn = canEditHours
      ? `<button class="btn-exclude" onclick="toggleExcluded(${ci},${ti})" title="${t.excluded ? 'Mark as covered' : 'Mark as not covered'}">${t.excluded ? '↩ Include' : '✕ Not Covered'}</button>`
      : '';

    const editBtn   = canEditHours ? `<button class="btn btn-edit" onclick="editTopic(${ci},${ti})">Edit</button>` : '';
    const deleteBtn = isAdmin      ? `<button class="btn btn-danger" onclick="deleteTopic(event,${ci},${ti})">Delete</button>` : '';
    const actionsHtml = (canEditHours || isAdmin) ? `<div class="topic-actions">
      ${topicReorderHtml}
      ${excludeBtn}
      ${editBtn}
      ${deleteBtn}
    </div>` : '';

    return `<div class="topic-row${t.excluded ? ' topic-excluded' : ''}">
      <div class="topic-num">${ti + 1}</div>
      <div class="topic-main">
        <div class="topic-title">${highlight(t.title || t.topic || '', q)}</div>
        ${syllabusBlock || objHtml}
        <div class="topic-meta-row">
          <div class="topic-meta-left">${chipsLeft}<div class="activity-row">${activityHtml}</div></div>
          ${chipsRight ? `<div class="topic-meta-right">${chipsRight}</div>` : ''}
        </div>
      </div>
      ${actionsHtml}
    </div>`;
  }

  // ── renderChapterAssessment ────────────────────────────────────────────────
  function renderChapterAssessment(ch, ci) {
    const a = ch.assessment;
    const typeLabel = a ? (a.type === 'igcsetools' ? 'IGCSE Tools' : a.type === 'pdf' ? 'PDF' : 'External') : '';
    return `<div class="ch-assessment">
      <span class="ch-assessment-label">Chapter Assessment</span>
      ${a ? `
        <span class="asmnt-badge ${escHtml(a.type)}">${typeLabel}</span>
        <span class="asmnt-title">${escHtml(a.title)}</span>
        ${a.duration ? `<span class="asmnt-duration">${escHtml(a.duration)}</span>` : ''}
        <a href="${safeUrl(a.url)}" target="_blank" rel="noopener noreferrer" class="asmnt-open-link">Open ↗</a>
        ${isAdmin ? `
          <button class="btn btn-edit btn-sm" onclick="openAssessmentModal({type:'chapter',ci:${ci}},window.chapters[${ci}].assessment)">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="removeAssessment(event,${ci})">Remove</button>` : ''}
      ` : `
        ${isAdmin ? `<button class="btn btn-secondary btn-sm" onclick="openAssessmentModal({type:'chapter',ci:${ci}})">+ Add Assessment</button>` : ''}
      `}
    </div>`;
  }

  // ── Move chapter / topic (reorder) ─────────────────────────────────────────
  async function moveChapter(e, ci, dir) {
    e.stopPropagation();
    const ni = ci + dir;
    if (ni < 0 || ni >= chapters.length) return;
    [chapters[ci], chapters[ni]] = [chapters[ni], chapters[ci]];
    await saveChapters();
    showToast('Chapter order updated.');
    render();
  }

  async function moveTopic(ci, ti, dir) {
    const topics = chapters[ci].topics;
    const ni = ti + dir;
    if (ni < 0 || ni >= topics.length) return;
    [topics[ti], topics[ni]] = [topics[ni], topics[ti]];
    await saveChapters();
  }

  // ── Inline chip edit ───────────────────────────────────────────────────────
  window.inlineEditChip = function(e, field, ci, ti) {
    e.stopPropagation();
    const chip  = e.currentTarget;
    const topic = chapters[ci].topics[ti];
    const current = field === 'hours' ? (topic.duration ?? topic.hour ?? '') : (topic.week ?? '');
    chip.innerHTML = `<input class="chip-inline-input" type="number" min="1" max="${field === 'hours' ? 60 : 52}"
      value="${current}" placeholder="${field === 'hours' ? 'e.g. 2' : 'e.g. 5'}" onclick="event.stopPropagation()">`;
    const inp = chip.querySelector('input');
    inp.focus(); inp.select();
    function commit() {
      const raw = inp.value.trim();
      const val = parseInt(raw);
      if (field === 'hours') {
        if (!isNaN(val) && val > 0) { topic.duration = val; topic.hour = val; saveChapters().then(() => showToast('Lesson hours updated.')); }
      } else {
        // Allow clearing week to null (empty input = no scheduled week)
        if (raw === '' || raw === '0') { topic.week = null; saveChapters().then(() => showToast('Week cleared.')); }
        else if (!isNaN(val) && val > 0) { topic.week = val; saveChapters().then(() => showToast('Week updated.')); }
      }
      render();
    }
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter')  { ev.preventDefault(); inp.removeEventListener('blur', commit); commit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); inp.removeEventListener('blur', commit); render(); }
    });
  };

  // ── Toggle excluded ────────────────────────────────────────────────────────
  window.toggleExcluded = async function(ci, ti) {
    if (!isAdmin && !isCoordinator) return;
    const t = chapters[ci].topics[ti];
    t.excluded = !t.excluded;
    await saveChapters();
    showToast(t.excluded ? 'Topic marked as not covered.' : 'Topic included.');
    render();
  };

  // ── Chapter CRUD ───────────────────────────────────────────────────────────
  function openAddChapterModal() {
    if (!isAdmin) return;
    modalMode = 'add-chapter';
    editChIdx = null;
    _modalDirty = false;
    document.getElementById('chModalTitle').textContent = 'Add Chapter';
    document.getElementById('chTitleInput').value       = '';
    document.getElementById('chYearSelect').value       = years[0] || '';
    document.getElementById('chapterModal').classList.add('open');
    document.getElementById('chTitleInput').focus();
  }

  function editChapter(ci) {
    if (!isAdmin && !isCoordinator) return;
    modalMode = 'edit-chapter';
    editChIdx = ci;
    _modalDirty = false;
    const ch = chapters[ci];
    document.getElementById('chModalTitle').textContent = 'Edit Chapter';
    document.getElementById('chTitleInput').value       = ch.chapter || ch.title || '';
    document.getElementById('chYearSelect').value       = ch.year || years[0] || '';
    document.getElementById('chapterModal').classList.add('open');
    document.getElementById('chTitleInput').focus();
  }

  async function saveChapterModal() {
    const title = document.getElementById('chTitleInput').value.trim();
    const year  = document.getElementById('chYearSelect').value;
    if (!title) { document.getElementById('chTitleInput').focus(); return; }

    if (modalMode === 'add-chapter') {
      chapters.push({ id: genId(), chapter: title, year, topics: [] });
    } else {
      chapters[editChIdx] = { ...chapters[editChIdx], chapter: title, year };
    }
    _modalDirty = false;
    closeChapterModal();
    await saveChapters();
    showToast(modalMode === 'add-chapter' ? 'Chapter added.' : 'Chapter updated.');
  }

  function closeChapterModal() {
    if (_modalDirty) { showToast('Changes discarded.'); _modalDirty = false; }
    document.getElementById('chapterModal').classList.remove('open');
  }

  async function deleteChapter(e, ci) {
    e.stopPropagation();
    const btn = e.currentTarget;
    if (btn.dataset.confirming !== 'true') {
      btn.dataset.confirming = 'true';
      btn.textContent = 'Confirm?';
      setTimeout(() => { btn.dataset.confirming = 'false'; btn.textContent = 'Delete'; }, 3000);
      return;
    }
    chapters.splice(ci, 1);
    await saveChapters();
    showToast('Chapter deleted.');
  }

  // ── RTE helpers ────────────────────────────────────────────────────────────
  window._rteExec = function(cmd) {
    document.getElementById('topObjectivesEditor').focus();
    document.execCommand(cmd, false, null);
  };
  window._rteClear = function() {
    document.getElementById('topObjectivesEditor').innerHTML = '';
    document.getElementById('topObjectivesEditor').focus();
  };

  // ── Topic CRUD ─────────────────────────────────────────────────────────────
  function openAddTopicModal(ci) {
    if (!isAdmin) return;
    modalMode  = 'add-topic';
    editChIdx  = ci;
    editTopIdx = null;
    _modalDirty = false;
    modalResources    = [];
    modalSyllabusRefs = [];
    document.getElementById('topModalTitle').textContent     = 'Add Topic';
    document.getElementById('topTitleInput').value           = '';
    document.getElementById('topDurationInput').value        = '';
    document.getElementById('topObjectivesEditor').innerHTML = '';
    const weekInput = document.getElementById('topStartWeekInput');
    if (weekInput) weekInput.value = '';
    if (features.semesterChips) _setModalSemester(0);
    renderModalResources();
    renderSyllabusChips();
    initSyllabusPicker();
    document.getElementById('topicModal').classList.add('open');
    document.getElementById('topTitleInput').focus();
  }

  function editTopic(ci, ti) {
    if (!isAdmin && !isCoordinator) return;
    modalMode  = 'edit-topic';
    editChIdx  = ci;
    editTopIdx = ti;
    _modalDirty = false;
    const t = chapters[ci].topics[ti];
    modalResources    = (t.resources || []).map(r => ({ ...r }));
    modalSyllabusRefs = (t.syllabusRefs || []).slice();
    document.getElementById('topModalTitle').textContent     = 'Edit Topic';
    document.getElementById('topTitleInput').value           = t.title || t.topic || '';
    document.getElementById('topDurationInput').value        = t.duration || t.hour || '';
    const weekInput = document.getElementById('topStartWeekInput');
    if (weekInput) weekInput.value = t.week || '';
    if (features.semesterChips) _setModalSemester(t.semester || 0);
    const rawObj = t.objectives || t.objective || '';
    document.getElementById('topObjectivesEditor').innerHTML =
      typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(rawObj) : rawObj;
    renderModalResources();
    renderSyllabusChips();
    initSyllabusPicker();
    document.getElementById('topicModal').classList.add('open');
    document.getElementById('topTitleInput').focus();
  }

  function renderModalResources() {
    const container = document.getElementById('resourcesList');
    const colHeads  = document.getElementById('resColHeads');
    if (!container) return;
    if (modalResources.length === 0) {
      if (colHeads) colHeads.style.display = 'none';
      container.innerHTML = '<p class="no-resources">No resource links added yet.</p>';
      return;
    }
    if (colHeads) colHeads.style.display = 'flex';
    container.innerHTML = modalResources.map((r, i) => `
      <div class="resource-row">
        <input class="form-input" type="text" placeholder="Link name" value="${escHtml(r.name)}">
        <input class="form-input url-input" type="url" placeholder="https://…" value="${escHtml(r.url)}">
        <button class="res-del-btn" type="button" onclick="removeModalResource(${i})" title="Remove">✕</button>
      </div>`).join('');
  }

  function readModalResourcesFromDOM() {
    return Array.from(document.querySelectorAll('#resourcesList .resource-row')).map(row => {
      const inputs = row.querySelectorAll('input');
      return { name: inputs[0].value.trim(), url: inputs[1].value.trim() };
    }).filter(r => r.name || r.url);
  }

  window.addModalResource = function() {
    modalResources = readModalResourcesFromDOM();
    modalResources.push({ name: '', url: '' });
    renderModalResources();
    const rows = document.querySelectorAll('#resourcesList .resource-row');
    if (rows.length) rows[rows.length - 1].querySelector('input').focus();
  };
  window.removeModalResource = function(i) {
    modalResources = readModalResourcesFromDOM();
    modalResources.splice(i, 1);
    renderModalResources();
  };

  async function saveTopicModal() {
    const title      = document.getElementById('topTitleInput').value.trim();
    const duration   = parseInt(document.getElementById('topDurationInput').value) || null;
    const weekEl     = document.getElementById('topStartWeekInput');
    const startWeek  = weekEl ? (parseInt(weekEl.value) || null) : null;
    const objectives = document.getElementById('topObjectivesEditor').innerHTML.trim();
    if (!title) { document.getElementById('topTitleInput').focus(); return; }

    const resources = readModalResourcesFromDOM();
    const topic = {
      topic:        title,
      title:        title,
      hour:         duration,
      duration:     duration,
      week:         startWeek,
      objective:    objectives,
      objectives:   objectives,
      resources,
      syllabusRefs: modalSyllabusRefs.slice(),
    };
    if (features.semesterChips) topic.semester = _modalSemester || null;

    if (modalMode === 'add-topic') {
      if (!chapters[editChIdx].topics) chapters[editChIdx].topics = [];
      topic.id = genId();
      chapters[editChIdx].topics.push(topic);
    } else {
      chapters[editChIdx].topics[editTopIdx] = { ...chapters[editChIdx].topics[editTopIdx], ...topic };
    }
    _modalDirty = false;
    closeTopicModal();
    await saveChapters();
    showToast(modalMode === 'add-topic' ? 'Topic added.' : 'Topic updated.');
  }

  function closeTopicModal() {
    if (_modalDirty) { showToast('Changes discarded.'); _modalDirty = false; }
    document.getElementById('topicModal').classList.remove('open');
  }

  async function deleteTopic(e, ci, ti) {
    e.stopPropagation();
    const btn = e.currentTarget;
    if (btn.dataset.confirming !== 'true') {
      const orig = btn.textContent;
      btn.dataset.confirming = 'true';
      btn.textContent = 'Confirm?';
      setTimeout(() => { btn.dataset.confirming = 'false'; btn.textContent = orig; }, 3000);
      return;
    }
    chapters[ci].topics.splice(ti, 1);
    await saveChapters();
    showToast('Topic deleted.');
  }

  // ── Buffer topics ──────────────────────────────────────────────────────────
  window.openAddBuffer = function(ci) {
    document.getElementById(`ch-footer-btns-${ci}`).style.display = 'none';
    const form = document.getElementById(`ch-buffer-form-${ci}`);
    form.classList.add('open');
    const inp = document.getElementById(`ch-buffer-label-${ci}`);
    inp.value = '';
    document.getElementById(`ch-buffer-dur-${ci}`).value = '1';
    inp.focus();
  };
  window.cancelBuffer = function(ci) {
    document.getElementById(`ch-buffer-form-${ci}`).classList.remove('open');
    document.getElementById(`ch-footer-btns-${ci}`).style.display = 'flex';
  };
  window.saveBuffer = async function(ci) {
    const label = document.getElementById(`ch-buffer-label-${ci}`).value.trim() || 'Review Time';
    const dur   = parseInt(document.getElementById(`ch-buffer-dur-${ci}`).value, 10) || 1;
    if (!chapters[ci]) return;
    chapters[ci].topics = chapters[ci].topics || [];
    chapters[ci].topics.push({ type: 'buffer', title: label, duration: dur });
    await saveChapters();
    window.cancelBuffer(ci);
    render();
    showToast('Buffer added.');
  };

  // ── Semester chips (checkpoint) ────────────────────────────────────────────
  window.cycleSemesterChip = async function(e, ci, ti) {
    e.stopPropagation();
    const t = chapters[ci].topics[ti];
    const next = !t.semester ? 1 : t.semester === 1 ? 2 : null;
    t.semester = next;
    await saveChapters();
    showToast(next ? `Semester ${next === 1 ? 'I' : 'II'} set.` : 'Semester cleared.');
    render();
  };

  function _setModalSemester(val) {
    _modalSemester = val;
    _modalDirty = true;
    const b0 = document.getElementById('semBtn0');
    const b1 = document.getElementById('semBtn1');
    const b2 = document.getElementById('semBtn2');
    if (b0) b0.className = 'sem-btn' + (val === 0 ? ' active-s1' : '');
    if (b1) b1.className = 'sem-btn' + (val === 1 ? ' active-s1' : '');
    if (b2) b2.className = 'sem-btn' + (val === 2 ? ' active-s2' : '');
  }
  window.setModalSemester = function(val) { _setModalSemester(val); };

  // ── Assessment Modal ───────────────────────────────────────────────────────
  document.getElementById('asmntPdfInput')?.addEventListener('change', e => {
    _asmntPdfFile = e.target.files[0] || null;
    document.getElementById('asmntPdfName').textContent = _asmntPdfFile ? _asmntPdfFile.name : 'No file chosen';
  });

  function openAssessmentModal(context, existing) {
    if (!isAdmin) return;
    _asmntContext = context;
    _asmntPdfFile = null;
    document.getElementById('asmntPdfName').textContent = 'No file chosen';
    document.getElementById('asmntPdfInput').value = '';
    document.getElementById('asmntTitleError').style.display = 'none';
    document.getElementById('asmntUrlError').style.display   = 'none';
    document.getElementById('asmntUploadProgress').classList.remove('visible');

    const isChapter = context.type === 'chapter';
    document.getElementById('asmntModalTitle').textContent = existing
      ? (isChapter ? 'Edit Chapter Assessment' : 'Edit Topic Activity')
      : (isChapter ? 'Add Chapter Assessment' : 'Add Topic Activity');
    document.getElementById('asmntDurationGroup').style.display = isChapter ? '' : 'none';
    document.getElementById('asmntTitleInput').value       = existing?.title    || '';
    document.getElementById('asmntTypeSelect').value       = existing?.type     || 'igcsetools';
    document.getElementById('asmntUrlInput').value         = (existing?.type !== 'pdf' ? existing?.url : '') || '';
    document.getElementById('asmntExistingPdfUrl').value   = (existing?.type === 'pdf' ? existing?.url : '') || '';
    document.getElementById('asmntDurationInput').value    = existing?.duration || '';

    onAsmntTypeChange();
    document.getElementById('assessmentModal').classList.add('open');
    setTimeout(() => document.getElementById('asmntTitleInput').focus(), 80);
  }

  function closeAssessmentModal() {
    document.getElementById('assessmentModal').classList.remove('open');
    _asmntContext = null;
    _asmntPdfFile = null;
  }

  function onAsmntTypeChange() {
    const type = document.getElementById('asmntTypeSelect').value;
    document.getElementById('asmntUrlGroup').style.display = type === 'pdf' ? 'none' : '';
    document.getElementById('asmntPdfGroup').style.display = type === 'pdf' ? '' : 'none';
    document.getElementById('asmntUrlError').style.display = 'none';
  }

  async function saveAssessmentModal() {
    const title = document.getElementById('asmntTitleInput').value.trim();
    const type  = document.getElementById('asmntTypeSelect').value;
    if (!title) { document.getElementById('asmntTitleError').style.display = 'block'; return; }

    let url = '';
    if (type === 'pdf') {
      const existingUrl = document.getElementById('asmntExistingPdfUrl').value.trim();
      if (_asmntPdfFile) {
        const btn  = document.getElementById('asmntSaveBtn');
        const prog = document.getElementById('asmntUploadProgress');
        btn.disabled = true;
        prog.classList.add('visible');
        try {
          const cfg     = subjects[currentSubject];
          const chId    = chapters[_asmntContext.ci]?.id || `ch${_asmntContext.ci}`;
          const path    = `pacing-assessments/${cfg.collection}/${chId}/${_asmntPdfFile.name}`;
          const storage = getStorage(window.firebaseApp);
          const fileRef = storageRef(storage, path);
          await uploadBytes(fileRef, _asmntPdfFile);
          url = await getDownloadURL(fileRef);
        } catch (err) {
          console.error('Upload failed', err);
          showToast('Upload failed. Check storage rules.', true);
          document.getElementById('asmntSaveBtn').disabled = false;
          document.getElementById('asmntUploadProgress').classList.remove('visible');
          return;
        }
        btn.disabled = false;
        prog.classList.remove('visible');
      } else if (/^https?:\/\//i.test(existingUrl)) {
        url = existingUrl;
      } else {
        document.getElementById('asmntUrlError').style.display = 'block';
        return;
      }
    } else {
      url = document.getElementById('asmntUrlInput').value.trim();
      if (!/^https?:\/\//i.test(url)) { document.getElementById('asmntUrlError').style.display = 'block'; return; }
    }

    const obj = { type, url, title };
    if (_asmntContext.type === 'chapter') {
      const dur = document.getElementById('asmntDurationInput').value.trim();
      if (dur) obj.duration = dur;
      chapters[_asmntContext.ci].assessment = obj;
    } else {
      chapters[_asmntContext.ci].topics[_asmntContext.ti].activity = obj;
    }
    await saveChapters();
    closeAssessmentModal();
    showToast('Assessment saved.');
  }

  function removeAssessment(event, ci) {
    const btn = event.currentTarget;
    if (btn.dataset.confirming) {
      chapters[ci].assessment = null;
      saveChapters().then(() => showToast('Assessment removed.'));
    } else {
      btn.dataset.confirming = '1';
      btn.textContent = 'Confirm remove';
      setTimeout(() => { btn.textContent = 'Remove'; delete btn.dataset.confirming; }, 3000);
    }
  }

  function removeActivity(event, ci, ti) {
    const btn = event.currentTarget;
    if (btn.dataset.confirming) {
      chapters[ci].topics[ti].activity = null;
      saveChapters().then(() => showToast('Activity removed.'));
    } else {
      btn.dataset.confirming = '1';
      btn.textContent = 'Confirm remove';
      setTimeout(() => { btn.textContent = 'Remove'; delete btn.dataset.confirming; }, 3000);
    }
  }

  // ── Settings Panel ─────────────────────────────────────────────────────────
  function showSettingsPanel() {
    if (settingsMode === 'modal') {
      const panel = document.getElementById('settingsPanel');
      if (!panel) return;
      const willOpen = panel.style.display === 'none' || panel.style.display === '';
      panel.style.display = willOpen ? 'flex' : 'none';
      if (willOpen) loadAllSettings();
      return;
    }
    // inline mode
    document.getElementById('settingsPanel').style.display     = '';
    document.getElementById('contentActionBar').style.display  = 'none';
    document.getElementById('loadingState').style.display      = 'none';
    document.getElementById('emptyState').style.display        = 'none';
    document.getElementById('chaptersList').style.display      = 'none';
    document.getElementById('chapterPager').style.display      = 'none';
    document.getElementById('glhBanner').style.display         = 'none';
    document.getElementById('glhChart').style.display          = 'none';
    const sw = document.getElementById('pacingSearch')?.closest('.pacing-search-wrap');
    if (sw) sw.style.display = 'none';
    const rc = document.getElementById('searchResultCount');
    if (rc) rc.style.display = 'none';
    loadAllSettings();
  }

  function hideSettingsPanel() {
    document.getElementById('settingsPanel').style.display    = 'none';
    document.getElementById('contentActionBar').style.display = '';
    const sw = document.getElementById('pacingSearch')?.closest('.pacing-search-wrap');
    if (sw) sw.style.display = '';
  }

  async function loadAllSettings() {
    const db = window.db;
    const { getDoc: _getDoc, doc: _doc } = window.__firestoreHelpers;

    // Load all subject docs in parallel, then render once
    await Promise.all(Object.keys(subjects).map(async subj => {
      try {
        const snap = await _getDoc(_doc(db, subjects[subj].collection, docId));
        if (snap.exists()) {
          const d = snap.data();
          settingsData[subj] = {
            classes:     Array.isArray(d.classes) ? d.classes : [],
            objPrefixes: Array.isArray(d.objPrefixes) ? d.objPrefixes.join(', ') : (settingsData[subj].objPrefixes || ''),
            weeklyHours: typeof d.weeklyHours === 'number' ? d.weeklyHours : (settingsData[subj].weeklyHours || 0),
          };
        }
      } catch (err) { console.error('Settings load error:', err); }
    }));
    renderClassGroups();
    renderObjSettings();

    // Calendar settings read-only display
    try {
      const snap = await _getDoc(_doc(db, 'calendar_settings', 'current'));
      const display = document.getElementById('calSettingsDisplay');
      if (!display) return;
      if (snap.exists()) {
        const d = snap.data();
        const start = d.academicYearStart
          ? new Date(d.academicYearStart + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          : '—';
        const weeks = d.totalTeachingWeeks ?? teachingWeeks.length ?? '—';
        display.textContent = `Academic year start: ${start} · Teaching weeks: ${weeks}`;
      } else {
        display.textContent = 'No calendar settings configured yet.';
      }
    } catch { /* calendar settings display is non-critical */ }
  }

  window.switchClassSubj = function(subj, btn) {
    settingsClassSubj = subj;
    document.querySelectorAll('#classSubjTabs .s-stab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderClassGroups();
  };
  window.switchObjSubj = function(subj, btn) {
    settingsObjSubj = subj;
    document.querySelectorAll('#objSubjTabs .s-stab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderObjSettings();
  };

  function renderClassGroups() {
    const data = settingsData[settingsClassSubj];
    const wrap = document.getElementById('classGroupsList');
    if (!wrap) return;
    wrap.innerHTML = data.classes.length
      ? `<div class="class-tags-wrap">${data.classes.map((cls, i) =>
          `<span class="class-tag">${escHtml(cls)}<button class="class-tag-del" onclick="removeClassGroup(${i})" title="Remove">✕</button></span>`
        ).join('')}</div>`
      : '<p class="no-classes-hint">No class groups defined yet.</p>';
  }

  window.addClassGroup = function() {
    const inp = document.getElementById('newClassInput');
    const val = (inp.value || '').trim();
    if (!val) { inp.focus(); return; }
    const data = settingsData[settingsClassSubj];
    if (!data.classes.includes(val)) data.classes.push(val);
    inp.value = '';
    renderClassGroups();
    inp.focus();
  };
  window.removeClassGroup = function(i) {
    settingsData[settingsClassSubj].classes.splice(i, 1);
    renderClassGroups();
  };
  window.saveClassGroups = async function() {
    const subj = settingsClassSubj;
    const data = settingsData[subj];
    const btn  = document.getElementById('saveClassGroupsBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const { doc: _doc, setDoc: _setDoc, serverTimestamp: _ts } = window.__firestoreHelpers;
      await _setDoc(_doc(window.db, subjects[subj].collection, docId),
        { classes: data.classes, updatedAt: _ts() }, { merge: true });
      showToast(`Class groups saved for ${subjects[subj].label}.`);
    } catch (err) { console.error(err); showToast('Save failed.', true); }
    finally { if (btn) { btn.disabled = false; btn.textContent = 'Save Class Groups'; } }
  };

  function renderObjSettings() {
    const data  = settingsData[settingsObjSubj];
    const prefInp = document.getElementById('objPrefixInput');
    if (prefInp) prefInp.value = data.objPrefixes || '';
    const hoursGroup = document.getElementById('weeklyHoursGroup');
    if (hoursGroup) hoursGroup.style.display = '';
    const label = document.getElementById('weeklyHoursLabel');
    if (label) label.textContent = `${subjects[settingsObjSubj]?.label || ''} lesson hours per week`;
    const hoursInp = document.getElementById('weeklyHoursInput');
    if (hoursInp) hoursInp.value = data.weeklyHours || '';
  }

  window.saveObjSettings = async function() {
    const subj    = settingsObjSubj;
    const prefRaw = (document.getElementById('objPrefixInput').value || '').trim();
    const prefixes = prefRaw.split(',').map(s => s.trim()).filter(Boolean);
    settingsData[subj].objPrefixes = prefRaw;
    const payload = { objPrefixes: prefixes };
    const h = parseInt(document.getElementById('weeklyHoursInput')?.value || '0');
    if (!isNaN(h) && h > 0) { settingsData[subj].weeklyHours = h; payload.weeklyHours = h; }
    const btn = document.getElementById('saveObjBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const { doc: _doc, setDoc: _setDoc, serverTimestamp: _ts } = window.__firestoreHelpers;
      await _setDoc(_doc(window.db, subjects[subj].collection, docId),
        { ...payload, updatedAt: _ts() }, { merge: true });
      if (currentSubject === subj) render();
      showToast(`Settings saved for ${subjects[subj].label}.`);
    } catch (err) { console.error(err); showToast('Save failed.', true); }
    finally { if (btn) { btn.disabled = false; btn.textContent = 'Save Settings'; } }
  };

  // ── Wire up all modal event listeners & global onclick exposure ────────────
  // Syllabus detail
  document.getElementById('syllabusDetailCloseBtn')?.addEventListener('click', closeSyllabusDetail);
  document.getElementById('syllabusDetailFooterClose')?.addEventListener('click', closeSyllabusDetail);
  document.getElementById('syllabusDetailEditBtn')?.addEventListener('click', () => {
    const key = document.getElementById('syllabusDetailModal').dataset.currentKey;
    closeSyllabusDetail();
    openSyllabusEditor(key);
  });

  // Syllabus editor
  document.getElementById('syllabusEditorCloseBtn')?.addEventListener('click', closeSyllabusEditor);
  document.getElementById('syllabusEditorCloseFooter')?.addEventListener('click', closeSyllabusEditor);
  document.getElementById('editSyllabusBtn')?.addEventListener('click', () => openSyllabusEditor());
  document.getElementById('syllabusEditorSaveBtn')?.addEventListener('click', saveSyllabusEntry);

  // Settings toggle (modal mode)
  document.getElementById('settingsToggleBtn')?.addEventListener('click', showSettingsPanel);
  document.getElementById('settingsPanelCloseBtn')?.addEventListener('click', hideSettingsPanel);

  // Delegated: srl-code chips → syllabus detail
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-syl-key]');
    if (chip) openSyllabusDetail(chip.dataset.sylKey);
  });

  // Backdrop clicks close modals
  document.getElementById('chapterModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeChapterModal(); });
  document.getElementById('topicModal')?.addEventListener('click',   e => { if (e.target === e.currentTarget) closeTopicModal(); });
  document.getElementById('assessmentModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeAssessmentModal(); });
  document.getElementById('teachSchedModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeTeachingScheduleModal(); });

  // Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeChapterModal();
      closeTopicModal();
      closeAssessmentModal();
      closeSyllabusDetail();
      closeTeachingScheduleModal();
    }
  });

  // Expose all functions that inline onclick= handlers call
  Object.assign(window, {
    // Chapter CRUD
    openAddChapterModal,
    editChapter,
    deleteChapter,
    saveChapterModal,
    closeChapterModal,
    // Topic CRUD
    openAddTopicModal,
    editTopic,
    deleteTopic,
    saveTopicModal,
    closeTopicModal,
    // Assessment
    openAssessmentModal,
    closeAssessmentModal,
    onAsmntTypeChange,
    saveAssessmentModal,
    removeAssessment,
    removeActivity,
    // Syllabus
    openSyllabusDetail,
    closeSyllabusDetail,
    openSyllabusEditor,
    closeSyllabusEditor,
    saveSyllabusEntry,
    removeSyllabusChip,
    // Teaching Schedule
    openTeachingScheduleModal,
    closeTeachingScheduleModal,
    // Reorder
    moveChapter,
    moveTopic,
    // Settings (in addition to window.switch* already assigned above)
    showSettingsPanel,
    hideSettingsPanel,
    toggleSettingsPanel: showSettingsPanel, // alias for modal-mode onclick handlers
  });
}
