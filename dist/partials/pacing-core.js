/**
 * pacing-core.js — shared JS for all pacing pages (IGCSE, Checkpoint, AS-Level).
 *
 * Each subject page sets window.PACING_CONFIG before importing this module:
 *   window.PACING_CONFIG = {
 *     collection: 'math_pacing',   // Firestore collection name
 *     docId:      'year9-10',      // document ID inside collection
 *   };
 */
import {
  getFirestore, collection, doc, getDoc, getDocs,
  setDoc, onSnapshot, serverTimestamp, query, where,
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const COLLECTION    = window.PACING_CONFIG.collection;
const DOC_ID        = window.PACING_CONFIG.docId;
const SUBJECT_KEY   = window.PACING_CONFIG.subjectKey;
const SYLLABUS_CODE = window.PACING_CONFIG.syllabusCode || '';
const PROGRESSION_GRID = !!window.PACING_CONFIG.progressionGrid;
const YEAR_A        = window.PACING_CONFIG.yearA || 'Year 9';
const YEAR_B        = window.PACING_CONFIG.yearB || 'Year 10';
const YEAR_A_KEY    = window.PACING_CONFIG.yearAKey || 'year9';
const YEAR_B_KEY    = window.PACING_CONFIG.yearBKey || 'year10';
// Per-subject Firestore field names written by Teachers Hub. Each subject's
// pacing template uses its own keys: IGCSE shares `statuses` + `igcse_*_classes`,
// Checkpoint and AS/A-Level use prefixed variants like `checkpoint_math_statuses`
// and `asmath_classes`. Defaults fall back to the IGCSE math layout.
const PROGRESS_KEY  = window.PACING_CONFIG.progressKey  || 'statuses';
const CLASSES_FIELD = window.PACING_CONFIG.classesField || 'igcse_classes';
const PROGRESS_KEY_RE = new RegExp(`^${PROGRESS_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(.+)$`);

let db, isAdmin = false, isCoordinator = false;
let chapters = [];
let classList = [];
let syllabusIndex = {};   // code → { title, tier, topicArea }
let syllabusReady = false;
let allTeachers = [];
let progressByTeacher = {};
let selectedClass = 'default';
let calSettings = null;
let _editChIdx = null, _editTopIdx = null;

// ── Paging state ──────────────────────────────────────────────
const PAGE_SIZE = 8;
let structurePage = 0;
let progressPage  = 0;
let hoursPage     = 0;

function renderPager(containerId, currentPage, totalItems, onGo) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const totalPages = Math.ceil(totalItems / PAGE_SIZE);
  if (totalPages <= 1) { el.style.display = 'none'; return; }
  el.style.display = 'flex';

  const start = currentPage * PAGE_SIZE + 1;
  const end   = Math.min((currentPage + 1) * PAGE_SIZE, totalItems);

  const range = [];
  for (let i = 0; i < totalPages; i++) {
    if (i === 0 || i === totalPages - 1 || Math.abs(i - currentPage) <= 2) range.push(i);
    else if (range[range.length - 1] !== '…') range.push('…');
  }

  const btns = range.map(i => i === '…'
    ? `<span class="pager-btn" style="border:none;cursor:default;opacity:.4">…</span>`
    : `<button class="pager-btn${i === currentPage ? ' on' : ''}" onclick="(${onGo})(${i})">${i + 1}</button>`
  ).join('');

  el.innerHTML = `
    <span class="pager-info">Showing ${start}–${end} of ${totalItems}</span>
    <div class="pager-btns">
      <button class="pager-btn" onclick="(${onGo})(${currentPage - 1})" ${currentPage === 0 ? 'disabled' : ''}>‹</button>
      ${btns}
      <button class="pager-btn" onclick="(${onGo})(${currentPage + 1})" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>›</button>
    </div>`;
}

// ── Helpers ──────────────────────────────────────────────────
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function safeUrl(u) { return /^https?:\/\//i.test(u||'') ? u : '#'; }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ── Tab switching ─────────────────────────────────────────────
window.switchTab = function(id, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  document.getElementById('tab-structure').style.display = id === 'structure' ? '' : 'none';
  document.getElementById('tab-progress').style.display  = id === 'progress'  ? '' : 'none';
  document.getElementById('tab-heatmap').style.display   = id === 'heatmap'   ? '' : 'none';
  document.getElementById('tab-hours').style.display     = id === 'hours'     ? '' : 'none';
  const progEl = document.getElementById('tab-progression');
  if (progEl) progEl.style.display = id === 'progression' ? '' : 'none';
  if (id === 'progress')    loadProgressTab();
  if (id === 'heatmap')     loadHeatmapTab();
  if (id === 'hours')       loadHoursTab();
  if (id === 'progression') {
    // Refresh coverage each time the tab is opened so it reflects any
    // recent pacing edits. Heuristic / override rendering is unaffected.
    _progCoverageByCode = null;
    renderProgressionGrid();
    if (!_progCoverageLoading) _progLoadCoverage();
  }
};

// ── Inline quick-edit ─────────────────────────────────────────
window.inlineSave = async function(ci, ti, field, value, inputEl) {
  const topic = chapters[ci]?.topics?.[ti];
  if (!topic) return;
  topic[field] = value;
  inputEl.classList.add('saving');
  try {
    await saveChapters();
    showToast('Saved ✓');
  } finally {
    setTimeout(() => inputEl.classList.remove('saving'), 800);
  }
};

// Topic name inline edit
window.activateTopicNameInput = function(el, ci, ti) {
  if (el.querySelector('input')) return;
  const topic = chapters[ci]?.topics?.[ti];
  if (!topic) return;
  const orig = topic.topic || '';
  el.innerHTML = `<input class="inline-input" type="text" value="${escHtml(orig)}"
    style="width:100%;font-weight:500;font-size:.82rem;padding:2px 4px"
    onkeydown="if(event.key==='Enter'){this.blur()}else if(event.key==='Escape'){this.dataset.cancel=1;this.blur()}"
    onblur="commitTopicName(this,${ci},${ti})">`;
  const inp = el.querySelector('input');
  inp.focus();
  inp.select();
};
window.commitTopicName = async function(inp, ci, ti) {
  if (inp.dataset.cancel) { renderChapters(); return; }
  const val = inp.value.trim();
  if (!val) { renderChapters(); return; }
  const topic = chapters[ci]?.topics?.[ti];
  if (!topic) return;
  topic.topic = val;
  inp.classList.add('saving');
  try {
    await saveChapters();
    showToast('Saved ✓');
  } catch(e) { /* error toast shown by saveChapters */ }
  renderChapters();
};

// Codes cell: inline input with autocomplete from cambridge_syllabus
window.activateCodesInput = function(wrapEl, ci, ti) {
  if (wrapEl.querySelector('.inline-codes-input')) return;
  const topic = chapters[ci]?.topics?.[ti];
  if (!topic) return;

  const confirmedCodes = new Set(
    Array.isArray(topic.syllabusRefs) && topic.syllabusRefs.length
      ? topic.syllabusRefs
      : _parseObjCodes(topic.objective || '')
  );
  let acIndex = -1;

  wrapEl.innerHTML = `
    <div class="codes-ac-wrap">
      <input class="inline-codes-input" type="text" placeholder="Type code e.g. C1.1" autocomplete="off" spellcheck="false">
      <div class="codes-ac-dropdown" id="acDrop_${ci}_${ti}" style="display:none"></div>
    </div>
    <div id="acPills_${ci}_${ti}" style="display:flex;flex-wrap:wrap;gap:2px;margin-top:4px"></div>`;

  const inp  = wrapEl.querySelector('.inline-codes-input');
  const drop = wrapEl.querySelector('.codes-ac-dropdown');
  const pillsEl = wrapEl.querySelector(`#acPills_${ci}_${ti}`);

  function renderPills() {
    pillsEl.innerHTML = '';
    [...confirmedCodes].forEach(c => {
      const span = document.createElement('span');
      span.className = 'obj-code';
      span.style.cursor = 'pointer';
      span.title = `Click to remove ${c}`;
      span.textContent = `${c} ✕`;
      span.addEventListener('mousedown', e => {
        e.preventDefault(); // prevent inp blur before click registers
      });
      span.addEventListener('click', e => {
        e.stopPropagation();
        confirmedCodes.delete(c);
        renderPills();
      });
      pillsEl.appendChild(span);
    });
  }
  renderPills();
  inp.focus();

  function getMatches(q) {
    if (!q) return [];
    const ql = q.toLowerCase();
    return Object.entries(syllabusIndex)
      .filter(([docId, d]) => {
        const displayCode = (d.code || docId.split('_').slice(1).join('_')).toLowerCase();
        const subjectMatch = !SYLLABUS_CODE || docId.startsWith(SYLLABUS_CODE + '_');
        return subjectMatch && displayCode.startsWith(ql) && !confirmedCodes.has(d.code || docId.split('_').slice(1).join('_'));
      })
      .sort(([aId,a],[bId,b]) => (a.code||aId.split('_').slice(1).join('_')).localeCompare(b.code||bId.split('_').slice(1).join('_')))
      .slice(0, 12)
      .map(([docId, d]) => [d.code || docId.split('_').slice(1).join('_'), d]);
  }

  function renderDrop(matches, loading) {
    acIndex = -1;
    if (loading) {
      drop.innerHTML = `<div class="codes-ac-empty" style="color:var(--ink-3)">Loading syllabus…</div>`;
    } else if (!matches.length) {
      drop.innerHTML = `<div class="codes-ac-empty">No matches</div>`;
    } else {
      drop.innerHTML = matches.map(([code, d]) =>
        `<div class="codes-ac-item" data-code="${escHtml(code)}">
          <span class="codes-ac-code">${escHtml(code)}</span>
          <span class="codes-ac-title">${escHtml(d.title || '')}</span>
          <span class="codes-ac-tier ${escHtml(d.tier||'')}">${escHtml(d.tier||'')}</span>
         </div>`
      ).join('');
      drop.querySelectorAll('.codes-ac-item').forEach(item => {
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          selectCode(item.dataset.code);
        });
      });
    }
    drop.style.display = '';
  }

  function selectCode(displayCode) {
    const valid = Object.entries(syllabusIndex).some(([docId, d]) => {
      const code = d.code || docId.split('_').slice(1).join('_');
      return code === displayCode && (!SYLLABUS_CODE || docId.startsWith(SYLLABUS_CODE + '_'));
    });
    if (!valid) return;
    confirmedCodes.add(displayCode);
    inp.value = '';
    drop.style.display = 'none';
    renderPills();
    inp.focus();
  }

  inp.addEventListener('input', () => {
    const q = inp.value.trim();
    inp.classList.remove('codes-ac-invalid');
    if (!q) { drop.style.display = 'none'; return; }
    if (!syllabusReady) { renderDrop([], true); return; }
    renderDrop(getMatches(q));
  });

  inp.addEventListener('keydown', e => {
    const items = drop.querySelectorAll('.codes-ac-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acIndex = Math.min(acIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === acIndex));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      acIndex = Math.max(acIndex - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === acIndex));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (acIndex >= 0 && items[acIndex]) {
        selectCode(items[acIndex].dataset.code);
      } else {
        const typed = inp.value.trim().toUpperCase();
        const match = Object.values(syllabusIndex).find(d => (d.code||'').toUpperCase() === typed);
        if (match) { selectCode(match.code); }
        else if (typed) {
          inp.classList.add('codes-ac-invalid');
          showToast('Invalid code — choose from the dropdown');
        }
      }
    } else if (e.key === 'Escape') {
      if (drop.style.display !== 'none') { drop.style.display = 'none'; return; }
      restorePills(topic.objective || '');
    }
  });

  async function commit() {
    drop.style.display = 'none';
    const codeList = [...confirmedCodes];
    topic.syllabusRefs = codeList;
    topic.objective = codeList.join(' ');
    try {
      await saveChapters();
      showToast('Codes saved ✓');
    } catch (e) {
      // saveChapters already showed error toast
    }
    renderChapters();
  }

  function restorePills(objective) {
    const codes = Array.isArray(topic.syllabusRefs) && topic.syllabusRefs.length
      ? topic.syllabusRefs
      : _parseObjCodes(objective);
    wrapEl.innerHTML = codes.map(c => {
      const entry = Object.entries(syllabusIndex).find(([docId, d]) => (d.code || docId.split('_').slice(1).join('_')) === c)?.[1];
      const tip = entry ? `${entry.tier ? '[' + entry.tier + '] ' : ''}${entry.title || ''}` : '';
      return `<span class="obj-code"${tip ? ` data-tip="${escHtml(tip)}"` : ''}>${escHtml(c)}</span>`;
    }).join('') + (codes.length === 0 ? `<span style="font-size:.65rem;color:var(--border)">+ codes</span>` : '');
  }

  inp.addEventListener('blur', () => {
    setTimeout(commit, 150);
  });
};

// ── Modal codes autocomplete widget ──────────────────────────
let _modalConfirmedCodes = new Set();

function initModalCodesAC(initialObjective) {
  _modalConfirmedCodes = new Set(_parseObjCodes(initialObjective || ''));

  const inp     = document.getElementById('modalCodesRawInput');
  const drop    = document.getElementById('modalCodesDrop');
  const pillsEl = document.getElementById('modalCodesPills');
  const hidden  = document.getElementById('topObjInput');

  let acIndex = -1;

  function renderPills() {
    pillsEl.innerHTML = [..._modalConfirmedCodes].map(c => {
      const entry = Object.values(syllabusIndex).find(d => d.code === c);
      const tip   = entry ? `${entry.tier ? '['+entry.tier+'] ' : ''}${entry.title||''}` : '';
      return `<span class="modal-obj-pill" title="${escHtml(tip)}">
        ${escHtml(c)}
        <span class="modal-obj-pill-remove" data-remove="${escHtml(c)}">✕</span>
      </span>`;
    }).join('');
    hidden.value = [..._modalConfirmedCodes].join(' ');
  }

  pillsEl.addEventListener('click', e => {
    const code = e.target.dataset.remove;
    if (code) { _modalConfirmedCodes.delete(code); renderPills(); }
  });

  renderPills();
  inp.value = '';
  drop.style.display = 'none';

  function getMatches(q) {
    if (!q || !syllabusReady) return { loading: !syllabusReady, matches: [] };
    const ql = q.toLowerCase();
    const matches = Object.entries(syllabusIndex)
      .filter(([docId, d]) => {
        const displayCode = (d.code || docId.split('_').slice(1).join('_')).toLowerCase();
        const subjectMatch = !SYLLABUS_CODE || docId.startsWith(SYLLABUS_CODE + '_');
        return subjectMatch && displayCode.startsWith(ql) && !_modalConfirmedCodes.has(d.code || docId.split('_').slice(1).join('_'));
      })
      .sort(([aId,a],[bId,b]) => (a.code||aId.split('_').slice(1).join('_')).localeCompare(b.code||bId.split('_').slice(1).join('_')))
      .slice(0, 12)
      .map(([docId, d]) => [d.code || docId.split('_').slice(1).join('_'), d]);
    return { loading: false, matches };
  }

  function renderDrop({ loading, matches }) {
    acIndex = -1;
    if (loading) {
      drop.innerHTML = `<div class="codes-ac-empty" style="color:var(--ink-3)">Loading syllabus…</div>`;
    } else if (!matches.length) {
      drop.innerHTML = `<div class="codes-ac-empty">No matches</div>`;
    } else {
      drop.innerHTML = matches.map(([code, d]) =>
        `<div class="codes-ac-item" data-code="${escHtml(code)}">
          <span class="codes-ac-code">${escHtml(code)}</span>
          <span class="codes-ac-title">${escHtml(d.title||'')}</span>
          <span class="codes-ac-tier ${escHtml(d.tier||'')}">${escHtml(d.tier||'')}</span>
        </div>`
      ).join('');
      drop.querySelectorAll('.codes-ac-item').forEach(item => {
        item.addEventListener('mousedown', e => { e.preventDefault(); selectCode(item.dataset.code); });
      });
    }
    drop.style.display = '';
  }

  function selectCode(displayCode) {
    const valid = Object.entries(syllabusIndex).some(([docId, d]) => {
      const code = d.code || docId.split('_').slice(1).join('_');
      return code === displayCode && (!SYLLABUS_CODE || docId.startsWith(SYLLABUS_CODE + '_'));
    });
    if (!valid) return;
    _modalConfirmedCodes.add(displayCode);
    inp.value = '';
    drop.style.display = 'none';
    renderPills();
    inp.focus();
  }

  // Remove old listeners by cloning the input
  const newInp = inp.cloneNode(true);
  inp.parentNode.replaceChild(newInp, inp);
  const activeInp = document.getElementById('modalCodesRawInput');

  activeInp.addEventListener('input', () => {
    const q = activeInp.value.trim();
    activeInp.style.borderColor = '';
    if (!q) { drop.style.display = 'none'; return; }
    renderDrop(getMatches(q));
  });

  activeInp.addEventListener('keydown', e => {
    const items = drop.querySelectorAll('.codes-ac-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acIndex = Math.min(acIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === acIndex));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      acIndex = Math.max(acIndex - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === acIndex));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (acIndex >= 0 && items[acIndex]) {
        selectCode(items[acIndex].dataset.code);
      } else {
        const typed = activeInp.value.trim().toUpperCase();
        const match = Object.values(syllabusIndex).find(d => (d.code||'').toUpperCase() === typed);
        if (match) selectCode(match.code);
        else if (typed) { activeInp.style.outline = '2px solid #dc2626'; showToast('Invalid code — choose from the dropdown'); }
      }
    } else if (e.key === 'Escape') {
      drop.style.display = 'none';
    }
  });

  activeInp.addEventListener('blur', () => { setTimeout(() => { drop.style.display = 'none'; }, 150); });
}

// ── Save chapters to Firestore ────────────────────────────────
async function saveChapters() {
  if (!db) { console.error('saveChapters: db not ready'); showToast('Not authenticated'); return; }
  const structureOnly = chapters.map(ch => ({
    ...ch,
    topics: (ch.topics || []).map(({ status, note, diag, actualHour, ...rest }) => rest),
  }));
  try {
    await setDoc(doc(db, COLLECTION, DOC_ID), { chapters: structureOnly, updatedAt: serverTimestamp() }, { merge: true });
  } catch (e) {
    console.error('saveChapters failed:', e);
    showToast('Save failed — check console');
    throw e; // re-throw so callers know it failed
  }
}

// ── Render chapter list ───────────────────────────────────────
function renderChapters() {
  const el = document.getElementById('chapterList');
  if (!chapters.length) {
    el.innerHTML = '<div class="empty-wrap">No chapters yet. Click "+ Add Chapter" to start.</div>';
    document.getElementById('structurePager').style.display = 'none';
    return;
  }
  const pageChapters = chapters.slice(structurePage * PAGE_SIZE, (structurePage + 1) * PAGE_SIZE);
  const pageOffset   = structurePage * PAGE_SIZE;
  el.innerHTML = pageChapters.map((ch, localCi) => {
    const ci = localCi + pageOffset;
    const topics = ch.topics || [];
    const yearCls = ch.year === YEAR_A ? 'yr9' : 'yr10';
    const topicsHtml = topics.length === 0
      ? '<div style="padding:10px 14px;font-size:.75rem;color:var(--ink-3)">No topics yet.</div>'
      : (() => {
        const showHoursWeek = isAdmin && !isCoordinator;
        const notesWidth = isAdmin ? (showHoursWeek ? '10' : '22') : '22';
        return `<table class="topic-tbl">
          <thead><tr>
            <th style="width:26%">Topic</th>
            <th style="width:18%;color:#1d4ed8">Codes</th>
            ${showHoursWeek ? `<th style="width:6%;color:#92400e">Hours</th>` : ''}
            ${showHoursWeek ? `<th style="width:6%;color:#166534">Week</th>` : ''}
            <th style="width:20%">Schedule</th>
            <th style="width:${notesWidth}%">Notes &amp; Tags</th>
            ${isAdmin ? `<th style="width:14%">Actions</th>` : ''}
          </tr></thead>
          <tbody>
            ${topics.map((t, ti) => {
              const codes = Array.isArray(t.syllabusRefs) && t.syllabusRefs.length ? t.syllabusRefs : _parseObjCodes(t.objective);
              const dur   = t.duration ?? t.hour ?? '';
              const wk    = t.week ?? '';
              const info  = wk ? weekInfo(wk) : null;
              const pill  = (() => {
                if (!info) return '';
                const parts = [];
                if (info.termLabel) parts.push(info.termLabel);
                parts.push(`Week ${wk}`);
                parts.push(`${fmtShortDate(info.monDate)} – ${fmtShortDate(info.friDate)}`);
                return `<div class="week-pill">&#128197; ${escHtml(parts.join(' · '))}</div>`;
              })();
              return `
              <tr>
                <td>
                  <div class="topic-name-cell" style="font-weight:500;font-size:.82rem;${isAdmin ? 'cursor:text' : ''}"
                    ${isAdmin ? `title="Double-click to edit" ondblclick="activateTopicNameInput(this,${ci},${ti})"` : ''}>${escHtml(t.topic)}</div>
                  ${t.resources && t.resources.length ? `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:4px">${t.resources.map(r => `<a class="res-chip" href="${safeUrl(r.url)}" target="_blank" rel="noopener">&#128279; ${escHtml(r.name||r.url)}</a>`).join('')}</div>` : ''}
                </td>
                <td>
                  <div class="inline-codes-wrap" ${isAdmin ? `onclick="activateCodesInput(this,${ci},${ti})" title="Click to edit codes"` : ''}>
                    ${codes.map(c => {
                      const entry = Object.entries(syllabusIndex).find(([docId, d]) => (d.code || docId.split('_').slice(1).join('_')) === c)?.[1];
                      const tip = entry ? `${entry.tier ? '[' + entry.tier + '] ' : ''}${entry.title || ''}` : '';
                      return `<span class="obj-code"${tip ? ` data-tip="${escHtml(tip)}"` : ''}>${escHtml(c)}</span>`;
                    }).join('')}
                    ${codes.length === 0 ? `<span style="font-size:.65rem;color:var(--border)">${isAdmin ? '+ codes' : '—'}</span>` : ''}
                  </div>
                </td>
                ${showHoursWeek ? `<td>
                  <input class="inline-input inline-input-num inline-input-hours" type="number" min="0" max="99"
                    value="${escHtml(String(dur))}" placeholder="—"
                    onchange="inlineSave(${ci},${ti},'duration',+this.value||1,this)"
                    title="Hours for this topic">
                </td>` : ''}
                ${showHoursWeek ? `<td>
                  <input class="inline-input inline-input-num inline-input-week" type="number" min="1" max="99"
                    value="${escHtml(String(wk))}" placeholder="—"
                    onchange="inlineSave(${ci},${ti},'week',+this.value||null,this)"
                    title="School week number">
                </td>` : ''}
                <td>${pill || '<span style="color:var(--border);font-size:.7rem">—</span>'}</td>
                <td>
                  ${t.coordNote ? `<div class="coord-note-text">${escHtml(t.coordNote)}</div>` : ''}
                  ${t.diag ? `<span class="diag-badge ${escHtml(t.diag)}">${t.diag === 'weak' ? '⚠ Weak' : t.diag === 'review' ? '↻ Review' : '✓ Good'}</span>` : ''}
                </td>
                ${isAdmin ? `<td>
                  <div style="display:flex;gap:4px;flex-wrap:wrap">
                    <button class="icon-btn edit" onclick="editTopic(${ci},${ti})" title="Edit topic">✎</button>
                    <button class="icon-btn del" onclick="deleteTopic(${ci},${ti})" title="Delete topic">✕</button>
                    ${ti > 0 ? `<button class="icon-btn move" onclick="moveTopic(${ci},${ti},-1)" title="Move up">↑</button>` : ''}
                    ${ti < topics.length-1 ? `<button class="icon-btn move" onclick="moveTopic(${ci},${ti},1)" title="Move down">↓</button>` : ''}
                  </div>
                </td>` : ''}
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
      })();

    return `
      <div class="ch-item" id="ch-${ci}">
        <div class="ch-item-head" onclick="toggleCh(${ci})">
          <span class="ch-num">Ch ${ci+1}</span>
          <span class="ch-name">${escHtml(ch.chapter)}</span>
          <span class="ch-year-badge ${yearCls}">${escHtml(ch.year||'')}</span>
          <span style="font-size:.65rem;color:var(--ink-3);font-family:'DM Mono',monospace">${topics.length} topics</span>
          ${isAdmin ? `<div class="ch-actions" onclick="event.stopPropagation()">
            <button class="icon-btn edit" onclick="editChapter(${ci})" title="Edit chapter">✎</button>
            <button class="icon-btn del" onclick="deleteChapter(${ci})" title="Delete chapter">✕</button>
            ${ci > 0 ? `<button class="icon-btn move" onclick="moveChapter(${ci},-1)" title="Move up">↑</button>` : ''}
            ${ci < chapters.length-1 ? `<button class="icon-btn move" onclick="moveChapter(${ci},1)" title="Move down">↓</button>` : ''}
          </div>` : ''}
          <span class="ch-caret">▾</span>
        </div>
        <div class="ch-body">
          ${topicsHtml}
          ${isAdmin ? `<button class="add-topic-btn" onclick="openAddTopicModal(${ci})">+ Add Topic</button>` : ''}
        </div>
      </div>`;
  }).join('');

  renderPager('structurePager', structurePage, chapters.length, 'goStructurePage');
}

window.goStructurePage = function(p) {
  const total = Math.ceil(chapters.length / PAGE_SIZE);
  if (p < 0 || p >= total) return;
  structurePage = p;
  renderChapters();
  document.getElementById('chapterList').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function toggleCh(ci) {
  document.getElementById(`ch-${ci}`).classList.toggle('collapsed');
}
window.toggleCh = toggleCh;

function _parseObjCodes(objStr) {
  if (!objStr) return [];
  const s = String(objStr);
  // IGCSE/A-Level codes: C1.1, E2.3, 1.1, 1.1.1
  const igcse = s.match(/[A-Z]?\d+\.\d+(?:\.\d+)*/g) || [];
  // Checkpoint codes: 7Ni.01, 7Nf.07, 8Sp.03
  const checkpoint = s.match(/\d[A-Za-z]+\.\d+/g) || [];
  return [...new Set([...igcse, ...checkpoint])];
}

// ── Chapter CRUD ─────────────────────────────────────────────
window.openAddChapterModal = function() {
  _editChIdx = null;
  document.getElementById('chModalTitle').textContent = 'Add Chapter';
  document.getElementById('chNameInput').value = '';
  document.getElementById('chYearInput').value = YEAR_A;
  document.getElementById('chapterModal').style.display = 'flex';
  setTimeout(() => document.getElementById('chNameInput').focus(), 50);
};

window.editChapter = function(ci) {
  _editChIdx = ci;
  const ch = chapters[ci];
  document.getElementById('chModalTitle').textContent = 'Edit Chapter';
  document.getElementById('chNameInput').value = ch.chapter || '';
  document.getElementById('chYearInput').value = ch.year || YEAR_A;
  document.getElementById('chapterModal').style.display = 'flex';
  setTimeout(() => document.getElementById('chNameInput').focus(), 50);
};

window.saveChapterModal = async function() {
  const name = document.getElementById('chNameInput').value.trim();
  const year = document.getElementById('chYearInput').value;
  if (!name) { document.getElementById('chNameInput').focus(); return; }
  if (_editChIdx !== null) {
    chapters[_editChIdx].chapter = name;
    chapters[_editChIdx].year = year;
  } else {
    chapters.push({ id: newId(), chapter: name, year, topics: [] });
  }
  await saveChapters();
  closeChapterModal();
  showToast(_editChIdx !== null ? 'Chapter updated' : 'Chapter added');
  renderChapters();
};

window.closeChapterModal = function() {
  document.getElementById('chapterModal').style.display = 'none';
};

window.deleteChapter = function(ci) {
  const btn = event.currentTarget;
  if (btn.dataset.confirming) {
    chapters.splice(ci, 1);
    saveChapters().then(() => { showToast('Chapter deleted'); renderChapters(); });
    delete btn.dataset.confirming;
    btn.textContent = '✕';
    btn.style.background = '';
  } else {
    btn.dataset.confirming = '1';
    btn.textContent = 'Sure?';
    btn.style.background = '#fee2e2';
    setTimeout(() => { delete btn.dataset.confirming; btn.textContent = '✕'; btn.style.background = ''; }, 3000);
  }
};

window.moveChapter = function(ci, dir) {
  const ni = ci + dir;
  if (ni < 0 || ni >= chapters.length) return;
  [chapters[ci], chapters[ni]] = [chapters[ni], chapters[ci]];
  saveChapters().then(() => renderChapters());
};

// ── Topic CRUD ────────────────────────────────────────────────
let _topModalCi = null;
let _modalResources = [];

window.openAddTopicModal = function(ci) {
  _topModalCi = ci; _editTopIdx = null; _modalResources = [];
  document.getElementById('topModalTitle').textContent = 'Add Topic — ' + escHtml(chapters[ci].chapter);
  document.getElementById('topNameInput').value = '';
  document.getElementById('topHourInput').value = '';
  document.getElementById('topWeekInput').value = '';
  document.getElementById('topObjInput').value = '';
  document.getElementById('topCoordNoteInput').value = '';
  document.getElementById('topDiagInput').value = '';
  document.getElementById('topAoInput').value = '';
  renderModalResources();
  document.getElementById('topicModal').style.display = 'flex';
  initModalCodesAC('');
  setTimeout(() => document.getElementById('topNameInput').focus(), 50);
};

window.editTopic = function(ci, ti) {
  _topModalCi = ci; _editTopIdx = ti;
  const t = chapters[ci].topics[ti];
  _modalResources = (t.resources || []).map(r => ({...r}));
  document.getElementById('topModalTitle').textContent = 'Edit Topic';
  document.getElementById('topNameInput').value = t.topic || '';
  document.getElementById('topHourInput').value = t.duration ?? t.hour ?? '';
  document.getElementById('topWeekInput').value = t.week || '';
  document.getElementById('topObjInput').value = t.objective || '';
  document.getElementById('topCoordNoteInput').value = t.coordNote || '';
  document.getElementById('topDiagInput').value = t.diag || '';
  document.getElementById('topAoInput').value = t.ao || '';
  renderModalResources();
  document.getElementById('topicModal').style.display = 'flex';
  initModalCodesAC(t.objective || '');
  setTimeout(() => document.getElementById('topNameInput').focus(), 50);
};

function renderModalResources() {
  const el = document.getElementById('topResources');
  el.innerHTML = _modalResources.map((r, i) => `
    <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center">
      <input class="form-input" style="flex:1" value="${escHtml(r.name||'')}" placeholder="Name" oninput="_modalResources[${i}].name=this.value">
      <input class="form-input" style="flex:2" value="${escHtml(r.url||'')}" placeholder="https://…" oninput="_modalResources[${i}].url=this.value">
      <button class="icon-btn danger" onclick="_modalResources.splice(${i},1);renderModalResources()">&#215;</button>
    </div>`).join('');
}
window.renderModalResources = renderModalResources;

window.addModalResource = function() {
  _modalResources.push({ name: '', url: '' });
  renderModalResources();
};

window.saveTopicModal = async function() {
  const name = document.getElementById('topNameInput').value.trim();
  if (!name) { document.getElementById('topNameInput').focus(); return; }
  const duration = parseInt(document.getElementById('topHourInput').value) || 1;
  const week     = document.getElementById('topWeekInput').value.trim() || null;
  const objective = document.getElementById('topObjInput').value.trim();
  const coordNote = document.getElementById('topCoordNoteInput').value.trim();
  const diag     = document.getElementById('topDiagInput').value;
  const ao       = document.getElementById('topAoInput').value;
  const resources = _modalResources.filter(r => r.name || r.url);

  const topicData = { topic: name, duration, week, objective, coordNote, resources };
  if (diag)  topicData.diag = diag;  else delete topicData.diag;
  if (ao)    topicData.ao   = ao;    else delete topicData.ao;

  if (_editTopIdx !== null) {
    const existing = chapters[_topModalCi].topics[_editTopIdx];
    chapters[_topModalCi].topics[_editTopIdx] = { ...existing, ...topicData };
    if (!ao) delete chapters[_topModalCi].topics[_editTopIdx].ao;
  } else {
    chapters[_topModalCi].topics.push({ id: newId(), ...topicData });
  }
  await saveChapters();
  closeTopicModal();
  showToast(_editTopIdx !== null ? 'Topic updated' : 'Topic added');
  renderChapters();
};

window.closeTopicModal = function() {
  document.getElementById('topicModal').style.display = 'none';
};

window.deleteTopic = function(ci, ti) {
  const btn = event.currentTarget;
  if (btn.dataset.confirming) {
    chapters[ci].topics.splice(ti, 1);
    saveChapters().then(() => { showToast('Topic deleted'); renderChapters(); });
    delete btn.dataset.confirming;
    btn.textContent = '✕';
    btn.style.background = '';
  } else {
    btn.dataset.confirming = '1';
    btn.textContent = 'Sure?';
    btn.style.background = '#fee2e2';
    setTimeout(() => { delete btn.dataset.confirming; btn.textContent = '✕'; btn.style.background = ''; }, 3000);
  }
};

window.moveTopic = function(ci, ti, dir) {
  const topics = chapters[ci].topics;
  const ni = ti + dir;
  if (ni < 0 || ni >= topics.length) return;
  [topics[ti], topics[ni]] = [topics[ni], topics[ti]];
  saveChapters().then(() => renderChapters());
};

// ── Shared teacher fetch ──────────────────────────────────────
// Only includes teachers whose `subjects` array contains SUBJECT_KEY.
// Legacy teachers with no subjects field are always included.
async function fetchTeachers() {
  const snap = await getDocs(query(collection(db, 'users'), where('role_teachershub', 'in', ['teachers_user', 'teachers_admin'])));
  allTeachers = [];
  snap.forEach(d => {
    const data = d.data();
    const teacherSubjects = data.subjects;
    if (!teacherSubjects || teacherSubjects.length === 0 || (SUBJECT_KEY && teacherSubjects.includes(SUBJECT_KEY))) {
      allTeachers.push({ uid: d.id, ...data });
    }
  });

  const profileClassSet = new Set();
  allTeachers.forEach(t => { (t[CLASSES_FIELD] || []).forEach(c => profileClassSet.add(c)); });
  if (profileClassSet.size > 0) {
    classList = [...new Set([...profileClassSet, ...classList])].sort();
  }
}

// ── Teacher Progress Tab ──────────────────────────────────────
async function loadProgressTab() {
  document.getElementById('progressList').innerHTML = '<div class="loading-wrap">Loading teachers…</div>';
  document.getElementById('aggBanner').innerHTML = '';

  await fetchTeachers();

  progressByTeacher = {};
  await Promise.all(allTeachers.map(async t => {
    const progSnap = await getDoc(doc(db, 'userProgress', t.uid));
    if (progSnap.exists()) {
      const d = progSnap.data();
      const classSections = {};
      Object.keys(d).forEach(key => {
        const m = key.match(PROGRESS_KEY_RE);
        if (m) classSections[m[1].replace(/_/g, ' ')] = d[key];
      });
      if (d[PROGRESS_KEY] && !Object.keys(classSections).length) {
        classSections['—'] = d[PROGRESS_KEY];
      }
      progressByTeacher[t.uid] = { classSections, updatedAt: d.updatedAt };
    } else {
      progressByTeacher[t.uid] = { classSections: {}, updatedAt: null };
    }
  }));

  renderProgressView();
}

function renderProgressView() {
  const listEl = document.getElementById('progressList');
  const aggEl  = document.getElementById('aggBanner');

  if (!allTeachers.length) {
    listEl.innerHTML = '<div class="empty-wrap">No teachers found with role_teachershub set.</div>';
    aggEl.innerHTML = '';
    return;
  }

  const totalTopics = chapters.reduce((n, ch) => n + (ch.topics||[]).length, 0);

  function classMatchesYear(cls) {
    if (!selectedClass || selectedClass === 'default') return true;
    const n = cls.replace(/\s/g, '').toLowerCase();
    if (selectedClass === YEAR_A_KEY) return new RegExp('\\b' + YEAR_A.replace('Year ','') + '\\b').test(n.replace(/\s/g,''));
    if (selectedClass === YEAR_B_KEY) return new RegExp('\\b' + YEAR_B.replace('Year ','') + '\\b').test(n.replace(/\s/g,''));
    return true;
  }

  const rows = [];
  allTeachers.forEach(t => {
    const { classSections, updatedAt } = progressByTeacher[t.uid] || { classSections: {}, updatedAt: null };
    const keys = Object.keys(classSections).filter(k => classMatchesYear(k));
    if (keys.length) {
      keys.forEach(cls => rows.push({ t, cls: cls.replace(/_/g,' '), statuses: classSections[cls], updatedAt }));
    } else {
      rows.push({ t, cls: null, statuses: {}, updatedAt: null, noData: true });
    }
  });

  let aggDone = 0, aggProg = 0, aggWeak = 0, aggPairs = 0;
  rows.forEach(({ statuses }) => {
    if (!Object.keys(statuses).length) return;
    aggPairs++;
    chapters.forEach(ch => (ch.topics||[]).forEach(topic => {
      const k = `${ch.id}.${topic.id}`;
      const s = statuses[k];
      if (s === 'done') aggDone++;
      else if (s === 'inprogress') aggProg++;
      if (statuses[`diag.${k}`] === 'weak') aggWeak++;
    }));
  });
  const avgPct = totalTopics && aggPairs
    ? Math.round(aggDone / (totalTopics * aggPairs) * 100) : 0;
  const teacherCount = new Set(rows.map(r => r.t.uid)).size;

  aggEl.innerHTML = `
    <div class="agg-stat blue"><div class="agg-stat-num">${teacherCount}</div><div class="agg-stat-label">Teachers</div></div>
    <div class="agg-stat"><div class="agg-stat-num">${totalTopics}</div><div class="agg-stat-label">Total Topics</div></div>
    <div class="agg-stat green"><div class="agg-stat-num" style="color:#1e7a4a">${avgPct}%</div><div class="agg-stat-label">Avg Completion</div></div>
    <div class="agg-stat"><div class="agg-stat-num" style="color:#1a5fa8">${aggProg}</div><div class="agg-stat-label">In Progress</div></div>
    ${aggWeak > 0 ? `<div class="agg-stat accent"><div class="agg-stat-num" style="color:#dc2626">${aggWeak}</div><div class="agg-stat-label">Weak-Flagged</div></div>` : ''}
  `;

  buildWeakAlerts();

  const teacherCards = [];
  const seen = new Map();
  rows.forEach(row => {
    if (!seen.has(row.t.uid)) { seen.set(row.t.uid, []); teacherCards.push({ t: row.t, rows: seen.get(row.t.uid) }); }
    seen.get(row.t.uid).push(row);
  });

  const pageCards = teacherCards.slice(progressPage * PAGE_SIZE, (progressPage + 1) * PAGE_SIZE);

  listEl.innerHTML = pageCards.map((card, ci) => {
    const { t, rows: classRows } = card;
    const ti = ci + progressPage * PAGE_SIZE;
    const initials = (t.displayName || t.email || '?').split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const updatedAt = progressByTeacher[t.uid]?.updatedAt;
    const updLabel  = updatedAt?.toDate ? updatedAt.toDate().toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) : '';

    const hasClasses   = t[CLASSES_FIELD] && t[CLASSES_FIELD].length > 0;
    const hasAnyData   = Object.keys(progressByTeacher[t.uid]?.classSections || {}).length > 0;
    const firstRow     = classRows[0];
    const isNoDataCard = firstRow?.noData;

    const classRowsHtml = isNoDataCard
      ? `<div class="teacher-no-data-row">
           ${!hasClasses
             ? `<span class="no-data-icon">📋</span> No classes assigned — teacher has not selected a class in Teachers Hub`
             : !hasAnyData
               ? `<span class="no-data-icon">📝</span> Classes assigned (${t[CLASSES_FIELD].join(', ')}) but no progress saved yet`
               : `<span class="no-data-icon">🔍</span> No data for selected year filter`
           }
         </div>`
      : classRows.map((row, ri) => {
      const { cls, statuses } = row;
      let done = 0, prog = 0, pending = 0;
      chapters.forEach(ch => (ch.topics||[]).forEach(topic => {
        const s = statuses[`${ch.id}.${topic.id}`];
        if (s === 'done') done++;
        else if (s === 'inprogress') prog++;
        else pending++;
      }));
      const pct      = totalTopics ? Math.round(done / totalTopics * 100) : 0;
      const barColor = pct >= 75 ? '#1e7a4a' : pct >= 40 ? '#1a5fa8' : '#dc2626';
      const rowId    = `tcr-${ti}-${ri}`;
      const rowUpd   = row.updatedAt?.toDate
        ? row.updatedAt.toDate().toLocaleDateString('en-GB',{day:'2-digit',month:'short'})
        : '—';

      const chDetail = chapters.map((ch, chi) => {
        const chTopics = ch.topics || [];
        let chDone = 0;
        chTopics.forEach(topic => { if (statuses[`${ch.id}.${topic.id}`] === 'done') chDone++; });
        const chPct = chTopics.length ? Math.round(chDone/chTopics.length*100) : 0;

        const topicRows = chTopics.map(topic => {
          const k = `${ch.id}.${topic.id}`;
          const s = statuses[k] || 'pending';
          const diag = statuses[`diag.${k}`] || '';
          const actualHour = statuses[`actual.${k}`] || null;
          return `<div class="detail-topic-row">
            <div class="status-dot ${s}"></div>
            <div class="detail-topic-name">${escHtml(topic.topic)}</div>
            ${actualHour !== null ? `<div class="detail-actual-hours">${actualHour}h actual</div>` : ''}
            ${diag ? `<span class="detail-diag ${diag}">${diag==='weak'?'⚠ Weak':'↻ Review'}</span>` : ''}
          </div>`;
        }).join('');

        return `<div class="detail-chapter">
          <div class="detail-ch-head" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'':'none'">
            <div class="detail-ch-name">Ch ${chi+1} — ${escHtml(ch.chapter)}</div>
            <div class="detail-ch-pct">${chDone}/${chTopics.length} done (${chPct}%)</div>
          </div>
          <div style="display:none">${topicRows}</div>
        </div>`;
      }).join('');

      return `
        <div class="teacher-class-row" id="${rowId}" onclick="toggleClassRow('${rowId}')">
          <span class="class-row-badge">${escHtml(cls || '—')}</span>
          <div class="teacher-stats">
            <div class="t-stat"><div class="t-stat-num done">${done}</div><div class="t-stat-label">Done</div></div>
            <div class="t-stat"><div class="t-stat-num prog">${prog}</div><div class="t-stat-label">In Prog</div></div>
            <div class="t-stat"><div class="t-stat-num pend">${pending}</div><div class="t-stat-label">Pending</div></div>
          </div>
          <div class="teacher-prog-wrap">
            <div class="teacher-prog-bar"><div class="teacher-prog-fill" style="width:${pct}%;background:${barColor}"></div></div>
            <span style="font-size:.65rem;font-weight:700;color:${barColor}">${pct}%</span>
          </div>
          <div class="teacher-last-update">${rowUpd}</div>
          <svg class="teacher-expand-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4,6 8,10 12,6"/></svg>
        </div>
        <div class="teacher-detail" id="${rowId}-detail">${chDetail}</div>`;
    }).join('');

    return `<div class="teacher-card" id="teacher-card-${ti}">
      <div class="teacher-card-identity">
        <div class="teacher-avatar">${initials}</div>
        <div style="flex:1;min-width:0">
          <div class="teacher-name">${escHtml(t.displayName || t.email)}</div>
          <div class="teacher-email">${escHtml(t.email)}</div>
        </div>
      </div>
      ${classRowsHtml}
    </div>`;
  }).join('');

  renderPager('progressPager', progressPage, teacherCards.length, 'goProgressPage');
}

window.goProgressPage = function(p) {
  progressPage = p;
  renderProgressView();
  document.getElementById('progressList').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.toggleClassRow = function(rowId) {
  const row    = document.getElementById(rowId);
  const detail = document.getElementById(`${rowId}-detail`);
  if (row)    row.classList.toggle('open');
  if (detail) detail.classList.toggle('open');
};

window.refreshProgress = function() {
  progressPage = 0; hoursPage = 0;
  loadProgressTab();
};

// ── Weak Topic Alert ──────────────────────────────────────────
function buildWeakAlerts() {
  const weakMap = {};
  allTeachers.forEach(t => {
    const { classSections } = progressByTeacher[t.uid] || { classSections: {} };
    Object.values(classSections).forEach(statuses => {
      chapters.forEach(ch => (ch.topics || []).forEach(topic => {
        const k = `${ch.id}.${topic.id}`;
        if (statuses[`diag.${k}`] === 'weak') {
          if (!weakMap[k]) weakMap[k] = { topicName: topic.topic, chName: ch.chapter, teachers: [] };
          const name = t.displayName || t.email;
          if (!weakMap[k].teachers.includes(name)) weakMap[k].teachers.push(name);
        }
      }));
    });
  });

  const panel   = document.getElementById('weakAlertPanel');
  const body    = document.getElementById('weakAlertBody');
  const countEl = document.getElementById('weakAlertCount');
  const entries = Object.values(weakMap);

  if (!entries.length) { panel.style.display = 'none'; return; }

  countEl.textContent = `${entries.length} topic${entries.length !== 1 ? 's' : ''} flagged weak`;
  body.innerHTML = entries.map(e => `
    <div class="weak-topic-row">
      <div class="weak-topic-name">${escHtml(e.topicName)}
        <span style="font-size:.65rem;font-weight:400;color:var(--ink-3)"> — ${escHtml(e.chName)}</span>
      </div>
      <div class="weak-teacher-chips">
        ${e.teachers.map(n => `<span class="weak-teacher-chip">${escHtml(n)}</span>`).join('')}
      </div>
    </div>`).join('');
  panel.style.display = '';
  document.getElementById('weakAlertBody').style.display = _weakPanelOpen ? '' : 'none';
  document.getElementById('weakAlertToggle').textContent = _weakPanelOpen ? '▾ Hide' : '▸ Show';
}

let _weakPanelOpen = false;
window.toggleWeakPanel = function() {
  _weakPanelOpen = !_weakPanelOpen;
  document.getElementById('weakAlertBody').style.display = _weakPanelOpen ? '' : 'none';
  document.getElementById('weakAlertToggle').textContent = _weakPanelOpen ? '▾ Hide' : '▸ Show';
};

// ── Coverage Heatmap ──────────────────────────────────────────
async function loadHeatmapTab() {
  const el = document.getElementById('heatmapGrid');
  if (el) el.innerHTML = '<div class="loading-wrap">Loading…</div>';

  if (!allTeachers.length) await fetchTeachers();

  // Only include progress from teachers in allTeachers (already subject-filtered).
  const allowedUids = new Set(allTeachers.map(t => t.uid));
  // @lint-allow-unbounded — auto-annotated; revisit if collection grows large
  const progressSnap = await getDocs(collection(db, 'userProgress'));
  const progressByClass = {};
  const teacherByClass  = {};

  allTeachers.forEach(t => {
    (t[CLASSES_FIELD] || []).forEach(cls => {
      const key = cls.replace(/\s/g, '_');
      teacherByClass[key] = t;
    });
  });

  progressSnap.forEach(d => {
    if (!allowedUids.has(d.id)) return; // skip teachers not in this subject
    const data = d.data();
    Object.keys(data).forEach(key => {
      const m = key.match(PROGRESS_KEY_RE);
      if (!m) return;
      const cls = m[1];
      if (!progressByClass[cls] ||
          Object.keys(data[key]).length > Object.keys(progressByClass[cls]).length) {
        progressByClass[cls] = data[key];
      }
    });
  });

  const activeCols = Object.keys(progressByClass).sort();
  renderHeatmap(activeCols, progressByClass, teacherByClass);
}

function renderHeatmap(activeCols, progressByClass, teacherByClass) {
  const el = document.getElementById('heatmapGrid');
  if (!el) return;

  if (!activeCols || !activeCols.length || !chapters.length) {
    el.innerHTML = '<p style="color:var(--ink-3);font-size:.82rem;padding:10px">No class progress data yet. Teachers need to select a class before saving progress.</p>';
    return;
  }

  function heatColor(pct) {
    if (pct === 0)  return { bg: '#f1f5f9', fg: '#94a3b8' };
    if (pct < 25)   return { bg: '#fecaca', fg: '#7f1d1d' };
    if (pct < 50)   return { bg: '#fca5a5', fg: '#7f1d1d' };
    if (pct < 75)   return { bg: '#60a5fa', fg: '#1e3a8a' };
    if (pct < 90)   return { bg: '#34d399', fg: '#064e3b' };
    return           { bg: '#059669', fg: '#fff' };
  }

  function initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase();
  }

  const accentPalette = ['#2563eb','#7c3aed','#059669','#d97706','#dc2626','#0891b2'];

  const headerCells = activeCols.map((cls, ci) => {
    const label   = cls.replace(/_/g, ' ');
    const teacher = teacherByClass[cls];
    const name    = teacher?.displayName || teacher?.name || null;
    const school  = teacher?.school || null;
    const photo   = teacher?.photoURL || null;
    const accent  = accentPalette[ci % accentPalette.length];

    const avatarHtml = photo
      ? `<img class="heatmap-col-avatar" src="${escHtml(photo)}" alt="" loading="lazy">`
      : `<div class="heatmap-col-avatar-placeholder" style="background:${accent}">${escHtml(initials(name || label))}</div>`;

    const nameHtml   = name   ? `<div class="heatmap-col-name">${escHtml(name)}</div>` : '';
    const schoolHtml = school ? `<div class="heatmap-col-school">${escHtml(school)}</div>` : '';

    const tooltipParts = [label];
    if (name)   tooltipParts.push(name);
    if (school) tooltipParts.push(school);

    return `<th class="heatmap-col-header" title="${escHtml(tooltipParts.join(' · '))}">
      <div class="heatmap-col-card">
        <div class="heatmap-col-class">${escHtml(label)}</div>
        <div class="heatmap-col-divider" style="background:${accent}"></div>
        ${avatarHtml}
        ${nameHtml}
        ${schoolHtml}
      </div>
    </th>`;
  }).join('');

  const rows = chapters.map((ch, ci) => {
    const chTopics = ch.topics || [];

    const cells = activeCols.map(cls => {
      const statuses = progressByClass[cls] || {};
      const done = chTopics.filter(tp => statuses[`${ch.id}.${tp.id}`] === 'done').length;
      const pct  = chTopics.length ? Math.round(done / chTopics.length * 100) : 0;
      const { bg, fg } = heatColor(pct);
      const label = cls.replace(/_/g, ' ');
      return `<td style="text-align:center"><div class="heatmap-cell" style="background:${bg};color:${fg}" title="${escHtml(label)} — ${escHtml(ch.chapter)}: ${done}/${chTopics.length} done">${pct ? pct + '%' : '—'}</div></td>`;
    }).join('');

    return `<tr>
      <td class="heatmap-ch-label" title="${escHtml(ch.chapter)}">${ci + 1}. ${escHtml(ch.chapter)}</td>
      ${cells}
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="heatmap-legend">
      <div class="heatmap-legend-item"><div class="heatmap-legend-swatch" style="background:#f1f5f9;border:1px solid #e2e8f0"></div>Not started</div>
      <div class="heatmap-legend-item"><div class="heatmap-legend-swatch" style="background:#fecaca"></div>&lt;25%</div>
      <div class="heatmap-legend-item"><div class="heatmap-legend-swatch" style="background:#fca5a5"></div>25–49%</div>
      <div class="heatmap-legend-item"><div class="heatmap-legend-swatch" style="background:#60a5fa"></div>50–74%</div>
      <div class="heatmap-legend-item"><div class="heatmap-legend-swatch" style="background:#34d399"></div>75–89%</div>
      <div class="heatmap-legend-item"><div class="heatmap-legend-swatch" style="background:#059669"></div>≥90%</div>
    </div>
    <div class="heatmap-wrap">
      <table class="heatmap-table">
        <thead><tr>
          <th style="text-align:left;width:auto;min-width:200px;max-width:360px;background:transparent;border:none;vertical-align:bottom;padding:0 6px 4px"></th>
          ${headerCells}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Hours Report ──────────────────────────────────────────────
async function loadHoursTab() {
  if (!allTeachers.length) await fetchTeachers();
  renderHoursReport();
}

function _mergedStatuses(uid) {
  const { classSections = {} } = progressByTeacher[uid] || {};
  const merged = {};
  Object.values(classSections).forEach(s => {
    Object.entries(s).forEach(([k, v]) => {
      if (k.startsWith('actual.')) {
        merged[k] = (merged[k] || 0) + (parseFloat(v) || 0);
      } else if (!merged[k]) {
        merged[k] = v;
      }
    });
  });
  return merged;
}

const _hoursExpanded = new Set();

window.toggleHoursDrilldown = function(uid) {
  if (_hoursExpanded.has(uid)) _hoursExpanded.delete(uid);
  else _hoursExpanded.add(uid);
  renderHoursReport();
};

function renderHoursReport() {
  const content = document.getElementById('hoursReportContent');
  const aggEl   = document.getElementById('aggHoursBanner');
  if (!content) return;

  const totalPlanned = chapters.reduce((s, ch) =>
    s + (ch.topics || []).reduce((ts, t) => ts + (+(t.duration ?? t.hour) || 0), 0), 0);

  let grandActual = 0;
  allTeachers.forEach(t => {
    const st = _mergedStatuses(t.uid);
    chapters.forEach(ch => (ch.topics || []).forEach(topic => {
      grandActual += parseFloat(st[`actual.${ch.id}.${topic.id}`]) || 0;
    }));
  });
  grandActual = Math.round(grandActual * 10) / 10;

  const pageTeachersH = allTeachers.slice(hoursPage * PAGE_SIZE, (hoursPage + 1) * PAGE_SIZE);

  const rows = pageTeachersH.map(t => {
    const st       = _mergedStatuses(t.uid);
    let actual     = 0;
    chapters.forEach(ch => (ch.topics || []).forEach(topic => {
      actual += parseFloat(st[`actual.${ch.id}.${topic.id}`]) || 0;
    }));
    actual = Math.round(actual * 10) / 10;

    const diff     = Math.round((actual - totalPlanned) * 10) / 10;
    const pillCls  = actual === 0 ? '' : diff > 2 ? 'hours-over' : diff < -2 ? 'hours-under' : 'hours-match';
    const label    = actual === 0 ? '—' : diff === 0 ? '✓ On track' : diff > 0 ? `+${diff}h over` : `${Math.abs(diff)}h under`;
    const barPct   = totalPlanned ? Math.min(100, Math.round(actual / totalPlanned * 100)) : 0;
    const barColor = barPct >= 100 ? '#dc2626' : barPct >= 80 ? '#1e7a4a' : '#3b82f6';
    const initials = (t.displayName || t.email || '?').split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const expanded = _hoursExpanded.has(t.uid);

    let drillHtml = '';
    if (expanded) {
      const chRows = chapters.map(ch => {
        const planned = (ch.topics||[]).reduce((s,tp) => s + (+(tp.duration??tp.hour)||0), 0);
        let logged = 0;
        (ch.topics||[]).forEach(tp => {
          logged += parseFloat(st[`actual.${ch.id}.${tp.id}`]) || 0;
        });
        logged = Math.round(logged * 10) / 10;

        const topicRows = (ch.topics||[]).map(tp => {
          const tPlan = +(tp.duration ?? tp.hour) || 0;
          const tLog  = Math.round((parseFloat(st[`actual.${ch.id}.${tp.id}`]) || 0) * 10) / 10;
          if (!tPlan && !tLog) return '';
          const tDiff = Math.round((tLog - tPlan) * 10) / 10;
          const tColor = tLog === 0 ? 'var(--ink-3)' : tDiff > 1 ? '#dc2626' : tDiff < -1 ? '#d97706' : '#15803d';
          return `<tr style="background:#fafaf8">
            <td style="padding:4px 14px 4px 36px;font-size:.72rem;color:var(--ink-2)">${escHtml(tp.topic)}</td>
            <td style="padding:4px 14px;font-size:.68rem;color:var(--ink-3);font-family:'DM Mono',monospace">${tPlan ? tPlan+'h' : '—'}</td>
            <td style="padding:4px 14px;font-size:.68rem;font-family:'DM Mono',monospace;color:${tLog?'var(--ink)':'var(--ink-3)'};font-weight:${tLog?'600':'400'}">${tLog ? tLog+'h' : '—'}</td>
            <td style="padding:4px 14px;font-size:.65rem;color:${tColor}">${tLog > 0 ? (tDiff >= 0 ? '+'+tDiff : tDiff)+'h' : ''}</td>
          </tr>`;
        }).join('');

        const chDiff = Math.round((logged - planned) * 10) / 10;
        const chColor = logged === 0 ? 'var(--ink-3)' : chDiff > 2 ? '#dc2626' : chDiff < -2 ? '#d97706' : '#15803d';
        return `<tr style="background:#f8f8f6;border-top:1px solid var(--border)">
          <td style="padding:6px 14px 6px 20px;font-size:.75rem;font-weight:600;color:var(--ink)">${escHtml(ch.chapter)}</td>
          <td style="padding:6px 14px;font-size:.72rem;font-family:'DM Mono',monospace;color:var(--ink-2)">${planned ? planned+'h' : '—'}</td>
          <td style="padding:6px 14px;font-size:.72rem;font-family:'DM Mono',monospace;font-weight:600;color:${logged?'var(--ink)':'var(--ink-3)'}">${logged ? logged+'h' : '—'}</td>
          <td style="padding:6px 14px;font-size:.7rem;color:${chColor}">${logged > 0 ? (chDiff >= 0 ? '+'+chDiff : chDiff)+'h' : ''}</td>
        </tr>${topicRows}`;
      }).join('');
      drillHtml = `<tr><td colspan="4" style="padding:0;border-top:1px solid #e5e7eb">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:#f1f5f9">
            <th style="padding:5px 14px 5px 20px;font-size:.6rem;text-align:left;color:var(--ink-3);font-weight:700;text-transform:uppercase;letter-spacing:.06em">Chapter / Topic</th>
            <th style="padding:5px 14px;font-size:.6rem;text-align:left;color:#92400e;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Planned</th>
            <th style="padding:5px 14px;font-size:.6rem;text-align:left;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Logged</th>
            <th style="padding:5px 14px;font-size:.6rem;text-align:left;color:var(--ink-3);font-weight:700;text-transform:uppercase;letter-spacing:.06em">Diff</th>
          </tr></thead>
          <tbody>${chRows}</tbody>
        </table>
      </td></tr>`;
    }

    return `<tr class="hours-teacher-row" onclick="toggleHoursDrilldown('${escHtml(t.uid)}')" style="cursor:pointer" title="Click to ${expanded ? 'collapse' : 'expand'} topic breakdown">
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:.6rem;color:var(--ink-3);flex-shrink:0">${expanded ? '▾' : '▸'}</span>
          <div class="teacher-avatar" style="width:32px;height:32px;font-size:.72rem;flex-shrink:0">${initials}</div>
          <div>
            <div style="font-size:.84rem;font-weight:600;color:var(--ink)">${escHtml(t.displayName || t.email)}</div>
            <div style="font-size:.65rem;color:var(--ink-3)">${escHtml(t.email)}</div>
          </div>
        </div>
      </td>
      <td><span style="font-family:'DM Mono',monospace;font-size:.82rem;font-weight:600">${totalPlanned}h</span></td>
      <td><span style="font-family:'DM Mono',monospace;font-size:.82rem;font-weight:${actual>0?'700':'400'};color:${actual>0?'var(--ink)':'var(--ink-3)'}">${actual > 0 ? actual+'h' : '—'}</span></td>
      <td>
        ${actual > 0 ? `
          <div style="display:flex;align-items:center;gap:8px">
            <span class="hours-pill ${pillCls}">${label}</span>
            <div style="flex:1;max-width:120px">
              <div class="hours-ratio-bar"><div class="hours-ratio-fill" style="width:${barPct}%;background:${barColor}"></div></div>
              <div style="font-size:.58rem;color:var(--ink-3);margin-top:2px">${barPct}% of planned</div>
            </div>
          </div>` : '<span style="font-size:.75rem;color:var(--ink-3)">No hours logged</span>'}
      </td>
    </tr>${drillHtml}`;
  }).join('');

  content.innerHTML = `<table class="hours-table">
    <thead><tr>
      <th style="width:35%">Teacher</th>
      <th style="color:#92400e">Planned Hours</th>
      <th style="color:#166534">Logged Hours</th>
      <th>Status</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  renderPager('hoursPager', hoursPage, allTeachers.length, 'goHoursPage');

  const diffTotal = Math.round((grandActual - totalPlanned) * 10) / 10;
  const diffColor = diffTotal > 2 ? '#dc2626' : diffTotal < -2 ? '#d97706' : '#1e7a4a';
  const diffCls   = diffTotal > 2 ? 'accent' : diffTotal < -2 ? 'amber' : 'green';
  aggEl.innerHTML = `
    <div class="agg-stat blue"><div class="agg-stat-num">${allTeachers.length}</div><div class="agg-stat-label">Teachers</div></div>
    <div class="agg-stat"><div class="agg-stat-num">${totalPlanned}h</div><div class="agg-stat-label">Total Planned</div></div>
    <div class="agg-stat green"><div class="agg-stat-num">${grandActual > 0 ? grandActual+'h' : '—'}</div><div class="agg-stat-label">Total Logged</div></div>
    <div class="agg-stat ${diffCls}"><div class="agg-stat-num" style="color:${diffColor}">${grandActual > 0 ? (diffTotal >= 0 ? '+' : '')+diffTotal+'h' : '—'}</div><div class="agg-stat-label">Difference</div></div>`;
}

window.goHoursPage = function(p) {
  const total = Math.ceil(allTeachers.length / PAGE_SIZE);
  if (p < 0 || p >= total) return;
  hoursPage = p;
  renderHoursReport();
  document.getElementById('hoursReportContent').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ── Reset paging on class/data change ────────────────────────
window.selectClass = function(cls, btn) {
  selectedClass = cls;
  progressPage = 0; hoursPage = 0;
  document.querySelectorAll('.class-chip').forEach(c => c.classList.remove('on'));
  btn.classList.add('on');
  renderProgressView();
};

// ── Modal close ───────────────────────────────────────────────
document.getElementById('chapterModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeChapterModal(); });
document.getElementById('topicModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeTopicModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeChapterModal(); closeTopicModal(); }
  if (e.key === 'Enter' && document.getElementById('chapterModal').style.display !== 'none') {
    if (document.activeElement?.tagName !== 'TEXTAREA') saveChapterModal();
  }
});

// ── Academic calendar helpers ─────────────────────────────────
function _calParseDate(str) {
  if (!str) return null;
  const d = new Date(str + 'T00:00:00');
  return isNaN(d) ? null : d;
}

function weekInfo(weekNum) {
  if (!calSettings || !calSettings.academicYearStart || !weekNum) return null;
  const yearStart = _calParseDate(calSettings.academicYearStart);
  if (!yearStart) return null;
  const MS_WEEK = 7 * 24 * 3600 * 1000;
  const monDate = new Date(yearStart.getTime() + (weekNum - 1) * MS_WEEK);
  const friDate = new Date(monDate.getTime() + 4 * 24 * 3600 * 1000);

  let termLabel = '';
  const terms = calSettings.terms || [];
  for (const term of terms) {
    const ts = _calParseDate(term.start);
    const te = _calParseDate(term.end);
    if (ts && te && monDate >= ts && monDate <= te) {
      termLabel = term.label || '';
      break;
    }
  }
  return { monDate, friDate, termLabel };
}

function fmtShortDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function renderCalStrip() {
  const strip = document.getElementById('calStrip');
  if (!strip || !calSettings) return;
  const yearStart = _calParseDate(calSettings.academicYearStart);
  const totalWeeks = calSettings.totalTeachingWeeks || '?';
  const terms = calSettings.terms || [];

  let html = `
    <div class="cal-strip-item">
      <span class="cal-strip-dot"></span>
      Academic year starts <strong>${yearStart ? fmtShortDate(yearStart) : '—'}</strong>
    </div>
    <div class="cal-strip-item">Total <strong>${totalWeeks}</strong> teaching weeks</div>`;

  terms.forEach(t => {
    const ts = _calParseDate(t.start), te = _calParseDate(t.end);
    if (ts && te) {
      html += `<div class="cal-strip-item"><span class="cal-strip-term">${escHtml(t.label||'Term')}</span> ${fmtShortDate(ts)} – ${fmtShortDate(te)}</div>`;
    }
  });

  html += `<a class="cal-strip-link" href="academic-calendar">⚙ Year Settings →</a>`;
  strip.innerHTML = html;
  strip.style.display = 'flex';
}

// ── authReady ─────────────────────────────────────────────────
document.addEventListener('authReady', ({ detail: { user, profile } }) => {
  // central_admin OR central_user with 'coordinator' sub-role can edit pacing
  // (matches Firestore rules: isAdmin() || isCHCoordinator())
  const isCentralAdmin = profile?.role_centralhub === 'central_admin' || profile?.role === 'central_admin';
  isCoordinator  = profile?.role_centralhub === 'central_user'
                   && Array.isArray(profile?.ch_sub_roles)
                   && profile.ch_sub_roles.includes('coordinator');
  isAdmin = isCentralAdmin || isCoordinator;

  db = window.db;
  document.getElementById('mainContent').style.display = '';
  if (isAdmin) {
    document.querySelectorAll('.btn-add').forEach(b => b.style.display = '');
  } else {
    document.querySelectorAll('.btn-add').forEach(b => b.style.display = 'none');
  }

  if (PROGRESSION_GRID) {
    const tabBtn = document.getElementById('tabBtnProgression');
    if (tabBtn) tabBtn.style.display = '';
  }

  getDoc(doc(db, 'calendar_settings', 'current')).then(snap => {
    if (snap.exists()) {
      calSettings = snap.data();
      renderCalStrip();
      renderChapters();
    }
  }).catch(e => console.warn('calendar_settings load failed:', e));

  // @lint-allow-unbounded — auto-annotated; revisit if collection grows large
  getDocs(collection(db, 'cambridge_syllabus')).then(snap => {
    snap.forEach(d => { syllabusIndex[d.id] = d.data(); });
    syllabusReady = true;
    console.log(`Syllabus index loaded: ${Object.keys(syllabusIndex).length} codes`);
  }).catch(e => console.warn('cambridge_syllabus load failed:', e));

  // Optional: per-subject progression override (cambridge_syllabus_progression/{code})
  // If present, the Progression Grid uses these rows verbatim instead of
  // running the title-similarity heuristic.
  if (PROGRESSION_GRID && SYLLABUS_CODE) {
    getDoc(doc(db, 'cambridge_syllabus_progression', SYLLABUS_CODE)).then(snap => {
      if (snap.exists() && Array.isArray(snap.data().rows)) {
        _progOverrideRows = snap.data().rows;
        console.log(`Progression override loaded: ${_progOverrideRows.length} rows`);
      } else {
        _progOverrideRows = []; // explicitly mark as "checked, none"
      }
    }).catch(e => console.warn('progression override load failed:', e));
  }

  onSnapshot(doc(db, COLLECTION, DOC_ID), snap => {
    if (snap.exists()) {
      chapters = snap.data().chapters || [];
      classList = snap.data().classes || [];
    } else {
      chapters = [];
      classList = [];
    }
    renderChapters();
  });
});

// ══════════════════════════════════════════════════════════════════
// Progression Grid (Stage 7 → 8 → 9 — Lower Secondary Checkpoint)
// ══════════════════════════════════════════════════════════════════

// Strand prefix → component label. Falls back to entry.component if known.
// Used only by the heuristic path; the override path reads `component` from
// the curated Firestore doc directly.
const STRAND_TO_COMPONENT = {
  // Math (0862)
  Ni: 'Number', Np: 'Number', Nf: 'Number',
  Ae: 'Algebra', As: 'Algebra',
  Gg: 'Geometry and Measure', Gp: 'Geometry and Measure',
  Ss: 'Statistics and Probability', Sp: 'Statistics and Probability',
  // Science (0893)
  SIC: 'Science in Context',
  TWSm: 'Thinking and Working Scientifically',
  TWSp: 'Thinking and Working Scientifically',
  TWSc: 'Thinking and Working Scientifically',
  TWSa: 'Thinking and Working Scientifically',
  Bs: 'Biology', Bp: 'Biology', Be: 'Biology',
  Cm: 'Chemistry', Cp: 'Chemistry', Cc: 'Chemistry',
  Pf: 'Physics', Ps: 'Physics', Pe: 'Physics',
  ESp: 'Earth and Space', ESc: 'Earth and Space', ESs: 'Earth and Space',
};

let _progFilter = 'all';
let _progSearch = '';
let _progStateFilter = null; // null = no state filter; otherwise 'done'|'ontrack'|'behind'|'notstarted'|'missing'
let _progOverrideRows = null; // null = not yet loaded / not present; [] = loaded but empty
let _progCoverageByCode = null; // { '7Ni.02': { totalClasses, doneClasses, classes: [{cls, status, teacher}] } }
let _progCoverageLoading = false;
const _progCollapsed = new Set();   // components the user has collapsed in this session
let _progDefaultsApplied = false;   // flips after the first render so subsequent
                                    // re-renders (search/filter) don't reset state

// Distinct colour per component, used both by chips and accordion headers so
// the user keeps a consistent visual mental map across filter/grid views.
const PROG_COMPONENT_COLOR = {
  // Math (0862)
  'Number':                          '#7c3aed', // violet
  'Algebra':                         '#d97706', // amber
  'Geometry and Measure':            '#0891b2', // cyan
  'Statistics and Probability':      '#059669', // emerald
  // Science (0893)
  'Science in Context':              '#4f46e5', // indigo
  'Thinking and Working Scientifically': '#64748b', // slate
  'Biology':                         '#16a34a', // green
  'Chemistry':                       '#db2777', // pink
  'Physics':                         '#0284c7', // sky
  'Earth and Space':                 '#92400e', // brown
};
function _progColor(component) {
  return PROG_COMPONENT_COLOR[component] || '#64748b';
}

function _progParseCode(code) {
  // e.g. "7Ni.02" → { stage: 7, strand: 'Ni', num: 2 }
  // Strand may be 1–5 chars to cover Science codes like TWSm/TWSp/TWSc/TWSa/SIC/ESp/ESc/ESs.
  const m = /^(\d)([A-Za-z]{1,5})\.?(\d+)?/.exec(code || '');
  if (!m) return { stage: null, strand: '', num: 0 };
  return { stage: +m[1], strand: m[2], num: +(m[3] || 0) };
}

function _progComponent(entry, parsed) {
  if (entry?.component) return entry.component;
  return STRAND_TO_COMPONENT[parsed.strand] || 'Other';
}

// Stop words to ignore when computing title overlap. Without these, every
// pair would share "and", "of", "the", "use" and score artificially high.
const _PROG_STOPWORDS = new Set([
  'and','or','of','the','a','an','to','in','on','for','from','with','by',
  'is','are','as','that','this','these','those','use','using','using','can',
  'be','it','its','their','at','any','all','some','more','than','more','less',
  'between','within','given','via','do','does','using','include','includes',
  'including','etc','e.g.','i.e.',
]);

function _progTokens(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !_PROG_STOPWORDS.has(w))
  );
}

function _progSimilarity(tokensA, tokensB) {
  if (!tokensA.size || !tokensB.size) return 0;
  let inter = 0;
  tokensA.forEach(t => { if (tokensB.has(t)) inter++; });
  // Jaccard: intersection / union
  const union = tokensA.size + tokensB.size - inter;
  return union ? inter / union : 0;
}

// Build progression rows: group by (component, topicArea, strand), then align
// objectives by sequential index across stages. Matches the layout of
// Cambridge progression grid PDFs (one row = same family across 7/8/9).
function _progBuildRows() {
  if (!SYLLABUS_CODE) return [];
  const prefix = SYLLABUS_CODE + '_';

  // Helper: turn a code (e.g. "7Ni.02") into the row-cell entry rendered
  // by _progRenderCell, looking up syllabusIndex for title/tier/etc.
  const cellFromCode = (code) => {
    if (!code) return null;
    const key = prefix + code;
    const data = syllabusIndex[key];
    const parsed = _progParseCode(code);
    return {
      key, code, parsed,
      title: data?.title || '',
      tier: data?.tier || '',
      data: data || {},
    };
  };

  // ── Override path: if Firestore has a curated progression doc for this
  // subject, render it verbatim. This matches the official Cambridge PDF
  // exactly and avoids any heuristic mis-pairings.
  if (Array.isArray(_progOverrideRows) && _progOverrideRows.length) {
    return _progOverrideRows.map(r => ({
      component: r.component || 'Other',
      topicArea: r.topicArea || '',
      stage7: cellFromCode(r.stage7),
      stage8: cellFromCode(r.stage8),
      stage9: cellFromCode(r.stage9),
    }));
  }

  // ── Heuristic path: no override yet, infer rows from title similarity.
  const entries = [];
  Object.entries(syllabusIndex).forEach(([key, data]) => {
    if (!key.startsWith(prefix)) return;
    const code = data.code || key.slice(prefix.length);
    const parsed = _progParseCode(code);
    if (!parsed.stage || parsed.stage < 7 || parsed.stage > 9) return;
    entries.push({
      key, code, parsed,
      title: data.title || '',
      topicArea: data.topicArea || '',
      tier: data.tier || '',
      component: _progComponent(data, parsed),
      data,
    });
  });

  // Group by (component → topicArea → strand). Within each group, sort by
  // num and zip across stages by index.
  const groups = {};
  entries.forEach(e => {
    const ck = e.component;
    const tk = e.topicArea || '_';
    const sk = e.parsed.strand;
    groups[ck] ??= {};
    groups[ck][tk] ??= {};
    groups[ck][tk][sk] ??= { 7: [], 8: [], 9: [] };
    groups[ck][tk][sk][e.parsed.stage].push(e);
  });

  // Threshold for fuzzy title-overlap matching (Jaccard). Tuned for Cambridge
  // progression PDFs — they reuse the same key nouns across stages
  // ("brackets", "indices", "fractions", "ratio"), so even a modest overlap
  // is meaningful. Lower values risk false matches; higher values fragment
  // genuine progressions.
  const SIM_THRESHOLD = 0.18;

  const rows = [];
  Object.keys(groups).sort().forEach(component => {
    Object.keys(groups[component]).sort().forEach(topicArea => {
      const strands = groups[component][topicArea];
      Object.keys(strands).sort().forEach(strand => {
        const buckets = strands[strand];
        [7, 8, 9].forEach(s => buckets[s].sort((a, b) => a.parsed.num - b.parsed.num));

        // Pre-compute tokens once per entry.
        [7, 8, 9].forEach(s => buckets[s].forEach(e => { e._tokens = _progTokens(e.title); }));

        // Build progression rows by walking stages in order. Each Stage 7
        // objective seeds a row; Stage 8 / Stage 9 objectives are matched
        // to an existing row if their title overlap exceeds the threshold,
        // otherwise they start a new row (Stage-only progression).
        const localRows = buckets[7].map(e => ({
          component,
          topicArea: topicArea === '_' ? '' : topicArea,
          stage7: e, stage8: null, stage9: null,
        }));

        function placeIntoRow(stageKey, requiresPrevStage) {
          buckets[+stageKey.slice(-1)].forEach(entry => {
            // Find best unfilled row whose previous-stage cell exists and
            // whose title is most similar to this entry.
            let bestIdx = -1, bestSim = SIM_THRESHOLD;
            localRows.forEach((row, idx) => {
              if (row[stageKey]) return; // slot already taken
              const prev = row[requiresPrevStage];
              if (!prev) return;          // no anchor in previous stage
              const sim = _progSimilarity(prev._tokens, entry._tokens);
              if (sim > bestSim) { bestSim = sim; bestIdx = idx; }
            });
            if (bestIdx >= 0) {
              localRows[bestIdx][stageKey] = entry;
            } else {
              // No good anchor — start a fresh row at this stage only.
              localRows.push({
                component,
                topicArea: topicArea === '_' ? '' : topicArea,
                stage7: null, stage8: null, stage9: null,
                [stageKey]: entry,
              });
            }
          });
        }

        // Stage 8 anchors to Stage 7. Stage 9 anchors to Stage 8 first
        // (closer progression) and falls back to Stage 7 if no Stage 8 row.
        placeIntoRow('stage8', 'stage7');
        buckets[9].forEach(entry => {
          let bestIdx = -1, bestSim = SIM_THRESHOLD;
          localRows.forEach((row, idx) => {
            if (row.stage9) return;
            const anchor = row.stage8 || row.stage7;
            if (!anchor) return;
            const sim = _progSimilarity(anchor._tokens, entry._tokens);
            if (sim > bestSim) { bestSim = sim; bestIdx = idx; }
          });
          if (bestIdx >= 0) {
            localRows[bestIdx].stage9 = entry;
          } else {
            localRows.push({
              component,
              topicArea: topicArea === '_' ? '' : topicArea,
              stage7: null, stage8: null, stage9: entry,
            });
          }
        });

        // Sort rows so the table reads naturally: by lowest stage code present.
        localRows.sort((a, b) => {
          const aRef = a.stage7 || a.stage8 || a.stage9;
          const bRef = b.stage7 || b.stage8 || b.stage9;
          return aRef.parsed.num - bRef.parsed.num;
        });

        rows.push(...localRows);
      });
    });
  });
  return rows;
}

// Collect the set of coverage states present in a progression row,
// including 'missing' (objective exists in the framework but isn't
// linked to any pacing topic). Used by the legend state filter to
// fade rows that don't contain the requested state.
function _progRowStates(row) {
  const out = new Set();
  [row.stage7, row.stage8, row.stage9].forEach(item => {
    if (!item) return;
    const b = _progCoverageByCode && _progCoverageByCode[item.code];
    if (!b || !b.totalClasses) { out.add('missing'); return; }
    const s = _progCoverageState(b);
    if (s) out.add(s);
  });
  return out;
}

function _progRenderCell(item) {
  if (!item) return '<div class="prog-cell-empty" title="Not introduced at this stage">not introduced</div>';
  const tierBadge = item.tier
    ? ` <span class="syl-tier-badge ${escHtml(item.tier.toLowerCase())}" style="font-size:.55rem;padding:0 4px;border-radius:3px">${escHtml(item.tier)}</span>`
    : '';
  return `<div class="prog-cell">
    <span class="prog-code-row">
      <span class="prog-code" data-key="${escHtml(item.key)}">${escHtml(item.code)}${tierBadge}</span>
      ${_progCoverageBadge(item.code)}
    </span>
    <span class="prog-title" data-key="${escHtml(item.key)}">${escHtml(item.title)}</span>
  </div>`;
}

function renderProgressionGrid() {
  const wrap = document.getElementById('progressionGrid');
  if (!wrap) return;
  if (!syllabusReady || _progOverrideRows === null) {
    // Wait for both the syllabus index and the optional override doc to
    // settle before rendering — otherwise the heuristic path may flash
    // briefly before the override loads.
    wrap.innerHTML = '<div class="prog-empty">Loading syllabus…</div>';
    setTimeout(renderProgressionGrid, 400);
    return;
  }

  const rows = _progBuildRows();
  if (!rows.length) {
    wrap.innerHTML = `<div class="prog-empty">No progression data found for syllabus code <strong>${escHtml(SYLLABUS_CODE || '?')}</strong>.</div>`;
    return;
  }

  // Build filter chips from distinct components, on first render only.
  const chipBar = document.getElementById('progStrandFilter');
  if (chipBar && !chipBar.dataset.built) {
    const components = ['all', ...new Set(rows.map(r => r.component))];
    chipBar.innerHTML = components.map(c => {
      if (c === 'all') {
        return `<button class="prog-chip${c === _progFilter ? ' on' : ''}" data-comp="${escHtml(c)}">All strands</button>`;
      }
      const color = _progColor(c);
      return `<button class="prog-chip${c === _progFilter ? ' on' : ''}" data-comp="${escHtml(c)}" data-cmp-color="${color}" style="color:${color}">${escHtml(c)}</button>`;
    }).join('');
    chipBar.dataset.built = '1';
    chipBar.querySelectorAll('.prog-chip').forEach(btn => {
      btn.onclick = () => {
        _progFilter = btn.dataset.comp;
        chipBar.querySelectorAll('.prog-chip').forEach(b => b.classList.toggle('on', b.dataset.comp === _progFilter));
        renderProgressionGrid();
      };
    });
    const searchInput = document.getElementById('progSearchInput');
    if (searchInput) {
      searchInput.oninput = () => {
        _progSearch = searchInput.value.trim().toLowerCase();
        renderProgressionGrid();
      };
    }

    // Legend doubles as a state filter — clicking "behind schedule"
    // fades rows that don't contain a behind-schedule pill, etc.
    // Clicking the same item again clears the filter.
    const legend = document.getElementById('progStateLegend');
    if (legend) {
      legend.querySelectorAll('button[data-state]').forEach(btn => {
        btn.onclick = () => {
          const state = btn.dataset.state;
          _progStateFilter = (_progStateFilter === state) ? null : state;
          legend.querySelectorAll('button[data-state]').forEach(b => {
            b.classList.toggle('on', b.dataset.state === _progStateFilter);
          });
          renderProgressionGrid();
        };
      });
    }
  }

  const filtered = rows.filter(r => {
    if (_progFilter !== 'all' && r.component !== _progFilter) return false;
    if (_progSearch) {
      const hay = [
        r.topicArea,
        r.stage7?.code, r.stage7?.title,
        r.stage8?.code, r.stage8?.title,
        r.stage9?.code, r.stage9?.title,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(_progSearch)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    wrap.innerHTML = `<div class="prog-empty">No matching objectives.</div>`;
    return;
  }

  // Group filtered rows by component, preserving original order (rows are
  // already sorted by the override doc / heuristic). One <details> block
  // per component lets the user collapse strands they aren't reviewing.
  const groups = new Map(); // component → rows[]
  filtered.forEach(r => {
    if (!groups.has(r.component)) groups.set(r.component, []);
    groups.get(r.component).push(r);
  });

  // Default accordion state — applied only once per session: keep the first
  // component open, collapse the rest. After this, _progCollapsed reflects
  // user-driven open/close decisions and is preserved across re-renders
  // (filter, search) within the same session.
  if (!_progDefaultsApplied) {
    let i = 0;
    groups.forEach((_, component) => {
      if (i > 0) _progCollapsed.add(component);
      i++;
    });
    _progDefaultsApplied = true;
  }

  // Aggregate coverage across the codes in this component (skip "not in
  // pacing" — only count codes that actually appear in topic.syllabusRefs).
  // Returns the overall pct + per-stage pct breakdown so the header can
  // show where in the Stage 7→8→9 arc the gap is.
  function componentCoverage(rows) {
    if (!_progCoverageByCode) return null;
    const totals = {
      all: { done: 0, total: 0 },
      stage7: { done: 0, total: 0 },
      stage8: { done: 0, total: 0 },
      stage9: { done: 0, total: 0 },
    };
    rows.forEach(r => {
      ['stage7', 'stage8', 'stage9'].forEach(key => {
        const item = r[key];
        if (!item) return;
        const b = _progCoverageByCode[item.code];
        if (!b || !b.totalClasses) return;
        totals[key].done  += b.doneClasses;
        totals[key].total += b.totalClasses;
        totals.all.done   += b.doneClasses;
        totals.all.total  += b.totalClasses;
      });
    });
    if (!totals.all.total) return null;
    const pctOf = t => t.total ? Math.round(t.done / t.total * 100) : null;
    return {
      pct: pctOf(totals.all),
      done: totals.all.done,
      total: totals.all.total,
      stages: { 7: pctOf(totals.stage7), 8: pctOf(totals.stage8), 9: pctOf(totals.stage9) },
    };
  }

  let html = '';
  groups.forEach((groupRows, component) => {
    const collapsed = _progCollapsed.has(component);
    const cov = componentCoverage(groupRows);

    let covHtml = '';
    if (cov) {
      let covCls = 'prog-acc-cov-zero';
      if (cov.pct >= 90)      covCls = 'prog-acc-cov-full';
      else if (cov.pct >= 50) covCls = 'prog-acc-cov-mid';
      else if (cov.pct > 0)   covCls = 'prog-acc-cov-low';

      // Per-stage mini-bars surface where the gap is — e.g. Stage 7
      // 100% but Stage 9 5% means the strand is on track in earlier
      // stages and falls off later. A single average hides that.
      const stageBars = [7, 8, 9].map(s => {
        const p = cov.stages[s];
        if (p === null) return `<span class="prog-acc-stage prog-acc-stage-na" title="Stage ${s}: nothing in pacing yet">S${s}</span>`;
        let cls = 'prog-acc-stage-zero';
        if (p >= 90)      cls = 'prog-acc-stage-full';
        else if (p >= 50) cls = 'prog-acc-stage-mid';
        else if (p > 0)   cls = 'prog-acc-stage-low';
        return `<span class="prog-acc-stage ${cls}" title="Stage ${s}: ${p}% of class-objective slots completed">
          <span class="prog-acc-stage-label">S${s}</span>
          <span class="prog-acc-stage-track"><span class="prog-acc-stage-fill" style="width:${p}%"></span></span>
        </span>`;
      }).join('');

      covHtml = `
        <span class="prog-acc-stages" aria-hidden="true">${stageBars}</span>
        <span class="prog-acc-cov ${covCls}" title="${cov.done} of ${cov.total} class-objective slots completed across this strand.">${cov.pct}% avg</span>`;
    }

    let body = `<table class="prog-table">
      <thead><tr>
        <th class="col-topic">Topic Area</th>
        <th class="col-stage">Stage 7 <span class="prog-stage-sub">Year 7</span></th>
        <th class="col-stage">Stage 8 <span class="prog-stage-sub">Year 8</span></th>
        <th class="col-stage">Stage 9 <span class="prog-stage-sub">Year 9</span></th>
      </tr></thead><tbody>`;
    let lastArea = '';
    groupRows.forEach(r => {
      const topicLabel = r.topicArea && r.topicArea !== lastArea ? r.topicArea : '';
      const isAreaBoundary = topicLabel && lastArea !== ''; // true on every row that opens a new topic-area (after the first)
      if (topicLabel) lastArea = r.topicArea;
      const rowStates = _progRowStates(r);
      const fadeCls = (_progStateFilter && !rowStates.has(_progStateFilter)) ? ' prog-row-fade' : '';
      const boundaryCls = isAreaBoundary ? ' prog-row-area-start' : '';
      body += `<tr class="prog-row${fadeCls}${boundaryCls}">
        <td class="topic-cell">${escHtml(topicLabel)}</td>
        <td>${_progRenderCell(r.stage7)}</td>
        <td>${_progRenderCell(r.stage8)}</td>
        <td>${_progRenderCell(r.stage9)}</td>
      </tr>`;
    });
    body += `</tbody></table>`;

    const color = _progColor(component);
    html += `<details class="prog-acc" data-component="${escHtml(component)}" style="--cmp-color: ${color}"${collapsed ? '' : ' open'}>
      <summary class="prog-acc-summary">
        <span class="prog-acc-caret" aria-hidden="true">▸</span>
        <span class="prog-acc-title">${escHtml(component)}</span>
        <span class="prog-acc-count">${groupRows.length} ${groupRows.length === 1 ? 'row' : 'rows'}</span>
        ${covHtml}
      </summary>
      <div class="prog-acc-body">${body}</div>
    </details>`;
  });

  wrap.innerHTML = html;
  _progSyncToggleAllLabel();
  wrap.querySelectorAll('.prog-code, .prog-title').forEach(el => {
    el.onclick = () => openProgressionModal(el.dataset.key);
  });
  // Persist user collapse/expand state across re-renders.
  wrap.querySelectorAll('details.prog-acc').forEach(d => {
    d.addEventListener('toggle', () => {
      const c = d.dataset.component;
      if (d.open) _progCollapsed.delete(c);
      else        _progCollapsed.add(c);
      _progSyncToggleAllLabel();
    });
  });
}

// Update the "Expand all" / "Collapse all" button label based on current
// accordion state — shows whichever action would change more sections.
function _progSyncToggleAllLabel() {
  const label = document.getElementById('progToggleAllLabel');
  if (!label) return;
  const all = document.querySelectorAll('#progressionGrid details.prog-acc');
  if (!all.length) return;
  const openCount = Array.from(all).filter(d => d.open).length;
  // If at least half are open, offer to collapse; otherwise to expand.
  label.textContent = openCount >= all.length / 2 ? 'Collapse all' : 'Expand all';
}

window.toggleAllProgAccordions = function() {
  const all = document.querySelectorAll('#progressionGrid details.prog-acc');
  if (!all.length) return;
  const openCount = Array.from(all).filter(d => d.open).length;
  const shouldCollapse = openCount >= all.length / 2;
  all.forEach(d => {
    const c = d.dataset.component;
    d.open = !shouldCollapse;
    if (d.open) _progCollapsed.delete(c);
    else        _progCollapsed.add(c);
  });
  _progSyncToggleAllLabel();
};

// Dismissible info banner — preference persists per browser via
// localStorage so users don't see the explanation on every visit.
const _PROG_INFO_KEY = 'centralhub.progInfoDismissed.v1';
window.dismissProgInfo = function() {
  const el = document.getElementById('progInfoBanner');
  if (el) el.style.display = 'none';
  try { localStorage.setItem(_PROG_INFO_KEY, '1'); } catch (e) {}
};
function _progApplyInfoPreference() {
  const el = document.getElementById('progInfoBanner');
  if (!el) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem(_PROG_INFO_KEY) === '1'; } catch (e) {}
  if (dismissed) el.style.display = 'none';
}
// Apply on each authReady so the banner respects past dismissals.
document.addEventListener('authReady', () => {
  // Run after the next tick so the DOM has been laid out.
  setTimeout(_progApplyInfoPreference, 0);
});

window.openProgressionModal = function(key) {
  const entry = syllabusIndex[key];
  if (!entry) return;
  const titleEl = document.getElementById('progModalTitle');
  const bodyEl  = document.getElementById('progModalBody');
  if (!titleEl || !bodyEl) return;
  const code = entry.code || key.split('_').slice(1).join('_');
  const tier = entry.tier ? `<span class="prog-modal-tier">${escHtml(entry.tier)}</span>` : '';
  titleEl.innerHTML = `<span style="font-family:'DM Mono',monospace;font-size:.8rem;color:var(--accent-dk);margin-right:8px">${escHtml(code)}</span>${escHtml(entry.title || '')}${tier}`;

  let html = '';
  if (entry.topicArea) html += `<h4>Topic Area</h4><p>${escHtml(entry.topicArea)}</p>`;
  if (entry.description && entry.description !== entry.title) {
    html += `<h4>Description</h4><p>${escHtml(entry.description)}</p>`;
  }
  if (Array.isArray(entry.content) && entry.content.length) {
    html += `<h4>Content</h4><ul>${entry.content.map(c => `<li>${escHtml(c)}</li>`).join('')}</ul>`;
  } else if (typeof entry.content === 'string' && entry.content.trim()) {
    html += `<h4>Content</h4><p>${escHtml(entry.content)}</p>`;
  }
  if (entry.notes) {
    const notes = Array.isArray(entry.notes) ? entry.notes.join('\n') : entry.notes;
    if (notes && notes.trim()) html += `<h4>Notes</h4><p style="white-space:pre-wrap">${escHtml(notes)}</p>`;
  }
  if (entry.paper) html += `<h4>Stage</h4><p>${escHtml(entry.paper)}</p>`;
  bodyEl.innerHTML = html || '<p style="color:var(--ink-3)">No additional details.</p>';
  document.getElementById('progressionModal').style.display = 'flex';
};

window.closeProgressionModal = function() {
  document.getElementById('progressionModal').style.display = 'none';
};

// ── Pacing-aware coverage ────────────────────────────────────────
// For each objective code that appears in any topic.syllabusRefs, compute
// per-class coverage by joining live `chapters` (pacing structure) with
// `userProgress/{uid}` documents (per-class status maps written by
// teachers). The result is keyed by code so the Progression Grid can
// annotate each cell in O(1).
async function _progLoadCoverage() {
  if (_progCoverageLoading) return;
  _progCoverageLoading = true;
  try {
    if (!allTeachers.length) await fetchTeachers();

    // class → statusMap, plus class → owning teacher (for tooltips)
    const allowedUids   = new Set(allTeachers.map(t => t.uid));
    const progressByCls = {};
    const teacherByCls  = {};
    allTeachers.forEach(t => {
      (t[CLASSES_FIELD] || []).forEach(cls => {
        teacherByCls[cls.replace(/\s/g, '_')] = t;
      });
    });
    // @lint-allow-unbounded — auto-annotated; revisit if collection grows large
    const snap = await getDocs(collection(db, 'userProgress'));
    snap.forEach(d => {
      if (!allowedUids.has(d.id)) return;
      const data = d.data();
      Object.keys(data).forEach(key => {
        const m = key.match(PROGRESS_KEY_RE);
        if (!m) return;
        const cls = m[1];
        // Take the largest snapshot if a class appears under multiple teachers.
        if (!progressByCls[cls] ||
            Object.keys(data[key]).length > Object.keys(progressByCls[cls]).length) {
          progressByCls[cls] = data[key];
        }
      });
    });

    const classKeys = Object.keys(progressByCls);
    const cov = {};

    chapters.forEach(ch => {
      (ch.topics || []).forEach(topic => {
        const refs = Array.isArray(topic.syllabusRefs) ? topic.syllabusRefs : [];
        if (!refs.length) return;
        refs.forEach(code => {
          cov[code] ??= {
            totalClasses: 0,
            doneClasses: 0,
            inListedClasses: 0, // class has the topic in its pacing — i.e. always classKeys.length here
            classes: [],         // [{cls, status, teacher}]
          };
        });
        classKeys.forEach(cls => {
          const status = progressByCls[cls]?.[`${ch.id}.${topic.id}`] || 'pending';
          refs.forEach(code => {
            // For multi-ref topics, a class status applies to each ref; we
            // take the best (done > others) when the same code maps to
            // multiple topics in the same class.
            const bucket = cov[code];
            // Avoid double counting the same (code, cls) pair from another
            // topic by using a transient set on the bucket.
            bucket._seen ??= new Set();
            const k = cls;
            if (bucket._seen.has(k)) {
              // Upgrade if new status is "done" and previous wasn't.
              if (status === 'done' && !bucket._doneSet?.has(k)) {
                bucket._doneSet ??= new Set();
                bucket._doneSet.add(k);
                bucket.doneClasses++;
                // Replace classes[] entry's status if better.
                const prev = bucket.classes.find(c => c.cls === k);
                if (prev) prev.status = 'done';
              }
              return;
            }
            bucket._seen.add(k);
            bucket.totalClasses++;
            bucket.classes.push({
              cls,
              status,
              teacher: teacherByCls[cls] || null,
            });
            if (status === 'done') {
              bucket._doneSet ??= new Set();
              bucket._doneSet.add(k);
              bucket.doneClasses++;
            }
          });
        });
      });
    });

    // Strip transient bookkeeping, sort classes for stable display.
    Object.values(cov).forEach(b => {
      delete b._seen;
      delete b._doneSet;
      b.classes.sort((a, b) => a.cls.localeCompare(b.cls));
    });

    _progCoverageByCode = cov;
  } catch (e) {
    console.warn('progression coverage load failed:', e);
    _progCoverageByCode = {};
  } finally {
    _progCoverageLoading = false;
    // Re-render now that data is in.
    renderProgressionGrid();
  }
}

// Map a code's coverage record to a semantic state.
// Four states (plus loading/missing) — chosen so the colour reads as an
// action signal, not just a percentage:
//   done     — every class has finished it
//   ontrack  — at least half of the classes have, but not all
//   behind   — at least one class started, but fewer than half
//   notstarted — zero classes done
function _progCoverageState(b) {
  if (!b || !b.totalClasses) return null;
  const pct = b.doneClasses / b.totalClasses * 100;
  if (pct >= 100) return 'done';
  if (pct >= 50)  return 'ontrack';
  if (pct > 0)    return 'behind';
  return 'notstarted';
}

function _progCoverageBadge(code) {
  // Three top-level cases:
  //  • Coverage data not yet loaded → small placeholder dot
  //  • Code never appears in pacing structure → "Not in pacing" hint
  //  • Code is in pacing → segmented progress pill + done/total
  if (!_progCoverageByCode) {
    return `<span class="prog-cov prog-cov-loading" title="Loading coverage…">⋯</span>`;
  }
  const b = _progCoverageByCode[code];
  if (!b || !b.totalClasses) {
    return `<span class="prog-cov prog-cov-missing" title="This objective is not yet linked to any topic in the pacing structure.">not in pacing</span>`;
  }
  const state = _progCoverageState(b);
  // Cap the segment count so wide cohorts (8+ classes) don't blow out
  // the pill width — the numeric "done/total" stays authoritative.
  const segCount = Math.min(b.totalClasses, 5);
  const onCount = Math.round(b.doneClasses / b.totalClasses * segCount);
  let dots = '';
  for (let i = 0; i < segCount; i++) {
    dots += `<span class="${i < onCount ? 'on' : ''}"></span>`;
  }

  const lines = b.classes.map(c => {
    const icon = c.status === 'done' ? '✓' : (c.status === 'pending' ? '·' : c.status[0].toUpperCase());
    const t = c.teacher?.displayName || c.teacher?.name || '';
    return `${icon} ${c.cls.replace(/_/g, ' ')}${t ? ' — ' + t : ''}`;
  }).join('\n');
  const stateLabel = { done: 'all classes done', ontrack: 'on track', behind: 'behind schedule', notstarted: 'not started' }[state] || '';
  const tooltip = `${b.doneClasses}/${b.totalClasses} classes done — ${stateLabel}\n\n${lines}`;
  return `<span class="prog-cov prog-cov-${state}" data-state="${state}" title="${escHtml(tooltip)}"><span class="prog-cov-dots" aria-hidden="true">${dots}</span>${b.doneClasses}/${b.totalClasses}</span>`;
}
