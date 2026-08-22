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

    await awardPoints(studentUid, points, { counter, eventId: event.id });

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

// ── Per-user rate limiting (2026-08-01 pre-launch hardening) ──
// Firestore-transaction token bucket shared by the three abusable
// callables (easeBankProxy / practiceBankAiSuggest / askEduversal).
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
    // Approval gate (2026-08-01): auto-provisioned central_user counts only
    // once central_admin approves — mirrors the firestore.rules helpers.
    const isCentralUser = u?.role_centralhub === "central_user"
      && u?.approval_status_centralhub === "approved";
    const subRoles = Array.isArray(u?.ch_sub_roles) ? u.ch_sub_roles : [];
    // Page-access UI is the sole gate since 2026-05-20 — any signed-in
    // central_user who reaches /practice-assessment-author can run the
    // AI suggest. Sub-role hierarchy removed.
    if (!(isAdmin || isCentralUser)) {
      throw new HttpsError("permission-denied",
        "Requires CH admin or central_user.");
    }
    // Spend throttle — Anthropic calls cost real money and the auth gate
    // above is auto-provisioned on first sign-in (2026-08-01 hardening).
    if (!isAdmin) {
      await enforcePerUserRateLimit("practiceBankAiSuggest", uid, 20, 100);
    }
    // For audit log: serialise the actor's effective role string. Admin
    // takes precedence; otherwise list sub-roles (or 'central_user' for
    // plain users with no sub-role assigned).
    const actorRole = isAdmin
      ? "central_admin"
      : (subRoles.length ? subRoles.join(",") : "central_user");

    const data = request.data || {};
    const subjectId = String(data.subjectId || "").trim();
    if (!["math", "english", "science"].includes(subjectId)) {
      throw new HttpsError("invalid-argument",
        `subjectId must be math/english/science (got ${subjectId})`);
    }
    // Subject-specialty gate: non-admin central_user constrained to subjects
    // in their ch_subjects[]. Applies uniformly across sub-roles since
    // 2026-05-20 (director no longer bypasses).
    if (!isAdmin) {
      const chSubjects = Array.isArray(u?.ch_subjects) ? u.ch_subjects : [];
      if (!chSubjects.includes(subjectId)) {
        throw new HttpsError("permission-denied",
          `central_user not entitled to subject ${subjectId}`);
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
    // Opus is admin-only: it is 5-8× Sonnet's price and the model param is
    // client-controlled — non-admins silently fall back to the default.
    const requestedModel = String(data.model || PRACTICE_AI_DEFAULT_MODEL);
    const model = (PRACTICE_AI_ALLOWED_MODELS.has(requestedModel)
      && (isAdmin || requestedModel !== "claude-opus-4-7"))
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
        actorRole,
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
          actorRole,
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
      actorRole,
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
// AICF PHASE 3 — rebuildAiCompetencyAggregates (2026-05-18)
//   Walks ai_competency_self_assessments + ai_maturity_assessments
//   for each (schoolId, academicYear) pair and writes summary docs
//   to ai_competency_aggregates/{schoolId}_{academicYear} and one
//   network-wide ai_competency_aggregates/network_{academicYear}.
//
//   Two triggers:
//     (a) Weekly schedule (Mondays 02:00 Asia/Jakarta) — full rebuild.
//     (b) onDocumentWritten on ai_maturity_assessments — partial
//         rebuild when a single school flips to 'appraised'.
//
//   Schema: docs/architecture/FIRESTORE_SCHEMA.md §24
//   (ai_competency_aggregates).
//
//   Admin SDK bypasses rules — aggregate docs are Cloud-Function-only
//   writers per the rule block.
// ───────────────────────────────────────────────────────────────

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

  const staffCounts = { foundation: 0, practitioner: 0, leader: 0, unsubmitted: 0 };
  let validationLagSum = 0, validationLagN = 0, pendingValidation = 0, submittedCount = 0;

  staffSnap.docs.forEach((d) => {
    const data = d.data() || {};
    if (data.status === "submitted") {
      pendingValidation += 1;
      submittedCount += 1;
    }
    if (data.status === "validated") {
      submittedCount += 1;
      const agreed = data?.validation?.agreedLevel || data.selfDeclaredLevel;
      if (agreed && Object.prototype.hasOwnProperty.call(staffCounts, agreed)) {
        staffCounts[agreed] += 1;
      }
      // Validation lag (submittedAt → validatedAt)
      const sub = data.submittedAt?.toMillis?.();
      const val = data?.validation?.validatedAt?.toMillis?.();
      if (sub && val && val > sub) {
        validationLagSum += (val - sub);
        validationLagN += 1;
      }
    }
    if (data.status === "draft" || !data.status) {
      // We don't count drafts as 'unsubmitted staff' here because we
      // can't tell the eligible-staff denominator without a separate
      // staff roster query. Field is left for future expansion.
    }
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

  let institutionalCurrentLevel = null;
  let institutionalDomainLevels = [];
  let institutionalAppraised = false;
  if (mat) {
    institutionalAppraised = mat.status === "appraised";
    const ratings = institutionalAppraised
      ? (mat.appraisal?.validatedDomainRatings || mat.domainRatings || {})
      : (mat.domainRatings || {});
    institutionalCurrentLevel = institutionalAppraised
      ? (mat.appraisal?.validatedOverallLevel ?? mat.overallLevel ?? null)
      : (mat.overallLevel ?? null);
    institutionalDomainLevels = [
      "strategy_leadership","policy_compliance","staff_capability",
      "teaching_learning","student_outcomes","infrastructure_resources"
    ].map((k) => ratings?.[k]?.currentLevel ?? null);
  }

  // 3. Look up the previous year for trend (best-effort).
  const previousYear = previousAcademicYear(academicYear);
  let previousOverallLevel = null, levelDelta = null;
  let previousStaffPractitionerCount = null, practitionerDelta = null;
  if (previousYear) {
    try {
      const prevAgg = await db
        .collection("ai_competency_aggregates")
        .doc(`${schoolId}_${previousYear}`)
        .get();
      if (prevAgg.exists) {
        const pd = prevAgg.data();
        previousOverallLevel = pd.institutionalCurrentLevel ?? null;
        previousStaffPractitionerCount = pd.staffCounts?.practitioner ?? null;
        if (institutionalCurrentLevel != null && previousOverallLevel != null) {
          levelDelta = institutionalCurrentLevel - previousOverallLevel;
        }
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
    schoolId,
    academicYear,
    staffCounts,
    submissionRate,
    pendingValidationCount: pendingValidation,
    medianDaysToValidation,
    institutionalCurrentLevel,
    institutionalDomainLevels,
    institutionalAppraised,
    previousOverallLevel,
    levelDelta,
    previousStaffPractitionerCount,
    practitionerDelta,
    recomputedAt: admin.firestore.FieldValue.serverTimestamp(),
    recomputedBy: "rebuildAiCompetencyAggregates",
  };

  await db.collection("ai_competency_aggregates").doc(aggregateId).set(payload, { merge: true });
  console.log(`[rebuildAiCompetencyAggregates] wrote school aggregate ${aggregateId} (institutional level ${institutionalCurrentLevel}, staff ${JSON.stringify(staffCounts)})`);
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
  const schoolsByMaturityLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, unknown: 0 };
  // Per-domain levels collected for median later
  const domainSamples = [[], [], [], [], [], []]; // 6 domains, index 0-5
  const perDomainTop = [[], [], [], [], [], []];

  aggsSnap.docs.forEach((d) => {
    const data = d.data() || {};
    for (const k of ["foundation", "practitioner", "leader", "unsubmitted"]) {
      staffTotals[k] += (data.staffCounts?.[k] || 0);
    }
    const lvl = data.institutionalCurrentLevel;
    if (lvl >= 1 && lvl <= 5) {
      schoolsByMaturityLevel[lvl] += 1;
    } else {
      schoolsByMaturityLevel.unknown += 1;
    }
    const domains = Array.isArray(data.institutionalDomainLevels) ? data.institutionalDomainLevels : [];
    for (let i = 0; i < 6; i++) {
      const v = domains[i];
      if (typeof v === "number" && v >= 1 && v <= 5) {
        domainSamples[i].push(v);
        perDomainTop[i].push({ schoolId: data.schoolId, level: v });
      }
    }
  });

  const networkDomainMedian = domainSamples.map((arr) => median(arr));
  const domainNames = [
    "strategy_leadership","policy_compliance","staff_capability",
    "teaching_learning","student_outcomes","infrastructure_resources"
  ];
  const topSchoolsByDomain = {};
  const bottomSchoolsByDomain = {};
  for (let i = 0; i < 6; i++) {
    const sorted = perDomainTop[i].slice().sort((a, b) => b.level - a.level);
    topSchoolsByDomain[domainNames[i]] = sorted.slice(0, 3).map((s) => s.schoolId);
    bottomSchoolsByDomain[domainNames[i]] = sorted.slice(-3).reverse().map((s) => s.schoolId);
  }

  const payload = {
    scopeKind: "network",
    academicYear,
    staffCounts: staffTotals,
    schoolsByMaturityLevel,
    networkDomainMedian,
    topSchoolsByDomain,
    bottomSchoolsByDomain,
    recomputedAt: admin.firestore.FieldValue.serverTimestamp(),
    recomputedBy: "rebuildAiCompetencyAggregates",
  };
  await db.collection("ai_competency_aggregates").doc(aggregateId).set(payload, { merge: true });
  console.log(`[rebuildAiCompetencyAggregates] wrote network aggregate ${aggregateId} (${aggsSnap.size} schools, ${JSON.stringify(schoolsByMaturityLevel)})`);
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
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

// On-demand: recompute one school when its maturity doc flips to 'appraised'.
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
    const flippedToAppraised = (after.status === "appraised") && (!before || before.status !== "appraised");
    if (!flippedToAppraised) return;
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
