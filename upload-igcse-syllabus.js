/**
 * One-time upload script: loads IGCSE-Math.json into igcse_syllabus Firestore collection.
 *
 * Usage:
 *   node upload-igcse-syllabus.js
 *
 * Requirements:
 *   npm install firebase-admin
 *   Place your centralhub-8727b service account key at:
 *     ../keys/centralhub-service-account.json
 *
 * Each syllabus entry is stored as:
 *   igcse_syllabus/{subjectCode}_{sectionCode}
 *   e.g. igcse_syllabus/0580_C1.1
 *
 * Fields stored per document:
 *   subjectCode  — "0580"
 *   code         — "C1.1"
 *   tier         — "core" | "extended"
 *   topicArea    — "Number"
 *   title        — "Types of number"
 *   description  — first 3 content bullets joined as a short summary
 *   content      — full content array
 *   notes        — notes_examples array
 */

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

const KEY_PATH  = path.join(__dirname, 'serviceAccountKey.json');
const JSON_PATH = path.join(__dirname, 'resources/IGCSE-Math.json');
const SUBJECT_CODE = '0580';

if (!fs.existsSync(KEY_PATH)) {
  console.error('Service account key not found at:', KEY_PATH);
  process.exit(1);
}

if (!fs.existsSync(JSON_PATH)) {
  console.error('IGCSE-Math.json not found at:', JSON_PATH);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(KEY_PATH)),
});

const db   = admin.firestore();
const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));

async function run() {
  const batch = db.batch();
  let count = 0;

  for (const entry of data) {
    const code    = entry.section_code;           // e.g. "C1.1"
    const docId   = `${SUBJECT_CODE}_${code}`;    // e.g. "0580_C1.1"
    const ref     = db.collection('igcse_syllabus').doc(docId);

    // Build a short description from first 3 content bullets
    const description = (entry.content || []).slice(0, 3).join('; ');

    batch.set(ref, {
      subjectCode: SUBJECT_CODE,
      code,
      tier:        (entry.tier || '').toLowerCase(),
      topicArea:   entry.topic || '',
      title:       entry.title || '',
      description,
      content:     entry.content || [],
      notes:       entry.notes_examples || [],
    });

    count++;
  }

  await batch.commit();
  console.log(`Uploaded ${count} syllabus entries to igcse_syllabus.`);
  process.exit(0);
}

run().catch(err => {
  console.error('Upload failed:', err);
  process.exit(1);
});
