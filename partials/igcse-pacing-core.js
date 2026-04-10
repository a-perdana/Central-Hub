/**
 * igcse-pacing-core.js — shared JS for all IGCSE subject pacing pages.
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
const SYLLABUS_CODE = window.PACING_CONFIG.syllabusCode || ''; // e.g. '0610', '0620', '0625'

let db, isAdmin = false;
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
  if (id === 'progress') loadProgressTab();
  if (id === 'heatmap')  loadHeatmapTab();
  if (id === 'hours')    loadHoursTab();
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

// Codes cell: inline input with autocomplete from igcse_syllabus
window.activateCodesInput = function(wrapEl, ci, ti) {
  if (wrapEl.querySelector('.inline-codes-input')) return;
  const topic = chapters[ci]?.topics?.[ti];
  if (!topic) return;

  const confirmedCodes = new Set(_parseObjCodes(topic.objective || ''));
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
    pillsEl.innerHTML = [...confirmedCodes].map(c =>
      `<span class="obj-code" data-remove="${escHtml(c)}" style="cursor:pointer" title="Click to remove ${escHtml(c)}">${escHtml(c)} ✕</span>`
    ).join('');
  }
  wrapEl.addEventListener('click', e => {
    const code = e.target.closest('[data-remove]')?.dataset.remove;
    if (code) { confirmedCodes.delete(code); renderPills(); }
  });
  renderPills();
  inp.focus();

  function getMatches(q) {
    if (!q) return [];
    const ql = q.toLowerCase();
    return Object.entries(syllabusIndex)
      .filter(([docId, d]) => {
        const displayCode = (d.code || '').toLowerCase();
        const subjectMatch = !SYLLABUS_CODE || docId.startsWith(SYLLABUS_CODE + '_');
        return subjectMatch && displayCode.startsWith(ql) && !confirmedCodes.has(d.code || '');
      })
      .sort(([,a],[,b]) => (a.code||'').localeCompare(b.code||''))
      .slice(0, 12)
      .map(([, d]) => [d.code || '', d]);
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
    const valid = Object.entries(syllabusIndex).some(([docId, d]) =>
      d.code === displayCode && (!SYLLABUS_CODE || docId.startsWith(SYLLABUS_CODE + '_')));
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
    const objective = [...confirmedCodes].join(' ');
    topic.objective = objective;
    try {
      await saveChapters();
      showToast('Codes saved ✓');
    } catch (e) {
      // saveChapters already showed error toast
    }
    renderChapters();
  }

  function restorePills(objective) {
    const codes = _parseObjCodes(objective);
    wrapEl.innerHTML = codes.map(c => {
      const entry = Object.values(syllabusIndex).find(d => d.code === c);
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
        const subjectMatch = !SYLLABUS_CODE || docId.startsWith(SYLLABUS_CODE + '_');
        return subjectMatch && (d.code||'').toLowerCase().startsWith(ql) && !_modalConfirmedCodes.has(d.code||'');
      })
      .sort(([,a],[,b]) => (a.code||'').localeCompare(b.code||''))
      .slice(0, 12)
      .map(([, d]) => [d.code||'', d]);
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
    const valid = Object.entries(syllabusIndex).some(([docId, d]) =>
      d.code === displayCode && (!SYLLABUS_CODE || docId.startsWith(SYLLABUS_CODE + '_')));
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
    const yearCls = ch.year === 'Year 9' ? 'yr9' : 'yr10';
    const topicsHtml = topics.length === 0
      ? '<div style="padding:10px 14px;font-size:.75rem;color:var(--ink-3)">No topics yet.</div>'
      : `<table class="topic-tbl">
          <thead><tr>
            <th style="width:30%">Topic</th>
            <th style="width:22%;color:#1d4ed8">Codes</th>
            <th style="width:8%;color:#92400e">Hours</th>
            <th style="width:8%;color:#166534">Week</th>
            <th style="width:18%">Notes &amp; Tags</th>
            <th style="width:14%">Actions</th>
          </tr></thead>
          <tbody>
            ${topics.map((t, ti) => {
              const codes = _parseObjCodes(t.objective);
              const dur   = t.duration ?? t.hour ?? '';
              const wk    = t.week ?? '';
              return `
              <tr>
                <td>
                  <div class="topic-name-cell" style="font-weight:500;font-size:.82rem;cursor:text"
                    title="Double-click to edit"
                    ondblclick="activateTopicNameInput(this,${ci},${ti})">${escHtml(t.topic)}</div>
                  ${t.resources && t.resources.length ? `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:4px">${t.resources.map(r => `<a class="res-chip" href="${safeUrl(r.url)}" target="_blank" rel="noopener">&#128279; ${escHtml(r.name||r.url)}</a>`).join('')}</div>` : ''}
                </td>
                <td>
                  <div class="inline-codes-wrap" onclick="activateCodesInput(this,${ci},${ti})" title="Click to edit codes">
                    ${codes.map(c => {
                      const entry = Object.values(syllabusIndex).find(d => d.code === c);
                      const tip = entry ? `${entry.tier ? '[' + entry.tier + '] ' : ''}${entry.title || ''}` : '';
                      return `<span class="obj-code"${tip ? ` data-tip="${escHtml(tip)}"` : ''}>${escHtml(c)}</span>`;
                    }).join('')}
                    ${codes.length === 0 ? `<span style="font-size:.65rem;color:var(--border)">+ codes</span>` : ''}
                  </div>
                </td>
                <td>
                  <input class="inline-input inline-input-num inline-input-hours" type="number" min="0" max="99"
                    value="${escHtml(String(dur))}" placeholder="—"
                    onchange="inlineSave(${ci},${ti},'duration',+this.value||1,this)"
                    title="Hours for this topic">
                </td>
                <td>
                  ${(() => {
                    const info = wk ? weekInfo(wk) : null;
                    const lbl  = info
                      ? `${fmtShortDate(info.monDate)}–${fmtShortDate(info.friDate)}${info.termLabel ? ` · ${info.termLabel}` : ''}`
                      : '';
                    const termCls = info?.termLabel ? ' term-lbl' : '';
                    return `<div class="week-cell">
                      <input class="inline-input inline-input-num inline-input-week" type="number" min="1" max="99"
                        value="${escHtml(String(wk))}" placeholder="—"
                        onchange="inlineSave(${ci},${ti},'week',+this.value||null,this)"
                        title="${lbl ? `Week ${wk}: ${lbl}` : 'School week number'}">
                      ${lbl ? `<span class="week-date-lbl${termCls}">${escHtml(lbl)}</span>` : ''}
                    </div>`;
                  })()}
                </td>
                <td>
                  ${t.coordNote ? `<div class="coord-note-text">${escHtml(t.coordNote)}</div>` : ''}
                  ${t.diag ? `<span class="diag-badge ${escHtml(t.diag)}">${t.diag === 'weak' ? '⚠ Weak' : t.diag === 'review' ? '↻ Review' : '✓ Good'}</span>` : ''}
                </td>
                <td>
                  <div style="display:flex;gap:4px;flex-wrap:wrap">
                    <button class="icon-btn edit" onclick="editTopic(${ci},${ti})" title="Edit topic">✎</button>
                    <button class="icon-btn del" onclick="deleteTopic(${ci},${ti})" title="Delete topic">✕</button>
                    ${ti > 0 ? `<button class="icon-btn move" onclick="moveTopic(${ci},${ti},-1)" title="Move up">↑</button>` : ''}
                    ${ti < topics.length-1 ? `<button class="icon-btn move" onclick="moveTopic(${ci},${ti},1)" title="Move down">↓</button>` : ''}
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;

    return `
      <div class="ch-item" id="ch-${ci}">
        <div class="ch-item-head" onclick="toggleCh(${ci})">
          <span class="ch-num">Ch ${ci+1}</span>
          <span class="ch-name">${escHtml(ch.chapter)}</span>
          <span class="ch-year-badge ${yearCls}">${escHtml(ch.year||'')}</span>
          <span style="font-size:.65rem;color:var(--ink-3);font-family:'DM Mono',monospace">${topics.length} topics</span>
          <div class="ch-actions" onclick="event.stopPropagation()">
            <button class="icon-btn edit" onclick="editChapter(${ci})" title="Edit chapter">✎</button>
            <button class="icon-btn del" onclick="deleteChapter(${ci})" title="Delete chapter">✕</button>
            ${ci > 0 ? `<button class="icon-btn move" onclick="moveChapter(${ci},-1)" title="Move up">↑</button>` : ''}
            ${ci < chapters.length-1 ? `<button class="icon-btn move" onclick="moveChapter(${ci},1)" title="Move down">↓</button>` : ''}
          </div>
          <span class="ch-caret">▾</span>
        </div>
        <div class="ch-body">
          ${topicsHtml}
          <button class="add-topic-btn" onclick="openAddTopicModal(${ci})">+ Add Topic</button>
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
  // Match syllabus codes: C1.1 (math) or 1.1 / 1.1.1 (other subjects)
  const matches = String(objStr).match(/[A-Z]?\d+\.\d+(?:\.\d+)*/g) || [];
  return [...new Set(matches)];
}

// ── Chapter CRUD ─────────────────────────────────────────────
window.openAddChapterModal = function() {
  _editChIdx = null;
  document.getElementById('chModalTitle').textContent = 'Add Chapter';
  document.getElementById('chNameInput').value = '';
  document.getElementById('chYearInput').value = 'Year 9';
  document.getElementById('chapterModal').style.display = 'flex';
  setTimeout(() => document.getElementById('chNameInput').focus(), 50);
};

window.editChapter = function(ci) {
  _editChIdx = ci;
  const ch = chapters[ci];
  document.getElementById('chModalTitle').textContent = 'Edit Chapter';
  document.getElementById('chNameInput').value = ch.chapter || '';
  document.getElementById('chYearInput').value = ch.year || 'Year 9';
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
  const snap = await getDocs(query(collection(db, 'users'), where('role_teachershub', '==', 'teachers_user')));
  allTeachers = [];
  snap.forEach(d => {
    const data = d.data();
    const teacherSubjects = data.subjects;
    if (!teacherSubjects || teacherSubjects.length === 0 || (SUBJECT_KEY && teacherSubjects.includes(SUBJECT_KEY))) {
      allTeachers.push({ uid: d.id, ...data });
    }
  });

  const profileClassSet = new Set();
  allTeachers.forEach(t => { (t.igcse_classes || []).forEach(c => profileClassSet.add(c)); });
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
        const m = key.match(/^statuses_(.+)$/);
        if (m) classSections[m[1].replace(/_/g, ' ')] = d[key];
      });
      if (d.statuses && !Object.keys(classSections).length) {
        classSections['—'] = d.statuses;
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
    if (selectedClass === 'year9')  return /\b9/.test(n) && !/10/.test(n);
    if (selectedClass === 'year10') return /10/.test(n);
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

    const hasClasses   = t.igcse_classes && t.igcse_classes.length > 0;
    const hasAnyData   = Object.keys(progressByTeacher[t.uid]?.classSections || {}).length > 0;
    const firstRow     = classRows[0];
    const isNoDataCard = firstRow?.noData;

    const classRowsHtml = isNoDataCard
      ? `<div class="teacher-no-data-row">
           ${!hasClasses
             ? `<span class="no-data-icon">📋</span> No classes assigned — teacher has not selected a class in Teachers Hub`
             : !hasAnyData
               ? `<span class="no-data-icon">📝</span> Classes assigned (${t.igcse_classes.join(', ')}) but no progress saved yet`
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
  const progressSnap = await getDocs(collection(db, 'userProgress'));
  const progressByClass = {};
  const teacherByClass  = {};

  allTeachers.forEach(t => {
    (t.igcse_classes || []).forEach(cls => {
      const key = cls.replace(/\s/g, '_');
      teacherByClass[key] = t;
    });
  });

  progressSnap.forEach(d => {
    if (!allowedUids.has(d.id)) return; // skip teachers not in this subject
    const data = d.data();
    Object.keys(data).forEach(key => {
      const m = key.match(/^statuses_(.+)$/);
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
  isAdmin = profile?.role_centralhub === 'central_admin' || profile?.role === 'central_admin';

  if (!isAdmin) {
    document.getElementById('accessDenied').style.display = '';
    return;
  }

  db = window.db;
  document.getElementById('mainContent').style.display = '';

  getDoc(doc(db, 'calendar_settings', 'current')).then(snap => {
    if (snap.exists()) {
      calSettings = snap.data();
      renderCalStrip();
      renderChapters();
    }
  }).catch(e => console.warn('calendar_settings load failed:', e));

  getDocs(collection(db, 'igcse_syllabus')).then(snap => {
    snap.forEach(d => { syllabusIndex[d.id] = d.data(); });
    syllabusReady = true;
    console.log(`Syllabus index loaded: ${Object.keys(syllabusIndex).length} codes`);
  }).catch(e => console.warn('igcse_syllabus load failed:', e));

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
