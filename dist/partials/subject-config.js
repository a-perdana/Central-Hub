// Canonical CH subject taxonomy.
//
// Source of truth for the 11 ch_subjects[] enum values used across:
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
  'early_years',
  'civics',
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
  early_years: 'Early Years',
  civics:    'Civics',
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
  early_years: 'EY',
  civics:    'Ci',
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
  early_years: '🧸',  // teddy bear (Early Years / EYFS foundation stage)
  civics:    '⚖️',  // balance scale (Civics / Pancasila & citizenship education)
};

// Per-subject SVG identity pattern, served as a data:image/svg+xml URL.
// Applied at low opacity inside the card head as a background-image —
// gives every department a subtle subject-themed texture without
// loud overdesign. Each pattern uses currentColor; the rendered hue
// is set via the .dw-pick-head's `color` (driven by --pick-pattern-color).
//
// IMPORTANT: The SVG body is encoded with encodeURIComponent before
// being baked into the data URI. The card threads --pick-pattern into
// an inline style="..." attribute. If literal '<' / '>' / '"' leaks
// into that attribute, the browser closes the style="" early and
// dumps the rest as text into the DOM. Past incident 2026-05-24:
// the unencoded version rendered '"); --pick-pattern-color:#1d4ed8">'
// as visible text inside every card. encodeURIComponent fully
// neutralises this — % escapes survive the inline style boundary +
// remain a valid data: URI when the browser fetches it.
//
// All patterns sized for `background-size: 60px 60px` repeat. Single-
// line SVG strings (data: URIs choke on raw newlines).
const SVG = (body) => {
  const raw = `<svg xmlns='http://www.w3.org/2000/svg' width='60' height='60' viewBox='0 0 60 60' fill='none' stroke='currentColor' stroke-width='1' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(raw)}")`;
};

export const SUBJECT_PATTERN = {
  // Math — graph paper grid (calculus / linear algebra notebook feel)
  math: SVG(`<path d='M0 15h60M0 30h60M0 45h60M15 0v60M30 0v60M45 0v60' stroke-opacity='0.5'/>`),
  // Biology — DNA double helix (sine waves out of phase)
  biology: SVG(`<path d='M5 10 Q15 20 25 10 T45 10 T65 10'/><path d='M5 30 Q15 20 25 30 T45 30 T65 30'/><path d='M5 50 Q15 40 25 50 T45 50 T65 50'/><line x1='10' y1='15' x2='10' y2='25'/><line x1='20' y1='15' x2='20' y2='25'/><line x1='30' y1='15' x2='30' y2='25'/><line x1='40' y1='15' x2='40' y2='25'/><line x1='50' y1='15' x2='50' y2='25'/>`),
  // Chemistry — benzene/hex tiling (organic chemistry vibe)
  chemistry: SVG(`<polygon points='15,5 25,5 30,15 25,25 15,25 10,15' stroke-width='1.2'/><polygon points='45,5 55,5 60,15 55,25 45,25 40,15' stroke-width='1.2'/><polygon points='30,30 40,30 45,40 40,50 30,50 25,40' stroke-width='1.2'/><polygon points='0,30 10,30 15,40 10,50 0,50 -5,40' stroke-width='1.2'/>`),
  // Physics — atomic orbits (3 ellipses rotated for nucleus halo)
  physics: SVG(`<ellipse cx='30' cy='30' rx='25' ry='8' transform='rotate(0 30 30)'/><ellipse cx='30' cy='30' rx='25' ry='8' transform='rotate(60 30 30)'/><ellipse cx='30' cy='30' rx='25' ry='8' transform='rotate(-60 30 30)'/><circle cx='30' cy='30' r='3' fill='currentColor' stroke='none'/>`),
  // Science (combined) — circuit board traces (microscope/lab-equipment shorthand)
  science: SVG(`<path d='M5 30h15v-15h10v15h15v10h10v-10h5'/><circle cx='20' cy='15' r='2'/><circle cx='45' cy='40' r='2'/><circle cx='30' cy='30' r='2' fill='currentColor' stroke='none'/>`),
  // English — typeset lines + caret (printed page / typography hint)
  english: SVG(`<path d='M10 12h40M10 22h35M10 32h40M10 42h28M10 52h40' stroke-opacity='0.55'/><path d='M48 38l4 4 -4 4' stroke-width='1.4'/>`),
  // Bahasa — Indonesian batik-inspired dot-and-loop motif
  bahasa: SVG(`<circle cx='15' cy='15' r='3'/><circle cx='45' cy='15' r='3'/><circle cx='30' cy='30' r='3'/><circle cx='15' cy='45' r='3'/><circle cx='45' cy='45' r='3'/><path d='M15 15 Q22 8 30 15 T45 15' stroke-opacity='0.5'/><path d='M15 45 Q22 38 30 45 T45 45' stroke-opacity='0.5'/>`),
  // Religion — 8-pointed star (Islamic geometric pattern, common in Indonesian school context)
  religion: SVG(`<g transform='translate(30 30)'><polygon points='0,-18 5,-5 18,0 5,5 0,18 -5,5 -18,0 -5,-5' transform='rotate(0)'/><polygon points='0,-18 5,-5 18,0 5,5 0,18 -5,5 -18,0 -5,-5' transform='rotate(22.5)' stroke-opacity='0.5'/></g>`),
  // Edu-STEAM — interconnected dots (network / integration of disciplines)
  edu_steam: SVG(`<circle cx='10' cy='10' r='2' fill='currentColor' stroke='none'/><circle cx='50' cy='10' r='2' fill='currentColor' stroke='none'/><circle cx='30' cy='30' r='2' fill='currentColor' stroke='none'/><circle cx='10' cy='50' r='2' fill='currentColor' stroke='none'/><circle cx='50' cy='50' r='2' fill='currentColor' stroke='none'/><path d='M10 10 L30 30 L50 10 M10 50 L30 30 L50 50 M10 10 L10 50 M50 10 L50 50' stroke-opacity='0.35'/>`),
  // Early Years — building blocks + play shapes (foundation-stage feel)
  early_years: SVG(`<rect x='8' y='32' width='16' height='16' rx='2'/><rect x='26' y='32' width='16' height='16' rx='2'/><rect x='17' y='14' width='16' height='16' rx='2'/><circle cx='48' cy='20' r='7'/><polygon points='48,38 56,52 40,52'/>`),
  // Civics — balance scales (justice / citizenship / Pancasila values)
  civics: SVG(`<line x1='30' y1='8' x2='30' y2='44'/><line x1='14' y1='18' x2='46' y2='18'/><path d='M14 18 L8 32 M14 18 L20 32'/><path d='M8 32 a6 4 0 0 0 12 0'/><path d='M46 18 L40 32 M46 18 L52 32'/><path d='M40 32 a6 4 0 0 0 12 0'/><rect x='22' y='44' width='16' height='4' rx='1'/>`),
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
  early_years: 'linear-gradient(135deg,#fb923c,#c2410c)',
  civics:    'linear-gradient(135deg,#0ea5e9,#0369a1)',
};

// Single tint colour per subject, used by the pattern SVG via
// currentColor inheritance. Picks the DEEPER stop of each gradient
// so the pattern reads on a white card head without washing out.
export const SUBJECT_PATTERN_COLOR = {
  math:      '#1d4ed8',
  biology:   '#047857',
  chemistry: '#b45309',
  physics:   '#5b21b6',
  science:   '#0e7490',
  english:   '#9d174d',
  bahasa:    '#9f1239',
  religion:  '#3730a3',
  edu_steam: '#5b21b6',
  early_years: '#c2410c',
  civics:    '#0369a1',
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
// Bahasa Indonesia + Edu-STEAM are Eduversal-authored (non-Cambridge)
// subjects that now carry the full 4-stage pacing surface, mirroring the
// Cambridge subjects' structure. Their `code` is an EDV-prefix placeholder
// (no Cambridge syllabus code) — replace once HQ authors a real scheme.
//
// Subjects with no pacing pages (Religion / Early Years / Civics) keep an
// empty array — the UI renders an empty-state pointing the coordinator at
// the Annual Strategy slot below.
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
  bahasa: [
    { slug: 'primary-bahasa-pacing',    label: 'Primary Bahasa',    stage: 'Y1–6',   code: 'EDV-BAH-P' },
    { slug: 'checkpoint-bahasa-pacing', label: 'Checkpoint Bahasa', stage: 'Y7–8',   code: 'EDV-BAH-C' },
    { slug: 'igcse-bahasa-pacing',      label: 'Secondary Bahasa',  stage: 'Y9–10',  code: 'EDV-BAH-S' },
    { slug: 'as-alevel-bahasa-pacing',  label: 'AS/A-Level Bahasa', stage: 'Y11–12', code: 'EDV-BAH-A' },
  ],
  edu_steam: [
    { slug: 'primary-edu-steam-pacing',    label: 'Primary Edu-STEAM',    stage: 'Y1–6',   code: 'EDV-STM-P' },
    { slug: 'checkpoint-edu-steam-pacing', label: 'Checkpoint Edu-STEAM', stage: 'Y7–8',   code: 'EDV-STM-C' },
    { slug: 'igcse-edu-steam-pacing',      label: 'Secondary Edu-STEAM',  stage: 'Y9–10',  code: 'EDV-STM-S' },
    { slug: 'as-alevel-edu-steam-pacing',  label: 'AS/A-Level Edu-STEAM', stage: 'Y11–12', code: 'EDV-STM-A' },
  ],
  religion:    [],
  early_years: [],
  civics:      [],
};

export function isValidSubject(subjectId) {
  return SUBJECTS.includes(subjectId);
}

export function subjectLabel(subjectId) {
  return SUBJECT_LABELS[subjectId] || subjectId;
}
