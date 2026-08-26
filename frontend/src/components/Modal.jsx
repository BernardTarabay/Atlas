import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

/**
 * The dialog every modal in this app is built on.
 *
 * It already handled Escape. What it did not do was anything that makes a
 * dialog usable without a mouse, or comprehensible to a screen reader: no
 * role, no accessible name, no focus management. Opening a modal left focus
 * on whatever button was behind it, so Tab walked the page underneath the
 * overlay -- reaching controls the user cannot see and cannot reasonably
 * mean to press -- and closing it dropped focus back to the document body,
 * losing the reader's place entirely.
 *
 * Fixing it here fixes it for all of them at once.
 */
export function Modal({ open, onClose, title, children, footer, width = "max-w-lg" }) {
  const panelRef = useRef(null);
  const restoreFocusTo = useRef(null);
  const titleId = useId();

  // Escape closes -- but only the TOPMOST dialog.
  //
  // The listener used to sit on `window`, so with one modal opened from
  // inside another (the folder picker inside "Register a storage location")
  // a single Escape fired both handlers and discarded the half-filled form
  // underneath as well. Listening on the panel during the capture phase and
  // stopping propagation means the innermost dialog consumes the key.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    const node = panelRef.current;
    node?.addEventListener("keydown", onKey);
    return () => node?.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Move focus in on open, put it back on close.
  useEffect(() => {
    if (!open) return undefined;
    restoreFocusTo.current = document.activeElement;

    // Prefer the first real control; fall back to the panel itself so focus
    // is never left outside the dialog.
    const focusable = panelRef.current?.querySelector(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    );
    (focusable || panelRef.current)?.focus();

    // The page behind a modal should not scroll under it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      // Only restore if the element is still in the document -- the action
      // that closed the dialog may have removed the row it came from.
      const target = restoreFocusTo.current;
      if (target instanceof HTMLElement && document.contains(target)) target.focus();
    };
  }, [open]);

  // Keep Tab inside the dialog. Without this the tab order continues into the
  // page behind the overlay, which is invisible to a sighted keyboard user
  // and nonsensical to a screen-reader one.
  function onKeyDownTrap(e) {
    if (e.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-scrim/70 backdrop-blur-sm animate-fade-in-up" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDownTrap}
        className={`glass-card animate-fade-in-up relative w-full ${width} p-0 shadow-2xl focus:outline-none`}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 id={titleId} className="text-sm font-semibold text-base-50">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-1 text-base-400 hover:bg-base-900 hover:text-base-100"
          >
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
