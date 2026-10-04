// ═══════════════════════════════════════════════════════════════
// Students Hub game rules (2026-10-04) — pure functions, no Firebase.
//
// Required by index.js (startPracticeRun / answerPracticeItem /
// awardPracticeAttemptPoints / claimDailyChest / rebuildLeaderboards /
// resetLeaderboardWindows / practiceJourney) and unit-tested by
// practice-game.test.js (`node practice-game.test.js`).
//
//   Points   — a run earns per CORRECT answer, weighted by difficulty;
//              finishing a run only pays a small bonus when at least one
//              answer was right. Before this a 1-question run paid 20 even
//              when wrong, so 20 speed-clicked runs out-earned 3 perfect ones.
//   Mastery  — per Cambridge chapter: Bronze → Silver → Gold → Crown.
//              The tier only ever goes up (earned stays earned).
//   Rematch  — a missed question comes back 1, 3 and 7 days later; three
//              right answers in a row on schedule clear it.
//   Leagues  — weekly cohorts of up to 30 students in the same stage band;
//              the top climbs a league, the bottom of a big cohort drops one.
//   Cup      — schools compete weekly in one featured subject.
//
// QUEST_VARIANTS + questHash MUST stay identical to Students Hub
// partials/quests.js — practice-game.test.js loads that file and compares.
// ═══════════════════════════════════════════════════════════════
"use strict";

const crypto = require("crypto");

// ── Points ──────────────────────────────────────────────────────
const PRACTICE_MIN_ITEMS = 5;
const DIFF_RANK = { easy: 0, medium: 1, hard: 2 };
const DIFF_BY_RANK = ["easy", "medium", "hard"];
const DIFF_MULT = { easy: 1, medium: 1.5, hard: 2 };
const PER_CORRECT = 5;
const REMATCH_MULT = 1.5;
const RUN_POINTS = {
  COMPLETION: 10,        // finished a run with at least one right answer
  DAILY_BASE: 50,        // the daily challenge (one per subject per day)
  TOURNAMENT_BASE: 75,   // reserved
  COMBO_3: 10,
  COMBO_5: 20,
  PERFECT: 30,           // every answer right, run of 5+
  BOSS: 15,              // beat the boss question
};
const MASTERY_BONUS = { 1: 10, 2: 25, 3: 50, 4: 100 };

function diffOf(d) { return Object.prototype.hasOwnProperty.call(DIFF_RANK, d) ? d : "medium"; }

function pointsForCorrect(difficulty, opts = {}) {
  return Math.round(PER_CORRECT * DIFF_MULT[diffOf(difficulty)] * (opts.rematch ? REMATCH_MULT : 1));
}

// Breakdown of what a finished run earns (before the daily-challenge
// first-of-day bonus and the daily cap, which need queries).
function runPoints(a) {
  const mode = a.mode || "practice";
  const total = Array.isArray(a.itemIds) ? a.itemIds.length : 0;
  const correct = Number(a.correctCount) || 0;
  const answered = Number(a.attemptedCount) || (Array.isArray(a.responses) ? a.responses.length : 0);
  const b = {
    base: 0,
    correct: a.earnedCorrectPts != null ? Number(a.earnedCorrectPts) || 0 : correct * PER_CORRECT,
    combo: 0, perfect: 0, boss: 0,
    mastery: Number(a.tierBonus) || 0,
  };
  if (mode === "daily_challenge") b.base = RUN_POINTS.DAILY_BASE;
  else if (mode === "tournament") b.base = RUN_POINTS.TOURNAMENT_BASE;
  else if (correct >= 1 && answered >= Math.min(PRACTICE_MIN_ITEMS, total)) b.base = RUN_POINTS.COMPLETION;
  const best = Number(a.streakBest) || 0;
  b.combo = best >= 5 ? RUN_POINTS.COMBO_5 : best >= 3 ? RUN_POINTS.COMBO_3 : 0;
  if (total >= PRACTICE_MIN_ITEMS && correct === total) b.perfect = RUN_POINTS.PERFECT;
  if (a.bossBeaten === true) b.boss = RUN_POINTS.BOSS;
  b.total = b.base + b.correct + b.combo + b.perfect + b.boss + b.mastery;
  return b;
}

// ── Dates (Jakarta day keys are passed in as YYYY-MM-DD) ─────────
function addDays(dayISO, n) {
  return new Date(Date.parse(dayISO + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
function weekKeyOf(dayISO) {                 // Monday of that week
  const dow = (new Date(dayISO + "T00:00:00Z").getUTCDay() + 6) % 7;
  return addDays(dayISO, -dow);
}

// ── Chapter mastery + rematch deck ──────────────────────────────
const MASTERY_TIERS = ["none", "bronze", "silver", "gold", "crown"];
const LAST_N = 10;
const REMATCH_INTERVALS = [1, 3, 7];
const MISSED_CAP = 150;

function chapterKey(subjectId, book, chapter) {
  const h = crypto.createHash("sha1").update(String(book || "Other") + "|" + String(chapter)).digest("hex").slice(0, 12);
  return String(subjectId || "x") + "~" + h;
}
function recentAccuracy(last) {
  const s = String(last || "");
  if (!s.length) return 0;
  let c = 0;
  for (const ch of s) if (ch === "1") c++;
  return c / s.length;
}
// 1 Bronze: 5 answers · 2 Silver: 12 answers, 60%+ of the last 10 ·
// 3 Gold: 20 answers, 80%+ of the last 10 · 4 Crown: Gold + 90%+ and 5 hard ones right.
function masteryTier(e) {
  const n = Number(e.n) || 0;
  const last = String(e.last || "");
  const acc = recentAccuracy(last);
  const full = last.length >= LAST_N;
  if (n >= 20 && full && acc >= 0.9 && (Number(e.hc) || 0) >= 5) return 4;
  if (n >= 20 && full && acc >= 0.8) return 3;
  if (n >= 12 && acc >= 0.6) return 2;
  if (n >= 5) return 1;
  return 0;
}
// What the student needs for the next tier, in plain words (journey map).
function nextTierHint(e) {
  const t = Number(e.tier) || 0;
  const n = Number(e.n) || 0;
  const acc = Math.round(recentAccuracy(e.last) * 100);
  if (t === 0) return `${Math.max(0, 5 - n)} more answers for Bronze`;
  if (t === 1) return n < 12 ? `${12 - n} more answers for Silver` : `Get 6 of your last 10 right for Silver (now ${acc}%)`;
  if (t === 2) return n < 20 ? `${20 - n} more answers for Gold` : `Get 8 of your last 10 right for Gold (now ${acc}%)`;
  if (t === 3) {
    const hc = Number(e.hc) || 0;
    return hc < 5 ? `${5 - hc} more hard questions right for the Crown` : `Get 9 of your last 10 right for the Crown (now ${acc}%)`;
  }
  return "Crown earned — this chapter is mastered";
}

// Apply one graded answer. Returns a NEW mastery object (input untouched)
// plus what happened, so the caller can tell the student.
function applyAnswer(mastery, item, isCorrect, today) {
  const src = mastery || {};
  const m = {
    chapters: Object.assign({}, src.chapters || {}),
    missed: Object.assign({}, src.missed || {}),
    rematchCleared: Number(src.rematchCleared) || 0,
  };
  const out = { tierUp: null, rematch: null, key: null };

  if (item.chapter) {
    const key = chapterKey(item.subjectId, item.book, item.chapter);
    const prev = m.chapters[key] || { subj: item.subjectId || null, book: item.book || "Other", chapter: item.chapter, n: 0, c: 0, hc: 0, last: "", tier: 0 };
    const e = Object.assign({}, prev, {
      n: (Number(prev.n) || 0) + 1,
      c: (Number(prev.c) || 0) + (isCorrect ? 1 : 0),
      hc: (Number(prev.hc) || 0) + (isCorrect && item.difficulty === "hard" ? 1 : 0),
      last: (String(prev.last || "") + (isCorrect ? "1" : "0")).slice(-LAST_N),
      at: today,
    });
    e.tier = Math.max(Number(prev.tier) || 0, masteryTier(e));
    if (e.tier > (Number(prev.tier) || 0)) {
      out.tierUp = { key, subj: e.subj, book: e.book, chapter: e.chapter, tier: e.tier, name: MASTERY_TIERS[e.tier], bonus: MASTERY_BONUS[e.tier] };
    }
    m.chapters[key] = e;
    out.key = key;
  }

  const miss = m.missed[item.id];
  if (!isCorrect) {
    m.missed[item.id] = { due: addDays(today, REMATCH_INTERVALS[0]), stage: 0, subj: item.subjectId || null, at: today };
    out.rematch = miss ? "reset" : "added";
  } else if (miss && miss.due <= today) {
    const stage = (Number(miss.stage) || 0) + 1;
    if (stage >= REMATCH_INTERVALS.length) {
      delete m.missed[item.id];
      m.rematchCleared++;
      out.rematch = "cleared";
    } else {
      m.missed[item.id] = Object.assign({}, miss, { stage, due: addDays(today, REMATCH_INTERVALS[stage]) });
      out.rematch = "advanced";
    }
  }
  const ids = Object.keys(m.missed);
  if (ids.length > MISSED_CAP) {
    ids.sort((a, b) => String(m.missed[a].at || "").localeCompare(String(m.missed[b].at || "")));
    for (const id of ids.slice(0, ids.length - MISSED_CAP)) delete m.missed[id];
  }
  return Object.assign({ mastery: m }, out);
}

function dueRematch(mastery, today, subjectId) {
  const missed = (mastery && mastery.missed) || {};
  return Object.keys(missed)
    .filter(id => missed[id].due <= today && (!subjectId || missed[id].subj === subjectId))
    .sort((a, b) => String(missed[a].due).localeCompare(String(missed[b].due)) || a.localeCompare(b));
}

// ── Daily quest twists (mirror of Students Hub partials/quests.js) ──
function questHash(str) {              // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const qsum = (a, f) => a.reduce((n, x) => n + (Number(f(x)) || 0), 0);
const longRun = (x) => (Array.isArray(x.itemIds) ? x.itemIds.length : 0) >= PRACTICE_MIN_ITEMS;
const QUEST_VARIANTS = [
  { id: "subject-math",    target: 1,  progress: (a) => a.filter(x => x.subjectId === "math").length },
  { id: "subject-english", target: 1,  progress: (a) => a.filter(x => x.subjectId === "english").length },
  { id: "subject-science", target: 1,  progress: (a) => a.filter(x => x.subjectId === "science").length },
  { id: "score-80",        target: 1,  progress: (a) => a.some(x => longRun(x) && Number(x.rawScorePct) >= 80) ? 1 : 0 },
  { id: "two-runs",        target: 2,  progress: (a) => a.length },
  { id: "combo-5",         target: 1,  progress: (a) => a.some(x => Number(x.streakBest) >= 5) ? 1 : 0 },
  { id: "boss-beaten",     target: 1,  progress: (a) => a.some(x => x.bossBeaten === true) ? 1 : 0 },
  { id: "hard-3",          target: 3,  progress: (a) => qsum(a, x => x.hardCorrect) },
  { id: "two-subjects",    target: 2,  progress: (a) => new Set(a.map(x => x.subjectId).filter(Boolean)).size },
  { id: "ten-correct",     target: 10, progress: (a) => qsum(a, x => x.correctCount) },
  { id: "chapter-run",     target: 1,  progress: (a) => a.some(x => !!x.chapter) ? 1 : 0 },
  { id: "three-runs",      target: 3,  progress: (a) => a.length },
  { id: "brave-run",       target: 1,  progress: (a) => a.some(x => x.difficulty === "medium" || x.difficulty === "hard") ? 1 : 0 },
  { id: "score-90",        target: 1,  progress: (a) => a.some(x => longRun(x) && Number(x.rawScorePct) >= 90) ? 1 : 0 },
  { id: "comeback",        target: 1,  progress: (a) => a.some(x => Number(x.comebacks) >= 1) ? 1 : 0 },
];
function pickQuestVariant(uid, dayISO) { return QUEST_VARIANTS[questHash(String(uid) + "|" + String(dayISO)) % QUEST_VARIANTS.length]; }
function questProgress(v, attempts) { return Math.min(v.target, v.progress(attempts || [])); }

// ── Weekly leagues ──────────────────────────────────────────────
const LEAGUES = ["bronze", "silver", "gold", "diamond", "legend"];
const COHORT_MAX = 30;
const MIN_PROMOTE_POINTS = 100;   // a lone student must still put in a real week to climb

function bandOf(grade) {
  const g = Number(grade);
  return g >= 11 ? "alevel" : g >= 9 ? "igcse" : "checkpoint";
}
function leagueOf(r) { return LEAGUES.includes(r && r.league) ? r.league : "bronze"; }
function promoteCount(size) { return size < 1 ? 0 : Math.min(5, Math.max(1, Math.round(size * 0.2))); }
function demoteCount(size) { return size >= 10 ? Math.min(5, Math.round(size * 0.15)) : 0; }

// rows: student_points docs ({id, weeklyPoints, league, leagueWeek, leagueCohort, gradeLevel}).
// A student joins a cohort the first time they score in a week, and keeps it all week.
function assignCohorts(rows, weekKey) {
  const cohorts = {};
  const assign = [];
  const active = rows.filter(r => (Number(r.weeklyPoints) || 0) > 0);
  const placed = (r) => r.leagueWeek === weekKey && typeof r.leagueCohort === "string" && r.leagueCohort.startsWith(weekKey + "_");
  for (const r of active) if (placed(r)) (cohorts[r.leagueCohort] = cohorts[r.leagueCohort] || []).push(r);
  const joiners = active.filter(r => !placed(r)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const r of joiners) {
    const lg = leagueOf(r);
    const prefix = `${weekKey}_${lg}_${bandOf(r.gradeLevel)}_`;
    let k = 1;
    while ((cohorts[prefix + k] || []).length >= COHORT_MAX) k++;
    const id = prefix + k;
    (cohorts[id] = cohorts[id] || []).push(r);
    assign.push({ uid: r.id, cohortId: id, league: lg });
  }
  return { cohorts, assign };
}
function cohortMeta(cohortId) {
  const [weekKey, league, band] = String(cohortId).split("_");
  return { weekKey, league, band };
}
// End-of-week result for one cohort.
function resolveCohort(list) {
  const sorted = [...list].sort((a, b) => (Number(b.weeklyPoints) || 0) - (Number(a.weeklyPoints) || 0) || String(a.id).localeCompare(String(b.id)));
  const size = sorted.length;
  const up = promoteCount(size);
  const down = demoteCount(size);
  return sorted.map((r, i) => {
    const from = leagueOf(r);
    const li = LEAGUES.indexOf(from);
    let to = from;
    let outcome = "stayed";
    if (i < up && li < LEAGUES.length - 1 && (Number(r.weeklyPoints) || 0) >= MIN_PROMOTE_POINTS) { to = LEAGUES[li + 1]; outcome = "promoted"; }
    else if (i >= size - down && li > 0) { to = LEAGUES[li - 1]; outcome = "demoted"; }
    return { uid: r.id, rank: i + 1, size, from, to, outcome, weeklyPoints: Number(r.weeklyPoints) || 0 };
  });
}

// ── School Cup (weekly, one featured subject) ───────────────────
const CUP_SUBJECTS = ["math", "english", "science"];
const CUP_MIN_DIVISOR = 5;   // per-student average, but a school of 1 can't top it on one student
function cupSubject(weekKey) {
  const n = Math.floor(Date.parse(weekKey + "T00:00:00Z") / (7 * 86400000));
  return CUP_SUBJECTS[((n % 3) + 3) % 3];
}
function schoolCup(rows, subject) {
  const by = {};
  for (const r of rows) {
    if (!r.schoolId || !((Number(r.weeklyPoints) || 0) > 0)) continue;
    const s = by[r.schoolId] = by[r.schoolId] || { schoolId: r.schoolId, schoolName: r.schoolName || null, total: 0, active: 0, players: [] };
    const p = Number((r.weeklyBySubject || {})[subject]) || 0;
    s.active++;
    s.total += p;
    if (!s.schoolName && r.schoolName) s.schoolName = r.schoolName;
    if (p > 0) s.players.push({ displayName: r.displayName || "Student", points: p, mascotId: r.mascotId || null, level: r.level || 1 });
  }
  return Object.values(by)
    .map(s => Object.assign({}, s, {
      score: Math.round(s.total / Math.max(CUP_MIN_DIVISOR, s.active)),
      players: s.players.sort((a, b) => b.points - a.points).slice(0, 3),
    }))
    .sort((a, b) => b.score - a.score || b.total - a.total)
    .map((s, i) => Object.assign({ rank: i + 1 }, s));
}

module.exports = {
  PRACTICE_MIN_ITEMS, DIFF_RANK, DIFF_BY_RANK, DIFF_MULT, PER_CORRECT, REMATCH_MULT, RUN_POINTS, MASTERY_BONUS,
  diffOf, pointsForCorrect, runPoints, addDays, weekKeyOf,
  MASTERY_TIERS, REMATCH_INTERVALS, chapterKey, masteryTier, nextTierHint, applyAnswer, dueRematch,
  questHash, QUEST_VARIANTS, pickQuestVariant, questProgress,
  LEAGUES, COHORT_MAX, MIN_PROMOTE_POINTS, bandOf, leagueOf, promoteCount, demoteCount, assignCohorts, cohortMeta, resolveCohort,
  CUP_SUBJECTS, cupSubject, schoolCup,
};
