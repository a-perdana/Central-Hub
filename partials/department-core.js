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
  doc, getDoc, getDocs, addDoc, deleteDoc, setDoc, serverTimestamp, limit
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

// Lazy caches for the inline "Add subject leader" composer.
let allSchoolsCache = null;          // [{id, name, domain, ...}], one-shot fetch
const staffBySchoolCache = new Map(); // schoolId -> [{id, name, email, phone, userId}]

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
      ? '<span class="dw-pick-chip dw-pick-chip--write">Write</span>'
      : '<span class="dw-pick-chip dw-pick-chip--read">Read-only</span>';

    // Cambridge stage chips with official syllabus codes — derived
    // from SUBJECT_PACING_LINKS. Each chip shows the stage marker
    // (Y1-6 / Y7-8 / Y9-10 / Y11-12) above the 4-digit Cambridge
    // syllabus code (e.g. 0580 for IGCSE Math). Codes cited from
    // curriculum-map.html SUBJECT_CONFIGS — single source of truth.
    const pacingLinks = SUBJECT_PACING_LINKS[s] || [];
    const stageOrder = ['Y1–6', 'Y7–8', 'Y9–10', 'Y11–12'];
    const stages = stageOrder
      .map(st => pacingLinks.find(l => l.stage === st))
      .filter(Boolean);
    const stagesHtml = stages.length
      ? stages.map(st => `
          <span class="dw-pick-stage" title="${escHtml(st.label)} · Cambridge ${escHtml(st.code || '')}">
            ${escHtml(st.stage)}
            ${st.code ? `<span class="dw-pick-stage-code">${escHtml(st.code)}</span>` : ''}
          </span>
        `).join('')
      : '<span class="dw-pick-stages-empty">Network-defined scope</span>';

    // Cambridge subject code line — fixed two-letter mono code under
    // the name, gives the card a Cambridge-syllabus feel without
    // claiming a specific 4-digit code (those live on the pacing pages).
    const subjectCode = SUBJECT_BADGE[s] || '';

    // Cambridge stage coverage bar — 4 segments (Y1-6, Y7-8, Y9-10,
    // Y11-12). A segment is "filled" if the subject ships a Cambridge
    // pacing page at that stage. Zero Firestore cost — pure derivation
    // from SUBJECT_PACING_LINKS. Math owns 4/4, English 2/4, Bahasa
    // 0/4, etc. Filled stages use the subject's accent gradient so
    // the bar reads as part of the card's identity.
    const filledCount = stages.length;
    const coverageHtml = stageOrder.map(stage => {
      const filled = pacingLinks.some(l => l.stage === stage);
      return `<span class="dw-pick-coverage-seg${filled ? ' dw-pick-coverage-seg--filled' : ''}" title="${escHtml(stage)} ${filled ? '· covered' : '· no Cambridge pacing'}"></span>`;
    }).join('');

    // Hover-reveal pacing jump strip — lets a coordinator dive
    // straight to a Cambridge pacing page from the picker without
    // opening the workspace first. Each chip is its own <a> with
    // stopPropagation so the card-level link doesn't swallow the
    // click. Subjects with no Cambridge pacing pages get a small
    // empty-state pointing back at the workspace.
    const jumpsHtml = pacingLinks.length
      ? pacingLinks.map(l => `
          <a href="${escHtml(l.slug)}"
             class="dw-pick-jump"
             title="${escHtml(l.label)} · Cambridge ${escHtml(l.code || '')}"
             onclick="event.stopPropagation()">
            ${escHtml(l.stage)}
            ${l.code ? `<span class="dw-pick-jump-code">${escHtml(l.code)}</span>` : ''}
          </a>
        `).join('')
      : '<span class="dw-pick-jumps-empty">No Cambridge pacing for this department.</span>';

    // Card is a <div role="link"> (not <a>) because it nests <a>
    // jump chips for direct pacing-page navigation. Nested anchors
    // are invalid HTML. Click + keyboard handlers below route
    // empty-area clicks to the workspace href.
    return `
      <div class="dw-pick-card${isMine ? ' dw-pick-card--mine' : ''}"
         role="link"
         tabindex="0"
         data-subject="${escHtml(s)}"
         data-href="?subject=${encodeURIComponent(s)}"
         aria-label="Open ${escHtml(SUBJECT_LABELS[s])} department workspace"
         style="--pick-grad:${SUBJECT_ACCENT[s]}">
        ${isMine ? '<span class="dw-pick-yours">★ Yours</span>' : ''}
        <div class="dw-pick-head">
          <div class="dw-pick-badge" style="background:${SUBJECT_ACCENT[s]}" aria-hidden="true">
            <span class="dw-pick-emoji">${SUBJECT_EMOJI[s] || SUBJECT_BADGE[s]}</span>
          </div>
          <div class="dw-pick-head-text">
            <div class="dw-pick-name">${escHtml(SUBJECT_LABELS[s])}</div>
            <div class="dw-pick-subject-code">Department · ${escHtml(subjectCode)}</div>
          </div>
        </div>
        <div class="dw-pick-coverage" aria-label="Cambridge stage coverage ${filledCount} of 4">
          <div class="dw-pick-coverage-track">${coverageHtml}</div>
          <span class="dw-pick-coverage-lbl">${filledCount}/4</span>
        </div>
        <div class="dw-pick-stages" aria-label="Cambridge stages">
          ${stagesHtml}
        </div>
        <div class="dw-pick-stats" data-subject-stats="${escHtml(s)}">
          <div class="dw-pick-stat">
            <span class="dw-pick-stat-val dw-pick-stat-val--muted" data-kpi="leaders">—</span>
            <span class="dw-pick-stat-lbl">Leaders</span>
          </div>
          <div class="dw-pick-stat">
            <span class="dw-pick-stat-val dw-pick-stat-val--muted" data-kpi="schools">—</span>
            <span class="dw-pick-stat-lbl">Schools</span>
          </div>
          <div class="dw-pick-stat">
            <span class="dw-pick-stat-val dw-pick-stat-val--muted" data-kpi="plan">—</span>
            <span class="dw-pick-stat-lbl">Annual Plan</span>
          </div>
          <div class="dw-pick-stat dw-pick-stat--detailed">
            <span class="dw-pick-stat-val dw-pick-stat-val--muted" data-kpi="last">—</span>
            <span class="dw-pick-stat-lbl">Last Activity</span>
          </div>
        </div>
        <div class="dw-pick-foot">
          ${writeChip}
          <span class="dw-pick-arrow" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </span>
        </div>
        <div class="dw-pick-jumps" aria-label="Jump to Cambridge pacing pages">
          <div class="dw-pick-jumps-lbl">Jump to pacing →</div>
          <div class="dw-pick-jumps-row">${jumpsHtml}</div>
        </div>
      </div>
    `;
  }).join('');

  // Resolve the saved density preference (defaults to 'comfortable').
  // Stored in localStorage so admins/directors who curate the 9-card
  // view don't have to re-pick on every visit.
  const initialDensity = readDensityPref();

  host.innerHTML = `
    <div class="dw-pick-context">${escHtml(ctxLine)}</div>
    <div class="dw-pick-toolbar" role="toolbar" aria-label="Card density">
      <span class="dw-pick-toolbar-lbl">View</span>
      <div class="dw-pick-density" role="group" aria-label="Density">
        <button type="button" class="dw-pick-density-btn" data-density="compact" aria-pressed="${initialDensity === 'compact'}">Compact</button>
        <button type="button" class="dw-pick-density-btn" data-density="comfortable" aria-pressed="${initialDensity === 'comfortable'}">Comfortable</button>
        <button type="button" class="dw-pick-density-btn" data-density="detailed" aria-pressed="${initialDensity === 'detailed'}">Detailed</button>
      </div>
    </div>
    <div class="dw-pick-grid" id="dwPickGrid" data-density="${escHtml(initialDensity)}">${cards}</div>
    <div class="dw-pick-footnote">
      A department workspace gathers that subject's Annual Plan, school subject leaders,
      Coordinator's running notes, and recent activity in one canvas. The cross-subject
      lenses (<a href="coordinators-meetings">Meetings</a> ·
      <a href="decisions-register">Decisions</a> ·
      <a href="coordinators-directory">Directory</a> ·
      <a href="department-artifacts">Artifacts</a>) remain for HQ-wide views.
    </div>
  `;

  wireDensityToggle();

  // Fire-and-forget live KPI population. Two batched reads cover all
  // 9 cards (instead of 18 per-card queries). Failures degrade
  // silently — cards keep the "—" placeholder.
  populatePickerKpis().catch(err => console.warn('[picker kpis]', err));

  wirePickerClicks();
}

// ---------------------------------------------------------------------------
// Density toggle — persisted in localStorage so admin's view choice
// survives reloads. Only the grid container's data-density changes;
// each card has CSS overrides per density value.
// ---------------------------------------------------------------------------

const DENSITY_PREF_KEY = 'ch-dw-pick-density';
const VALID_DENSITIES = ['compact', 'comfortable', 'detailed'];

function readDensityPref() {
  try {
    const v = localStorage.getItem(DENSITY_PREF_KEY);
    if (VALID_DENSITIES.includes(v)) return v;
  } catch (e) { /* private mode / disabled storage — fall through */ }
  return 'comfortable';
}

function writeDensityPref(v) {
  if (!VALID_DENSITIES.includes(v)) return;
  try { localStorage.setItem(DENSITY_PREF_KEY, v); } catch (e) { /* ignore */ }
}

function wireDensityToggle() {
  const grid = $('dwPickGrid');
  if (!grid) return;
  const btns = document.querySelectorAll('.dw-pick-density-btn[data-density]');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-density');
      if (!VALID_DENSITIES.includes(next)) return;
      grid.setAttribute('data-density', next);
      btns.forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
      writeDensityPref(next);
    });
  });
}

// Each .dw-pick-card is a <div role="link"> because it nests real
// <a> tags (the Cambridge pacing jump chips). We forward empty-area
// clicks + Enter/Space keypresses to the workspace href, and let
// the inner <a> chips handle their own navigation untouched.
function wirePickerClicks() {
  const cards = document.querySelectorAll('.dw-pick-card[data-href]');
  cards.forEach(card => {
    const href = card.getAttribute('data-href');
    if (!href) return;

    card.addEventListener('click', (e) => {
      // If the click landed inside (or on) a real anchor, let it
      // navigate normally — that's a jump chip doing its job.
      if (e.target.closest('a')) return;
      window.location.href = href;
    });

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        // Same rule for keyboard — focused chips own their own
        // activation, only the card-body Enter/Space opens the
        // workspace.
        if (e.target.closest('a')) return;
        e.preventDefault();
        window.location.href = href;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Picker live KPIs — 2 batched reads cover all 9 subject cards
// ---------------------------------------------------------------------------

async function populatePickerKpis() {
  if (!db) return;

  // Query 1: every school subject leader in the network. Network is
  // ~14 schools × 9 subjects = 126 max — well within Firestore single-
  // query limits. Cap at 500 for safety.
  const qLeaders = query(
    collection(db, 'coordinators_directory_entries'),
    where('entryKind', '==', 'school_subject_leader'),
    limit(500)
  );

  // Query 2: every annual-plan artifact across all subjects. Capped
  // at 9 subjects × small N versions each — typically ≤ 50 docs.
  const qPlans = query(
    collection(db, 'department_artifacts'),
    where('artifactType', '==', 'annual_plan'),
    limit(200)
  );

  let leaderSnap, planSnap;
  try {
    [leaderSnap, planSnap] = await Promise.all([
      getDocs(qLeaders),
      getDocs(qPlans),
    ]);
  } catch (err) {
    console.warn('[populatePickerKpis] read failed:', err);
    return;
  }

  // Group leaders + plans by subjectId. lastActivity = max updatedAt
  // across both sources (no extra Firestore read — the timestamps come
  // free with each doc we already fetched).
  const bySubject = new Map();
  const noteLastActivity = (subjectId, ts) => {
    if (!subjectId || !ts) return;
    const d = ts.toDate ? ts.toDate() : (ts instanceof Date ? ts : null);
    if (!d) return;
    const bucket = bySubject.get(subjectId);
    if (!bucket) return;
    if (!bucket.lastActivity || d > bucket.lastActivity) {
      bucket.lastActivity = d;
    }
  };
  const ensureBucket = (subjectId) => {
    let bucket = bySubject.get(subjectId);
    if (!bucket) {
      bucket = { leaders: 0, schools: new Set(), hasPlan: false, lastActivity: null };
      bySubject.set(subjectId, bucket);
    }
    return bucket;
  };

  leaderSnap.forEach(d => {
    const e = d.data();
    if (!e?.subjectId) return;
    const bucket = ensureBucket(e.subjectId);
    bucket.leaders += 1;
    if (e.schoolId) bucket.schools.add(e.schoolId);
    noteLastActivity(e.subjectId, e.updatedAt || e.createdAt);
  });

  // Mark which subjects have a current Annual Plan artifact. "current"
  // matches the existing department_artifacts pill convention — a
  // status field of 'current' (others are 'draft' / 'archived').
  planSnap.forEach(d => {
    const a = d.data();
    if (!a?.subjectId) return;
    const bucket = ensureBucket(a.subjectId);
    // Treat any non-archived annual_plan as "present"; the green check
    // is about whether the slot is filled, not lifecycle nuance.
    if (a.status !== 'archived') bucket.hasPlan = true;
    noteLastActivity(a.subjectId, a.updatedAt || a.createdAt);
  });

  // Paint each card's stat row. Subjects with no entries get a
  // muted "0" — informative on its own (signals "no leader yet").
  document.querySelectorAll('[data-subject-stats]').forEach(host => {
    const s = host.getAttribute('data-subject-stats');
    const b = bySubject.get(s) || { leaders: 0, schools: new Set(), hasPlan: false, lastActivity: null };
    paintPickerStat(host, 'leaders', b.leaders, b.leaders > 0 ? null : 'muted');
    paintPickerStat(host, 'schools', b.schools.size, b.schools.size > 0 ? null : 'muted');
    if (b.hasPlan) {
      paintPickerStat(host, 'plan', '✓', 'ok');
    } else {
      paintPickerStat(host, 'plan', '—', 'warn');
    }
    if (b.lastActivity) {
      paintPickerStat(host, 'last', fmtRelativeCompact(b.lastActivity), null);
    } else {
      paintPickerStat(host, 'last', '—', 'muted');
    }
  });
}

// Compact relative-date formatter for the picker's Last Activity
// cell — fits inside a ~50px mono span. "2d" / "3w" / "Mar 4" /
// "·" for null. Keeps the 4-cell grid readable in Detailed mode.
function fmtRelativeCompact(d) {
  if (!d) return '—';
  const diffMs = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return 'today';
  if (diffMs < 2 * day) return '1d';
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d`;
  if (diffMs < 30 * day) return `${Math.floor(diffMs / (7 * day))}w`;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function paintPickerStat(hostEl, kpi, value, variant) {
  const el = hostEl.querySelector(`[data-kpi="${kpi}"]`);
  if (!el) return;
  el.textContent = String(value);
  el.classList.remove(
    'dw-pick-stat-val--muted',
    'dw-pick-stat-val--ok',
    'dw-pick-stat-val--warn'
  );
  if (variant === 'muted') el.classList.add('dw-pick-stat-val--muted');
  else if (variant === 'ok') el.classList.add('dw-pick-stat-val--ok');
  else if (variant === 'warn') el.classList.add('dw-pick-stat-val--warn');
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
  const composer = canWriteActive ? renderLeaderComposerHtml(subjectId) : '';
  const grid = entries.length
    ? `<div class="dw-leaders-grid">${entries.map(e => renderLeaderCard(e)).join('')}</div>`
    : `<div class="dw-empty">
        <div class="dw-empty-title">No school subject leaders mapped for ${escHtml(SUBJECT_LABELS[subjectId])} yet.</div>
        <div class="dw-empty-desc">${canWriteActive
          ? 'Use the form above to add the first school subject leader — pick the school, then type the teacher’s name to autocomplete from Staff.'
          : 'A subject coordinator with write access can add school subject leaders here.'}</div>
      </div>`;

  slot.innerHTML = composer + grid;

  if (canWriteActive) wireLeaderComposer(subjectId);
  wireLeaderDeletes(slot);
}

function renderLeaderCard(e) {
  const school = e.schoolName || e.school || '—';
  const fullName = e.displayName || e.name || '—';
  const grad = SUBJECT_ACCENT[activeSubject] || 'linear-gradient(135deg,#7c3aed,#0891b2)';
  const initials = leaderInitials(fullName);

  const mailSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 7 9-7"/></svg>`;
  const phoneSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z"/></svg>`;

  const email = e.email
    ? `<div class="dw-leader-contact-row">${mailSvg}<a class="dw-leader-email" href="mailto:${escHtml(e.email)}" title="${escHtml(e.email)}">${escHtml(e.email)}</a></div>`
    : '';
  const phone = e.phone
    ? `<div class="dw-leader-contact-row">${phoneSvg}<span class="dw-leader-phone">${escHtml(e.phone)}</span></div>`
    : '';

  const removeBtn = canWriteActive
    ? `<button type="button" class="dw-leader-remove" data-remove="${escHtml(e.id)}" aria-label="Remove subject leader" title="Remove">×</button>`
    : '';

  return `
    <div class="dw-leader-card" style="--leader-grad:${grad}">
      <div class="dw-leader-strip">
        ${removeBtn}
        <div class="dw-leader-school">${escHtml(school)}</div>
      </div>
      <div class="dw-leader-body">
        <div class="dw-leader-avatar" aria-hidden="true"><span>${escHtml(initials)}</span></div>
        <div class="dw-leader-name">${escHtml(fullName)}</div>
        ${e.position ? `<div class="dw-leader-position">${escHtml(e.position)}</div>` : ''}
        ${(email || phone) ? `<div class="dw-leader-contact">${email}${phone}</div>` : ''}
      </div>
    </div>
  `;
}

function leaderInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '–';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderLeaderComposerHtml(subjectId) {
  return `
    <div class="dw-leader-composer" data-subject="${escHtml(subjectId)}">
      <div class="dw-leader-composer-lbl">Add a school subject leader</div>
      <div class="dw-leader-composer-row">
        <select class="dw-leader-school-select" id="dwLeaderSchool" aria-label="School">
          <option value="">Loading schools…</option>
        </select>
        <div class="dw-leader-staff-wrap">
          <input type="text" class="dw-leader-staff-input" id="dwLeaderStaff"
                 placeholder="Pick a school first…"
                 autocomplete="off" disabled
                 aria-label="Teacher name (autocomplete from Staff)">
          <div class="dw-leader-suggest" id="dwLeaderSuggest" hidden></div>
        </div>
        <button type="button" class="dw-btn-primary" id="dwLeaderAdd" disabled>Add subject leader</button>
      </div>
      <div class="dw-leader-composer-hint" id="dwLeaderHint">
        Pick a school. The teacher field autocompletes names from the Staff directory for that school.
      </div>
    </div>
  `;
}

function wireLeaderComposer(subjectId) {
  const schoolSel = $('dwLeaderSchool');
  const staffInput = $('dwLeaderStaff');
  const suggestBox = $('dwLeaderSuggest');
  const addBtn = $('dwLeaderAdd');
  const hint = $('dwLeaderHint');
  if (!schoolSel || !staffInput || !suggestBox || !addBtn || !hint) return;

  // Per-instance state — picked staff row (from autocomplete) clears when the
  // user re-types so we never write a stale email/name pair.
  let pickedStaff = null;

  // 1) Populate school <select> from cache.
  loadAllSchools().then((schools) => {
    schoolSel.innerHTML = '<option value="">— Choose school —</option>' + schools
      .map(s => `<option value="${escHtml(s.id)}">${escHtml(s.name || s.id)}</option>`)
      .join('');
  }).catch((err) => {
    console.warn('[leader composer schools]', err);
    schoolSel.innerHTML = '<option value="">(could not load schools)</option>';
  });

  // 2) When school changes, preload its teacher list so autocomplete is instant.
  schoolSel.addEventListener('change', async () => {
    pickedStaff = null;
    staffInput.value = '';
    suggestBox.hidden = true;
    addBtn.disabled = true;
    const schoolId = schoolSel.value;
    if (!schoolId) {
      staffInput.disabled = true;
      staffInput.placeholder = 'Pick a school first…';
      hint.textContent = 'Pick a school. The teacher field autocompletes names from the Staff directory for that school.';
      return;
    }
    staffInput.disabled = false;
    staffInput.placeholder = 'Type a teacher name…';
    hint.textContent = 'Loading teachers from Staff…';
    try {
      const teachers = await loadTeachersForSchool(schoolId);
      hint.textContent = teachers.length
        ? `${teachers.length} teacher${teachers.length === 1 ? '' : 's'} from Staff for this school — start typing to filter.`
        : 'No teachers found in Staff for this school. You can still add a leader manually by typing the name.';
    } catch (err) {
      console.warn('[leader composer teachers]', err);
      hint.textContent = 'Could not load Staff for this school — you can still type a name manually.';
    }
  });

  // 3) Autocomplete on staff input.
  staffInput.addEventListener('input', () => {
    pickedStaff = null;
    addBtn.disabled = !staffInput.value.trim();
    const schoolId = schoolSel.value;
    if (!schoolId) { suggestBox.hidden = true; return; }
    const teachers = staffBySchoolCache.get(schoolId) || [];
    const needle = staffInput.value.trim().toLowerCase();
    if (!needle) { suggestBox.hidden = true; return; }
    const matches = teachers.filter(t =>
      (t.name || '').toLowerCase().includes(needle) ||
      (t.email || '').toLowerCase().includes(needle)
    ).slice(0, 8);
    if (!matches.length) { suggestBox.hidden = true; return; }
    suggestBox.innerHTML = matches.map(t => `
      <div class="dw-leader-suggest-row" data-staff-id="${escHtml(t.id)}">
        <div class="dw-leader-suggest-name">${escHtml(t.name || '—')}</div>
        <div class="dw-leader-suggest-meta">${escHtml(t.email || '')}${t.department ? ` · ${escHtml(t.department)}` : ''}</div>
      </div>
    `).join('');
    suggestBox.hidden = false;
  });

  // Click on a suggestion → fill input + lock pickedStaff.
  suggestBox.addEventListener('mousedown', (ev) => {
    // mousedown (not click) so the input doesn't blur first and hide the box.
    const row = ev.target.closest('[data-staff-id]');
    if (!row) return;
    ev.preventDefault();
    const schoolId = schoolSel.value;
    const teachers = staffBySchoolCache.get(schoolId) || [];
    const t = teachers.find(x => x.id === row.dataset.staffId);
    if (!t) return;
    pickedStaff = t;
    staffInput.value = t.name || '';
    suggestBox.hidden = true;
    addBtn.disabled = false;
  });

  // Hide suggestions on blur (slight delay so click registers).
  staffInput.addEventListener('blur', () => {
    setTimeout(() => { suggestBox.hidden = true; }, 120);
  });

  // 4) Add button → write the entry.
  addBtn.addEventListener('click', async () => {
    const schoolId = schoolSel.value;
    const typedName = staffInput.value.trim();
    if (!schoolId || !typedName) {
      showToast('Pick a school and a teacher first.');
      return;
    }
    const schools = await loadAllSchools().catch(() => []);
    const school = schools.find(s => s.id === schoolId);
    const t = pickedStaff;  // may be null if admin typed a name manually
    const payload = {
      entryKind: 'school_subject_leader',
      displayName: t?.name || typedName,
      name: t?.name || typedName,  // legacy field
      positions: [],
      position: null,
      subjectIds: [subjectId],
      subjectId: subjectId,
      email: t?.email || '',
      phone: t?.phone || '',
      schoolId,
      schoolName: school?.name || schoolId,
      gradeLevel: null,
      gradeContext: '',
      roleNotes: '',
      userId: t?.userId || null,
      staffId: t?.id || null,
      status: 'active',
      createdBy: currentUser.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    addBtn.disabled = true;
    const originalLabel = addBtn.textContent;
    addBtn.textContent = 'Adding…';
    try {
      await addDoc(collection(db, 'coordinators_directory_entries'), payload);
      showToast(`Added ${payload.displayName} (${payload.schoolName}).`);
      // Reset the composer for the next entry.
      pickedStaff = null;
      staffInput.value = '';
      suggestBox.hidden = true;
      // onSnapshot will re-render the grid — re-rendering wipes this composer
      // and rebuilds it. Re-wiring is handled by renderLeaders().
    } catch (err) {
      console.warn('[leader add]', err);
      showToast(`Add failed: ${err.code || err.message || 'error'}`);
      addBtn.disabled = false;
      addBtn.textContent = originalLabel;
    }
  });
}

function wireLeaderDeletes(slot) {
  if (!canWriteActive) return;
  slot.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.remove;
      if (btn.dataset.confirming === 'true') {
        btn.dataset.confirming = 'false';
        btn.textContent = '×';
        try {
          await deleteDoc(doc(db, 'coordinators_directory_entries', id));
          showToast('Removed.');
        } catch (err) {
          console.warn('[leader remove]', err);
          showToast(`Remove failed: ${err.code || err.message || 'error'}`);
        }
        return;
      }
      btn.dataset.confirming = 'true';
      btn.textContent = '✓ confirm';
      setTimeout(() => {
        if (btn.dataset.confirming === 'true') {
          btn.dataset.confirming = 'false';
          btn.textContent = '×';
        }
      }, 3000);
    });
  });
}

async function loadAllSchools() {
  if (allSchoolsCache) return allSchoolsCache;
  const snap = await getDocs(query(collection(db, 'partner_schools'), orderBy('name')));
  allSchoolsCache = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.id !== 'eduversal_hq');  // HQ never carries Subject Leaders
  return allSchoolsCache;
}

async function loadTeachersForSchool(schoolId) {
  if (staffBySchoolCache.has(schoolId)) return staffBySchoolCache.get(schoolId);
  // Single-field index on schoolId is enough; role + status filtered client-side.
  const snap = await getDocs(query(
    collection(db, 'staff'),
    where('schoolId', '==', schoolId),
    limit(500)
  ));
  const list = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(t => (t.role || 'teacher') === 'teacher' && (t.status || 'active') === 'active')
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  staffBySchoolCache.set(schoolId, list);
  return list;
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
