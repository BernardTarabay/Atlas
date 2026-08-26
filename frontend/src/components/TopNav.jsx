import { useCallback, useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, FileText, FolderTree, LifeBuoy, Images, HardDrive, Inbox, ScrollText, Users, Boxes, Menu, X, MoreHorizontal,
  LogOut, User as UserIcon, ChevronDown, MonitorSmartphone, Stamp,
  GripVertical, Pin, PinOff, RotateCcw,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { usePolling } from "../hooks/useApiData";
import { api } from "../services/apiClient";
import { NAV_LAYOUT_KEY, resolveNav, toStored, pinAt, unpin, reorder } from "../lib/navLayout";

/**
 * WHY THE NAVIGATION MOVED TO THE TOP
 *
 * The brief said to evaluate rather than assume, so: the sidebar was 256
 * fixed pixels of chrome, permanently, for eleven links. Every page in this
 * app is a wide table or a two-pane browser -- Files, Subjects, Duplicates,
 * Triage -- and on a 1366px laptop those 256px were roughly a fifth of the
 * horizontal space, spent on a list the user reads once and then navigates by
 * muscle memory. The Subjects page in particular puts a tree beside a file
 * list beside a detail panel, and it was the cramped one.
 *
 * Top navigation gives that width back to the content and costs nothing that
 * matters: the same eleven destinations still fit on one row at desktop
 * widths, and below that they collapse into a drawer exactly as the sidebar
 * already did.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * A flat row of eleven equally-weighted links is a worse menu than a sidebar,
 * not a better one. So the destinations are split by how often they are used:
 * the six that are the daily loop stay visible, and the administrative ones
 * (Audit Log, Users, Inbox, Storage, Devices) live behind a "More" menu. That
 * is a judgement about this application's actual workflow -- you look at
 * Files and Subjects constantly and at the audit log twice a year.
 */

/**
 * THE DEFAULT SPLIT, WHICH IS NOW ONLY A DEFAULT.
 *
 * `defaultPrimary` marks the daily loop -- what a new account sees on the
 * header row. Anyone can drag a destination between the row and "More", or pin
 * it from the menu, and their arrangement is remembered (lib/navLayout.js).
 * Order below still follows the lifecycle a document goes through, which is
 * roughly how often each is opened.
 */
const PRIMARY = [
  // The Library leads because it is what this application is for. Everything
  // else here is either a narrower lens on the same documents (Files, Types)
  // or a queue of work about them (Triage, Duplicates).
  { to: "/", label: "Library", icon: FolderTree, end: true, defaultPrimary: true },
  { to: "/files", label: "Files", icon: FileText, defaultPrimary: true },
  // Beside the Library because they are a pair, not a hierarchy: these are the
  // two independent classification axes (docs/03-taxonomy.md §3.4), and
  // putting the second one behind "More" while the first is primary is how
  // half a feature quietly stops existing.
  { to: "/document-types", label: "Types", icon: Stamp, defaultPrimary: true },
  { to: "/triage", label: "Triage", icon: LifeBuoy, badgeKey: "triage", defaultPrimary: true },
  { to: "/photos", label: "Photos", icon: Images, badgeKey: "photos", defaultPrimary: true },
];

// Reached occasionally and deliberately. Behind "More" rather than removed --
// hiding a destination entirely is how a feature stops existing. Any of these
// can be dragged or pinned onto the header row.
const SECONDARY = [
  // Moved off the front row when the Library took over the landing page. It
  // is not demoted in importance -- it is the best view of the pipeline in the
  // app -- but the numbers a person needs *daily* (how much is unfiled, how
  // much is still being processed) now sit on the Library itself, and this
  // answers the deeper questions you go looking for on purpose.
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/storage-locations", label: "Storage locations", icon: HardDrive },
  { to: "/devices", label: "Devices", icon: MonitorSmartphone },
  { to: "/inbox", label: "Inbox", icon: Inbox, permission: "email.manage" },
  { to: "/audit-log", label: "Audit log", icon: ScrollText, permission: "audit.view" },
  { to: "/users", label: "Users", icon: Users, permission: "user.manage" },
];

/** Every destination in one list; where each one SITS is decided at runtime. */
const ALL_ITEMS = [...PRIMARY, ...SECONDARY];

/**
 * The drag payloads this header understands.
 *
 * Two different gestures land on the same targets and must not be confused:
 * rearranging the navigation, and dragging a document somewhere. Custom MIME
 * types keep them apart, and keep anything else dragged onto the page (a
 * desktop file, selected text) from being read as either.
 */
const NAV_MIME = "text/dms-nav-item";
const FILE_MIME = "text/dms-file-id";

// Polled rather than fetched once so the badges reflect work that shows up
// from a scan still running in the background. 30s is frequent enough to feel
// live without hammering the API from every open tab.
const BADGE_POLL_MS = 30000;

function Badge({ count }) {
  if (!count) return null;
  return (
    <span className="ml-1 rounded-full bg-brand-500/90 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function TopNav() {
  const { user, logout, hasPermission } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // One request for every badge. Three usePolling calls would be three timers
  // and three round trips on the same 30s beat, from every open tab.
  const { data: badgeData } = usePolling(
    () =>
      Promise.all([
        api.get("/triage/summary").catch(() => null),
        api.get("/photos/summary").catch(() => null),
      ]).then(([triage, photos]) => ({ triage, photos })),
    BADGE_POLL_MS
  );

  const badges = {
    triage: badgeData?.triage?.total || 0,
    // Only the ones actually waiting on a person -- a count that included
    // every already-read photo would sit permanently at four figures and mean
    // nothing.
    photos: (badgeData?.photos?.counts?.pending || 0) + (badgeData?.photos?.counts?.failed || 0),
  };

  const navigate = useNavigate();

  /**
   * The user's own header arrangement.
   *
   * localStorage throws in private-mode Safari, and a header that fails to
   * render takes the whole application with it -- so a broken read falls back
   * to the shipped default rather than propagating.
   */
  const [pinned, setPinned] = useState(() => {
    try {
      const raw = localStorage.getItem(NAV_LAYOUT_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  });

  const savePinned = useCallback((next) => {
    setPinned(next);
    try {
      if (next === null) localStorage.removeItem(NAV_LAYOUT_KEY);
      else localStorage.setItem(NAV_LAYOUT_KEY, JSON.stringify(next));
    } catch { /* a layout that cannot be saved still works for this session */ }
  }, []);

  const { primary, secondary } = useMemo(
    () => resolveNav(ALL_ITEMS, pinned, hasPermission),
    [pinned, hasPermission]
  );

  // The order to mutate from. When nothing has been customised yet, that is
  // whatever is on the header right now -- so the first drag rearranges what
  // the user can see rather than an invisible default.
  const currentOrder = useMemo(() => toStored(primary), [primary]);

  // --- dragging -----------------------------------------------------------
  const [draggingKey, setDraggingKey] = useState(null);
  const [dropHint, setDropHint] = useState(null); // { key, before } | "more"

  const isNavDrag = (e) => [...e.dataTransfer.types].includes(NAV_MIME);
  const isFileDrag = (e) => [...e.dataTransfer.types].includes(FILE_MIME);

  const startNavDrag = (e, key) => {
    e.dataTransfer.setData(NAV_MIME, key);
    e.dataTransfer.effectAllowed = "move";
    setDraggingKey(key);
  };
  const endNavDrag = () => { setDraggingKey(null); setDropHint(null); };

  /**
   * A destination accepts two very different drops.
   *
   * A NAV item lands here to be reordered. A FILE lands here to take you to
   * that page -- dragging a document onto "Duplicates" is a way to get there
   * while still holding it, which is otherwise impossible: you cannot navigate
   * mid-drag with the mouse already down.
   */
  const onItemDragOver = (e, item, index) => {
    if (isNavDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const box = e.currentTarget.getBoundingClientRect();
      setDropHint({ key: item.to, before: e.clientX < box.left + box.width / 2 });
    } else if (isFileDrag(e)) {
      e.preventDefault();
      // "link", not "move": nothing is filed here. The cursor should not
      // promise that dropping a document on a menu entry files it there.
      e.dataTransfer.dropEffect = "link";
      setDropHint({ key: item.to, before: null });
    }
    void index;
  };

  const onItemDrop = (e, item) => {
    if (isNavDrag(e)) {
      e.preventDefault();
      const key = e.dataTransfer.getData(NAV_MIME);
      const box = e.currentTarget.getBoundingClientRect();
      const before = e.clientX < box.left + box.width / 2;
      savePinned(reorder(currentOrder, key, item.to, before));
    } else if (isFileDrag(e)) {
      e.preventDefault();
      navigate(item.to);
    }
    endNavDrag();
  };

  // Dropping a header item on "More" demotes it; dropping a file navigates.
  const onMoreDrop = (e) => {
    if (isNavDrag(e)) {
      e.preventDefault();
      savePinned(unpin(currentOrder, e.dataTransfer.getData(NAV_MIME)));
    }
    endNavDrag();
  };

  const pinToHeader = (key) => savePinned(pinAt(currentOrder, key));
  const unpinFromHeader = (key) => savePinned(unpin(currentOrder, key));
  const resetOrder = () => savePinned(null);

  // A layout is "customised" only if it differs from what shipped.
  const customised = pinned !== null;

  return (
    <header className="sticky top-0 z-40 shrink-0 border-b border-line bg-base-900/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-2 px-4 sm:px-6">
        {/* Brand */}
        <NavLink to="/" className="flex shrink-0 items-center gap-2.5" aria-label="Atlas home">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 shadow-glow">
            <Boxes size={16} className="text-white" aria-hidden="true" />
          </div>
          <span className="hidden text-sm font-semibold text-base-50 sm:block">Atlas</span>
        </NavLink>

        {/* Primary destinations. Hidden below md, where the drawer takes over. */}
        <nav className="ml-2 hidden min-w-0 flex-1 items-center gap-0.5 md:flex" aria-label="Main">
          {primary.map((item, index) => (
            <div
              key={item.to}
              className="relative"
              draggable
              onDragStart={(e) => startNavDrag(e, item.to)}
              onDragEnd={endNavDrag}
              onDragOver={(e) => onItemDragOver(e, item, index)}
              onDragLeave={() => setDropHint(null)}
              onDrop={(e) => onItemDrop(e, item)}
            >
              {/* Where the item would land, shown on the side the pointer is
                  on. Without it, dropping is a guess -- you find out where it
                  went only after letting go. */}
              {dropHint?.key === item.to && dropHint.before !== null && (
                <span
                  aria-hidden="true"
                  className={"absolute inset-y-1 w-0.5 rounded bg-brand-400 " + (dropHint.before ? "-left-0.5" : "-right-0.5")}
                />
              )}
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  (isActive ? "topnav-link-active" : "topnav-link") +
                  " cursor-grab active:cursor-grabbing" +
                  (draggingKey === item.to ? " opacity-40" : "") +
                  // A file hovering over a destination: this is where you will
                  // be taken, so it reads as a target rather than a drop slot.
                  (dropHint?.key === item.to && dropHint.before === null
                    ? " ring-1 ring-inset ring-brand-400/70"
                    : "")
                }
              >
                <item.icon size={15} aria-hidden="true" />
                {/* The label is what makes this navigable; only drop it when
                    there genuinely is not room, which is below lg. */}
                <span className="hidden lg:inline">{item.label}</span>
                <Badge count={item.badgeKey ? badges[item.badgeKey] : 0} />
              </NavLink>
            </div>
          ))}

          {(secondary.length > 0 || customised) && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                aria-haspopup="menu"
                /* Dropping a header item here demotes it -- the reverse of
                   dragging one out, and the gesture people try first. */
                onDragOver={(e) => {
                  if (!isNavDrag(e)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropHint("more");
                }}
                onDragLeave={() => setDropHint(null)}
                onDrop={onMoreDrop}
                className={"topnav-link" + (dropHint === "more" ? " ring-1 ring-inset ring-brand-400/70" : "")}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
                <span className="hidden lg:inline">More</span>
              </button>
              {moreOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} aria-hidden="true" />
                  <div className="glass-card animate-fade-in-up absolute left-0 z-20 mt-2 w-72 p-1.5">
                    {secondary.map((item) => (
                      <div
                        key={item.to}
                        className="group/nav flex items-center gap-1"
                        draggable
                        onDragStart={(e) => startNavDrag(e, item.to)}
                        onDragEnd={endNavDrag}
                      >
                        <NavLink
                          to={item.to}
                          onClick={() => setMoreOpen(false)}
                          className={({ isActive }) =>
                            "flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-sm " +
                            (isActive ? "bg-base-800 text-base-50" : "text-base-300 hover:bg-base-850")
                          }
                        >
                          <item.icon size={15} aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          <Badge count={item.badgeKey ? badges[item.badgeKey] : 0} />
                        </NavLink>
                        {/* The keyboard path. Dragging is the discoverable
                            gesture; a button is the one that works without a
                            mouse, and rearranging your own navigation should
                            not require one. */}
                        <button
                          type="button"
                          onClick={() => pinToHeader(item.to)}
                          title={`Show ${item.label} on the header`}
                          aria-label={`Show ${item.label} on the header`}
                          className="shrink-0 rounded-lg p-1.5 text-base-500 opacity-0 hover:bg-base-800 hover:text-brand-700 focus:opacity-100 group-hover/nav:opacity-100"
                        >
                          <Pin size={13} />
                        </button>
                      </div>
                    ))}

                    {/* What is already on the header, so it can be taken off
                        again without a mouse. */}
                    {primary.length > 0 && (
                      <>
                        <div className="my-1.5 border-t border-line" />
                        <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-base-500">
                          On the header — drag to reorder
                        </p>
                        {primary.map((item) => (
                          <div key={item.to} className="group/pin flex items-center gap-1">
                            <span className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-base-400">
                              <GripVertical size={12} className="shrink-0 text-base-600" aria-hidden="true" />
                              <item.icon size={14} aria-hidden="true" />
                              <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => unpinFromHeader(item.to)}
                              title={`Move ${item.label} into More`}
                              aria-label={`Move ${item.label} into More`}
                              className="shrink-0 rounded-lg p-1.5 text-base-500 opacity-0 hover:bg-base-800 hover:text-base-200 focus:opacity-100 group-hover/pin:opacity-100"
                            >
                              <PinOff size={13} />
                            </button>
                          </div>
                        ))}
                      </>
                    )}

                    {customised && (
                      <>
                        <div className="my-1.5 border-t border-line" />
                        <button
                          type="button"
                          onClick={() => { resetOrder(); setMoreOpen(false); }}
                          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-base-400 hover:bg-base-850 hover:text-base-200"
                        >
                          <RotateCcw size={13} aria-hidden="true" />
                          Reset to the default order
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </nav>

        <div className="flex-1 md:hidden" />

        {/* Account */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setAccountOpen((v) => !v)}
            aria-expanded={accountOpen}
            aria-haspopup="menu"
            className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm hover:bg-base-850"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-700 text-[11px] font-semibold text-white">
              {(user?.full_name || user?.email || "?").slice(0, 1).toUpperCase()}
            </div>
            <div className="hidden text-left xl:block">
              <p className="text-xs font-medium leading-tight text-base-100">{user?.full_name}</p>
              <p className="text-[10px] leading-tight text-base-400">{user?.roles?.join(", ")}</p>
            </div>
            <ChevronDown size={13} className="hidden text-base-400 xl:block" aria-hidden="true" />
          </button>

          {accountOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAccountOpen(false)} aria-hidden="true" />
              <div className="glass-card animate-fade-in-up absolute right-0 z-20 mt-2 w-56 p-1.5">
                <div className="px-3 py-2 text-xs text-base-400">
                  <div className="flex items-center gap-1.5"><UserIcon size={12} aria-hidden="true" /> {user?.email}</div>
                </div>
                <button
                  onClick={logout}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-700 hover:bg-rose-500/10"
                >
                  <LogOut size={15} aria-hidden="true" /> Sign out
                </button>
              </div>
            </>
          )}
        </div>

        {/* Drawer trigger, below md only. */}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation menu"
          aria-controls="app-nav-drawer"
          className="rounded-xl p-2 text-base-300 hover:bg-base-850 hover:text-base-100 md:hidden"
        >
          <Menu size={18} aria-hidden="true" />
        </button>
      </div>

      {/* Mobile drawer.
          Rendered only when open rather than translated off-screen: an element
          that is not in the tree cannot be tabbed into, which an off-screen
          one still can. Same reasoning the old sidebar arrived at. */}
      {drawerOpen && (
        <div className="md:hidden">
          <div
            className="fixed inset-0 z-40 bg-scrim/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <nav
            id="app-nav-drawer"
            className="fixed inset-y-0 right-0 z-50 flex w-72 flex-col gap-1 overflow-y-auto border-l border-line bg-base-900 p-3"
            aria-label="Main"
          >
            <div className="mb-1 flex items-center justify-between px-2 py-1">
              <span className="text-sm font-semibold text-base-50">Menu</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation menu"
                className="rounded-lg p-1.5 text-base-400 hover:bg-base-850 hover:text-base-100"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            {[...primary, ...secondary].map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setDrawerOpen(false)}
                className={({ isActive }) => (isActive ? "nav-link-active" : "nav-link")}
              >
                <item.icon size={17} aria-hidden="true" />
                <span className="flex-1">{item.label}</span>
                <Badge count={item.badgeKey ? badges[item.badgeKey] : 0} />
              </NavLink>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}
