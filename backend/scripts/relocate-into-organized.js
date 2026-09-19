// Move the real files into the organized tree, and leave the source folders empty.
//
// WHAT THIS CHANGES ABOUT THE APPLICATION
//
// Atlas's whole model has been: index files WHERE THEY LIVE, and build a
// disposable tree of shortcuts beside them (services/mirror/shortcutWriter.js
// explains why shortcuts and not copies). That makes the organized folder
// deletable at any time -- re-run sync_mirror and it comes back.
//
// This inverts it, on the owner's explicit instruction. After this runs the
// organized tree holds the ONLY copy of every file, and deleting it is data
// loss. That is a deliberate trade, not an oversight, and it is the reason
// this is a script you have to run rather than something the pipeline does.
//
//     node scripts/relocate-into-organized.js            report, move nothing
//     node scripts/relocate-into-organized.js --apply    do it
//
// WHY IT MUST RUN WITH THE APP STOPPED
//
// The storage watcher (WATCH_ENABLED) is subscribed to these very folders. A
// file disappearing from a watched location is, to it, a deletion -- so moving
// 7,000 files while it is running races the scanner into marking the entire
// archive missing. Stop the API and the worker first.
//
// HOW A FILE'S DESTINATION IS DECIDED
//
// The same way its shortcut's would be, deliberately reusing
// mirrorService.mirrorRelativePathFor's inputs: the subject's materialized
// path becomes the folder chain, and the canonical name is used if the naming
// pipeline produced one, otherwise the real filename. So the tree this
// produces is exactly the tree the mirror would have shown -- with the files
// in it rather than links to them.
const fsp = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");
const env = require("../src/config/env");
const { safeSegment, disambiguate } = require("../src/services/mirror/mirrorService");

const APPLY = process.argv.includes("--apply");
const pool = new Pool({ connectionString: env.databaseUrl });

/**
 * Where this file belongs inside the organized tree.
 *
 * Note the missing `.lnk`: mirrorService appends a shortcut extension because
 * it writes shortcuts. This writes the file itself, so the name is the name.
 */
function relativePathFor(file) {
  const dir = String(file.mirror_relative_dir || "")
    // Path separators ONLY. mirrorService also splits on dots because it is
    // handed a dot-joined slug path; this is handed display names, and a
    // folder legitimately called "Dr. Smith" must not become "Dr" / " Smith".
    .split(/[/\\]/)
    .map(safeSegment)
    .filter(Boolean);
  const folder = dir.length ? dir : ["_Unsorted"];
  return path.join(...folder, safeSegment(file.mirror_filename));
}

/**
 * Every active file, INCLUDING the ones with no subject and no canonical name.
 *
 * fileRepository.listForMirror deliberately excludes those -- a shortcut tree
 * has nothing useful to say about a file nobody has filed. Here they matter:
 * the instruction is that the source folders end up empty, and a file left
 * behind because it was never classified would quietly defeat that. They go to
 * _Unsorted, which is honest and still moves them.
 */
async function listAll(ownerUserId) {
  const { rows } = await pool.query(
    `SELECT f.id, f.current_path, f.filename_current, f.sha256_hash, f.size_bytes,
            l.root_path, l.name AS location_name,
            COALESCE(f.canonical_filename, f.filename_current) AS mirror_filename,
            COALESCE(f.canonical_relative_dir, cls.subject_path) AS mirror_relative_dir
       FROM files f
       JOIN storage_locations l ON l.id = f.storage_location_id
       LEFT JOIN LATERAL (
         -- The folder chain in DISPLAY names, not slugs.
         --
         -- materialized_path is dot-joined slugs ("administrative.
         -- correspondence.communication-logs"): exactly right as a database
         -- key, and wrong as a folder someone opens in Explorer. This tree is
         -- the deliverable, so it gets Administrative/Correspondence/
         -- Communication Logs.
         --
         -- It also removes a real hazard. canonical_relative_dir is already
         -- in display form, so mixing the two produced BOTH "administrative"
         -- and "Administrative" in one plan -- which Windows silently merges
         -- by case and other filesystems do not.
         SELECT (
           WITH RECURSIVE chain AS (
             SELECT s.id, s.parent_id, s.name, 1 AS depth
               FROM subjects s WHERE s.id = cr.classified_subject_id
             UNION ALL
             SELECT pa.id, pa.parent_id, pa.name, chain.depth + 1
               FROM subjects pa JOIN chain ON pa.id = chain.parent_id
           )
           SELECT string_agg(name, '/' ORDER BY depth DESC) FROM chain
         ) AS subject_path
           FROM classification_results cr
          WHERE cr.file_id = f.id AND cr.classified_subject_id IS NOT NULL
          ORDER BY cr.created_at DESC LIMIT 1
       ) cls ON true
      WHERE f.status = 'active' AND f.deleted_at IS NULL AND f.owner_user_id = $1
      ORDER BY f.id`,
    [ownerUserId]
  );
  return rows;
}

/** The organized folder as a registered, writable storage location. */
async function ensureOrganizedLocation(ownerUserId, root) {
  const { rows: existing } = await pool.query(
    "SELECT * FROM storage_locations WHERE root_path = $1 AND owner_user_id = $2",
    [root, ownerUserId]
  );
  if (existing[0]) return existing[0];

  const { rows } = await pool.query(
    `INSERT INTO storage_locations (name, type, root_path, access_mode, is_read_only, owner_user_id)
     VALUES ('Organized', 'local', $1, 'direct', false, $2) RETURNING *`,
    [root, ownerUserId]
  );
  return rows[0];
}

/** Remove directories that the move left with nothing in them. */
async function removeEmptyDirs(dir, root) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name), root);
  }
  if (dir === root) return;                       // keep the location itself
  try {
    const left = await fsp.readdir(dir);
    if (!left.length) await fsp.rmdir(dir);
  } catch { /* raced or not empty */ }
}

(async () => {
  const { rows: users } = await pool.query("SELECT id FROM users ORDER BY created_at LIMIT 1");
  const ownerUserId = users[0].id;

  if (!env.mirrorRoot) throw new Error("MIRROR_ROOT is not set.");
  const root = path.resolve(env.mirrorRoot);

  const files = await listAll(ownerUserId);
  console.log(`${files.length} active file(s) to relocate into ${root}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: dry run -- nothing will move. Pass --apply to do it.\n");

  // Plan every destination FIRST, so collisions are resolved against the whole
  // set rather than against whatever happens to have moved already.
  const taken = new Set();
  const plan = files.map((f) => ({
    file: f,
    from: path.resolve(f.root_path, f.current_path),
    rel: disambiguate(relativePathFor(f), taken),
  }));

  const byFolder = new Map();
  for (const p of plan) {
    const top = p.rel.split(path.sep)[0];
    byFolder.set(top, (byFolder.get(top) || 0) + 1);
  }
  console.log("destination tree (top level):");
  for (const [folder, n] of [...byFolder].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${folder}`);
  }

  if (!APPLY) {
    console.log("\nsample:");
    plan.slice(0, 5).forEach((p) => console.log(`   ${p.file.location_name}/${p.file.current_path}\n      -> ${p.rel}`));
    await pool.end();
    return;
  }

  const organized = await ensureOrganizedLocation(ownerUserId, root);
  const summary = { moved: 0, failed: [], skipped: 0 };
  const sourceRoots = new Set(files.map((f) => path.resolve(f.root_path)));

  for (const { file, from, rel } of plan) {
    const to = path.join(root, rel);
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      try {
        await fsp.rename(from, to);
      } catch (err) {
        // rename() cannot cross a volume. Copy-then-unlink is the fallback,
        // and the unlink only happens once the copy is on disk.
        if (err.code !== "EXDEV") throw err;
        await fsp.copyFile(from, to);
        await fsp.unlink(from);
      }

      // Only claim the move in the database once the bytes are demonstrably
      // at the destination. A DB row pointing at a file that is not there is
      // worse than a file the DB has not caught up with yet.
      const stat = await fsp.stat(to);
      if (!stat.isFile()) throw new Error("destination is not a file after the move");

      await pool.query(
        `UPDATE files
            SET storage_location_id = $2,
                current_path        = $3,
                filename_current    = $4,
                updated_at          = now()
          WHERE id = $1`,
        [file.id, organized.id, rel, path.basename(rel)]
      );
      summary.moved += 1;
      if (summary.moved % 500 === 0) console.log(`   moved ${summary.moved}/${plan.length}`);
    } catch (err) {
      summary.failed.push({ file: file.current_path, reason: err.message });
    }
  }

  console.log(`\nmoved ${summary.moved}, failed ${summary.failed.length}`);
  summary.failed.slice(0, 10).forEach((f) => console.log(`   ! ${f.file}: ${f.reason}`));

  for (const srcRoot of sourceRoots) {
    if (srcRoot === root) continue;
    await removeEmptyDirs(srcRoot, srcRoot);
  }
  console.log("removed empty directories from the source locations");

  await pool.end();
})().catch(async (err) => {
  console.error("FAILED:", err.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
