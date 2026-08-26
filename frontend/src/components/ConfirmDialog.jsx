import { Modal } from "./Modal";
import { AlertTriangle } from "lucide-react";

/**
 * `body` is for confirmations that need a CHOICE, not just a yes.
 *
 * Deleting a folder is the case that forced it: "what happens to the 128
 * documents inside" is part of the decision, and asking it in a second dialog
 * after the first would be two prompts for one action. Kept optional so the
 * plain yes/no confirmations stay exactly as they were.
 */
export function ConfirmDialog({
  open, onClose, onConfirm, title, description, body = null,
  confirmLabel = "Confirm", danger = false, loading = false,
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={body ? "max-w-md" : "max-w-sm"}
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            className={danger ? "btn-danger btn-sm" : "btn-primary btn-sm"}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex gap-3">
        {danger && <AlertTriangle size={20} className="mt-0.5 shrink-0 text-rose-600" />}
        <div className="min-w-0">
          <p className="text-sm text-base-300">{description}</p>
          {body}
        </div>
      </div>
    </Modal>
  );
}
