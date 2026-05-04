/**
 * Cloud Functions — centralhub-8727b
 *
 * Phase 5 (2026-05-04): three induction-module functions.
 *   1. onPulseWritten        — fires alarm on 2 consecutive low scores
 *   2. onJournalWritten      — maintains anonymous induction_journal_aggregates
 *   3. expireMentorCerts     — daily cron, sets active=false on expired certs
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
// HELPERS
// ───────────────────────────────────────────────────────────────
function isoWeekStart(d) {
  const date = new Date(d);
  const day = date.getDay() || 7;
  if (day !== 1) date.setHours(-24 * (day - 1));
  return date.toISOString().slice(0, 10);
}
