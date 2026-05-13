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
 * Practice Bank AI Suggest (2026-05-12):
 *   N+1. practiceBankAiSuggest          — httpsCallable Anthropic proxy that
 *                                         ranks practice_questions candidates
 *                                         for a /practice-assessment-author
 *                                         draft. Secret: ANTHROPIC_API_KEY.
 *                                         Writes ai_suggestion_cache (24h TTL,
 *                                         pool-fingerprint key) + practice_ai_audit
 *                                         (append-only). Default model:
 *                                         claude-sonnet-4-6.
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

// ───────────────────────────────────────────────────────────────
// 5b. EASE ITEM EXPOSURE + CORRECT-RATE — onEaseResponseCreated
//     On every ease_responses write, server-side increments the
//     parent ease_items doc's seenCount, recomputes correctRate as
//     a running average, and writes a server-validated mirror of
//     theta_after / se_after onto the parent session doc.
//
//     Rule of thumb (Phase 3): client-side adaptive engine emits
//     "what I think theta is now"; this function emits "what the
//     server believes after seeing the response trail". Pacing /
//     class-assessment / growth dashboards read the server values
//     only — client values stay on the session for resume only.
//
//     Server-side scoring re-validates `isCorrect` against the
//     parent ease_items definition, since the client computed it.
//     A mismatch sets a `serverCorrectionApplied` flag on the
//     response doc (response is immutable for the student but
//     admin-writable; this is the admin SDK path).
// ───────────────────────────────────────────────────────────────
exports.onEaseResponseCreated = onDocumentWritten(
  {
    document: "ease_responses/{responseId}",
    region: "asia-southeast1",
  },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return;            // delete — not handled
    if (event.data?.before?.exists) return; // updates — ignore (responses are immutable)
    const { sessionId, studentUid, itemId, answerGiven, isCorrect, theta_after, se_after, seq } = after;
    if (!sessionId || !itemId) return;

    // 1. Re-grade against the item definition. Disagreement is rare
    //    but possible if the client UI bug or a clock skew flipped a
    //    flag. Server is authoritative.
    let serverIsCorrect = !!isCorrect;
    let serverCorrectionApplied = false;
    try {
      const itemSnap = await db.collection("ease_items").doc(itemId).get();
      if (itemSnap.exists) {
        const it = itemSnap.data();
        const computed = recomputeIsCorrect(it, answerGiven);
        if (computed !== null && computed !== !!isCorrect) {
          serverIsCorrect = computed;
          serverCorrectionApplied = true;
        }
      }
    } catch (err) {
      console.warn(`[ease-server-grade] ${event.params.responseId}: regrade failed`, err.message);
    }

    // 2. Update parent ease_items: bump seenCount + running correctRate.
    //    correctRate = (rate*n + 1*is_correct) / (n+1). Stored as 0..1.
    try {
      const itRef = db.collection("ease_items").doc(itemId);
      await db.runTransaction(async (tx) => {
        const cur = await tx.get(itRef);
        if (!cur.exists) return;
        const d = cur.data();
        const n   = d.seenCount || 0;
        const r   = typeof d.correctRate === "number" ? d.correctRate : null;
        const nNew = n + 1;
        const rNew = r === null
          ? (serverIsCorrect ? 1 : 0)
          : (r * n + (serverIsCorrect ? 1 : 0)) / nNew;
        tx.update(itRef, {
          seenCount: nNew,
          correctRate: rNew,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    } catch (err) {
      console.warn(`[ease-server-grade] item update failed ${itemId}`, err.message);
    }

    // 3. Mirror theta_after / se_after into the parent session doc
    //    under server-prefixed fields. The client field stays as-is
    //    (it's the resume source). Pacing + growth dashboards read
    //    `serverTheta` / `serverSE` only.
    try {
      const sRef = db.collection("ease_sessions").doc(sessionId);
      await sRef.update({
        serverTheta: typeof theta_after === "number" ? theta_after : null,
        serverSE: typeof se_after === "number" ? se_after : null,
        serverItemsAnswered: typeof seq === "number" ? seq : null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn(`[ease-server-grade] session update failed ${sessionId}`, err.message);
    }

    // 4. Apply server correction back onto the response doc if needed.
    //    Response docs are client-immutable but admin-writable per the rule.
    if (serverCorrectionApplied) {
      try {
        await db.collection("ease_responses").doc(event.params.responseId).update({
          serverIsCorrect,
          serverCorrectionApplied: true,
          serverCorrectionAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[ease-server-grade] correction applied to ${event.params.responseId} (student=${studentUid}, item=${itemId})`);
      } catch (err) {
        console.warn(`[ease-server-grade] correction write failed`, err.message);
      }
    }
  }
);

function recomputeIsCorrect(item, answerGiven) {
  if (!item || !item.type) return null;
  if (item.type === "mcq") {
    if (typeof item.correctIdx !== "number") return null;
    return Number(answerGiven) === Number(item.correctIdx);
  }
  if (item.type === "numeric") {
    const a = String(answerGiven ?? "").trim();
    const c = String(item.correctAnswer ?? "").trim();
    const an = Number(a), cn = Number(c);
    return (!isNaN(an) && !isNaN(cn)) ? an === cn : a.toLowerCase() === c.toLowerCase();
  }
  if (item.type === "short") {
    const a = String(answerGiven ?? "").trim().toLowerCase();
    const c = String(item.correctAnswer ?? "").trim().toLowerCase();
    if (a === c) return true;
    // Synonym list — populated by the new question editor.
    if (Array.isArray(item.acceptedAnswers)) {
      return item.acceptedAnswers.some(s => String(s).trim().toLowerCase() === a);
    }
    return false;
  }
  return null;
}

// ───────────────────────────────────────────────────────────────
// 5c. EASE ITEM CALIBRATION — calibrateEaseItems (scheduled, weekly)
//     Every Sunday 03:00 Jakarta. Walks ease_responses for items
//     with ≥ MIN_CALIBRATION_RESPONSES responses and computes a
//     calibrated logit (b) and a crude discrimination proxy (a)
//     from accumulated response data. Flips pilotPhase to false
//     once an item has enough data; updates ease_items.calibratedLogit
//     and .discrimination.
//
//     Method (lightweight, Rasch-1PL bootstrap):
//       p_correct = correctRate
//       logit(p) = ln(p / (1-p))    [clamped to avoid ±Inf]
//       b ≈ θ̄_seen − logit(p)
//     Where θ̄_seen is the mean theta_after across all responses on
//     this item (i.e. the population that has actually seen it).
//     This is a coarse first pass — Phase 3.5 will replace it with
//     a proper joint MLE once the response volume justifies it.
//
//     Adaptive engine (ease-test.html) keeps falling back to the
//     bootstrap DIFF_LOGIT until pilotPhase flips to false; once
//     flipped, the engine should prefer `calibratedLogit` for that
//     item (FOLLOWUP — engine code switch lives in the SH client).
// ───────────────────────────────────────────────────────────────
const MIN_CALIBRATION_RESPONSES = 30;

exports.calibrateEaseItems = onSchedule(
  {
    schedule: "0 3 * * 0",          // Sundays 03:00
    timeZone: "Asia/Jakarta",
    region: "asia-southeast1",
  },
  async () => {
    const itemsSnap = await db.collection("ease_items")
      .where("seenCount", ">=", MIN_CALIBRATION_RESPONSES)
      .get();
    console.log(`[ease-calibrate] ${itemsSnap.size} item(s) above threshold`);

    let calibrated = 0;
    for (const itDoc of itemsSnap.docs) {
      const it = itDoc.data();
      const p  = typeof it.correctRate === "number" ? it.correctRate : null;
      if (p === null || p <= 0 || p >= 1) continue; // ceiling / floor — can't fit
      const pClamped = Math.max(0.02, Math.min(0.98, p));
      const logitP = Math.log(pClamped / (1 - pClamped));

      // θ̄ across all responses on this item. Cap query to 1000 — beyond that,
      // the rolling correctRate already smooths things out.
      const respSnap = await db.collection("ease_responses")
        .where("itemId", "==", itDoc.id)
        .limit(1000)
        .get();
      if (respSnap.empty) continue;
      let sum = 0, n = 0;
      respSnap.forEach(r => {
        const t = r.data().theta_after;
        if (typeof t === "number") { sum += t; n++; }
      });
      if (n === 0) continue;
      const thetaMean = sum / n;
      const calibratedLogit = thetaMean - logitP;

      // Discrimination proxy: variance-of-theta-around-flip approximation.
      // Items where correctRate transitions sharply at a given θ are more
      // discriminating; we approximate by computing the SD of theta for
      // responders and inverting (smaller SD → tighter cut → higher a).
      // Clamp to [0.5, 2.5] so a single weird item can't tank engine ranking.
      let sqSum = 0;
      respSnap.forEach(r => {
        const t = r.data().theta_after;
        if (typeof t === "number") { sqSum += (t - thetaMean) ** 2; }
      });
      const sd = Math.sqrt(sqSum / Math.max(1, n));
      const discrimination = Math.max(0.5, Math.min(2.5, sd > 0 ? 1 / sd : 1.0));

      await itDoc.ref.update({
        calibratedLogit,
        discrimination,
        pilotPhase: false,
        calibratedAt: admin.firestore.FieldValue.serverTimestamp(),
        calibrationResponseCount: n,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      calibrated++;
    }
    console.log(`[ease-calibrate] ${calibrated} item(s) calibrated this run.`);
  }
);

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
  // SH engagement (2026-05-13) — practice + daily-challenge
  PRACTICE_BASE: 20,                    // attempting a run at all
  DAILY_CHALLENGE_BASE: 50,             // higher floor than free practice
  TOURNAMENT_BASE: 75,                  // reserved for future /tournaments page
  PRACTICE_PER_CORRECT: 5,              // correctCount * this
  PRACTICE_RUN_STREAK_3: 10,            // bestStreak >= 3 within the run
  PRACTICE_RUN_STREAK_5: 20,            // bestStreak >= 5 within the run
  PRACTICE_PERFECT_BONUS: 30,           // rawScorePct === 100
  DAILY_CHALLENGE_FIRST_BONUS: 25,      // first daily-challenge submit of the day for this (uid, subj)
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
    if (opts.counter === "practice")        update.practiceRunsCompleted = admin.firestore.FieldValue.increment(1);
    if (opts.counter === "daily_challenge") update.dailyChallengesCompleted = admin.firestore.FieldValue.increment(1);
    if (opts.counter === "practice_perfect") update.perfectScores       = admin.firestore.FieldValue.increment(1);

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
// 6b. awardPracticeAttemptPoints — on practice_attempts write (2026-05-13)
//    Fires on transition INTO 'submitted' (or 'scored', for parity
//    with chapter test pipeline). Mode-aware point formula:
//
//      practice         : base 20  + 5/correct + run-streak + perfect
//      daily_challenge  : base 50  + 5/correct + run-streak + perfect
//                                  + 25 first-of-day-per-subject bonus
//      tournament       : base 75  (reserved — no /tournaments page yet)
//
//    Writes the awarded total back to practice_attempts.pointsAwarded
//    so the student dashboard can render it without re-deriving.
//    NEVER touches chapter_mastery / ease_growth — same boundary as
//    practice_questions / practice_assessments (CLAUDE.md #33).
// ───────────────────────────────────────────────────────────────
exports.awardPracticeAttemptPoints = onDocumentWritten(
  { document: "practice_attempts/{attemptId}", region: "asia-southeast1" },
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!after) return;

    const SCORED = new Set(["submitted", "scored"]);
    const wasScored = before && SCORED.has(before.status);
    const isScored  = SCORED.has(after.status);
    if (!isScored || wasScored) return;       // only fire on transition INTO scored

    const studentUid = after.studentUid;
    if (!studentUid) return;

    // No re-entry guard needed for the pointsAwarded writeback below:
    // that update keeps status==='submitted' on both sides of the
    // transition, so wasScored becomes true and the early-return at
    // top of this handler bails out.

    const mode         = after.mode || "practice";
    const correctCount = Number(after.correctCount || 0);
    const bestStreak   = Number(after.streakBest || 0);
    const scorePct     = Number(after.rawScorePct || 0);
    const subjectId    = after.subjectId;
    const challengeId  = after.challengeId;

    // Base by mode
    let points;
    let counter;
    if (mode === "daily_challenge") {
      points  = POINTS.DAILY_CHALLENGE_BASE;
      counter = "daily_challenge";
    } else if (mode === "tournament") {
      points  = POINTS.TOURNAMENT_BASE;
      counter = "practice";
    } else {
      points  = POINTS.PRACTICE_BASE;
      counter = "practice";
    }

    // Per-correct
    points += correctCount * POINTS.PRACTICE_PER_CORRECT;

    // Run-internal streak
    if      (bestStreak >= 5) points += POINTS.PRACTICE_RUN_STREAK_5;
    else if (bestStreak >= 3) points += POINTS.PRACTICE_RUN_STREAK_3;

    // Perfect run
    const isPerfect = scorePct >= 100;
    if (isPerfect) {
      points += POINTS.PRACTICE_PERFECT_BONUS;
      counter = mode === "daily_challenge" ? "daily_challenge" : "practice_perfect";
    }

    // Daily-challenge first-of-day-per-subject bonus
    if (mode === "daily_challenge" && challengeId) {
      try {
        const dup = await db.collection("practice_attempts")
          .where("studentUid", "==", studentUid)
          .where("challengeId", "==", challengeId)
          .where("status", "in", ["submitted", "scored"])
          .get();
        if (dup.size <= 1) points += POINTS.DAILY_CHALLENGE_FIRST_BONUS;
      } catch (e) { /* silent — first-bonus is nice-to-have, not load-bearing */ }
    }

    await awardPoints(studentUid, points, { counter });

    // Write pointsAwarded back so SH can render it in the summary screen
    // + recent-runs list. Best-effort: a failure here doesn't void the
    // point award (already committed above).
    try {
      await event.data.after.ref.update({
        pointsAwarded: points,
        pointsAwardedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn("[awardPracticeAttemptPoints] pointsAwarded writeback failed", e.message);
    }
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
// rotateDailyChallenges — nightly auto-publish for tomorrow
//   Runs daily at 00:05 Asia/Jakarta. For each pilot subject
//   (math / english / science):
//     - If a daily_challenges/{tomorrow_subj} doc already exists,
//       do nothing (HQ may have manual-published).
//     - Else pick one published practice_assessments doc for that
//       subject (prefer mode='daily_challenge', fall back to
//       mode='practice') and write tomorrow's challenge with
//       createdBy: 'system'.
//   Empty pool → log + skip. Never overwrites a manual publish.
//
//   Doc id pattern matches /daily-challenge-admin:
//     {YYYY-MM-DD}_{subjectId}
// ───────────────────────────────────────────────────────────────
exports.rotateDailyChallenges = onSchedule(
  { schedule: "5 0 * * *", timeZone: "Asia/Jakarta", region: "asia-southeast1" },
  async () => {
    const SUBJECTS = ["math", "english", "science"];
    // Compute tomorrow in Asia/Jakarta. The runtime container is UTC,
    // so build the date key from a localised string slice to avoid
    // timezone drift on the boundary day.
    const nowJakarta = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
    const tomorrow = new Date(nowJakarta);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const y = tomorrow.getFullYear();
    const m = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const d = String(tomorrow.getDate()).padStart(2, "0");
    const dateKey = `${y}-${m}-${d}`;

    // 00:00:00 → 23:59:59 in Asia/Jakarta, expressed as a UTC Date.
    // Asia/Jakarta is UTC+7 always (no DST). So local 00:00 → UTC 17:00 prior day.
    const opens  = new Date(`${dateKey}T00:00:00+07:00`);
    const closes = new Date(`${dateKey}T23:59:59+07:00`);

    const summary = { dateKey, published: [], skipped: [], empty: [] };

    for (const subj of SUBJECTS) {
      const id = `${dateKey}_${subj}`;
      const ref = db.collection("daily_challenges").doc(id);
      const existing = await ref.get();
      if (existing.exists) {
        summary.skipped.push(subj);
        continue;
      }

      // Pick from published assessments for this subject. Prefer
      // mode='daily_challenge' (the HQ-curated daily bucket); fall
      // back to mode='practice' so the rotator still has something
      // to land on during the math-only pilot.
      let pool = await db.collection("practice_assessments")
        .where("subjectId", "==", subj)
        .where("status", "==", "published")
        .where("mode", "==", "daily_challenge")
        .limit(50).get();
      if (pool.empty) {
        pool = await db.collection("practice_assessments")
          .where("subjectId", "==", subj)
          .where("status", "==", "published")
          .where("mode", "==", "practice")
          .limit(50).get();
      }
      if (pool.empty) {
        summary.empty.push(subj);
        continue;
      }

      // Random pick. Deterministic alternative considered (e.g.
      // round-robin by dateKey hash) but random gives more variety
      // when the pool is small.
      const docs = pool.docs;
      const pickIdx = Math.floor(Math.random() * docs.length);
      const a = docs[pickIdx];
      const aData = a.data();
      if (!Array.isArray(aData.itemIds) || aData.itemIds.length === 0) {
        summary.empty.push(subj);
        continue;
      }

      const SUBJ_LABEL = { math: "Math", english: "English", science: "Science" };
      await ref.set({
        dateKey,
        subjectId: subj,
        title: aData.title || `${SUBJ_LABEL[subj]} — daily rotation`,
        description: aData.description || "",
        itemIds: aData.itemIds,
        itemCount: aData.itemCount || aData.itemIds.length,
        difficultyMix: aData.difficultyMix || {},
        topicGroups: aData.topicGroups || [],
        sourceAssessmentId: a.id,
        opensAt: opens,
        closesAt: closes,
        status: "open",
        createdBy: "system",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      summary.published.push({ subj, assessmentId: a.id });
    }

    console.log("[rotateDailyChallenges]", JSON.stringify(summary));
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
// N. PRACTICE BANK AI SUGGEST — practiceBankAiSuggest
//    HQ Subject Specialists pick items from `practice_questions`
//    to compose a `practice_assessments` doc. This function ranks
//    a candidate pool with Anthropic Claude and returns top-N ids
//    + a 1-line rationale per pick.
//
//    Secret: ANTHROPIC_API_KEY (Secret Manager).
//    Default model: claude-sonnet-4-6 (cost-effective for ranking;
//    Opus is overkill for metadata ranking).
//
//    Auth gate (same as easeBankProxy):
//      central_admin OR director OR coordinator.
//      Coordinators additionally constrained to their ch_subjects[].
//
//    Privacy: ONLY metadata + first 200 chars of stem is sent to
//    the model. No full HTML, no image URLs, no correct answers.
//
//    Caching: ai_suggestion_cache/{sha256-of-inputs}. 24h soft TTL.
//    Cache key embeds a fingerprint of the candidate-pool ids so a
//    new import / archive auto-invalidates downstream cached calls.
//
//    Audit: every call (cache hit OR miss) appends a row to
//    practice_ai_audit — uid, intent, returnedIds, tokenUsage,
//    latencyMs, cacheHit.
//
//    Request shape:
//      {
//        subjectId,
//        targetCount: 1..50,
//        difficultyMix: { easy, medium, hard },     // optional
//        topicGroups: [],                            // optional
//        cambridgeStage: 7..12 | null,               // optional
//        intent: "Year 7 warm-up on integers...",    // free text
//        assessmentId: 'draft-xyz' | null,           // optional pin
//        model: 'claude-sonnet-4-6' (default)
//      }
//
//    Response shape:
//      { returnedIds[], rationale[], cacheHit, auditId,
//        candidatePoolSize, model, tokenUsage }
// ───────────────────────────────────────────────────────────────
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const PRACTICE_AI_DEFAULT_MODEL = "claude-sonnet-4-6";
const PRACTICE_AI_ALLOWED_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-7",
]);
const PRACTICE_AI_CANDIDATE_CAP = 100;
const PRACTICE_AI_CACHE_TTL_HOURS = 24;

async function sha256Hex(input) {
  const { createHash } = require("crypto");
  return createHash("sha256").update(input).digest("hex");
}

function buildPracticeAiPrompt({ intent, params, candidates }) {
  const lines = [];
  lines.push("You are helping a Cambridge curriculum specialist pick");
  lines.push("practice questions for a Students Hub gamification surface");
  lines.push("(tournaments / leaderboards / daily challenges) — NOT a");
  lines.push("formal graded assessment. Items are math/english/science.");
  lines.push("");
  lines.push("=== Author intent ===");
  lines.push(intent || "(no free-text intent given)");
  lines.push("");
  lines.push("=== Structured params ===");
  lines.push(`subject:        ${params.subjectId}`);
  lines.push(`target count:   ${params.targetCount}`);
  if (params.difficultyMix) {
    const m = params.difficultyMix;
    lines.push(`difficulty mix: easy=${m.easy||0} medium=${m.medium||0} hard=${m.hard||0}`);
  }
  if (Array.isArray(params.topicGroups) && params.topicGroups.length) {
    lines.push(`topic groups:   ${params.topicGroups.join(", ")}`);
  }
  if (params.cambridgeStage) {
    lines.push(`cambridge stage: ${params.cambridgeStage}`);
  }
  lines.push("");
  lines.push("=== Candidate pool (metadata only) ===");
  for (const c of candidates) {
    const stem = (c.stemPreview || "").replace(/\s+/g, " ").slice(0, 200);
    lines.push(`- id:${c.id} | topic:${c.topic||"-"} | group:${c.topicGroup||"-"} | diff:${c.difficulty||"-"} | cmd:${c.commandWord||"-"} | stem:${stem}`);
  }
  lines.push("");
  lines.push("=== Task ===");
  lines.push(`Pick the best ${params.targetCount} candidates that match the`);
  lines.push("author's intent + structured params. Respect the difficulty");
  lines.push("mix and topic-group constraints when provided. Prefer items");
  lines.push("that read clearly from stem text alone (this is a gamified");
  lines.push("surface, not a formal exam).");
  lines.push("");
  lines.push("Return ONLY a JSON object — no prose, no markdown fences —");
  lines.push("of the shape:");
  lines.push('  { "picks": [ { "id": "...", "reason": "1 short sentence" }, ... ] }');
  lines.push("");
  lines.push("If fewer than the target count of candidates are a good fit,");
  lines.push("return fewer picks rather than padding. Do NOT invent ids.");
  return lines.join("\n");
}

function parseAiPicksJson(text) {
  // Defensive: strip code fences if the model wrapped output despite instructions.
  let cleaned = String(text || "").trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    const picks = Array.isArray(parsed?.picks) ? parsed.picks : [];
    return picks
      .filter(p => p && typeof p.id === "string")
      .map(p => ({ id: p.id, reason: String(p.reason || "").slice(0, 280) }));
  } catch (_e) {
    return [];
  }
}

exports.practiceBankAiSuggest = onCall(
  {
    region: "asia-southeast1",
    secrets: [anthropicApiKey],
    cors: true,
    timeoutSeconds: 60,
    memory: "512MiB",
  },
  async (request) => {
    const t0 = Date.now();
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = request.auth.uid;
    const userSnap = await db.collection("users").doc(uid).get();
    const u = userSnap.exists ? userSnap.data() : null;
    const isAdmin = u?.role_centralhub === "central_admin";
    const subRoles = Array.isArray(u?.ch_sub_roles) ? u.ch_sub_roles : [];
    const isDirector = subRoles.includes("director");
    const isCoordinator = subRoles.includes("coordinator");
    if (!(isAdmin || isDirector || isCoordinator)) {
      throw new HttpsError("permission-denied",
        "Requires CH admin / director / coordinator.");
    }

    const data = request.data || {};
    const subjectId = String(data.subjectId || "").trim();
    if (!["math", "english", "science"].includes(subjectId)) {
      throw new HttpsError("invalid-argument",
        `subjectId must be math/english/science (got ${subjectId})`);
    }
    // Coordinator subject gate.
    if (!isAdmin && !isDirector && isCoordinator) {
      const chSubjects = Array.isArray(u?.ch_subjects) ? u.ch_subjects : [];
      if (!chSubjects.includes(subjectId)) {
        throw new HttpsError("permission-denied",
          `Coordinator not entitled to subject ${subjectId}`);
      }
    }

    const targetCount = Math.max(1, Math.min(50,
      Number(data.targetCount) || 10));
    const difficultyMix = data.difficultyMix && typeof data.difficultyMix === "object"
      ? {
        easy: Math.max(0, Number(data.difficultyMix.easy) || 0),
        medium: Math.max(0, Number(data.difficultyMix.medium) || 0),
        hard: Math.max(0, Number(data.difficultyMix.hard) || 0),
      }
      : null;
    const topicGroups = Array.isArray(data.topicGroups)
      ? data.topicGroups.filter(t => typeof t === "string").slice(0, 8)
      : [];
    const cambridgeStage = (typeof data.cambridgeStage === "number"
      && data.cambridgeStage >= 7 && data.cambridgeStage <= 12)
      ? data.cambridgeStage : null;
    const intent = String(data.intent || "").slice(0, 600);
    const assessmentId = data.assessmentId
      ? String(data.assessmentId).slice(0, 64) : null;
    const requestedModel = String(data.model || PRACTICE_AI_DEFAULT_MODEL);
    const model = PRACTICE_AI_ALLOWED_MODELS.has(requestedModel)
      ? requestedModel : PRACTICE_AI_DEFAULT_MODEL;

    // Build hard-filter query over practice_questions.
    let q = db.collection("practice_questions")
      .where("subjectId", "==", subjectId)
      .where("status", "==", "active");
    if (cambridgeStage) {
      q = q.where("cambridgeStage", "==", cambridgeStage);
    }
    // topicGroups: array-contains-any supports up to 10 values.
    if (topicGroups.length === 1) {
      q = q.where("topicGroup", "==", topicGroups[0]);
    } else if (topicGroups.length > 1) {
      q = q.where("topicGroup", "in", topicGroups.slice(0, 10));
    }
    // Most-recent-imported first; cap candidate pool.
    q = q.orderBy("importedAt", "desc").limit(PRACTICE_AI_CANDIDATE_CAP);
    const candSnap = await q.get();
    const candidates = candSnap.docs.map(d => {
      const x = d.data() || {};
      return {
        id: d.id,
        topic: x.topic || null,
        topicGroup: x.topicGroup || null,
        difficulty: x.difficulty || null,
        commandWord: x.commandWord || null,
        stemPreview: typeof x.stem === "string"
          ? x.stem.slice(0, 200) : "",
      };
    });
    const candidatePoolSize = candidates.length;

    if (candidatePoolSize === 0) {
      const auditRef = await db.collection("practice_ai_audit").add({
        actorUid: uid,
        actorEmail: u?.email || request.auth.token?.email || null,
        actorRole: isAdmin ? "central_admin"
          : (isDirector ? "director" : "coordinator"),
        assessmentId,
        subjectId,
        intent,
        params: { targetCount, difficultyMix, topicGroups, cambridgeStage },
        candidatePoolSize: 0,
        candidateIdsSentToModel: [],
        returnedIds: [],
        rationale: [],
        model,
        tokenUsage: { input: 0, output: 0, total: 0 },
        latencyMs: Date.now() - t0,
        cacheHit: false,
        error: null,
        at: admin.firestore.FieldValue.serverTimestamp(),
      });
      return {
        returnedIds: [], rationale: [], cacheHit: false,
        auditId: auditRef.id, candidatePoolSize: 0,
        model, tokenUsage: { input: 0, output: 0, total: 0 },
      };
    }

    // Cache lookup. Key embeds a fingerprint of the candidate-pool ids
    // so an import / archive auto-invalidates the cache.
    const sortedCandIds = candidates.map(c => c.id).sort();
    const poolFingerprint = await sha256Hex(sortedCandIds.join("|"));
    const cacheKeyRaw = JSON.stringify({
      subjectId, targetCount, difficultyMix, topicGroups, cambridgeStage,
      intent, model, poolFingerprint,
    });
    const cacheKey = (await sha256Hex(cacheKeyRaw)).slice(0, 40);

    const nowMs = Date.now();
    const cacheRef = db.collection("ai_suggestion_cache").doc(cacheKey);
    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      const c = cacheSnap.data() || {};
      const expiresAt = c.expiresAt?.toMillis?.() || 0;
      if (expiresAt > nowMs && Array.isArray(c.returnedIds)) {
        const auditRef = await db.collection("practice_ai_audit").add({
          actorUid: uid,
          actorEmail: u?.email || request.auth.token?.email || null,
          actorRole: isAdmin ? "central_admin"
            : (isDirector ? "director" : "coordinator"),
          assessmentId,
          subjectId,
          intent,
          params: { targetCount, difficultyMix, topicGroups, cambridgeStage },
          candidatePoolSize,
          candidateIdsSentToModel: sortedCandIds,
          returnedIds: c.returnedIds,
          rationale: c.rationale || [],
          model: c.model || model,
          tokenUsage: { input: 0, output: 0, total: 0 },
          latencyMs: Date.now() - t0,
          cacheHit: true,
          error: null,
          at: admin.firestore.FieldValue.serverTimestamp(),
        });
        return {
          returnedIds: c.returnedIds,
          rationale: c.rationale || [],
          cacheHit: true,
          auditId: auditRef.id,
          candidatePoolSize,
          model: c.model || model,
          tokenUsage: { input: 0, output: 0, total: 0 },
        };
      }
    }

    // Live Anthropic call.
    const apiKey = anthropicApiKey.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition",
        "ANTHROPIC_API_KEY secret not set.");
    }
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic.default({ apiKey });

    const prompt = buildPracticeAiPrompt({
      intent,
      params: { subjectId, targetCount, difficultyMix, topicGroups, cambridgeStage },
      candidates,
    });

    let returnedIds = [];
    let rationale = [];
    let tokenUsage = { input: 0, output: 0, total: 0 };
    let errorMsg = null;
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      });
      const textBlock = (resp.content || []).find(b => b.type === "text");
      const picks = parseAiPicksJson(textBlock?.text || "");
      const validIdSet = new Set(candidates.map(c => c.id));
      const dedup = new Set();
      for (const p of picks) {
        if (!validIdSet.has(p.id) || dedup.has(p.id)) continue;
        dedup.add(p.id);
        returnedIds.push(p.id);
        rationale.push(p.reason);
        if (returnedIds.length >= targetCount) break;
      }
      tokenUsage = {
        input: resp.usage?.input_tokens || 0,
        output: resp.usage?.output_tokens || 0,
        total: (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0),
      };
    } catch (err) {
      errorMsg = String(err?.message || err);
    }

    // Persist cache + audit.
    const ttlMs = PRACTICE_AI_CACHE_TTL_HOURS * 3600 * 1000;
    await cacheRef.set({
      returnedIds,
      rationale,
      model,
      tokenUsage,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + ttlMs),
    });

    const auditRef = await db.collection("practice_ai_audit").add({
      actorUid: uid,
      actorEmail: u?.email || request.auth.token?.email || null,
      actorRole: isAdmin ? "central_admin"
        : (isDirector ? "director" : "coordinator"),
      assessmentId,
      subjectId,
      intent,
      params: { targetCount, difficultyMix, topicGroups, cambridgeStage },
      candidatePoolSize,
      candidateIdsSentToModel: sortedCandIds,
      returnedIds,
      rationale,
      model,
      tokenUsage,
      latencyMs: Date.now() - t0,
      cacheHit: false,
      error: errorMsg,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (errorMsg) {
      throw new HttpsError("internal", `Anthropic call failed: ${errorMsg}`,
        { auditId: auditRef.id });
    }

    return {
      returnedIds,
      rationale,
      cacheHit: false,
      auditId: auditRef.id,
      candidatePoolSize,
      model,
      tokenUsage,
    };
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
