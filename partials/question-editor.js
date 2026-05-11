// Shared rich question editor for chapter_test_items + ease_items.
//
// Usage (ES module):
//   import { mountQuestionEditor } from './partials/question-editor.js';
//   const editor = mountQuestionEditor(containerEl, {
//     mode: 'chapter_test' | 'ease',
//     initialItem: {...} | null,   // null for new item
//     subjects: ['math','english','science', ...],
//     onSave: async (item) => { ... },
//     onCancel: () => { ... },
//   });
//
// The editor renders into containerEl (replaces children). It manages
// its own state and emits the cleaned-up item payload via onSave.
//
// Storage layout for stem images:
//   chapter_test_items/{itemId}/stem.{ext}   (chapter_test mode)
//   ease_items/{itemId}/stem.{ext}           (ease mode)
//
// Dependencies (loaded on first mount):
//   KaTeX 0.16   (LaTeX render)        — https://cdn.jsdelivr.net/npm/katex@0.16.9/...
//   marked 12    (Markdown render)     — https://cdn.jsdelivr.net/npm/marked@12/...
//
// Both are loaded once and cached on window.__qeDeps.

const KATEX_CSS  = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css';
const KATEX_JS   = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js';
const KATEX_AUTO = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js';
const MARKED_JS  = 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js';

const SUBJECTS_ALL = [
  { id: 'math',      label: 'Mathematics' },
  { id: 'english',   label: 'English'     },
  { id: 'science',   label: 'Science'     },
  { id: 'biology',   label: 'Biology'     },
  { id: 'chemistry', label: 'Chemistry'   },
  { id: 'physics',   label: 'Physics'     },
  { id: 'bahasa',    label: 'Bahasa'      },
  { id: 'religion',  label: 'Religion'    },
];
const SUBJECTS_EASE = SUBJECTS_ALL.filter(s => ['math','english','science'].includes(s.id));

// Cambridge command words — placeholder list. Replace with provenance-pinned
// JSON from docs/research/cambridge/ once 0862/0861/0893 syllabus excerpts arrive.
const COMMAND_WORDS = [
  'Calculate', 'Compare', 'Define', 'Describe', 'Discuss', 'Evaluate',
  'Explain', 'Give', 'Identify', 'Justify', 'List', 'Name', 'Outline',
  'Predict', 'Show', 'State', 'Suggest', 'Sketch',
];

const ASSESSMENT_OBJECTIVES = [
  { id: 'AO1', label: 'AO1 — Knowledge & understanding' },
  { id: 'AO2', label: 'AO2 — Application & analysis'     },
  { id: 'AO3', label: 'AO3 — Experimental / evaluation'   },
];

// ─── dependency loader ────────────────────────────────────────────────

async function loadDeps() {
  if (window.__qeDeps?.ready) return window.__qeDeps;
  const deps = window.__qeDeps = { ready: false };

  // CSS
  if (!document.querySelector(`link[href="${KATEX_CSS}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = KATEX_CSS;
    document.head.appendChild(link);
  }

  // Scripts (sequential — auto-render depends on katex)
  await loadScript(KATEX_JS);
  await loadScript(KATEX_AUTO);
  await loadScript(MARKED_JS);

  deps.ready = true;
  return deps;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// ─── rendering helpers ────────────────────────────────────────────────

function renderRich(targetEl, text) {
  if (!text) { targetEl.innerHTML = '<em style="color:var(--ink-3, #888)">Empty</em>'; return; }
  try {
    const html = window.marked
      ? window.marked.parse(text, { breaks: true })
      : escapeHtml(text).replace(/\n/g, '<br>');
    targetEl.innerHTML = html;
    if (window.renderMathInElement) {
      window.renderMathInElement(targetEl, {
        delimiters: [
          { left: '$$', right: '$$', display: true  },
          { left: '$',  right: '$',  display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true  },
        ],
        throwOnError: false,
      });
    }
  } catch (err) {
    targetEl.innerHTML = `<span style="color:#c00">Preview error: ${escapeHtml(err.message)}</span>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ─── component ────────────────────────────────────────────────────────

export async function mountQuestionEditor(container, opts) {
  const {
    mode = 'chapter_test',                  // 'chapter_test' | 'ease'
    initialItem = null,
    subjects = mode === 'ease' ? SUBJECTS_EASE : SUBJECTS_ALL,
    extraFieldsHtml = '',                   // HTML appended to the right-side metadata column
    extraFieldsBind = null,                 // (rootEl, item, opts) => void — wire up the extra inputs
    onSave,
    onCancel,
  } = opts || {};

  await loadDeps();

  // Working state — clone so caller's object isn't mutated.
  const item = normalizeItem(initialItem, mode);

  container.innerHTML = '';
  container.appendChild(buildStyles());

  const root = document.createElement('div');
  root.className = 'qe-root';
  container.appendChild(root);

  root.innerHTML = renderShell(item, mode, subjects, extraFieldsHtml);
  if (typeof extraFieldsBind === 'function') {
    try { extraFieldsBind(root, item, opts); }
    catch (err) { console.error('[question-editor] extraFieldsBind failed', err); }
  }

  // -- wire up handlers -----------------------------------------------
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => Array.from(root.querySelectorAll(sel));

  // Subject / stage / unit / metadata wiring
  bindInput($('#qe-subject'),     'subjectId');
  bindInput($('#qe-stage'),       'stage', parseInt);
  bindInput($('#qe-unitCode'),    'unitCode');
  bindInput($('#qe-unitTitle'),   'unitTitle');
  bindInput($('#qe-type'),        'type', null, onTypeChange);
  bindInput($('#qe-marks'),       'marks', parseInt);
  bindInput($('#qe-difficulty'),  'difficulty');
  bindInput($('#qe-difficultyStars'), 'difficultyStars', parseInt);
  bindInput($('#qe-commandWord'), 'commandWord');
  bindInput($('#qe-ao'),          'assessmentObjective');
  bindInput($('#qe-syllabusObjective'), 'syllabusObjective');
  bindInput($('#qe-cambridgeRefs'), 'cambridgeStandardRefsRaw', null, () => {
    item.cambridgeStandardRefs = parseRefs(item.cambridgeStandardRefsRaw);
  });

  // Stem + live preview
  // Imported items carry rich HTML in stemHtml + LaTeX delimiters
  // \(…\). HQ-authored items carry plain markdown in stem. Prefer
  // stemHtml as the seed so HQ specialists see the actual question
  // content (not stripped plain text) and can edit it inline.
  // marked.parse() passes HTML through; KaTeX auto-render picks up
  // \(…\) regardless of wrapper tags.
  const stemTA = $('#qe-stem'); const stemPV = $('#qe-stem-preview');
  if (!item.stem && item.stemHtml) item.stem = item.stemHtml;
  stemTA.value = item.stem || '';
  stemTA.addEventListener('input', () => {
    item.stem = stemTA.value;
    renderRich(stemPV, item.stem);
  });
  renderRich(stemPV, item.stem);

  // Type-specific blocks
  function onTypeChange() {
    $$('.qe-type-block').forEach(el => el.style.display = 'none');
    const block = $(`#qe-block-${item.type}`);
    if (block) block.style.display = '';
  }
  onTypeChange();

  // MCQ options
  // Same seed-from-rich-source pattern as the stem: if optionsHtml[i]
  // exists and the plain options[i] is empty or matches a stripped
  // version, swap in the rich source so the editor textarea shows the
  // real content.
  if (Array.isArray(item.optionsHtml) && Array.isArray(item.options)) {
    item.options = item.options.map((plain, i) => {
      const rich = item.optionsHtml[i];
      if (!plain && rich) return rich;
      // Heuristic: if rich is non-empty AND plain is a clear subset
      // (entities decoded, tags stripped), prefer rich so HQ sees
      // markdown source they can actually edit.
      if (rich && plain) return rich;
      return plain;
    });
  }
  const optsList = $('#qe-options-list');
  function renderOpts() {
    optsList.innerHTML = '';
    (item.options || []).forEach((opt, idx) => {
      const row = document.createElement('div');
      row.className = 'qe-opt-row';
      row.innerHTML = `
        <label class="qe-opt-radio">
          <input type="radio" name="qe-correct" ${idx === item.correctIdx ? 'checked' : ''}>
        </label>
        <textarea class="qe-opt-text" rows="1" placeholder="Option ${String.fromCharCode(65 + idx)}">${escapeHtml(opt)}</textarea>
        <div class="qe-opt-preview"></div>
        <button type="button" class="qe-opt-up"  title="Move up">↑</button>
        <button type="button" class="qe-opt-down" title="Move down">↓</button>
        <button type="button" class="qe-opt-rm"  title="Remove">×</button>
      `;
      optsList.appendChild(row);

      const ta = row.querySelector('.qe-opt-text');
      const pv = row.querySelector('.qe-opt-preview');
      renderRich(pv, opt);
      ta.addEventListener('input', () => {
        item.options[idx] = ta.value;
        renderRich(pv, ta.value);
      });
      row.querySelector('input[type=radio]').addEventListener('change', () => {
        item.correctIdx = idx;
      });
      row.querySelector('.qe-opt-up').addEventListener('click', () => moveOpt(idx, -1));
      row.querySelector('.qe-opt-down').addEventListener('click', () => moveOpt(idx, +1));
      row.querySelector('.qe-opt-rm').addEventListener('click', () => {
        item.options.splice(idx, 1);
        if (item.correctIdx >= idx && item.correctIdx > 0) item.correctIdx--;
        renderOpts();
      });
    });
  }
  function moveOpt(idx, dir) {
    const tgt = idx + dir;
    if (tgt < 0 || tgt >= item.options.length) return;
    const tmp = item.options[idx];
    item.options[idx] = item.options[tgt];
    item.options[tgt] = tmp;
    if (item.correctIdx === idx) item.correctIdx = tgt;
    else if (item.correctIdx === tgt) item.correctIdx = idx;
    renderOpts();
  }
  $('#qe-opt-add').addEventListener('click', () => {
    item.options = item.options || [];
    item.options.push('');
    renderOpts();
  });
  renderOpts();

  // Numeric
  bindInput($('#qe-numeric-answer'), 'correctAnswer');
  bindInput($('#qe-numeric-tolerance'), 'tolerance', parseFloat);

  // Short
  bindInput($('#qe-short-answer'), 'correctAnswer');
  $('#qe-short-accepted').value = (item.acceptedAnswers || []).join('\n');
  $('#qe-short-accepted').addEventListener('input', (e) => {
    item.acceptedAnswers = e.target.value.split('\n').map(s => s.trim()).filter(Boolean);
  });

  // Mark scheme + explanation (with previews)
  const msTA = $('#qe-markScheme'); const msPV = $('#qe-markScheme-preview');
  msTA.value = item.markScheme || '';
  msTA.addEventListener('input', () => { item.markScheme = msTA.value; renderRich(msPV, msTA.value); });
  renderRich(msPV, item.markScheme);

  const expTA = $('#qe-explanation'); const expPV = $('#qe-explanation-preview');
  expTA.value = item.explanation || '';
  expTA.addEventListener('input', () => { item.explanation = expTA.value; renderRich(expPV, expTA.value); });
  renderRich(expPV, item.explanation);

  // Save / cancel
  $('#qe-save').addEventListener('click', async () => {
    const cleaned = finalizePayload(item, mode);
    const err = validate(cleaned, mode);
    if (err) { showErr(err); return; }
    showErr(null);
    $('#qe-save').disabled = true; $('#qe-save').textContent = 'Saving…';
    try {
      await onSave?.(cleaned);
    } catch (e) {
      showErr(e?.message || 'Save failed');
    } finally {
      $('#qe-save').disabled = false; $('#qe-save').textContent = 'Save item';
    }
  });
  $('#qe-cancel').addEventListener('click', () => onCancel?.());

  function showErr(msg) {
    const e = $('#qe-error');
    if (!msg) { e.style.display = 'none'; e.textContent = ''; return; }
    e.style.display = ''; e.textContent = msg;
  }

  function bindInput(el, key, cast, onChange) {
    if (!el) return;
    if (item[key] !== undefined && item[key] !== null) {
      if (el.tagName === 'INPUT' && el.type === 'checkbox') el.checked = !!item[key];
      else el.value = item[key];
    }
    el.addEventListener('input', () => {
      let v = el.tagName === 'INPUT' && el.type === 'checkbox' ? el.checked : el.value;
      if (cast) v = cast(v);
      if (Number.isNaN(v)) v = null;
      item[key] = v;
      onChange?.();
    });
    el.addEventListener('change', () => el.dispatchEvent(new Event('input')));
  }

  return {
    getItem: () => finalizePayload(item, mode),
    setItem: (next) => { Object.assign(item, normalizeItem(next, mode)); },
    destroy: () => { container.innerHTML = ''; },
  };
}

// ─── shell HTML ───────────────────────────────────────────────────────

function renderShell(item, mode, subjects, extraFieldsHtml = '') {
  const subjectOpts = subjects.map(s =>
    `<option value="${s.id}" ${s.id === item.subjectId ? 'selected' : ''}>${s.label}</option>`
  ).join('');
  const cwOpts = ['<option value="">— (none) —</option>',
    ...COMMAND_WORDS.map(w => `<option value="${w}" ${w === item.commandWord ? 'selected' : ''}>${w}</option>`)
  ].join('');
  const aoOpts = ['<option value="">— (none) —</option>',
    ...ASSESSMENT_OBJECTIVES.map(a => `<option value="${a.id}" ${a.id === item.assessmentObjective ? 'selected' : ''}>${a.label}</option>`)
  ].join('');
  const stageOpts = [7,8,9,10,11,12].map(y =>
    `<option value="${y}" ${y === item.stage ? 'selected' : ''}>Year ${y}</option>`
  ).join('');
  const showUnit = mode === 'chapter_test';

  return `
    <div class="qe-grid">
      <div class="qe-col-left">
        <div class="qe-section">
          <h3>Question stem</h3>
          <p class="qe-hint">
            Markdown + LaTeX. Inline math: <code>\\(x^2\\)</code> or <code>$x^2$</code>. Display: <code>\\[…\\]</code> or <code>$$…$$</code>.
            Inline HTML (e.g. <code>&lt;img src&gt;</code>, <code>&lt;p&gt;</code>) is preserved as-is.
            Live preview shows what students see.
          </p>
          <div class="qe-stem-split">
            <textarea id="qe-stem" rows="6" placeholder="Markdown + LaTeX. Use $x^2$ inline or $$\\int$$ block."></textarea>
            <div class="qe-preview" id="qe-stem-preview"></div>
          </div>
        </div>

        <div class="qe-section">
          <h3>Answer</h3>
          <div class="qe-row">
            <label>Type</label>
            <select id="qe-type">
              <option value="mcq"     ${item.type === 'mcq'     ? 'selected' : ''}>Multiple choice</option>
              <option value="numeric" ${item.type === 'numeric' ? 'selected' : ''}>Numeric</option>
              <option value="short"   ${item.type === 'short'   ? 'selected' : ''}>Short answer</option>
            </select>
          </div>

          <div class="qe-type-block" id="qe-block-mcq">
            <label>Options (radio = correct)</label>
            <div id="qe-options-list"></div>
            <button type="button" id="qe-opt-add" class="qe-btn-secondary">+ Add option</button>
          </div>

          <div class="qe-type-block" id="qe-block-numeric">
            <div class="qe-row">
              <label>Correct numeric answer</label>
              <input id="qe-numeric-answer" type="text" placeholder="e.g. 42 or 3.14">
            </div>
            <div class="qe-row">
              <label>Tolerance (±)</label>
              <input id="qe-numeric-tolerance" type="number" step="any" placeholder="0 = exact match">
            </div>
          </div>

          <div class="qe-type-block" id="qe-block-short">
            <div class="qe-row">
              <label>Primary answer</label>
              <input id="qe-short-answer" type="text" placeholder="Exact match (case-insensitive)">
            </div>
            <div class="qe-row">
              <label>Accepted synonyms (one per line)</label>
              <textarea id="qe-short-accepted" rows="3" placeholder="Each line = an accepted match"></textarea>
            </div>
          </div>
        </div>

        <div class="qe-section">
          <h3>Mark scheme (optional)</h3>
          <div class="qe-stem-split">
            <textarea id="qe-markScheme" rows="4" placeholder="Cambridge M1/A1/B1 notation. e.g. **M1** correct substitution · **A1** answer with unit"></textarea>
            <div class="qe-preview" id="qe-markScheme-preview"></div>
          </div>
        </div>

        <div class="qe-section">
          <h3>Explanation (shown to student after submit)</h3>
          <div class="qe-stem-split">
            <textarea id="qe-explanation" rows="3"></textarea>
            <div class="qe-preview" id="qe-explanation-preview"></div>
          </div>
        </div>
      </div>

      <div class="qe-col-right">
        <div class="qe-section">
          <h3>Metadata</h3>
          <div class="qe-row">
            <label>Subject</label>
            <select id="qe-subject">${subjectOpts}</select>
          </div>
          <div class="qe-row">
            <label>Year</label>
            <select id="qe-stage">${stageOpts}</select>
          </div>
          ${showUnit ? `
          <div class="qe-row">
            <label>Unit code</label>
            <input id="qe-unitCode" type="text" placeholder="e.g. 7Ni.04 or C1.6" value="${escapeHtml(item.unitCode || '')}">
          </div>
          <div class="qe-row">
            <label>Unit title</label>
            <input id="qe-unitTitle" type="text" placeholder="e.g. Integers, powers and roots" value="${escapeHtml(item.unitTitle || '')}">
          </div>
          ` : ''}
          <div class="qe-row qe-row-2">
            <div>
              <label>Marks</label>
              <input id="qe-marks" type="number" min="1" max="20" value="${item.marks || 1}">
            </div>
            <div>
              <label>Difficulty</label>
              <select id="qe-difficulty">
                <option value="easy"   ${item.difficulty === 'easy'   ? 'selected' : ''}>Easy</option>
                <option value="medium" ${item.difficulty === 'medium' ? 'selected' : ''}>Medium</option>
                <option value="hard"   ${item.difficulty === 'hard'   ? 'selected' : ''}>Hard</option>
              </select>
            </div>
          </div>
          <div class="qe-row">
            <label>Difficulty stars</label>
            <select id="qe-difficultyStars">
              <option value=""  ${!item.difficultyStars ? 'selected' : ''}>— (none) —</option>
              <option value="1" ${item.difficultyStars === 1 ? 'selected' : ''}>★ — recall</option>
              <option value="2" ${item.difficultyStars === 2 ? 'selected' : ''}>★★ — apply</option>
              <option value="3" ${item.difficultyStars === 3 ? 'selected' : ''}>★★★ — analyse / evaluate</option>
            </select>
          </div>
        </div>

        <div class="qe-section">
          <h3>Cambridge metadata</h3>
          <div class="qe-row">
            <label>Command word</label>
            <select id="qe-commandWord">${cwOpts}</select>
          </div>
          <div class="qe-row">
            <label>Assessment objective</label>
            <select id="qe-ao">${aoOpts}</select>
          </div>
          <div class="qe-row">
            <label>Syllabus objective</label>
            <input id="qe-syllabusObjective" type="text" placeholder="e.g. C4.1 – Define the term acid" value="${escapeHtml(item.syllabusObjective || '')}">
          </div>
          <div class="qe-row">
            <label>Cambridge refs (comma-separated)</label>
            <input id="qe-cambridgeRefs" type="text" placeholder="e.g. 7Ni.04, CTS 1.2" value="${escapeHtml((item.cambridgeStandardRefs || []).join(', '))}">
          </div>
        </div>

        ${extraFieldsHtml}

        <div id="qe-error" class="qe-error" style="display:none"></div>
        <div class="qe-actions">
          <button type="button" id="qe-cancel" class="qe-btn-secondary">Cancel</button>
          <button type="button" id="qe-save"   class="qe-btn-primary">Save item</button>
        </div>
      </div>
    </div>
  `;
}

function buildStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .qe-root { font-family: inherit; }
    .qe-grid { display: grid; grid-template-columns: 1fr 320px; gap: 18px; }
    @media (max-width: 900px) { .qe-grid { grid-template-columns: 1fr; } }
    .qe-section { background:#fff; border:1px solid var(--border, #e5e7eb); border-radius:10px; padding:14px; margin-bottom:14px; }
    .qe-section h3 { font-family: 'Lora', serif; font-size: .98rem; margin: 0 0 10px; font-weight:600; color: var(--ink, #111); }
    .qe-hint { margin: 0 0 10px; font-size: 12px; color: var(--ink-3, #888); line-height: 1.5; }
    .qe-hint code { background: var(--paper, #f5f5f5); padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
    .qe-stem-split { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
    @media (max-width: 700px) { .qe-stem-split { grid-template-columns: 1fr; } }
    .qe-stem-split textarea { width:100%; min-height: 110px; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size:12.5px; padding:10px; border:1px solid var(--border, #e5e7eb); border-radius:8px; resize: vertical; }
    .qe-preview { padding:10px; border:1px dashed var(--border, #e5e7eb); border-radius:8px; background:#fafafa; font-size:13.5px; line-height:1.5; min-height:110px; max-height: 220px; overflow:auto; }
    .qe-preview p:first-child { margin-top: 0; }
    .qe-preview p:last-child { margin-bottom: 0; }
    .qe-row { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
    .qe-row label { font-size:12px; font-weight:600; color: var(--ink-2, #444); }
    .qe-row input, .qe-row select, .qe-row textarea { padding:8px 10px; border:1px solid var(--border, #e5e7eb); border-radius:8px; font:inherit; font-size:13px; }
    .qe-row-2 { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
    .qe-row-2 > div { display:flex; flex-direction:column; gap:4px; }
    .qe-type-block { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border, #e5e7eb); }
    .qe-opt-row { display:grid; grid-template-columns: 22px 1fr 1fr 26px 26px 26px; gap:6px; align-items:center; margin-bottom:6px; }
    .qe-opt-text { font-size:13px; padding:6px 8px; border:1px solid var(--border, #e5e7eb); border-radius:6px; resize:vertical; min-height:34px; font-family:inherit; }
    .qe-opt-preview { padding:6px 8px; border:1px dashed var(--border, #e5e7eb); border-radius:6px; background:#fafafa; font-size:12.5px; min-height:34px; }
    .qe-opt-row button { background:#fff; border:1px solid var(--border, #e5e7eb); border-radius:6px; cursor:pointer; font-size:13px; padding:4px 0; }
    .qe-opt-row button:hover { background:#f3f4f6; }
    .qe-btn-primary, .qe-btn-secondary { padding:8px 16px; border-radius:8px; border:1px solid transparent; font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
    .qe-btn-primary { background: var(--accent, #6c5ce7); color:#fff; }
    .qe-btn-primary:hover { background: var(--accent-dk, #5a4ed1); }
    .qe-btn-primary:disabled { opacity:.6; cursor:wait; }
    .qe-btn-secondary { background:#fff; color: var(--ink, #111); border-color: var(--border, #e5e7eb); }
    .qe-btn-secondary:hover { background:#f3f4f6; }
    .qe-actions { display:flex; gap:8px; justify-content:flex-end; }
    .qe-error { padding:10px 12px; background:#fef2f2; color:#b91c1c; border:1px solid #fca5a5; border-radius:8px; font-size:13px; margin-bottom:10px; }
  `;
  return style;
}

// ─── normalisation + validation ───────────────────────────────────────

function normalizeItem(src, mode) {
  const base = {
    type:            'mcq',
    stem:            '',
    options:         ['', '', '', ''],
    correctIdx:      0,
    correctAnswer:   '',
    tolerance:       null,
    acceptedAnswers: [],
    marks:           1,
    difficulty:      'medium',
    difficultyStars: null,
    commandWord:     null,
    assessmentObjective: null,
    syllabusObjective:   null,
    cambridgeStandardRefs: [],
    cambridgeStandardRefsRaw: '',
    markScheme:      null,
    explanation:     null,
    subjectId:       mode === 'ease' ? 'math' : 'math',
    stage:           7,
    unitCode:        '',
    unitTitle:       '',
    status:          'draft',
    version:         1,
    parentItemId:    null,
  };
  if (!src) return base;
  const merged = { ...base, ...src };
  if (Array.isArray(merged.cambridgeStandardRefs)) {
    merged.cambridgeStandardRefsRaw = merged.cambridgeStandardRefs.join(', ');
  }
  if (merged.type === 'mcq' && (!merged.options || merged.options.length < 2)) {
    merged.options = ['', '', '', ''];
  }
  return merged;
}

function finalizePayload(item, mode) {
  const stemTrim = String(item.stem || '').trim();
  const out = {
    type:            item.type,
    stem:            stemTrim,
    stemHtml:        stemTrim,
    marks:           Number(item.marks) || 1,
    difficulty:      item.difficulty || 'medium',
    difficultyStars: item.difficultyStars || null,
    commandWord:     item.commandWord || null,
    assessmentObjective: item.assessmentObjective || null,
    syllabusObjective:   item.syllabusObjective ? String(item.syllabusObjective).trim() : null,
    cambridgeStandardRefs: parseRefs(item.cambridgeStandardRefsRaw),
    markScheme:      item.markScheme ? String(item.markScheme).trim() : null,
    explanation:     item.explanation ? String(item.explanation).trim() : null,
    subjectId:       item.subjectId,
    stage:           Number(item.stage) || null,
    status:          item.status || 'draft',
    version:         Number(item.version) || 1,
    parentItemId:    item.parentItemId || null,
  };
  if (mode === 'chapter_test') {
    out.unitCode  = item.unitCode ? String(item.unitCode).trim() : null;
    out.unitTitle = item.unitTitle ? String(item.unitTitle).trim() : null;
  }
  if (item.type === 'mcq') {
    out.options    = (item.options || []).map(s => String(s || '').trim());
    // Mirror rich source into *Html fields so runner + row preview
    // stay consistent regardless of whether content arrived from
    // an import (HTML + LaTeX) or a fresh HQ author (markdown).
    out.optionsHtml = out.options.slice();
    out.correctIdx = Number(item.correctIdx) || 0;
    out.correctAnswer  = null;
    out.tolerance      = null;
    out.acceptedAnswers = null;
  } else if (item.type === 'numeric') {
    out.options       = null;
    out.correctIdx    = null;
    out.correctAnswer = item.correctAnswer != null ? String(item.correctAnswer).trim() : '';
    out.tolerance     = item.tolerance != null && !Number.isNaN(item.tolerance) ? Number(item.tolerance) : 0;
    out.acceptedAnswers = null;
  } else if (item.type === 'short') {
    out.options       = null;
    out.correctIdx    = null;
    out.correctAnswer = item.correctAnswer != null ? String(item.correctAnswer).trim() : '';
    out.tolerance     = null;
    out.acceptedAnswers = Array.isArray(item.acceptedAnswers) ? item.acceptedAnswers : [];
  }
  return out;
}

function validate(p, mode) {
  if (!p.stem) return 'Question stem is required.';
  if (mode === 'chapter_test' && !p.unitCode) return 'Unit code is required for chapter test items.';
  if (!p.subjectId) return 'Subject is required.';
  if (p.type === 'mcq') {
    if (!Array.isArray(p.options) || p.options.length < 2) return 'MCQ needs at least 2 options.';
    if (p.options.some(o => !o)) return 'MCQ options cannot be empty.';
    if (typeof p.correctIdx !== 'number' || p.correctIdx < 0 || p.correctIdx >= p.options.length) {
      return 'Pick a correct option.';
    }
  } else if (p.type === 'numeric') {
    if (!p.correctAnswer) return 'Numeric answer is required.';
    if (Number.isNaN(parseFloat(p.correctAnswer))) return 'Numeric answer must be a number.';
  } else if (p.type === 'short') {
    if (!p.correctAnswer) return 'Short answer requires a primary correct value.';
  }
  if (p.marks < 1) return 'Marks must be at least 1.';
  return null;
}

function parseRefs(raw) {
  if (!raw) return [];
  return String(raw).split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
}
