import { createContext, useCallback, useContext, useState } from "react";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";

const ToastContext = createContext(null);

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

const STYLES = {
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  error: "border-rose-500/30 bg-rose-500/10 text-rose-700",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700",
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((message, type = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => dismiss(id), 4500);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      {/*
        Announced to assistive tech. Toasts are how this app reports the
        outcome of almost every action -- "Renamed", "Couldn't reach the
        assistant" -- and without a live region they were purely visual, so a
        screen-reader user pressed Approve and was told nothing at all.

        polite (not assertive) so it waits for a pause rather than cutting
        across whatever is being read; atomic so the whole message is spoken
        rather than just the words that changed.
      */}
      <div
        className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map((t) => {
          const Icon = ICONS[t.type];
          return (
            <div
              key={t.id}
              className={`animate-fade-in-up glass-card flex items-start gap-2.5 border px-4 py-3 text-sm shadow-lg ${STYLES[t.type]}`}
              style={{ minWidth: 280, maxWidth: 380 }}
            >
              <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p className="flex-1 leading-snug">{t.message}</p>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="text-current/60 hover:text-current"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
