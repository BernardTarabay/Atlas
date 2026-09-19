import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../services/apiClient";
import { shareFiles, nativeShareAvailable } from "./shareFile";
import { useAssistant } from "../context/AssistantContext";
import { fileLabel } from "./fileDrag";

/**
 * The actions a file has, defined once for every view that shows files.
 *
 * WHY THIS EXISTS
 *
 * Library and Files are two ways of looking at ONE inventory. A file does not
 * become a different kind of thing because you reached it through a different
 * list, so "why can I share this from Library but not from Files?" is a
 * question the architecture should make unaskable rather than a bug to be
 * fixed twice.
 *
 * Before this, each page assembled its own actions object by hand and wired its
 * own download. That is how they drifted: one of them had no Preview, no Move
 * and no Details, because nobody remembered to add them there too.
 *
 * So the shared operations -- share, export, and the jump back to a file's real
 * place in the Library -- are implemented HERE, once. A page supplies only what
 * is genuinely local to it: whether the user may rename, what "open" means on
 * that screen, which modal its Move button opens.
 *
 * WHAT STAYS PER-PAGE
 *
 * Anything that would be a lie to share. Library's "open" honours the
 * server-machine rule in lib/openFile; the Files page opens its own preview
 * modal. Those are different intentions, not one intention implemented twice.
 */
export function useFileActions({
  push,
  onPreview = null,
  onDetails = null,
  onOpen = null,
  onRename = null,
  onMove = null,
  onDelete = null,
  showInLibrary = false,
} = {}) {
  const navigate = useNavigate();
  const { attachFiles, openAssistant } = useAssistant();

  const notice = useCallback((message, tone = "info") => push?.(message, tone), [push]);

  /** Hand one or more files to the OS share sheet, or export them. */
  const share = useCallback(
    (fileOrFiles) => shareFiles(Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles], { onNotice: notice }),
    [notice]
  );

  const download = useCallback(
    async (file) => {
      const name = file.canonical_filename || file.filename_current || "download";
      try {
        await api.download(`/files/${file.id}/download`, name);
      } catch (err) {
        notice(err.message || `Could not download "${name}".`, "error");
      }
    },
    [notice]
  );

  /**
   * Go to where this file actually lives.
   *
   * THE FILE ANSWERS THIS, NOT THE CALLER.
   *
   * Every listing decorates its rows with `subject_id` (fileRepository's
   * FILE_DECORATION), which is the file's own record of where it is filed. So
   * this reads the destination off the file rather than having each view
   * reconstruct it -- a Types page working out a Library path for itself would
   * be a second, quietly diverging copy of the same knowledge.
   *
   * `file` travels in the URL alongside `subject` so the Library can scroll to
   * it and mark it. Landing in the right folder and leaving someone to find
   * one row among two hundred is most of the way to not having navigated at
   * all.
   */
  /**
   * Hand this file to the assistant as context, and open it.
   *
   * THE KEYBOARD AND TOUCH PATH FOR DRAG-AND-DROP.
   *
   * Dragging a row onto the assistant is the discoverable gesture and it is
   * also a mouse-only one: HTML5 drag-and-drop does not fire for touch at all,
   * and there is no keyboard equivalent. A feature that exists only for people
   * with a pointer is half a feature, and this app is explicitly used from a
   * phone (docs/11). So the same operation is a menu item, reachable by
   * right-click, by the row's dots button, and by long-press on a phone --
   * which is what opens that menu there.
   */
  const askAssistantAbout = useCallback(
    (file) => {
      const { added, duplicates } = attachFiles([
        { id: file.id, name: fileLabel(file), path: file.current_path || null },
      ]);
      openAssistant();
      if (added) notice(`Attached "${fileLabel(file)}" for Gemini.`, "success");
      else if (duplicates) notice("That file is already attached.", "info");
    },
    [attachFiles, openAssistant, notice]
  );

  const goToLibrary = useCallback(
    (file) => {
      const subjectId = file.subject_id || null;
      if (!subjectId) {
        // Unfiled is a real answer, and the unfiled pile is a real place.
        navigate(`/?unfiled=1&file=${file.id}`);
        notice("This file has not been filed under a folder yet — showing it in Unfiled.", "info");
        return;
      }
      navigate(`/?subject=${subjectId}&file=${file.id}`);
    },
    [navigate, notice]
  );

  /**
   * The object FileContextMenu consumes.
   *
   * A null entry means "this view does not offer that", and the menu omits the
   * row rather than showing something inert -- see its own note on placeholder
   * UI.
   */
  const actions = useMemo(
    () => ({
      onOpen,
      onPreview,
      onDetails,
      onShare: share,
      onDownload: download,
      onAskAssistant: askAssistantAbout,
      onRename,
      onMove,
      onDelete,
      onShowInLibrary: showInLibrary ? goToLibrary : null,
    }),
    [onOpen, onPreview, onDetails, share, download, askAssistantAbout, onRename, onMove, onDelete, showInLibrary, goToLibrary]
  );

  return { actions, share, download, goToLibrary, askAssistantAbout, nativeShareAvailable: nativeShareAvailable() };
}
