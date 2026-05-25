/**
 * scripts/build-shared/copy-tree.js
 *
 * Tiny copy-tree helper extracted from the 3 hub build.js files. Replaces
 * ~14 near-identical "iterate-list-of-files-and-copyFileSync-with-warning"
 * blocks (Cambridge / Permendiknas / ES / AICF reference / AICF practical /
 * references-data sub-trees) with a single declarative call.
 *
 * Vercel-safe: works whether the source is the local hub mirror (Vercel's
 * standalone-subrepo case) or the monorepo `docs/research/` (developer
 * machine running from monorepo root). Each call passes the resolved
 * source path; this module doesn't choose between them.
 *
 * Step 6 of the 2026-05-25 system-architecture pass.
 */

const fs   = require('fs');
const path = require('path');

/**
 * Copy a flat list of files from `srcDir` to `destDir`. Returns
 * { copied: number, missing: number }.
 *
 * Logs each successful copy + each missing entry. The `label` is the
 * dest-tree prefix used in console output (e.g. "dist/research/cambridge").
 *
 * @param {string} srcDir    Absolute or resolvable path to the source dir.
 * @param {string} destDir   Absolute or resolvable path to the destination.
 * @param {string[]} files   Bare filenames inside srcDir.
 * @param {string} label     Log prefix — typically `dist/<subtree>`.
 */
function copyFiles(srcDir, destDir, files, label) {
  let copied = 0;
  let missing = 0;
  if (!fs.existsSync(srcDir)) {
    console.warn(`WARNING: ${label} source dir missing: ${srcDir}`);
    return { copied: 0, missing: files.length };
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of files) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`Copied: ${label}/${name}`);
      copied++;
    } else {
      console.warn(`WARNING: ${name} not found in ${srcDir}`);
      missing++;
    }
  }
  return { copied, missing };
}

/**
 * Recursively copy a directory tree from `srcDir` to `destDir`. Useful
 * for sub-trees like references-data/ where the file list is large and
 * already structured. Returns count of files copied.
 *
 * @param {string} srcDir   Source directory (must exist or returns 0).
 * @param {string} destDir  Destination — created if missing.
 * @param {string} label    Log prefix shown once at the end.
 */
function copyDir(srcDir, destDir, label) {
  if (!fs.existsSync(srcDir)) {
    console.warn(`WARNING: ${label} source dir missing: ${srcDir}`);
    return 0;
  }
  let count = 0;
  function walk(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name);
      const d = path.join(dest, ent.name);
      if (ent.isDirectory()) walk(s, d);
      else { fs.copyFileSync(s, d); count++; }
    }
  }
  walk(srcDir, destDir);
  console.log(`Copied: ${label} (${count} files)`);
  return count;
}

/**
 * Resolve a source dir using the local-mirror-first / monorepo-fallback
 * pattern that AH+TH need (Vercel ships standalone subrepos, no `..`).
 * CH always has monorepo access so it skips the fallback — but using
 * this helper keeps the pattern uniform.
 *
 * @param {string} localDir     Hub-local mirror path.
 * @param {string} monorepoDir  Monorepo `..` fallback path.
 * @returns {string|null}       The first existing path, or null.
 */
function resolveSrcDir(localDir, monorepoDir) {
  if (fs.existsSync(localDir)) return localDir;
  if (monorepoDir && fs.existsSync(monorepoDir)) return monorepoDir;
  return null;
}

module.exports = { copyFiles, copyDir, resolveSrcDir };
