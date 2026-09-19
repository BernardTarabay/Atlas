import { api } from "../services/apiClient";

/**
 * Handing a file to whatever the person actually wants to do with it.
 *
 * ONE IMPLEMENTATION, THREE VIEWS
 *
 * Library, Files and Types are three ways of looking at one inventory, so
 * "share this file" has to mean one thing. Everything below is called from all
 * three through lib/fileActions.js; none of them knows how sharing works.
 *
 * WHAT "SHARE" CAN ACTUALLY BE
 *
 * There is no single web API that reaches WhatsApp. There is the Web Share
 * API, which hands the file to the OPERATING SYSTEM's share sheet, and the
 * share sheet is where WhatsApp, Mail, AirDrop and everything else installed
 * shows up. So the job here is to produce a real File object and pass it on.
 *
 * Three things gate it, and all three are the platform's rules rather than
 * ours:
 *
 *   a secure context   navigator.share does not exist on plain http from a
 *                      non-loopback address. Over the tailnet name or on
 *                      localhost it is there; on http://192.168.1.x:5000 it
 *                      never will be, so the fallback is not an edge case.
 *   a user gesture     it must be called during a click/tap. Anything awaited
 *                      before it is fine, but a share fired from a timer is
 *                      refused.
 *   canShare(files)    support for TEXT sharing says nothing about support for
 *                      FILE sharing, and several browsers have one without the
 *                      other. Asking about the actual payload is the only
 *                      reliable test.
 *
 * WHEN IT CANNOT, IT DOWNLOADS -- LOUDLY
 *
 * The fallback is the same thing the person would have done by hand, minus the
 * hunting: the file lands in Downloads and they attach it. What it never does
 * is fail quietly, because a Share button that sometimes does nothing is worse
 * than one that is honest about what this browser can do.
 */

/** Did the person simply back out of the share sheet? Not an error. */
const isCancellation = (err) =>
  err?.name === "AbortError" || /abort|cancel/i.test(err?.message || "");

/** Can this browser share these actual files, right now? */
export function canShareFiles(files) {
  if (typeof navigator === "undefined" || !navigator.share || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files });
  } catch {
    return false;
  }
}

/** Whether a Share action is worth offering at all in this context. */
export function nativeShareAvailable() {
  return typeof navigator !== "undefined" && Boolean(navigator.share);
}

const displayName = (file) =>
  file.canonical_filename || file.filename_current || file.display_name || "file";

/** Pull one file's bytes down as a real File, named the way the user sees it. */
async function toFile(file) {
  const { blob, contentType } = await api.fetchBlob(`/files/${file.id}/download`);
  return new File([blob], displayName(file), {
    type: contentType || blob.type || "application/octet-stream",
  });
}

/**
 * Share one or many files.
 *
 * @param {object[]} files    the file records (needs `id` and a name)
 * @param {object}   handlers
 * @param {Function} handlers.onNotice  (message, tone) -- surfaced to the user
 * @returns {Promise<"shared"|"downloaded"|"cancelled">}
 */
export async function shareFiles(files, { onNotice } = {}) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return "cancelled";

  const label = list.length === 1 ? `"${displayName(list[0])}"` : `${list.length} files`;

  let payload;
  try {
    payload = await Promise.all(list.map(toFile));
  } catch (err) {
    onNotice?.(`Could not read ${label} to share: ${err.message}`, "error");
    return "cancelled";
  }

  // MANY PLATFORMS SHARE ONE FILE AND NOT SEVERAL.
  //
  // canShare() is asked about the whole set first. If the set is refused but a
  // single file would be accepted, that is worth knowing -- but silently
  // sharing only the first of four selected files would be worse than not
  // sharing at all, so a rejected multi-file set falls through to the export
  // path where the user gets all of them.
  if (canShareFiles(payload)) {
    try {
      await navigator.share({
        files: payload,
        title: list.length === 1 ? displayName(list[0]) : `${list.length} files`,
      });
      return "shared";
    } catch (err) {
      if (isCancellation(err)) return "cancelled";
      // A share that errors for any other reason still leaves the person
      // wanting the file, so it becomes an export rather than a dead end.
      onNotice?.(`Sharing failed (${err.message}) — downloading instead.`, "info");
    }
  } else {
    onNotice?.(
      list.length > 1
        ? `This browser can't hand ${list.length} files to the system share sheet — downloading them instead.`
        : "This browser can't open the system share sheet — downloading instead.",
      "info"
    );
  }

  // EXPORT FALLBACK.
  //
  // Sequential rather than parallel: browsers throttle or block a burst of
  // simultaneous downloads, and several will drop all but the first.
  let saved = 0;
  for (const file of list) {
    try {
      await api.download(`/files/${file.id}/download`, displayName(file));
      saved += 1;
    } catch (err) {
      onNotice?.(`Could not download "${displayName(file)}": ${err.message}`, "error");
    }
  }
  if (saved) onNotice?.(saved === 1 ? "Downloaded — attach it from your Downloads folder." : `Downloaded ${saved} files.`, "success");
  return "downloaded";
}
