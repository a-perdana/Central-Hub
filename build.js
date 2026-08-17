const fs   = require("fs");
const path = require("path");

function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.readdirSync(srcDir, { withFileTypes: true }).forEach((entry) => {
    const srcPath  = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  });
}

// -- A11Y injection helper (WCAG 2.2 AA, 2026-05-31) -----------------------
//    Shared by all 3 hubs (keep CH / AH / TH copies in sync — same manual-
//    sync discipline as the a11y.css block). Adds:
//      1. <a class="skip-link" href="#main-content"> right after <body ...>
//         (2.4.1 Bypass Blocks) — first focusable element on the page.
//      2. id="main-content" role="main" tabindex="-1" ATTRIBUTES on the first
//         content wrapper (1.3.1). Attributes only — never a new <main> element
//         (would break `body:has(> .page-footer)` — Common Mistake #54).
//    Idempotent (skips if a skip-link / #main-content already present).
//    Skips auth-flow pages (login) where there is no main content to skip to.
const A11Y_SKIP_FILES = new Set(["login.html"]);
// First-content-wrapper candidates, in priority order. The first match in the
// document that does NOT already carry an id gets the landmark attributes.
const A11Y_WRAPPER_PATTERNS = [
  /<header class="page-hero"(?![^>]*\bid=)/,
  /<main\b(?![^>]*\bid=)/,
  /<section class="page-info-strip"(?![^>]*\bid=)/,
  /<div class="page-wrap"(?![^>]*\bid=)/,
  /<div class="main-content"(?![^>]*\bid=)/,
  /<div class="page-layout"(?![^>]*\bid=)/,
  /<div id="mainContent"/,            // AH
  /<div id="navbar-container"><\/div>/ // TH bespoke (fallback handled below)
];
function injectA11y(html, fileBase) {
  if (A11Y_SKIP_FILES.has(fileBase)) return html;
  // Idempotency — already processed.
  if (/class="skip-link"/.test(html)) return html;

  const SKIP = '<a class="skip-link" href="#main-content">Skip to main content</a>\n';
  const LANDMARK = ' id="main-content" role="main" tabindex="-1"';

  // 1) Skip-link right after the opening <body ...> tag.
  let out = html.replace(/(<body\b[^>]*>)/, `$1\n${SKIP}`);

  // 2) Landmark attributes on the first matching content wrapper.
  //    Search/replace ONLY in the post-<body> region so example markup inside
  //    <head> comments or <style> blocks (e.g. a "canonical <header class=
  //    'page-hero'>" doc comment) can't be mistaken for the real wrapper.
  //    Past incident: roles-positions + 6 others had the landmark injected into
  //    a style-block comment, leaving the real <header> landmark-less and the
  //    skip-link target (#main-content) dangling.
  const bodyIdx = out.search(/<body\b[^>]*>/);
  const splitAt = bodyIdx === -1 ? 0 : bodyIdx;
  let headPart = out.slice(0, splitAt);
  let bodyPart = out.slice(splitAt);
  let landmarkPlaced = false;
  for (const pat of A11Y_WRAPPER_PATTERNS) {
    const m = bodyPart.match(pat);
    if (!m) continue;
    // Skip the TH-only navbar-container sentinel here — handled by fallback.
    if (pat.source.includes("navbar-container")) break;
    const tag = m[0];
    const existingId = tag.match(/\bid="([^"]+)"/);
    if (existingId) {
      // Wrapper already carries an id (e.g. AH's <div id="mainContent">).
      // Don't add a second id="main-content" — that produces a duplicate-id
      // element (the browser keeps only the first, getElementById on the page's
      // own id returns null → crash). Instead reuse the existing id as the
      // landmark target: add only role/tabindex and point the skip-link there.
      bodyPart = bodyPart.replace(tag, tag + ' role="main" tabindex="-1"');
      out = headPart + bodyPart;
      out = out.replace('href="#main-content"', `href="#${existingId[1]}"`);
      headPart = out.slice(0, splitAt);
      bodyPart = out.slice(splitAt);
    } else {
      // Inject the full landmark just after the matched tag-name token.
      bodyPart = bodyPart.replace(tag, tag + LANDMARK);
    }
    landmarkPlaced = true;
    break;
  }
  out = headPart + bodyPart;
  // 3) Fallback for bespoke pages with no known wrapper: drop a bare focus
  //    target right after the skip-link so the skip-link still lands.
  if (!landmarkPlaced) {
    out = out.replace(
      SKIP,
      SKIP + '<span id="main-content" tabindex="-1"></span>\n'
    );
  }
  return out;
}

// -- Create dist
if (!fs.existsSync("dist")) fs.mkdirSync("dist");

const sharedNavbarPath = path.join("partials", "navbar.html");
const sharedNavbar = fs.existsSync(sharedNavbarPath)
  ? fs.readFileSync(sharedNavbarPath, "utf8")
  : "";

const syllabusModalsPath = path.join("partials", "syllabus-modals.html");
const syllabusModals = fs.existsSync(syllabusModalsPath)
  ? fs.readFileSync(syllabusModalsPath, "utf8")
  : "";

const syllabusToolbarBtnPath = path.join("partials", "syllabus-toolbar-button.html");
const syllabusToolbarBtn = fs.existsSync(syllabusToolbarBtnPath)
  ? fs.readFileSync(syllabusToolbarBtnPath, "utf8")
  : "";

const notesWidgetPath = path.join("partials", "notes-widget.html");
const notesWidget = fs.existsSync(notesWidgetPath)
  ? fs.readFileSync(notesWidgetPath, "utf8")
  : "";

// -- Generate firebase-config.js from Vercel env vars
const cfg = {
  FIREBASE_API_KEY:            process.env.FIREBASE_API_KEY            || "",
  FIREBASE_AUTH_DOMAIN:        process.env.FIREBASE_AUTH_DOMAIN        || "",
  FIREBASE_PROJECT_ID:         process.env.FIREBASE_PROJECT_ID         || "",
  FIREBASE_STORAGE_BUCKET:     process.env.FIREBASE_STORAGE_BUCKET     || "",
  FIREBASE_MESSAGING_SENDER_ID:process.env.FIREBASE_MESSAGING_SENDER_ID|| "",
  FIREBASE_APP_ID:             process.env.FIREBASE_APP_ID             || "",
  MAIL_SERVICE_URL:            process.env.MAIL_SERVICE_URL            || "",
  // MAIL_SERVICE_SECRET intentionally NOT emitted (2026-08-01 hardening):
  // shipping the Resend bearer to the browser let anyone lift it from
  // View Source. All sends now go through the mailRelay Cloud Function.
};

const firebaseConfigContent = `// Auto-generated by build.js - do not edit
window.ENV = {
  FIREBASE_API_KEY:            "${cfg.FIREBASE_API_KEY}",
  FIREBASE_AUTH_DOMAIN:        "${cfg.FIREBASE_AUTH_DOMAIN}",
  FIREBASE_PROJECT_ID:         "${cfg.FIREBASE_PROJECT_ID}",
  FIREBASE_STORAGE_BUCKET:     "${cfg.FIREBASE_STORAGE_BUCKET}",
  FIREBASE_MESSAGING_SENDER_ID:"${cfg.FIREBASE_MESSAGING_SENDER_ID}",
  FIREBASE_APP_ID:             "${cfg.FIREBASE_APP_ID}",
  MAIL_SERVICE_URL:            "${cfg.MAIL_SERVICE_URL}",
};
`;

fs.writeFileSync(path.join("dist", "firebase-config.js"), firebaseConfigContent);
console.log("Generated: dist/firebase-config.js");

// ============================================================
// IGCSE pacing pages — generated from igcse-pacing-template.html
// ============================================================
const AO_MATH = `<option value="AO1">AO1 — Knowledge &amp; techniques</option>
          <option value="AO2">AO2 — Analyse &amp; interpret</option>
          <option value="AO1+AO2">AO1 + AO2 — Both</option>`;
const AO_SCIENCE = `<option value="AO1">AO1 — Knowledge &amp; understanding</option>
          <option value="AO2">AO2 — Handle information &amp; solve problems</option>
          <option value="AO3">AO3 — Experimental skills &amp; investigations</option>
          <option value="AO1+AO2">AO1 + AO2 — Both</option>`;

const IGCSE_SUBJECTS = {
  'igcse-math-pacing.html': {
    pageTitle:    'IGCSE Mathematics Pacing — CentralHub',
    accentVars:   '--accent: #c0392b;\n      --accent-dk: #a93224;\n      --accent-2: #fdf0ef;\n      --red-50: #fff5f5;\n      --red-100: #fee2e2;\n      --red-600: #dc2626;\n      --red-700: #b91c1c;\n      --red-800: #991b1b;\n      --red-900: #7f1d1d;',
    heroGradient: 'linear-gradient(135deg, #450a0a 0%, #7f1d1d 40%, #991b1b 70%, #b91c1c 100%)',
    heroGlow:     'rgba(185,28,28,.4)',
    heroIcon:     '∫',
    heroEyebrow:  'IGCSE Mathematics 0580',
    heroTitle:    'IGCSE Mathematics Pacing',
    heroDesc:     'Manage chapters, topics, and syllabus codes for Years 9–10. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_MATH,
    pacingConfig: `{ collection: 'math_pacing', docId: 'year9-10', subjectKey: 'math', comboKey: 'igcse_math', syllabusCode: '0580', progressKey: 'statuses', classesField: 'igcse_math_classes', yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10' }`,
    yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10',
  },
  'igcse-biology-pacing.html': {
    pageTitle:    'IGCSE Biology Pacing — CentralHub',
    accentVars:   '--accent: #1e7a4a;\n      --accent-dk: #166534;\n      --accent-2: #e9f7ef;',
    heroGradient: 'linear-gradient(135deg, #052e16 0%, #14532d 40%, #166534 70%, #15803d 100%)',
    heroGlow:     'rgba(21,128,61,.4)',
    heroIcon:     '🧬',
    heroEyebrow:  'IGCSE Biology 0610',
    heroTitle:    'IGCSE Biology Pacing',
    heroDesc:     'Manage chapters, topics, and syllabus codes for Years 9–10. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'biology_pacing', docId: 'year9-10', subjectKey: 'biology', comboKey: 'igcse_biology', syllabusCode: '0610', progressKey: 'statuses', classesField: 'igcse_biology_classes', yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10' }`,
    yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10',
  },
  'igcse-chemistry-pacing.html': {
    pageTitle:    'IGCSE Chemistry Pacing — CentralHub',
    accentVars:   '--accent: #7c3aed;\n      --accent-dk: #6d28d9;\n      --accent-2: #f5f3ff;',
    heroGradient: 'linear-gradient(135deg, #2e1065 0%, #4c1d95 40%, #5b21b6 70%, #6d28d9 100%)',
    heroGlow:     'rgba(109,40,217,.4)',
    heroIcon:     '⚗',
    heroEyebrow:  'IGCSE Chemistry 0620',
    heroTitle:    'IGCSE Chemistry Pacing',
    heroDesc:     'Manage chapters, topics, and syllabus codes for Years 9–10. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'chemistry_pacing', docId: 'year9-10', subjectKey: 'chemistry', comboKey: 'igcse_chemistry', syllabusCode: '0620', progressKey: 'statuses', classesField: 'igcse_chemistry_classes', yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10' }`,
    yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10',
  },
  'igcse-physics-pacing.html': {
    pageTitle:    'IGCSE Physics Pacing — CentralHub',
    accentVars:   '--accent: #0369a1;\n      --accent-dk: #075985;\n      --accent-2: #f0f9ff;',
    heroGradient: 'linear-gradient(135deg, #0c4a6e 0%, #075985 40%, #0369a1 70%, #0284c7 100%)',
    heroGlow:     'rgba(2,132,199,.4)',
    heroIcon:     '⚛',
    heroEyebrow:  'IGCSE Physics 0625',
    heroTitle:    'IGCSE Physics Pacing',
    heroDesc:     'Manage chapters, topics, and syllabus codes for Years 9–10. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'physics_pacing', docId: 'year9-10', subjectKey: 'physics', comboKey: 'igcse_physics', syllabusCode: '0625', progressKey: 'statuses', classesField: 'igcse_physics_classes', yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10' }`,
    yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10',
  },
  // ── Eduversal-authored non-Cambridge subjects (Secondary Y9-10 tier) ──
  // Bahasa Indonesia + Edu-STEAM have no Cambridge syllabus code; they
  // carry an EDV-prefix placeholder until Eduversal authors a real
  // scheme. Structure mirrors the IGCSE Cambridge pages exactly so the
  // pacing-core.js engine + Teachers Hub coverage views work unchanged.
  // The IGCSE-tier collection uses the bare `<subject>_pacing` name to
  // align with subject-config.js SUBJECT_PACING_LINKS (igcse-* slug).
  'igcse-bahasa-pacing.html': {
    pageTitle:    'Bahasa Indonesia Pacing (Y9–10) — CentralHub',
    accentVars:   '--accent: #e11d48;\n      --accent-dk: #9f1239;\n      --accent-2: #fff1f3;',
    heroGradient: 'linear-gradient(135deg, #4c0519 0%, #881337 40%, #9f1239 70%, #be123c 100%)',
    heroGlow:     'rgba(225,29,72,.4)',
    heroIcon:     '📚',
    heroEyebrow:  'Bahasa Indonesia · EDV-BAH-S',
    heroTitle:    'Bahasa Indonesia Pacing (Y9–10)',
    heroDesc:     'Manage chapters, topics, and learning objectives for Years 9–10. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_MATH,
    pacingConfig: `{ collection: 'bahasa_pacing', docId: 'year9-10', subjectKey: 'bahasa', comboKey: 'igcse_bahasa', syllabusCode: 'EDV-BAH-S', progressKey: 'statuses', classesField: 'igcse_bahasa_classes', yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10' }`,
    yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10',
  },
  'igcse-edu-steam-pacing.html': {
    pageTitle:    'Edu-STEAM Pacing (Y9–10) — CentralHub',
    accentVars:   '--accent: #7c3aed;\n      --accent-dk: #5b21b6;\n      --accent-2: #f5f3ff;',
    heroGradient: 'linear-gradient(135deg, #2e1065 0%, #4c1d95 35%, #5b21b6 65%, #0891b2 100%)',
    heroGlow:     'rgba(124,58,237,.4)',
    heroIcon:     '🚀',
    heroEyebrow:  'Edu-STEAM · EDV-STM-S',
    heroTitle:    'Edu-STEAM Pacing (Y9–10)',
    heroDesc:     'Manage projects, topics, and learning objectives for Years 9–10. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'edu_steam_pacing', docId: 'year9-10', subjectKey: 'edu_steam', comboKey: 'igcse_edu_steam', syllabusCode: 'EDV-STM-S', progressKey: 'statuses', classesField: 'igcse_edu_steam_classes', yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10' }`,
    yearA: 'Year 9', yearB: 'Year 10', yearAKey: 'year9', yearBKey: 'year10',
  },
};

// ============================================================
// Checkpoint pacing pages — generated from igcse-pacing-template.html
// ============================================================
const CHECKPOINT_SUBJECTS = {
  'checkpoint-math-pacing.html': {
    pageTitle:    'Checkpoint Mathematics Pacing — CentralHub',
    accentVars:   '--accent: #c0392b;\n      --accent-dk: #a93224;\n      --accent-2: #fdf0ef;',
    heroGradient: 'linear-gradient(135deg, #450a0a 0%, #7f1d1d 40%, #991b1b 70%, #b91c1c 100%)',
    heroGlow:     'rgba(185,28,28,.4)',
    heroIcon:     '∫',
    heroEyebrow:  'Cambridge Checkpoint Mathematics 0862',
    heroTitle:    'Checkpoint Mathematics Pacing',
    heroDesc:     'Manage chapters, topics, and learning objectives for Years 7–8. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_MATH,
    pacingConfig: `{ collection: 'checkpoint_math_pacing', docId: 'year7-8', subjectKey: 'math', comboKey: 'checkpoint_math', syllabusCode: '0862', progressKey: 'checkpoint_math_statuses', classesField: 'checkpoint_math_classes', progressionGrid: true, yearA: 'Year 7', yearB: 'Year 8', yearAKey: 'year7', yearBKey: 'year8' }`,
    yearA: 'Year 7', yearB: 'Year 8', yearAKey: 'year7', yearBKey: 'year8',
  },
  'checkpoint-english-pacing.html': {
    pageTitle:    'Checkpoint English Pacing — CentralHub',
    accentVars:   '--accent: #2980b9;\n      --accent-dk: #1f6fa3;\n      --accent-2: #e8f4fd;',
    heroGradient: 'linear-gradient(135deg, #0c2340 0%, #1a4a7a 40%, #1f6fa3 70%, #2980b9 100%)',
    heroGlow:     'rgba(41,128,185,.4)',
    heroIcon:     '📖',
    heroEyebrow:  'Cambridge Checkpoint English 1111',
    heroTitle:    'Checkpoint English Pacing',
    heroDesc:     'Manage chapters, topics, and learning objectives for Years 7–8. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_MATH,
    pacingConfig: `{ collection: 'checkpoint_english_pacing', docId: 'year7-8', subjectKey: 'english', comboKey: 'checkpoint_english', syllabusCode: '1111', progressKey: 'checkpoint_english_statuses', classesField: 'checkpoint_english_classes', progressionGrid: true, yearA: 'Year 7', yearB: 'Year 8', yearAKey: 'year7', yearBKey: 'year8' }`,
    yearA: 'Year 7', yearB: 'Year 8', yearAKey: 'year7', yearBKey: 'year8',
  },
  'checkpoint-science-pacing.html': {
    pageTitle:    'Checkpoint Science Pacing — CentralHub',
    accentVars:   '--accent: #27ae60;\n      --accent-dk: #1e8449;\n      --accent-2: #e9f7ef;',
    heroGradient: 'linear-gradient(135deg, #052e16 0%, #14532d 40%, #166534 70%, #15803d 100%)',
    heroGlow:     'rgba(21,128,61,.4)',
    heroIcon:     '🔬',
    heroEyebrow:  'Cambridge Checkpoint Science 0893',
    heroTitle:    'Checkpoint Science Pacing',
    heroDesc:     'Manage chapters, topics, and learning objectives for Years 7–8. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'checkpoint_science_pacing', docId: 'year7-8', subjectKey: 'science', comboKeys: ['checkpoint_science', 'checkpoint_biology', 'checkpoint_chemistry', 'checkpoint_physics'], syllabusCode: '0893', progressKey: 'checkpoint_science_statuses', classesField: 'checkpoint_science_classes', progressionGrid: true, yearA: 'Year 7', yearB: 'Year 8', yearAKey: 'year7', yearBKey: 'year8' }`,
    yearA: 'Year 7', yearB: 'Year 8', yearAKey: 'year7', yearBKey: 'year8',
  },
  // ── Eduversal-authored non-Cambridge subjects (Checkpoint Y7-8 tier) ──
  'checkpoint-bahasa-pacing.html': {
    pageTitle:    'Bahasa Indonesia Pacing (Y7–8) — CentralHub',
    accentVars:   '--accent: #e11d48;\n      --accent-dk: #9f1239;\n      --accent-2: #fff1f3;',
    heroGradient: 'linear-gradient(135deg, #4c0519 0%, #881337 40%, #9f1239 70%, #be123c 100%)',
    heroGlow:     'rgba(225,29,72,.4)',
    heroIcon:     '📚',
    heroEyebrow:  'Bahasa Indonesia · EDV-BAH-C',
    heroTitle:    'Bahasa Indonesia Pacing (Y7–8)',
    heroDesc:     'Manage chapters, topics, and learning objectives for Years 7–8. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_MATH,
    pacingConfig: `{ collection: 'checkpoint_bahasa_pacing', docId: 'year7-8', subjectKey: 'bahasa', comboKey: 'checkpoint_bahasa', syllabusCode: 'EDV-BAH-C', progressKey: 'checkpoint_bahasa_statuses', classesField: 'checkpoint_bahasa_classes', yearA: 'Year 7', yearB: 'Year 8', yearAKey: 'year7', yearBKey: 'year8' }`,
    yearA: 'Year 7', yearB: 'Year 8', yearAKey: 'year7', yearBKey: 'year8',
  },
  'checkpoint-edu-steam-pacing.html': {
    pageTitle:    'Edu-STEAM Pacing (Y7–8) — CentralHub',
    accentVars:   '--accent: #7c3aed;\n      --accent-dk: #5b21b6;\n      --accent-2: #f5f3ff;',
    heroGradient: 'linear-gradient(135deg, #2e1065 0%, #4c1d95 35%, #5b21b6 65%, #0891b2 100%)',
    heroGlow:     'rgba(124,58,237,.4)',
    heroIcon:     '🚀',
    heroEyebrow:  'Edu-STEAM · EDV-STM-C',
    heroTitle:    'Edu-STEAM Pacing (Y7–8)',
    heroDesc:     'Manage projects, topics, and learning objectives for Years 7–8. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'checkpoint_edu_steam_pacing', docId: 'year7-8', subjectKey: 'edu_steam', comboKey: 'checkpoint_edu_steam', syllabusCode: 'EDV-STM-C', progressKey: 'checkpoint_edu_steam_statuses', classesField: 'checkpoint_edu_steam_classes', yearA: 'Year 7', yearB: 'Year 8', yearAKey: 'year7', yearBKey: 'year8' }`,
    yearA: 'Year 7', yearB: 'Year 8', yearAKey: 'year7', yearBKey: 'year8',
  },
};

// ============================================================
// Primary pacing pages — generated from primary-pacing-template.html
// All 6 stages live in one Firestore doc (year1-6); the page renders
// a 6-chip year filter + 6-option chapter modal dropdown rather than
// the 2-year secondary/IGCSE/AS-A pattern. PACING_CONFIG.years[] drives
// pacing-core.js's filter/badge/modal-default behaviour.
// ============================================================
const PRIMARY_YEARS = [
  { label: 'Year 1', key: 'year1', badgeCls: 'yr1' },
  { label: 'Year 2', key: 'year2', badgeCls: 'yr2' },
  { label: 'Year 3', key: 'year3', badgeCls: 'yr3' },
  { label: 'Year 4', key: 'year4', badgeCls: 'yr4' },
  { label: 'Year 5', key: 'year5', badgeCls: 'yr5' },
  { label: 'Year 6', key: 'year6', badgeCls: 'yr6' },
];
const PRIMARY_YEARS_JSON = JSON.stringify(PRIMARY_YEARS);
const PRIMARY_YEAR_CHIPS = PRIMARY_YEARS.map(
  y => `        <button class="class-chip" data-cls="${y.key}" onclick="selectClass('${y.key}',this)">${y.label}</button>`
).join('\n');
const PRIMARY_YEAR_OPTIONS = PRIMARY_YEARS.map(
  y => `          <option value="${y.label}">${y.label}</option>`
).join('\n');

const PRIMARY_SUBJECTS = {
  'primary-math-pacing.html': {
    pageTitle:    'Primary Mathematics Pacing — CentralHub',
    accentVars:   '--accent: #c0392b;\n      --accent-dk: #a93224;\n      --accent-2: #fdf0ef;',
    heroGradient: 'linear-gradient(135deg, #450a0a 0%, #7f1d1d 40%, #991b1b 70%, #b91c1c 100%)',
    heroGlow:     'rgba(185,28,28,.4)',
    heroIcon:     '∫',
    heroEyebrow:  'Cambridge Primary Mathematics 0096',
    heroTitle:    'Primary Mathematics Pacing',
    heroDesc:     'Manage chapters, topics, and learning objectives for Stage 1–6 (Year 1–6). Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_MATH,
    pacingConfig: `{ collection: 'primary_math_pacing', docId: 'year1-6', subjectKey: 'math', comboKey: 'primary_math', syllabusCode: '0096', progressKey: 'primary_math_statuses', classesField: 'primary_math_classes', years: ${PRIMARY_YEARS_JSON} }`,
  },
  'primary-english-pacing.html': {
    pageTitle:    'Primary English Pacing — CentralHub',
    accentVars:   '--accent: #2980b9;\n      --accent-dk: #1f6fa3;\n      --accent-2: #e8f4fd;',
    heroGradient: 'linear-gradient(135deg, #0c2340 0%, #1a4a7a 40%, #1f6fa3 70%, #2980b9 100%)',
    heroGlow:     'rgba(41,128,185,.4)',
    heroIcon:     '📖',
    heroEyebrow:  'Cambridge Primary English 0058',
    heroTitle:    'Primary English Pacing',
    heroDesc:     'Manage chapters, topics, and learning objectives for Stage 1–6 (Year 1–6). Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_MATH,
    pacingConfig: `{ collection: 'primary_english_pacing', docId: 'year1-6', subjectKey: 'english', comboKey: 'primary_english', syllabusCode: '0058', progressKey: 'primary_english_statuses', classesField: 'primary_english_classes', years: ${PRIMARY_YEARS_JSON} }`,
  },
  'primary-science-pacing.html': {
    pageTitle:    'Primary Science Pacing — CentralHub',
    accentVars:   '--accent: #27ae60;\n      --accent-dk: #1e8449;\n      --accent-2: #e9f7ef;',
    heroGradient: 'linear-gradient(135deg, #052e16 0%, #14532d 40%, #166534 70%, #15803d 100%)',
    heroGlow:     'rgba(21,128,61,.4)',
    heroIcon:     '🔬',
    heroEyebrow:  'Cambridge Primary Science 0097',
    heroTitle:    'Primary Science Pacing',
    heroDesc:     'Manage chapters, topics, and learning objectives for Stage 1–6 (Year 1–6). Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'primary_science_pacing', docId: 'year1-6', subjectKey: 'science', comboKeys: ['primary_science', 'primary_biology', 'primary_chemistry', 'primary_physics'], syllabusCode: '0097', progressKey: 'primary_science_statuses', classesField: 'primary_science_classes', years: ${PRIMARY_YEARS_JSON} }`,
  },
  // ── Eduversal-authored non-Cambridge subjects (Primary Y1-6 tier) ──
  'primary-bahasa-pacing.html': {
    pageTitle:    'Primary Bahasa Indonesia Pacing — CentralHub',
    accentVars:   '--accent: #e11d48;\n      --accent-dk: #9f1239;\n      --accent-2: #fff1f3;',
    heroGradient: 'linear-gradient(135deg, #4c0519 0%, #881337 40%, #9f1239 70%, #be123c 100%)',
    heroGlow:     'rgba(225,29,72,.4)',
    heroIcon:     '📚',
    heroEyebrow:  'Primary Bahasa Indonesia · EDV-BAH-P',
    heroTitle:    'Primary Bahasa Indonesia Pacing',
    heroDesc:     'Manage chapters, topics, and learning objectives for Stage 1–6 (Year 1–6). Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_MATH,
    pacingConfig: `{ collection: 'primary_bahasa_pacing', docId: 'year1-6', subjectKey: 'bahasa', comboKey: 'primary_bahasa', syllabusCode: 'EDV-BAH-P', progressKey: 'primary_bahasa_statuses', classesField: 'primary_bahasa_classes', years: ${PRIMARY_YEARS_JSON} }`,
  },
  'primary-edu-steam-pacing.html': {
    pageTitle:    'Primary Edu-STEAM Pacing — CentralHub',
    accentVars:   '--accent: #7c3aed;\n      --accent-dk: #5b21b6;\n      --accent-2: #f5f3ff;',
    heroGradient: 'linear-gradient(135deg, #2e1065 0%, #4c1d95 35%, #5b21b6 65%, #0891b2 100%)',
    heroGlow:     'rgba(124,58,237,.4)',
    heroIcon:     '🚀',
    heroEyebrow:  'Primary Edu-STEAM · EDV-STM-P',
    heroTitle:    'Primary Edu-STEAM Pacing',
    heroDesc:     'Manage projects, topics, and learning objectives for Stage 1–6 (Year 1–6). Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'primary_edu_steam_pacing', docId: 'year1-6', subjectKey: 'edu_steam', comboKey: 'primary_edu_steam', syllabusCode: 'EDV-STM-P', progressKey: 'primary_edu_steam_statuses', classesField: 'primary_edu_steam_classes', years: ${PRIMARY_YEARS_JSON} }`,
  },
};

// ============================================================
// AS/A-Level pacing pages — generated from igcse-pacing-template.html
// ============================================================
const ASALEVEL_SUBJECTS = {
  'as-alevel-math-pacing.html': {
    pageTitle:    'AS & A Level Mathematics Pacing — CentralHub',
    accentVars:   '--accent: #c0392b;\n      --accent-dk: #a93224;\n      --accent-2: #fdf0ef;',
    heroGradient: 'linear-gradient(135deg, #450a0a 0%, #7f1d1d 40%, #991b1b 70%, #b91c1c 100%)',
    heroGlow:     'rgba(185,28,28,.4)',
    heroIcon:     '∫',
    heroEyebrow:  'Cambridge AS & A Level Mathematics 9709',
    heroTitle:    'AS & A Level Mathematics Pacing',
    heroDesc:     'Manage chapters, topics, and syllabus codes for Years 11–12. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_MATH,
    pacingConfig: `{ collection: 'asalevel_math_pacing', docId: 'year11-12', subjectKey: 'math', comboKey: 'asalevel_math', progressKey: 'asmath_statuses', classesField: 'asalevel_math_classes', yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12' }`,
    yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12',
  },
  'as-alevel-biology-pacing.html': {
    pageTitle:    'AS & A Level Biology Pacing — CentralHub',
    accentVars:   '--accent: #1e7a4a;\n      --accent-dk: #166534;\n      --accent-2: #e9f7ef;',
    heroGradient: 'linear-gradient(135deg, #052e16 0%, #14532d 40%, #166534 70%, #15803d 100%)',
    heroGlow:     'rgba(21,128,61,.4)',
    heroIcon:     '🧬',
    heroEyebrow:  'Cambridge AS & A Level Biology 9700',
    heroTitle:    'AS & A Level Biology Pacing',
    heroDesc:     'Manage chapters, topics, and syllabus codes for Years 11–12. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'asalevel_biology_pacing', docId: 'year11-12', subjectKey: 'biology', comboKey: 'asalevel_biology', progressKey: 'asbio_statuses', classesField: 'asalevel_biology_classes', yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12' }`,
    yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12',
  },
  'as-alevel-chemistry-pacing.html': {
    pageTitle:    'AS & A Level Chemistry Pacing — CentralHub',
    accentVars:   '--accent: #e67e22;\n      --accent-dk: #ca6f1e;\n      --accent-2: #fef5e7;',
    heroGradient: 'linear-gradient(135deg, #431407 0%, #7c2d12 40%, #9a3412 70%, #c2410c 100%)',
    heroGlow:     'rgba(194,65,12,.4)',
    heroIcon:     '⚗',
    heroEyebrow:  'Cambridge AS & A Level Chemistry 9701',
    heroTitle:    'AS & A Level Chemistry Pacing',
    heroDesc:     'Manage chapters, topics, and syllabus codes for Years 11–12. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'asalevel_chemistry_pacing', docId: 'year11-12', subjectKey: 'chemistry', comboKey: 'asalevel_chemistry', progressKey: 'aschem_statuses', classesField: 'asalevel_chemistry_classes', yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12' }`,
    yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12',
  },
  'as-alevel-physics-pacing.html': {
    pageTitle:    'AS & A Level Physics Pacing — CentralHub',
    accentVars:   '--accent: #0369a1;\n      --accent-dk: #075985;\n      --accent-2: #f0f9ff;',
    heroGradient: 'linear-gradient(135deg, #0c4a6e 0%, #075985 40%, #0369a1 70%, #0284c7 100%)',
    heroGlow:     'rgba(2,132,199,.4)',
    heroIcon:     '⚛',
    heroEyebrow:  'Cambridge AS & A Level Physics 9702',
    heroTitle:    'AS & A Level Physics Pacing',
    heroDesc:     'Manage chapters, topics, and syllabus codes for Years 11–12. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'asalevel_physics_pacing', docId: 'year11-12', subjectKey: 'physics', comboKey: 'asalevel_physics', progressKey: 'asphys_statuses', classesField: 'asalevel_physics_classes', yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12' }`,
    yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12',
  },
  // ── Eduversal-authored non-Cambridge subjects (AS / A-Level Y11-12 tier) ──
  'as-alevel-bahasa-pacing.html': {
    pageTitle:    'AS & A Level Bahasa Indonesia Pacing — CentralHub',
    accentVars:   '--accent: #e11d48;\n      --accent-dk: #9f1239;\n      --accent-2: #fff1f3;',
    heroGradient: 'linear-gradient(135deg, #4c0519 0%, #881337 40%, #9f1239 70%, #be123c 100%)',
    heroGlow:     'rgba(225,29,72,.4)',
    heroIcon:     '📚',
    heroEyebrow:  'AS & A Level Bahasa Indonesia · EDV-BAH-A',
    heroTitle:    'AS & A Level Bahasa Indonesia Pacing',
    heroDesc:     'Manage chapters, topics, and learning objectives for Years 11–12. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_MATH,
    pacingConfig: `{ collection: 'asalevel_bahasa_pacing', docId: 'year11-12', subjectKey: 'bahasa', comboKey: 'asalevel_bahasa', syllabusCode: 'EDV-BAH-A', progressKey: 'asbahasa_statuses', classesField: 'asalevel_bahasa_classes', yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12' }`,
    yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12',
  },
  'as-alevel-edu-steam-pacing.html': {
    pageTitle:    'AS & A Level Edu-STEAM Pacing — CentralHub',
    accentVars:   '--accent: #7c3aed;\n      --accent-dk: #5b21b6;\n      --accent-2: #f5f3ff;',
    heroGradient: 'linear-gradient(135deg, #2e1065 0%, #4c1d95 35%, #5b21b6 65%, #0891b2 100%)',
    heroGlow:     'rgba(124,58,237,.4)',
    heroIcon:     '🚀',
    heroEyebrow:  'AS & A Level Edu-STEAM · EDV-STM-A',
    heroTitle:    'AS & A Level Edu-STEAM Pacing',
    heroDesc:     'Manage projects, topics, and learning objectives for Years 11–12. Monitor teacher coverage and track pacing by class.',
    aoOptions:    AO_SCIENCE,
    pacingConfig: `{ collection: 'asalevel_edu_steam_pacing', docId: 'year11-12', subjectKey: 'edu_steam', comboKey: 'asalevel_edu_steam', syllabusCode: 'EDV-STM-A', progressKey: 'asedusteam_statuses', classesField: 'asalevel_edu_steam_classes', yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12' }`,
    yearA: 'Year 11', yearB: 'Year 12', yearAKey: 'year11', yearBKey: 'year12',
  },
};

function generateFromPacingTemplate(template, cfg) {
  let out = template
    .replace('{{PAGE_TITLE}}',    cfg.pageTitle)
    .replace('{{ACCENT_VARS}}',   cfg.accentVars)
    .replace('{{HERO_GRADIENT}}', cfg.heroGradient)
    .replace('{{HERO_GLOW}}',     cfg.heroGlow)
    .replace('{{HERO_ICON}}',     cfg.heroIcon)
    .replace('{{HERO_EYEBROW}}',  cfg.heroEyebrow)
    .replace('{{HERO_TITLE}}',    cfg.heroTitle)
    .replace('{{HERO_DESC}}',     cfg.heroDesc)
    .replace('{{AO_OPTIONS}}',    cfg.aoOptions)
    .replace('{{PACING_CONFIG}}', cfg.pacingConfig);
  // 2-year pages (IGCSE / Checkpoint / AS-A) inline YEAR_A/YEAR_B chips +
  // dropdown options directly in the template; primary template ships
  // pre-rendered YEAR_CHIPS / YEAR_OPTIONS blocks instead.
  if (cfg.yearChips !== undefined) {
    out = out.replace('{{YEAR_CHIPS}}',   cfg.yearChips)
             .replace('{{YEAR_OPTIONS}}', cfg.yearOptions);
  } else {
    out = out
      .replace(/\{\{YEAR_A_KEY\}\}/g, cfg.yearAKey)
      .replace(/\{\{YEAR_B_KEY\}\}/g, cfg.yearBKey)
      .replace(/\{\{YEAR_A\}\}/g,    cfg.yearA)
      .replace(/\{\{YEAR_B\}\}/g,    cfg.yearB);
  }
  return out;
}

const igcseTemplate      = fs.readFileSync('igcse-pacing-template.html', 'utf8');
const checkpointTemplate = fs.readFileSync('secondary-checkpoint-pacing-template.html', 'utf8');
const asalevelTemplate   = fs.readFileSync('as-alevel-pacing-template.html', 'utf8');
const primaryTemplate    = fs.readFileSync('primary-pacing-template.html',    'utf8');

const generatedPacing = {};
Object.entries(IGCSE_SUBJECTS).forEach(([f, cfg]) => {
  generatedPacing[f] = generateFromPacingTemplate(igcseTemplate, cfg);
});
Object.entries(CHECKPOINT_SUBJECTS).forEach(([f, cfg]) => {
  generatedPacing[f] = generateFromPacingTemplate(checkpointTemplate, cfg);
});
Object.entries(ASALEVEL_SUBJECTS).forEach(([f, cfg]) => {
  generatedPacing[f] = generateFromPacingTemplate(asalevelTemplate, cfg);
});
Object.entries(PRIMARY_SUBJECTS).forEach(([f, cfg]) => {
  generatedPacing[f] = generateFromPacingTemplate(primaryTemplate, {
    ...cfg,
    yearChips:   PRIMARY_YEAR_CHIPS,
    yearOptions: PRIMARY_YEAR_OPTIONS,
  });
});

// -- Copy HTML files
const htmlFiles = [
  "index.html",
  "announcements.html",
  "messageboard.html",
  "schools.html",
  "pilot-enrolment.html",
  "staff.html",
  "inventory.html",
  "login.html",
  "waiting.html",
  "academic-calendar.html",
  "school-appraisals.html",
  "teacher-appraisals.html",
  "teacher-appraisal-entry.html",
  "teacher-levels.html",
  "classroom-walkthrough-entry.html",
  "observation-calibration.html",
  "teaching-progress.html",
  "primary-checkpoint-syllabus.html",
  "secondary-checkpoint-syllabus.html",
  "igcse-syllabus.html",
  "schedule-settings.html",
  "igcse-math-pacing.html",
  "igcse-biology-pacing.html",
  "igcse-chemistry-pacing.html",
  "igcse-physics-pacing.html",
  "primary-math-pacing.html",
  "primary-english-pacing.html",
  "primary-science-pacing.html",
  "checkpoint-math-pacing.html",
  "checkpoint-english-pacing.html",
  "checkpoint-science-pacing.html",
  "as-alevel-math-pacing.html",
  "as-alevel-biology-pacing.html",
  "as-alevel-chemistry-pacing.html",
  "as-alevel-physics-pacing.html",
  // Eduversal-authored non-Cambridge subjects — Bahasa Indonesia + Edu-STEAM,
  // all 4 stages (Primary / Checkpoint / IGCSE-Secondary / AS-A-Level).
  // Generated from the same pacing templates as the Cambridge pages
  // (see IGCSE_SUBJECTS / CHECKPOINT_SUBJECTS / PRIMARY_SUBJECTS /
  // ASALEVEL_SUBJECTS). EDV-prefix placeholder codes until HQ authors a
  // real scheme; content is filled in later via the standard pacing UI.
  "primary-bahasa-pacing.html",
  "checkpoint-bahasa-pacing.html",
  "igcse-bahasa-pacing.html",
  "as-alevel-bahasa-pacing.html",
  "primary-edu-steam-pacing.html",
  "checkpoint-edu-steam-pacing.html",
  "igcse-edu-steam-pacing.html",
  "as-alevel-edu-steam-pacing.html",
  "as-alevel-syllabus.html",
  "assessment-management.html",
  "console.html",
  "activities.html",
  "surveys.html",
  "survey-console.html",
  "certificates.html",
  "certificate-verify.html",
  "checklist-admin.html",
  "weekly-checklist.html",
  "feedback-management.html",
  "cambridge-calendar.html",
  "school-events.html",
  "curriculum-map.html",
  "national-math-alignment.html",
  "national-biology-alignment.html",
  "national-chemistry-alignment.html",
  "national-physics-alignment.html",
  "school-kpi-admin.html",
  "teacher-kpi-admin.html",
  "reports.html",
  "school-visits.html",
  "notifications.html",
  "settings.html",
  "mail-composer.html",
  "library.html",
  // Self-serve dashboard publishing (2026-07-13). `dashboards` is the
  // auth-guarded manager/upload page (normal CH chrome). `dashboard-view`
  // is a STANDALONE sandboxed viewer — no navbar / shared-styles / auth-guard /
  // cambridge-crossref (see STANDALONE_VIEWER handling below).
  "dashboards.html",
  "dashboard-view.html",
  "network-health.html",
  "students-overview.html",
  "competency-admin.html",
  "induction-admin.html",
  "my-induction.html",
  "handbook.html",
  "references.html",
  "pd.html",
  "roles-positions.html",
  "chip-families.html",
  "ask.html",
  "principal-coaching-session.html",
  "principal-coaching-hub.html",
  "principal-360-admin.html",
  "principal-observations.html",
  "principal-appraisals.html",
  "read-me-leadership-programs.html",
  "competency-framework.html",
  "learning-path.html",
  "specialist-portfolio.html",
  "specialist-certificates.html",
  "read-me-my-hub.html",
  "read-me-coordinator.html",
  "read-me-appraisal.html",
  "read-me-kpi.html",
  "read-me-competency.html",
  "read-me-teacher-programs.html",
  "orientation-admin.html",
  "chapter-test-author.html",
  "ease-item-author.html",
  "ease-window-admin.html",
  "ease-bank-browser.html",
  "question-bank.html",
  "practice-bank-admin.html",
  "practice-assessment-author.html",
  "daily-challenge-admin.html",
  "practice-bank-flags.html",
  "practice-bank-endorsements.html",
  "diagrams.html",
  "page-access.html",
  "rules-viewer.html",
  "design-system.html",
  "cambridge-standards.html",
  // AI Competency Framework v1.0 reader pages (Phase 1c-1e, 2026-05-17)
  "ai-framework-teacher.html",
  "ai-framework-student.html",
  "ai-framework-institutional.html",
  // AICF Phase 3 (2026-05-18) — Institutional Maturity appraisal queue
  "ai-maturity-admin.html",
  // Department Office workspace (2026-05-19) — Director + Coordinator
  // meeting + decision + artifact + directory cluster. Replaces the
  // long-running Heads-of-Departments Google Doc workflow.
  "coordinators-meetings.html",
  "department-artifacts.html",
  "decisions-register.html",
  "coordinator-proposals.html",
  "coordinators-directory.html",
  // Department Workspace (2026-05-24) — subject-scoped command centre.
  // Single page renders any of 9 ch_subjects via ?subject= query;
  // shared JS lives in partials/department-core.js + subject-config.js.
  "department-workspace.html",
  // Specialist appraisal walkthrough log (2026-05-19; renamed from
  // my-school-visits 2026-05-26) — Department Office > Workspace. Coordinator-
  // gated own 15-school visit + Window 2/3/4 progress. Shares school_visits
  // collection with /school-visits (Operations) via visitType:
  // 'specialist_walkthrough' discriminator.
  "induction-walkthroughs.html",
  // Walkthrough review queue (2026-05-19; renamed from specialist-mentor-review
  // 2026-05-26) — Department Office > Workspace. Director-only. HQ Director
  // sees submitted specialist walkthroughs, leaves NN2-confidential coaching
  // feedback, flips notesState 'submitted' → 'mentor_reviewed' (or back to
  // 'draft' for revision).
  "walkthrough-review.html",
  // Programme hubs (2026-07-24) — one page per Management-Module programme card
  // on /index. Thin shell + partials/programme-hub-core.js + programme-config.js;
  // scoped by a fixed programKey. Integrates with the Coordinators/Department
  // Office ecosystem via a programKey discriminator on the shared collections
  // (coordinators_meetings, department_artifacts, calendar_events). All 8 share
  // one shell + module; they differ only by their initProgrammeHub('<key>') call.
  "ease-growth.html",
  "ease-assessment.html",
  "ease-academic.html",
  "appraisal-system.html",
  "induction-programs.html",
  "dtp.html",
  "aft.html",
  "atc.html",
  "eduos.html",
];

// Standalone pages copied verbatim — NO navbar / shared-styles / auth-guard /
// cambridge-crossref / keyboard-enabler / a11y injection. The dashboard viewer
// renders untrusted uploaded HTML inside a sandboxed iframe and must stay a
// minimal, self-contained shell (no shared JS that could be reached from the
// page chrome). firebase-config.js is loaded by the page itself.
const STANDALONE_VERBATIM = new Set(["dashboard-view.html"]);

// ── Cache-busting (2026-08-01 pre-launch ops pass) ─────────────────
// Assets ship with bare filenames (auth-guard.js, shared-styles.css…)
// and no Cache-Control policy, so after a deploy users could hold stale
// JS against fresh HTML for an unbounded window — the classic
// "works for me, blank for them". Every local .js/.css reference in the
// emitted HTML gets ?v=<git-sha> so each deploy naturally busts caches.
let BUILD_VERSION;
try {
  BUILD_VERSION = require("child_process")
    .execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
    .toString().trim();
} catch (_) {
  BUILD_VERSION = String(Date.now());
}
console.log(`Cache-bust token: ?v=${BUILD_VERSION}`);

function addCacheBusting(html) {
  return html.replace(
    /((?:src|href)=(["']))([^"'?#]+\.(?:js|css))(\2)/g,
    (m, pre, _q, url, post) => {
      if (/^(?:https?:)?\/\//i.test(url) || url.startsWith("data:")) return m;
      return pre + url + "?v=" + BUILD_VERSION + post;
    }
  );
}

htmlFiles.forEach((file) => {
  let source = generatedPacing[file] || null;
  if (!source) {
    if (!fs.existsSync(file)) return;
    source = fs.readFileSync(file, "utf8");
  }

  if (STANDALONE_VERBATIM.has(file)) {
    fs.writeFileSync(path.join("dist", file), source);
    console.log(`Copied (standalone): ${file}`);
    return;
  }

  // Inject shared-styles.css before the first <style> or </head> tag
  if (!source.includes('shared-styles.css')) {
    const sharedLink = '  <link rel="stylesheet" href="shared-styles.css">\n';
    if (source.includes('<style>') || source.includes('<style ')) {
      source = source.replace(/(\s*<style[\s>])/, `\n${sharedLink}$1`);
    } else {
      source = source.replace('</head>', `${sharedLink}</head>`);
    }
  }

  // Inject shared navbar
  let output = sharedNavbar
    ? source.replace("<!-- SHARED_NAVBAR -->", sharedNavbar)
    : source;
  // -- A11Y (WCAG 2.2 AA, 2026-05-31): skip-link + <main> landmark --------
  //    1) Skip-link as the FIRST focusable element on the page (2.4.1 Bypass
  //       Blocks). Injected right after the opening <body ...> tag so it
  //       precedes the navbar in DOM/focus order. Styled by .skip-link in
  //       shared-styles.css.
  //    2) main-content landmark (1.3.1 / supports 2.4.1): add the id +
  //       role="main" + tabindex="-1" attributes to the FIRST content
  //       wrapper — attributes only, NEVER a new <main> wrapper element
  //       (would break `body:has(> .page-footer)` — Common Mistake #54).
  //       Fallback: a bare focus target right after the navbar if no known
  //       wrapper is found (bespoke pages like index).
  output = injectA11y(output, file);
  // Inject shared syllabus modals (Teaching Schedule + toast)
  if (syllabusModals) {
    output = output.replace("<!-- SYLLABUS_MODALS -->", syllabusModals);
  }
  // Inject shared syllabus toolbar button (Teaching Schedule launcher)
  if (syllabusToolbarBtn) {
    output = output.replace("<!-- SYLLABUS_TEACH_SCHED_BTN -->", syllabusToolbarBtn);
  }
  // Inject personal notes widget (currently only on index.html — placeholder
  // is a no-op on every other page, since the marker isn't present)
  if (notesWidget) {
    output = output.replace("<!-- NOTES_WIDGET -->", notesWidget);
  }
  // Phase 4 — inject /cambridge-crossref.js once per page (defer; auto-
  // bootstraps from DOM scan). Skip login + index since they don't render
  // CTS chips. Use lastIndexOf so we target the actual document </body>
  // and not a </body> sitting inside an inline JS template literal
  // (e.g. orientation-admin's print-window builder).
  //
  // Idempotency check: look for the actual <script src="..."> tag, not
  // a plain substring of the filename. Past incident 2026-05-15:
  // handbook.html had CSS/JS comments referencing "cambridge-crossref.js"
  // which made the loose substring check think the script was already
  // there → ES/CTS/SKL/PIGP chips rendered but were unclickable.
  if (file !== 'login.html' && file !== 'index.html' && file !== 'waiting.html' &&
      !/<script\s[^>]*src=["']cambridge-crossref\.js["']/.test(output)) {
    const closeIdx = output.lastIndexOf('</body>');
    if (closeIdx >= 0) {
      output = output.slice(0, closeIdx)
        + '<script src="cambridge-crossref.js" defer></script>\n'
        + output.slice(closeIdx);
    }
  }
  // A11Y (WCAG 2.1.1 Keyboard): inject keyboard-enabler.js on every page —
  // global Enter/Space -> click for role="button" non-native elements. Defer.
  if (!/<script\s[^>]*src=["']keyboard-enabler\.js["']/.test(output)) {
    const kClose = output.lastIndexOf('</body>');
    if (kClose >= 0) {
      output = output.slice(0, kClose)
        + '<script src="keyboard-enabler.js" defer></script>\n'
        + output.slice(kClose);
    }
  }
  output = addCacheBusting(output);
  fs.writeFileSync(path.join("dist", file), output);
  console.log(`Copied: ${file}`);
});

// -- Copy auth-guard.js
if (fs.existsSync("auth-guard.js")) {
  fs.copyFileSync("auth-guard.js", path.join("dist", "auth-guard.js"));
  console.log("Copied: auth-guard.js");
}

// -- Copy cambridge-crossref.js (Phase 4)
if (fs.existsSync("cambridge-crossref.js")) {
  fs.copyFileSync("cambridge-crossref.js", path.join("dist", "cambridge-crossref.js"));
  console.log("Copied: cambridge-crossref.js");
}

// -- Copy keyboard-enabler.js (A11Y WCAG 2.1.1 — build-injected per page)
if (fs.existsSync("keyboard-enabler.js")) {
  fs.copyFileSync("keyboard-enabler.js", path.join("dist", "keyboard-enabler.js"));
  console.log("Copied: keyboard-enabler.js");
}

// -- Copy handbook-reader.{css,js} — shared handbook reader module.
//    Source-of-truth is shared-design/; synced to each hub root via
//    `npm run sync:handbook -- --apply`. handbook.html loads these by
//    relative path so they must land at dist root next to handbook.html.
["handbook-reader.css", "handbook-reader.js"].forEach(name => {
  if (fs.existsSync(name)) {
    fs.copyFileSync(name, path.join("dist", name));
    console.log(`Copied: ${name}`);
  }
});

// Research-archive copy blocks (Permendiknas / Cambridge / ES / AICF) —
// drives the chip popovers in cambridge-crossref.js + AICF reader pages.
// Source-of-truth lives in monorepo docs/research/. CH's Vercel deploy
// checks out the monorepo (CH project root), so `..` resolves directly;
// no local mirror is needed (unlike AH+TH).
//
// Since 2026-05-25 (architecture pass step 6) — replaces ~110 lines of
// near-identical "iterate-list-and-copyFileSync" boilerplate with one
// declarative call per subtree via the shared copy-tree helper.
const { copyFiles, copyDir } = require("./build-tools/copy-tree.js");

// Permendiknas (SKL / PIGP / PMD chip popovers)
{
  const src = path.join("..", "docs", "research", "permendiknas");
  if (fs.existsSync(src)) copyFiles(
    src,
    path.join("dist", "research", "permendiknas"),
    ["no-27-2010-pigp.json", "no-10-2025-skl.json", "no-16-2007.json"],
    "dist/research/permendiknas"
  );
  // 13/2007 (principal standard — five competency dimensions) lives one level
  // down in mevzuat/ under a long descriptive filename. Flatten AND shorten it
  // to permendiknas-13-2007.json so every hub exposes the chip's source at one
  // predictable path (the AH/TH mirrors emit the same name). copyFiles cannot
  // rename, so this is a direct copy rather than another copyFiles call.
  const p13src = path.join(src, "mevzuat", "permendiknas-13-2007-standar-kepala-sekolah.json");
  const p13dest = path.join("dist", "research", "permendiknas", "permendiknas-13-2007.json");
  if (fs.existsSync(p13src)) {
    fs.mkdirSync(path.dirname(p13dest), { recursive: true });
    fs.copyFileSync(p13src, p13dest);
    console.log("  dist/research/permendiknas: +1 permendiknas-13-2007.json");
  } else {
    console.warn("WARNING: permendiknas 13/2007 source missing:", p13src);
  }
}

// Cambridge research archive (CSLS chip popovers — also surfaced cross-hub
// via /references reader)
{
  const src = path.join("..", "docs", "research", "cambridge");
  if (fs.existsSync(src)) copyFiles(
    src,
    path.join("dist", "research", "cambridge"),
    ["school-leader-standards-2023.json"],
    "dist/research/cambridge"
  );
}

// Eduversal Academic Standards (ES chip popovers — manifest + blurbs only;
// full section JSONs ship via references-data tree below for the reader)
{
  const src = path.join("..", "docs", "research", "eduversal", "academic-standards");
  if (fs.existsSync(src)) copyFiles(
    src,
    path.join("dist", "research", "eduversal", "academic-standards"),
    ["manifest.json", "search-blurbs.json"],
    "dist/research/eduversal/academic-standards"
  );
}

// Eduversal AI Competency Framework v1.0 (manifest + practical + reference
// layers) — AICF chip family + 3 reader pages /ai-framework-{teacher,
// student,institutional}
{
  const src = path.join("..", "docs", "research", "eduversal", "ai-competency-framework");
  if (fs.existsSync(src)) {
    const destDir = path.join("dist", "research", "eduversal", "ai-competency-framework");
    copyFiles(src, destDir, ["manifest.json"], "dist/research/eduversal/ai-competency-framework");
    const practicalSrc = path.join(src, "practical");
    if (fs.existsSync(practicalSrc)) {
      copyDir(practicalSrc, path.join(destDir, "practical"), "dist/research/eduversal/ai-competency-framework/practical");
    } else {
      console.warn(`WARNING: practical/ subdir not found in ${src}`);
    }
    const referenceSrc = path.join(src, "reference");
    if (fs.existsSync(referenceSrc)) {
      copyDir(referenceSrc, path.join(destDir, "reference"), "dist/research/eduversal/ai-competency-framework/reference");
    } else {
      console.warn(`WARNING: reference/ subdir not found in ${src} — chip popovers will degrade gracefully but reader pages will be empty.`);
    }
  } else {
    console.warn(`WARNING: docs/research/eduversal/ai-competency-framework/ not found — AICF chip family and reader pages will not function.`);
  }
}

// -- References & Standards data tree.
//    The /references page (Hub for policy + framework + verbatim) loads
//    these on demand via fetch('references-data/<path>'). Source of
//    truth is monorepo-root docs/ and the per-app resources/ folders.
//    Keep this list in sync with the MANIFEST in references.html.
const refDestRoot = path.join("dist", "references-data");
fs.mkdirSync(refDestRoot, { recursive: true });

/** How many Eduversal Academic Standards sections exist, per the manifest.
 *
 *  Returns 0 when the monorepo ../docs tree is not present (Vercel clones this
 *  subrepo alone). Callers use it only to GENERATE source paths, which the copy
 *  loop then existsSync-guards — so 0 means "emit no ES entries" rather than
 *  "emit broken ones", matching how every other absent ../docs source behaves. */
function esSectionCount() {
  try {
    const manifest = path.join("..", "docs", "research", "eduversal",
                               "academic-standards", "manifest.json");
    return JSON.parse(fs.readFileSync(manifest, "utf8")).sections.length;
  } catch {
    console.warn("WARNING: ES manifest unreadable (../docs absent?) — " +
                 "skipping eduversal-standards section mirror.");
    return 0;
  }
}

// Map: [destRelativePath, sourceAbsolutePath]
const refAssetMap = [
  // ── Cross-Module Audits ─────────────────────────────────────
  ["audits/INDEX.md",                                         path.join("..", "docs", "cross-module", "INDEX.md")],
  ["audits/specialist-content-depth-audit.md",                path.join("..", "docs", "cross-module", "specialist-content-depth-audit.md")],
  ["audits/school-appraisal-x-principal-rubric-mapping.json", path.join("..", "docs", "cross-module", "school-appraisal-x-principal-rubric-mapping.json")],
  ["audits/principal-360-framework-v1.json",                  path.join("..", "docs", "cross-module", "principal-360-framework-v1.json")],
  ["audits/principal-coaching-framework-v1.json",             path.join("..", "docs", "cross-module", "principal-coaching-framework-v1.json")],
  ["audits/observation-calibration-scenario-v1.json",         path.join("..", "docs", "cross-module", "observation-calibration-scenario-v1.json")],
  // Provenance / hand-author backfills — preserved as an audit trail
  // for the May 2026 content-quality sweep. Source-of-truth is now in
  // Firestore; these JSONs are the hand-authored set the seeders read.
  ["audits/competency-content-backfill-v1.json",              path.join("..", "docs", "competency", "competency-content-backfill-v1.json")],
  // (3 specialist-content-backfill/polish v1 JSONs removed 2026-06-26 —
  //  archived to docs/competency/legacy/, no longer surfaced in /references.
  //  Their manifest entries in references.html were dropped at the same time.)
  // Heyet board proposal — early Round 1 deliverable, archived but
  // kept reachable for executive context.
  ["audits/HEYET-PROPOSAL.md",                                path.join("..", "docs", "principal-development", "HEYET-PROPOSAL.md")],

  // ── Frameworks ──────────────────────────────────────────────
  // Appraisal v2 + Principal Appraisal v1 — read from AH/CH resources
  // which are kept byte-identical with TH copies via tag scripts.
  ["frameworks/appraisal-framework-v2.json",               path.join("..", "Academic Hub", "resources", "appraisal-framework-v2.json")],
  ["frameworks/principal-appraisal-framework-v1.json",     path.join("..", "Academic Hub", "resources", "principal-appraisal-framework-v1.json")],
  ["frameworks/principal-observation-rubric.json",         path.join("..", "Academic Hub", "resources", "principal-observation-rubric.json")],
  ["frameworks/principal-operating-cadence.json",          path.join("..", "Academic Hub", "resources", "principal-operating-cadence.json")],
  ["frameworks/school-appraisal-framework.json",           path.join("..", "Academic Hub", "resources", "school-appraisal-framework.json")],
  ["frameworks/appraisal-levels.json",                     path.join("..", "Academic Hub", "resources", "appraisal-levels.json")],
  ["frameworks/walkthrough-rubric.json",                   path.join("..", "Academic Hub", "resources", "walkthrough-rubric.json")],
  ["frameworks/coaching-questions.json",                   path.join("..", "Academic Hub", "resources", "coaching-questions.json")],
  ["frameworks/teaching-competency-framework.json",        path.join("resources", "teaching-competency-framework.json")],
  ["frameworks/leadership-competency-framework.json",      path.join("resources", "leadership-competency-framework.json")],
  ["frameworks/teacher-kpi-extensions-v1.json",            path.join("..", "docs", "kpi", "teacher-kpi-extensions-v1.json")],
  ["frameworks/teacher-kpi-legacy-backfill-v1.json",       path.join("..", "docs", "kpi", "teacher-kpi-legacy-backfill-v1.json")],

  // ── Weekly checklists × 8 sub-roles ────────────────────────
  ["frameworks/weekly-checklists/_academic-year-arc.json",        path.join("..", "docs", "weekly-checklists", "_academic-year-arc.json")],
  ["frameworks/weekly-checklists/subject-teacher.json",           path.join("..", "docs", "weekly-checklists", "subject-teacher.json")],
  ["frameworks/weekly-checklists/subject-leader.json",            path.join("..", "docs", "weekly-checklists", "subject-leader.json")],
  ["frameworks/weekly-checklists/school-principal.json",          path.join("..", "docs", "weekly-checklists", "school-principal.json")],
  ["frameworks/weekly-checklists/academic-coordinator.json",      path.join("..", "docs", "weekly-checklists", "academic-coordinator.json")],
  ["frameworks/weekly-checklists/cambridge-coordinator.json",     path.join("..", "docs", "weekly-checklists", "cambridge-coordinator.json")],
  ["frameworks/weekly-checklists/foundation-representative.json", path.join("..", "docs", "weekly-checklists", "foundation-representative.json")],
  ["frameworks/weekly-checklists/subject-specialist.json",        path.join("..", "docs", "weekly-checklists", "subject-specialist.json")],
  ["frameworks/weekly-checklists/director.json",                  path.join("..", "docs", "weekly-checklists", "director.json")],

  // ── Cambridge verbatim ──────────────────────────────────────
  ["cambridge/teacher-standards-2023.json",         path.join("..", "docs", "research", "cambridge", "teacher-standards-2023.json")],
  ["cambridge/teacher-standards-rationale.json",    path.join("..", "docs", "research", "cambridge", "teacher-standards-rationale.json")],
  ["cambridge/school-leader-standards-2023.json",   path.join("..", "docs", "research", "cambridge", "school-leader-standards-2023.json")],
  ["cambridge/mentoring-guide-2020.json",           path.join("..", "docs", "research", "cambridge", "mentoring-guide-2020.json")],
  ["cambridge/ictl-5881-syllabus.json",             path.join("..", "docs", "research", "cambridge", "ictl-5881-syllabus.json")],

  // ── Permendiknas / Permendikbud verbatim ────────────────────
  ["permendiknas/no-10-2025-skl.json",  path.join("..", "docs", "research", "permendiknas", "no-10-2025-skl.json")],
  ["permendiknas/no-27-2010-pigp.json", path.join("..", "docs", "research", "permendiknas", "no-27-2010-pigp.json")],
  ["permendiknas/no-16-2007.json",      path.join("..", "docs", "research", "permendiknas", "no-16-2007.json")],

  // ── Organization (Framework v1.0 + Lampiran V + roles catalogue) ─
  // Canonical eduversal-side org-topology references. The roles catalogue
  // itself stays in resources/roles-positions.json and is rendered by the
  // dedicated /roles-positions surface — references-data only mirrors a
  // copy here so the search index can pick up its content and the manifest
  // can deep-link to it.
  ["organization/organizational-meeting-framework-v1-2026.json", path.join("..", "docs", "research", "eduversal", "organizational-meeting-framework-v1-2026.json")],
  ["organization/partner-school-org-structure-lampiran-v.json",  path.join("..", "docs", "research", "eduversal", "partner-school-org-structure-lampiran-v.json")],
  ["organization/roles-positions.json",                          path.join("resources", "roles-positions.json")],

  // ── Eduversal Academic Standards (24-section network-wide manual) ─
  // The whole standards corpus is mirrored here so the /references reader
  // can deep-link any madde (e.g. "ES 7.3" → /references?doc=eduversal-
  // standards-section-07). manifest.json is the flat madde id index used
  // by the ES chip family AND by the references search index. Source-of-
  // truth is HQ-authored Academic Hub/Sections/Section NN.json → mirrored
  // into docs/research/eduversal/academic-standards/ by build-academic-
  // standards.js (--apply).
  ["eduversal-standards/manifest.json",      path.join("..", "docs", "research", "eduversal", "academic-standards", "manifest.json")],
  ["eduversal-standards/search-blurbs.json", path.join("..", "docs", "research", "eduversal", "academic-standards", "search-blurbs.json")],
  // Count read from the manifest, not hard-coded: a literal silently stops
  // copying the moment a section is added, and dist/ just quietly lacks it.
  // Past incident 2026-07-29, adding Section 24.
  //
  // Read defensively. Vercel clones ONLY this subrepo, so the whole ../docs
  // tree is absent there — every other entry in this map is just a PATH that
  // the copy loop below existsSync-guards and skips with a warning, but this
  // one READS at module scope, which threw ENOENT and took the entire build
  // down with it. (Deploy failure 2026-07-29; same parent-dir-on-Vercel trap
  // as the shared-design fallback.) Falling back to 0 sections degrades the
  // way the rest of the map already does: locally the count is derived and
  // correct, on Vercel these entries are skipped like their siblings.
  ...Array.from({ length: esSectionCount() }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return [
      `eduversal-standards/section-${n}.json`,
      path.join("..", "docs", "research", "eduversal", "academic-standards", `section-${n}.json`),
    ];
  }),

  // ── AI Competency Framework v1.0 (AICF) ─────────────────────
  // Mirror the framework spine + 4 reference JSONs (verbatim PDF parts) +
  // 6 practical layer JSONs into references-data/ so the /references hub
  // can index, search, and deep-link them (?doc=aicf-...). Source is the
  // same monorepo tree the 3 reader pages (/ai-framework-{teacher,student,
  // institutional}) and the chip family already consume, so this is a
  // duplicate-mirror — both copies stay in sync via this single build step.
  ["aicf/manifest.json",                  path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "manifest.json")],
  ["aicf/eduversal-v1-part1-teacher.json", path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "reference", "eduversal-v1-part1-teacher.json")],
  ["aicf/eduversal-v1-part2-student.json", path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "reference", "eduversal-v1-part2-student.json")],
  ["aicf/eduversal-v1-part3-institutional.json", path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "reference", "eduversal-v1-part3-institutional.json")],
  ["aicf/eduversal-v1-appendices.json",   path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "reference", "eduversal-v1-appendices.json")],
  ["aicf/unesco-ai-cft-2024.json",        path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "reference", "unesco-ai-cft-2024.json")],
  ["aicf/external-sources-index.json",    path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "reference", "external-sources-index.json")],
  ["aicf/teacher-playbook.json",          path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "practical", "teacher-playbook.json")],
  ["aicf/leader-playbook.json",           path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "practical", "leader-playbook.json")],
  ["aicf/specialist-playbook.json",       path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "practical", "specialist-playbook.json")],
  ["aicf/prompt-library.json",            path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "practical", "prompt-library.json")],
  ["aicf/redFlagsAndRedlines.json",       path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "practical", "redFlagsAndRedlines.json")],
  ["aicf/decision-trees.json",            path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "practical", "decision-trees.json")],
  ["aicf/weekly-tips.json",               path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "practical", "weekly-tips.json")],
  ["aicf/classroom-activities.json",      path.join("..", "docs", "research", "eduversal", "ai-competency-framework", "practical", "classroom-activities.json")],

  // ── Schemas & Governance ────────────────────────────────────
  ["schemas/FIRESTORE_SCHEMA.md",                  path.join("..", "docs", "architecture", "FIRESTORE_SCHEMA.md")],
  ["schemas/DESIGN_SYSTEM.md",                     path.join("..", "docs", "architecture", "DESIGN_SYSTEM.md")],
  ["schemas/CONTRIBUTING-FIRESTORE.md",            path.join("..", "docs", "architecture", "CONTRIBUTING-FIRESTORE.md")],
  ["schemas/db-diagram.md",                        path.join("..", "docs", "architecture", "db-diagram.md")],
  ["schemas/INDUCTION_CHARTER.md",                 path.join("..", "docs", "induction", "INDUCTION_CHARTER.md")],
  ["schemas/INDUCTION_CHARTER.json",               path.join("..", "docs", "induction", "INDUCTION_CHARTER.json")],
  ["schemas/induction-firestore-schema.json",     path.join("..", "docs", "induction", "firestore-schema.json")],
  ["schemas/MENTOR_CERTIFICATION_CURRICULUM.md",   path.join("..", "docs", "induction", "MENTOR_CERTIFICATION_CURRICULUM.md")],
  ["schemas/SIGNIFICANT_CONCERN_POLICY.md",        path.join("..", "docs", "induction", "SIGNIFICANT_CONCERN_POLICY.md")],
  ["schemas/induction-observation-rubric-v1.json", path.join("..", "docs", "induction", "induction-observation-rubric-v1.json")],
  ["schemas/SCHOOL_DATA_PACK_TEMPLATE.md",         path.join("..", "docs", "induction", "SCHOOL_DATA_PACK_TEMPLATE.md")],
  ["schemas/SPECIALIST_NETWORK_DATA_ACCESS.md",    path.join("..", "docs", "induction", "SPECIALIST_NETWORK_DATA_ACCESS.md")],
  ["schemas/KPI_APPRAISAL_REVISION_WORKFLOW.md",   path.join("..", "docs", "induction", "KPI_APPRAISAL_REVISION_WORKFLOW.md")],
  ["schemas/SPECIALIST_COHORT_REVIEW.md",          path.join("..", "docs", "induction", "SPECIALIST_COHORT_REVIEW.md")],
  ["schemas/weekly-checklists-SCHEMA.md",          path.join("..", "docs", "weekly-checklists", "SCHEMA.md")],

  // ── PD & Facilitation (docs/pd/) — facilitator session guides, participant
  //    one-pagers, slide-deck outlines, workbooks for the partner-school PD
  //    program. Surfaced under the /references 'pd' facet. ESL/EAL English.
  ["pd/README.md",                                 path.join("..", "docs", "pd", "README.md")],
  ["pd/facilitator-conventions.md",                path.join("..", "docs", "pd", "_facilitator-conventions.md")],
  ["pd/july-pd-program-map.md",                    path.join("..", "docs", "pd", "00-program-overview", "july-pd-program-map.md")],
  ["pd/three-rating-systems-at-a-glance.md",       path.join("..", "docs", "pd", "00-program-overview", "three-rating-systems-at-a-glance.md")],
  ["pd/teachers/onepager-how-appraisal-works.md",  path.join("..", "docs", "pd", "teachers", "onepager-how-appraisal-works.md")],
  ["pd/teachers/onepager-how-kpi-works.md",        path.join("..", "docs", "pd", "teachers", "onepager-how-kpi-works.md")],
  ["pd/teachers/session-appraisal-for-teachers.md", path.join("..", "docs", "pd", "teachers", "session-appraisal-for-teachers.md")],
  ["pd/teachers/session-kpi-for-teachers.md",      path.join("..", "docs", "pd", "teachers", "session-kpi-for-teachers.md")],
  ["pd/teachers/session-competency-self-assessment.md", path.join("..", "docs", "pd", "teachers", "session-competency-self-assessment.md")],
  ["pd/teachers/workbook-competency-self-assessment.md", path.join("..", "docs", "pd", "teachers", "workbook-competency-self-assessment.md")],
  ["pd/teachers/session-ai-in-the-classroom.md",   path.join("..", "docs", "pd", "teachers", "session-ai-in-the-classroom.md")],
  ["pd/leaders/onepager-leadership-evaluation-map.md", path.join("..", "docs", "pd", "leaders", "onepager-leadership-evaluation-map.md")],
  ["pd/leaders/session-observer-calibration-f2.md", path.join("..", "docs", "pd", "leaders", "session-observer-calibration-f2.md")],
  ["pd/leaders/workbook-f2-calibration-exercise.md", path.join("..", "docs", "pd", "leaders", "workbook-f2-calibration-exercise.md")],
  ["pd/leaders/session-coaching-glow-grow-go.md",  path.join("..", "docs", "pd", "leaders", "session-coaching-glow-grow-go.md")],
  ["pd/leaders/session-kpi-target-setting.md",     path.join("..", "docs", "pd", "leaders", "session-kpi-target-setting.md")],
  ["pd/leaders/session-leadership-competency.md",  path.join("..", "docs", "pd", "leaders", "session-leadership-competency.md")],
  ["pd/specialists/train-the-trainer-guide.md",    path.join("..", "docs", "pd", "specialists", "train-the-trainer-guide.md")],
  ["pd/specialists/session-specialist-walkthrough-lens.md", path.join("..", "docs", "pd", "specialists", "session-specialist-walkthrough-lens.md")],
  ["pd/slides/deck-three-rating-systems.md",       path.join("..", "docs", "pd", "slides", "deck-three-rating-systems.md")],
  ["pd/slides/deck-appraisal-for-teachers.md",     path.join("..", "docs", "pd", "slides", "deck-appraisal-for-teachers.md")],
  ["pd/slides/deck-kpi-for-teachers.md",           path.join("..", "docs", "pd", "slides", "deck-kpi-for-teachers.md")],
  ["pd/slides/deck-observer-calibration.md",       path.join("..", "docs", "pd", "slides", "deck-observer-calibration.md")],
  ["pd/slides/deck-ai-in-the-classroom.md",        path.join("..", "docs", "pd", "slides", "deck-ai-in-the-classroom.md")],
];

let refCopied = 0, refMissing = 0;
refAssetMap.forEach(([rel, src]) => {
  const dest = path.join(refDestRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    refCopied++;
  } else {
    console.warn(`WARNING: references-data source missing: ${src} (skipped)`);
    refMissing++;
  }
});
console.log(`Copied: dist/references-data/ (${refCopied} files, ${refMissing} missing)`);

// ── References search index ─────────────────────────────────────────
// Scans every successfully-copied references-data file and extracts:
//   - special tokens (NN[1-5], CTS X.Y, F[1-5L], F_LEAD, PIGP pasal-N,
//     SKL: dimension) — so 'NN3' finds every doc that uses NN3, not just
//     ones whose MANIFEST tag literally lists 'NN3'.
//   - headings (markdown # ## ### or top-level JSON keys) — give the
//     search a few prose anchors per doc.
// Runtime references.html fetches dist/references-search-index.json once
// at boot and unions matches with the existing DOM-text search.
function extractTokens(text) {
  const tokens = new Set();

  // NN1-NN5
  for (const m of text.matchAll(/\bNN[1-5]\b/g)) tokens.add(m[0]);

  // CTS X.Y (Cambridge Teacher Standards) — also store the bare 'CTS' so a
  // search for 'CTS' alone surfaces every doc that anchors to the standard.
  for (const m of text.matchAll(/\bCTS\s*(\d+\.\d+)\b/g)) {
    tokens.add(`CTS ${m[1]}`);
  }
  if (/\bCTS\b/.test(text)) tokens.add('CTS');

  // F1-F5, F_LEAD, F3L
  for (const m of text.matchAll(/\bF(?:_LEAD|[1-5][A-Z]?)\b/g)) tokens.add(m[0]);

  // PIGP — bare mention OR with pasal-N / lampiran-X qualifier
  if (/\bPIGP\b/.test(text)) tokens.add('PIGP');
  for (const m of text.matchAll(/\bPIGP\s+(?:pasal|lampiran)-[\w-]+/gi)) {
    tokens.add(m[0].replace(/\s+/g, ' '));
  }

  // SKL — bare mention OR with dimension_id
  if (/\bSKL\b/.test(text)) tokens.add('SKL');
  for (const m of text.matchAll(/\bSKL[:\s]+([a-z_]+)\b/gi)) tokens.add(`SKL: ${m[1]}`);

  return [...tokens];
}

function extractHeadings(text, kind) {
  const out = [];
  if (kind === 'md') {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
      if (m && out.length < 12) out.push(m[2]);
    }
  } else if (kind === 'json') {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const k of Object.keys(obj).slice(0, 12)) out.push(k);
      }
    } catch (_) { /* malformed JSON — skip headings, tokens still work */ }
  }
  return out;
}

const searchIndex = { version: '1', builtAt: new Date().toISOString(), docs: {} };
let indexedDocs = 0;
refAssetMap.forEach(([rel, src]) => {
  if (!fs.existsSync(src)) return;
  const text = fs.readFileSync(src, 'utf8');
  const kind = rel.endsWith('.md') ? 'md' : rel.endsWith('.json') ? 'json' : 'unknown';
  const tokens = extractTokens(text);
  const headings = extractHeadings(text, kind);
  // Only persist entries that actually carry tokens or headings — empty
  // payloads add bytes and noise without helping recall.
  if (tokens.length || headings.length) {
    searchIndex.docs[rel] = { tokens, headings };
    indexedDocs++;
  }
});
fs.writeFileSync(
  path.join('dist', 'references-search-index.json'),
  JSON.stringify(searchIndex)
);
console.log(`Generated: dist/references-search-index.json (${indexedDocs} docs indexed)`);

// -- Copy firestore.rules so /rules-viewer can fetch it at runtime.
//    Read-only display; the live enforcement comes from the deployed
//    rules at console.firebase.google.com, this is just the
//    human-readable mirror.
if (fs.existsSync("firestore.rules")) {
  fs.copyFileSync("firestore.rules", path.join("dist", "firestore.rules"));
  console.log("Copied: firestore.rules");
}

// -- Copy static assets
if (fs.existsSync("resources")) {
  copyDirRecursive("resources", "dist/resources");
  console.log("Copied: resources/");
}

// -- Copy calendar-fallback.js
if (fs.existsSync("calendar-fallback.js")) {
  fs.copyFileSync("calendar-fallback.js", path.join("dist", "calendar-fallback.js"));
  console.log("Copied: calendar-fallback.js");
}

// -- Copy shared-styles.css
if (fs.existsSync("shared-styles.css")) {
  fs.copyFileSync("shared-styles.css", path.join("dist", "shared-styles.css"));
  console.log("Copied: shared-styles.css");
}

// -- Copy tokens.css
if (fs.existsSync("tokens.css")) {
  fs.copyFileSync("tokens.css", path.join("dist", "tokens.css"));
  console.log("Copied: tokens.css");
}

// -- Copy Eduversal master logo (white-on-transparent, 600x176)
// Used by login + navbar across all hubs; mail templates pull this from
// https://centralhub.eduversal.org/eduversal-logo-white.png
if (fs.existsSync("eduversal-logo-white.png")) {
  fs.copyFileSync("eduversal-logo-white.png", path.join("dist", "eduversal-logo-white.png"));
  console.log("Copied: eduversal-logo-white.png");
}

// references-viewer schema-aware modal renderer + references-shell
// runtime (shared CSS + ES module) — local-then-shared fallback pattern
// (mirrors nav-edit-simple). Used by references.html. Local hub copies
// are auto-synced from shared-design/ via `npm run sync:tokens --apply`.
[
  'references-viewer.js',
  'references-viewer.css',
  'references-shell.js',
  'references-shell.css',
].forEach(name => {
  const local  = name;
  const shared = path.join('..', 'shared-design', name);
  const src    = fs.existsSync(local) ? local : (fs.existsSync(shared) ? shared : null);
  if (src) {
    fs.copyFileSync(src, path.join('dist', name));
    console.log(`Copied: ${src} -> dist/${name}`);
  } else {
    console.warn(`WARNING: ${name} not found locally or in shared-design/`);
  }
});

// competency-framework.css — 3-hub byte-identical CSS partial (cf-legend
// popover + domain-takeaways accordion). Source-of-truth lives in
// monorepo-root /shared-design/competency-framework.css. Same local-then-
// shared fallback as references-viewer. Linked from competency-framework.html
// at dist root. If shared CSS is missing, the page still renders but the
// cf-legend bottom-right help button + takeaways toggle lose styling.
{
  const name   = 'competency-framework.css';
  const local  = name;
  const shared = path.join('..', 'shared-design', name);
  const src    = fs.existsSync(local) ? local : (fs.existsSync(shared) ? shared : null);
  if (src) {
    fs.copyFileSync(src, path.join('dist', name));
    console.log(`Copied: ${src} -> dist/${name}`);
  } else {
    console.warn(`WARNING: ${name} not found locally or in shared-design/`);
  }
}

// -- Copy partials/*.js shared modules + shared partial CSS
const partialsDistDir = path.join("dist", "partials");
if (!fs.existsSync(partialsDistDir)) fs.mkdirSync(partialsDistDir, { recursive: true });
const partialsAssets = ["pacing-core.js", "syllabus-core.js", "syllabus-styles.css", "question-editor.js", "subject-config.js", "department-core.js", "programme-config.js", "programme-hub-core.js"];
for (const fname of partialsAssets) {
  const src = path.join("partials", fname);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(partialsDistDir, fname));
    console.log(`Copied: partials/${fname}`);
  }
}

// -- Summary
console.log("\nBuild completed successfully!");
console.log("Environment variables:");
Object.keys(cfg).forEach((key) => {
  console.log(`  ${key}: ${cfg[key] ? "[SET]" : "[NOT SET - login will fail]"}`);
});
