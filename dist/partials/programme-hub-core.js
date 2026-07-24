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
  doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, serverTimestamp, limit,
  getCountFromServer
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

import {
  PROGRAMME_LABELS, PROGRAMME_ACRONYM, PROGRAMME_EMOJI, PROGRAMME_ACCENT,
  PROGRAMME_ACCENT_COLOR, PROGRAMME_PICS, PROGRAMME_LINKS, isValidProgramme,
  programmeLabel
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

// ---------------------------------------------------------------------------
// Utilities (copied from department-core.js — the ecosystem convention is that
// each surface ships its own tiny helper set rather than sharing a util module)
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function safeUrl(url) { return /^https?:\/\//i.test(url) ? url : '#'; }

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
  const titleEl = $('heroTitle');
  const descEl = $('heroDesc');
  const iconEl = $('heroIcon');
  if (titleEl) titleEl.textContent = label;
  if (descEl) descEl.textContent = PROGRAMME_ACRONYM[programKey] || '';
  if (iconEl) iconEl.textContent = emoji;
  // Thread the programme accent onto the root so section accent bars pick it up.
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

  const links = (PROGRAMME_LINKS[programKey] || []).map(l => `
    <a class="prog-link-card" href="${escHtml(l.slug)}">
      <div class="prog-link-title">${escHtml(l.label)} <span class="prog-link-arr" aria-hidden="true">→</span></div>
      <div class="prog-link-desc">${escHtml(l.desc || '')}</div>
    </a>`).join('');
  const linksBlock = links
    ? `<div class="prog-links-lbl">Related tools</div><div class="prog-links">${links}</div>`
    : '';

  host.innerHTML = `
    <!-- Overview -->
    <section class="dw-section" data-section="overview" aria-label="Overview">
      <div class="dw-section-head">
        <h3 class="dw-section-title">Overview</h3>
        <span class="dw-section-mode">Live · Read-only</span>
      </div>
      <div class="dw-kpi-grid" id="progKpiGrid">
        <div class="dw-kpi">
          <div class="dw-kpi-val" id="kpiWindow">—</div>
          <div class="dw-kpi-lbl">Active Window</div>
          <div class="dw-kpi-sub" id="kpiWindowSub">EASE Growth term</div>
        </div>
        <div class="dw-kpi">
          <div class="dw-kpi-val" id="kpiItems">—</div>
          <div class="dw-kpi-lbl">Item Bank</div>
          <div class="dw-kpi-sub">calibrated + bootstrap</div>
        </div>
        <div class="dw-kpi">
          <div class="dw-kpi-val" id="kpiDocs">—</div>
          <div class="dw-kpi-lbl">Documents</div>
          <div class="dw-kpi-sub">in this hub</div>
        </div>
        <div class="dw-kpi">
          <div class="dw-kpi-val" id="kpiMeetings">—</div>
          <div class="dw-kpi-lbl">Meetings</div>
          <div class="dw-kpi-sub">logged for this programme</div>
        </div>
      </div>
      ${picsBlock}
      ${linksBlock}
    </section>

    <!-- Documentation -->
    <section class="dw-section" data-section="documentation" aria-label="Documentation">
      <div class="dw-section-head">
        <h3 class="dw-section-title">Documentation</h3>
        <div class="dw-section-actions">
          <span class="dw-section-mode">Versioned · Artifacts</span>
          ${canWrite ? `<button class="btn-add prog-add" type="button" id="btnAddDoc">+ Add document</button>` : ''}
        </div>
      </div>
      <div id="progDocs" class="prog-slot"><div class="dw-loading">Loading…</div></div>
    </section>

    <!-- Calendar -->
    <section class="dw-section" data-section="calendar" aria-label="Calendar">
      <div class="dw-section-head">
        <h3 class="dw-section-title">Calendar</h3>
        <div class="dw-section-actions">
          <span class="dw-section-mode">Programme events</span>
          ${canWrite ? `<button class="btn-add prog-add" type="button" id="btnAddEvent">+ Add event</button>` : ''}
        </div>
      </div>
      <div id="progCalendar" class="prog-slot"><div class="dw-loading">Loading…</div></div>
    </section>

    <!-- Meetings -->
    <section class="dw-section" data-section="meetings" aria-label="Meeting records">
      <div class="dw-section-head">
        <h3 class="dw-section-title">Meeting Records</h3>
        <div class="dw-section-actions">
          <span class="dw-section-mode">Shared pool · Coordinators Meetings</span>
          ${canWrite ? `<button class="btn-add prog-add" type="button" id="btnAddMeeting">+ New meeting</button>` : ''}
        </div>
      </div>
      <div id="progMeetings" class="prog-slot"><div class="dw-loading">Loading…</div></div>
    </section>
  `;

  // Wire buttons
  if (canWrite) {
    const bDoc = $('btnAddDoc'); if (bDoc) bDoc.addEventListener('click', () => openDocModal(null));
    const bEvt = $('btnAddEvent'); if (bEvt) bEvt.addEventListener('click', () => openEventModal(null));
    const bMtg = $('btnAddMeeting'); if (bMtg) bMtg.addEventListener('click', createMeeting);
  }

  // Bind data
  bindOverviewKpi();
  bindDocs();
  bindCalendar();
  bindMeetings();
}

function deepLinkScroll() {
  const targetHash = window.location.hash.replace(/^#/, '');
  if (!targetHash) return;
  setTimeout(() => {
    const target = document.querySelector(`[data-section="${CSS.escape(targetHash)}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 140);
}

// ---------------------------------------------------------------------------
// Section: Overview KPIs (read-only)
// ---------------------------------------------------------------------------

async function bindOverviewKpi() {
  // Active EASE window (ease_growth only — other programmes just show "—").
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
        setText('kpiWindow', String(winLabel).replace(/_/g, ' '));
        setText('kpiWindowSub', w.academicYear ? `AY ${w.academicYear}` : 'open now');
      } else {
        setText('kpiWindow', 'Closed');
        setText('kpiWindowSub', 'no open window');
      }
    } catch (e) {
      setText('kpiWindow', '—');
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
    setText('kpiWindow', '—');
    setText('kpiWindowSub', 'not applicable');
    setText('kpiItems', '—');
  }
  // Docs + Meetings counts are filled by their own binds (bindDocs/bindMeetings).
}

function setText(id, txt) { const el = $(id); if (el) el.textContent = txt; }

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
    <div class="modal-overlay" id="docOverlay">
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
    <div class="modal-overlay" id="evtOverlay">
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
