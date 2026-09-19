// The file lifecycle, written down once.
//
// WHAT WAS WRONG BEFORE
//
// A file's position in the pipeline was never recorded -- it was inferred,
// differently, by everything that needed to know. "Is this file done?" was
// answered by asking whether it had a hash, whether it had a file_content
// row, what its text_quality said, and whether a job was in flight; and
// triageRepository, fileRepository.listUnprocessed, dashboardRepository and
// the scan's recovery pass each asked a slightly different combination.
//
// That is the mechanism behind "retrying a triaged file just sends it back to
// triage". The retry re-ran a stage, the stage genuinely succeeded, and the
// file still matched the stuck predicate -- because the predicate was about a
// permanent property of the document (a photograph has no text layer) rather
// than about progress. Nothing counted the laps, so it could happen forever.
//
// THE STATES, AND WHAT EACH ONE PROMISES
//
//   discovered        indexed; no stage has run
//   processing        a stage is queued or running
//   needs_user        the machine has done everything it can. A RESTING
//                     state, not an error: this is what "in triage" means,
//                     and a file here is waiting on a decision, not on a
//                     retry
//   completed         processed as far as this file can go, and filed
//   failed_retryable  a stage failed and retrying is still worth doing
//   failed_terminal   retried to the limit, or failed for a reason retrying
//                     cannot change
//   archived          withdrawn from the working set by the user
//
// Every file is in exactly one. The three terminal-ish states (completed,
// needs_user, failed_terminal, archived) are terminal for the PIPELINE -- a
// human can always move a file out of them, which is the point of the triage
// workspace.
//
// WHY RETRIES ARE COUNTED PER STAGE
//
// A file that failed extraction twice and then failed classification once has
// not "failed three times". A single counter would strand it early, and a
// counter that resets on every new stage would never stop anything. The count
// lives in a JSONB map keyed by stage.
const db = require("../config/database");
const fileRepository = require("../repositories/fileRepository");

const State = Object.freeze({
  DISCOVERED: "discovered",
  PROCESSING: "processing",
  NEEDS_USER: "needs_user",
  COMPLETED: "completed",
  FAILED_RETRYABLE: "failed_retryable",
  FAILED_TERMINAL: "failed_terminal",
  ARCHIVED: "archived",
});

/**
 * How many times one stage may be retried before the file is declared
 * terminally failed and handed to a person.
 *
 * Three is chosen to match BullMQ's own `attempts: 3` (queues/index.js) --
 * those are transient-error retries within a single job, and these are
 * deliberate re-runs of the whole stage after it gave up. Beyond three
 * deliberate re-runs of a stage that keeps failing the same way, the honest
 * conclusion is that reprocessing is not the answer.
 */
const MAX_RETRIES_PER_STAGE = 3;

/**
 * Which transitions are allowed.
 *
 * Written as data rather than as scattered `if`s so the answer to "can a file
 * go from X to Y" is one lookup and one place to change. The permissive
 * entries are as deliberate as the restrictive ones:
 *
 *   anything -> archived        the user can always withdraw a file
 *   needs_user -> processing    a human intervention (retry, re-run OCR) puts
 *                               it back in the pipeline; this is the edge that
 *                               makes triage actionable rather than a morgue
 *   failed_terminal -> processing  same, but only by explicit user action --
 *                               nothing automatic may resurrect it, which is
 *                               exactly what "terminal" has to mean to be
 *                               worth having
 */
// Two entries here look redundant and are not:
//
//   discovered -> completed
//     A user can file a document the pipeline has not reached yet. Refusing
//     that meant the move succeeded, the classification row was written, and
//     the state silently stayed 'discovered' -- so the file remained in the
//     triage queue immediately after being dealt with, which is the exact
//     bounce this state machine exists to stop. Caught by verify-ownership.
//
//   failed_retryable -> failed_retryable  (and the terminal self-edge)
//     The second failure of the same stage must be able to overwrite the
//     first one's reason. Without the self-edge the transition was refused
//     and failure_reason kept describing attempt one, so the user was shown a
//     stale explanation for the attempt that actually just failed.
const ALLOWED = Object.freeze({
  [State.DISCOVERED]: [State.PROCESSING, State.NEEDS_USER, State.COMPLETED, State.FAILED_RETRYABLE, State.FAILED_TERMINAL, State.ARCHIVED],
  [State.PROCESSING]: [State.PROCESSING, State.COMPLETED, State.NEEDS_USER, State.FAILED_RETRYABLE, State.FAILED_TERMINAL, State.ARCHIVED],
  [State.NEEDS_USER]: [State.PROCESSING, State.NEEDS_USER, State.COMPLETED, State.ARCHIVED, State.FAILED_TERMINAL],
  // completed -> failed_* is allowed because a failure is a fact about what
  // just happened, and refusing to record it would leave the truth only in a
  // log line. In the normal pipeline a processor calls markProcessing first,
  // so this edge is only reached by a re-run that skipped it or by a bug --
  // both of which are things the user should be able to see on the file.
  [State.COMPLETED]: [State.PROCESSING, State.NEEDS_USER, State.COMPLETED, State.FAILED_RETRYABLE, State.FAILED_TERMINAL, State.ARCHIVED],
  [State.FAILED_RETRYABLE]: [State.PROCESSING, State.NEEDS_USER, State.COMPLETED, State.FAILED_RETRYABLE, State.FAILED_TERMINAL, State.ARCHIVED],
  [State.FAILED_TERMINAL]: [State.PROCESSING, State.NEEDS_USER, State.COMPLETED, State.FAILED_TERMINAL, State.ARCHIVED],
  [State.ARCHIVED]: [State.DISCOVERED, State.PROCESSING, State.COMPLETED],
});

function canTransition(from, to) {
  if (!from) return true; // a brand-new row has no previous state
  return (ALLOWED[from] || []).includes(to);
}

/**
 * Move a file to a new state.
 *
 * An illegal transition is logged and IGNORED rather than thrown. This is
 * called from job processors, and the alternative -- throwing -- would fail
 * the job, which the queue then retries, which attempts the same illegal
 * transition again. A state machine that can crash the pipeline it exists to
 * describe is worse than one that occasionally declines a move; the log line
 * is what makes the decline visible.
 */
async function transition(fileId, to, { stage = null, reason = null, client = null } = {}) {
  const exec = client || db;
  const { rows } = await exec.query("SELECT pipeline_state FROM files WHERE id = $1", [fileId]);
  const from = rows[0]?.pipeline_state;
  if (!rows.length) return null;

  if (!canTransition(from, to)) {
    console.warn(`[pipeline] refusing ${from} -> ${to} for file ${fileId}${stage ? ` (${stage})` : ""}`);
    return null;
  }

  const { rows: updated } = await exec.query(
    `UPDATE files SET
       pipeline_state   = $2,
       pipeline_stage   = COALESCE($3, pipeline_stage),
       failure_reason   = $4,
       failure_stage    = $5,
       state_changed_at = now()
     WHERE id = $1 RETURNING *`,
    [
      fileId, to, stage,
      to === State.FAILED_RETRYABLE || to === State.FAILED_TERMINAL ? reason : null,
      to === State.FAILED_RETRYABLE || to === State.FAILED_TERMINAL ? stage : null,
    ]
  );
  return updated[0] || null;
}

/** A stage has begun. */
async function markProcessing(fileId, stage) {
  return transition(fileId, State.PROCESSING, { stage });
}

/**
 * A stage failed.
 *
 * Decides retryable vs terminal from the count already recorded for THIS
 * stage, and returns which it chose so the caller can decide whether to
 * re-enqueue. `permanent` short-circuits the count for failures where
 * retrying is provably pointless -- the bytes are gone, the format has no
 * extractor, the OCR engine is not installed. Counting to three before
 * admitting that would waste three runs and three minutes to reach the same
 * answer, and would tell the user "retrying" when nothing can come of it.
 */
async function markFailed(fileId, stage, reason, { permanent = false } = {}) {
  const { rows } = await db.query(
    `UPDATE files
        SET retry_counts = jsonb_set(
              retry_counts, ARRAY[$2::text],
              to_jsonb(COALESCE((retry_counts->>$2)::int, 0) + 1), true)
      WHERE id = $1
      RETURNING retry_counts`,
    [fileId, stage]
  );
  const attempts = rows[0] ? Number(rows[0].retry_counts?.[stage] || 1) : 1;

  const terminal = permanent || attempts >= MAX_RETRIES_PER_STAGE;
  const state = terminal ? State.FAILED_TERMINAL : State.FAILED_RETRYABLE;

  const explained = terminal && !permanent
    ? `${reason} (gave up after ${attempts} attempts at ${stage})`
    : reason;

  await transition(fileId, state, { stage, reason: explained });
  return { state, attempts, terminal, reason: explained };
}

/**
 * The machine has finished with this file and a person must decide.
 *
 * Distinct from failure on purpose. An unreadable scan is not a bug and
 * retrying it is not a fix -- it is a document that needs a human to look at
 * the picture. Presenting that as "failed" is what made the triage queue feel
 * like a list of errors rather than a list of decisions.
 */
async function markNeedsUser(fileId, stage, reason) {
  return transition(fileId, State.NEEDS_USER, { stage, reason });
}

async function markCompleted(fileId, stage = null) {
  return transition(fileId, State.COMPLETED, { stage });
}

/**
 * The user has dealt with a file that was waiting on them.
 *
 * This is what stops a resolved file bouncing straight back into triage. The
 * underlying condition is often still true and always will be -- the photo
 * still has no text layer -- so the queue has to remember the DECISION, not
 * re-evaluate the condition.
 *
 * @param {string} resolution - what they did: 'moved', 'kept_name', 'archived',
 *   'renamed', 'ocr_reviewed'. Recorded so the audit trail says which.
 */
async function markUserResolved(fileId, resolution, { state = State.COMPLETED } = {}) {
  await db.query(
    `UPDATE files SET user_resolved_at = now(), user_resolution = $2 WHERE id = $1`,
    [fileId, resolution]
  );
  return transition(fileId, state, { stage: "user" });
}

/**
 * A file is being deliberately re-run by a person.
 *
 * Clears the resolution marker: asking for reprocessing is asking for a fresh
 * verdict, and leaving the old "already dealt with" flag on would hide the
 * result from the queue it is supposed to reappear in.
 */
async function markRetrying(fileId, stage) {
  await db.query(
    `UPDATE files SET user_resolved_at = NULL, user_resolution = NULL WHERE id = $1`,
    [fileId]
  );
  return transition(fileId, State.PROCESSING, { stage });
}

/** How many times a given stage has been retried for this file. */
function retriesFor(file, stage) {
  return Number(file?.retry_counts?.[stage] || 0);
}

/** Whether another retry of this stage is worth enqueueing. */
function canRetry(file, stage) {
  return retriesFor(file, stage) < MAX_RETRIES_PER_STAGE;
}

/**
 * A plain-language summary of where a file stands, for the UI.
 *
 * Built here rather than in the frontend so the Files page, the triage queue
 * and the Photos workspace describe the same state the same way -- three
 * different phrasings of "stuck" is how a user concludes there are three
 * different problems.
 */
function describe(file) {
  const stage = file.pipeline_stage ? ` at ${file.pipeline_stage.replace(/_/g, " ")}` : "";
  switch (file.pipeline_state) {
    case State.DISCOVERED:
      return { label: "Waiting", tone: "neutral", detail: "Indexed, not processed yet." };
    case State.PROCESSING:
      return { label: "Processing", tone: "busy", detail: `Working${stage}.` };
    case State.NEEDS_USER:
      return {
        label: "Needs you", tone: "attention",
        detail: file.failure_reason || "The pipeline has done all it can; this one needs a decision.",
      };
    case State.COMPLETED:
      return { label: "Done", tone: "good", detail: "Processed and filed." };
    case State.FAILED_RETRYABLE:
      return {
        label: "Failed", tone: "warn",
        detail: `${file.failure_reason || "A stage failed"}${stage}. Retrying may still help.`,
      };
    case State.FAILED_TERMINAL:
      return {
        label: "Can't process", tone: "bad",
        detail: file.failure_reason || "Reprocessing cannot fix this; decide what to do with it.",
      };
    case State.ARCHIVED:
      return { label: "Archived", tone: "muted", detail: "Withdrawn from the working set." };
    default:
      return { label: "Unknown", tone: "neutral", detail: "" };
  }
}

module.exports = {
  State, ALLOWED, MAX_RETRIES_PER_STAGE,
  canTransition, transition,
  markProcessing, markFailed, markNeedsUser, markCompleted, markUserResolved, markRetrying,
  retriesFor, canRetry, describe,
  // re-exported so callers need only this module for the common case
  findFile: fileRepository.findById,
};
