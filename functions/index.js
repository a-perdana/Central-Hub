/**
 * Cloud Functions — centralhub-8727b
 *
 * Induction-module (Phase 5, 2026-05-04):
 *   1. onPulseWritten                   — fires alarm on 2 consecutive low scores
 *   2. onJournalWritten                 — maintains anonymous induction_journal_aggregates
 *   3. expireMentorCerts                — daily cron, sets active=false on expired certs
 *
 * Principal Evaluation Module (Phase-2, 2026-05-09):
 *   4. aggregatePrincipal360Responses   — recompute principal_360_aggregates/{cycleId}
 *                                         on every response write. Charter NN5:
 *                                         threshold-gated cohort visibility, no
 *                                         respondent uid in any output.
 *
 * EASE Bank Proxy (2026-05-11):
 *   N. easeBankProxy                    — httpsCallable proxy to latihan.id
 *                                         question-bank API. Bearer token in
 *                                         Secret Manager (LATIHAN_API_TOKEN);
 *                                         CH admin / director / coordinator only.
 *
 * Deploy:
 *   cd "Central Hub/functions" && npm install
 *   cd ..
 *   firebase deploy --only functions --project centralhub-8727b
 *
 * Requires Blaze billing plan (Spark plan does not allow Cloud Functions).
 */

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule }        = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError }= require("firebase-functions/v2/https");
const { defineSecret }      = require("firebase-functions/params");
const { setGlobalOptions }  = require("firebase-functions/v2");
const admin                 = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: "asia-southeast1", maxInstances: 10 });

// ───────────────────────────────────────────────────────────────
// 1. PULSE ALARM — onPulseWritten
//    On every induction_pulses write, check if mentee has recorded
//    score <= 2 in this week AND the previous week. If so, write a
//    notification doc that the mentor + school leader can read.
// ───────────────────────────────────────────────────────────────
exports.onPulseWritten = onDocumentWritten(
  {
    document: "induction_pulses/{pulseId}",
    region: "asia-southeast1",
  },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return;                       // delete event — ignore
    if (after.score == null || after.score > 2) return;

    const uid = after.uid;
    if (!uid) return;

    // Look up the previous pulse for this user (excluding this week).
    const thisWeek = after.weekStartDate;
    const prevSnap = await db.collection("induction_pulses")
      .where("uid", "==", uid)
      .where("weekStartDate", "<", thisWeek)
      .orderBy("weekStartDate", "desc")
      .limit(1)
      .get();

    if (prevSnap.empty) return;               // first pulse — no alarm
    const prev = prevSnap.docs[0].data();
    if (prev.score == null || prev.score > 2) return;

    // Two consecutive lows → fire alarm.
    const assignSnap = await db.collection("induction_assignments")
      .doc(uid)
      .get();
    if (!assignSnap.exists) return;
    const assignment = assignSnap.data();

    const alarmId = `${uid}_${thisWeek}`;
    await db.collection("induction_alarms").doc(alarmId).set({
      uid,
      mentorUid: assignment.mentorUid,
      schoolLeaderUid: assignment.schoolLeaderUid,
      schoolId: assignment.schoolId,
      weekStartDate: after.weekStartDate,
      kind: "two_consecutive_low_pulse",
      currentScore: after.score,
      previousScore: prev.score,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      acknowledged: false,
    }, { merge: true });

    console.log(`[pulse-alarm] ${uid} two-week low (${prev.score} → ${after.score})`);
  }
);

// ───────────────────────────────────────────────────────────────
// 2. JOURNAL AGGREGATOR — onJournalWritten
//    On every induction_journal write, increment the anonymous
//    aggregate counter for (programId, stageId, isoWeek). HQ reads
//    this collection without ever touching named entries (Charter NN2).
// ───────────────────────────────────────────────────────────────
exports.onJournalWritten = onDocumentWritten(
  {
    document: "induction_journal/{entryId}",
    region: "asia-southeast1",
  },
  async (event) => {
    const after = event.data?.after?.data();
    const before = event.data?.before?.data();
    if (!after && !before) return;

    const data = after || before;
    const programId = data.programId || "unknown";
    const stageId   = data.stageId   || "unknown";
    const entryDate = (data.entryDate?.toDate
      ? data.entryDate.toDate()
      : new Date(data.entryDate || Date.now()));
    const isoWeek = isoWeekStart(entryDate);

    const aggId = `${programId}_${stageId}_${isoWeek}`;
    const aggRef = db.collection("induction_journal_aggregates").doc(aggId);

    // We re-derive totals on a small window each time. Cheaper than
    // maintaining incremental counters that can drift.
    const weekEnd = new Date(isoWeek);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const entriesSnap = await db.collection("induction_journal")
      .where("programId", "==", programId)
      .where("stageId",   "==", stageId)
      .where("entryDate", ">=", new Date(isoWeek))
      .where("entryDate", "<",  weekEnd)
      .get();

    const uniqueMentees = new Set();
    entriesSnap.docs.forEach((d) => uniqueMentees.add(d.data().uid));
    const totalEntries  = entriesSnap.size;
    const menteeCount   = uniqueMentees.size;

    // Total mentees in this (programId, stageId) — denominator.
    const assignSnap = await db.collection("induction_assignments")
      .where("programId",     "==", programId)
      .where("currentStageId","==", stageId)
      .get();
    const totalMentees = assignSnap.size;

    await aggRef.set({
      programId,
      stageId,
      isoWeek,
      totalMentees,
      menteesWithJournalEntryThisWeek: menteeCount,
      averageEntriesPerMentee: menteeCount === 0 ? 0 : totalEntries / menteeCount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
);

// ───────────────────────────────────────────────────────────────
// 3. CERT EXPIRY SWEEPER — daily cron
//    Sets active=false on any mentor_certifications doc whose
//    validUntil is in the past. Runs once per day at 02:00 WIB.
// ───────────────────────────────────────────────────────────────
exports.expireMentorCerts = onSchedule(
  {
    schedule: "0 2 * * *",
    timeZone: "Asia/Jakarta",
    region: "asia-southeast1",
  },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const expiredSnap = await db.collection("mentor_certifications")
      .where("active",     "==", true)
      .where("validUntil", "<",  now)
      .limit(500)
      .get();

    if (expiredSnap.empty) {
      console.log("[cert-sweep] no expired certifications");
      return;
    }

    const batch = db.batch();
    expiredSnap.docs.forEach((doc) => {
      batch.update(doc.ref, {
        active: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        expiredBySweep: true,
      });
    });
    await batch.commit();
    console.log(`[cert-sweep] expired ${expiredSnap.size} certifications`);
  }
);

// ───────────────────────────────────────────────────────────────
// 4. PRINCIPAL 360° AGGREGATOR — aggregatePrincipal360Responses
//    On every principal_360_responses write, recompute the matching
//    principal_360_aggregates/{cycleId} doc:
//      - per-cohort respondentCount + perFocusMean (P1..P8) + narrativesCount
//      - aboveThreshold[c] = (respondentCount >= COHORT_THRESHOLD)  (Charter NN5)
//      - composite.F3_360_score: weighted across ABOVE-THRESHOLD cohorts only.
//        Below-threshold cohort weight is redistributed proportionally to the
//        remaining cohorts (per framework data_aggregation_rules).
//    No respondent uid is read or persisted — the trigger only sees the doc
//    that was just written + the rest of the cohort.
//
//    Source framework: docs/cross-module/principal-360-framework-v1.json
// ───────────────────────────────────────────────────────────────
const FOCUS_KEYS       = ["P1","P2","P3","P4","P5","P6","P7","P8"];
const COHORT_THRESHOLD = 5;          // min_respondents_to_report
const COHORT_WEIGHTS   = { staff: 0.60, parent: 0.25, student: 0.15 };

exports.aggregatePrincipal360Responses = onDocumentWritten(
  {
    document: "principal_360_responses/{respId}",
    region: "asia-southeast1",
  },
  async (event) => {
    const after  = event.data?.after?.data();
    const before = event.data?.before?.data();
    const data   = after || before;
    if (!data) return;

    const cycleId = data.cycleId;
    if (!cycleId) {
      console.warn("[360-agg] response missing cycleId; skipping", event.params);
      return;
    }

    // Load cycle for principalUid + schoolId denormalisation on the aggregate.
    const cycleSnap = await db.collection("principal_360_cycles").doc(cycleId).get();
    if (!cycleSnap.exists) {
      console.warn(`[360-agg] cycle ${cycleId} not found; skipping`);
      return;
    }
    const cycle = cycleSnap.data();

    // Pull every response for this cycle. Bounded by the school's eligible
    // pool (typically < 200), so a full re-derive each write is cheaper than
    // maintaining incremental counters that can drift.
    const respSnap = await db.collection("principal_360_responses")
      .where("cycleId", "==", cycleId)
      .get();

    const cohortStats = { staff: blank(), parent: blank(), student: blank() };

    respSnap.docs.forEach((d) => {
      const r = d.data();
      const c = r.cohort;
      if (!cohortStats[c]) return;     // unknown cohort — defensive
      const stats = cohortStats[c];
      stats.respondentCount++;

      // Tally narratives (any non-empty narrative field counts as one).
      if (r.narratives && Object.values(r.narratives).some((v) => (v || "").toString().trim().length > 0)) {
        stats.narrativesCount++;
      }

      // Tally per-question scores grouped by focus.
      // Question id format: "P1-Q-S1" / "P3-Q-T2" / etc — first 2 chars = focus.
      const responses = r.responses || {};
      Object.keys(responses).forEach((qId) => {
        const v = responses[qId];
        // Charter NN5: 0 = "Cannot Comment / Not Observed" — explicitly excluded.
        if (typeof v !== "number" || v <= 0 || v > 4) return;
        const focus = (qId || "").slice(0, 2).toUpperCase();
        if (!FOCUS_KEYS.includes(focus)) return;
        if (!stats._focusSum)   stats._focusSum   = {};
        if (!stats._focusCount) stats._focusCount = {};
        stats._focusSum[focus]   = (stats._focusSum[focus]   || 0) + v;
        stats._focusCount[focus] = (stats._focusCount[focus] || 0) + 1;
      });
    });

    // Convert sums → means; drop the working _focus* fields from the persisted
    // doc so we never expose raw count/sum (NN5 — only the mean is observable).
    const aboveThreshold = {};
    Object.keys(cohortStats).forEach((c) => {
      const s = cohortStats[c];
      const mean = {};
      FOCUS_KEYS.forEach((k) => {
        const sum = s._focusSum?.[k];
        const cnt = s._focusCount?.[k];
        if (cnt > 0) mean[k] = sum / cnt;
      });
      s.perFocusMean = mean;
      delete s._focusSum;
      delete s._focusCount;
      aboveThreshold[c] = s.respondentCount >= COHORT_THRESHOLD;
    });

    // F3 composite — weighted across ABOVE-threshold cohorts only.
    // Per framework: "If a cohort has < 5 respondents, redistribute its
    // weight proportionally to the remaining cohorts."
    let weightSum = 0;
    Object.keys(COHORT_WEIGHTS).forEach((c) => {
      if (aboveThreshold[c]) weightSum += COHORT_WEIGHTS[c];
    });
    let f3 = null;
    if (weightSum > 0) {
      let acc = 0;
      Object.keys(COHORT_WEIGHTS).forEach((c) => {
        if (!aboveThreshold[c]) return;
        const focusMeans = cohortStats[c].perFocusMean;
        const vals = FOCUS_KEYS.map((k) => focusMeans[k]).filter((v) => typeof v === "number");
        if (vals.length === 0) return;
        const cohortMean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const w = COHORT_WEIGHTS[c] / weightSum;            // normalised
        acc += cohortMean * w;
      });
      f3 = round2(acc);
    }

    const aggDoc = {
      cycleId,
      principalUid: cycle.principalUid || null,
      schoolId:     cycle.schoolId     || null,
      cohortStats,
      aboveThreshold,
      composite: { F3_360_score: f3 },
      lastAggregatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("principal_360_aggregates").doc(cycleId).set(aggDoc, { merge: true });
    console.log(`[360-agg] cycle=${cycleId} totals s=${cohortStats.staff.respondentCount} p=${cohortStats.parent.respondentCount} t=${cohortStats.student.respondentCount} F3=${f3}`);
  }
);

function blank() {
  return { respondentCount: 0, narrativesCount: 0, perFocusMean: {} };
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ───────────────────────────────────────────────────────────────
// 5. CHAPTER MASTERY AGGREGATE — onChapterAttemptWritten
//    On every chapter_test_attempts write where status flips into
//    'scored' / 'submitted' / 'flagged' (i.e. a real result exists),
//    recompute chapter_mastery/{studentUid}_{subjectId}_{unitCode}.
//
//    The aggregate doc holds the LATEST attempt's score so pacing
//    dashboards + class-assessment heatmaps can read mastery
//    without re-scanning attempts. Same student retaking a chapter
//    overwrites the prior result (attemptsCount increments).
//
//    Doc id pattern: {studentUid}_{subjectId}_{unitCode}.
//    Sanitised to firestore-safe slug (lowercase, non-alphanumeric → -).
// ───────────────────────────────────────────────────────────────
const MASTERY_STATUSES = new Set(["scored", "submitted", "flagged"]);

exports.onChapterAttemptWritten = onDocumentWritten(
  {
    document: "chapter_test_attempts/{attemptId}",
    region: "asia-southeast1",
  },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return; // delete
    if (!MASTERY_STATUSES.has(after.status)) return; // still in_progress / draft / cancelled

    const beforeStatus = event.data?.before?.data()?.status;
    if (MASTERY_STATUSES.has(beforeStatus) && beforeStatus === after.status &&
        event.data?.before?.data()?.rawScorePct === after.rawScorePct) {
      return; // no score change → nothing to recompute
    }

    const studentUid = after.studentUid;
    const testId     = after.testId || "";
    const subjectId  = (testId.split("_")[0] || "unknown").toLowerCase();
    const unitCode   = inferUnitCode(testId) || "unknown";
    if (!studentUid) return;

    const masteryId = slug(`${studentUid}_${subjectId}_${unitCode}`);
    const ref = db.collection("chapter_mastery").doc(masteryId);
    const prior = (await ref.get()).data() || {};

    const rawScorePct = typeof after.rawScorePct === "number" ? after.rawScorePct : null;
    const passed      = after.passed === true;
    const masteryLevel = bandFor(rawScorePct);

    const payload = {
      studentUid,
      subjectId,
      unitCode,
      testId,
      testTitle: after.testTitle || null,
      schoolId: after.schoolId || null,
      classId: after.classId || null,
      className: after.className || null,
      latestAttemptId: event.params.attemptId,
      scorePct: rawScorePct,
      passed,
      masteryLevel,
      attemptsCount: (prior.attemptsCount || 0) + 1,
      lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (!prior.firstAttemptAt) payload.firstAttemptAt = admin.firestore.FieldValue.serverTimestamp();

    await ref.set(payload, { merge: true });
    console.log(`[chapter-mastery] ${masteryId} ← ${rawScorePct}% (${masteryLevel})`);
  }
);

function bandFor(pct) {
  if (typeof pct !== "number") return null;
  if (pct < 40)  return "emerging";
  if (pct < 60)  return "developing";
  if (pct < 80)  return "secure";
  return "exceeding";
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_]/g, "-");
}
function inferUnitCode(testId) {
  // testId pattern: {subject}_{year}_{unitCode}_v{n}, lowercased+slugged.
  // e.g. math_7_7ni-01_v1 → unit "7ni-01"
  const parts = String(testId).split("_");
  if (parts.length < 4) return null;
  // Drop leading subject + year, drop trailing version, rejoin remainder.
  return parts.slice(2, -1).join("_");
}

// ═══════════════════════════════════════════════════════════════
// GAMIFICATION (Students Hub, 2026-05-11)
// ═══════════════════════════════════════════════════════════════
// Three triggers + one daily schedule:
//   5. awardChapterTestPoints   — on chapter_test_attempts write
//   6. awardEaseSessionPoints   — on ease_sessions write
//   7. rebuildLeaderboards      — scheduled hourly, regenerates
//                                 school_leaderboards/{board} aggregates
//   8. resetLeaderboardWindows  — scheduled daily, resets weekly + monthly
//                                 buckets on student_points
//
// Writes are constrained to student_points/{uid} and
// school_leaderboards/{board}. Both collections are RULE-LOCKED for
// client writes — only admin SDK (these functions) can write.
//
// Schema host: docs/FIRESTORE_SCHEMA.md §20.
// Award rules table also documented there.
// ═══════════════════════════════════════════════════════════════

const POINTS = {
  CHAPTER_BASE: 50,
  CHAPTER_FIRST_ATTEMPT_BONUS: 25,
  CHAPTER_PERFECT_BONUS: 50,           // 100% score
  EASE_BASE: 100,
  EASE_GROWTH_POSITIVE_BONUS: 25,      // growthVsPrev >= 0
  EASE_GROWTH_STRONG_BONUS: 50,        // growthVsPrev >= 5
  STREAK_MILESTONE_7:   100,
  STREAK_MILESTONE_30:  250,
};

function levelXpRequired(level) {
  return 100 + (level - 1) * 50;
}
function computeLevelFromTotalXp(totalXp) {
  let level = 1;
  let remaining = totalXp;
  while (level < 100) {
    const req = levelXpRequired(level);
    if (remaining < req) return { level, xpInLevel: remaining, xpRequired: req, progress: Math.round((remaining/req)*100) };
    remaining -= req;
    level++;
  }
  return { level: 100, xpInLevel: 0, xpRequired: levelXpRequired(100), progress: 100 };
}

// Build the denormalised identity payload from a students/{uid} doc.
async function loadStudentIdentity(studentUid) {
  const snap = await db.collection("students").doc(studentUid).get();
  if (!snap.exists) return null;
  const s = snap.data();
  return {
    studentUid,
    displayName:  s.displayName || (s.email ? s.email.split("@")[0] : "Student"),
    photoURL:     s.photoURL || null,
    schoolId:     s.schoolId || null,
    schoolName:   s.school || null,
    classId:      s.classId || null,
    className:    s.className || null,
    gradeLevel:   s.gradeLevel || null,
  };
}

// Award points + recompute level / streak. Always merges; safe to re-run.
// reason: short slug for audit (used to skip duplicate awards if needed).
async function awardPoints(studentUid, points, opts = {}) {
  if (!studentUid || !points) return;
  const ref = db.collection("student_points").doc(studentUid);
  const identity = await loadStudentIdentity(studentUid);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur  = snap.exists ? snap.data() : {};
    const totalPoints   = (cur.totalPoints   || 0) + points;
    const weeklyPoints  = (cur.weeklyPoints  || 0) + points;
    const monthlyPoints = (cur.monthlyPoints || 0) + points;

    // Level is derived from totalPoints (1 point = 1 XP).
    const lvl = computeLevelFromTotalXp(totalPoints);

    // Streak: bump if a new calendar day since lastDayISO.
    const today = new Date().toISOString().slice(0, 10);
    const prevDay = cur.streak?.lastDayISO;
    let streak = cur.streak || { current: 0, longest: 0, lastDayISO: null };
    if (prevDay !== today) {
      // Was the last day exactly yesterday?
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const currentStreak = (prevDay === yesterday) ? (streak.current || 0) + 1 : 1;
      streak = {
        current: currentStreak,
        longest: Math.max(currentStreak, streak.longest || 0),
        lastDayISO: today,
      };
    }

    const update = {
      ...identity,
      totalPoints, weeklyPoints, monthlyPoints,
      level: lvl.level, levelXp: lvl.xpInLevel, levelXpRequired: lvl.xpRequired, levelProgress: lvl.progress,
      streak,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Activity counters (opt-in via opts.counter)
    if (opts.counter === "chapter")        update.chapterTestsCompleted = admin.firestore.FieldValue.increment(1);
    if (opts.counter === "ease")           update.easeSessionsCompleted = admin.firestore.FieldValue.increment(1);
    if (opts.counter === "chapter_perfect") update.perfectScores       = admin.firestore.FieldValue.increment(1);

    if (!snap.exists) {
      update.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }
    tx.set(ref, update, { merge: true });
  });
}

// ───────────────────────────────────────────────────────────────
// 5. awardChapterTestPoints — on chapter_test_attempts write
//    Fires when an attempt status flips to 'scored' (or 'submitted').
//    Idempotent: we look at the pre→post transition. Re-runs on the
//    same scored doc are no-ops because the transition was prior→after.
// ───────────────────────────────────────────────────────────────
exports.awardChapterTestPoints = onDocumentWritten(
  { document: "chapter_test_attempts/{attemptId}", region: "asia-southeast1" },
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!after) return;

    const SCORED = new Set(["scored", "submitted", "flagged"]);
    const wasScored = before && SCORED.has(before.status);
    const isScored  = SCORED.has(after.status);
    if (!isScored || wasScored) return;     // only fire on transition INTO scored

    const studentUid = after.studentUid;
    if (!studentUid) return;

    const scorePct = Number(after.rawScorePct || 0);
    let points = POINTS.CHAPTER_BASE;
    points += Math.round(scorePct * 0.5);

    // First attempt bonus — count submissions for this (student, test) pair.
    if (after.testId) {
      const dup = await db.collection("chapter_test_attempts")
        .where("studentUid", "==", studentUid)
        .where("testId", "==", after.testId)
        .where("status", "in", ["scored", "submitted", "flagged"])
        .get();
      if (dup.size <= 1) points += POINTS.CHAPTER_FIRST_ATTEMPT_BONUS;
    }

    const isPerfect = scorePct >= 100;
    if (isPerfect) points += POINTS.CHAPTER_PERFECT_BONUS;

    await awardPoints(studentUid, points, {
      counter: isPerfect ? "chapter_perfect" : "chapter",
    });
  }
);

// ───────────────────────────────────────────────────────────────
// 6. awardEaseSessionPoints — on ease_sessions write
//    Fires on transition INTO 'submitted'. Looks up the matching
//    ease_growth doc to derive growthVsPrev for the bonus.
// ───────────────────────────────────────────────────────────────
exports.awardEaseSessionPoints = onDocumentWritten(
  { document: "ease_sessions/{sessionId}", region: "asia-southeast1" },
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!after) return;

    const wasSubmitted = before && before.status === "submitted";
    const isSubmitted  = after.status === "submitted";
    if (!isSubmitted || wasSubmitted) return;

    const studentUid = after.studentUid;
    if (!studentUid) return;

    let points = POINTS.EASE_BASE;
    try {
      const growthRef = db.collection("ease_growth").doc(`${studentUid}_${after.subjectId}`);
      const gSnap = await growthRef.get();
      if (gSnap.exists) {
        const windows = gSnap.data().windows || [];
        const lastWindow = windows[windows.length - 1];
        if (lastWindow && lastWindow.growthVsPrev != null) {
          const g = lastWindow.growthVsPrev;
          if (g >= 5) points += POINTS.EASE_GROWTH_STRONG_BONUS;
          else if (g >= 0) points += POINTS.EASE_GROWTH_POSITIVE_BONUS;
        }
      }
    } catch (e) { /* no growth doc yet — first window */ }

    await awardPoints(studentUid, points, { counter: "ease" });
  }
);

// ───────────────────────────────────────────────────────────────
// 7. rebuildLeaderboards — hourly schedule
//    Re-generates top-100 inline aggregates for every
//    (scope, scopeId, period) tuple in active use. Stored at
//    school_leaderboards/{scope}_{scopeId}_{period}.
//
//    Heuristic: walks all student_points docs, groups by scope key,
//    sorts by period field, writes top 100. For network scope, single
//    pass over the whole collection. For partner-school scopes, groups
//    by schoolId. Class + grade groups likewise.
// ───────────────────────────────────────────────────────────────
exports.rebuildLeaderboards = onSchedule(
  { schedule: "every 60 minutes", timeZone: "Asia/Jakarta", region: "asia-southeast1" },
  async () => {
    const all = await db.collection("student_points").get();
    if (all.empty) {
      console.log("[rebuildLeaderboards] no student_points yet — skip");
      return;
    }
    const rows = all.docs.map(d => ({ id: d.id, ...d.data() }));
    const periods = ["weekly", "monthly", "alltime"];
    const periodField = {
      weekly:  "weeklyPoints",
      monthly: "monthlyPoints",
      alltime: "totalPoints",
    };

    const batch = db.batch();
    const seen = new Set();

    function writeBoard(scope, scopeId, period, list) {
      if (!list.length) return;
      const sorted = [...list].sort((a, b) =>
        (b[periodField[period]] || 0) - (a[periodField[period]] || 0)
      );
      const entries = sorted.slice(0, 100).map((r, i) => ({
        rank: i + 1,
        studentUid: r.studentUid || r.id,
        displayName: r.displayName || "Student",
        photoURL: r.photoURL || null,
        schoolId: r.schoolId || null,
        schoolName: r.schoolName || null,
        classId: r.classId || null,
        className: r.className || null,
        gradeLevel: r.gradeLevel || null,
        totalPoints: r.totalPoints || 0,
        weeklyPoints: r.weeklyPoints || 0,
        monthlyPoints: r.monthlyPoints || 0,
        level: r.level || 1,
      }));
      const id = `${scope}_${scopeId}_${period}`;
      if (seen.has(id)) return;
      seen.add(id);
      batch.set(db.collection("school_leaderboards").doc(id), {
        scope, scopeId, period, entries,
        computedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // Group by class, grade-within-school, school, and network-wide
    const byClass = {};
    const byGrade = {};   // key = `${schoolId}|${gradeLevel}`
    const bySchool = {};
    rows.forEach(r => {
      if (r.classId)   (byClass[r.classId]   ||= []).push(r);
      if (r.schoolId && r.gradeLevel != null) {
        const k = `${r.schoolId}|${r.gradeLevel}`;
        (byGrade[k] ||= []).push(r);
      }
      if (r.schoolId)  (bySchool[r.schoolId] ||= []).push(r);
    });

    periods.forEach(p => {
      Object.entries(byClass).forEach(([id, list])  => writeBoard("class", id, p, list));
      Object.entries(byGrade).forEach(([k, list])   => writeBoard("grade", k, p, list));
      Object.entries(bySchool).forEach(([id, list]) => writeBoard("school", id, p, list));
      writeBoard("network", "all", p, rows);
    });

    await batch.commit();
    console.log(`[rebuildLeaderboards] wrote ${seen.size} boards across ${rows.length} students`);
  }
);

// ───────────────────────────────────────────────────────────────
// 8. resetLeaderboardWindows — daily 00:05 Asia/Jakarta
//    Mondays reset weeklyPoints to 0.
//    First-of-month resets monthlyPoints to 0.
//    totalPoints is never reset.
// ───────────────────────────────────────────────────────────────
exports.resetLeaderboardWindows = onSchedule(
  { schedule: "5 0 * * *", timeZone: "Asia/Jakarta", region: "asia-southeast1" },
  async () => {
    const now = new Date();
    const dayOfWeek = now.toLocaleString("en-GB", { weekday: "short", timeZone: "Asia/Jakarta" });
    const dayOfMonth = Number(now.toLocaleString("en-GB", { day: "numeric", timeZone: "Asia/Jakarta" }));
    const resetWeekly  = dayOfWeek === "Mon";
    const resetMonthly = dayOfMonth === 1;

    if (!resetWeekly && !resetMonthly) {
      console.log("[resetLeaderboardWindows] no reset today");
      return;
    }

    const all = await db.collection("student_points").get();
    const batch = db.batch();
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    all.docs.forEach(d => {
      const upd = { updatedAt: stamp };
      if (resetWeekly)  { upd.weeklyPoints  = 0; upd.lastWeeklyResetAt  = stamp; }
      if (resetMonthly) { upd.monthlyPoints = 0; upd.lastMonthlyResetAt = stamp; }
      batch.set(d.ref, upd, { merge: true });
    });
    await batch.commit();
    console.log(`[resetLeaderboardWindows] reset ${all.size} docs (weekly=${resetWeekly} monthly=${resetMonthly})`);
  }
);

// ───────────────────────────────────────────────────────────────
// EASE BANK PROXY — easeBankProxy
//   Server-side proxy to the external latihan.id question bank
//   API. Keeps the bearer token off the client; restricts callers
//   to authenticated CH admins / directors / coordinators.
//
//   Token stored in Secret Manager as LATIHAN_API_TOKEN. Set via:
//     firebase functions:secrets:set LATIHAN_API_TOKEN --project centralhub-8727b
//   then paste the bearer (no "Bearer " prefix — raw token).
//
//   Client usage (CH page):
//     const fn = httpsCallable(getFunctions(app, 'asia-southeast1'),
//                              'easeBankProxy');
//     const { data } = await fn({ path: '/ease/lessons' });
//     // or: fn({ path: '/ease/questions',
//     //          query: { lesson_code: 'EASE-SMP-MAT', per_page: 25 } });
//
//   Allow-listed paths only — proxy never forwards arbitrary URLs.
// ───────────────────────────────────────────────────────────────
const LATIHAN_BASE = "https://latihan.id/api/eduversal";
const LATIHAN_ALLOWED_PATHS = new Set(["/ease/lessons", "/ease/questions"]);
const latihanApiToken = defineSecret("LATIHAN_API_TOKEN");

exports.easeBankProxy = onCall(
  {
    region: "asia-southeast1",
    secrets: [latihanApiToken],
    cors: true,
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = request.auth.uid;
    const userSnap = await db.collection("users").doc(uid).get();
    const u = userSnap.exists ? userSnap.data() : null;
    const isAdmin = u?.role_centralhub === "central_admin";
    const subRoles = Array.isArray(u?.ch_sub_roles) ? u.ch_sub_roles : [];
    const allowed = isAdmin
      || subRoles.includes("director")
      || subRoles.includes("coordinator");
    if (!allowed) {
      throw new HttpsError("permission-denied",
        "Requires CH admin / director / coordinator.");
    }

    const path = String(request.data?.path || "");
    if (!LATIHAN_ALLOWED_PATHS.has(path)) {
      throw new HttpsError("invalid-argument",
        `Path not allowed: ${path}`);
    }

    const query = request.data?.query || {};
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === "") continue;
      if (Array.isArray(v)) {
        for (const item of v) params.append(`${k}[]`, String(item));
      } else {
        params.append(k, String(v));
      }
    }
    const qs = params.toString();
    const url = `${LATIHAN_BASE}${path}${qs ? "?" + qs : ""}`;

    const token = latihanApiToken.value();
    if (!token) {
      throw new HttpsError("failed-precondition",
        "LATIHAN_API_TOKEN secret not set.");
    }

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": token,
        "Accept": "application/json",
      },
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); }
    catch { body = { raw: text }; }

    if (!res.ok) {
      throw new HttpsError("internal",
        `Upstream ${res.status}`, { status: res.status, body });
    }
    return body;
  }
);

// ───────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────
function isoWeekStart(d) {
  const date = new Date(d);
  const day = date.getDay() || 7;
  if (day !== 1) date.setHours(-24 * (day - 1));
  return date.toISOString().slice(0, 10);
}
