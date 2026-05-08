# Contributing — Firestore Rules

**Read this BEFORE adding a new collection, renaming a field, or writing a Firestore rule.**

This is the rule set for the shared `centralhub-8727b` Firebase project. The lint script (`npm run lint:firestore`) enforces a subset of these checks automatically; the rest is on you and the code reviewer.

> **Companion docs:**
> - [`FIRESTORE_SCHEMA.md`](FIRESTORE_SCHEMA.md) — the canonical schema (every collection + FK + index).
> - [`db-diagram.md`](db-diagram.md) — visual ER diagrams.
> - `Central Hub/firestore.rules` — the live rules being enforced.

---

## Golden rules (the ones the lint script checks)

These produce a hard error in `npm run lint:firestore`:

| Rule | Why |
|---|---|
| **No undocumented collections.** Every `collection(db, '...')` and `doc(db, '...')` call must reference a collection that's in `FIRESTORE_SCHEMA.md`. | Prevents accidental ad-hoc collections that bypass schema review. |
| **No undocumented collections in rules.** Every `match /COLLECTION/{...}` block in `firestore.rules` must have a corresponding card in `FIRESTORE_SCHEMA.md`. | Keeps rules and schema in lockstep. |
| **No banned field names** anywhere in `collection()` / `doc()` / payload literals: `uid:` (only allowed where the doc id IS the uid — see naming table below), `authorId:`, `timestamp:`. | Naming drift causes silent rule failures (`isAHUserAtSameSchool` etc. checks the wrong field). |
| **No unbounded `getDocs(collection(...))`** outside admin tooling. Either add `limit(N)`, `where(...)`, or annotate with `// @lint-allow-unbounded` (admin only). | A single dashboard load could pull 32k weekly_progress docs. |
| **No `allow read, write: if true`** in rules outside known-public collections (`orientation_*`, `pathwaySubmissions`, `certificate-verify`). | Public-by-default is a privacy footgun. |

---

## When you add a NEW collection

1. **Add a card to [`FIRESTORE_SCHEMA.md`](FIRESTORE_SCHEMA.md)** in the right domain section. Include:
   - **PK** (doc-id format — auto-id, composite key, or stable slug)
   - **Fields** with types and `→ FK` arrows
   - **FKs** (which other collections it points at)
   - **Writers** (who can `create` / `update` / `delete`)
   - **Read scope** (who can `get` / `list`)
   - **Indexes** if any composite query is needed
   - **Notes** for gotchas / denormalisation / history
2. **Update [`db-diagram.md`](db-diagram.md)** — add the entity to the relevant `erDiagram` block, label every relationship with the FK field name.
3. **Add an explicit `match` block in `Central Hub/firestore.rules`.** Without one the collection is **default-denied** for all clients (rules currently have no `match /{document=**}` catch-all by intent — every collection must be enumerated).
4. **If your collection needs composite queries**, add an index to `Central Hub/firestore.indexes.json` and deploy via `firebase deploy --only firestore:indexes`.
5. **Run `npm run lint:firestore`** before committing — it will tell you if anything's mismatched.
6. **Commit the schema/diagram/rules changes together** with the code that uses the collection. Splitting them across PRs is the #1 reason docs drift.

---

## Naming convention (enforced by lint)

| Concept | Field name | When |
|---|---|---|
| User reference | **`userId`** | Always when one doc references another user. |
| Owner doc id | **`uid`** | ONLY when the doc id IS the uid (e.g. `users/{uid}`, `userProgress/{uid}`, `user_competencies/{uid}`). Don't store `uid` as a payload field unless the doc id == that uid. |
| Authored content | **`authorUid`** | For topics, replies, comments. Never `authorId`. |
| Semantic role | `teacherUid`, `appraiserUid`, `observerUid`, `evaluatorUid`, `testerUid` | Where one doc has multiple user refs and the role matters. |
| Audit fields | `createdBy`, `respondedBy` | Workflow audit trails. |
| School FK | **`schoolId`** → `partner_schools/{id}` | Always pointer-style. |
| School display | `school` | Denormalised display name only. NEVER use as a key for queries or rules. |
| Subject | `subjectId` | Free-text key like `'math'`. |
| Period | `periodId` → `teacher_kpi_settings/{id}` | KPI evaluation periods. |
| Created timestamp | **`createdAt`** | Always `serverTimestamp()`. Never `timestamp` (legacy name). |
| Updated timestamp | `updatedAt` | Same convention. |

---

## Doc-ID patterns

Pick the one that matches your access pattern.

| Pattern | When to use | Example |
|---|---|---|
| **Auto-id** | Many records per "owner", no natural unique key, no need for clients to construct the id | `announcements/{id}`, `topics/{id}` |
| **Composite key** | Strict 1-per-(user, scope) and clients must construct the id deterministically (`getDoc` without `list`) | `teacher_kpi_submissions/{userId}_{periodId}` |
| **Stable slug** | Human-readable lookup, often shared across apps | `cambridge_syllabus/0580_C1.1`, `page_access_config/cambridge-exams` |

---

## Rule writing checklist

When you add or modify a `match` block:

- [ ] Use **`isAuthorized()`** as the floor (signed in + allowed domain), never `isSignedIn()` alone.
- [ ] Separate `get` and `list` if the read patterns differ. `list` is dangerous — it means "anyone can dump the whole collection".
- [ ] For same-school checks, use the **`isAHUserAtSameSchool(targetUid)`** helper. Don't reimplement it inline.
- [ ] If a sub-role gates the rule, list the exact sub-role values (`['school_principal', 'academic_coordinator']`). Don't pattern-match.
- [ ] If you write `isTeachersUser()` / `isAcademicUser()` etc., **also** check the resource (e.g. `resource.data.userId == request.auth.uid`) — role alone is too broad.
- [ ] Don't rely on the application code to enforce a check the rules should enforce. Devtools is real.

---

## Query writing checklist

- [ ] **Bound everything.** Either `limit(N)` or a `where(...)` that meaningfully narrows the result set.
- [ ] If you need a compound query (`where('a','==',x), where('b','==',y)`), add the **composite index** to `firestore.indexes.json` and deploy. Don't ignore the Firebase console error — your query will fail in production.
- [ ] When you query a collection with FKs, prefer **server-side `where()`** over client-side `.filter()`. Otherwise the rules can't actually scope the read either.
- [ ] If you need to denormalise a field for query speed (e.g. `schoolName` on `weekly_progress`), document the refresh policy in `FIRESTORE_SCHEMA.md`.

---

## Forbidden patterns (lint will fail)

```js
// ❌ BAD — unbounded read
const snap = await getDocs(collection(db, 'weekly_progress'));

// ✅ GOOD — bounded
const snap = await getDocs(query(
  collection(db, 'weekly_progress'),
  where('updatedAt', '>', sinceCutoff),
  limit(2000),
));

// ❌ BAD — payload uses banned field name (only `uid` is allowed; doc id ≠ uid here)
await setDoc(doc(db, 'weekly_progress', `${u}_w15`), { uid: u, ... });

// ✅ GOOD — `userId` matches schema convention
await setDoc(doc(db, 'weekly_progress', `${u}_w15`), { userId: u, ... });

// ❌ BAD — hits a collection that isn't in FIRESTORE_SCHEMA.md
await getDoc(doc(db, 'random_new_thing', 'x'));

// ✅ GOOD — schema doc has been updated first, rule added, then code follows.
```

---

## When you HAVE to bypass the lint

There are a few legit cases. Use them sparingly.

```js
// @lint-allow-unbounded — admin tooling on a known-small collection (~15 schools)
const snap = await getDocs(collection(db, 'partner_schools'));
```

```js
// @lint-allow-uid — this doc id IS the uid
await setDoc(doc(db, 'users', user.uid), { uid: user.uid, email: user.email });
```

The lint script honours these inline annotations. Code review should challenge any new annotation.

---

## Running the lint

From monorepo root:

```bash
npm run lint:firestore                 # all hubs + rules + schema
npm run lint:firestore -- --hub=ah     # only Academic Hub
npm run lint:firestore -- --strict     # treat warnings as errors
```

Expected output on a clean tree: `✓ no issues found`.
On a problem: a list of file:line locations + the rule that was broken + the schema doc anchor to read.

---

## When in doubt

- **Reading?** Look at how a similar collection's rule is written, then mirror it.
- **Writing?** Look at how a similar collection's payload is built, then mirror it.
- **Designing?** Open `db-diagram.md`, find the closest entity, and let the existing pattern guide you. If your design doesn't fit, propose an extension to this doc first.

The single source of truth for "what exists" is `FIRESTORE_SCHEMA.md`. If you find yourself wanting to skip updating it — that's the moment to slow down.
