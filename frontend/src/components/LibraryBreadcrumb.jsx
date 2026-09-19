import { ChevronRight, FolderOpen, FolderTree, Library, Search, X } from "lucide-react";

/**
 * Where you are, and how to get back out.
 *
 * WHY THIS REPLACED A LINE OF TEXT
 *
 * The panel header used to print the folder's name next to its
 * `materialized_path` as a static string -- "Contracts" followed by
 * "Legal / Contracts". That answers "where am I" and nothing else: the
 * ancestors were visible but dead, so the only way back up a level was to find
 * the parent again in the tree on the left. In a folder six levels deep that
 * is a hunt every single time.
 *
 * Every ancestor here is a button. That is the whole idea -- a breadcrumb is
 * not a label, it is the fastest control on the page for moving up.
 *
 * WHY THE COUNT LIVES HERE
 *
 * "How many files am I looking at" is part of knowing where you are, and it
 * belongs next to the place rather than off in the filter bar. The number is
 * passed in rather than derived: this component must not disagree with the
 * list underneath it, so it is given whatever that list is actually showing.
 *
 * ONE COMPONENT FOR THREE MODES
 *
 * A folder, the unfiled pile, and a search across everything are all "where
 * you are". Giving them one shape means the answer to "where am I" appears in
 * the same place at the same size whatever you are doing, instead of moving
 * around depending on how you got there.
 */

/** Walk `parent_id` up the flat subject list. Nearest ancestor last. */
function ancestorChain(subjects, subject) {
  const byId = new Map((subjects || []).map((s) => [s.id, s]));
  const chain = [];
  let cursor = subject?.parent_id ? byId.get(subject.parent_id) : null;
  // Bounded by the map size: a cycle in the data would otherwise hang the page,
  // and a folder tree is not a place to trust that it cannot happen.
  let guard = 0;
  while (cursor && guard < byId.size) {
    chain.unshift(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : null;
    guard += 1;
  }
  return chain;
}

function Crumb({ children, onClick, current, icon: Icon }) {
  if (current) {
    return (
      <span className="flex min-h-9 min-w-0 items-center gap-1.5 font-semibold text-base-50 sm:min-h-0" aria-current="page">
        {Icon && <Icon size={15} className="shrink-0 text-brand-600" aria-hidden="true" />}
        <span className="truncate">{children}</span>
      </span>
    );
  }
  return (
    <button
      onClick={onClick}
      // These crumbs ARE the way back out of a folder, and on a phone they are
      // the ONLY way -- there is no tree pane to click a parent in. At
      // px-1 py-0.5 they were roughly 24px tall, which is a link you aim at
      // rather than a control you tap. Sized for a finger below sm and left
      // exactly as they were above it.
      className="flex min-h-9 min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-base-500 transition-colors hover:bg-base-850 hover:text-base-100 sm:min-h-0 sm:px-1 sm:py-0.5"
    >
      {Icon && <Icon size={15} className="shrink-0" aria-hidden="true" />}
      <span className="truncate">{children}</span>
    </button>
  );
}

const Separator = () => (
  <ChevronRight size={13} className="shrink-0 text-base-600" aria-hidden="true" />
);

export function LibraryBreadcrumb({
  subjects,
  selected,
  unfiledMode,
  searching,
  query,
  count,
  countLabel = "file",
  onNavigate,
  onClearSearch,
  actions,
}) {
  const chain = searching || unfiledMode ? [] : ancestorChain(subjects, selected);

  return (
    <div className="mb-3 flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-2">
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {/* The root is always present and always clickable, so there is a way
            back to "everything" from any depth without touching the tree. */}
        <Crumb icon={Library} onClick={() => onNavigate(null)} current={false}>
          Library
        </Crumb>

        {searching ? (
          <>
            <Separator />
            <Crumb icon={Search} current>
              “{query}”
            </Crumb>
          </>
        ) : unfiledMode ? (
          <>
            <Separator />
            <Crumb icon={FolderOpen} current>
              Unfiled
            </Crumb>
          </>
        ) : selected ? (
          <>
            {chain.map((node) => (
              <span key={node.id} className="flex min-w-0 items-center gap-1.5">
                <Separator />
                <Crumb onClick={() => onNavigate(node.id)}>{node.name}</Crumb>
              </span>
            ))}
            <Separator />
            <Crumb icon={FolderTree} current>
              {selected.name}
            </Crumb>
          </>
        ) : null}

        {/* The count sits with the place, not with the filters. */}
        {count !== null && count !== undefined && (
          <span className="ml-1 shrink-0 rounded-full border border-line bg-base-850 px-2 py-0.5 text-[11px] font-medium tabular text-base-500">
            {count.toLocaleString()} {countLabel}{count === 1 ? "" : "s"}
          </span>
        )}

        {searching && (
          <button className="btn-ghost btn-sm ml-1 shrink-0" onClick={onClearSearch}>
            <X size={13} /> Clear
          </button>
        )}
      </nav>

      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
