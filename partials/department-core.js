// Department Workspace orchestrator.
//
// Single-page workspace that renders one department at a time, keyed by
// `?subject=<ch_subjects value>` in the URL. With no subject param, renders
// a picker landing (own subjects highlighted; admin/director sees all 9).
//
// MVP sections (4):
//   - overview        Live KPI strip (artifact completeness · leader count ·
//                     schools covered · last meeting date)
//   - annual-plan     Bound — reads department_artifacts where
//                     subjectId=X AND artifactType='annual_plan'
//   - subject-leaders Live — coordinators_directory_entries where
//                     subjectId=X AND entryKind='school_subject_leader'
//   - discussion      Free-text — department_notes/{subjectId}/sections/discussion_topics
//
// Loose read / tight write boundary:
//   - Any signed-in central_user (incl. coordinators of OTHER subjects) can READ
//     any department's workspace (network transparency, matches existing 4
//     Department Office cross-views).
//   - WRITE to free-text discussion is gated to subject-owning coordinators +
//     director + admin at the rule level.

import {
  collection, query, where, orderBy, onSnapshot,
  doc, getDoc, setDoc, serverTimestamp, limit
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

import {
  SUBJECTS, SUBJECT_LABELS, SUBJECT_BADGE, SUBJECT_EMOJI, SUBJECT_ACCENT, SUBJECT_PACING_LINKS, isValidSubject, subjectLabel
} from './subject-config.js';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let db = null;
let currentUser = null;
let userProfile = null;
let isAdmin = false;
let isDirector = false;
let userSubjects = [];  // ch_subjects[] of current user; empty for plain central_user

let activeSubject = null;            // selected subject (e.g. 'math') or null = picker
let canWriteActive = false;          // can current user write to activeSubject?
let unsubFns = [];                   // cleanup for Firestore listeners

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

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

// ---------------------------------------------------------------------------
// Entry point — called by department-workspace.html on authReady
// ---------------------------------------------------------------------------

export function initDepartmentWorkspace() {
  db = window.db;
  currentUser = window.currentUser;
  userProfile = window.userProfile || {};

  isAdmin = userProfile.role_centralhub === 'central_admin';
  const subRoles = Array.isArray(userProfile.ch_sub_roles) ? userProfile.ch_sub_roles : [];
  isDirector = subRoles.includes('director');
  userSubjects = Array.isArray(userProfile.ch_subjects) ? userProfile.ch_subjects : [];

  // Resolve route — ?subject= takes precedence; otherwise picker.
  const params = new URLSearchParams(window.location.search);
  const requested = (params.get('subject') || '').trim();

  if (requested && isValidSubject(requested)) {
    openSubject(requested);
  } else if (!requested && userSubjects.length === 1 && !isAdmin && !isDirector) {
    // Single-subject coordinator → auto-redirect to own subject.
    // Use replaceState so the back button doesn't bounce back to the picker.
    const target = `?subject=${encodeURIComponent(userSubjects[0])}`;
    window.history.replaceState({}, '', target);
    openSubject(userSubjects[0]);
  } else {
    renderPicker();
  }

  // Listen for in-page navigation (picker click → URL update → re-render).
  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(window.location.search);
    const s = (p.get('subject') || '').trim();
    clearListeners();
    if (s && isValidSubject(s)) openSubject(s); else renderPicker();
  });
}

// ---------------------------------------------------------------------------
// Picker landing — subject grid
// ---------------------------------------------------------------------------

function renderPicker() {
  activeSubject = null;
  canWriteActive = false;

  const host = $('workspaceRoot');
  if (!host) return;

  const myCount = userSubjects.length;
  const ctxLine = isAdmin
    ? 'Admin · pick any department to open its workspace.'
    : isDirector
      ? 'Director · pick any department to open its workspace.'
      : myCount === 0
        ? 'You have no ch_subjects[] assigned. Browse any department in read-only mode below.'
        : `Your specialty: ${userSubjects.map(subjectLabel).join(', ')}.`;

  // Sort so the coordinator's own subjects float to the top of the grid.
  // Within each group preserve the canonical SUBJECTS array order (Math
  // first, edu-steam last) so the layout is predictable for admins/directors
  // who see all 9.
  const orderedSubjects = [
    ...SUBJECTS.filter(s => userSubjects.includes(s)),
    ...SUBJECTS.filter(s => !userSubjects.includes(s)),
  ];

  const cards = orderedSubjects.map(s => {
    const isMine = userSubjects.includes(s);
    const writable = isAdmin || isDirector || isMine;
    const writeChip = writable
      ? '<span class="dw-pick-chip dw-pick-chip--write">Write access</span>'
      : '<span class="dw-pick-chip dw-pick-chip--read">Read-only</span>';
    return `
      <a class="dw-pick-card${isMine ? ' dw-pick-card--mine' : ''}"
         href="?subject=${encodeURIComponent(s)}"
         data-subject="${escHtml(s)}">
        <div class="dw-pick-badge" style="background:${SUBJECT_ACCENT[s]}" aria-hidden="true">
          <span class="dw-pick-emoji">${SUBJECT_EMOJI[s] || SUBJECT_BADGE[s]}</span>
        </div>
        <div class="dw-pick-body">
          <div class="dw-pick-name">${escHtml(SUBJECT_LABELS[s])}</div>
          ${writeChip}
        </div>
      </a>
    `;
  }).join('');

  host.innerHTML = `
    <div class="dw-pick-context">${escHtml(ctxLine)}</div>
    <div class="dw-pick-grid">${cards}</div>
    <div class="dw-pick-footnote">
      A department workspace gathers that subject's Annual Plan, school subject leaders,
      Coordinator's running notes, and recent activity in one canvas. The cross-subject
      lenses (<a href="coordinators-meetings">Meetings</a> ·
      <a href="decisions-register">Decisions</a> ·
      <a href="coordinators-directory">Directory</a> ·
      <a href="department-artifacts">Artifacts</a>) remain for HQ-wide views.
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Subject view — orchestrator
// ---------------------------------------------------------------------------

function openSubject(subjectId) {
  activeSubject = subjectId;
  canWriteActive = isAdmin || isDirector || userSubjects.includes(subjectId);

  const host = $('workspaceRoot');
  if (!host) return;

  const accent = SUBJECT_ACCENT[subjectId];
  const label = SUBJECT_LABELS[subjectId];
  const badge = SUBJECT_EMOJI[subjectId] || SUBJECT_BADGE[subjectId];
  const writeBadge = canWriteActive
    ? '<span class="dw-write-badge dw-write-badge--yes">You can edit</span>'
    : '<span class="dw-write-badge dw-write-badge--no">Read-only · not your subject</span>';

  host.innerHTML = `
    <div class="dw-subject-head">
      <div class="dw-subject-id-row">
        <div class="dw-subject-badge" style="background:${accent}" aria-hidden="true"><span>${badge}</span></div>
        <div class="dw-subject-title-block">
          <h2 class="dw-subject-title">${escHtml(label)} Department</h2>
          <div class="dw-subject-sub">${writeBadge}</div>
        </div>
      </div>
    </div>

    <!-- Overview KPI strip -->
    <section class="dw-section" data-section="overview" aria-label="Overview">
      <div class="dw-section-head">
        <h3 class="dw-section-title">Overview</h3>
      </div>
      <div class="dw-kpi-grid" id="dwKpiGrid">
        <div class="dw-kpi"><div class="dw-kpi-lbl">Artifacts</div><div class="dw-kpi-val" id="kpiArtifacts">—</div><div class="dw-kpi-sub">of 4 core types</div></div>
        <div class="dw-kpi"><div class="dw-kpi-lbl">Subject Leaders</div><div class="dw-kpi-val" id="kpiLeaders">—</div><div class="dw-kpi-sub">across the network</div></div>
        <div class="dw-kpi"><div class="dw-kpi-lbl">Schools Covered</div><div class="dw-kpi-val" id="kpiSchools">—</div><div class="dw-kpi-sub">with a named leader</div></div>
        <div class="dw-kpi"><div class="dw-kpi-lbl">Last Meeting</div><div class="dw-kpi-val" id="kpiLastMeeting">—</div><div class="dw-kpi-sub" id="kpiLastMeetingSub">no minutes yet</div></div>
      </div>
    </section>

    <!-- Annual Plan: pacing-link strip (auto) + Annual Strategy artifact (manual) -->
    <section class="dw-section" data-section="annual-plan" aria-label="Annual Plan">
      <div class="dw-section-head">
        <h3 class="dw-section-title">Annual Plan</h3>
        <span class="dw-section-mode">Pacing + Strategy</span>
      </div>

      <!-- Auto-rendered live links to the Cambridge pacing pages for this subject. -->
      <div class="dw-pacing-block">
        <div class="dw-block-lbl">
          <span class="dw-block-lbl-icon" aria-hidden="true">📐</span>
          <span>Pacing — Cambridge Curriculum</span>
          <span class="dw-block-lbl-hint">live · Curriculum > Pacing</span>
        </div>
        <div id="dwPacingStrip" class="dw-pacing-strip"></div>
      </div>

      <!-- Manual artifact slot — coordinator's annual strategy notes / PDF. -->
      <div class="dw-strategy-block">
        <div class="dw-block-lbl">
          <span class="dw-block-lbl-icon" aria-hidden="true">📋</span>
          <span>Annual Strategy</span>
          <span class="dw-block-lbl-hint">artifact · Department Artifacts</span>
        </div>
        <div id="dwAnnualPlan" class="dw-bound-slot"><div class="dw-loading">Loading…</div></div>
      </div>
    </section>

    <!-- Subject Leaders (live) -->
    <section class="dw-section" data-section="subject-leaders" aria-label="Subject leaders">
      <div class="dw-section-head">
        <h3 class="dw-section-title">Subject Leaders @ Schools</h3>
        <span class="dw-section-mode">Live · Directory</span>
      </div>
      <div id="dwLeaders" class="dw-leaders-slot"><div class="dw-loading">Loading…</div></div>
    </section>

    <!-- Discussion Topics (free-text) -->
    <section class="dw-section" data-section="discussion" aria-label="Discussion topics for school subject leaders">
      <div class="dw-section-head">
        <h3 class="dw-section-title">Discussion Topics</h3>
        <span class="dw-section-mode">Notes · Coordinator running list</span>
      </div>
      <div id="dwDiscussion" class="dw-notes-slot"><div class="dw-loading">Loading…</div></div>
    </section>
  `;

  // Wire each section.
  renderPacingStrip(subjectId);
  bindAnnualPlan(subjectId);
  bindSubjectLeaders(subjectId);
  bindDiscussion(subjectId);
  bindOverviewKpi(subjectId);
}

// ---------------------------------------------------------------------------
// Section: Pacing strip (auto-rendered, no Firestore)
// ---------------------------------------------------------------------------

function renderPacingStrip(subjectId) {
  const slot = $('dwPacingStrip');
  if (!slot) return;
  const links = SUBJECT_PACING_LINKS[subjectId] || [];
  if (!links.length) {
    slot.innerHTML = `
      <div class="dw-pacing-empty">
        No Cambridge pacing pages for ${escHtml(SUBJECT_LABELS[subjectId])} —
        the department is managed through the Annual Strategy artifact below.
      </div>
    `;
    return;
  }
  slot.innerHTML = links.map(L => `
    <a class="dw-pacing-link" href="${escHtml(L.slug)}">
      <span class="dw-pacing-stage">${escHtml(L.stage)}</span>
      <span class="dw-pacing-label">${escHtml(L.label)}</span>
      <svg class="dw-pacing-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
    </a>
  `).join('');
}

// ---------------------------------------------------------------------------
// Section: Annual Plan (bound artifact)
// ---------------------------------------------------------------------------

function bindAnnualPlan(subjectId) {
  const slot = $('dwAnnualPlan');
  if (!slot) return;

  // department_artifacts is unbounded across all subjects; we filter client-side
  // after a where() on subjectId + artifactType. Volumes are tiny (<20 docs).
  const q = query(
    collection(db, 'department_artifacts'),
    where('subjectId', '==', subjectId),
    where('artifactType', '==', 'annual_plan'),
    limit(20)
  );

  const unsub = onSnapshot(q, (snap) => {
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    docs.sort((a, b) => {
      const av = (a.version || 0); const bv = (b.version || 0);
      if (av !== bv) return bv - av;
      const at = a.updatedAt?.toMillis?.() || 0;
      const bt = b.updatedAt?.toMillis?.() || 0;
      return bt - at;
    });
    renderAnnualPlan(slot, subjectId, docs);
  }, (err) => {
    console.warn('[bindAnnualPlan]', err);
    slot.innerHTML = `<div class="dw-empty">Could not load Annual Plan (${escHtml(err.code || err.message || 'error')}).</div>`;
  });

  unsubFns.push(unsub);
}

function safeUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) ? String(url) : null;
}

function renderAnnualPlan(slot, subjectId, docs) {
  if (!docs.length) {
    slot.innerHTML = `
      <div class="dw-empty">
        <div class="dw-empty-title">No Annual Strategy uploaded yet for ${escHtml(SUBJECT_LABELS[subjectId])}.</div>
        <div class="dw-empty-desc">
          The Cambridge pacing pages above already cover <em>what</em> gets taught. Use the Annual Strategy artifact for the rest — yearly goals, staffing, budget, club plans, retrospective.
          ${canWriteActive
            ? ` <a href="department-artifacts?subject=${encodeURIComponent(subjectId)}&type=annual_plan">Open Department Artifacts</a> to upload one.`
            : ''}
        </div>
      </div>
    `;
    return;
  }

  const current = docs.find(d => d.status === 'current') || docs[0];
  const others = docs.filter(d => d.id !== current.id).slice(0, 3);

  const fileUrl = safeUrl(current.fileUrl) || safeUrl(current.externalUrl);
  const statusClass = current.status === 'current' ? 'current' : (current.status === 'archived' ? 'archived' : 'draft');

  slot.innerHTML = `
    <div class="dw-artifact-card">
      <div class="dw-artifact-row">
        <div class="dw-artifact-icon" aria-hidden="true">📋</div>
        <div class="dw-artifact-main">
          <div class="dw-artifact-title">${escHtml(current.title || 'Annual Strategy')}</div>
          <div class="dw-artifact-meta">
            <span class="dw-pill dw-pill--${statusClass}">${escHtml(current.status || 'draft')}</span>
            ${current.version ? `<span class="dw-pill">v${escHtml(current.version)}</span>` : ''}
            <span class="dw-artifact-when">Updated ${fmtRelative(current.updatedAt)}</span>
          </div>
          ${current.summary ? `<div class="dw-artifact-summary">${escHtml(current.summary)}</div>` : ''}
        </div>
        <div class="dw-artifact-actions">
          ${fileUrl ? `<a class="dw-btn-secondary" href="${fileUrl}" target="_blank" rel="noopener">Open ↗</a>` : ''}
          <a class="dw-btn-secondary" href="department-artifacts?subject=${encodeURIComponent(subjectId)}&type=annual_plan">Manage →</a>
        </div>
      </div>
    </div>
    ${others.length ? `
      <div class="dw-artifact-versions">
        <div class="dw-artifact-versions-lbl">Earlier versions</div>
        <ul class="dw-version-list">
          ${others.map(o => `
            <li>
              <span class="dw-pill dw-pill--${o.status === 'current' ? 'current' : (o.status === 'archived' ? 'archived' : 'draft')}">${escHtml(o.status || 'draft')}</span>
              ${o.version ? `<span class="dw-pill">v${escHtml(o.version)}</span>` : ''}
              <span class="dw-artifact-when">${fmtRelative(o.updatedAt)}</span>
              <span class="dw-version-title">${escHtml(o.title || 'Annual Plan')}</span>
            </li>
          `).join('')}
        </ul>
      </div>
    ` : ''}
  `;
}

// ---------------------------------------------------------------------------
// Section: Subject Leaders (live)
// ---------------------------------------------------------------------------

function bindSubjectLeaders(subjectId) {
  const slot = $('dwLeaders');
  if (!slot) return;

  const q = query(
    collection(db, 'coordinators_directory_entries'),
    where('subjectId', '==', subjectId),
    where('entryKind', '==', 'school_subject_leader'),
    limit(50)
  );

  const unsub = onSnapshot(q, (snap) => {
    const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    entries.sort((a, b) => {
      const sa = String(a.schoolName || a.school || '').toLowerCase();
      const sb = String(b.schoolName || b.school || '').toLowerCase();
      if (sa !== sb) return sa.localeCompare(sb);
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    renderLeaders(slot, subjectId, entries);
    updateKpi('kpiLeaders', entries.length);
    const schools = new Set(entries.map(e => e.schoolId).filter(Boolean));
    updateKpi('kpiSchools', schools.size);
  }, (err) => {
    console.warn('[bindSubjectLeaders]', err);
    slot.innerHTML = `<div class="dw-empty">Could not load subject leaders (${escHtml(err.code || err.message || 'error')}).</div>`;
  });

  unsubFns.push(unsub);
}

function renderLeaders(slot, subjectId, entries) {
  if (!entries.length) {
    slot.innerHTML = `
      <div class="dw-empty">
        <div class="dw-empty-title">No school subject leaders mapped for ${escHtml(SUBJECT_LABELS[subjectId])} yet.</div>
        <div class="dw-empty-desc">Open <a href="coordinators-directory">Directory</a> to add school subject leader rows.</div>
      </div>
    `;
    return;
  }
  slot.innerHTML = `
    <div class="dw-leaders-grid">
      ${entries.map(e => {
        const school = e.schoolName || e.school || '—';
        const phone = e.phone ? `<span class="dw-leader-phone">${escHtml(e.phone)}</span>` : '';
        const email = e.email ? `<a class="dw-leader-email" href="mailto:${escHtml(e.email)}">${escHtml(e.email)}</a>` : '';
        return `
          <div class="dw-leader-card">
            <div class="dw-leader-school">${escHtml(school)}</div>
            <div class="dw-leader-name">${escHtml(e.name || '—')}</div>
            ${e.position ? `<div class="dw-leader-position">${escHtml(e.position)}</div>` : ''}
            <div class="dw-leader-contact">${email}${phone}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Section: Discussion Topics (free-text)
// ---------------------------------------------------------------------------

function bindDiscussion(subjectId) {
  const slot = $('dwDiscussion');
  if (!slot) return;

  const ref = doc(db, 'department_notes', subjectId, 'sections', 'discussion_topics');

  const unsub = onSnapshot(ref, (snap) => {
    const data = snap.exists() ? snap.data() : null;
    renderDiscussion(slot, subjectId, ref, data);
  }, (err) => {
    console.warn('[bindDiscussion]', err);
    slot.innerHTML = `<div class="dw-empty">Could not load notes (${escHtml(err.code || err.message || 'error')}).</div>`;
  });

  unsubFns.push(unsub);
}

function renderDiscussion(slot, subjectId, ref, data) {
  const body = data?.contentMd || '';
  const lastEdit = data?.lastEditedAt ? fmtRelative(data.lastEditedAt) : null;
  const lastBy = data?.lastEditedByName ? escHtml(data.lastEditedByName) : '';

  if (!canWriteActive) {
    // Read-only view (other-subject coordinators, or this subject's
    // central_user without sub-role match — though loose-read covers all).
    slot.innerHTML = `
      <div class="dw-notes-readonly">
        ${body
          ? `<div class="dw-notes-body">${escHtml(body)}</div>`
          : `<div class="dw-empty"><div class="dw-empty-title">No discussion topics yet.</div><div class="dw-empty-desc">The ${escHtml(SUBJECT_LABELS[subjectId])} Coordinator has not added items to discuss with school subject leaders.</div></div>`}
        ${lastEdit ? `<div class="dw-notes-meta">Last edit ${lastEdit}${lastBy ? ` · by ${lastBy}` : ''}</div>` : ''}
      </div>
    `;
    return;
  }

  // Editable view (admin / director / this subject's coordinator)
  slot.innerHTML = `
    <div class="dw-notes-editor">
      <textarea class="dw-notes-textarea" id="dwNotesText"
                placeholder="What needs to be raised with school subject leaders this term? Free-form notes — one item per line works well."
                rows="8">${escHtml(body)}</textarea>
      <div class="dw-notes-foot">
        <div class="dw-notes-meta">
          ${lastEdit ? `Last saved ${lastEdit}${lastBy ? ` · by ${lastBy}` : ''}` : 'Not saved yet'}
        </div>
        <div class="dw-notes-actions">
          <button class="dw-btn-secondary" id="dwNotesCancel" type="button">Reset</button>
          <button class="dw-btn-primary" id="dwNotesSave" type="button">Save notes</button>
        </div>
      </div>
    </div>
  `;

  const textarea = $('dwNotesText');
  const btnSave = $('dwNotesSave');
  const btnCancel = $('dwNotesCancel');
  const originalBody = body;

  btnSave.addEventListener('click', async () => {
    const newBody = textarea.value;
    if (newBody === originalBody) {
      showToast('No changes.');
      return;
    }
    btnSave.disabled = true;
    btnSave.textContent = 'Saving…';
    try {
      await setDoc(ref, {
        subjectId,
        sectionId: 'discussion_topics',
        contentMd: newBody,
        lastEditedBy: currentUser.uid,
        lastEditedByName: userProfile.displayName || currentUser.email || 'Unknown',
        lastEditedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      showToast('Notes saved.');
    } catch (err) {
      console.warn('[discussion save]', err);
      showToast('Save failed: ' + (err.code || err.message || 'error'));
      btnSave.disabled = false;
      btnSave.textContent = 'Save notes';
    }
    // onSnapshot will re-render and reset originalBody on next pass.
  });

  btnCancel.addEventListener('click', () => {
    textarea.value = originalBody;
  });
}

// ---------------------------------------------------------------------------
// Section: Overview KPI strip
// ---------------------------------------------------------------------------

function updateKpi(id, val, subText) {
  const el = $(id);
  if (el) el.textContent = String(val);
  if (subText != null) {
    const sub = $(id + 'Sub');
    if (sub) sub.textContent = subText;
  }
}

function bindOverviewKpi(subjectId) {
  // Artifact-completeness count (out of 4 core types) — one-shot read,
  // cheap enough at this volume; no realtime needed for the KPI strip.
  const qArtifacts = query(
    collection(db, 'department_artifacts'),
    where('subjectId', '==', subjectId),
    limit(50)
  );
  const unsubA = onSnapshot(qArtifacts, (snap) => {
    const docs = snap.docs.map(d => d.data());
    const coreTypes = ['annual_plan', 'dtp_report', 'department_handbook', 'subject_policy'];
    const have = new Set(docs.filter(d => coreTypes.includes(d.artifactType)).map(d => d.artifactType));
    updateKpi('kpiArtifacts', `${have.size}/4`);
  }, (err) => {
    console.warn('[kpi artifacts]', err);
    updateKpi('kpiArtifacts', '—');
  });
  unsubFns.push(unsubA);

  // Last meeting date — coordinators_meetings is HQ-wide, not subject-scoped
  // (the existing G-Docs replacement workflow runs ONE weekly meeting that
  // covers all subjects). Show the most recent meeting date overall.
  const qMeetings = query(
    collection(db, 'coordinators_meetings'),
    orderBy('meetingDate', 'desc'),
    limit(1)
  );
  const unsubM = onSnapshot(qMeetings, (snap) => {
    if (snap.empty) {
      updateKpi('kpiLastMeeting', '—', 'no minutes yet');
      return;
    }
    const m = snap.docs[0].data();
    const d = m.meetingDate?.toDate ? m.meetingDate.toDate() : null;
    if (!d) {
      updateKpi('kpiLastMeeting', '—', 'no minutes yet');
      return;
    }
    const diff = Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
    const lbl = diff <= 0 ? 'today'
              : diff === 1 ? '1d ago'
              : diff < 30 ? `${diff}d ago`
              : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    updateKpi('kpiLastMeeting', lbl, m.title ? escHtml(m.title).slice(0, 64) : 'most recent meeting');
  }, (err) => {
    console.warn('[kpi meetings]', err);
    updateKpi('kpiLastMeeting', '—', 'could not load');
  });
  unsubFns.push(unsubM);
}
