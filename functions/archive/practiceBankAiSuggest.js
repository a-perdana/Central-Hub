// ARCHIVED 2026-10-02 (Alif): the Practice Assessment AI composer is retired.
// Students Hub's daily challenges are now built straight from the active
// practice_questions pool per grade (rotateDailyChallenges), so AI-ranked
// practice_assessments are no longer needed. The page is in
// Central Hub/archive/practice-assessment/.
//
// This file is NOT required by index.js and is NOT deployed. It is the
// verbatim block that lived in index.js, kept for reference. Its data
// (practice_ai_audit, ai_suggestion_cache) was left in Firestore untouched.
// To revive: move the block back into index.js (it expects index.js's
// db, onCall, HttpsError, enforcePerUserRateLimit, crypto and the
// anthropicApiKey secret) and redeploy.

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
// const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");  // still defined in index.js (askEduversal)
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

