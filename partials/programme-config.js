// Canonical CH programme taxonomy.
//
// Source of truth for the 8 Management-Module programmes surfaced as cards on
// /index and, one page each, as programme hubs (/ease-growth, …). Each hub is a
// thin HTML shell that calls initProgrammeHub('<programKey>') from
// partials/programme-hub-core.js — this config drives the hub's identity
// (label, acronym, accent, PICs, related-tool deep-links, ES anchors).
//
// Models 1:1 on partials/subject-config.js (arrays + per-key maps + isValid*/
// *Label, module-local non-exported SVG() helper). The programme KEY is the
// stable `programKey` Firestore discriminator written onto shared ecosystem
// collections (coordinators_meetings, department_artifacts, calendar_events).
// Keep the underscore keys stable — they are Firestore values.
//
// Only 'ease_growth' carries full data today (the pilot). The other 7 are
// stubbed (label + acronym + accent + PICs) so the config is complete; each
// gets its LINKS / ES refs filled when its hub is built.

export const PROGRAMMES = [
  'ease_growth',
  'ease_assessment',
  'ease_academic',
  'appraisal_system',
  'induction_programs',
  'dtp',
  'aft',
  'atc',
];

export const PROGRAMME_LABELS = {
  ease_growth:        'EASE Growth',
  ease_assessment:    'EASE Assessment',
  ease_academic:      'EASE Academic',
  appraisal_system:   'Appraisal System',
  induction_programs: 'Induction Programs',
  dtp:                'DTP',
  aft:                'AFT',
  atc:                'ATC',
};

// Full acronym expansion / one-line "what this is". Shown in the hub hero desc.
export const PROGRAMME_ACRONYM = {
  ease_growth:        'Evaluation of Achievement Standardized Exam — Growth. Adaptive cross-grade growth assessment in Math, English, and Science.',
  ease_assessment:    'Evaluation of Achievement Standardized Exam — Common Assessments. Network-wide shared assessments across partner schools.',
  ease_academic:      'Evaluation of Achievement Standardized Exam — Academic. Per-subject achievement tracking across the Cambridge curriculum.',
  appraisal_system:   'Staff performance evaluation — objectives, appraisal cycles, and observations across the network.',
  induction_programs: 'Year-1 staff support — mentor assignments, induction windows, and completion certification.',
  dtp:                'Development of Teaching Proficiency — structured professional learning pathways and capacity-building.',
  aft:                'Academy of Future Teachers — pre-service teacher development, placements, and mentorship pathways.',
  atc:                'Academy Training Center — centralised training delivery, facilitation, and capacity programmes.',
};

// One-line "what this hub is" used in the page info-strip + footer CTA.
export const PROGRAMME_TAGLINE = {
  ease_growth:        'adaptive growth assessment in Math, English, and Science',
  ease_assessment:    'network-wide common assessments across partner schools',
  ease_academic:      'per-subject achievement tracking across the Cambridge curriculum',
  appraisal_system:   'staff performance evaluations, objectives, and appraisal cycles',
  induction_programs: 'year-1 staff support with mentors, windows, and certification',
  dtp:                'Development of Teaching Proficiency — professional learning pathways',
  aft:                'Academy of Future Teachers — pre-service teacher development',
  atc:                'Academy Training Center — centralised training delivery',
};

// Two-letter mono badge (matches subject-config's SUBJECT_BADGE convention).
export const PROGRAMME_BADGE = {
  ease_growth:        'EG',
  ease_assessment:    'EA',
  ease_academic:      'EA',
  appraisal_system:   'AP',
  induction_programs: 'IN',
  dtp:                'DT',
  aft:                'AF',
  atc:                'AT',
};

// Programme-themed emoji — primary visual on the hub hero.
export const PROGRAMME_EMOJI = {
  ease_growth:        '📈',
  ease_assessment:    '✅',
  ease_academic:      '🎓',
  appraisal_system:   '📋',
  induction_programs: '🧭',
  dtp:                '📚',
  aft:                '🍎',
  atc:                '🏫',
};

// Per-programme gradient — mirrors the index.html Management-Module card colours
// so the card and its hub feel like one surface.
export const PROGRAMME_ACCENT = {
  ease_growth:        'linear-gradient(140deg,#10b981,#0d9488)', // emerald (card mc-emerald)
  ease_assessment:    'linear-gradient(140deg,#0d9488,#0f766e)', // teal    (card mc-teal)
  ease_academic:      'linear-gradient(140deg,#0891b2,#0e7490)', // cyan    (card mc-cyan)
  appraisal_system:   'linear-gradient(140deg,#f59e0b,#b45309)', // amber   (card mc-amber)
  induction_programs: 'linear-gradient(140deg,#8b5cf6,#4338ca)', // violet  (card mc-violet)
  dtp:                'linear-gradient(140deg,#6366f1,#4338ca)', // indigo  (card mc-indigo)
  aft:                'linear-gradient(140deg,#059669,#047857)', // green   (card mc-green)
  atc:                'linear-gradient(140deg,#e11d48,#9f1239)', // rose    (card mc-rose)
};

// Deeper gradient stop — used as a solid tint (badge bg, accent bar).
export const PROGRAMME_ACCENT_COLOR = {
  ease_growth:        '#0d9488',
  ease_assessment:    '#0f766e',
  ease_academic:      '#0e7490',
  appraisal_system:   '#b45309',
  induction_programs: '#4338ca',
  dtp:                '#4338ca',
  aft:                '#047857',
  atc:                '#9f1239',
};

// Lead-Specialist (PIC) names — SAME list shown on the /index card head.
// AFT keeps the "AFT Coordinator" placeholder (Yusuf Tanriverdi omitted per
// user); ATC keeps "Akhmad Nur I. Tawqim" (to be added to the directory later).
export const PROGRAMME_PICS = {
  ease_growth:        ['Ridwan Sumitro', 'Muhammad Ali'],
  ease_assessment:    ['Ridwan Sumitro', 'Muhammad Ali'],
  ease_academic:      ['Fuad Imamguliyev', 'Aan Mulyana'],
  appraisal_system:   ['Muhammad Iqbal', 'Jaini Mukhlis'],
  induction_programs: ['Fuad Imamguliyev', 'Ridwan Sumitro'],
  dtp:                ['Eki Maulana', "Qurrota A'yun"],
  aft:                ['Akhmad Afwa', 'AFT Coordinator'],
  atc:                ['Akhmad Nur I. Tawqim', 'Aan Mulyana'],
};

// Related-tool deep-links surfaced in the hub's Overview section. Each link:
//   - slug:  canonical URL slug (page basename minus .html — page MUST exist)
//   - label: display string
//   - desc:  one-line "what this tool does"
// All slugs verified to exist (2026-07-25). AFT + ATC have no dedicated tool
// pages — they point at the closest generic surfaces (references / pd).
// Links every programme hub carries, appended after its own tools by
// programmeLinks(). Both are shared HQ surfaces keyed by the SAME programKey
// discriminator this hub writes — the Meetings section already reads
// coordinators_meetings, so these are the "open the full editor" routes back
// into the pool. Defined once here rather than repeated in all eight lists.
export const PROGRAMME_COMMON_LINKS = [
  { slug: 'coordinators-meetings', label: 'Coordinators Meetings', desc: 'Full meeting editor with agenda items — shared HQ meeting pool.' },
  { slug: 'decisions-register',    label: 'Decisions & Policies',  desc: 'Network-wide decisions surfaced from coordinator meetings.' },
];

export const PROGRAMME_LINKS = {
  ease_growth: [
    { slug: 'ease-item-author',   label: 'EASE Item Author',  desc: 'Author the 3-band adaptive item bank (Math / English / Science).' },
    { slug: 'ease-window-admin',  label: 'EASE Window Admin',  desc: 'Open and close the three EASE Growth windows per academic year.' },
    { slug: 'ease-bank-browser',  label: 'Latihan Browser',    desc: 'Read-only viewer into the upstream latihan.id question archive.' },
  ],
  ease_assessment: [
    { slug: 'chapter-test-author',        label: 'Chapter Tests',          desc: 'Author network-uniform chapter mastery tests anchored to Cambridge pacing units.' },
    { slug: 'question-bank',              label: 'Chapter Test Item Bank', desc: 'Standalone CRUD + reuse bank for chapter-test items with Cambridge metadata.' },
    { slug: 'assessment-management',      label: 'Pacing Assessments',     desc: 'Manage chapter-end assessments and topic activities embedded in the pacing guides.' },
    { slug: 'practice-assessment-author', label: 'Practice Tests',         desc: 'Compose or AI-rank practice assessments for Students Hub tournaments and leaderboards.' },
    { slug: 'practice-bank-admin',        label: 'Practice Questions',     desc: 'CRUD for supplemental practice items powering SH gamification (never formal grading).' },
  ],
  ease_academic: [
    { slug: 'teaching-progress',             label: 'Teaching Progress',    desc: 'Real-time view of teacher pacing progress across all subjects, live from Teachers Hub.' },
    { slug: 'curriculum-map',                label: 'Curriculum Map',       desc: 'Week-by-week visual of all subjects and Cambridge syllabus coverage.' },
    { slug: 'students-overview',             label: 'Students Overview',    desc: 'Network-wide roster of every Students Hub account across partner schools.' },
    { slug: 'primary-checkpoint-syllabus',   label: 'Primary Checkpoint',   desc: 'Manage chapter, topic, and syllabus-objective structure for Primary Checkpoint subjects.' },
    { slug: 'secondary-checkpoint-syllabus', label: 'Secondary Checkpoint', desc: 'Manage chapter, topic, and syllabus-objective structure for Secondary Checkpoint subjects.' },
  ],
  appraisal_system: [
    { slug: 'school-appraisals',    label: 'School Appraisals',    desc: 'Five-domain self-appraisal for partner schools; coordinators review and validate.' },
    { slug: 'teacher-appraisals',   label: 'Teacher Appraisals',   desc: 'All formal appraisal records and classroom walkthroughs across every school.' },
    { slug: 'school-visits',        label: 'School Visits',        desc: 'Log on-site monitoring, mid-year check-ins, and validation visits network-wide.' },
    { slug: 'principal-appraisals', label: 'Principal Appraisals', desc: 'Network-wide roll-up of every Foundation Rep annual appraisal on principals.' },
    { slug: 'walkthroughs',         label: 'Walkthroughs',         desc: 'Your personal appraisal walkthrough lens across the schools you serve.' },
    { slug: 'principal-360-admin',  label: 'Principal 360°',       desc: 'Launch 360 survey cycles, distribute invite links, and monitor response progress.' },
  ],
  induction_programs: [
    { slug: 'induction-admin',   label: 'Induction Admin',   desc: 'Assign mentors, track first-year cohorts, and manage the three induction handbook templates.' },
    { slug: 'my-induction',      label: 'My Induction',      desc: 'Specialist mentee dashboard with a 4-window Year-1 timeline and 10-walkthrough cycle.' },
    { slug: 'handbook',          label: 'Handbooks',         desc: 'Guided role handbooks: Year-1 induction tracks and first-90-day operational guides.' },
    { slug: 'orientation-admin', label: 'Orientation Admin', desc: 'Manage resources, competency questions, and incoming partner-school teacher registrations.' },
  ],
  dtp: [
    { slug: 'pd',                   label: 'PD Materials',         desc: 'Ready-to-present professional-development materials for PD days, visits, and online sessions.' },
    { slug: 'learning-path',        label: 'Learning Path',        desc: 'Specialist CPD course: 29 competencies across 6 domains, staged Awareness to Lead.' },
    { slug: 'competency-framework', label: 'Competency Framework', desc: 'Hybrid coaching and subject-deepening framework for HQ Subject Specialists.' },
    { slug: 'competency-admin',     label: 'Competency Admin',     desc: 'Review evidence, approve or reject competency claims, and issue certificates.' },
    { slug: 'certificates',         label: 'Certificate Tracking', desc: 'Search, filter, and audit every issued partner-school workshop certificate.' },
  ],
  // AFT — no dedicated page; generic reference surfaces.
  aft: [
    { slug: 'references',      label: 'References & Standards', desc: 'Searchable archive of every framework, standard, and regulation across the network.' },
    { slug: 'roles-positions', label: 'Roles & Positions',     desc: 'Network-wide HR catalogue mapping positions to role architecture and Cambridge/Indonesian anchors.' },
    { slug: 'handbook',        label: 'Handbooks',             desc: 'Guided role handbooks for induction tracks and operational guides.' },
  ],
  // ATC — no dedicated page; pd is the only strong fit.
  atc: [
    { slug: 'pd',               label: 'PD Materials',      desc: 'Facilitator session guides, decks, and workbooks for delivering training sessions.' },
    { slug: 'learning-path',    label: 'Learning Path',     desc: 'Structured CPD course learners progress through, Awareness to Lead.' },
    { slug: 'orientation-admin',label: 'Orientation Admin', desc: 'Manage training resources, competency questions, and teacher registrations.' },
  ],
};

// Eduversal Academic Standards (ES) madde anchors — for documentation
// grounding. Validate any id against
// docs/research/eduversal/academic-standards/manifest.json before adding;
// leave [] rather than inventing a phantom ref (Common Mistake #49).
// EASE + PD + appraisal live in ES Section 12 "Staff Lifecycle" / the
// assessment sections; left [] here until each is verified per-programme.
// Every id below was checked against manifest.json's maddeIndex on 2026-07-26
// and against the section body text — not inferred from the title alone.
// ES 6.14 "Benchmark and External Assessments" names EASE explicitly (its
// windows, its five report tiers, and the "NOT used for individual student
// grades" boundary), so it anchors all three EASE programmes.
export const PROGRAMME_ES_REFS = {
  // 6.14 names EASE; 6.3 assessment architecture; 6.11 data → instruction.
  ease_growth:        ['ES 6.14', 'ES 6.3', 'ES 6.11'],
  // 6.6 summative design + 6.7 internal moderation = network-uniform tests.
  ease_assessment:    ['ES 6.14', 'ES 6.6', 'ES 6.7', 'ES 6.4'],
  // 6.8 grading/reporting + 6.9 report cards = per-subject achievement.
  ease_academic:      ['ES 6.14', 'ES 6.8', 'ES 6.9', 'ES 6.11'],
  // Section 12 staff lifecycle: annual cycle + goals + performance concerns.
  appraisal_system:   ['ES 12.7', 'ES 12.8', 'ES 12.11', 'ES 6.17'],
  // 12.5 induction programme for new teachers + 12.9 coaching and mentoring.
  induction_programs: ['ES 12.5', 'ES 12.9', 'ES 12.4'],
  // 12.6 professional development opportunities + 12.8 growth plans.
  dtp:                ['ES 12.6', 'ES 12.8', 'ES 12.9'],
  // Pre-service pipeline = workforce planning + recruitment/selection.
  aft:                ['ES 12.2', 'ES 12.3'],
  // Centralised training delivery sits under PD opportunities.
  atc:                ['ES 12.6', 'ES 12.13'],
};

// Sibling programmes — surfaced as "Related programmes" chips so the eight
// modules read as one system rather than eight silos. Grouped by family:
// the three EASE assessment products, and the staff-development cluster.
export const PROGRAMME_SIBLINGS = {
  ease_growth:        ['ease_assessment', 'ease_academic'],
  ease_assessment:    ['ease_growth', 'ease_academic'],
  ease_academic:      ['ease_growth', 'ease_assessment'],
  appraisal_system:   ['induction_programs', 'dtp'],
  induction_programs: ['appraisal_system', 'dtp', 'aft'],
  dtp:                ['atc', 'induction_programs', 'appraisal_system'],
  aft:                ['atc', 'induction_programs'],
  atc:                ['dtp', 'aft'],
};

// One-line boundary note per programme — what this hub is NOT, so readers
// don't mistake e.g. Growth for an achievement grade. Rendered in the info
// strip. EASE Growth's line restates the ES 6.14 "not used for individual
// student grades" rule in plain language.
export const PROGRAMME_BOUNDARY = {
  ease_growth:        'Growth is diagnostic — it tracks progress over time and is never a report-card grade (ES 6.14).',
  ease_assessment:    'Common assessments are network-uniform; per-school variants defeat comparability (ES 6.7).',
  ease_academic:      'Achievement tracking reports mastery against the Cambridge curriculum, not growth trajectory.',
  appraisal_system:   'Appraisal is the formal performance record — Year-1 induction data never feeds it (Charter NN1).',
  induction_programs: 'Induction supports Year-1 staff; it is developmental and never feeds appraisal scoring (Charter NN1).',
  dtp:                'DTP is capacity-building, not evaluation — participation is not an appraisal input.',
  aft:                'AFT covers pre-service candidates who are not yet network staff.',
  atc:                'ATC is delivery infrastructure — the curriculum it delivers is owned by DTP.',
};

// The hub's own tools followed by the two shared HQ surfaces. De-duped by slug
// so a programme that lists one of them explicitly never renders it twice.
export function programmeLinks(programKey) {
  const own = PROGRAMME_LINKS[programKey] || [];
  const seen = new Set(own.map(l => l.slug));
  return own.concat(PROGRAMME_COMMON_LINKS.filter(l => !seen.has(l.slug)));
}

export function isValidProgramme(programKey) {
  return PROGRAMMES.includes(programKey);
}

export function programmeLabel(programKey) {
  return PROGRAMME_LABELS[programKey] || programKey;
}
