// Aggregates for the dashboard.
//
// WHY THIS EXISTS
//
// The dashboard used to fetch `/files?limit=200` and render `files.length`.
// On a 9,398-file repository it therefore reported "200 files tracked" -- not
// a rounding error, a hard ceiling, and the same bug applied to proposals,
// duplicates and jobs. It also dragged 200 fully-decorated file rows across
// the wire (each with a subject lateral join and a rename-proposal lateral
// join) purely to take the length of the array.
//
// Counting is the database's job. Everything here is a COUNT/SUM over the
// whole table, so the numbers are true at any scale and the payload is a few
// hundred bytes instead of a few hundred rows.
//
// The one deliberate exception is the jobs window: "what has the pipeline
// been doing lately" is a genuinely time-bounded question, so it is scoped to
// a recent interval and says so on screen.

const db = require("../config/database");
const { requireOwner } = require("./ownership");

// A row that belongs to the caller by way of the file it describes. Used by
// the subqueries over rename_proposals and file_content, neither of which
// carries an owner column -- ownership of a proposal is not an independent
// fact, it is a consequence of which file the proposal is about.
const OWNED_FILE = (fileIdExpr) =>
  `EXISTS (SELECT 1 FROM files of WHERE of.id = ${fileIdExpr} AND of.owner_user_id = $1)`;

// A file counts as "in the repository" unless it has been deleted. Missing
// files (the drive is unplugged) still count -- they are known documents, and
// hiding them would make the total silently shrink when a disk goes offline.
/**
 * What the dashboard counts as a document.
 *
 * Not deleted, not archived, and not the losing copy of a duplicate the user
 * has already settled -- the same definition the Library lists by
 * (fileFilters.LISTABLE_FILE). It has to be the same or the two disagree, and
 * they did: the overview reported 31 documents while the library held 16
 * distinct ones, because registering a second overlapping folder doubled the
 * count of everything.
 *
 * This applies to the whole overview deliberately, funnel included. "16
 * documents, 16 hashed, 16 described" describes an archive; the same numbers
 * doubled by however many backup folders happen to be registered describe
 * nothing anyone asked about.
 */
const { LISTABLE_FILE } = require("./fileFilters");
const LIVE = LISTABLE_FILE;

/**
 * Headline totals plus the processing funnel, in one pass over `files`.
 *
 * One query rather than six: these are all counts over the same rows with
 * different filters, which is exactly what FILTER is for, and it means the
 * numbers are mutually consistent -- six separate queries could interleave
 * with the worker and report a funnel where a later stage exceeds an earlier
 * one.
 */
async function overview(ownerUserId) {
  requireOwner(ownerUserId, "dashboard.overview");
  const { rows } = await db.query(
    `SELECT
       count(*)::int                                                        AS total_files,
       coalesce(sum(f.size_bytes), 0)::bigint                               AS total_bytes,
       count(*) FILTER (WHERE f.status = 'missing')::int                    AS missing,
       count(*) FILTER (WHERE f.is_cloud_placeholder)::int                  AS placeholders,
       count(*) FILTER (WHERE f.sha256_hash IS NOT NULL)::int               AS hashed,
       count(*) FILTER (WHERE fc.file_id IS NOT NULL)::int                  AS extracted,
       count(*) FILTER (WHERE fc.text_quality = 'ok')::int                  AS searchable,
       count(*) FILTER (WHERE fc.needs_ocr)::int                            AS needs_ocr,
       count(*) FILTER (WHERE cls.subject_id IS NOT NULL)::int              AS classified,
       count(*) FILTER (WHERE f.canonical_filename IS NOT NULL)::int        AS named
     FROM files f
     LEFT JOIN file_content fc ON fc.file_id = f.id
     LEFT JOIN LATERAL (
       SELECT cr.classified_subject_id AS subject_id
       FROM classification_results cr
       WHERE cr.file_id = f.id AND cr.classified_subject_id IS NOT NULL
       ORDER BY cr.created_at DESC LIMIT 1
     ) cls ON true
     WHERE ${LIVE} AND f.owner_user_id = $1`,
    [ownerUserId]
  );
  return rows[0];
}

/**
 * Everything that is waiting on a human, with the number attached.
 *
 * Deliberately one row of counts rather than a list of items: the dashboard's
 * job is to say "there are 3,412 suggestions worth clearing", and the page
 * that can actually clear them is one click away.
 */
async function attention(ownerUserId) {
  requireOwner(ownerUserId, "dashboard.attention");
  // Every subquery carries the owner. rename_proposals and file_content have
  // no owner column of their own, so they reach it through the file they
  // describe -- the same EXISTS shape renameProposalRepository uses.
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM rename_proposals rp
         WHERE rp.status = 'pending' AND ${OWNED_FILE("rp.file_id")})                            AS pending_proposals,
       (SELECT count(*)::int FROM rename_proposals rp
         WHERE rp.status = 'pending' AND rp.confidence_score <= 0
           AND ${OWNED_FILE("rp.file_id")})                                                     AS zero_confidence_proposals,
       (SELECT count(*)::int FROM duplicate_groups
         WHERE status = 'open' AND group_type = 'exact' AND owner_user_id = $1)                 AS open_exact_duplicates,
       (SELECT count(*)::int FROM duplicate_groups
         WHERE status = 'open' AND group_type = 'probable' AND owner_user_id = $1)              AS open_probable_duplicates,
       (SELECT count(*)::int FROM file_content fc
         WHERE fc.needs_ocr AND ${OWNED_FILE("fc.file_id")})                                    AS needs_ocr,
       (SELECT count(*)::int FROM files f
          WHERE ${LIVE} AND f.status = 'active' AND f.owner_user_id = $1
            AND NOT EXISTS (SELECT 1 FROM classification_results cr
                             WHERE cr.file_id = f.id AND cr.classified_subject_id IS NOT NULL)) AS unfiled,
       -- Discovered but going nowhere: the pipeline still owes this file
       -- something, and no job is queued to deliver it. The self-healing scan
       -- repairs these, so a non-zero number here means "the next scan has
       -- work to do", not "these are lost".
       --
       -- SCOPED BY STATE, not by missing artifacts. This asked "no hash or no
       -- file_content row", which counted every photograph in the archive as
       -- permanently stalled -- an image never gets a content row and never
       -- will, because there is no text in it to extract. The dashboard
       -- therefore showed 1,426 stalled files on an installation where nothing
       -- was wrong with any of them, and the same predicate in the scan's
       -- recovery pass re-queued all 1,426 on every single scan.
       --
       -- Kept identical to fileRepository.countBacklogByLocation and
       -- triageRepository on purpose: "stalled" must be the same number on the
       -- dashboard, the Storage Locations page and the triage queue, or two of
       -- the three look like a bug.
       (SELECT count(*)::int FROM files f
          WHERE f.status = 'active' AND f.owner_user_id = $1
            AND f.pipeline_state IN ('discovered', 'processing', 'failed_retryable')
            AND NOT EXISTS (SELECT 1 FROM processing_jobs pj
                             WHERE pj.status IN ('queued','running')
                               AND pj.payload->>'fileId' = f.id::text))                         AS stalled,
       (SELECT count(*)::int FROM processing_jobs
         WHERE status IN ('queued','running') AND owner_user_id = $1)                           AS jobs_in_flight,
       (SELECT count(*)::int FROM processing_jobs
         WHERE status = 'failed' AND owner_user_id = $1
           AND finished_at > now() - interval '24 hours')                                       AS jobs_failed_today`,
    [ownerUserId]
  );
  return rows[0];
}

/**
 * Bytes held by duplicate copies that are not the canonical one.
 *
 * The single most concrete number this app can show someone with a drive
 * they think is too full: not "you have 412 duplicate groups" but "there is
 * 6.1 GB sitting in copies of things you already have". Only EXACT groups
 * count -- probable ones are unconfirmed guesses and it would be dishonest
 * to put their bytes in a "reclaimable" figure.
 */
async function reclaimableBytes(ownerUserId) {
  requireOwner(ownerUserId, "dashboard.reclaimableBytes");
  const { rows } = await db.query(
    `SELECT coalesce(sum(f.size_bytes), 0)::bigint AS bytes,
            count(*)::int                          AS copies
       FROM duplicate_group_members dgm
       JOIN duplicate_groups dg ON dg.id = dgm.duplicate_group_id
       JOIN files f ON f.id = dgm.file_id
      WHERE dg.group_type = 'exact'
        AND dg.owner_user_id = $1
        AND f.status <> 'deleted'
        -- Every member EXCEPT the one kept. When a group has no canonical
        -- pick yet, all but one copy is still redundant, so charge the group
        -- for (members - 1) by excluding the earliest-imported member.
        AND f.id <> COALESCE(
              dg.canonical_file_id,
              (SELECT f2.id FROM duplicate_group_members m2
                 JOIN files f2 ON f2.id = m2.file_id
                WHERE m2.duplicate_group_id = dg.id
                ORDER BY f2.imported_at ASC LIMIT 1))`,
    [ownerUserId]
  );
  return rows[0];
}

/**
 * File types, ordered by how much of the repository they represent, with how
 * much of each is actually readable.
 *
 * The coverage column is the point. "1,599 PDFs" is trivia; "1,599 PDFs, 61%
 * readable" is the OCR argument, and it is the difference between a search
 * box that finds things and one that quietly does not.
 */
async function byExtension(ownerUserId, limit = 10) {
  requireOwner(ownerUserId, "dashboard.byExtension");
  const { rows } = await db.query(
    `SELECT lower(coalesce(nullif(f.extension, ''), '(none)')) AS ext,
            count(*)::int                                       AS files,
            coalesce(sum(f.size_bytes), 0)::bigint              AS bytes,
            count(*) FILTER (WHERE fc.text_quality = 'ok')::int  AS searchable
       FROM files f
       LEFT JOIN file_content fc ON fc.file_id = f.id
      WHERE ${LIVE} AND f.owner_user_id = $1
      GROUP BY 1
      ORDER BY files DESC
      LIMIT $2`,
    [ownerUserId, limit]
  );
  return rows;
}

/** Per-location totals, so "which folder is all of this coming from" is answerable. */
async function byLocation(ownerUserId) {
  requireOwner(ownerUserId, "dashboard.byLocation");
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.root_path, s.is_read_only,
            count(f.id)::int                                     AS files,
            coalesce(sum(f.size_bytes), 0)::bigint               AS bytes,
            count(f.id) FILTER (WHERE f.canonical_filename IS NOT NULL)::int AS named,
            max(fs.finished_at)                                  AS last_scan
       FROM storage_locations s
       LEFT JOIN files f ON f.storage_location_id = s.id AND f.status <> 'deleted'
       LEFT JOIN filesystem_scans fs ON fs.storage_location_id = s.id AND fs.status = 'completed'
      WHERE s.owner_user_id = $1 AND s.is_active = true
      GROUP BY s.id, s.name, s.root_path, s.is_read_only
      ORDER BY files DESC`,
    [ownerUserId]
  );
  return rows;
}

/** What the pipeline has been doing lately, by job type. */
async function recentJobs(ownerUserId, hours = 24) {
  requireOwner(ownerUserId, "dashboard.recentJobs");
  const { rows } = await db.query(
    `SELECT job_type,
            count(*) FILTER (WHERE status = 'completed')::int AS completed,
            count(*) FILTER (WHERE status = 'failed')::int    AS failed,
            count(*) FILTER (WHERE status IN ('queued','running'))::int AS active
       FROM processing_jobs
      WHERE owner_user_id = $1
        AND created_at > now() - make_interval(hours => $2)
      GROUP BY job_type
      HAVING count(*) > 0
      ORDER BY 2 DESC, 1`,
    [ownerUserId, hours]
  );
  return rows;
}

/** Files added per day, for the "is this thing still ingesting" question. */
async function ingestionTrend(ownerUserId, days = 14) {
  requireOwner(ownerUserId, "dashboard.ingestionTrend");
  const { rows } = await db.query(
    `SELECT d::date AS day, coalesce(c.n, 0)::int AS files
       FROM generate_series(now()::date - ($1::int - 1), now()::date, interval '1 day') d
       LEFT JOIN (
         SELECT imported_at::date AS day, count(*) AS n
           FROM files
          WHERE status <> 'deleted' AND owner_user_id = $2
            AND imported_at > now() - make_interval(days => $1)
          GROUP BY 1
       ) c ON c.day = d::date
      ORDER BY day`,
    [days, ownerUserId]
  );
  return rows;
}

module.exports = {
  overview, attention, reclaimableBytes, byExtension, byLocation, recentJobs, ingestionTrend,
};
