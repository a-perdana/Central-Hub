// Canonical CH subject taxonomy.
//
// Source of truth for the 9 ch_subjects[] enum values used across:
//   - /coordinators-directory  (school subject leader rows, HQ coordinator rows)
//   - /department-workspace    (per-subject command centre)
//   - any future page that filters by subject specialty
//
// Underscore form (edu_steam) is the Firestore enum value — keep it stable.
// Label + accent strings are display-only; safe to edit.

export const SUBJECTS = [
  'math',
  'biology',
  'chemistry',
  'physics',
  'science',
  'english',
  'bahasa',
  'religion',
  'edu_steam',
];

export const SUBJECT_LABELS = {
  math:      'Math',
  biology:   'Biology',
  chemistry: 'Chemistry',
  physics:   'Physics',
  science:   'Science',
  english:   'English',
  bahasa:    'Bahasa',
  religion:  'Religion',
  edu_steam: 'Edu-STEAM',
};

// Two-letter mono badge (matches department-artifacts.html .subject-icon convention).
export const SUBJECT_BADGE = {
  math:      'Ma',
  biology:   'Bi',
  chemistry: 'Ch',
  physics:   'Ph',
  science:   'Sc',
  english:   'En',
  bahasa:    'Ba',
  religion:  'Re',
  edu_steam: 'ES',
};

// Subject-themed emoji, used as the primary visual on /department-workspace
// picker cards + subject view header. Chosen to be platform-stable
// (no skin-tone modifiers, no flags except where culturally meaningful).
export const SUBJECT_EMOJI = {
  math:      '🧮',  // abacus
  biology:   '🧬',  // DNA
  chemistry: '⚗️',  // alembic
  physics:   '🔭',  // telescope
  science:   '🔬',  // microscope (combined science)
  english:   '📖',  // open book
  bahasa:    '📚',  // stack of books (Bahasa Indonesia)
  religion:  '🕌',  // mosque (Indonesian school context)
  edu_steam: '🚀',  // rocket (Edu-STEAM = science + tech + engineering + arts + math)
};

// Per-subject gradient. Reuses the same hues as department-artifacts.html
// so the two surfaces feel like one system.
export const SUBJECT_ACCENT = {
  math:      'linear-gradient(135deg,#3b82f6,#1d4ed8)',
  biology:   'linear-gradient(135deg,#10b981,#047857)',
  chemistry: 'linear-gradient(135deg,#f59e0b,#b45309)',
  physics:   'linear-gradient(135deg,#8b5cf6,#5b21b6)',
  science:   'linear-gradient(135deg,#06b6d4,#0e7490)',
  english:   'linear-gradient(135deg,#ec4899,#9d174d)',
  bahasa:    'linear-gradient(135deg,#f43f5e,#9f1239)',
  religion:  'linear-gradient(135deg,#6366f1,#3730a3)',
  edu_steam: 'linear-gradient(135deg,#7c3aed,#0891b2)',
};

// Per-subject Cambridge pacing pages — the live "annual plan" of what
// gets taught when, week by week. Auto-rendered as a link strip at the
// top of the Annual Plan section in /department-workspace and above
// each subject card on /department-artifacts.
//
// Each link carries:
//   - slug:   canonical URL slug (matches the .html basename minus .html)
//   - label:  display string (kept terse for the link strip)
//   - stage:  short marker for the stage chip ("Y1–6", "Y7–8", "Y9–10", "Y11–12")
//   - code:   official Cambridge syllabus code (e.g. "0580" for IGCSE Math).
//             Cited verbatim from curriculum-map.html SUBJECT_CONFIGS +
//             primary-checkpoint-syllabus.html — single source of truth
//             for the 4-digit syllabus codes used network-wide.
//
// Subjects with no Cambridge pacing pages (Bahasa / Religion / Edu-STEAM)
// have an empty array — the UI renders an empty-state pointing the
// coordinator at the Annual Strategy slot below.
export const SUBJECT_PACING_LINKS = {
  math: [
    { slug: 'primary-math-pacing',    label: 'Primary Math',      stage: 'Y1–6',   code: '0096' },
    { slug: 'checkpoint-math-pacing', label: 'Checkpoint Math',   stage: 'Y7–8',   code: '0862' },
    { slug: 'igcse-math-pacing',      label: 'IGCSE Math',        stage: 'Y9–10',  code: '0580' },
    { slug: 'as-alevel-math-pacing',  label: 'AS/A-Level Math',   stage: 'Y11–12', code: '9709' },
  ],
  biology: [
    { slug: 'primary-science-pacing',    label: 'Primary Science (general)', stage: 'Y1–6',   code: '0097' },
    { slug: 'igcse-biology-pacing',      label: 'IGCSE Biology',             stage: 'Y9–10',  code: '0610' },
    { slug: 'as-alevel-biology-pacing',  label: 'AS/A-Level Biology',        stage: 'Y11–12', code: '9700' },
  ],
  chemistry: [
    { slug: 'primary-science-pacing',     label: 'Primary Science (general)', stage: 'Y1–6',   code: '0097' },
    { slug: 'igcse-chemistry-pacing',     label: 'IGCSE Chemistry',           stage: 'Y9–10',  code: '0620' },
    { slug: 'as-alevel-chemistry-pacing', label: 'AS/A-Level Chemistry',      stage: 'Y11–12', code: '9701' },
  ],
  physics: [
    { slug: 'primary-science-pacing',   label: 'Primary Science (general)', stage: 'Y1–6',   code: '0097' },
    { slug: 'igcse-physics-pacing',     label: 'IGCSE Physics',             stage: 'Y9–10',  code: '0625' },
    { slug: 'as-alevel-physics-pacing', label: 'AS/A-Level Physics',        stage: 'Y11–12', code: '9702' },
  ],
  science: [
    { slug: 'primary-science-pacing',    label: 'Primary Science',    stage: 'Y1–6', code: '0097' },
    { slug: 'checkpoint-science-pacing', label: 'Checkpoint Science', stage: 'Y7–8', code: '0893' },
  ],
  english: [
    { slug: 'primary-english-pacing',    label: 'Primary English',    stage: 'Y1–6', code: '0844' },
    { slug: 'checkpoint-english-pacing', label: 'Checkpoint English', stage: 'Y7–8', code: '1111' },
  ],
  bahasa:    [],
  religion:  [],
  edu_steam: [],
};

export function isValidSubject(subjectId) {
  return SUBJECTS.includes(subjectId);
}

export function subjectLabel(subjectId) {
  return SUBJECT_LABELS[subjectId] || subjectId;
}
