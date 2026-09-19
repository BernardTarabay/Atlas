// Merging the folders that turned out to be the same idea twice.
//
// The execution half of services/ai/folderConsolidator.js. That one decides
// what should merge; this one does it, and it is the part that deletes rows in
// somebody's taxonomy, so the guards here are not advisory.
//
// WHAT A MERGE ACTUALLY IS
//
// Filing is a database fact -- a classification_results row saying this file
// belongs under that subject. So merging two folders is:
//
//   1. repoint every classification_results row from the loser to the survivor
//   2. re-parent the loser's child folders under the survivor, so no branch is
//      orphaned
//   3. delete the loser
//
// Nothing on disk moves, is renamed, or is deleted. A merge that turns out to
// be wrong is undone by moving files back, which is an ordinary operation the
// app already supports.
//
// THE RULES THAT ARE NOT NEGOTIABLE
//
//   a user's folder is never deleted   The model is told this and told it
//                                      again in the schema, and it is ALSO
//                                      enforced here, because a prompt is a
//                                      request. "The assistant tidied away the
//                                      folder I made" is the single worst
//                                      thing this feature could do.
//   no parent/child merges             Folding a folder into its own ancestor
//                                      is not deduplication, it is flattening,
//                                      and it silently destroys the nesting a
//                                      person may have chosen.
//   the survivor must exist            and must not appear in its own merge
//                                      list, which is a cheap way for a
//                                      malformed plan to delete everything.
const db = require("../config/database");
const auditLogRepository = require("../repositories/auditLogRepository");
const folderConsolidator = require("./ai/folderConsolidator");
const subjectService = require("./subjectService");
const { requireOwner } = require("../repositories/ownership");
const env = require("../config/env");

/** The whole tree, with everything the planner and the guards need. */
async function loadTree(ownerUserId) {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.origin, s.parent_id, s.materialized_path,
            (SELECT count(*)::int FROM subjects k WHERE k.parent_id = s.id) AS kids,
            (SELECT count(*)::int FROM classification_results c
              WHERE c.classified_subject_id = s.id) AS files
       FROM subjects s
      WHERE s.owner_user_id = $1 AND s.archived_at IS NULL
      ORDER BY s.materialized_path`,
    [ownerUserId]
  );
  return rows;
}

/**
 * Take just the path out of whatever the model echoed back.
 *
 * The tree is shown to it as "- financial.tax-returns [ai] (65 file(s))", and
 * asked for the path "copied exactly". It copied the whole line -- annotation
 * and all -- so every single lookup missed and a perfectly good plan was
 * refused wholesale as "the survivor does not exist".
 *
 * Rendering the annotations differently would only move the problem. Anything
 * after the first space is decoration by construction, because a
 * materialized_path is dot-joined slugs and can never contain one.
 */
function normalizePath(raw) {
  return String(raw || "").trim().split(/[\s[(]/)[0].toLowerCase();
}

const isAncestorOf = (maybeAncestor, node) =>
  node.materialized_path.startsWith(`${maybeAncestor.materialized_path}.`);

/**
 * Fold one folder into another.
 *
 * Done in a transaction: a merge that repointed half a folder's files and then
 * failed would leave the archive with documents split across two folders that
 * were supposed to have become one, which is worse than either outcome.
 */
async function mergeOne(loser, survivor, ownerUserId) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    // 1. The files. ON CONFLICT is not available here (no unique constraint on
    //    file+subject), so a file already filed under the survivor would end up
    //    with two rows -- harmless for listing, but it would double the
    //    survivor's count. Delete those first, then repoint the rest.
    await client.query(
      `DELETE FROM classification_results loser_row
        WHERE loser_row.classified_subject_id = $1
          AND EXISTS (
                SELECT 1 FROM classification_results keep
                 WHERE keep.file_id = loser_row.file_id
                   AND keep.classified_subject_id = $2
              )`,
      [loser.id, survivor.id]
    );
    const moved = await client.query(
      `UPDATE classification_results SET classified_subject_id = $2
        WHERE classified_subject_id = $1`,
      [loser.id, survivor.id]
    );

    // 2. The children, so nothing is orphaned by step 3.
    const reparented = await client.query(
      `UPDATE subjects SET parent_id = $2 WHERE parent_id = $1 AND owner_user_id = $3`,
      [loser.id, survivor.id, ownerUserId]
    );

    // 3. The folder itself.
    await client.query("DELETE FROM subjects WHERE id = $1 AND owner_user_id = $2", [loser.id, ownerUserId]);

    await client.query("COMMIT");
    return { moved: moved.rowCount, reparented: reparented.rowCount };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One consolidation pass over the whole tree.
 *
 * @param {string} ownerUserId
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] report the plan, change nothing
 */
async function consolidate(ownerUserId, { dryRun = false } = {}) {
  requireOwner(ownerUserId, "folderConsolidation.consolidate");

  const summary = { merged: 0, filesMoved: 0, foldersRemoved: [], reparented: [], refused: [], dryRun: Boolean(dryRun) };
  if (!env.ai.apiKey) {
    summary.reason = "GEMINI_API_KEY is not set.";
    return summary;
  }

  const tree = await loadTree(ownerUserId);
  const byPath = new Map(tree.map((s) => [s.materialized_path.toLowerCase(), s]));

  const plan = await folderConsolidator.planConsolidation(tree);
  if (!plan.ok) {
    summary.reason = plan.reason;
    return summary;
  }

  for (const group of plan.merges) {
    const survivor = byPath.get(normalizePath(group?.survivor_path));
    if (!survivor) {
      summary.refused.push({ path: group?.survivor_path, reason: "the survivor does not exist" });
      continue;
    }

    for (const path of group.merge_paths || []) {
      const loser = byPath.get(normalizePath(path));
      const label = loser?.materialized_path || path;

      if (!loser) { summary.refused.push({ path, reason: "no such folder" }); continue; }
      if (loser.id === survivor.id) { summary.refused.push({ path: label, reason: "listed as its own survivor" }); continue; }

      // THE RULE THE MODEL IS NOT TRUSTED WITH.
      if (loser.origin === "user") {
        summary.refused.push({ path: label, reason: "created by the user; never merged away" });
        continue;
      }
      if (isAncestorOf(loser, survivor) || isAncestorOf(survivor, loser)) {
        summary.refused.push({ path: label, reason: `nested with "${survivor.materialized_path}"; nesting is not duplication` });
        continue;
      }

      if (dryRun) {
        summary.foldersRemoved.push({ from: label, into: survivor.materialized_path, files: loser.files, rationale: group.rationale });
        summary.merged += 1;
        summary.filesMoved += loser.files;
        continue;
      }

      try {
        const { moved } = await mergeOne(loser, survivor, ownerUserId);
        summary.merged += 1;
        summary.filesMoved += moved;
        summary.foldersRemoved.push({ from: label, into: survivor.materialized_path, files: moved, rationale: group.rationale });
        // The tree has changed under us: anything that pointed at the loser
        // must now resolve to the survivor, or a later group in this same plan
        // would try to merge a folder that no longer exists.
        byPath.set(label.toLowerCase(), survivor);
      } catch (err) {
        summary.refused.push({ path: label, reason: err.message });
      }
    }
  }

  // RE-PARENTING, after the merges.
  //
  // Deliberately second: a folder that is about to be merged away should not
  // first be moved somewhere, and doing merges first means the tree this reads
  // is the one that will actually survive.
  //
  // This is what pulls the assistant's inventions back under the structure the
  // person built. The organizer nests under an existing folder when it can, but
  // a batch that finds no suitable parent creates at the top level -- so over a
  // long backlog the archive grows a row of stray top-level folders sitting
  // beside the four the user actually made.
  for (const move of plan.reparents || []) {
    const node = byPath.get(normalizePath(move?.path));
    const parent = byPath.get(normalizePath(move?.new_parent_path));
    const label = node?.materialized_path || move?.path;

    if (!node) { summary.refused.push({ path: move?.path, reason: "no such folder" }); continue; }
    if (!parent) { summary.refused.push({ path: label, reason: `destination "${move?.new_parent_path}" does not exist` }); continue; }

    // Same rule as merging: a folder the user made is not the assistant's to
    // rearrange. Moving one is less destructive than deleting it and is still
    // their tree being changed without them asking.
    if (node.origin === "user") {
      summary.refused.push({ path: label, reason: "created by the user; never moved" });
      continue;
    }
    if (node.id === parent.id || isAncestorOf(node, parent)) {
      summary.refused.push({ path: label, reason: "would nest a folder inside itself or its own branch" });
      continue;
    }
    if (node.parent_id === parent.id) continue; // already there

    if (dryRun) {
      summary.reparented.push({ path: label, into: parent.materialized_path, files: node.files, rationale: move.rationale });
      continue;
    }

    try {
      // subjectService.moveToParent owns the hard parts -- cycle detection, the
      // depth limit measured on the DEEPEST folder in the branch, name
      // collisions in the destination, and recomputing materialized_path for
      // every descendant. Reimplementing any of that here would be a second,
      // worse copy.
      await subjectService.moveToParent(node.id, parent.id, ownerUserId);
      summary.reparented.push({ path: label, into: parent.materialized_path, files: node.files, rationale: move.rationale });
    } catch (err) {
      summary.refused.push({ path: label, reason: err.message });
    }
  }

  if (!dryRun && (summary.merged || summary.reparented.length)) {
    await auditLogRepository.record({
      userId: ownerUserId,
      action: "subjects.consolidated",
      entityType: "user",
      entityId: ownerUserId,
      newState: {
        merged: summary.merged,
        filesMoved: summary.filesMoved,
        removed: summary.foldersRemoved.map((f) => `${f.from} -> ${f.into}`),
        reparented: summary.reparented.map((f) => `${f.path} -> under ${f.into}`),
      },
      reason:
        `Merged ${summary.merged} duplicate folder(s) moving ${summary.filesMoved} file(s), and ` +
        `re-parented ${summary.reparented.length}. Folders created by the user were left untouched.`,
    });
  }

  return summary;
}

module.exports = { consolidate, loadTree };
