export function EmptyState({ icon: Icon, title, description, action, onClick }) {
  const clickable = Boolean(onClick);
  return (
    <div
      className={
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line-strong px-6 py-16 text-center" +
        (clickable
          ? " cursor-pointer transition-colors hover:border-brand-400/40 hover:bg-base-900"
          : "")
      }
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") onClick(); } : undefined}
    >
      {Icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line-strong bg-base-900">
          <Icon size={22} className="text-base-400" />
        </div>
      )}
      <div>
        <p className="text-sm font-medium text-base-100">{title}</p>
        {description && <p className="mt-1 max-w-sm text-sm text-base-400">{description}</p>}
      </div>
      {action}
    </div>
  );
}
