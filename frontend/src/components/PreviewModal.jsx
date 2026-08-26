import { Download } from "lucide-react";
import { Modal } from "./Modal";
import { FilePreviewPane } from "./FilePreviewPane";

/**
 * "Just show me the file." Opened by the Eye icon and by double-clicking a row.
 *
 * The Download button is always present, not only when rendering fails. A
 * preview is a picture of the first page -- useful for recognising a document,
 * useless for reading page four -- so "I have seen enough, give me the actual
 * file" is a normal thing to want, and it is also the fallback for the formats
 * nothing can rasterise.
 */
export function PreviewModal({ fileId, filename, onDownload, onClose }) {
  return (
    <Modal open={Boolean(fileId)} onClose={onClose} title={filename || "Preview"} width="max-w-2xl">
      <FilePreviewPane fileId={fileId} />
      {onDownload && (
        <div className="mt-3 flex justify-end">
          <button className="btn-secondary btn-sm" onClick={() => onDownload(fileId)}>
            <Download size={13} /> Download the file
          </button>
        </div>
      )}
    </Modal>
  );
}
