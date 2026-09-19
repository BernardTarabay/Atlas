/**
 * WHAT A DRAGGED FILE CARRIES, DEFINED ONCE.
 *
 * There were two drag payloads on this page already and now there are three
 * consumers, which is exactly the point at which "set a dataTransfer key" has
 * to stop being written out by hand in each place.
 *
 * TWO MIME TYPES, ON PURPOSE, ON THE SAME DRAG.
 *
 *   text/dms-file-id   one id, a bare string. What the folder tree, the bins
 *                      and the navigation already read (SubjectTreePane,
 *                      LibraryPage, TopNav). It is unchanged and stays
 *                      unchanged: those targets act on one file, and giving
 *                      them a JSON array to parse would be a rewrite of three
 *                      working drop handlers for no gain.
 *
 *   text/dms-files     the whole selection, as JSON, with the names. What the
 *                      assistant reads, because it needs to SHOW what you are
 *                      about to attach before you let go, and an id is not
 *                      something a person can recognise.
 *
 * Setting both means a drag started anywhere works on every target: drop a
 * multi-selection on a folder and the folder gets the first file (which is
 * what it did before), drop the same drag on the assistant and it gets all of
 * them. Nothing had to be taught about anything else.
 *
 * WHY A CUSTOM MIME TYPE AT ALL
 *
 * `text/plain` would be read by every text input on the page, by the browser's
 * own "search for this" affordances, and by anything else listening for a
 * drop. A private type means only code that asks for it sees the drag, and --
 * more usefully -- `dataTransfer.types` can be inspected during `dragover`,
 * where the payload itself is deliberately unreadable for privacy reasons.
 * That is how a drop target can light up for a file and stay inert for a
 * desktop file or a dragged paragraph.
 */

export const FILE_MIME = "text/dms-file-id";
export const FILES_MIME = "text/dms-files";

/** How many files one drag will carry. */
const MAX_DRAGGED = 100;

/** The name a person would recognise this file by, in the order they would. */
export function fileLabel(f) {
  return (
    f?.ai_short_title ||
    f?.display_name ||
    f?.canonical_filename ||
    f?.filename_current ||
    f?.filename ||
    "Untitled"
  );
}

/**
 * Start a file drag carrying `files`.
 *
 * `effectAllowed` stays "move" so the cursor over a folder still reads as a
 * move -- attaching to the assistant is the secondary meaning of this gesture,
 * and the primary one should not have to look ambiguous to accommodate it.
 * The assistant sets `dropEffect = "copy"` on its own drop zone instead, which
 * is where the distinction actually belongs.
 */
export function setFileDragData(e, files) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean).slice(0, MAX_DRAGGED);
  if (!list.length) return;
  e.dataTransfer.setData(FILE_MIME, list[0].id);
  e.dataTransfer.setData(
    FILES_MIME,
    JSON.stringify(list.map((f) => ({ id: f.id, name: fileLabel(f), path: f.current_path || null })))
  );
  e.dataTransfer.effectAllowed = "move";
}

/** Is this drag one of ours? Answerable during `dragover`, unlike the payload. */
export function isFileDrag(e) {
  const types = [...(e.dataTransfer?.types || [])];
  return types.includes(FILES_MIME) || types.includes(FILE_MIME);
}

/**
 * The files a drop is carrying.
 *
 * Falls back to the single-id type so a drag begun somewhere that has not been
 * taught the richer payload still attaches -- with no name, which the caller
 * renders as the id rather than as nothing. Malformed JSON returns an empty
 * list rather than throwing: a drop handler that throws leaves the page in a
 * dragging state with no way out.
 */
export function readDraggedFiles(e) {
  const raw = e.dataTransfer.getData(FILES_MIME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((f) => f && typeof f.id === "string");
      }
    } catch { /* fall through to the single-id form */ }
  }
  const id = e.dataTransfer.getData(FILE_MIME);
  return id ? [{ id, name: id, path: null }] : [];
}
