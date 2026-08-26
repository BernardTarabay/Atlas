// Physical File persistence. See docs/01-domain-model.md for File vs Document.
//
// TWO CLASSES OF READ LIVE IN HERE
//
// Functions taking an `ownerUserId` answer HTTP requests and are scoped to
// that owner in SQL. Functions that do not take one are worker-side and are
// reached only via a storage location whose owner was already established --
// `findByLocationAndPath` is the clearest example: the location id IS the
// authorization, because a location belongs to exactly one account.
//
// The dangerous middle ground is content-addressed lookup. `findBySha256` and
// friends match on a hash, which knows nothing about who owns the bytes, so
// they crossed account boundaries by construction: two users holding the same
// PDF would have been put in one duplicate group, and one could adopt the
// other's classification, AI summary and canonical name. Those all take an
// owner now, and it is a required argument rather than an optional filter.
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");
const { tsQueryExpression } = require("./fileContentRepository");
const { buildFilterSql, buildOrderBy, LISTABLE_STATUS, NOT_A_DUPLICATE_COPY, LISTABLE_FILE } = require("./fileFilters");
const { requireOwner, ownedRepository } = require("./ownership");

const base = createBaseRepository("files");
// `findByIdForOwner` from here is what every request handler uses. The
// unscoped `findById` above it stays for worker code, which reaches a file
// through a storage location whose owner is already settled.
const owned = ownedRepository(db, "files", { orderBy: "imported_at DESC" });

async function findByLocationAndPath(storageLocationId, currentPath) {
  const { rows } = await db.query(
    "SELECT * FROM files WHERE storage_location_id = $1 AND current_path = $2",
    [storageLocationId, currentPath]
  );
  return rows[0] || null;
}

/**
 * Files with these exact bytes, WITHIN one account.
 *
 * The owner is not a filter that narrows a result -- it is what makes the
 * result meaningful. Identical bytes in two different people's archives are
 * two unrelated documents that happen to be the same file; treating them as
 * one is how a duplicate group ends up spanning accounts and offering to
 * "resolve" by keeping a copy the other user cannot see.
 */
async function findBySha256(sha256Hash, ownerUserId) {
  requireOwner(ownerUserId, "findBySha256");
  const { rows } = await db.query(
    "SELECT * FROM files WHERE sha256_hash = $1 AND owner_user_id = $2",
    [sha256Hash, ownerUserId]
  );
  return rows;
}

async function create(file) {
  const {
    storageLocationId, filenameOriginal, filenameCurrent, extension,
    mimeTypeDeclared, mimeTypeDetected, sizeBytes, originalPath, currentPath,
    createdAtFs, modifiedAtFs, sha256Hash,
  } = file;

  const { rows } = await db.query(
    `INSERT INTO files (
       storage_location_id, filename_original, filename_current, extension,
       mime_type_declared, mime_type_detected, size_bytes, original_path,
       current_path, created_at_fs, modified_at_fs, sha256_hash
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     -- Two scans of one location can be in flight at once: storageWatcher
     -- enqueues a rescan for every watched location on a timer with no check
     -- for one already running, and filesystem events enqueue more. Both then
     -- reach the same new file, both find nothing via findByLocationAndPath,
     -- and both INSERT -- one of which violated uq_files_location_path. That
     -- 23505 was not caught per file, so it escaped the whole "for await"
     -- loop and failed the ENTIRE scan, which BullMQ then retried from the
     -- top, re-walking every directory.
     --
     -- DO UPDATE rather than DO NOTHING so the row always comes back: the
     -- caller needs an id to mark scanned and to enqueue hashing, and a
     -- silent null there would strand the file instead. Touching only
     -- filesystem facts, never anything the pipeline has since decided.
     ON CONFLICT (storage_location_id, current_path) DO UPDATE
       SET size_bytes      = EXCLUDED.size_bytes,
           modified_at_fs  = EXCLUDED.modified_at_fs
     RETURNING *`,
    [
      storageLocationId, filenameOriginal, filenameCurrent, extension,
      mimeTypeDeclared, mimeTypeDetected, sizeBytes, originalPath, currentPath,
      createdAtFs, modifiedAtFs, sha256Hash,
    ]
  );
  return rows[0];
}

/**
 * Move a file between statuses, and keep `deleted_at` honest while doing it.
 *
 * THE BUG THIS FIXES
 *
 * This used to set `status` alone. Every file removed through the normal path
 * -- the Files page "x", bulk delete, the assistant -- therefore landed in the
 * Trash with `status='deleted'` and `deleted_at = NULL`, and two things
 * silently depended on that column:
 *
 *   lifecycleService.findExpired  requires `deleted_at IS NOT NULL`, so the
 *                                 nightly purge could never see these files.
 *                                 The Trash was not a 30-day holding area, it
 *                                 was permanent storage.
 *   the Trash listing             computes days_left from it, so the countdown
 *                                 the retention promise is made with had
 *                                 nothing to count from.
 *
 * Stamped here rather than at the call sites because there are several and
 * they would drift; the timestamp belongs to the transition, not to whoever
 * happened to trigger it.
 *
 * Restoring CLEARS it, for the same reason: a file back in the library with a
 * deletion date still on it is one rescan away from being purged out again.
 */
async function updateStatus(id, status) {
  const { rows } = await db.query(
    // $2 is cast explicitly in both places it appears. Without the casts
    // Postgres has to deduce one type for a parameter used as a file_status in
    // the SET and as text in the CASE, and refuses: "inconsistent types deduced
    // for parameter $2 (text versus file_status)".
    `UPDATE files
        SET status = $2::file_status,
            deleted_at = CASE
                           WHEN $2::text = 'deleted' THEN COALESCE(deleted_at, now())
                           WHEN $2::text = 'active'  THEN NULL
                           ELSE deleted_at
                         END
      WHERE id = $1
      RETURNING *`,
    [id, status]
  );
  return rows[0] || null;
}

async function updateProcessingStatus(id, processingStatus) {
  const { rows } = await db.query(
    "UPDATE files SET processing_status = $2 WHERE id = $1 RETURNING *",
    [id, processingStatus]
  );
  return rows[0] || null;
}

async function updatePath(id, { currentPath, filenameCurrent }, client = null) {
  const exec = client || db;
  const { rows } = await exec.query(
    `UPDATE files SET current_path = $2, filename_current = $3 WHERE id = $1 RETURNING *`,
    [id, currentPath, filenameCurrent]
  );
  return rows[0] || null;
}

async function markScanned(id) {
  await db.query("UPDATE files SET last_scanned_at = now() WHERE id = $1", [id]);
}

/** The document's own date and where it came from (migration 024). */
async function setDocumentDate(id, date, source) {
  await db.query(
    "UPDATE files SET document_date = $2, document_date_source = $3 WHERE id = $1",
    [id, date || null, source || "none"]
  );
}

/**
 * Record the name/folder this file WOULD have, without touching disk.
 *
 * Used for read-only storage locations (migration 018). Deliberately does
 * NOT write filename_current or current_path: those must always describe
 * what is actually on the filesystem, or the next read of this file goes
 * looking in a place that does not exist.
 */
async function setCanonicalName(id, { canonicalFilename, canonicalRelativeDir = null }) {
  const { rows } = await db.query(
    `UPDATE files
     SET canonical_filename = $2, canonical_relative_dir = $3, canonical_set_at = now()
     WHERE id = $1 RETURNING *`,
    [id, canonicalFilename, canonicalRelativeDir]
  );
  return rows[0] || null;
}

/**
 * The input to the shortcut mirror.
 *
 * A file earns its place by being FILED, not by being renamed:
 *
 *   canonical_filename    use it, under canonical_relative_dir  (renamed)
 *   otherwise, a subject  use filename_current, under the subject's path
 *
 * It used to require a canonical name, which meant rejecting a rename
 * proposal made the file DISAPPEAR from the organized folder. Rejecting says
 * "this name is wrong", not "this document does not belong in my
 * repository" -- but the effect was to strand it: no canonical name,
 * therefore no shortcut, therefore invisible in the only view meant to be
 * browsable.
 *
 * Naming and filing are separate decisions and failing at one is no reason to
 * lose the other. Files with neither are genuinely unplaceable and stay out.
 */
async function listForMirror(ownerUserId, { limit = 1000, offset = 0 } = {}) {
  requireOwner(ownerUserId, "listForMirror");
  const { rows } = await db.query(
    `SELECT f.*,
            l.root_path, l.name AS location_name, l.is_read_only,
            COALESCE(f.canonical_filename, f.filename_current) AS mirror_filename,
            COALESCE(f.canonical_relative_dir, cls.subject_path)  AS mirror_relative_dir,
            (f.canonical_filename IS NOT NULL)                    AS is_renamed
       FROM files f
       JOIN storage_locations l ON l.id = f.storage_location_id
       LEFT JOIN LATERAL (
         SELECT s.materialized_path AS subject_path
           FROM classification_results cr
           JOIN subjects s ON s.id = cr.classified_subject_id
          WHERE cr.file_id = f.id AND cr.classified_subject_id IS NOT NULL
          ORDER BY cr.created_at DESC LIMIT 1
       ) cls ON true
      WHERE f.status = 'active'
        AND f.owner_user_id = $3
        AND (f.canonical_filename IS NOT NULL OR cls.subject_path IS NOT NULL)
      ORDER BY f.id
      LIMIT $1 OFFSET $2`,
    [limit, offset, ownerUserId]
  );
  return rows;
}

/**
 * How much of this account's mirror exists.
 *
 * `eligible` MUST use the same predicate as listForMirror above -- active,
 * owned, and carrying either a canonical name or a subject. A count that
 * disagrees with what a sync would actually walk is worse than no count: it
 * reports work as outstanding that no sync will ever do, or reports the mirror
 * complete while files are missing from it. The two queries are next to each
 * other for that reason; change one and change the other.
 */
async function mirrorCounts(ownerUserId) {
  requireOwner(ownerUserId, "mirrorCounts");
  const { rows } = await db.query(
    `SELECT count(*)::int                                              AS eligible,
            count(*) FILTER (WHERE f.mirror_path IS NOT NULL)::int     AS mirrored,
            max(f.mirror_synced_at)                                    AS "lastSyncedAt"
       FROM files f
       LEFT JOIN LATERAL (
         SELECT s.materialized_path AS subject_path
           FROM classification_results cr
           JOIN subjects s ON s.id = cr.classified_subject_id
          WHERE cr.file_id = f.id AND cr.classified_subject_id IS NOT NULL
          ORDER BY cr.created_at DESC LIMIT 1
       ) cls ON true
      WHERE f.status = 'active'
        AND f.owner_user_id = $1
        AND (f.canonical_filename IS NOT NULL OR cls.subject_path IS NOT NULL)`,
    [ownerUserId]
  );
  return rows[0];
}

async function setMirrorPath(id, mirrorPath) {
  const { rows } = await db.query(
    "UPDATE files SET mirror_path = $2, mirror_synced_at = now() WHERE id = $1 RETURNING id",
    [id, mirrorPath]
  );
  return rows[0] || null;
}

async function setCloudPlaceholder(id, isPlaceholder) {
  const { rows } = await db.query(
    `UPDATE files SET is_cloud_placeholder = $2, placeholder_checked_at = now()
     WHERE id = $1 RETURNING id`,
    [id, isPlaceholder]
  );
  return rows[0] || null;
}

async function updateHash(id, sha256Hash) {
  const { rows } = await db.query(
    "UPDATE files SET sha256_hash = $2 WHERE id = $1 RETURNING *",
    [id, sha256Hash]
  );
  return rows[0] || null;
}

async function updateMimeDetected(id, mimeTypeDetected) {
  await db.query("UPDATE files SET mime_type_detected = $2 WHERE id = $1", [id, mimeTypeDetected]);
}

/** Denormalised onto `files` so the Photos workspace, the triage counts and
 *  the dashboard all read the same answer from one column rather than each
 *  joining file_ocr and reaching a slightly different one. */
async function setOcrStatus(id, ocrStatus) {
  const { rows } = await db.query(
    "UPDATE files SET ocr_status = $2 WHERE id = $1 RETURNING id, ocr_status",
    [id, ocrStatus]
  );
  return rows[0] || null;
}

/**
 * Claim a file for OCR, atomically.
 *
 * Returns the row only if this call is the one that moved it to 'queued'.
 *
 * WHY THIS IS NOT read-then-setOcrStatus
 *
 * That is what it was, and it raced. Hashing runs four wide, so between
 * "read: not completed yet" and "write: queued" another worker's OCR job
 * could finish and write 'completed' -- which this write then stamped back to
 * 'queued'. The photo showed "Queued" forever on the Photos page while
 * file_ocr said it had been read. Narrowing the window does not close it; only
 * doing the test and the write in one statement does.
 *
 * 'completed' and 'running' are the states worth protecting: the first is a
 * finished result, the second is a job actively holding the file. A forced
 * re-run bypasses this by calling setOcrStatus directly, which is the correct
 * escape hatch because forcing is an explicit human decision.
 */
async function claimForOcr(id) {
  const { rows } = await db.query(
    `UPDATE files SET ocr_status = 'queued'
      WHERE id = $1 AND ocr_status NOT IN ('completed', 'running')
      RETURNING id`,
    [id]
  );
  return rows[0] || null;
}

/** Marks a file as a picture, decided once at ingestion by mime/extension. */
async function setIsImage(id, isImage) {
  await db.query("UPDATE files SET is_image = $2 WHERE id = $1", [id, Boolean(isImage)]);
}

/**
 * The Photos workspace: pictures and anything else awaiting OCR.
 *
 * Deliberately NOT the ordinary file listing with a filter bolted on. A
 * photograph is judged by looking at it, so this returns what a visual grid
 * needs -- the OCR verdict, its confidence, and where the file is filed -- and
 * orders unreviewed items first, because the point of the page is to work
 * through the ones nobody has looked at yet.
 */
async function listPhotos(ownerUserId, { status = null, limit = 60, offset = 0 } = {}) {
  requireOwner(ownerUserId, "listPhotos");
  const { rows } = await db.query(
    `SELECT f.*, ${FILE_DECORATION_COLUMNS},
            o.status::text AS ocr_result_status,
            o.confidence   AS ocr_confidence,
            o.page_count   AS ocr_page_count,
            o.error_message AS ocr_error,
            length(o.text)  AS ocr_text_length
       FROM files f
       ${FILE_DECORATION}
       LEFT JOIN file_ocr o ON o.file_id = f.id
      WHERE f.owner_user_id = $1
        AND f.status = 'active'
        AND ${NOT_A_DUPLICATE_COPY}
        AND (f.is_image = true OR f.ocr_status <> 'not_needed')
        AND ($4::text IS NULL OR f.ocr_status::text = $4)
      ORDER BY (f.user_resolved_at IS NULL) DESC, f.imported_at DESC
      LIMIT $2 OFFSET $3`,
    [ownerUserId, limit, offset, status]
  );
  return rows;
}

async function countPhotos(ownerUserId, { status = null } = {}) {
  requireOwner(ownerUserId, "countPhotos");
  const { rows } = await db.query(
    `SELECT count(*)::int AS count FROM files f
      WHERE f.owner_user_id = $1
        AND f.status = 'active'
        AND ${NOT_A_DUPLICATE_COPY}
        AND (f.is_image = true OR f.ocr_status <> 'not_needed')
        AND ($2::text IS NULL OR f.ocr_status::text = $2)`,
    [ownerUserId, status]
  );
  return rows[0].count;
}

/**
 * Denormalized AI-enrichment fields (migration 012) -- kept directly on
 * `files` so list views can show a preview without joining
 * classification_results and parsing raw_output JSON per row.
 */
async function updateAiEnrichment(id, { shortTitle, summary, entities }) {
  const { rows } = await db.query(
    `UPDATE files
     SET ai_short_title = $2, ai_summary = $3, ai_entities = $4, ai_classified_at = now()
     WHERE id = $1 RETURNING *`,
    [id, shortTitle, summary, entities ? JSON.stringify(entities) : null]
  );
  return rows[0] || null;
}

/**
 * Mirror a description into the denormalised columns WITHOUT claiming the
 * classifier ran.
 *
 * `ai_classified_at` is not a "last touched" timestamp -- it is the record
 * that the AI classification or vision tier produced this enrichment, and
 * classifyProcessor and descriptionService both branch on it to decide whether
 * an existing summary can be adopted instead of paid for again.
 *
 * The describe stage writes ai_summary for surfaces that already read it
 * (the Files page, the detail modal, the preview pane), and for a file nothing
 * could read that summary is assembled from facts with no model involved.
 * Stamping ai_classified_at alongside it would make that facts-only sentence
 * indistinguishable from a classifier result -- so the next time the file
 * acquired real text, the pipeline would adopt "PDF document, 240 KB, stored
 * in Scans" as its considered description of the contents and never look
 * again. Leaving the timestamp alone keeps it meaning exactly one thing.
 */
async function mirrorDescription(id, { shortTitle, summary }) {
  const { rows } = await db.query(
    `UPDATE files
        SET ai_short_title = COALESCE($2, ai_short_title),
            ai_summary = $3
      WHERE id = $1 RETURNING *`,
    [id, shortTitle, summary]
  );
  return rows[0] || null;
}

/**
 * An already-processed file with byte-for-byte identical content.
 *
 * WHY: registering a second folder that overlaps an existing one used to put
 * every file through the whole pipeline again -- re-read, re-hashed,
 * re-parsed for metadata and text, re-classified, and handed a fresh rename
 * proposal. On a repository assembled from overlapping backups that is the
 * normal case, not the exception: the second folder is mostly the first one,
 * plus the handful of files that are genuinely new. The result was hours of
 * work and thousands of review items to arrive at facts already in the
 * database.
 *
 * Identical bytes cannot extract to different text, so anything downstream of
 * hashing can be adopted from the twin instead of recomputed (see
 * services/knownContentService.js).
 *
 * WHAT COUNTS AS A USABLE TWIN
 *
 *   not deleted        a removed file's results are still true, but adopting
 *                      from one would quietly resurrect a decision the user
 *                      made about it.
 *   has file_content   the marker that extraction actually finished. Without
 *                      it there is nothing to adopt, and the new file must go
 *                      through the pipeline normally.
 *   extraction not
 *   'failed'           a failed extraction is a state to retry, not to
 *                      propagate. Adopting one would turn a single broken
 *                      file into a hundred, all of them looking settled.
 *   not a placeholder  a cloud placeholder was skipped, not processed.
 *
 *   IS CLASSIFIED     the twin's latest classification actually puts it
 *                     somewhere. See below -- this one is load-bearing.
 *
 * WHY THE CLASSIFICATION REQUIREMENT EXISTS
 *
 * "Has a file_content row" was the only completeness test, and it is not one.
 * file_content is written at the end of extract_text, but extract_metadata,
 * classify and generate_names are SEPARATE QUEUES with their own backlogs, so
 * during any sizeable import the normal state of a twin is "text extracted,
 * nothing else yet".
 *
 * Adopting from a twin in that state was silently destructive. adoptFrom
 * copies whatever exists at that instant, so the new file inherited text and
 * nothing else -- no classification, therefore no subject. hashProcessor then
 * RETURNS EARLY on the adoption path, so it never enqueues the analysis stages
 * either. And listUnprocessed, the self-healing rescan, skips any file that
 * has both a hash and a file_content row -- which this file now does.
 *
 * The result: a file with text, no subject, no metadata, no proposal, absent
 * from the shortcut mirror entirely (listForMirror requires a canonical name
 * or a subject path), and invisible to every recovery mechanism in the system.
 * Permanently. On the exact workload -- a big overlapping import -- this
 * feature was written for.
 *
 * Requiring a real classification means an adoption always carries the thing
 * that files the document. A twin that has not got there yet simply is not a
 * twin worth adopting from, and the new file takes the ordinary pipeline,
 * which is the correct outcome and the one that used to happen anyway.
 *
 * Ordered so the BEST-developed twin wins: one that has been classified and
 * named carries more to inherit than one that has only been extracted, and
 * the earliest import breaks ties so the choice is stable across runs rather
 * than depending on which row the planner happened to return first.
 *
 * WHY THE OWNER IS REQUIRED HERE
 *
 * Adoption copies extracted text, metadata, document date, classification and
 * the AI summary from the twin. Without an owner scope, the twin could be
 * another account's file -- so registering a folder containing a common
 * document (a bank's standard terms, a government form) would silently import
 * a stranger's AI-generated summary of it, their subject placement, and the
 * document date they had corrected by hand. Nothing in the UI would say where
 * any of it came from. Same bytes is not same document once there is more
 * than one archive.
 */
async function findProcessedTwinByHash(sha256Hash, excludeFileId, ownerUserId) {
  if (!sha256Hash) return null;
  requireOwner(ownerUserId, "findProcessedTwinByHash");
  const { rows } = await db.query(
    `SELECT f.*
       FROM files f
       JOIN file_content fc ON fc.file_id = f.id
       -- "Latest row wins" -- the same rule adoptFrom itself applies when it
       -- picks which classification to copy, so this test and that choice can
       -- never disagree.
       JOIN LATERAL (
         SELECT cr.classified_subject_id, cr.classified_document_type_id
           FROM classification_results cr
          WHERE cr.file_id = f.id
          ORDER BY cr.created_at DESC LIMIT 1
       ) latest ON true
      WHERE f.sha256_hash = $1
        AND f.id <> $2
        AND f.owner_user_id = $3
        AND f.status <> 'deleted'
        AND f.is_cloud_placeholder IS NOT TRUE
        AND fc.extraction_status <> 'failed'
        AND (latest.classified_subject_id IS NOT NULL
             OR latest.classified_document_type_id IS NOT NULL)
      ORDER BY (f.canonical_filename IS NOT NULL) DESC,
               (f.ai_classified_at IS NOT NULL) DESC,
               f.imported_at ASC
      LIMIT 1`,
    [sha256Hash, excludeFileId, ownerUserId]
  );
  return rows[0] || null;
}

/**
 * Duplicate-cost-skip: find a sibling file (same content hash, already
 * AI-classified) so the LLM classifier never has to run twice against
 * identical content. Excludes the file itself.
 *
 * Owner-scoped for the same reason as findProcessedTwinByHash: the point of
 * this lookup is to reuse a Gemini result, and a Gemini result is a
 * description of a document written into someone's archive. Saving a fraction
 * of a cent is not a reason to copy it across an account boundary.
 */
async function findClassifiedSiblingByHash(sha256Hash, excludeFileId, ownerUserId) {
  requireOwner(ownerUserId, "findClassifiedSiblingByHash");
  const { rows } = await db.query(
    `SELECT * FROM files
     WHERE sha256_hash = $1 AND id != $2 AND owner_user_id = $3
       AND ai_classified_at IS NOT NULL
     ORDER BY ai_classified_at DESC LIMIT 1`,
    [sha256Hash, excludeFileId, ownerUserId]
  );
  return rows[0] || null;
}

/**
 * Active files in a storage location that were NOT touched by the current
 * scan pass (last_scanned_at older than `since`, or never scanned at all).
 * Used by the scan job to detect files that disappeared from disk between
 * scans (spec §31 reconciliation).
 */
async function listStaleActive(storageLocationId, since) {
  const { rows } = await db.query(
    `SELECT * FROM files
     WHERE storage_location_id = $1 AND status = 'active'
       AND (last_scanned_at IS NULL OR last_scanned_at < $2)`,
    [storageLocationId, since]
  );
  return rows;
}

/**
 * Files this location has already DISCOVERED but never finished processing:
 * a row exists, but there is no hash, or no extracted-content row to go with
 * it.
 *
 * WHY THIS EXISTS
 *
 * Job handoff runs through Redis, and Redis can lose work in ways the
 * database never sees -- a power cut mid-import, a Memurai restart, an
 * operator killing the worker. The file row is already committed at that
 * point, so the next scan sees a file it recognizes whose size and mtime
 * have not changed, marks it scanned, and moves on. Nothing ever retries it.
 * The file then sits in the list forever: no hash, no text, unsearchable,
 * permanently "pending", and completely silent about it.
 *
 * Two exclusions keep this from creating work rather than recovering it:
 *
 *   created_at < `before`  -- files this very scan just inserted already
 *     have a hash job in flight and legitimately have no hash yet.
 *   no queued/running job  -- a file that is merely waiting its turn in a
 *     long backlog is not stranded, and re-enqueueing it every rescan would
 *     multiply the backlog it is already stuck behind.
 *
 * Cloud placeholders are deliberately INCLUDED. hashProcessor skips them on
 * purpose and tells the user "it will be processed automatically once its
 * contents are available locally" -- a promise nothing kept until now. Their
 * re-check is cheap and correctly starts the pipeline once iCloud has
 * materialized the bytes.
 */
async function listUnprocessed(storageLocationId, before) {
  const { rows } = await db.query(
    `SELECT f.id, f.filename_current, f.current_path, f.sha256_hash IS NULL AS needs_hash
       FROM files f
      WHERE f.storage_location_id = $1
        AND f.status = 'active'
        AND f.created_at < $2
        AND (f.sha256_hash IS NULL
             OR NOT EXISTS (SELECT 1 FROM file_content fc WHERE fc.file_id = f.id))
        AND NOT EXISTS (
              SELECT 1 FROM processing_jobs pj
               WHERE pj.status IN ('queued', 'running')
                 AND pj.payload->>'fileId' = f.id::text
                 -- ...but only if that job is plausibly still alive.
                 --
                 -- 'queued'/'running' is not a reliable statement about
                 -- reality: a worker killed mid-job (power cut, Memurai
                 -- restart, an operator closing the window) leaves its row
                 -- at 'running' forever, and a Redis enqueue that failed
                 -- outright used to leave one at 'queued' forever. Either
                 -- way the anti-join above then excluded the file from the
                 -- ONE mechanism written to rescue it -- permanently, on
                 -- every future scan. The stranded file is exactly what this
                 -- query exists to find, so it must not take a stale row's
                 -- word for it.
                 --
                 -- A day is far longer than any real job here takes (the
                 -- slowest, a full scan of ~9,400 files, is minutes) and far
                 -- shorter than "forever".
                 AND pj.created_at > now() - interval '24 hours'
            )`,
    [storageLocationId, before]
  );
  return rows;
}

/**
 * Per-location processing backlog, split into the two cases that mean very
 * different things to whoever is watching:
 *
 *   inFlight -- discovered, not finished, but a job is queued or running.
 *     Normal. A big import looks like this for an hour and there is nothing
 *     to do but wait.
 *   stalled  -- discovered, not finished, and nothing is going to pick it
 *     up. This is the silent failure: the file is listed but unsearchable
 *     and no amount of waiting fixes it. The next scan repairs these (see
 *     listUnprocessed), so a non-zero number here is "will heal", not
 *     "lost" -- but it should still be visible rather than invisible.
 *
 * One query for every location; the Storage Locations page renders a card
 * per location and must not issue a count per card.
 */
async function countBacklogByLocation(ownerUserId) {
  requireOwner(ownerUserId, "countBacklogByLocation");
  const { rows } = await db.query(
    `SELECT f.storage_location_id,
            count(*) FILTER (WHERE j.file_id IS NOT NULL)::int AS in_flight,
            count(*) FILTER (WHERE j.file_id IS NULL)::int     AS stalled
       FROM files f
       LEFT JOIN LATERAL (
            SELECT 1 AS file_id FROM processing_jobs pj
             WHERE pj.status IN ('queued', 'running')
               AND pj.payload->>'fileId' = f.id::text
             LIMIT 1
       ) j ON true
      WHERE f.status = 'active'
        AND f.owner_user_id = $1
        AND (f.sha256_hash IS NULL
             OR NOT EXISTS (SELECT 1 FROM file_content fc WHERE fc.file_id = f.id))
      GROUP BY f.storage_location_id`,
    [ownerUserId]
  );
  return Object.fromEntries(
    rows.map((r) => [r.storage_location_id, { inFlight: r.in_flight, stalled: r.stalled }])
  );
}

/**
 * Candidate pool for probable-duplicate / version detection: other active
 * files that plausibly share content with `file`, joined to their extracted
 * text so the comparison itself needs no second round trip.
 *
 * The pre-filter is deliberately coarse -- same extension, non-empty text,
 * not an exact-hash match (those are already handled as EXACT duplicates by
 * detectDuplicatesProcessor, and re-reporting them as "probable" would be
 * both wrong and noisy). Similarity scoring itself happens in JS
 * (services/similarityService.js), not SQL.
 *
 * `limit` bounds the pool because this runs per-file during ingestion: a
 * repository with 50k files of one extension must not turn every import
 * into a 50k-way comparison. The bound is a deliberate recall/cost trade --
 * see the note in detectDuplicatesProcessor.
 */
async function listSimilarityCandidates(file, { limit = 300 } = {}) {
  // The candidate pool is drawn from the file's OWN owner, taken off the file
  // row rather than passed in -- a similarity comparison against a document
  // the user cannot open would produce a duplicate group whose other half is
  // invisible to them, and an "existing similar document" warning naming a
  // file that does not exist as far as they are concerned.
  const ownerUserId = requireOwner(file.owner_user_id, "listSimilarityCandidates");
  const { rows } = await db.query(
    `SELECT f.id, f.filename_current, f.filename_original, f.current_path,
            f.size_bytes, f.extension, f.sha256_hash, fc.extracted_text
     FROM files f
     JOIN file_content fc ON fc.file_id = f.id
     WHERE f.id != $1
       AND f.owner_user_id = $5
       AND f.status = 'active'
       AND f.extension IS NOT DISTINCT FROM $2
       AND (f.sha256_hash IS NULL OR f.sha256_hash IS DISTINCT FROM $3)
       AND fc.extracted_text IS NOT NULL
       AND length(fc.extracted_text) > 0
     ORDER BY f.imported_at DESC
     LIMIT $4`,
    [file.id, file.extension, file.sha256_hash, limit, ownerUserId]
  );
  return rows;
}

/**
 * The search that actually makes this app useful: matches a file by what is
 * INSIDE it, not just what it is called.
 *
 * Someone looking for a document does not remember its filename -- that is
 * the whole reason the filenames were a mess to begin with. They remember a
 * party, an amount, a phrase. This searches extracted content, the AI title
 * and summary, and the filename together, ranks them, and returns a snippet
 * of the matching text with the hit marked.
 *
 * Ranking puts a filename or title hit above a body hit: if a document is
 * literally named after what you typed, it is almost certainly the one you
 * meant.
 */
/**
 * @param {object} [opts]
 * @param {string|null} [opts.subjectId] - EXACT-match scope, used by the
 *   Subjects page to search within the branch you have open. Deliberately not
 *   the same thing as `filters.subjectId`, which is the Files page's subject
 *   FILTER and includes descendants: browsing a subject shows that subject's
 *   own files, so searching inside it must match, while picking "Finance"
 *   from a dropdown means Finance and everything under it.
 * @param {object|null} [opts.filters] - parseFileFilters() output
 */
async function searchEverything(query, { limit = 50, offset = 0, subjectId = null, filters = null } = {}) {
  const tsQuery = tsQueryExpression(1);

  // Parameters are numbered dynamically because the filter set is variable:
  // $1 is always the search term, then the optional subject scope, then
  // whatever filters were asked for, and limit/offset last.
  const params = [query];
  const bind = (value) => { params.push(value); return `$${params.length}`; };

  // Optional scope: only files whose LATEST classification puts them in this
  // subject. Same "latest wins" rule as listBySubject -- a file that was
  // reclassified belongs where it is now, not everywhere it has ever been.
  const subjectFilter = subjectId
    ? `AND EXISTS (
         SELECT 1 FROM (
           SELECT classified_subject_id FROM classification_results cr
           WHERE cr.file_id = f.id ORDER BY cr.created_at DESC LIMIT 1
         ) latest WHERE latest.classified_subject_id = ${bind(subjectId)}
       )`
    : "";

  const filterSql = buildFilterSql(filters, params.length + 1);
  params.push(...filterSql.params);
  const limitParam = bind(limit);
  const offsetParam = bind(offset);

  const { rows } = await db.query(
    `WITH matches AS (
       SELECT f.id,
              -- Weighted so a name match outranks a body match, and a body
              -- match still beats nothing.
              GREATEST(
                CASE WHEN f.filename_current ILIKE '%' || $1 || '%'
                       OR f.filename_original ILIKE '%' || $1 || '%' THEN 1.0 ELSE 0 END,
                CASE WHEN f.ai_short_title ILIKE '%' || $1 || '%' THEN 0.9 ELSE 0 END,
                CASE WHEN f.canonical_filename ILIKE '%' || $1 || '%' THEN 0.9 ELSE 0 END,
                CASE WHEN f.ai_summary ILIKE '%' || $1 || '%' THEN 0.6 ELSE 0 END,
                CASE WHEN fc.search_vector @@ (${tsQuery})
                     THEN 0.5 + LEAST(ts_rank(fc.search_vector, ${tsQuery})::numeric, 0.4)
                     ELSE 0 END
              ) AS rank,
              (fc.search_vector @@ (${tsQuery})) AS matched_content,
              (f.filename_current ILIKE '%' || $1 || '%'
                 OR f.filename_original ILIKE '%' || $1 || '%'
                 OR f.canonical_filename ILIKE '%' || $1 || '%') AS matched_filename,
              (f.ai_short_title ILIKE '%' || $1 || '%'
                 OR f.ai_summary ILIKE '%' || $1 || '%') AS matched_ai
       FROM files f
       LEFT JOIN file_content fc ON fc.file_id = f.id
       WHERE ${LISTABLE_FILE}
       ${subjectFilter}
       ${filterSql.sql}
     )
     SELECT f.*, ${FILE_DECORATION_COLUMNS},
            m.rank, m.matched_content, m.matched_filename, m.matched_ai,
            -- A short excerpt around the hit, with <mark> around the term.
            -- MaxFragments=2 keeps it to a couple of sentences rather than
            -- dumping a paragraph into a table cell.
            CASE WHEN m.matched_content THEN
              ts_headline('simple', fc.extracted_text, ${tsQuery},
                'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=22, MinWords=8, FragmentDelimiter=" … "')
            END AS snippet
     FROM matches m
     JOIN files f ON f.id = m.id
     LEFT JOIN file_content fc ON fc.file_id = f.id
     ${FILE_DECORATION}
     WHERE m.rank > 0
     ORDER BY m.rank DESC, f.imported_at DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params
  );
  return rows;
}

async function searchByFilename(fragment, ownerUserId, { limit = 50, offset = 0 } = {}) {
  requireOwner(ownerUserId, "searchByFilename");
  const { rows } = await db.query(
    `SELECT * FROM files
     WHERE (filename_original ILIKE '%' || $1 || '%' OR filename_current ILIKE '%' || $1 || '%')
       AND owner_user_id = $4
       AND status != 'deleted'
     ORDER BY imported_at DESC LIMIT $2 OFFSET $3`,
    [fragment, limit, offset, ownerUserId]
  );
  return rows;
}

/**
 * The Files page's default view (no search term, no explicit status
 * filter). Deliberately NOT the generic base.list() -- that has no WHERE
 * clause at all, so a removed file (single "x" or bulk "Remove all files")
 * kept showing up here forever with just a "deleted" badge instead of
 * disappearing, which is exactly the bug this fixes. Everything except
 * 'deleted' still shows (active/missing/moved/changed/archived) -- only an
 * explicit removal hides a file from the default view; ?status=deleted
 * still works for anyone who wants to see what was removed.
 */
/**
 * Answers the two questions the Files page could not previously answer:
 * "where does this file live in the taxonomy?" and "has it actually been
 * named yet, or is it still waiting on me?"
 *
 * Both come from LATERAL subqueries taking the LATEST row -- a file can be
 * reclassified and can accumulate proposals, and only the most recent of
 * each describes where it stands now.
 *
 * naming_state is derived rather than stored, because it is a view of two
 * separate facts (does a canonical name exist, is a proposal outstanding):
 *   named    -- a canonical name has been applied
 *   pending  -- a proposal is waiting for review
 *   rejected -- the suggestion was turned down, which SETTLES the file: its
 *               own name is the right one. Not an unfinished state and not a
 *               failure -- the file is still filed under its subject and
 *               still appears in the shortcut mirror under that original
 *               name (see listForMirror: naming and filing are separate
 *               decisions and losing one never costs the other). The UI
 *               labels it "original name kept" for exactly this reason.
 *   none     -- nothing proposed yet (still processing, or nothing to say)
 */
const FILE_DECORATION = `
  LEFT JOIN storage_locations loc ON loc.id = f.storage_location_id
  LEFT JOIN LATERAL (
    SELECT s.id AS subject_id, s.name AS subject_name, s.materialized_path AS subject_path
    FROM classification_results cr
    LEFT JOIN subjects s ON s.id = cr.classified_subject_id
    WHERE cr.file_id = f.id
    ORDER BY cr.created_at DESC LIMIT 1
  ) cls ON true
  LEFT JOIN LATERAL (
    SELECT rp.status, rp.proposed_filename, rp.proposed_relative_dir
    FROM rename_proposals rp
    WHERE rp.file_id = f.id
    ORDER BY rp.created_at DESC LIMIT 1
  ) prop ON true
`;

const FILE_DECORATION_COLUMNS = `
  cls.subject_id,
  cls.subject_name,
  cls.subject_path,
  -- Where this file physically lives. f.* already carries document_date and
  -- document_date_source; only the location's NAME needs a join, and the
  -- listings show the name rather than the uuid.
  loc.name         AS location_name,
  loc.is_read_only AS location_is_read_only,
  prop.status AS proposal_status,
  prop.proposed_filename,
  prop.proposed_relative_dir,
  CASE
    WHEN f.canonical_filename IS NOT NULL THEN 'named'
    WHEN prop.status = 'pending'          THEN 'pending'
    WHEN prop.status = 'approved'         THEN 'pending'
    WHEN prop.status = 'rejected'         THEN 'rejected'
    WHEN prop.status = 'applied'          THEN 'named'
    ELSE 'none'
  END AS naming_state
`;

async function listNotDeleted({ limit = 50, offset = 0, filters = null, sort = null } = {}) {
  // Filters apply here, not only to search. "Every PDF from 2019" contains no
  // search term, and a filter bar that goes dead the moment you clear the
  // search box is a filter bar that does not work.
  const { sql, params } = buildFilterSql(filters, 1);
  const orderBy = buildOrderBy(sort);
  const { rows } = await db.query(
    `SELECT f.*, ${FILE_DECORATION_COLUMNS}
     FROM files f
     ${FILE_DECORATION}
     WHERE ${LISTABLE_FILE}
     ${sql}
     ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return rows;
}

/**
 * How many files sit directly under a subject, under the current filters.
 *
 * Deliberately the same eligibility rules as listBySubject -- active only,
 * losing copies of resolved duplicate groups excluded, exact subject match
 * rather than descendant-inclusive. A total that counted a different set from
 * the list it labels is worse than no total.
 */
async function countInSubject(subjectId, { filters = null } = {}) {
  const { sql, params } = buildFilterSql(filters, 2);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM files f
       JOIN LATERAL (
         SELECT classified_subject_id FROM classification_results cr
         WHERE cr.file_id = f.id ORDER BY cr.created_at DESC LIMIT 1
       ) latest ON true
      WHERE latest.classified_subject_id = $1 AND f.status = 'active'
        AND ${NOT_A_DUPLICATE_COPY}
      ${sql}`,
    [subjectId, ...params]
  );
  return rows[0]?.count || 0;
}

/**
 * Just the ids matching a filter set, for "select all 1,240".
 *
 * A selection UI that can only ever tick what is on screen makes filing a real
 * backlog into sixty page-selects, which is the point at which people give up
 * and the archive stays a mess. This is the cheap half of fixing that: ids
 * only, no decoration joins, capped.
 *
 * The cap is a real limit and not a formality -- the caller is told when it
 * bites (see fileService.matchingIds) rather than silently receiving a
 * truncated selection, because "select all" that quietly means "select the
 * first five thousand" is how a bulk action files the wrong set.
 *
 * ELIGIBILITY FOLLOWS THE LIST BEING SELECTED FROM, AND THE TWO LISTS DIFFER
 *
 * "Select all" has exactly one job: end up with the set the user is looking
 * at. So the rule here cannot be a rule of its own -- it has to be whichever
 * rule drew the rows on screen, and this application has two:
 *
 *   in a subject   listBySubject / countInSubject -- active only, and losing
 *                  copies of resolved duplicate groups excluded
 *   everywhere else listNotDeleted / countMatching -- everything that is not
 *                  deleted, duplicates included
 *
 * Applying the subject rule to both is what this function used to do, and it
 * under-selected silently on the second: a `missing`, `moved`, `changed` or
 * `archived` file, or a duplicate copy, was listed, was counted, and was then
 * left out of the selection with no message -- `capped` is false, so nothing
 * fired. The visible symptom was the unfiled pile refusing to empty. You file
 * "all 40", the tile still says 3, and the loop the Library is built around
 * (open the pile, select it, file it, watch the number drop) quietly stops
 * being true, with nothing on screen explaining why.
 *
 * Local databases are usually all-active, so this cannot be reproduced away
 * from a real corpus -- which is exactly why it is written down here rather
 * than left to be rediscovered.
 */
async function idsMatching({ filters = null, subjectId = null, limit = 5000 } = {}) {
  const startIndex = subjectId ? 2 : 1;
  const { sql, params } = buildFilterSql(filters, startIndex);

  // Subject scope: mirror listBySubject exactly -- latest-row subject match,
  // active only, resolved-duplicate losers excluded.
  const scope = subjectId
    ? `JOIN LATERAL (
         SELECT classified_subject_id FROM classification_results cr
         WHERE cr.file_id = f.id ORDER BY cr.created_at DESC LIMIT 1
       ) latest ON true`
    : "";
  const eligibility = subjectId
    ? `latest.classified_subject_id = $1 AND f.status = 'active'
        AND ${NOT_A_DUPLICATE_COPY}`
    // Everything else (the table's "Everything" scope, the unfiled pile):
    // mirror listNotDeleted, which is the query that put these rows on screen.
    : LISTABLE_FILE;

  const { rows } = await db.query(
    `SELECT f.id
       FROM files f
       ${scope}
      WHERE ${eligibility}
      ${sql}
      LIMIT $${params.length + startIndex}`,
    subjectId ? [subjectId, ...params, limit] : [...params, limit]
  );
  return rows.map((r) => r.id);
}

/**
 * How many files the current filter set matches, over the WHOLE repository
 * rather than the page being shown.
 *
 * This is what makes a filter usable at this scale. Narrowing 9,398 files to
 * a screen of 25 looks identical whether the filter matched 25 or 25,000, and
 * "did that do anything?" is not a question the user should have to answer by
 * clicking Next until it runs out.
 */
async function countMatching({ filters = null, includeDeleted = false } = {}) {
  const { sql, params } = buildFilterSql(filters, 1);
  const { rows } = await db.query(
    `SELECT count(*)::int AS count
       FROM files f
      WHERE ${includeDeleted ? "TRUE" : LISTABLE_FILE}
      ${sql}`,
    params
  );
  return rows[0].count;
}

/**
 * What is actually IN the repository to filter by: the file types present,
 * with counts, and the span the document dates cover.
 *
 * Without this the type dropdown is either a hardcoded guess at what a
 * church archive contains or a free-text box, and both offer options that
 * match nothing. Counts are included so the list can be ordered by how much
 * of the repository each type represents -- the same argument
 * dashboardRepository.byExtension makes.
 */
async function filterFacets(ownerUserId) {
  requireOwner(ownerUserId, "filterFacets");
  const [extensions, dates] = await Promise.all([
    db.query(
      `SELECT coalesce(nullif(lower(f.extension), ''), 'none') AS ext,
              count(*)::int AS count
         FROM files f
        WHERE f.status != 'deleted' AND f.owner_user_id = $1
        GROUP BY 1
        ORDER BY count DESC, ext`,
      [ownerUserId]
    ),
    db.query(
      `SELECT min(document_date) AS earliest, max(document_date) AS latest,
              count(*) FILTER (WHERE document_date IS NULL)::int AS undated
         FROM files WHERE status != 'deleted' AND owner_user_id = $1`,
      [ownerUserId]
    ),
  ]);
  return { extensions: extensions.rows, dateRange: dates.rows[0] };
}

// Both of these back "remove ALL files" (fileService.removeAll and
// bulkDeleteProcessor). An unscoped `status = 'active'` there would have
// enumerated -- and then queued for deletion -- every account's files from one
// user's button press. That is the single most destructive unscoped query in
// the codebase, which is why the owner is a positional argument rather than an
// option with a default.
async function listByStatus(status, ownerUserId, { limit = 100, offset = 0, excludeIds = null } = {}) {
  requireOwner(ownerUserId, "listByStatus");
  const { rows } = await db.query(
    `SELECT * FROM files
     WHERE status = $1 AND owner_user_id = $5 AND ($4::uuid[] IS NULL OR id <> ALL($4))
     ORDER BY imported_at DESC LIMIT $2 OFFSET $3`,
    [status, limit, offset, excludeIds && excludeIds.length ? excludeIds : null, ownerUserId]
  );
  return rows;
}

/** Cheap count for progress totals (e.g. "remove all files" job sizing) --
 * avoids pulling every row across the wire just to know how many there are. */
async function countByStatus(status, ownerUserId) {
  requireOwner(ownerUserId, "countByStatus");
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS count FROM files WHERE status = $1 AND owner_user_id = $2",
    [status, ownerUserId]
  );
  return rows[0].count;
}

/**
 * Active files currently classified under a subject, keyed off each file's
 * MOST RECENT classification_results row (a file can be reclassified, so
 * "latest wins" rather than "any match ever"). This backs the Subjects
 * page's file browser -- it deliberately does NOT go through the separate
 * `documents`/`document_subjects` tables (a distinct "logical Document
 * identity" concept from docs/01-domain-model.md) because nothing in the
 * classify/generate-names/bulk-rename pipeline ever populates those; a
 * Subjects browser backed by them would show nothing forever regardless of
 * how many files actually got classified and moved into that subject.
 */
async function listBySubject(subjectId, { limit = 50, offset = 0, filters = null, sort = null } = {}) {
  // $1 is the subject; filters occupy $2.. and limit/offset come last.
  const { sql, params } = buildFilterSql(filters, 2);
  // Built from a whitelist, never from request text -- see fileFilters.parseSort.
  const orderBy = buildOrderBy(sort);
  const { rows } = await db.query(
    `SELECT f.id, f.filename_current, f.filename_current AS display_name, f.current_path,
            f.ai_short_title, f.imported_at, f.size_bytes,
            f.document_date, f.document_date_source,
            loc.name AS location_name
     FROM files f
     LEFT JOIN storage_locations loc ON loc.id = f.storage_location_id
     JOIN LATERAL (
       SELECT classified_subject_id FROM classification_results cr
       WHERE cr.file_id = f.id ORDER BY cr.created_at DESC LIMIT 1
     ) latest ON true
     WHERE latest.classified_subject_id = $1 AND f.status = 'active'
       -- "Resolving" a duplicate group only records which copy is
       -- canonical -- it never deletes or deactivates the other identical
       -- copies (spec §13: never auto-delete just because files look
       -- alike). Without this, a document you'd already resolved kept
       -- showing up here once per physical copy, looking exactly like a
       -- fresh, unresolved duplicate. This excludes a file only when it's
       -- the LOSING side of an ALREADY-RESOLVED group (canonical_file_id
       -- is set and isn't this file) -- files in a still-open group, or
       -- not in any group at all, are unaffected.
       AND ${NOT_A_DUPLICATE_COPY}
     ${sql}
     ORDER BY ${orderBy} LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
    [subjectId, ...params, limit, offset]
  );
  return rows;
}

/**
 * Same eligibility rules as listBySubject (active, not the losing side of
 * an already-resolved duplicate group) but returns just the count -- used
 * to decide whether a subject can be deleted without pulling every row.
 */
async function countBySubject(subjectId, ownerUserId) {
  requireOwner(ownerUserId, "countBySubject");
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM files f
     JOIN LATERAL (
       SELECT classified_subject_id FROM classification_results cr
       WHERE cr.file_id = f.id ORDER BY cr.created_at DESC LIMIT 1
     ) latest ON true
     WHERE latest.classified_subject_id = $1 AND f.status = 'active'
       AND ${NOT_A_DUPLICATE_COPY}
       AND f.owner_user_id = $2`,
    [subjectId, ownerUserId]
  );
  return rows[0].count;
}

/**
 * Direct file count for EVERY subject in one query.
 *
 * Same eligibility rules as countBySubject, but the Subjects tree needs a
 * number next to every node -- calling countBySubject per node is an N+1
 * that grows with the taxonomy. Returns a plain { subjectId: count } map;
 * rolling those up to include descendants happens in subjectService, which
 * already has the materialized paths.
 */
async function countsBySubject({ filters = null } = {}) {
  // Filtered as well, so the number beside a branch always describes what
  // clicking it will show. A tree that says "412" and then lists 3 files
  // because a filter is on is worse than no number.
  const { sql, params } = buildFilterSql(filters, 1);
  const { rows } = await db.query(
    `SELECT latest.classified_subject_id AS subject_id, COUNT(*)::int AS count
     FROM files f
     JOIN LATERAL (
       SELECT classified_subject_id FROM classification_results cr
       WHERE cr.file_id = f.id ORDER BY cr.created_at DESC LIMIT 1
     ) latest ON true
     WHERE latest.classified_subject_id IS NOT NULL AND f.status = 'active'
       AND ${NOT_A_DUPLICATE_COPY}
     ${sql}
     GROUP BY latest.classified_subject_id`,
    params
  );
  return Object.fromEntries(rows.map((r) => [r.subject_id, r.count]));
}

/**
 * The same count, for the other classification axis.
 *
 * Kept deliberately parallel to countsBySubject -- same latest-row rule, same
 * active-only rule, same duplicate exclusion -- because the two numbers appear
 * in two browse surfaces that a user will compare. If "Invoice: 12" and
 * "Finance: 12" counted different things, one of them would be a lie and
 * neither page would say which.
 *
 * No rollup here: document types are flat by design (docs/03-taxonomy.md
 * §3.4). "Invoice" means Invoice.
 */
async function countsByDocumentType({ filters = null } = {}) {
  const { sql, params } = buildFilterSql(filters, 1);
  const { rows } = await db.query(
    `SELECT latest.classified_document_type_id AS document_type_id, COUNT(*)::int AS count
     FROM files f
     JOIN LATERAL (
       SELECT classified_document_type_id FROM classification_results cr
       WHERE cr.file_id = f.id ORDER BY cr.created_at DESC LIMIT 1
     ) latest ON true
     WHERE latest.classified_document_type_id IS NOT NULL AND f.status = 'active'
       AND ${NOT_A_DUPLICATE_COPY}
     ${sql}
     GROUP BY latest.classified_document_type_id`,
    params
  );
  return Object.fromEntries(rows.map((r) => [r.document_type_id, r.count]));
}

/**
 * How many of the owner's files carry no document type at all.
 *
 * This number is the point of the page, not a footnote. The axis is populated
 * by the AI tier, by a filename/extension signal, or by hand -- so on a real
 * corpus most files legitimately have no type yet, and a browse page that
 * silently omitted them would suggest the corpus is smaller than it is.
 */
async function countUntyped({ filters = null } = {}) {
  const { sql, params } = buildFilterSql(filters, 1);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM files f
     LEFT JOIN LATERAL (
       SELECT classified_document_type_id FROM classification_results cr
       WHERE cr.file_id = f.id ORDER BY cr.created_at DESC LIMIT 1
     ) latest ON true
     WHERE latest.classified_document_type_id IS NULL AND f.status = 'active'
       AND ${NOT_A_DUPLICATE_COPY}
     ${sql}`,
    params
  );
  return rows[0]?.count || 0;
}

/**
 * Several files by id, keeping only the caller's own.
 *
 * The bulk operations all need this. Doing it as one query rather than a loop
 * of findByIdForOwner is not only faster -- it makes "silently drop the ones
 * that are not yours" impossible to express by accident, because the caller
 * gets back a list it must compare against what it asked for. bulkService
 * does exactly that and reports the difference rather than pretending the
 * whole batch succeeded.
 */
/**
 * Which of these ids survive the filter set -- as a Set, for candidates that
 * arrived from somewhere other than SQL.
 *
 * WHY A SEPARATE PASS RATHER THAN A PREDICATE IN THE ORIGINAL QUERY
 *
 * The hybrid search (services/descriptionSearchService) fuses three ranked
 * signals, and only one of them is a database query that can carry the filter
 * clauses. The semantic signal scores in-memory vectors and the description
 * signal ranks a different table; both produce bare file ids that never passed
 * through buildFilterSql. Fusing them with the filtered signal put files back
 * into the result that every filter on screen excluded -- searching inside one
 * subject returned documents from other subjects and other storage locations,
 * which is precisely the "a filter must NARROW a search, not be replaced by
 * it" contract that scripts/verify-search-filters.js exists to hold.
 *
 * Gating the fused set here keeps the ranking intact (this decides membership,
 * never order) and keeps one definition of what a filter means, which is the
 * whole argument in the header of fileFilters.js.
 *
 * `status <> 'deleted'` rides along because it is the same bar searchEverything
 * applies. The two id-only signals read tables that have no opinion about file
 * status, so without it a deleted file stayed findable by its description.
 */
async function idsPassingFilters(ids, { filters = null } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return new Set();
  // $1 is the id array; the filter clauses (owner first, always) start at $2.
  const { sql, params } = buildFilterSql(filters, 2);
  const { rows } = await db.query(
    `SELECT f.id
       FROM files f
      WHERE f.id = ANY($1::uuid[])
        AND f.status <> 'deleted'
      ${sql}`,
    [ids, ...params]
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Which of these files are ALREADY filed under this subject.
 *
 * Filing a file where it already is still writes a classification row, and
 * "latest row wins" means that row is then the file's history. Re-filing
 * 50,000 files that never moved would bury every real placement decision under
 * a wall of no-ops, and cost 50,000 writes to change nothing.
 *
 * Used by the bulk move to subtract the no-ops before it starts, and to report
 * them honestly ("12,000 matched, 11,000 were already there") rather than
 * claiming credit for moving files that never went anywhere.
 */
async function idsCurrentlyInSubject(ids, subjectId) {
  if (!Array.isArray(ids) || ids.length === 0 || !subjectId) return new Set();
  const { rows } = await db.query(
    `SELECT f.id
       FROM files f
       JOIN LATERAL (
         SELECT classified_subject_id FROM classification_results cr
         WHERE cr.file_id = f.id ORDER BY cr.created_at DESC LIMIT 1
       ) latest ON true
      WHERE f.id = ANY($1::uuid[])
        AND latest.classified_subject_id = $2`,
    [ids, subjectId]
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * What is sitting in Archive or Trash.
 *
 * A separate function rather than a `status` filter on the normal listing,
 * because these views answer a different question and need a different column:
 * Trash has to show how long each file has left, which nothing else cares
 * about. `daysLeft` is computed in SQL so the arithmetic happens once, in the
 * same timezone as the timestamp it is derived from.
 */
async function listByLifecycle(status, ownerUserId, { limit = 100, offset = 0, retentionDays = 30 } = {}) {
  requireOwner(ownerUserId, "listByLifecycle");
  const { rows } = await db.query(
    `SELECT f.*, ${FILE_DECORATION_COLUMNS},
            f.deleted_at, f.archived_at,
            CASE WHEN f.status = 'deleted' AND f.deleted_at IS NOT NULL
                 THEN GREATEST(0, $4::int - EXTRACT(DAY FROM now() - f.deleted_at)::int)
                 ELSE NULL END AS days_left
       FROM files f
       ${FILE_DECORATION}
      WHERE f.owner_user_id = $1 AND f.status = $2
      ORDER BY COALESCE(f.deleted_at, f.archived_at) DESC NULLS LAST, f.id DESC
      LIMIT $3 OFFSET $5`,
    [ownerUserId, status, limit, retentionDays, offset]
  );
  return rows;
}

async function countByLifecycle(status, ownerUserId) {
  requireOwner(ownerUserId, "countByLifecycle");
  const { rows } = await db.query(
    "SELECT count(*)::int AS count FROM files WHERE owner_user_id = $1 AND status = $2",
    [ownerUserId, status]
  );
  return rows[0].count;
}

async function listByIdsForOwner(ids, ownerUserId) {
  requireOwner(ownerUserId, "listByIdsForOwner");
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const { rows } = await db.query(
    `SELECT f.*, ${FILE_DECORATION_COLUMNS}
       FROM files f
       ${FILE_DECORATION}
      WHERE f.id = ANY($1::uuid[]) AND f.owner_user_id = $2`,
    [ids, ownerUserId]
  );
  return rows;
}

module.exports = {
  ...base,
  ...owned,
  listByIdsForOwner,
  setOcrStatus,
  claimForOcr,
  setIsImage,
  listPhotos,
  countPhotos,
  countsBySubject,
  countsByDocumentType,
  idsMatching,
  idsPassingFilters,
  idsCurrentlyInSubject,
  listByLifecycle,
  countByLifecycle,
  countInSubject,
  countUntyped,
  findByLocationAndPath,
  findBySha256,
  create,
  updateStatus,
  updateProcessingStatus,
  updatePath,
  markScanned,
  setDocumentDate,
  updateHash,
  setCanonicalName,
  listForMirror,
  mirrorCounts,
  setMirrorPath,
  setCloudPlaceholder,
  updateMimeDetected,
  listStaleActive,
  listUnprocessed,
  countBacklogByLocation,
  listSimilarityCandidates,
  searchEverything,
  searchByFilename,
  listNotDeleted,
  countMatching,
  filterFacets,
  listByStatus,
  countByStatus,
  listBySubject,
  countBySubject,
  updateAiEnrichment,
  mirrorDescription,
  findClassifiedSiblingByHash,
  findProcessedTwinByHash,
};
