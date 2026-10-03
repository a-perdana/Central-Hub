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
 *                                         on every response write. Respondent
 *                                         anonymity (Principal 360 Framework):
 *                                         threshold-gated cohort visibility, no
 *                                         respondent uid in any output.
 *
 * EASE Bank Proxy (2026-05-11):
 *   N. easeBankProxy                    — httpsCallable proxy to latihan.id
 *                                         question-bank API. Bearer token in
 *                                         Secret Manager (LATIHAN_API_TOKEN);
 *                                         CH admin / director / coordinator only.
 *
 * Practice Bank AI Suggest — ARCHIVED 2026-10-02 (functions/archive/
 *   practiceBankAiSuggest.js; not loaded, not deployed).
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
    // Range boundaries in real time: the isoWeek label is a Jakarta
    // calendar date, so Monday 00:00 WIB = Sunday 17:00 UTC.
    const weekStartUtc = new Date(new Date(isoWeek + "T00:00:00Z").getTime() - JAKARTA_OFFSET_MS);
    const weekEnd = new Date(weekStartUtc.getTime() + 7 * 86400000);

    const entriesSnap = await db.collection("induction_journal")
      .where("programId", "==", programId)
      .where("stageId",   "==", stageId)
      .where("entryDate", ">=", weekStartUtc)
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
//      - aboveThreshold[c] = (respondentCount >= COHORT_THRESHOLD)
//        (framework cohort_definitions → min_respondents_to_report: 5)
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
        // Framework scoring_scale: 0 = "Cannot Comment / Not Observed" carries
        // exclude_from_aggregate — it is not a low score, so it never enters
        // the mean.
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
    // doc so we never expose raw count/sum (anonymity — only the mean is
    // observable).
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

    const rawScorePct = typeof after.rawScorePct === "number" ? after.rawScorePct : null;
    const passed      = after.passed === true;
    const masteryLevel = bandFor(rawScorePct);

    // Transaction + lastEventId guard + FieldValue.increment (2026-08-01):
    // the old read-modify-write on attemptsCount lost updates under
    // concurrent scoring, and at-least-once redelivery double-counted.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prior = snap.exists ? snap.data() : {};
      if (prior.lastEventId === event.id) return; // redelivered event

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
        attemptsCount: admin.firestore.FieldValue.increment(1),
        lastEventId: event.id,
        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (!prior.firstAttemptAt) payload.firstAttemptAt = admin.firestore.FieldValue.serverTimestamp();

      tx.set(ref, payload, { merge: true });
    });
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

// 2026-08-01 rewrite: the original version fetched up to 1,000 FULL
// response docs per qualifying item, sequentially, inside the default
// 60s / 256MiB envelope — with a few hundred qualifying items it timed
// out every week, re-did the same prefix, and never reached the tail.
// Now: explicit timeout/memory, .select() projection, a smaller
// statistically-sufficient response sample, a per-run item cap with
// "never-calibrated first, then stalest" ordering so every run makes
// forward progress, a re-calibration skip until an item has ~25% more
// data than last fit, and bounded concurrency.
const CALIBRATE_ITEMS_PER_RUN = 250;
const CALIBRATE_RESP_SAMPLE   = 400;

exports.calibrateEaseItems = onSchedule(
  {
    schedule: "0 3 * * 0",          // Sundays 03:00
    timeZone: "Asia/Jakarta",
    region: "asia-southeast1",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const itemsSnap = await db.collection("ease_items")
      .where("seenCount", ">=", MIN_CALIBRATION_RESPONSES)
      .select("correctRate", "seenCount", "calibratedAt", "calibrationResponseCount")
      .get();

    const candidates = itemsSnap.docs
      .map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
      .filter(it => {
        const p = typeof it.correctRate === "number" ? it.correctRate : null;
        if (p === null || p <= 0 || p >= 1) return false; // ceiling/floor — can't fit
        if (!it.calibratedAt) return true;                // never calibrated
        // Re-fit only once ~25% more responses have accumulated.
        return (it.seenCount || 0) >= Math.max(
          MIN_CALIBRATION_RESPONSES,
          (it.calibrationResponseCount || 0) * 1.25
        );
      })
      .sort((a, b) => {
        const ta = a.calibratedAt?.toMillis?.() || 0;   // 0 = never → first
        const tb = b.calibratedAt?.toMillis?.() || 0;
        return ta - tb;
      })
      .slice(0, CALIBRATE_ITEMS_PER_RUN);

    console.log(`[ease-calibrate] ${itemsSnap.size} above threshold, ${candidates.length} selected this run`);

    let calibrated = 0;
    async function calibrateOne(it) {
      const pClamped = Math.max(0.02, Math.min(0.98, it.correctRate));
      const logitP = Math.log(pClamped / (1 - pClamped));

      const respSnap = await db.collection("ease_responses")
        .where("itemId", "==", it.id)
        .select("theta_after")
        .limit(CALIBRATE_RESP_SAMPLE)
        .get();
      if (respSnap.empty) return;

      let sum = 0, n = 0;
      respSnap.forEach(r => {
        const t = r.data().theta_after;
        if (typeof t === "number") { sum += t; n++; }
      });
      if (n === 0) return;
      const thetaMean = sum / n;
      const calibratedLogit = thetaMean - logitP;

      // Discrimination proxy: SD of responder theta, inverted + clamped
      // to [0.5, 2.5] so a single weird item can't tank engine ranking.
      let sqSum = 0;
      respSnap.forEach(r => {
        const t = r.data().theta_after;
        if (typeof t === "number") { sqSum += (t - thetaMean) ** 2; }
      });
      const sd = Math.sqrt(sqSum / Math.max(1, n));
      const discrimination = Math.max(0.5, Math.min(2.5, sd > 0 ? 1 / sd : 1.0));

      await it.ref.update({
        calibratedLogit,
        discrimination,
        pilotPhase: false,
        calibratedAt: admin.firestore.FieldValue.serverTimestamp(),
        calibrationResponseCount: (it.seenCount || n),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      calibrated++;
    }

    // Bounded concurrency (5 at a time) — parallel enough to finish well
    // inside the timeout, serial enough not to hammer Firestore.
    for (let i = 0; i < candidates.length; i += 5) {
      await Promise.all(candidates.slice(i, i + 5).map(it =>
        calibrateOne(it).catch(e =>
          console.warn(`[ease-calibrate] ${it.id} failed:`, e.message))
      ));
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
// Schema host: docs/architecture/FIRESTORE_SCHEMA.md §20.
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

// Student-facing day keys are computed in Asia/Jakarta (UTC+7, no DST).
// Cloud Functions containers run in UTC — the old toISOString() day keys
// silently broke streaks for students practising before 07:00 WIB
// (2026-08-01 fix). Jakarta's offset is fixed, so shifting the epoch by
// +7h and reading the UTC calendar is exact.
const JAKARTA_OFFSET_MS = 7 * 3600 * 1000;
function jakartaDayISO(epochMs = Date.now()) {
  return new Date(epochMs + JAKARTA_OFFSET_MS).toISOString().slice(0, 10);
}

// Award points + recompute level / streak.
// opts.eventId: the Firestore trigger's event.id — REQUIRED for
// at-least-once safety. onDocumentWritten redelivers the SAME
// before/after pair on retry, so the callers' status-transition guards
// cannot catch redelivery; the marker doc written inside this
// transaction (student_points/{uid}/awards/{eventId}) can (2026-08-01
// fix — previously every retry double-awarded).
async function awardPoints(studentUid, points, opts = {}) {
  if (!studentUid || !points) return;
  const ref = db.collection("student_points").doc(studentUid);
  const identity = await loadStudentIdentity(studentUid);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let markerRef = null;
    if (opts.eventId) {
      markerRef = ref.collection("awards").doc(String(opts.eventId));
      const marker = await tx.get(markerRef);
      if (marker.exists) return; // redelivered event — already awarded
    }
    const cur  = snap.exists ? snap.data() : {};
    const totalPoints   = (cur.totalPoints   || 0) + points;
    const weeklyPoints  = (cur.weeklyPoints  || 0) + points;
    const monthlyPoints = (cur.monthlyPoints || 0) + points;

    // Level is derived from totalPoints (1 point = 1 XP).
    const lvl = computeLevelFromTotalXp(totalPoints);

    // Streak: bump if a new calendar day since lastDayISO. Milestone
    // bonuses (7-day +100, 30-day +250) are awarded inside this same
    // transaction so the same calendar-day flip can never pay twice —
    // `prevDay !== today` is the idempotency gate.
    const today = jakartaDayISO();
    const prevDay = cur.streak?.lastDayISO;
    let streak = cur.streak || { current: 0, longest: 0, lastDayISO: null, milestonesPaid: [] };
    let streakBonus = 0;
    let milestoneHit = null;
    if (prevDay !== today) {
      // Was the last day exactly yesterday (Jakarta calendar)?
      const yesterday = jakartaDayISO(Date.now() - 86400000);
      const currentStreak = (prevDay === yesterday) ? (streak.current || 0) + 1 : 1;
      const milestonesPaid = Array.isArray(streak.milestonesPaid) ? streak.milestonesPaid.slice() : [];

      if (currentStreak >= 30 && !milestonesPaid.includes(30)) {
        streakBonus  = POINTS.STREAK_MILESTONE_30;
        milestoneHit = 30;
        milestonesPaid.push(30);
      } else if (currentStreak >= 7 && !milestonesPaid.includes(7)) {
        streakBonus  = POINTS.STREAK_MILESTONE_7;
        milestoneHit = 7;
        milestonesPaid.push(7);
      }

      streak = {
        current: currentStreak,
        longest: Math.max(currentStreak, streak.longest || 0),
        lastDayISO: today,
        milestonesPaid,
      };
    }

    // Re-fold the milestone bonus into the running totals + level so the
    // doc commits in one shot.
    const totalAfterBonus   = totalPoints   + streakBonus;
    const weeklyAfterBonus  = weeklyPoints  + streakBonus;
    const monthlyAfterBonus = monthlyPoints + streakBonus;
    const lvlAfter = streakBonus ? computeLevelFromTotalXp(totalAfterBonus) : lvl;

    const update = {
      ...identity,
      totalPoints: totalAfterBonus,
      weeklyPoints: weeklyAfterBonus,
      monthlyPoints: monthlyAfterBonus,
      level: lvlAfter.level, levelXp: lvlAfter.xpInLevel, levelXpRequired: lvlAfter.xpRequired, levelProgress: lvlAfter.progress,
      streak,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (milestoneHit) {
      update.lastStreakMilestone = {
        day: milestoneHit,
        bonus: streakBonus,
        awardedAt: admin.firestore.FieldValue.serverTimestamp(),
        seen: false,
      };
    }

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
    if (markerRef) {
      tx.set(markerRef, {
        points,
        counter: opts.counter || null,
        at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
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
    // count() aggregation (2026-08-01): the old .get() fetched every prior
    // attempt as a full doc just to compare sizes — O(n) reads per award,
    // O(n²) over a class working the same test.
    if (after.testId) {
      const dup = await db.collection("chapter_test_attempts")
        .where("studentUid", "==", studentUid)
        .where("testId", "==", after.testId)
        .where("status", "in", ["scored", "submitted", "flagged"])
        .count().get();
      if (dup.data().count <= 1) points += POINTS.CHAPTER_FIRST_ATTEMPT_BONUS;
    }

    const isPerfect = scorePct >= 100;
    if (isPerfect) points += POINTS.CHAPTER_PERFECT_BONUS;

    await awardPoints(studentUid, points, {
      counter: isPerfect ? "chapter_perfect" : "chapter",
      eventId: event.id,
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

    await awardPoints(studentUid, points, { counter: "ease", eventId: event.id });
  }
);

// ───────────────────────────────────────────────────────────────
// 6a-bis. recomputeEaseGrowth — on ease_sessions write (2026-08-19)
//    Fires on transition INTO 'submitted'. Rebuilds the student's
//    ease_growth/{uid}_{subjectId} aggregate SERVER-SIDE from the
//    full set of submitted sessions, replacing the client-written
//    read-modify-write (SH audit H3: two concurrent tabs could drop
//    a window entry, and the student's browser was the sole author
//    of its own growth record). The client's optimistic write in
//    ease-test.html stays for instant UX; this recompute lands a
//    second later and is authoritative.
//
//    Scoring source preference per session: serverTheta (written by
//    onEaseResponseCreated) → clamp(200 + θ·33, 100, 300); falls
//    back to the client ritScore when serverTheta is absent.
//    One entry per windowId (latest submittedAt wins); entries
//    ordered by submittedAt; growthVsPrev derived from the ordering.
//    Equality-only query — no composite index needed.
// ───────────────────────────────────────────────────────────────
exports.recomputeEaseGrowth = onDocumentWritten(
  { document: "ease_sessions/{sessionId}", region: "asia-southeast1" },
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!after) return;

    const wasSubmitted = before && before.status === "submitted";
    const isSubmitted  = after.status === "submitted";
    if (!isSubmitted || wasSubmitted) return;

    const studentUid = after.studentUid;
    const subjectId  = after.subjectId;
    if (!studentUid || !subjectId) return;

    const ritFrom = (s) => {
      if (typeof s.serverTheta === "number") {
        return Math.max(100, Math.min(300, Math.round(200 + s.serverTheta * 33)));
      }
      return typeof s.ritScore === "number" ? s.ritScore : null;
    };
    const millis = (ts) => (ts && typeof ts.toMillis === "function") ? ts.toMillis() : 0;

    const growthRef = db.collection("ease_growth").doc(`${studentUid}_${subjectId}`);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(
          db.collection("ease_sessions")
            .where("studentUid", "==", studentUid)
            .where("subjectId", "==", subjectId)
            .where("status", "==", "submitted")
        );
        // One entry per window — the latest submission wins.
        const byWindow = new Map();
        snap.forEach((d) => {
          const s = d.data();
          const rit = ritFrom(s);
          if (rit === null || !s.windowId) return;
          const cur = byWindow.get(s.windowId);
          if (!cur || millis(s.submittedAt) > millis(cur.submittedAtTs)) {
            byWindow.set(s.windowId, {
              windowId: s.windowId,
              ritScore: rit,
              sessionId: d.id,
              submittedAtTs: s.submittedAt || null,
            });
          }
        });
        const ordered = [...byWindow.values()]
          .sort((a, b) => millis(a.submittedAtTs) - millis(b.submittedAtTs));
        const windows = ordered.map((w, i) => ({
          windowId: w.windowId,
          ritScore: w.ritScore,
          sessionId: w.sessionId,
          submittedAt: w.submittedAtTs,
          growthVsPrev: i > 0 ? w.ritScore - ordered[i - 1].ritScore : null,
        }));
        if (windows.length === 0) return;
        tx.set(growthRef, {
          studentUid,
          subjectId,
          windows,
          latestRit: windows[windows.length - 1].ritScore,
          serverRecomputedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      console.log(`[ease-growth-recompute] ${studentUid}_${subjectId} rebuilt`);
    } catch (e) {
      console.warn(`[ease-growth-recompute] ${studentUid}_${subjectId} failed`, e.message);
    }
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

    // 2026-10-02: only attempts graded by startPracticeRun /
    // answerPracticeItem earn points. Students can no longer write
    // practice_attempts at all (rules), so this is defence in depth
    // against any doc created another way.
    if (after.serverGraded !== true) {
      try {
        await event.data.after.ref.update({ pointsAwarded: 0, pointsNote: "not server-graded" });
      } catch (e) { /* best effort */ }
      return;
    }

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

    // Daily cap (2026-10-02): free-practice runs earn points for the
    // first PRACTICE_DAILY_POINT_RUNS completed runs of a Jakarta day;
    // later runs still count for practice, but score 0 points. Stops
    // point farming by speed-clicking through runs.
    let capped = false;
    if (mode === "practice") {
      try {
        const dayStart = jakartaDayStart();
        const done = await db.collection("practice_attempts")
          .where("studentUid", "==", studentUid)
          .where("mode", "==", "practice")
          .where("submittedAt", ">=", dayStart)
          .count().get();
        if (done.data().count > PRACTICE_DAILY_POINT_RUNS) { points = 0; capped = true; }
      } catch (e) {
        console.warn("[awardPracticeAttemptPoints] daily-cap count failed", e.message);
      }
    }

    // Daily-challenge first-of-day-per-subject bonus.
    // count() aggregation (2026-08-01) — was a full-doc fetch per award.
    if (mode === "daily_challenge" && challengeId) {
      try {
        const dup = await db.collection("practice_attempts")
          .where("studentUid", "==", studentUid)
          .where("challengeId", "==", challengeId)
          .where("status", "in", ["submitted", "scored"])
          .count().get();
        if (dup.data().count <= 1) points += POINTS.DAILY_CHALLENGE_FIRST_BONUS;
      } catch (e) {
        console.warn("[awardPracticeAttemptPoints] first-bonus count failed", e.message);
      }
    }

    if (points > 0) await awardPoints(studentUid, points, { counter, eventId: event.id });

    // Daily-challenge board row (2026-10-02). Students may only read
    // their own practice_attempts, so the school x grade board reads this
    // name + score projection instead.
    if (mode === "daily_challenge" && challengeId) {
      try {
        await db.collection("daily_challenge_results").doc(`${challengeId}_${studentUid}`).set({
          challengeId, studentUid,
          studentName: after.studentName || "Student",
          schoolId: after.schoolId || null,
          gradeLevel: after.gradeLevel || null,
          subjectId: subjectId || null,
          rawScorePct: scorePct,
          correctCount,
          itemCount: Array.isArray(after.itemIds) ? after.itemIds.length : null,
          submittedAt: after.submittedAt || admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.warn("[awardPracticeAttemptPoints] daily result row failed", e.message);
      }
    }

    // Write pointsAwarded back so SH can render it in the summary screen
    // + recent-runs list. Best-effort: a failure here doesn't void the
    // point award (already committed above).
    try {
      await event.data.after.ref.update({
        pointsAwarded: points,
        pointsAwardedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(capped ? { pointsNote: "daily point limit reached" } : {}),
      });
    } catch (e) {
      console.warn("[awardPracticeAttemptPoints] pointsAwarded writeback failed", e.message);
    }
  }
);

// ───────────────────────────────────────────────────────────────
// 6c. STUDENTS HUB PRACTICE ENGINE — server-graded (2026-10-02)
//
//   startPracticeRun    (callable) picks the items server-side and
//                       creates the practice_attempts doc. Free practice:
//                       random from the WHOLE active pool for the
//                       student's grade (subject + optional topicGroup /
//                       difficulty), items the student has not seen in
//                       their last PRACTICE_RECENT_ATTEMPTS runs first.
//                       Daily challenge: the challenge's items, one
//                       attempt per student per challenge (an unfinished
//                       one is resumed). Returns the items WITHOUT
//                       correctAnswer / explanation / distractorRationale.
//   answerPracticeItem  (callable) grades one answer in a transaction,
//                       in order, once per item; returns whether it was
//                       right plus the key and the explanation. Marks the
//                       attempt submitted after the last item, which
//                       fires awardPracticeAttemptPoints.
//   practicePoolStats   (callable) counts of active items per subject /
//                       topicGroup / difficulty for the student's grade —
//                       students can no longer read practice_questions.
//
//   Why: the client used to grade itself and write correctCount, and the
//   points function trusted it — any student could award themselves
//   unlimited points from DevTools, and every answer key was readable.
// ───────────────────────────────────────────────────────────────
const PRACTICE_SUBJECTS = ["math", "english", "science"];
const PRACTICE_DIFFS = ["easy", "medium", "hard"];
const PRACTICE_MAX_ITEMS = 20;
// Must exceed the largest grade × subject pool: the query has no random order, so
// a cap below the pool size silently drops the items with the highest doc ids from
// every unfiltered run. At 1000 it hid 436 G10 and 210 G11 science items (2026-10-03).
const PRACTICE_POOL_LIMIT = 3000;
const PRACTICE_RECENT_ATTEMPTS = 30;
const PRACTICE_DAILY_POINT_RUNS = 20;
const PRACTICE_PUBLIC_FIELDS = [
  "subjectId", "topic", "topicGroup", "difficulty", "stem", "stemHtml",
  "options", "optionsHtml", "hasDiagram", "diagramUrl", "diagramStoragePath",
  "diagramType", "diagramAlt",
];

function jakartaDayStart() {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
  return new Date(`${key}T00:00:00+07:00`);
}

function publicPracticeItem(snap) {
  const d = snap.data() || {};
  const out = { id: snap.id };
  for (const k of PRACTICE_PUBLIC_FIELDS) out[k] = d[k] === undefined ? null : d[k];
  return out;
}

async function loadActiveStudent(uid) {
  if (!uid) throw new HttpsError("unauthenticated", "Please sign in first.");
  const snap = await db.collection("students").doc(uid).get();
  const s = snap.exists ? snap.data() : null;
  if (!s || s.status !== "active") throw new HttpsError("permission-denied", "Your Students Hub account is not active.");
  const grade = Number(s.gradeLevel);
  if (!(grade >= 7 && grade <= 12)) {
    throw new HttpsError("failed-precondition", "Your grade is not set yet. Ask your school or Eduversal to set it.");
  }
  return { ...s, grade };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

exports.startPracticeRun = onCall({ region: "asia-southeast1" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  const s = await loadActiveStudent(uid);
  await enforcePerUserRateLimit("startPracticeRun", uid, 60, 300);
  const data = req.data || {};
  const attempts = db.collection("practice_attempts");
  const qcol = db.collection("practice_questions");

  // ── Daily challenge ─────────────────────────────────────────
  if (typeof data.challengeId === "string" && data.challengeId) {
    const challengeId = data.challengeId.slice(0, 80);
    const cSnap = await db.collection("daily_challenges").doc(challengeId).get();
    const c = cSnap.exists ? cSnap.data() : null;
    const now = Date.now();
    if (!c || c.status !== "open"
        || (c.opensAt && c.opensAt.toMillis() > now)
        || (c.closesAt && c.closesAt.toMillis() < now)) {
      throw new HttpsError("failed-precondition", "This challenge isn't open right now.");
    }
    if (c.gradeLevel != null && Number(c.gradeLevel) !== s.grade) {
      throw new HttpsError("permission-denied", "This challenge is for a different grade.");
    }
    const prev = await attempts.where("studentUid", "==", uid).where("challengeId", "==", challengeId).limit(10).get();
    if (prev.docs.some(d => ["submitted", "scored"].includes(d.get("status")))) {
      throw new HttpsError("already-exists", "You have already done this challenge today. Come back tomorrow!");
    }
    const open = prev.docs.find(d => d.get("status") === "in_progress" && d.get("serverGraded") === true);
    if (open) {
      const a = open.data();
      const snaps = await db.getAll(...a.itemIds.map(id => qcol.doc(id)));
      return {
        attemptId: open.id, mode: "daily_challenge", subjectId: a.subjectId, topicGroup: null,
        items: snaps.filter(x => x.exists).map(publicPracticeItem),
        responses: (a.responses || []).map(r => ({ itemId: r.itemId, answer: r.answer, isCorrect: r.isCorrect })),
        correctCount: a.correctCount || 0, streak: a.streakCurrent || 0, streakBest: a.streakBest || 0,
        resumed: true,
      };
    }
    const ids = Array.isArray(c.itemIds) ? c.itemIds.slice(0, PRACTICE_MAX_ITEMS) : [];
    const snaps = ids.length ? await db.getAll(...ids.map(id => qcol.doc(id))) : [];
    const usable = snaps.filter(x => x.exists && x.get("correctAnswer"));
    if (!usable.length) throw new HttpsError("failed-precondition", "This challenge has no questions.");
    const ref = await attempts.add({
      studentUid: uid, studentName: s.displayName || "", schoolId: s.schoolId || null,
      gradeLevel: s.grade, subjectId: c.subjectId || null, mode: "daily_challenge",
      sourceType: "challenge", challengeId, topicGroup: null,
      itemIds: usable.map(x => x.id), responses: [], status: "in_progress",
      correctCount: 0, attemptedCount: 0, rawScorePct: 0, streakCurrent: 0, streakBest: 0,
      pointsAwarded: null, serverGraded: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), submittedAt: null,
    });
    return { attemptId: ref.id, mode: "daily_challenge", subjectId: c.subjectId || null, topicGroup: null,
      items: usable.map(publicPracticeItem), responses: [], correctCount: 0, streak: 0, streakBest: 0 };
  }

  // ── Free practice ───────────────────────────────────────────
  const subjectId = String(data.subjectId || "");
  if (!PRACTICE_SUBJECTS.includes(subjectId)) throw new HttpsError("invalid-argument", "Unknown subject.");
  const topicGroup = typeof data.topicGroup === "string" && data.topicGroup ? data.topicGroup.slice(0, 40) : null;
  const chapter = typeof data.chapter === "string" && data.chapter ? data.chapter.slice(0, 120) : null;
  const chapterTopic = chapter && typeof data.chapterTopic === "string" && data.chapterTopic ? data.chapterTopic.slice(0, 160) : null;
  const difficulty = PRACTICE_DIFFS.includes(data.difficulty) ? data.difficulty : null;
  const n = Math.max(1, Math.min(PRACTICE_MAX_ITEMS, parseInt(data.n, 10) || 10));

  let q = qcol.where("subjectId", "==", subjectId).where("status", "==", "active")
    .where("type", "==", "mcq").where("gradeLevels", "array-contains", s.grade);
  if (topicGroup) q = q.where("topicGroup", "==", topicGroup);
  if (difficulty) q = q.where("difficulty", "==", difficulty);
  // chapter / topic are filtered here, not in the query, so no new composite index is needed.
  const poolSnap = await q.select("correctAnswer", "options", "chapter", "topic").limit(PRACTICE_POOL_LIMIT).get();
  const pool = poolSnap.docs
    .filter(d => !chapter || d.get("chapter") === chapter)
    .filter(d => !chapterTopic || d.get("topic") === chapterTopic)
    .filter(d => d.get("correctAnswer") && Array.isArray(d.get("options")) && d.get("options").length >= 2)
    .map(d => d.id);
  if (!pool.length) throw new HttpsError("not-found", "No questions for your grade match this topic, chapter and difficulty yet.");

  const recent = await attempts.where("studentUid", "==", uid)
    .orderBy("createdAt", "desc").limit(PRACTICE_RECENT_ATTEMPTS).select("itemIds").get();
  const seen = new Set(recent.docs.flatMap(d => d.get("itemIds") || []));
  const unseen = shuffleInPlace(pool.filter(id => !seen.has(id)));
  const again = shuffleInPlace(pool.filter(id => seen.has(id)));
  const pickedIds = [...unseen, ...again].slice(0, n);

  const snaps = await db.getAll(...pickedIds.map(id => qcol.doc(id)));
  const items = snaps.filter(x => x.exists).map(publicPracticeItem);
  const ref = await attempts.add({
    studentUid: uid, studentName: s.displayName || "", schoolId: s.schoolId || null,
    gradeLevel: s.grade, subjectId, mode: "practice", sourceType: "free", challengeId: null,
    topicGroup, chapter, chapterTopic, difficulty, itemIds: items.map(i => i.id), responses: [], status: "in_progress",
    correctCount: 0, attemptedCount: 0, rawScorePct: 0, streakCurrent: 0, streakBest: 0,
    pointsAwarded: null, serverGraded: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(), submittedAt: null,
  });
  return { attemptId: ref.id, mode: "practice", subjectId, topicGroup, items,
    responses: [], correctCount: 0, streak: 0, streakBest: 0, poolSize: pool.length, unseenCount: unseen.length };
});

exports.answerPracticeItem = onCall({ region: "asia-southeast1" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please sign in first.");
  const data = req.data || {};
  const attemptId = String(data.attemptId || "");
  const itemId = String(data.itemId || "");
  const answer = String(data.answer || "");
  if (!attemptId || !itemId || !["A", "B", "C", "D", "E"].includes(answer)) {
    throw new HttpsError("invalid-argument", "Missing attempt, question or answer.");
  }
  await enforcePerUserRateLimit("answerPracticeItem", uid, 900, 4000);
  const ref = db.collection("practice_attempts").doc(attemptId);
  return db.runTransaction(async (tx) => {
    const aSnap = await tx.get(ref);
    const a = aSnap.exists ? aSnap.data() : null;
    if (!a || a.studentUid !== uid || a.serverGraded !== true) throw new HttpsError("permission-denied", "This run is not yours.");
    if (a.status !== "in_progress") throw new HttpsError("failed-precondition", "This run is already finished.");
    const ids = a.itemIds || [];
    const responses = a.responses || [];
    if (ids[responses.length] !== itemId) {
      throw new HttpsError("failed-precondition", responses.some(r => r.itemId === itemId)
        ? "You have already answered this question." : "Please answer the questions in order.");
    }
    const qSnap = await tx.get(db.collection("practice_questions").doc(itemId));
    const key = qSnap.exists ? qSnap.get("correctAnswer") : null;
    if (!key) throw new HttpsError("not-found", "This question is no longer available.");
    const isCorrect = answer === key;
    const streak = isCorrect ? (a.streakCurrent || 0) + 1 : 0;
    const streakBest = Math.max(a.streakBest || 0, streak);
    const correctCount = (a.correctCount || 0) + (isCorrect ? 1 : 0);
    const spent = Math.max(0, Math.min(30 * 60 * 1000, Number(data.timeSpentMs) || 0));
    const nextResponses = [...responses, { itemId, answer, isCorrect, timeSpentMs: spent, answeredAt: new Date().toISOString() }];
    const done = nextResponses.length >= ids.length;
    const rawScorePct = Math.round((correctCount / ids.length) * 100);
    const update = {
      responses: nextResponses, correctCount, attemptedCount: nextResponses.length,
      streakCurrent: streak, streakBest, rawScorePct,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (done) { update.status = "submitted"; update.submittedAt = admin.firestore.FieldValue.serverTimestamp(); }
    tx.update(ref, update);
    return {
      isCorrect, correctAnswer: key, explanation: qSnap.get("explanation") || null,
      done, correctCount, attemptedCount: nextResponses.length, total: ids.length,
      streak, streakBest, rawScorePct,
    };
  });
});

const practiceStatsCache = new Map();   // grade -> { at, data }
exports.practicePoolStats = onCall({ region: "asia-southeast1" }, async (req) => {
  const s = await loadActiveStudent(req.auth && req.auth.uid);
  const hit = practiceStatsCache.get(s.grade);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.data;   // 60 s: a new bank shows up within a minute of seeding
  const snap = await db.collection("practice_questions")
    .where("status", "==", "active").where("type", "==", "mcq")
    .where("gradeLevels", "array-contains", s.grade)
    .select("subjectId", "topicGroup", "difficulty", "correctAnswer", "chapter", "topic").get();
  const subjects = {};
  for (const subj of PRACTICE_SUBJECTS) subjects[subj] = { total: 0, byTopic: {}, byDifficulty: {}, byChapter: {} };
  snap.forEach(d => {
    const subj = d.get("subjectId");
    if (!subjects[subj] || !d.get("correctAnswer")) return;
    const t = d.get("topicGroup") || "mixed", diff = d.get("difficulty") || "medium";
    subjects[subj].total++;
    subjects[subj].byTopic[t] = (subjects[subj].byTopic[t] || 0) + 1;
    subjects[subj].byDifficulty[diff] = (subjects[subj].byDifficulty[diff] || 0) + 1;
    // Cambridge chapter -> topic tree (from the LO workbook), for the chapter picker.
    const ch = d.get("chapter");
    if (ch) {
      const c = subjects[subj].byChapter[ch] || (subjects[subj].byChapter[ch] = { n: 0, topics: {} });
      c.n++;
      const tp = d.get("topic");
      if (tp) c.topics[tp] = (c.topics[tp] || 0) + 1;
    }
  });
  const data = { grade: s.grade, subjects };
  practiceStatsCache.set(s.grade, { at: Date.now(), data });
  return data;
});

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
  {
    schedule: "every 60 minutes",
    timeZone: "Asia/Jakarta",
    region: "asia-southeast1",
    // 2026-08-01 hardening: the default 60s/256MiB envelope OOMs/times out
    // once the student body grows past pilot size — this job holds every
    // student_points doc in memory while sorting per (scope × period).
    timeoutSeconds: 540,
    memory: "1GiB",
  },
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

    // BulkWriter instead of a single db.batch(): batches hard-cap at 500
    // writes, and 3 periods × (classes + grades + schools + 1) board docs
    // crosses that around ~167 scope groups — at which point the WHOLE
    // hourly rebuild used to fail atomically and silently (2026-08-01 fix).
    const writer = db.bulkWriter();
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
      writer.set(db.collection("school_leaderboards").doc(id), {
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

    await writer.close();
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
  {
    // 00:15 (was 00:05) — staggered away from rotateDailyChallenges (00:05)
    // and the on-the-hour rebuildLeaderboards run so three collection-scanning
    // jobs don't contend inside the shared maxInstances pool every midnight.
    schedule: "15 0 * * *",
    timeZone: "Asia/Jakarta",
    region: "asia-southeast1",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
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
    // BulkWriter — a single db.batch() hard-caps at 500 writes, which
    // means the weekly/monthly reset would fail permanently and silently
    // from the 501st student onward (2026-08-01 pre-launch fix).
    const writer = db.bulkWriter();
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    all.docs.forEach(d => {
      const upd = { updatedAt: stamp };
      if (resetWeekly)  { upd.weeklyPoints  = 0; upd.lastWeeklyResetAt  = stamp; }
      if (resetMonthly) { upd.monthlyPoints = 0; upd.lastMonthlyResetAt = stamp; }
      writer.set(d.ref, upd, { merge: true });
    });
    await writer.close();
    console.log(`[resetLeaderboardWindows] reset ${all.size} docs (weekly=${resetWeekly} monthly=${resetMonthly})`);
  }
);

// ───────────────────────────────────────────────────────────────
// DAILY CHALLENGE ROTATOR — rotateDailyChallenges
//   Runs 00:05 Asia/Jakarta and publishes TOMORROW's challenges.
//
//   Since 2026-10-02 Students Hub is open to Grade 7-12 and has no
//   classes, so there is one challenge per subject per grade:
//     daily_challenges/{YYYY-MM-DD}_{subjectId}_g{grade}
//   for subject ∈ {math, english, science} × grade ∈ 7..12.
//
//   Items come straight from the active practice_questions pool for
//   that subject + grade (gradeLevels array-contains grade, auto-
//   gradable MCQ only) — 5 picked at random. practice_assessments is
//   no longer needed for the rotation: writing questions is enough.
//     - Doc already exists → leave it (manual publish wins).
//     - Fewer than DAILY_MIN_POOL usable items → skip, log as empty.
// ───────────────────────────────────────────────────────────────
exports.rotateDailyChallenges = onSchedule(
  { schedule: "5 0 * * *", timeZone: "Asia/Jakarta", region: "asia-southeast1" },
  async () => {
    const SUBJECTS = ["math", "english", "science"];
    const GRADES = [7, 8, 9, 10, 11, 12];
    const DAILY_ITEM_COUNT = 5;
    const DAILY_MIN_POOL = 5;
    const SUBJ_LABEL = { math: "Math", english: "English", science: "Science" };

    // Tomorrow in Asia/Jakarta (UTC+7, no DST). en-CA formats YYYY-MM-DD.
    const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" })
      .format(new Date(Date.now() + 24 * 3600 * 1000));
    const opens  = new Date(`${dateKey}T00:00:00+07:00`);
    const closes = new Date(`${dateKey}T23:59:59+07:00`);

    const summary = { dateKey, published: [], skipped: [], empty: [] };

    for (const subj of SUBJECTS) {
      for (const grade of GRADES) {
        const id = `${dateKey}_${subj}_g${grade}`;
        const ref = db.collection("daily_challenges").doc(id);
        if ((await ref.get()).exists) { summary.skipped.push(id); continue; }

        const snap = await db.collection("practice_questions")
          .where("subjectId", "==", subj)
          .where("status", "==", "active")
          .where("type", "==", "mcq")
          .where("gradeLevels", "array-contains", grade)
          .limit(500).get();
        const pool = snap.docs.filter(d => {
          const v = d.data();
          return v.correctAnswer && Array.isArray(v.options) && v.options.length >= 2;
        });
        if (pool.length < DAILY_MIN_POOL) { summary.empty.push(`${id}(${pool.length})`); continue; }

        // Partial Fisher-Yates — first DAILY_ITEM_COUNT slots are the pick.
        for (let i = 0; i < DAILY_ITEM_COUNT; i++) {
          const j = i + Math.floor(Math.random() * (pool.length - i));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const picked = pool.slice(0, DAILY_ITEM_COUNT);
        const difficultyMix = {};
        const topicGroups = new Set();
        picked.forEach(d => {
          const v = d.data();
          const k = v.difficulty || "medium";
          difficultyMix[k] = (difficultyMix[k] || 0) + 1;
          if (v.topicGroup) topicGroups.add(v.topicGroup);
        });

        await ref.set({
          dateKey,
          subjectId: subj,
          gradeLevel: grade,
          title: `${SUBJ_LABEL[subj]} — Grade ${grade} daily challenge`,
          description: "",
          itemIds: picked.map(d => d.id),
          itemCount: picked.length,
          difficultyMix,
          topicGroups: [...topicGroups],
          sourceAssessmentId: null,
          opensAt: opens,
          closesAt: closes,
          status: "open",
          createdBy: "system",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        summary.published.push(id);
      }
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

// ── Per-user rate limiting (2026-08-01 pre-launch hardening) ──
// Firestore-transaction token bucket shared by the three abusable
// callables (easeBankProxy / askEduversal).
// Why: each callable gates on "any signed-in central_user", which
// auth-guard auto-provisions on first sign-in — so without a throttle a
// single account could loop Anthropic / Cohere / latihan.id calls and
// run unbounded spend. central_admin is exempt at each call site.
// State doc: fn_rate_limits/{fnName_uid} — rules block ALL client access.
// Fail-open on limiter-infrastructure errors, fail-closed on quota.
async function enforcePerUserRateLimit(fnName, uid, perHour, perDay) {
  const ref = db.collection("fn_rate_limits").doc(`${fnName}_${uid}`);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      const d = snap.exists ? (snap.data() || {}) : {};
      let hourStart = Number(d.hourStart) || 0;
      let hourCount = Number(d.hourCount) || 0;
      let dayStart  = Number(d.dayStart)  || 0;
      let dayCount  = Number(d.dayCount)  || 0;
      if (now - hourStart >= 3600 * 1000)      { hourStart = now; hourCount = 0; }
      if (now - dayStart  >= 24 * 3600 * 1000) { dayStart  = now; dayCount  = 0; }
      if (hourCount >= perHour || dayCount >= perDay) {
        throw new HttpsError("resource-exhausted",
          `Rate limit reached (${perHour}/hour, ${perDay}/day). Try again later.`);
      }
      tx.set(ref, {
        fnName, uid,
        hourStart, hourCount: hourCount + 1,
        dayStart,  dayCount:  dayCount + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.warn(`[rate-limit] ${fnName} check failed for ${uid}:`, err?.message || err);
  }
}

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
    // Approval gate (2026-08-01): auto-provisioned central_user counts only
    // once central_admin approves — mirrors the firestore.rules helpers.
    const isCentralUser = u?.role_centralhub === "central_user"
      && u?.approval_status_centralhub === "approved";
    // Page-access UI is the sole gate since 2026-05-20 — any signed-in
    // central_user who reaches /ease-bank-browser can proxy upstream.
    if (!(isAdmin || isCentralUser)) {
      throw new HttpsError("permission-denied",
        "Requires CH admin or central_user.");
    }

    // Throttle non-admins: the browser page is chatty (code-search index
    // pre-fetch ≈15 calls), so the ceiling is generous — this only stops
    // scripted loops from burning the latihan.id contract quota.
    if (!isAdmin) {
      await enforcePerUserRateLimit("easeBankProxy", uid, 120, 600);
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
      // Clamp per_page — the raw passthrough forwarded e.g. per_page=100000
      // verbatim, which can hammer the upstream contract (2026-08-01 fix).
      if (k === "per_page") {
        const pp = Math.max(1, Math.min(100, Number(v) || 25));
        params.append(k, String(pp));
        continue;
      }
      if (Array.isArray(v)) {
        for (const item of v.slice(0, 20)) params.append(`${k}[]`, String(item));
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
      // A hanging upstream must not pin the container for the full 30s
      // callable timeout (shared maxInstances pool).
      signal: AbortSignal.timeout(15000),
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
// AICF PHASE 3 — rebuildAiCompetencyAggregates (2026-05-18,
// reworked 2026-10-02 for the AI Competency Framework 26-27 v2.0)
//   Walks ai_competency_self_assessments + ai_maturity_assessments
//   for each (schoolId, academicYear) pair and writes summary docs
//   to ai_competency_aggregates/{schoolId}_{academicYear} and one
//   network-wide ai_competency_aggregates/network_{academicYear}.
//
//   Two triggers:
//     (a) Weekly schedule (Mondays 02:00 Asia/Jakarta) — full rebuild.
//     (b) onDocumentWritten on ai_maturity_assessments — partial
//         rebuild when a school shares (marks final) its profile, when
//         Eduversal adds notes, or when shared area levels change.
//
//   What the live framework allows (Digital Citizenship & AI: AI
//   Competency Framework 26-27, Part Three):
//     - "Institutional Assessment Process": the SCHOOL self-assesses and
//       rates its current level for each of the six domains.
//     - "Relationship to School Appraisal": the self-assessment "remains
//       developmental and is not validated or converted into a School
//       Appraisal rating."
//     - "Benchmarking and Reporting": network reporting "may summarise
//       patterns ... It should not rank schools".
//     - Annex 4: "retain a six-domain maturity profile rather than
//       reducing the framework to a single official score".
//   So, since 2026-10-02 (aggregateShapeVersion 2):
//     - the six area levels are taken AS THE SCHOOL SELF-RATED THEM
//       (domainRatings), never from Eduversal notes (the legacy
//       appraisal.validatedDomainRatings is no longer read);
//     - only shared profiles (status 'submitted' or 'appraised' — the
//       stored value 'appraised' means "Eduversal notes added") count;
//     - no single overall level, no year-on-year overall delta, no
//       count of schools per overall level, no top/bottom school lists.
//       The network doc carries a per-area level DISTRIBUTION only, with
//       no schoolIds in it (aggregate-only, no ranking).
//   Retired output fields (no longer written; values already stored on
//   older docs are left untouched — readers must check
//   aggregateShapeVersion >= 2 and ignore them):
//     school:  institutionalCurrentLevel, institutionalAppraised,
//              previousOverallLevel, levelDelta
//     network: schoolsByMaturityLevel, networkDomainMedian,
//              topSchoolsByDomain, bottomSchoolsByDomain
//   No page reads ai_competency_aggregates today (grep 2026-10-02).
//
//   🚨 NOT DEPLOYED: written 2026-10-02 while the billing account is
//   closed (Blaze needed). The deployed version is still the old one
//   until `firebase deploy --only functions:rebuildAiCompetencyAggregates,
//   functions:onMaturityAppraisalWritten --project centralhub-8727b`.
//
//   Schema: docs/architecture/FIRESTORE_SCHEMA.md §24
//   (ai_competency_aggregates).
//
//   Admin SDK bypasses rules — aggregate docs are Cloud-Function-only
//   writers per the rule block.
// ───────────────────────────────────────────────────────────────

const AICF_MATURITY_DOMAINS = [
  "strategy_leadership", "policy_compliance", "staff_capability",
  "teaching_learning", "student_outcomes", "infrastructure_resources",
];
const AICF_AGGREGATE_SHAPE_VERSION = 2;

// A profile counts once the school has marked it final ('submitted') or
// Eduversal has added notes to it (stored status 'appraised').
function isSharedMaturityProfile(mat) {
  return !!mat && (mat.status === "submitted" || mat.status === "appraised");
}

function validMaturityLevel(v) {
  return (typeof v === "number" && v >= 1 && v <= 5) ? v : null;
}

async function recomputeSchoolAggregate(schoolId, academicYear) {
  if (!schoolId || !academicYear) return;
  const aggregateId = `${schoolId}_${academicYear}`;

  // 1. Pull all teacher self-assessments for this school + year.
  //    Same-school AH leadership writes to ai_competency_self_assessments
  //    with userId = teacher; we filter on schoolId stamped on the doc.
  let staffSnap;
  try {
    staffSnap = await db.collection("ai_competency_self_assessments")
      .where("schoolId", "==", schoolId)
      .where("academicYear", "==", academicYear)
      .get();
  } catch (err) {
    console.error(`[rebuildAiCompetencyAggregates] staff query failed for ${aggregateId}`, err);
    staffSnap = { docs: [] };
  }

  // Staff distribution = the level each teacher SELF-DECLARED on a shared
  // self-assessment. Live AICF 26-27, Part One "Verification and
  // Validation": "Formal level certification is not required, but schools
  // should track overall staff competency distribution". The stored status
  // 'validated' now means "professional development conversation recorded"
  // (AH ai-validate-teacher-assessments), and a legacy validation.agreedLevel
  // no longer overrides the teacher's own level.
  const staffCounts = { foundation: 0, practitioner: 0, leader: 0, unsubmitted: 0 };
  let validationLagSum = 0, validationLagN = 0, pendingValidation = 0, submittedCount = 0;

  staffSnap.docs.forEach((d) => {
    const data = d.data() || {};
    if (data.status === "submitted" || data.status === "validated") {
      submittedCount += 1;
      const lvl = data.selfDeclaredLevel;
      if (lvl && Object.prototype.hasOwnProperty.call(staffCounts, lvl) && lvl !== "unsubmitted") {
        staffCounts[lvl] += 1;
      }
    }
    if (data.status === "submitted") {
      // Shared, conversation not yet recorded.
      pendingValidation += 1;
    }
    if (data.status === "validated") {
      // Lag from submission to the recorded conversation.
      const sub = data.submittedAt?.toMillis?.();
      const val = data?.validation?.validatedAt?.toMillis?.();
      if (sub && val && val > sub) {
        validationLagSum += (val - sub);
        validationLagN += 1;
      }
    }
    // Drafts are not counted: there is no eligible-staff denominator
    // without a separate staff roster query. Field left for expansion.
  });

  const submissionRate = submittedCount > 0
    ? Math.round((submittedCount / Math.max(submittedCount + staffCounts.unsubmitted, 1)) * 100) / 100
    : 0;
  const medianDaysToValidation = validationLagN > 0
    ? Math.round((validationLagSum / validationLagN) / 86400000)
    : null;

  // 2. Pull this school's institutional maturity doc.
  const matRef = db.collection("ai_maturity_assessments").doc(`${schoolId}_${academicYear}`);
  let mat = null;
  try {
    const matSnap = await matRef.get();
    if (matSnap.exists) mat = matSnap.data();
  } catch (err) {
    console.warn(`[rebuildAiCompetencyAggregates] maturity load failed for ${aggregateId}`, err);
  }

  // Six area levels exactly as the school self-rated them. Never an
  // overall level; never Eduversal's (legacy) noted levels.
  const institutionalProfileShared = isSharedMaturityProfile(mat);
  const selfRatings = institutionalProfileShared ? (mat.domainRatings || {}) : {};
  const institutionalDomainLevels = AICF_MATURITY_DOMAINS
    .map((k) => validMaturityLevel(selfRatings?.[k]?.currentLevel));
  const institutionalDomainTargets = AICF_MATURITY_DOMAINS
    .map((k) => validMaturityLevel(selfRatings?.[k]?.targetLevel));

  // 3. Previous year — staff trend only (best-effort). No overall-level
  //    delta: there is no overall level to compare.
  const previousYear = previousAcademicYear(academicYear);
  let previousStaffPractitionerCount = null, practitionerDelta = null;
  if (previousYear) {
    try {
      const prevAgg = await db
        .collection("ai_competency_aggregates")
        .doc(`${schoolId}_${previousYear}`)
        .get();
      if (prevAgg.exists) {
        const pd = prevAgg.data();
        previousStaffPractitionerCount = pd.staffCounts?.practitioner ?? null;
        if (previousStaffPractitionerCount != null) {
          practitionerDelta = (staffCounts.practitioner || 0) - previousStaffPractitionerCount;
        }
      }
    } catch (err) {
      console.warn(`[rebuildAiCompetencyAggregates] previous-year lookup failed for ${aggregateId}`, err);
    }
  }

  const payload = {
    scopeKind: "school",
    aggregateShapeVersion: AICF_AGGREGATE_SHAPE_VERSION,
    schoolId,
    academicYear,
    staffCounts,
    submissionRate,
    pendingValidationCount: pendingValidation,
    medianDaysToValidation,
    institutionalProfileShared,
    institutionalStatus: mat?.status || null,
    institutionalDomainLevels,
    institutionalDomainTargets,
    previousStaffPractitionerCount,
    practitionerDelta,
    recomputedAt: admin.firestore.FieldValue.serverTimestamp(),
    recomputedBy: "rebuildAiCompetencyAggregates",
  };

  await db.collection("ai_competency_aggregates").doc(aggregateId).set(payload, { merge: true });
  console.log(`[rebuildAiCompetencyAggregates] wrote school aggregate ${aggregateId} (profile shared ${institutionalProfileShared}, area levels ${JSON.stringify(institutionalDomainLevels)}, staff ${JSON.stringify(staffCounts)})`);
}

async function recomputeNetworkAggregate(academicYear) {
  const aggregateId = `network_${academicYear}`;

  // Load all school-level aggregates for this year (school-level only).
  // Network doc is computed FROM the school docs, so school recomputation
  // must complete first; the schedule trigger orders this naturally.
  const aggsSnap = await db
    .collection("ai_competency_aggregates")
    .where("academicYear", "==", academicYear)
    .where("scopeKind", "==", "school")
    .get();

  const staffTotals = { foundation: 0, practitioner: 0, leader: 0, unsubmitted: 0 };
  // Per-area distribution: how many shared school profiles sit at each
  // self-rated level, per area. Counts only — no schoolIds, no order, so
  // nothing here can rank a school (AICF 26-27 "Benchmarking and Reporting").
  const emptyDist = () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, notRated: 0 });
  const domainLevelDistribution = {};
  const domainTargetDistribution = {};
  for (const k of AICF_MATURITY_DOMAINS) {
    domainLevelDistribution[k] = emptyDist();
    domainTargetDistribution[k] = emptyDist();
  }
  let schoolsWithSharedProfile = 0;
  let schoolsWithoutSharedProfile = 0;

  aggsSnap.docs.forEach((d) => {
    const data = d.data() || {};
    for (const k of ["foundation", "practitioner", "leader", "unsubmitted"]) {
      staffTotals[k] += (data.staffCounts?.[k] || 0);
    }
    // Only school docs already in the v2 shape carry self-rated levels
    // for shared profiles; a v1 doc's institutionalDomainLevels may hold
    // Eduversal's legacy noted levels, so it is skipped until recomputed.
    const shared = data.aggregateShapeVersion >= AICF_AGGREGATE_SHAPE_VERSION
      && data.institutionalProfileShared === true;
    if (!shared) {
      schoolsWithoutSharedProfile += 1;
      return;
    }
    schoolsWithSharedProfile += 1;
    const levels = Array.isArray(data.institutionalDomainLevels) ? data.institutionalDomainLevels : [];
    const targets = Array.isArray(data.institutionalDomainTargets) ? data.institutionalDomainTargets : [];
    AICF_MATURITY_DOMAINS.forEach((k, i) => {
      const lv = validMaturityLevel(levels[i]);
      domainLevelDistribution[k][lv ?? "notRated"] += 1;
      const tg = validMaturityLevel(targets[i]);
      domainTargetDistribution[k][tg ?? "notRated"] += 1;
    });
  });

  const payload = {
    scopeKind: "network",
    aggregateShapeVersion: AICF_AGGREGATE_SHAPE_VERSION,
    academicYear,
    staffCounts: staffTotals,
    schoolsWithSharedProfile,
    schoolsWithoutSharedProfile,
    domainLevelDistribution,
    domainTargetDistribution,
    recomputedAt: admin.firestore.FieldValue.serverTimestamp(),
    recomputedBy: "rebuildAiCompetencyAggregates",
  };
  await db.collection("ai_competency_aggregates").doc(aggregateId).set(payload, { merge: true });
  console.log(`[rebuildAiCompetencyAggregates] wrote network aggregate ${aggregateId} (${aggsSnap.size} school docs, ${schoolsWithSharedProfile} shared profiles)`);
}

function previousAcademicYear(year) {
  // "2026-2027" → "2025-2026"
  const m = /^(\d{4})-(\d{4})$/.exec(year);
  if (!m) return null;
  const start = parseInt(m[1], 10) - 1;
  return `${start}-${start + 1}`;
}

// Weekly full rebuild (Mondays 02:00 Asia/Jakarta).
exports.rebuildAiCompetencyAggregates = onSchedule(
  {
    schedule: "0 2 * * 1",
    timeZone: "Asia/Jakarta",
    region: "asia-southeast1",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    console.log("[rebuildAiCompetencyAggregates] weekly run started");

    // Discover (schoolId, academicYear) pairs from both source collections.
    const pairs = new Map();
    const addPair = (sid, ay) => { if (sid && ay) pairs.set(`${sid}_${ay}`, { schoolId: sid, academicYear: ay }); };

    const staffSnap = await db.collection("ai_competency_self_assessments").select("schoolId", "academicYear").get();
    staffSnap.docs.forEach((d) => addPair(d.data().schoolId, d.data().academicYear));

    const matSnap = await db.collection("ai_maturity_assessments").select("schoolId", "academicYear").get();
    matSnap.docs.forEach((d) => addPair(d.data().schoolId, d.data().academicYear));

    console.log(`[rebuildAiCompetencyAggregates] recomputing ${pairs.size} school-year aggregates`);
    for (const { schoolId, academicYear } of pairs.values()) {
      try {
        await recomputeSchoolAggregate(schoolId, academicYear);
      } catch (err) {
        console.error(`[rebuildAiCompetencyAggregates] school recompute failed: ${schoolId} ${academicYear}`, err);
      }
    }

    // Now network-level rebuild — one per distinct academic year.
    const years = new Set([...pairs.values()].map((p) => p.academicYear));
    for (const y of years) {
      try {
        await recomputeNetworkAggregate(y);
      } catch (err) {
        console.error(`[rebuildAiCompetencyAggregates] network recompute failed: ${y}`, err);
      }
    }

    console.log("[rebuildAiCompetencyAggregates] weekly run done");
  }
);

// On-demand: recompute one school when its maturity profile changes in a
// way the aggregate sees — the status moves (draft → submitted when the
// school marks it final, submitted → 'appraised' when Eduversal adds notes,
// or back), or the self-rated area levels change on a shared profile.
// The function name is kept (renaming a deployed function deletes it).
exports.onMaturityAppraisalWritten = onDocumentWritten(
  {
    document: "ai_maturity_assessments/{docId}",
    region: "asia-southeast1",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const before = event.data?.before?.data?.() || null;
    const after  = event.data?.after?.data?.()  || null;
    if (!after) return; // delete — skip
    const levelsOf = (m) => JSON.stringify(AICF_MATURITY_DOMAINS.map((k) => [
      m?.domainRatings?.[k]?.currentLevel ?? null,
      m?.domainRatings?.[k]?.targetLevel ?? null,
    ]));
    const statusChanged = (before?.status || null) !== (after.status || null);
    const sharedLevelsChanged = isSharedMaturityProfile(after) && levelsOf(before) !== levelsOf(after);
    if (!statusChanged && !sharedLevelsChanged) return;
    // A draft that stays a draft changes nothing in the aggregate.
    if (!isSharedMaturityProfile(before) && !isSharedMaturityProfile(after)) return;
    const { schoolId, academicYear } = after;
    if (!schoolId || !academicYear) return;
    try {
      await recomputeSchoolAggregate(schoolId, academicYear);
      await recomputeNetworkAggregate(academicYear);
    } catch (err) {
      console.error(`[onMaturityAppraisalWritten] recompute failed for ${schoolId}_${academicYear}`, err);
    }
  }
);

// ───────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────
// Monday-of-week key in the Asia/Jakarta calendar (2026-08-01 fix — the
// old version used the container's UTC calendar, misfiling Monday-early-
// morning WIB entries into the previous week). Uses the fixed +7h offset
// trick (see JAKARTA_OFFSET_MS by awardPoints).
function isoWeekStart(d) {
  const date = new Date(new Date(d).getTime() + JAKARTA_OFFSET_MS);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return date.toISOString().slice(0, 10);
}

// ───────────────────────────────────────────────────────────────
// ASK EDUVERSAL — askEduversal (2026-06-27)
//   RAG Q&A agent over the indexed reference corpus (ES + handbooks +
//   frameworks + Cambridge + Permendiknas + AICF). Embeddings retrieval
//   (Cohere embed-v4.0, 256-dim) + grounded Claude generation with
//   server-side citation validation. Corpus lives in Firestore
//   ask_chunks/{id} (seeded by scripts/ask/seed-ask-chunks.js); this
//   function caches the chunk VECTORS in module memory across warm
//   invocations and reads the matched chunks' TEXT per question.
//
//   Secrets: COHERE_API_KEY (embeddings) + ANTHROPIC_API_KEY (generation).
//   Auth: signed-in central_user/admin (page-access on /ask is the UI gate).
//   Anti-hallucination: system rule grounds every claim to a retrieved
//   chunk; citations validated against the retrieved set before return;
//   no chunk → "not found", never answered from general knowledge.
//
//   Schema: docs/architecture/FIRESTORE_SCHEMA.md (Ask Eduversal block).
//   Plan: docs/architecture/ASK-EDUVERSAL-RETRIEVAL-SUBPLAN.md
// ───────────────────────────────────────────────────────────────

const cohereApiKey = defineSecret("COHERE_API_KEY");
// Shared with the archived practiceBankAiSuggest until 2026-10-02; askEduversal
// is now its only user.
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const ASK_DEFAULT_MODEL = "claude-sonnet-4-6";
const ASK_ALLOWED_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-7",
]);
const ASK_TOP_K = 12;            // chunks fed to the model
const ASK_CACHE_TTL_HOURS = 24;
const ASK_EMBED_MODEL = "embed-v4.0";
const ASK_EMBED_DIMS = 256;

// Per-1M-token USD pricing for the answer cost line shown to users + audit.
// Claude prices from the claude-api reference (cached 2026-06); Cohere
// embed-v4 from public pricing. Update if Anthropic/Cohere change rates.
// (Anthropic model id → {in, out}; embed is the per-query Cohere cost.)
const ASK_MODEL_PRICES = {
  "claude-sonnet-4-6":        { in: 3.00,  out: 15.00 },
  "claude-haiku-4-5-20251001":{ in: 1.00,  out: 5.00  },
  "claude-opus-4-7":          { in: 5.00,  out: 25.00 },
};
const ASK_EMBED_PRICE_PER_M = 0.12; // Cohere embed-v4 per 1M tokens
// Compute the USD cost of one answer from token usage. Returns a number
// (USD), rounded to 6 dp. Query-embed cost is a fixed tiny estimate (the
// query is ~tens of tokens; Cohere doesn't return per-call token counts).
function askComputeCostUsd(model, tokenUsage) {
  const p = ASK_MODEL_PRICES[model] || ASK_MODEL_PRICES[ASK_DEFAULT_MODEL];
  const inCost  = ((tokenUsage.input  || 0) / 1e6) * p.in;
  const outCost = ((tokenUsage.output || 0) / 1e6) * p.out;
  const embedCost = (40 / 1e6) * ASK_EMBED_PRICE_PER_M; // ~40-token query
  return Math.round((inCost + outCost + embedCost) * 1e6) / 1e6;
}

// Module-level vector cache (survives warm invocations).
let _askVecCache = null;       // [{ chunkId, ref, title, docId, source, deepLink, embedding:Float32Array }]
let _askVecFingerprint = null; // ask_meta.corpusFingerprint the cache was built against

async function loadAskVectors(db) {
  // Cheap freshness check: re-load only if the corpus fingerprint changed.
  let metaFp = null;
  try {
    const meta = await db.collection("ask_meta").doc("current").get();
    metaFp = meta.exists ? (meta.data() || {}).corpusFingerprint || null : null;
  } catch (_) { /* fall through — use stale cache if present */ }

  if (_askVecCache && _askVecFingerprint && _askVecFingerprint === metaFp) {
    return _askVecCache;
  }

  // Load vectors (NOT text) for every chunk.
  const snap = await db.collection("ask_chunks")
    .select("ref", "title", "docId", "source", "deepLink", "embedding")
    .get();
  const cache = [];
  snap.forEach(d => {
    const x = d.data() || {};
    if (!Array.isArray(x.embedding) || !x.embedding.length) return;
    cache.push({
      chunkId: d.id,
      ref: x.ref || d.id,
      title: x.title || x.ref || d.id,
      docId: x.docId || null,
      source: x.source || null,
      deepLink: x.deepLink || "references",
      embedding: Float32Array.from(x.embedding),
    });
  });
  _askVecCache = cache;
  _askVecFingerprint = metaFp;
  return cache;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedQueryCohere(apiKey, text) {
  const { CohereClientV2 } = require("cohere-ai");
  const cohere = new CohereClientV2({ token: apiKey });
  const resp = await cohere.embed({
    model: ASK_EMBED_MODEL,
    inputType: "search_query",
    outputDimension: ASK_EMBED_DIMS,
    embeddingTypes: ["float"],
    texts: [text],
  });
  const floats = (resp.embeddings && (resp.embeddings.float || resp.embeddings.float_)) || [];
  if (!floats.length) throw new Error("Cohere returned no query embedding.");
  return Float32Array.from(floats[0]);
}

function buildAskPrompt(question, chunks) {
  const sources = chunks.map((c, i) =>
    `[Source ${i + 1}] ref="${c.ref}" (${c.source})\n${c.text}`).join("\n\n");
  return `You are "Ask Eduversal", a careful assistant that answers staff questions ONLY from Eduversal's own indexed policy and handbook documents. You are answering for Eduversal HQ + partner-school staff.

RULES — follow exactly:
1. Answer ONLY using the SOURCES below. Do NOT use outside/general knowledge.
2. If the sources do not contain the answer, say so plainly ("The indexed documents don't define this") and, if there is a related policy, name it. NEVER invent a policy, a number, a frequency, or a citation.
3. Cite the source ref for every factual claim, inline, like (ES 7.3) or (Director · Overview). Only cite refs that appear in the SOURCES below.
4. Keep the answer concise, plain English (the audience includes ESL readers). Use short paragraphs or bullets.
5. End with a one-line "Sources:" list of the refs you actually used.

QUESTION:
${question}

SOURCES:
${sources}`;
}

exports.askEduversal = onCall(
  {
    region: "asia-southeast1",
    secrets: [cohereApiKey, anthropicApiKey],
    cors: true,
    timeoutSeconds: 60,
    memory: "1GiB",
  },
  async (request) => {
    const t0 = Date.now();
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const uid = request.auth.uid;
    const userSnap = await db.collection("users").doc(uid).get();
    const u = userSnap.exists ? userSnap.data() : null;
    const isAdmin = u?.role_centralhub === "central_admin";
    // Approval gate (2026-08-01): auto-provisioned central_user counts only
    // once central_admin approves — mirrors the firestore.rules helpers.
    const isCentralUser = u?.role_centralhub === "central_user"
      && u?.approval_status_centralhub === "approved";
    if (!(isAdmin || isCentralUser)) {
      throw new HttpsError("permission-denied", "Requires CH admin or central_user.");
    }
    // Spend throttle — each cache-miss answer costs real Anthropic+Cohere
    // money and the cache is trivially bypassed by rephrasing (2026-08-01).
    if (!isAdmin) {
      await enforcePerUserRateLimit("askEduversal", uid, 20, 100);
    }

    const data = request.data || {};
    const question = String(data.question || "").trim().slice(0, 600);
    if (question.length < 3) {
      throw new HttpsError("invalid-argument", "Ask a question (3+ chars).");
    }
    // Opus is admin-only (client-controlled param, 5-8× Sonnet pricing).
    const requestedModel = String(data.model || ASK_DEFAULT_MODEL);
    const model = (ASK_ALLOWED_MODELS.has(requestedModel)
      && (isAdmin || requestedModel !== "claude-opus-4-7"))
      ? requestedModel : ASK_DEFAULT_MODEL;

    // Corpus fingerprint (for cache key + freshness).
    let corpusFp = "none";
    try {
      const meta = await db.collection("ask_meta").doc("current").get();
      corpusFp = (meta.exists && (meta.data() || {}).corpusFingerprint) || "none";
    } catch (_) { /* tolerate */ }

    // Answer cache (24h, keyed on normalised question + corpus fingerprint).
    const normQ = question.toLowerCase().replace(/\s+/g, " ").trim();
    const cacheKey = (await sha256Hex(JSON.stringify({ normQ, model, corpusFp }))).slice(0, 40);
    const nowMs = Date.now();
    const cacheRef = db.collection("ask_cache").doc(cacheKey);
    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      const c = cacheSnap.data() || {};
      if ((c.expiresAt?.toMillis?.() || 0) > nowMs && c.answer) {
        await db.collection("ask_audit").add({
          actorUid: uid, actorEmail: u?.email || request.auth.token?.email || null,
          question, retrievedRefs: c.citations?.map(x => x.ref) || [],
          citations: c.citations || [], model: c.model || model,
          tokenUsage: { input: 0, output: 0, total: 0 },
          costUsd: 0, originalCostUsd: c.costUsd || 0,
          latencyMs: Date.now() - t0, cacheHit: true, error: null,
          at: admin.firestore.FieldValue.serverTimestamp(),
        });
        return {
          answer: c.answer, citations: c.citations || [], usedChunkIds: c.usedChunkIds || [],
          cacheHit: true, model: c.model || model, tokenUsage: { input: 0, output: 0, total: 0 },
          costUsd: 0, originalCostUsd: c.costUsd || 0,
        };
      }
    }

    // 1. Retrieve — embed the question, cosine over cached vectors, top-K.
    const cohereKey = cohereApiKey.value();
    if (!cohereKey) throw new HttpsError("failed-precondition", "COHERE_API_KEY secret not set.");
    const vectors = await loadAskVectors(db);
    if (!vectors.length) {
      throw new HttpsError("failed-precondition",
        "Knowledge pool is empty — run scripts/ask/seed-ask-chunks.js --apply.");
    }
    const qVec = await embedQueryCohere(cohereKey, question);
    const scored = vectors.map(v => ({ v, s: cosine(qVec, v.embedding) }));
    scored.sort((a, b) => b.s - a.s);
    const top = scored.slice(0, ASK_TOP_K).map(x => x.v);

    // 2. Pull TEXT for the top-K chunks (the only per-question corpus read).
    const refs = await db.getAll(...top.map(t => db.collection("ask_chunks").doc(t.chunkId)));
    const chunks = refs.map((snap, i) => {
      const x = snap.exists ? snap.data() : {};
      return {
        chunkId: top[i].chunkId, ref: x.ref || top[i].ref, title: x.title || top[i].title,
        docId: x.docId || top[i].docId, source: x.source || top[i].source,
        deepLink: x.deepLink || top[i].deepLink, text: x.text || "",
      };
    }).filter(c => c.text);

    if (!chunks.length) {
      throw new HttpsError("internal", "Retrieval matched no readable chunks.");
    }

    // 3. Generate — grounded Claude call.
    const anthKey = anthropicApiKey.value();
    if (!anthKey) throw new HttpsError("failed-precondition", "ANTHROPIC_API_KEY secret not set.");
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic.default({ apiKey: anthKey });

    let answer = "", tokenUsage = { input: 0, output: 0, total: 0 }, errorMsg = null;
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: 900,
        messages: [{ role: "user", content: buildAskPrompt(question, chunks) }],
      });
      const textBlock = (resp.content || []).find(b => b.type === "text");
      answer = (textBlock?.text || "").trim();
      tokenUsage = {
        input: resp.usage?.input_tokens || 0,
        output: resp.usage?.output_tokens || 0,
        total: (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0),
      };
    } catch (err) {
      errorMsg = String(err?.message || err);
    }

    // 4. Citation validation — keep only refs that were actually retrieved.
    const retrievedRefs = chunks.map(c => c.ref);
    const retrievedSet = new Set(retrievedRefs);
    const citedInAnswer = new Set();
    // Match any "(ref)" the model emitted against the retrieved refs.
    for (const c of chunks) {
      if (answer.includes(c.ref)) citedInAnswer.add(c.ref);
    }
    const citations = chunks
      .filter(c => citedInAnswer.has(c.ref))
      .map(c => ({ ref: c.ref, title: c.title, docId: c.docId, source: c.source, deepLink: c.deepLink }));

    // 5. Persist cache + audit.
    const costUsd = errorMsg ? 0 : askComputeCostUsd(model, tokenUsage);
    if (!errorMsg && answer) {
      const ttlMs = ASK_CACHE_TTL_HOURS * 3600 * 1000;
      await cacheRef.set({
        answer, citations, usedChunkIds: chunks.map(c => c.chunkId), model,
        tokenUsage, costUsd,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + ttlMs),
      });
    }
    const auditRef = await db.collection("ask_audit").add({
      actorUid: uid, actorEmail: u?.email || request.auth.token?.email || null,
      question, retrievedRefs, citations, model, tokenUsage, costUsd,
      latencyMs: Date.now() - t0, cacheHit: false, error: errorMsg,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (errorMsg) {
      throw new HttpsError("internal", `Answer generation failed: ${errorMsg}`, { auditId: auditRef.id });
    }

    return {
      answer, citations, usedChunkIds: chunks.map(c => c.chunkId),
      cacheHit: false, model, tokenUsage, costUsd, auditId: auditRef.id,
    };
  }
);

// ───────────────────────────────────────────────────────────────
// mailRelay — server-side relay to the Resend mail-service (2026-08-01)
//
//   Why: MAIL_SERVICE_SECRET used to be shipped to the browser via
//   dist/firebase-config.js (build.js env substitution). Anyone viewing
//   source on any CH/TH page could lift the bearer token and call
//   /send-campaign against the network address book. This relay keeps
//   the secret in Secret Manager; clients call the relay with their
//   Firebase ID token (or anonymously, for the single public careers
//   confirmation path) and the relay forwards to Railway.
//
//   Actions (request.data.action):
//     'transactional'        — any signed-in user (all 4 hubs share the
//                              Firebase project). Rate-limited per uid.
//                              Forwards to POST /send-transactional.
//     'applicationReceived'  — UNAUTHENTICATED, for the public TH
//                              /careers-apply confirmation only.
//                              templateName is pinned server-side and a
//                              global anon bucket caps volume.
//     'campaign' | 'test'    — central_admin only (mail-composer).
//                              Forwards to /send-campaign | /send-test.
//     'get'                  — central_admin only. GET passthrough
//                              limited to /recipients + /campaigns[/id].
//
//   Secret: MAIL_SERVICE_SECRET (Secret Manager — set with
//   `firebase functions:secrets:set MAIL_SERVICE_SECRET`).
// ───────────────────────────────────────────────────────────────
const mailServiceSecret = defineSecret("MAIL_SERVICE_SECRET");
const MAIL_SERVICE_BASE =
  (process.env.MAIL_SERVICE_URL || "https://mail-service-production-e9e7.up.railway.app")
    .replace(/\/$/, "");

function mailRelayValidateTransactional(p) {
  const toEmail = String(p.toEmail || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail) || toEmail.length > 200) {
    throw new HttpsError("invalid-argument", "Invalid toEmail.");
  }
  const subject = String(p.subject || "").trim();
  if (!subject || subject.length > 300) {
    throw new HttpsError("invalid-argument", "Subject required (≤300 chars).");
  }
  const bodyHtml = String(p.bodyHtml || "");
  if (!bodyHtml.trim() || bodyHtml.length > 120000) {
    throw new HttpsError("invalid-argument", "bodyHtml required (≤120k chars).");
  }
  const out = { toEmail, subject, bodyHtml };
  if (p.toName)     out.toName     = String(p.toName).slice(0, 200);
  if (p.replyTo)    out.replyTo    = String(p.replyTo).slice(0, 200);
  if (p.footerNote) out.footerNote = String(p.footerNote).slice(0, 500);
  if (typeof p.templateName === "string") out.templateName = p.templateName.slice(0, 40);
  if (Array.isArray(p.tags)) {
    out.tags = p.tags.slice(0, 10).map(t => ({
      name: String(t?.name || "").slice(0, 60),
      value: String(t?.value || "").slice(0, 120),
    }));
  }
  return out;
}

async function mailRelayForward(method, path, body) {
  const secret = mailServiceSecret.value();
  if (!secret) {
    throw new HttpsError("failed-precondition", "MAIL_SERVICE_SECRET secret not set.");
  }
  const res = await fetch(MAIL_SERVICE_BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + secret,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new HttpsError("internal", `mail-service ${res.status}`, { status: res.status, body: data });
  }
  return data;
}

exports.mailRelay = onCall(
  {
    region: "asia-southeast1",
    secrets: [mailServiceSecret],
    cors: true,
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (request) => {
    const action = String(request.data?.action || "");
    const payload = request.data?.payload || {};

    // Public path: careers-apply confirmation (candidate is NOT signed in
    // at submit time). Template pinned; global anon bucket caps abuse.
    if (action === "applicationReceived") {
      await enforcePerUserRateLimit("mailRelayAnon", "application_received", 30, 200);
      const clean = mailRelayValidateTransactional(payload);
      clean.templateName = "application_received";
      return await mailRelayForward("POST", "/send-transactional", clean);
    }

    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const uid = request.auth.uid;

    if (action === "transactional") {
      const userSnap = await db.collection("users").doc(uid).get();
      const isAdmin = userSnap.exists
        && userSnap.data()?.role_centralhub === "central_admin";
      if (!isAdmin) {
        await enforcePerUserRateLimit("mailRelayTx", uid, 30, 200);
      }
      const clean = mailRelayValidateTransactional(payload);
      return await mailRelayForward("POST", "/send-transactional", clean);
    }

    // Everything below is mail-composer tooling — central_admin only.
    const userSnap = await db.collection("users").doc(uid).get();
    const isAdmin = userSnap.exists
      && userSnap.data()?.role_centralhub === "central_admin";
    if (!isAdmin) {
      throw new HttpsError("permission-denied", "Requires central_admin.");
    }

    if (action === "campaign") {
      return await mailRelayForward("POST", "/send-campaign", payload);
    }
    if (action === "test") {
      return await mailRelayForward("POST", "/send-test", payload);
    }
    if (action === "get") {
      const path = String(request.data?.path || "");
      const ok = path === "/recipients"
        || path.startsWith("/recipients?")
        || path === "/campaigns"
        || /^\/campaigns\/[A-Za-z0-9._-]+$/.test(path);
      if (!ok) {
        throw new HttpsError("invalid-argument", `Path not allowed: ${path}`);
      }
      return await mailRelayForward("GET", path, null);
    }

    throw new HttpsError("invalid-argument", `Unknown action: ${action}`);
  }
);
