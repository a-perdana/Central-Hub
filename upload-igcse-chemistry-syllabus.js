/**
 * One-time upload script: loads IGCSE-Chemistry.json into igcse_syllabus Firestore collection.
 *
 * Usage:
 *   node upload-igcse-chemistry-syllabus.js
 *
 * Requirements:
 *   npm install firebase-admin
 *   Place your centralhub-8727b service account key at:
 *     serviceAccountKey.json  (same directory as this script)
 *
 * Each syllabus entry is stored as:
 *   igcse_syllabus/{subjectCode}_{sectionCode}_{tier}
 *   e.g. igcse_syllabus/0620_1.1_core
 *
 * Fields stored per document:
 *   subjectCode  — "0620"
 *   code         — "1.1"
 *   tier         — "core" | "supplement"
 *   topicNumber  — "1"
 *   topicArea    — "Characteristics and classification of living organisms"
 *   title        — "Characteristics of living organisms"
 *   description  — first 3 content bullets joined as a short summary
 *   content      — full content array
 *   notes        — notes_examples array
 */

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

const KEY_PATH     = path.join(__dirname, 'serviceAccountKey.json');
const JSON_PATH    = path.join(__dirname, 'resources/IGCSE-Chemistry.json');
const SUBJECT_CODE = '0620';

if (!fs.existsSync(KEY_PATH)) {
  console.error('Service account key not found at:', KEY_PATH);
  process.exit(1);
}

if (!fs.existsSync(JSON_PATH)) {
  console.error('IGCSE-Chemistry.json not found at:', JSON_PATH);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(KEY_PATH)),
});

const db   = admin.firestore();
const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));

async function run() {
  // Firestore batch limit is 500 — split into chunks if needed
  const BATCH_SIZE = 400;
  let count = 0;
  let batch = db.batch();

  for (const entry of data) {
    const tier    = (entry.tier || '').toLowerCase().replace(/\s+/g, '_'); // "core" | "supplement"
    const code    = entry.section_code;                                     // e.g. "1.1"
    const docId   = `${SUBJECT_CODE}_${code}_${tier}`;                     // e.g. "0620_1.1_core"
    const ref     = db.collection('igcse_syllabus').doc(docId);

    const description = (entry.content || []).slice(0, 3).join('; ');

    batch.set(ref, {
      subjectCode:  SUBJECT_CODE,
      code,
      tier,
      topicNumber:  entry.topic_number || '',
      topicArea:    entry.topic_title  || '',
      title:        entry.title        || '',
      description,
      content:      entry.content      || [],
      notes:        entry.notes_examples || [],
    });

    count++;

    if (count % BATCH_SIZE === 0) {
      await batch.commit();
      console.log(`  Committed ${count} entries so far...`);
      batch = db.batch();
    }
  }

  // Commit any remaining
  if (count % BATCH_SIZE !== 0) {
    await batch.commit();
  }

  console.log(`Done. Uploaded ${count} chemistry syllabus entries to igcse_syllabus.`);
  process.exit(0);
}

run().catch(err => {
  console.error('Upload failed:', err);
  process.exit(1);
});
