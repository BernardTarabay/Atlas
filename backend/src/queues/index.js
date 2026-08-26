// Enqueuing work (see docs/06-processing-pipeline.md §6.1).
//
// This is the ONLY place that writes a queued job -- job processors and API
// controllers use `enqueueJob()` below, so the "a job is always a
// processing_jobs row" invariant (spec §18) cannot be bypassed.
//
// As of migration 040 that invariant is structural rather than maintained.
// There used to be one BullMQ queue per job_type backed by Redis, which meant
// a job existed in two places and the two could disagree. Now the
// processing_jobs row IS the queue entry; the mechanics of claiming and
// retrying it live in ./pgQueue.js.
const processingJobRepository = require("../repositories/processingJobRepository");
const pgQueue = require("./pgQueue");
const { JobType } = require("../models/enums");

function assertKnownJobType(jobType) {
  if (!Object.values(JobType).includes(jobType)) {
    throw new Error(`Unknown job type "${jobType}"`);
  }
}

/**
 * Work out whose archive a job acts on.
 *
 * Tried in order of directness, and every source is an authoritative fact
 * about the work rather than a guess:
 *
 *   1. an explicit ownerUserId from the caller
 *   2. the storage location -- a location belongs to exactly one account
 *   3. the file in the payload -- likewise, and this is what makes the
 *      stage-chaining processors work without threading an owner through
 *      every one of them (hash -> extract_text -> classify -> generate_names
 *      each enqueue the next with only a fileId)
 *   4. the person who asked, for jobs that act on no particular file
 *
 * Deliberately no fifth fallback. If none of these apply the job has no owner,
 * and processingJobRepository.create refuses it -- which surfaces as a failed
 * enqueue at development time instead of a row nobody can see.
 */
async function resolveOwner(jobType, payload = {}, opts = {}) {
  if (opts.ownerUserId) return opts.ownerUserId;

  // Lazy requires: these repositories pull in the ownership helpers, and
  // requiring them at module load creates a cycle back through the services
  // that enqueue jobs.
  if (opts.storageLocationId) {
    const storageLocationRepository = require("../repositories/storageLocationRepository");
    const location = await storageLocationRepository.findById(opts.storageLocationId);
    if (location?.owner_user_id) return location.owner_user_id;
  }

  if (payload?.fileId) {
    const fileRepository = require("../repositories/fileRepository");
    const file = await fileRepository.findById(payload.fileId);
    if (file?.owner_user_id) return file.owner_user_id;
  }

  return opts.createdBy || null;
}

/**
 * Create the `processing_jobs` row, which IS the queue entry.
 *
 * One write, not two. This used to create the row and then enqueue a separate
 * BullMQ job on Redis, and the doc comment here conceded the pair was only
 * "atomic enough for our purposes". It was not -- see the note in the body.
 *
 * OWNERSHIP
 *
 * Every job belongs to exactly one account, because every job acts on exactly
 * one account's files. `ownerUserId` is required; when it is not supplied
 * explicitly it is resolved from the storage location, which is the other
 * thing that carries an owner. A job that could be created without one would
 * be invisible on its owner's Jobs page and visible on everyone else's, so
 * this refuses rather than defaulting.
 *
 * @param {string} jobType - one of JobType
 * @param {object} payload - job-specific input (e.g. { storageLocationId } for scan, { fileId } for hash)
 * @param {object} [opts]
 * @param {string} [opts.storageLocationId]
 * @param {string} [opts.ownerUserId] - whose archive this acts on; derived from
 *   the storage location when omitted
 * @param {string} [opts.createdBy] - user id, or null for system-initiated jobs
 * @param {number} [opts.progressTotal]
 */
async function enqueueJob(jobType, payload, opts = {}) {
  assertKnownJobType(jobType);

  const ownerUserId = await resolveOwner(jobType, payload, opts);

  // ONE WRITE, NOT TWO.
  //
  // This used to create the row and then enqueue it on Redis, with a comment
  // conceding the two were only "atomic enough for our purposes". They were
  // not. A Redis failure between the two steps left the row at 'queued' with
  // nothing on any queue to ever move it -- and fileRepository.listUnprocessed,
  // the self-healing rescan built to rescue stranded files, skips anything with
  // a 'queued' job on the reasonable assumption that it is merely waiting its
  // turn. So a blip excluded a file permanently from the one mechanism meant to
  // recover it, and the workaround was to catch the enqueue failure and mark
  // the row failed.
  //
  // There is no second step now. The row is the queue entry, so the window it
  // guarded against cannot open.
  const jobRow = await processingJobRepository.create({
    jobType,
    storageLocationId: opts.storageLocationId || null,
    payload,
    createdBy: opts.createdBy || null,
    ownerUserId,
    progressTotal: opts.progressTotal || 0,
  });

  // A hint to any idle worker, so it does not wait out its poll interval.
  // Deliberately after the commit and deliberately unawaited-on-failure: the
  // job is already durable, and a missed hint costs latency, never work.
  await pgQueue.notifyJobAvailable();

  return jobRow;
}

/**
 * Kept as the teardown every script already calls.
 *
 * Under BullMQ this closed a set of Redis connections that would otherwise hold
 * the event loop open forever. There is nothing queue-specific left to close --
 * the pg pool is owned by config/database -- so this is now a no-op that exists
 * so the ~30 scripts calling it keep working, and so there remains one obvious
 * place to hang queue teardown if it ever needs some again.
 */
async function closeAllQueues() {
  /* nothing to close: the queue is a table */
}

module.exports = { enqueueJob, closeAllQueues };
