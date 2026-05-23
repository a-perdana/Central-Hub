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

export function isValidSubject(subjectId) {
  return SUBJECTS.includes(subjectId);
}

export function subjectLabel(subjectId) {
  return SUBJECT_LABELS[subjectId] || subjectId;
}
