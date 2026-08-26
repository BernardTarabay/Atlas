import { api } from "../services/apiClient";

/**
 * What "open this file" means, given where the person asking is sitting.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The server can launch a file in its own desktop's default application, and
 * that is genuinely the best possible "open" -- a PDF in a PDF reader, a
 * spreadsheet in Excel. But it runs on the SERVER, and this app is reached
 * from two places: the machine the files are on, and a phone or laptop over
 * the tailnet.
 *
 * Asking the server to open a document because someone tapped a row on their
 * phone would launch it on a desktop in another room, where nobody is looking,
 * and report success. That is not a small annoyance -- it is the app doing
 * something invisible and unexplained on a different computer.
 *
 * So the rule is: launch it locally only when "locally" is where you are.
 *
 * HOW "WHERE YOU ARE" IS DECIDED
 *
 * The browser's own hostname. If the page was served from localhost then the
 * browser and the server are the same machine, by definition -- no
 * configuration, no guessing, and it cannot be wrong. Reaching Atlas over the
 * tailnet gives a `.ts.net` host and this correctly returns false.
 *
 * It is deliberately strict. A false negative costs a preview instead of a
 * launch, which is a fine outcome; a false positive opens a file on somebody
 * else's screen.
 */
export function isOnServerMachine() {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/**
 * Open a file the best way available from here.
 *
 * @param {object}   file
 * @param {object}   handlers
 * @param {Function} handlers.onPreview  fall back to the in-app preview
 * @param {Function} handlers.onDownload fall back to fetching the bytes
 * @param {Function} handlers.onNotice   tell the user what happened
 * @returns {Promise<"launched"|"downloaded"|"preview">}
 */
export async function openFileSmart(file, { onPreview, onDownload, onNotice } = {}) {
  if (!file) return "preview";

  // Nothing on this disk to launch: the bytes have to be fetched before there
  // is a file at all. This is the "if it isn't available, download it" case.
  if (file.is_cloud_placeholder) {
    onNotice?.(`"${file.filename_current}" is stored in the cloud — downloading it…`, "info");
    onDownload?.(file);
    return "downloaded";
  }

  if (isOnServerMachine()) {
    try {
      await api.post(`/files/${file.id}/open`);
      return "launched";
    } catch (err) {
      // Every reason this fails -- no desktop on the server, an
      // agent-brokered location, a file that moved -- ends the same way: show
      // it in the app instead. The message is surfaced rather than swallowed,
      // because "nothing happened" is the worst possible response to a
      // double-click.
      onNotice?.(`Couldn't open it on this machine (${err.message}). Showing a preview instead.`, "info");
    }
  }

  onPreview?.(file);
  return "preview";
}
