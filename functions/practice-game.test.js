// Unit tests for practice-game.js — run: node practice-game.test.js (from Central Hub/functions).
// Also checks the Students Hub quest mirror (partials/quests.js) against the server variants.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const G = require("./practice-game.js");

let passed = 0;
function test(name, fn) { fn(); passed++; }

// ── Points ──
test("difficulty multiplier", () => {
  assert.strictEqual(G.pointsForCorrect("easy"), 5);
  assert.strictEqual(G.pointsForCorrect("medium"), 8);
  assert.strictEqual(G.pointsForCorrect("hard"), 10);
  assert.strictEqual(G.pointsForCorrect("hard", { rematch: true }), 15);
  assert.strictEqual(G.pointsForCorrect(undefined), 8);
});
test("a wrong 1-question run earns nothing (the old exploit)", () => {
  const b = G.runPoints({ mode: "practice", itemIds: ["a"], correctCount: 0, attemptedCount: 1, earnedCorrectPts: 0 });
  assert.strictEqual(b.total, 0);
});
test("20 speed-clicked wrong runs earn less than one honest run", () => {
  const junk = G.runPoints({ mode: "practice", itemIds: ["a", "b", "c", "d", "e"], correctCount: 1, attemptedCount: 5, earnedCorrectPts: 5, streakBest: 1 }).total;
  const honest = G.runPoints({ mode: "practice", itemIds: Array(10).fill("x"), correctCount: 10, attemptedCount: 10, earnedCorrectPts: 80, streakBest: 10, bossBeaten: true }).total;
  assert.ok(honest > junk * 5, `honest ${honest} vs junk ${junk}`);
});
test("perfect needs 5+ items; boss + mastery add up", () => {
  const b = G.runPoints({ mode: "practice", itemIds: Array(10).fill("x"), correctCount: 10, attemptedCount: 10, earnedCorrectPts: 70, streakBest: 10, bossBeaten: true, tierBonus: 25 });
  assert.deepStrictEqual([b.base, b.correct, b.combo, b.perfect, b.boss, b.mastery, b.total], [10, 70, 20, 30, 15, 25, 170]);
  assert.strictEqual(G.runPoints({ mode: "practice", itemIds: ["a", "b"], correctCount: 2, attemptedCount: 2, earnedCorrectPts: 10 }).perfect, 0);
});
test("legacy attempts without earnedCorrectPts fall back to 5 per correct", () => {
  assert.strictEqual(G.runPoints({ mode: "practice", itemIds: Array(5).fill("x"), correctCount: 3, attemptedCount: 5 }).correct, 15);
});
test("daily challenge keeps its 50 base", () => {
  assert.strictEqual(G.runPoints({ mode: "daily_challenge", itemIds: Array(5).fill("x"), correctCount: 0, attemptedCount: 5, earnedCorrectPts: 0 }).base, 50);
});

// ── Dates ──
test("week key is the Monday", () => {
  assert.strictEqual(G.weekKeyOf("2026-10-04"), "2026-09-28"); // Sunday
  assert.strictEqual(G.weekKeyOf("2026-10-05"), "2026-10-05"); // Monday
  assert.strictEqual(G.addDays("2026-12-31", 1), "2027-01-01");
});

// ── Mastery ──
const item = (id, d, extra) => Object.assign({ id, subjectId: "math", book: "Stage 8", chapter: "3. Fractions", difficulty: d }, extra || {});
test("tiers climb bronze → silver → gold → crown and never drop", () => {
  let m = {};
  const ups = [];
  const feed = (n, correct, d) => { for (let i = 0; i < n; i++) { const r = G.applyAnswer(m, item("q" + Math.random(), d), correct, "2026-10-04"); m = r.mastery; if (r.tierUp) ups.push(r.tierUp.name); } };
  feed(5, false, "easy");                       // 5 answers, all wrong → bronze
  assert.deepStrictEqual(ups, ["bronze"]);
  feed(7, true, "easy");                        // 12 answers, last 10 = 7/10 → silver
  assert.deepStrictEqual(ups, ["bronze", "silver"]);
  feed(8, true, "medium");                      // 20 answers, last 10 = 10/10 → gold
  assert.deepStrictEqual(ups, ["bronze", "silver", "gold"]);
  feed(5, true, "hard");                        // 5 hard right, 90%+ → crown
  assert.deepStrictEqual(ups, ["bronze", "silver", "gold", "crown"]);
  feed(10, false, "easy");                      // a bad day does not take the crown away
  const e = Object.values(m.chapters)[0];
  assert.strictEqual(e.tier, 4);
  assert.strictEqual(e.last, "0000000000");
});
test("items without a chapter skip mastery but still enter the rematch deck", () => {
  const r = G.applyAnswer({}, { id: "x1", subjectId: "english", difficulty: "easy" }, false, "2026-10-04");
  assert.strictEqual(r.key, null);
  assert.strictEqual(r.mastery.missed.x1.due, "2026-10-05");
});
test("applyAnswer does not mutate its input", () => {
  const m0 = { chapters: {}, missed: {} };
  G.applyAnswer(m0, item("a", "easy"), false, "2026-10-04");
  assert.deepStrictEqual(m0, { chapters: {}, missed: {} });
});

// ── Rematch ──
test("missed question returns after 1, 3 and 7 days, then clears", () => {
  let m = G.applyAnswer({}, item("q1", "easy"), false, "2026-10-04").mastery;
  assert.deepStrictEqual(G.dueRematch(m, "2026-10-04"), []);
  assert.deepStrictEqual(G.dueRematch(m, "2026-10-05"), ["q1"]);
  let r = G.applyAnswer(m, item("q1", "easy"), true, "2026-10-04");      // right too early: no progress
  assert.strictEqual(r.rematch, null);
  r = G.applyAnswer(m, item("q1", "easy"), true, "2026-10-05"); m = r.mastery;
  assert.strictEqual(r.rematch, "advanced"); assert.strictEqual(m.missed.q1.due, "2026-10-08");
  r = G.applyAnswer(m, item("q1", "easy"), true, "2026-10-08"); m = r.mastery;
  assert.strictEqual(m.missed.q1.due, "2026-10-15");
  r = G.applyAnswer(m, item("q1", "easy"), true, "2026-10-15"); m = r.mastery;
  assert.strictEqual(r.rematch, "cleared"); assert.strictEqual(m.missed.q1, undefined); assert.strictEqual(m.rematchCleared, 1);
});
test("missing it again resets the schedule", () => {
  let m = G.applyAnswer({}, item("q1", "easy"), false, "2026-10-04").mastery;
  m = G.applyAnswer(m, item("q1", "easy"), true, "2026-10-05").mastery;
  const r = G.applyAnswer(m, item("q1", "easy"), false, "2026-10-08");
  assert.strictEqual(r.rematch, "reset");
  assert.deepStrictEqual([r.mastery.missed.q1.stage, r.mastery.missed.q1.due], [0, "2026-10-09"]);
});
test("rematch deck is capped at 150", () => {
  let m = {};
  for (let i = 0; i < 170; i++) m = G.applyAnswer(m, { id: "z" + i, subjectId: "math" }, false, G.addDays("2026-01-01", i)).mastery;
  assert.strictEqual(Object.keys(m.missed).length, 150);
  assert.ok(!m.missed.z0 && m.missed.z169);
});

// ── Leagues ──
const row = (id, pts, extra) => Object.assign({ id, weeklyPoints: pts, gradeLevel: 8, league: "bronze" }, extra || {});
test("cohorts fill to 30, split by band, keep members all week", () => {
  const rows = [];
  for (let i = 0; i < 65; i++) rows.push(row("s" + String(i).padStart(3, "0"), 10));
  rows.push(row("a1", 10, { gradeLevel: 11 }));
  rows.push(row("idle", 0));
  const { cohorts, assign } = G.assignCohorts(rows, "2026-09-28");
  const sizes = Object.entries(cohorts).map(([k, v]) => k + ":" + v.length).sort();
  assert.deepStrictEqual(sizes, ["2026-09-28_bronze_alevel_1:1", "2026-09-28_bronze_checkpoint_1:30", "2026-09-28_bronze_checkpoint_2:30", "2026-09-28_bronze_checkpoint_3:5"]);
  assert.strictEqual(assign.length, 66);
  // next hour: everyone already placed keeps the cohort, a late joiner fills the open one
  const placed = rows.filter(r => r.weeklyPoints > 0).map(r => Object.assign({}, r, { leagueWeek: "2026-09-28", leagueCohort: assign.find(a => a.uid === r.id).cohortId }));
  const again = G.assignCohorts(placed.concat([row("late", 5)]), "2026-09-28");
  assert.deepStrictEqual(again.assign, [{ uid: "late", cohortId: "2026-09-28_bronze_checkpoint_3", league: "bronze" }]);
  // a stale cohort from last week is ignored
  const stale = G.assignCohorts([row("old", 5, { leagueWeek: "2026-09-21", leagueCohort: "2026-09-21_bronze_checkpoint_1" })], "2026-09-28");
  assert.strictEqual(stale.assign[0].cohortId, "2026-09-28_bronze_checkpoint_1");
});
test("promotion and relegation", () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(row("p" + i, 1000 - i * 40, { league: "silver" }));
  const res = G.resolveCohort(list);
  assert.deepStrictEqual(res.filter(r => r.outcome === "promoted").map(r => r.uid), ["p0", "p1", "p2", "p3"]);
  assert.deepStrictEqual(res.filter(r => r.outcome === "demoted").map(r => r.uid), ["p17", "p18", "p19"]);
  assert.ok(res.filter(r => r.outcome === "promoted").every(r => r.to === "gold"));
  assert.strictEqual(G.resolveCohort([row("solo", 50)])[0].outcome, "stayed");           // below the 100-point floor
  assert.strictEqual(G.resolveCohort([row("solo", 150)])[0].to, "silver");
  assert.strictEqual(G.resolveCohort([row("top", 5000, { league: "legend" })])[0].outcome, "stayed");
  const bronze = []; for (let i = 0; i < 12; i++) bronze.push(row("b" + i, 500 - i));
  assert.ok(G.resolveCohort(bronze).every(r => r.outcome !== "demoted"));                // nothing below bronze
});

// ── Cup ──
test("school cup averages per active student with a floor of 5", () => {
  const rows = [
    row("x1", 100, { schoolId: "A", schoolName: "A", weeklyBySubject: { science: 300 } }),
    row("y1", 100, { schoolId: "B", schoolName: "B", weeklyBySubject: { science: 100 } }),
    row("y2", 100, { schoolId: "B", weeklyBySubject: { science: 100 } }),
    row("y3", 100, { schoolId: "B", weeklyBySubject: { science: 100 } }),
    row("y4", 100, { schoolId: "B", weeklyBySubject: { science: 100 } }),
    row("y5", 100, { schoolId: "B", weeklyBySubject: { science: 100 } }),
    row("y6", 100, { schoolId: "B", weeklyBySubject: { math: 900 } }),
  ];
  const cup = G.schoolCup(rows, "science");
  assert.deepStrictEqual(cup.map(s => [s.schoolId, s.score, s.active]), [["B", 83, 6], ["A", 60, 1]]);
  assert.strictEqual(cup[0].players.length, 3);
  assert.ok(G.CUP_SUBJECTS.includes(G.cupSubject("2026-09-28")));
  assert.notStrictEqual(G.cupSubject("2026-09-28"), G.cupSubject("2026-10-05"));
});

// ── Quest mirror ──
test("client quests.js matches the server variants", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../Students Hub/partials/quests.js"), "utf8");
  const ctx = { globalThis: {} };
  ctx.window = ctx.globalThis;
  vm.runInNewContext(src, ctx);
  const C = ctx.globalThis.SH_QUESTS;
  assert.strictEqual(C.variants.map(v => v.id).join(), G.QUEST_VARIANTS.map(v => v.id).join());
  assert.strictEqual(C.variants.map(v => v.target).join(), G.QUEST_VARIANTS.map(v => v.target).join());
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const subj = ["math", "english", "science", null];
  const diff = ["easy", "medium", "hard", null];
  for (let t = 0; t < 6000; t++) {
    const uid = "u" + rnd(100000);
    const day = G.addDays("2026-01-01", rnd(700));
    assert.strictEqual(C.pick(uid, day).id, G.pickQuestVariant(uid, day).id);
    const attempts = [];
    for (let k = rnd(4); k > 0; k--) {
      attempts.push({
        subjectId: subj[rnd(4)], difficulty: diff[rnd(4)], itemIds: Array(1 + rnd(12)).fill("i"),
        rawScorePct: rnd(101), streakBest: rnd(8), bossBeaten: rnd(3) === 0, hardCorrect: rnd(4),
        correctCount: rnd(10), chapter: rnd(2) ? "1. Integers" : null, comebacks: rnd(3),
      });
    }
    for (let i = 0; i < G.QUEST_VARIANTS.length; i++) {
      assert.strictEqual(C.progress(C.variants[i], attempts), G.questProgress(G.QUEST_VARIANTS[i], attempts), C.variants[i].id);
    }
  }
});

console.log(`practice-game: ${passed} tests passed`);
