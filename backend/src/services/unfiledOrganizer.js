// Emptying the unfiled pile, including by building the folders it needs.
//
// THE PROBLEM
//
// "Unfiled" is where a document goes when the classifier looked at the whole
// taxonomy and honestly reported that nothing fit. That is the correct answer
// to the question it was asked, and it is a dead end, because nothing ever
// asks the follow-up: then what SHOULD exist?
//
// On this installation that gap was 4,629 files -- 64% of the archive -- sat
// against a taxonomy of seven folders. No amount of re-running classification
// would have moved one of them, because the folder each needed had never been
// created and the classifier is structurally incapable of creating it.
//
// WHAT THIS DOES
//
// Takes the unfiled pile in batches, and for each batch asks the planner
// (services/ai/folderPlanner.js) two questions at once: which of these belong
// in folders that already exist, and what folders are missing? Then it creates
// the missing ones and files everything.
//
// WHY IT IS ALLOWED TO CREATE FOLDERS WITHOUT ASKING
//
// Because the alternative is what exists now. A proposal queue for 4,629 files
// is not review, it is a second unfiled pile with more steps, and the whole
// reason this feature was asked for is that the machine should "take charge"
// when the user's folders do not fit.
//
// What makes that defensible is that none of it is hidden or hard to undo:
//
//   every created folder carries origin='ai' and the rationale that produced
//   it, so the tree distinguishes the assistant's ideas from the user's
//   every placement is source=AI_AUTO, which the file detail shows
//   every folder creation and every placement is in the audit log
//   nothing is renamed, moved on disk, or deleted -- filing is a database
//   fact about where a document belongs, and reversing it is a move
//
// The one thing it will not do is invent a home for a document it cannot
// identify. A file the planner says nothing about stays unfiled, which is the
// honest outcome and keeps "unfiled" meaning something.
const db = require("../config/database");
const subjectService = require("./subjectService");
const fileOrganizeService = require("./fileOrganizeService");
const auditLogRepository = require("../repositories/auditLogRepository");
const folderPlanner = require("./ai/folderPlanner");
const { requireOwner } = require("../repositories/ownership");
const env = require("../config/env");

/**
 * Confidence floor for filing something without being asked.
 *
 * The planner reports how sure it is per file. `low` means it is guessing from
 * a filename, and a guess is exactly what should stay in the unfiled pile --
 * that pile is not a failure state, it is the list of things a person still
 * needs to look at. Filing a guess would empty the list by hiding the
 * problem.
 */
const MIN_CONFIDENCE = new Set(["high", "medium"]);

/**
 * How many times a file may be considered and left unplaced before the
 * organizer stops offering it.
 *
 * Without this the pass is a money leak rather than a feature: the pile is
 * selected in a stable order, so a batch nothing can categorise is re-planned
 * identically on the next run, and the next, hourly, forever. Three attempts
 * against a taxonomy that grows between them is a fair hearing; a fourth is
 * paying to be told the same thing.
 *
 * Migration 044 explains why this is a count rather than a "cannot be filed"
 * flag -- a document nothing could place in March may be obvious in June.
 */
const MAX_ORGANIZE_ATTEMPTS = 3;

/**
 * Folder names this refuses to create, whatever the planner says.
 *
 * The prompt already forbids these. This exists because a prompt is a request
 * and this is the user's taxonomy: on the first full run the planner produced
 * eight variations of "Placeholder Documents" holding 436 files -- naming
 * folders after the STATE OF THE CONTENT (it could not read it) rather than
 * what the documents were. That is precisely the junk drawer the instruction
 * bans, wearing a technical-sounding label instead of "Miscellaneous", and it
 * sailed past the rule because it reads like a real category.
 *
 * A rejected proposal is not a disaster: the files it would have swallowed
 * stay unfiled, which is the honest outcome for documents nothing could read.
 */
const REJECTED_FOLDER_NAME =
  /placeholder|unsorted|miscellaneous|\bmisc\b|\bother\b|unknown|untitled|unidentified|unreadable|blank|assorted|general documents|\btemp\b|\bvarious\b|low.quality|draft content|\bto sort\b/i;

/**
 * A child that only restates its parent adds a level of nesting and no
 * information -- "Purchase Agreements > Purchase Records". Compared on words
 * rather than exact text so the near-misses are caught too.
 */
function restatesParent(name, parentPath) {
  if (!parentPath) return false;
  const leaf = String(parentPath).split(".").pop().replace(/-/g, " ").toLowerCase();
  const words = new Set(String(name).toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const parentWords = String(leaf).split(/\s+/).filter((w) => w.length > 3);
  if (!parentWords.length || !words.size) return false;
  return parentWords.every((w) => words.has(w));
}

/**
 * Files with no subject on any classification result.
 *
 * Deliberately the same definition the Unfiled view uses, so the count the
 * user is looking at is the count this acts on.
 */
async function listUnfiled(ownerUserId, limit) {
  const { rows } = await db.query(
    `SELECT f.id, f.filename_current, f.current_path, f.ai_short_title,
            d.description
       FROM files f
       LEFT JOIN file_descriptions d ON d.file_id = f.id
      WHERE f.owner_user_id = $1
        AND f.status = 'active'
        AND f.deleted_at IS NULL
        AND f.organize_attempts < $3
        AND NOT EXISTS (
              SELECT 1 FROM classification_results c
               WHERE c.file_id = f.id AND c.classified_subject_id IS NOT NULL
            )
      ORDER BY f.imported_at DESC
      LIMIT $2`,
    [ownerUserId, limit, MAX_ORGANIZE_ATTEMPTS]
  );
  return rows;
}

/** The tree as the planner needs to see it: paths, descriptions, and weight. */
async function describeExistingTree(ownerUserId) {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.materialized_path, s.description,
            (SELECT count(*)::int FROM classification_results c
              WHERE c.classified_subject_id = s.id) AS file_count
       FROM subjects s
      WHERE s.owner_user_id = $1 AND s.archived_at IS NULL
      ORDER BY s.materialized_path`,
    [ownerUserId]
  );
  return rows;
}

/**
 * Resolve a folder path the way the planner writes them, not the way the
 * database stores them.
 *
 * findByPath is an exact, case-sensitive match, which is right for every other
 * caller and wrong for this one: the planner returns paths in whatever case it
 * feels like -- "financial" for a folder stored as "Financial" was the first
 * thing it did. Every parent lookup missed, so folders that were meant to nest
 * under an existing branch were all created at the top level instead.
 *
 * An index built once per pass also avoids a query per proposal, and it can be
 * updated as folders are created so later assignments in the SAME pass can
 * refer to them.
 */
function buildPathIndex(rows) {
  const index = new Map();
  for (const r of rows) index.set(String(r.materialized_path).toLowerCase(), r);
  return index;
}

const resolvePath = (index, path) =>
  (path ? index.get(String(path).trim().toLowerCase()) : null) || null;

/**
 * Turn the planner's proposed folders into real ones.
 *
 * Returns a map from the planner's own key to a created (or already-existing)
 * subject id, so assignments can be resolved against it.
 */
async function createProposedFolders(newFolders, ownerUserId, summary, pathIndex) {
  const byKey = new Map();

  for (const proposal of newFolders) {
    const name = String(proposal?.name || "").trim();
    if (!name || !proposal?.key) continue;

    if (REJECTED_FOLDER_NAME.test(name)) {
      summary.skippedFolders.push({ name, reason: "a junk-drawer name; its files stay unfiled" });
      continue;
    }

    // A proposal whose parent does not exist is nested at the top level
    // rather than dropped: the folder is still the right idea, and refusing
    // it over a bad path would lose the whole batch's worth of filing.
    let parentId = null;
    let parentPath = null;
    if (proposal.parent_path) {
      const parent = resolvePath(pathIndex, proposal.parent_path);
      if (parent) {
        parentId = parent.id;
        parentPath = parent.materialized_path;
      }
    }

    if (restatesParent(name, proposal.parent_path)) {
      summary.skippedFolders.push({ name, reason: `restates its parent "${proposal.parent_path}"` });
      continue;
    }

    // The planner is told not to duplicate, but it is a language model and
    // this is the user's taxonomy -- check rather than trust. An existing
    // folder of the same name in the same place is REUSED, which is the
    // outcome the instruction was aiming at anyway.
    //
    // Built the way the database builds it: materialized_path is dot-joined
    // SLUGS ("financial.tax-returns"), not display names joined by a slash.
    // Composing it the readable way meant this check never matched anything
    // and the duplicate guard was decorative -- it would have re-created a
    // folder the archive already had, which is the one failure the planner is
    // most explicitly told to avoid.
    const wantedPath = parentPath
      ? `${parentPath}.${subjectService.slugify(name)}`
      : subjectService.slugify(name);
    const existing = resolvePath(pathIndex, wantedPath);
    if (existing) {
      byKey.set(proposal.key, existing.id);
      summary.reusedFolders += 1;
      continue;
    }

    try {
      const created = await subjectService.create(
        {
          parentId,
          name,
          description: proposal.rationale ? String(proposal.rationale).slice(0, 400) : null,
          origin: "ai",
          aiRationale: proposal.rationale ? String(proposal.rationale).slice(0, 1000) : null,
        },
        ownerUserId
      );
      byKey.set(proposal.key, created.id);
      // Visible to the rest of this pass, so an assignment naming the new
      // folder by path resolves instead of silently dropping.
      pathIndex.set(String(created.materialized_path).toLowerCase(), created);
      summary.createdFolders.push({ id: created.id, name: created.name, path: created.materialized_path });
    } catch (err) {
      // A name collision the path check missed, a depth limit, a validation
      // rule -- none of them is a reason to abandon the rest of the batch.
      summary.skippedFolders.push({ name, reason: err.message });
    }
  }

  return byKey;
}

/**
 * One pass over the unfiled pile.
 *
 * @param {string} ownerUserId
 * @param {object} [opts]
 * @param {number} [opts.limit]   how many unfiled files to consider
 * @param {boolean} [opts.dryRun] plan and report, create and file nothing
 */
async function organizeUnfiled(ownerUserId, { limit = folderPlanner.BATCH_SIZE, dryRun = false } = {}) {
  requireOwner(ownerUserId, "unfiledOrganizer.organizeUnfiled");

  const summary = {
    considered: 0, filed: 0, leftUnfiled: 0,
    createdFolders: [], reusedFolders: 0, skippedFolders: [],
    dryRun: Boolean(dryRun),
  };

  if (!env.ai.apiKey) {
    summary.reason = "GEMINI_API_KEY is not set, so no folders can be proposed.";
    return summary;
  }

  const files = await listUnfiled(ownerUserId, Math.min(limit, folderPlanner.BATCH_SIZE));
  summary.considered = files.length;
  if (!files.length) return summary;

  const tree = await describeExistingTree(ownerUserId);
  const pathIndex = buildPathIndex(tree);
  const plan = await folderPlanner.planFolders(files, tree);
  if (!plan.ok) {
    summary.reason = plan.reason;
    return summary;
  }

  if (dryRun) {
    summary.plannedFolders = plan.newFolders;
    summary.plannedAssignments = plan.assignments.length;
    return summary;
  }

  const keyToSubject = await createProposedFolders(plan.newFolders, ownerUserId, summary, pathIndex);

  // Resolve every assignment to a real subject id, then file per destination
  // so each folder is one batched move rather than one move per file.
  const validIds = new Set(files.map((f) => f.id));
  const bySubject = new Map();

  for (const a of plan.assignments) {
    if (!a || !validIds.has(a.file_id)) continue;
    if (!MIN_CONFIDENCE.has(String(a.confidence || "").toLowerCase())) continue;

    let subjectId = null;
    if (a.new_folder_key && keyToSubject.has(a.new_folder_key)) {
      subjectId = keyToSubject.get(a.new_folder_key);
    } else if (a.existing_path) {
      const existing = resolvePath(pathIndex, a.existing_path);
      if (existing) subjectId = existing.id;
    }
    if (!subjectId) continue;

    if (!bySubject.has(subjectId)) bySubject.set(subjectId, []);
    bySubject.get(subjectId).push(a.file_id);
  }

  for (const [subjectId, fileIds] of bySubject) {
    try {
      const result = await fileOrganizeService.moveManyToSubject({
        fileIds,
        subjectId,
        ownerUserId,
        // Applied without review, which is what this feature is; recorded as
        // such so the file detail can say so rather than implying a person
        // chose it.
        source: fileOrganizeService.PlacementSource.AI_AUTO,
        note: "Filed by the unfiled-pile organizer.",
      });
      summary.filed += result.moved.length;
    } catch (err) {
      summary.skippedFolders.push({ name: subjectId, reason: err.message });
    }
  }

  // RECORD THE ATTEMPT ON EVERYTHING THAT DID NOT MOVE.
  //
  // This is what makes the pass terminate. Anything still unfiled after this
  // batch has now had one of its attempts, so the next run selects different
  // files instead of re-planning these -- and a file that exhausts its budget
  // drops out of the candidate set entirely.
  const placed = new Set([...bySubject.values()].flat());
  const unplaced = files.map((f) => f.id).filter((id) => !placed.has(id));
  if (unplaced.length) {
    await db.query(
      `UPDATE files
          SET organize_attempts = organize_attempts + 1,
              organize_attempted_at = now()
        WHERE id = ANY($1::uuid[])`,
      [unplaced]
    );
  }

  summary.leftUnfiled = summary.considered - summary.filed;
  summary.attemptsRecorded = unplaced.length;

  await auditLogRepository.record({
    userId: ownerUserId,
    action: "subjects.organize_unfiled",
    entityType: "user",
    entityId: ownerUserId,
    newState: {
      considered: summary.considered,
      filed: summary.filed,
      createdFolders: summary.createdFolders.map((f) => f.path),
      reusedFolders: summary.reusedFolders,
    },
    reason:
      `Organized ${summary.filed} of ${summary.considered} unfiled file(s); ` +
      `created ${summary.createdFolders.length} folder(s) the archive did not have.`,
  });

  return summary;
}

/** How much is waiting, so the UI can say whether this is worth running. */
async function unfiledSummary(ownerUserId) {
  requireOwner(ownerUserId, "unfiledOrganizer.unfiledSummary");
  const { rows } = await db.query(
    `SELECT count(*)::int AS unfiled,
            count(*) FILTER (WHERE f.organize_attempts >= ${MAX_ORGANIZE_ATTEMPTS})::int AS given_up
       FROM files f
      WHERE f.owner_user_id = $1 AND f.status = 'active' AND f.deleted_at IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM classification_results c
               WHERE c.file_id = f.id AND c.classified_subject_id IS NOT NULL
            )`,
    [ownerUserId]
  );
  const { rows: ai } = await db.query(
    `SELECT count(*)::int AS n FROM subjects WHERE owner_user_id = $1 AND origin = 'ai'`,
    [ownerUserId]
  );
  return {
    unfiled: rows[0]?.unfiled || 0,
    // Unfiled AND still worth another look. The difference between these two
    // is what the organizer has honestly given up on, which a person should be
    // told rather than left to wonder why the number stopped moving.
    organizable: Math.max(0, (rows[0]?.unfiled || 0) - (rows[0]?.given_up || 0)),
    givenUp: rows[0]?.given_up || 0,
    aiCreatedFolders: ai[0]?.n || 0,
    batchSize: folderPlanner.BATCH_SIZE,
    available: Boolean(env.ai.apiKey),
  };
}

/**
 * Owners whose unfiled pile is worth acting on, and who have somewhere to put
 * things.
 *
 * Scoped per owner for the reason trashPurgeScheduler documents at length: a
 * job is a processing_jobs row and every row must name an owner (migration
 * 028), so an ownerless sweep is refused by the repository and dies in a log
 * line nobody reads. That is exactly how the Trash purge silently never ran.
 *
 * The threshold is what stops this firing constantly. A handful of unfiled
 * files is the normal residue of an import -- the planner is deliberately
 * allowed to leave things alone -- and paying for a planning call to look at
 * six documents it already declined once is waste, not tidiness.
 */
async function findOwnersWithUnfiled(threshold) {
  const { rows } = await db.query(
    `SELECT f.owner_user_id, count(*)::int AS unfiled
       FROM files f
      WHERE f.status = 'active'
        AND f.deleted_at IS NULL
        AND f.owner_user_id IS NOT NULL
        AND f.organize_attempts < ${MAX_ORGANIZE_ATTEMPTS}
        AND NOT EXISTS (
              SELECT 1 FROM classification_results c
               WHERE c.file_id = f.id AND c.classified_subject_id IS NOT NULL
            )
      GROUP BY f.owner_user_id
     HAVING count(*) >= $1`,
    [threshold]
  );
  return rows;
}

/**
 * Is one of these already in flight, or has this owner had their allowance?
 *
 * Two different protections in one query, both about money rather than
 * correctness:
 *
 *   in flight   the scheduler ticks on a timer and a run takes minutes. Without
 *               this, a slow pass gets a second one queued on top of it, and
 *               the two plan against different snapshots of the tree -- which
 *               is how you get the same folder invented twice.
 *   daily cap   an unattended feature that spends per batch needs a ceiling
 *               that does not depend on the pile ever emptying. A 50,000-file
 *               import must not be able to run up an unbounded bill overnight.
 */
async function organizeRunsToday(ownerUserId) {
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE status IN ('queued','running'))::int AS in_flight,
       count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h
       FROM processing_jobs
      WHERE job_type = 'organize_unfiled' AND owner_user_id = $1`,
    [ownerUserId]
  );
  return { inFlight: rows[0]?.in_flight || 0, last24h: rows[0]?.last_24h || 0 };
}

module.exports = {
  organizeUnfiled, unfiledSummary, listUnfiled,
  findOwnersWithUnfiled, organizeRunsToday,
  MIN_CONFIDENCE,
};
