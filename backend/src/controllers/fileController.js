const fileService = require("../services/fileService");
const lifecycleService = require("../services/lifecycleService");
const mirrorService = require("../services/mirror/mirrorService");
const mime = require("../utils/mimeGuess");
const { buildContentDisposition } = require("../utils/contentDisposition");

async function list(req, res) {
  const files = await fileService.search(req.query, req.user.id);

  // Which signals actually ran, without changing the response body -- the body
  // is a bare array that several callers already consume. "lexical" means the
  // semantic half could not run (no API key, or Gemini was unreachable), so
  // paraphrase matching is unavailable for this request and the UI can say so
  // rather than leaving the user to conclude the file is not there.
  if (files?.searchMode) res.set("X-Search-Mode", files.searchMode);

  res.json(files);
}

async function count(req, res) {
  res.json(await fileService.count(req.query, req.user.id));
}

/**
 * Every id matching the current filters, for "select all N".
 *
 * Ids only, never rows: the caller already has the page it is showing and
 * needs the rest as a selection, not as data. `capped` travels with them so
 * the UI can say "the first 5,000 of 12,400" instead of quietly presenting a
 * truncated set as the whole match.
 */
async function matchingIds(req, res) {
  res.json(
    await fileService.matchingIds(req.query, req.user.id, {
      subjectId: req.query.inSubjectId || null,
    })
  );
}

async function filterOptions(req, res) {
  res.json(await fileService.filterOptions(req.user.id));
}

async function getOne(req, res) {
  res.json(await fileService.getFileDetail(req.params.id, req.user.id));
}

async function download(req, res) {
  const { file, stream } = await fileService.getDownloadStream(req.params.id, req.user.id);
  await fileService.recordDownloadAudit(file.id, req.user.id);

  res.setHeader("Content-Type", mime.guessMimeType(file.extension, file.mime_type_detected));
  res.setHeader("Content-Disposition", buildContentDisposition("attachment", file.filename_current));
  // The bytes are whatever the user's own document contains and the type is
  // guessed from its extension, so forbid the browser from sniffing its way
  // to a different, more executable opinion. `attachment` above already means
  // it is saved rather than rendered; this closes the gap for the browsers
  // that sniff anyway.
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Close the file handle when the client goes away.
  //
  // Without this, a cancelled download -- the user hitting Escape, closing the
  // tab, or a flaky connection on a multi-gigabyte file -- left the read
  // stream open with nothing draining it. On a corpus of hundreds of GB that
  // is a file descriptor and its buffers held until the process exits, once
  // per abandoned download.
  res.on("close", () => stream.destroy());

  stream.on("error", (err) => {
    // Once piping has begun the status line is already on the wire, so
    // res.status(500) here did nothing except throw ERR_HTTP_HEADERS_SENT
    // inside an error handler. Destroying the response is the only honest
    // signal left: it aborts the transfer so the client sees a truncated
    // download rather than a silently short file it believes is complete.
    console.error(`[download] stream failed for file ${file.id}:`, err.message);
    if (res.headersSent) res.destroy(err);
    else res.status(500).json({ error: "Could not read the file from disk." });
  });

  stream.pipe(res);
}

async function preview(req, res) {
  const { file, contentType, buffer } = await fileService.getPreviewImage(req.params.id, req.user.id);

  res.setHeader("Content-Type", contentType);
  // inline (not attachment) so the browser renders it -- always safe here
  // regardless of the underlying file's real format, since getPreviewImage
  // never returns raw bytes for anything but an actual raster image; every
  // other format has already been rasterized to a flat PNG.
  res.setHeader("Content-Disposition", buildContentDisposition("inline", `${file.filename_current}.preview.png`));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(buffer);
}

async function remove(req, res) {
  res.json(await fileService.removeFile(req.params.id, req.user.id));
}

async function removeAll(req, res) {
  const job = await fileService.removeAllFiles(req.user.id);
  res.status(202).json({ processingJobId: job.id, status: job.status });
}

// Filename and subject/documentType are separately permissioned -- reject
// up front rather than letting the service silently apply only part of
// what was asked, which would be confusing ("I set both fields but only
// the name changed and I don't know why").
async function update(req, res) {
  const { filename, subjectId, documentTypeId, confirmDuplicate } = req.body || {};

  if (filename !== undefined && !req.user.permissions.includes("document.rename")) {
    return res.status(403).json({ error: "Missing required permission: document.rename" });
  }
  if ((subjectId !== undefined || documentTypeId !== undefined) && !req.user.permissions.includes("classification.modify")) {
    return res.status(403).json({ error: "Missing required permission: classification.modify" });
  }

  const result = await fileService.updateFile(
    req.params.id,
    { filename, subjectId, documentTypeId, confirmDuplicate: Boolean(confirmDuplicate) },
    req.user.id
  );

  // 409 when the duplicate guard found something worth interrupting for. Not
  // an error to swallow: the body carries the findings and the actions
  // available on each, and the UI walks the user through them before calling
  // back with confirmDuplicate.
  res.status(result?.requiresConfirmation ? 409 : 200).json(result);
}

/**
 * File a selection under one subject.
 *
 * Same request/response contract as POST /photos/move and POST /triage/move,
 * deliberately: they are the same operation reached from a different list, and
 * MoveManyModal is already written against that shape. 409 when at least one
 * file raised a duplicate question, carrying the findings so the UI can ask
 * once about the whole batch rather than once per file.
 */
async function moveMany(req, res) {
  const { fileIds, subjectId, confirmDuplicates } = req.body || {};
  const result = await fileService.moveMany(fileIds, subjectId, req.user.id, {
    confirmDuplicates: Boolean(confirmDuplicates),
  });
  res.status(result.needsConfirmation.length > 0 ? 409 : 200).json(result);
}

/**
 * File everything matching a filter under one subject.
 *
 * The filter arrives in the BODY rather than the query string, and in the same
 * shape GET /files takes it: `{ filters: { ext, dateFrom, dateTo, subjectId,
 * documentTypeId, storageLocationId, pathPrefix }, toSubjectId }`. One filter
 * vocabulary across the filter bar, the listing, the counts and this -- a
 * second one would drift, and the assistant would be speaking a dialect of the
 * UI's language rather than the language itself.
 *
 * 202, not 200: the reply is a job to watch, not a completed move.
 */
async function moveByFilter(req, res) {
  const { filters, toSubjectId, confirmDuplicates } = req.body || {};
  const result = await fileService.moveByFilter(filters, toSubjectId, req.user.id, {
    confirmDuplicates: Boolean(confirmDuplicates),
  });
  res.status(202).json(result);
}

/**
 * Archive and Trash: what is in them, and moving things in and out.
 *
 * These sit on the file controller rather than getting their own resource
 * because they are states of a FILE, not a collection that owns anything --
 * the same reason they are statuses rather than folders (migration 037).
 */
async function lifecycleList(req, res) {
  res.json(await lifecycleService.listDestination(req.params.destination, req.query, req.user.id));
}

async function lifecycleSummary(req, res) {
  res.json(await lifecycleService.summary(req.user.id));
}

/** Move files INTO Archive or Trash. */
async function lifecycleMove(req, res) {
  const { fileIds } = req.body || {};
  res.json(await lifecycleService.moveFiles(fileIds, req.params.destination, req.user.id));
}

/** Bring them back out, to `active` and their existing folder. */
async function lifecycleRestore(req, res) {
  const { fileIds } = req.body || {};
  res.json(await lifecycleService.restoreFiles(fileIds, req.user.id));
}

/**
 * Remove rows for good.
 *
 * TWO-STEP, and the second step is not a formality. `confirm: "permanently
 * delete"` has to be typed by the caller, so a mis-wired button or a stray
 * click cannot reach it -- this is the only operation in the application that
 * cannot be undone. The route is also restricted to files ALREADY in the
 * Trash (see lifecycleService.purgeFiles), so every permanent deletion has a
 * reversible step in front of it.
 */
async function lifecyclePurge(req, res) {
  const { fileIds, confirm } = req.body || {};
  if (String(confirm || "").trim().toLowerCase() !== "permanently delete") {
    return res.status(400).json({
      error: 'This cannot be undone. Send confirm: "permanently delete" to proceed.',
      requiresConfirmation: true,
    });
  }
  res.json(await lifecycleService.purgeFiles(fileIds, req.user.id));
}

async function reveal(req, res) {
  res.json(await fileService.revealInFileManager(req.params.id, req.user.id));
}

/**
 * Launch the file in the host's default application.
 *
 * Same permission bar as download and reveal: it exposes the same content,
 * just to an application instead of to the browser. Nothing crosses the
 * network -- which is exactly why the client only offers it when the browser
 * and the server are the same machine.
 */
async function openLocally(req, res) {
  res.json(await fileService.openOnHost(req.params.id, req.user.id));
}

async function compare(req, res) {
  const { fileIdA, fileIdB } = req.body || {};
  res.json(await fileService.compareFiles(fileIdA, fileIdB, req.user.id));
}

/**
 * Rebuild the organized shortcut folder on demand.
 *
 * 202 rather than 200, like triggerScan: the work is queued, not done. The
 * caller gets the processing_jobs row and watches it in the Jobs dock, which
 * already knows how to render this job type (JobsDock.jsx labels it "Updating
 * organized folder") -- it simply never had a way to start one.
 */
async function mirrorSync(req, res) {
  const job = await mirrorService.queueSync(req.user.id, {
    // Pruning is the default and the safe one: a shortcut whose file is gone
    // is a dead link. Opting out is for the rare case of rebuilding while a
    // drive is unplugged, where every file on it would otherwise look deleted.
    prune: req.body?.prune !== false,
  });
  res.status(202).json(job);
}

/** Where the mirror is configured to live, and how much of it is built. */
async function mirrorStatus(req, res) {
  res.json(await mirrorService.status(req.user.id));
}

module.exports = {
  list, count, filterOptions, matchingIds, getOne, download, preview, remove, removeAll, compare, update, reveal,
  openLocally,
  moveMany,
  moveByFilter,
  lifecycleList, lifecycleSummary, lifecycleMove, lifecycleRestore, lifecyclePurge,
  mirrorSync, mirrorStatus,
};
