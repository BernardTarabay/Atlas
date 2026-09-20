// The library explorer: a file manager for the virtual library.
//
// WHY IT LOOKS LIKE FILE EXPLORER
//
// Because that shape is the product of thirty years of people browsing large
// numbers of files, and it works: a tree on the left for where you are, a dense
// list on the right for what is there, one command bar, one status bar, and the
// same row drawn the same way every time. Nothing animates, nothing reflows
// while you read it. A prettier list that shows twelve files per screen is a
// worse tool than a plain one that shows sixty.
//
// WHAT IS REAL AND WHAT IS NOT
//
// The library is a PREVIEW. Atlas has never moved, renamed or deleted a file;
// `files.plan` is where each file WOULD go. So every command that would touch
// the disk (paste, rename, delete, new folder) is present, reachable and
// correctly enabled - and refuses, explaining what is missing. The commands
// that are only about looking (views, sorting, grouping, filtering, selection,
// properties, copy path/link) are fully live. Pretending the destructive ones
// do not exist would hide the shape of the finished product; pretending they
// work would be a lie about your files.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtBytes = (n) => {
  if (n == null) return "";
  if (n === 0) return "0 KB";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < 4) { v /= 1024; i++; }
  return `${v.toFixed(i && v < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtDate = (t) => (t ? new Date(t).toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const fmtNum = (n) => (n ?? 0).toLocaleString();
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

async function api(path) {
  const res = await fetch(path, { credentials: "same-origin" });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (res.status === 401) { location.hash = "#/login"; throw new Error("sign in required"); }
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

/* ---- marking what you typed ------------------------------------------ */

// It goes into a RegExp and it is user input: "report (2024)" or "c++" would
// throw and take the whole list down with it. The search box is the one input
// guaranteed to receive punctuation.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does this text literally contain the query? The same test the marker uses. */
function hasMatch(text, query) {
  if (!query || !text) return false;
  return String(text).toLowerCase().includes(String(query).toLowerCase());
}

/**
 * `text` with every occurrence of `query` marked, find-in-page style, as HTML.
 * The text is escaped FIRST and the marks added after, so a file called
 * `<script>.pdf` is marked, not executed.
 */
function mark(text, query) {
  const value = String(text ?? "");
  const needle = (query || "").trim();
  if (!needle) return esc(value);
  const parts = value.split(new RegExp(`(${escapeRegExp(needle)})`, "gi"));
  if (parts.length === 1) return esc(value);
  return parts.map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join("");
}

/* ---- what a dragged file carries -------------------------------------- */

// A private MIME type, not text/plain: only our own targets react to it, and
// `dataTransfer.types` can be inspected during dragover, where the payload
// itself is deliberately unreadable. That is how a folder can light up for a
// dragged file and stay inert for a dragged paragraph or a desktop file.
const DRAG_MIME = "application/x-atlas-files";
const MAX_DRAGGED = 5000;

/* ---- icons ----------------------------------------------------------- */

const PATHS = {
  back: "M10 4 4 10l6 6", forward: "M10 4l6 6-6 6", up: "M10 16V5m0 0L5 10m5-5 5 5",
  refresh: "M16 10a6 6 0 1 1-1.8-4.2M16 4v3h-3",
  cut: "M6 4l8 12M14 4L6 16M6.5 16.5a1.8 1.8 0 1 1-2.5-2.5 1.8 1.8 0 0 1 2.5 2.5zm9.5-2.5a1.8 1.8 0 1 0-2.5 2.5 1.8 1.8 0 0 0 2.5-2.5z",
  copy: "M7 7h8v9H7zM5 13V4h8",
  paste: "M7 3h6v3H7zM5 5h2m6 0h2v12H5V5",
  rename: "M4 16h12M4 12l8-8 3 3-8 8H4z",
  share: "M6 10l8-4m-8 4 8 4m-8-4a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm12-5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  trash: "M4 6h12M8 6V4h4v2m-6 0 1 10h6l1-10",
  add: "M10 4v12M4 10h12",
  sort: "M5 6h10M5 10h7M5 14h4",
  view: "M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z",
  group: "M4 5h12M4 10h12M4 15h12",
  more: "M5 10h.01M10 10h.01M15 10h.01",
  info: "M10 9v5m0-8h.01M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0z",
  select: "M4 10l4 4 8-8",
  filter: "M3 5h14l-5.5 6v5l-3 1.5V11z",
  chev: "M7 4l5 5-5 5",
  caret: "M3 5l4 4 4-4",
  open: "M4 6h5l1.5 2H16v7H4z",
  eye: "M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5zm8 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  link: "M8 12a3 3 0 0 0 4 0l2-2a3 3 0 0 0-4-4m0 4a3 3 0 0 0-4 0l-2 2a3 3 0 0 0 4 4",
  download: "M10 3v9m0 0 3-3m-3 3-3-3M4 15h12",
};
const ico = (name, cls = "") => `<svg class="${cls}" viewBox="0 0 20 20" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;
const FOLDER_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h3.2a1 1 0 0 1 .7.3L8.8 5.6h7.7A1.5 1.5 0 0 1 18 7v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>';

/* ---- view / sort / group vocabularies -------------------------------- */

const VIEWS = [
  ["xl", "Extra large icons"], ["large", "Large icons"], ["medium", "Medium icons"], ["small", "Small icons"],
  ["list", "List"], ["details", "Details"], ["tiles", "Tiles"], ["content", "Content"],
];

// Every sort key here is backed by something Atlas actually knows. Explorer also
// offers Authors and Tags; the analyzers do not extract either yet, so they are
// not in this menu - a menu item that can only ever sort by blank is a lie.
const SORTS = [
  ["name", "Name"], ["mtime", "Date modified"], ["type", "Type"], ["size", "Size"],
  ["ctime", "Date created"], ["ddate", "Date of document"], ["dtype", "Category"],
  ["title", "Title"], ["lang", "Language"],
];

const GROUPS = [
  ["none", "(None)"], ["name", "Name"], ["type", "Type"], ["size", "Size"],
  ["mtime", "Date modified"], ["ctime", "Date created"], ["dtype", "Category"], ["lang", "Language"],
];

const COLUMNS = {
  name: { label: "Name", width: "minmax(220px, 2.2fr)" },
  mtime: { label: "Date modified", width: "150px" },
  type: { label: "Type", width: "150px" },
  size: { label: "Size", width: "90px" },
  ctime: { label: "Date created", width: "150px" },
  ddate: { label: "Date of document", width: "150px" },
  dtype: { label: "Category", width: "120px" },
  title: { label: "Title", width: "minmax(120px, 1fr)" },
  lang: { label: "Language", width: "90px" },
  pages: { label: "Pages", width: "70px" },
  folder: { label: "Folder", width: "minmax(140px, 1.4fr)" },
};

/** Why a result matched: worth saying, because the levels of confidence differ. */
const WHY = { name: "name", content: "inside the document", semantic: "by meaning" };

const KIND_LABEL = {
  image: "Image", video: "Video", audio: "Audio", pdf: "PDF document", doc: "Document",
  sheet: "Spreadsheet", slides: "Presentation", text: "Text document", archive: "Archive", app: "Application",
};
const DTYPE_LABEL = {
  invoice: "Invoice", receipt: "Receipt", contract: "Contract", statement: "Bank statement", payslip: "Payslip",
  letter: "Letter", cv: "CV", certificate: "Certificate", report: "Report", minutes: "Minutes", medical: "Medical",
  tax: "Tax", identity: "Identity document", registration: "Registration form", quote: "Quote", order: "Order",
  insurance: "Insurance",
};
const LANG_LABEL = { en: "English", ar: "العربية", fr: "Français" };

/* ---- persisted preferences ------------------------------------------- */

const PREFS = "atlas.explorer";
const defaults = {
  view: "details", sortBy: "name", sortDir: "asc", groupBy: "none", theme: "system",
  nav: 240, tree: true, preview: false, cols: ["name", "mtime", "type", "size"],
};
function loadPrefs() {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS) || "{}") }; } catch { return { ...defaults }; }
}
function savePrefs() {
  try { localStorage.setItem(PREFS, JSON.stringify({ view: S.view, sortBy: S.sortBy, sortDir: S.sortDir, groupBy: S.groupBy, theme: S.theme, nav: S.nav, tree: S.tree, preview: S.preview, cols: S.cols })); } catch { /* private window: preferences just do not persist */ }
}

const S = {
  ...loadPrefs(),
  path: "", listing: null, items: [], rows: [],
  // Search is a place you can be, not a different page: same items, same
  // selection, same views. `query` is what was searched for, `matches` are the
  // rows whose NAME literally contains it, and `matchPos` walks them.
  mode: "folder", query: "", ms: 0, matches: [], matchPos: 0,
  selected: new Set(), anchor: null, cursor: 0,
  filter: "", clip: null,
  nodes: new Map(), // path -> { open, loading, folders }
  typed: "", typedAt: 0,
};

let root = null;   // the .ex element, or null when the explorer is not mounted
let previewSeq = 0;

/* ---- item model ------------------------------------------------------ */

const extOf = (name) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : ""; };

function typeLabel(it) {
  if (it.isDir) return "File folder";
  const k = it.kind && KIND_LABEL[it.kind];
  if (k && it.ext) return `${k} (.${it.ext})`;
  if (k) return k;
  return it.ext ? `${it.ext.toUpperCase()} file` : "File";
}

function toItems(listing) {
  const folders = listing.folders.map((f) => ({
    key: `d:${f.name}`, isDir: true, name: f.name, size: f.bytes, count: f.count, subs: f.subs,
    mtime: 0, ctime: 0, kind: null, dtype: null, title: null, lang: null, pages: null, ddate: null, ext: "",
  }));
  const files = listing.files.map((f) => ({
    key: `f:${f.id}`, id: f.id, isDir: false, name: f.name, size: f.size, mtime: f.mtime, ctime: f.ctime,
    kind: f.kind, dtype: f.dtype, title: f.title, lang: f.lang, pages: f.pages, ddate: f.ddate,
    width: f.width, height: f.height, ext: extOf(f.name),
  }));
  for (const it of [...folders, ...files]) it.type = typeLabel(it);
  return [...folders, ...files];
}

function hitsToItems(hits) {
  return hits.map((h) => {
    const full = h.plan || h.path;
    const name = full.slice(full.lastIndexOf("/") + 1);
    const it = {
      key: `f:${h.id}`, id: h.id, isDir: false, name, size: h.size, mtime: h.mtime, ctime: h.ctime,
      kind: h.kind, dtype: h.dtype, title: h.title, lang: h.lang, pages: h.pages, ddate: h.ddate,
      width: h.width, height: h.height, ext: extOf(name),
      folder: h.plan ? h.plan.slice(0, h.plan.lastIndexOf("/")) : "",
      snippet: h.snippet, why: h.why || [],
    };
    it.type = typeLabel(it);
    return it;
  });
}

/* ---- sorting and grouping -------------------------------------------- */

function sortValue(it, key) {
  switch (key) {
    case "name": return it.name;
    case "type": return it.type;
    case "dtype": return it.dtype ? DTYPE_LABEL[it.dtype] ?? it.dtype : "";
    case "title": return it.title ?? "";
    case "lang": return it.lang ? LANG_LABEL[it.lang] ?? it.lang : "";
    default: return it[key] ?? 0;
  }
}

function compare(a, b) {
  // Folders first, always, whatever the sort - the same rule every file manager
  // uses, because "where can I go" and "what is here" are different questions.
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  const dir = S.sortDir === "asc" ? 1 : -1;
  const va = sortValue(a, S.sortBy);
  const vb = sortValue(b, S.sortBy);
  let r;
  if (typeof va === "string" || typeof vb === "string") r = collator.compare(String(va), String(vb));
  else r = (va || 0) - (vb || 0);
  // A stable, meaningful tiebreak: two files of the same size still land in a
  // predictable order instead of whatever the last sort left behind.
  return (r || collator.compare(a.name, b.name)) * dir;
}

const DAY = 86400000;
function dateGroup(t) {
  if (!t) return "Unspecified";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= today) return "Today";
  if (t >= today - DAY) return "Yesterday";
  if (t >= today - 7 * DAY) return "Earlier this week";
  if (t >= today - 14 * DAY) return "Last week";
  const d = new Date(t);
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "Earlier this month";
  if (d.getFullYear() === now.getFullYear()) return "Earlier this year";
  return "A long time ago";
}

const GROUP_ORDER = ["Today", "Yesterday", "Earlier this week", "Last week", "Earlier this month", "Earlier this year", "A long time ago", "Unspecified"];
const SIZE_ORDER = ["Empty", "Tiny (0 - 16 KB)", "Small (16 KB - 1 MB)", "Medium (1 - 128 MB)", "Large (128 MB - 1 GB)", "Huge (> 1 GB)"];

function sizeGroup(n) {
  if (!n) return "Empty";
  if (n < 16 * 1024) return "Tiny (0 - 16 KB)";
  if (n < 1024 * 1024) return "Small (16 KB - 1 MB)";
  if (n < 128 * 1024 * 1024) return "Medium (1 - 128 MB)";
  if (n < 1024 * 1024 * 1024) return "Large (128 MB - 1 GB)";
  return "Huge (> 1 GB)";
}

function groupOf(it) {
  switch (S.groupBy) {
    case "name": { const c = it.name.trim().charAt(0).toUpperCase(); return /\p{L}/u.test(c) ? c : /\d/.test(c) ? "0 - 9" : "Other"; }
    case "type": return it.type;
    case "size": return it.isDir ? "Folders" : sizeGroup(it.size);
    case "mtime": return it.isDir ? "Folders" : dateGroup(it.mtime);
    case "ctime": return it.isDir ? "Folders" : dateGroup(it.ctime);
    case "dtype": return it.isDir ? "Folders" : it.dtype ? DTYPE_LABEL[it.dtype] ?? it.dtype : "Not classified";
    case "lang": return it.isDir ? "Folders" : it.lang ? LANG_LABEL[it.lang] ?? it.lang : "Unknown";
    default: return "";
  }
}

function groupRank(label) {
  if (label === "Folders") return -1;
  const d = GROUP_ORDER.indexOf(label);
  if (d >= 0) return d;
  const s = SIZE_ORDER.indexOf(label);
  if (s >= 0) return s;
  return 0;
}

/** The visible items, filtered, sorted and grouped: [{ label, items }]. */
function build() {
  const f = S.filter.trim().toLowerCase();
  let items = S.items;
  if (f) {
    items = items.filter((it) => it.name.toLowerCase().includes(f)
      || (it.title ?? "").toLowerCase().includes(f)
      || (it.dtype ? (DTYPE_LABEL[it.dtype] ?? it.dtype).toLowerCase() : "").includes(f)
      || it.type.toLowerCase().includes(f));
  }
  items = [...items].sort(compare);
  if (S.groupBy === "none") return [{ label: "", items }];
  const map = new Map();
  for (const it of items) {
    const label = groupOf(it);
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(it);
  }
  const known = GROUP_ORDER.concat(SIZE_ORDER);
  const groups = [...map.entries()].map(([label, list]) => ({ label, items: list }));
  groups.sort((a, b) => {
    const ra = groupRank(a.label);
    const rb = groupRank(b.label);
    if (known.includes(a.label) || known.includes(b.label) || a.label === "Folders" || b.label === "Folders") {
      if (ra !== rb) return (ra - rb) * (S.sortDir === "asc" ? 1 : -1);
    }
    return collator.compare(a.label, b.label) * (S.sortDir === "asc" ? 1 : -1);
  });
  return groups;
}

/* ---- rendering ------------------------------------------------------- */

function iconFor(it) {
  if (it.isDir) return `<span class="ex-ico folder">${FOLDER_SVG}</span>`;
  const cls = it.kind || "";
  const big = ["xl", "large", "medium", "tiles", "content"].includes(S.view);
  if (it.kind === "image" && big) {
    return `<span class="ex-ico image"><img loading="lazy" decoding="async" alt="" src="/api/files/${it.id}/content"></span>`;
  }
  return `<span class="ex-ico ${esc(cls)}">${esc(it.ext || it.kind || "?")}</span>`;
}

function cellText(it, col) {
  switch (col) {
    case "mtime": return it.isDir ? "" : fmtDate(it.mtime);
    case "ctime": return it.isDir ? "" : fmtDate(it.ctime);
    case "ddate": return it.ddate ? fmtDate(it.ddate) : "";
    case "type": return it.type;
    case "size": return it.isDir ? `${fmtNum(it.count)} items` : fmtBytes(it.size);
    case "dtype": return it.dtype ? DTYPE_LABEL[it.dtype] ?? it.dtype : "";
    case "title": return it.title ?? "";
    case "lang": return it.lang ? LANG_LABEL[it.lang] ?? it.lang : "";
    case "pages": return it.pages ? String(it.pages) : "";
    case "folder": return it.folder ?? "";
    default: return it.name;
  }
}

function itemHtml(it, index) {
  const sel = S.selected.has(it.key) ? ' aria-selected="true"' : "";
  const cur = index === S.cursor ? " cursor" : "";
  const hot = S.mode === "search" && S.matches[S.matchPos] === index ? " hot" : "";
  const drag = it.isDir ? ' data-folder="1"' : "";
  const a = `class="ex-item${cur}${hot}" data-key="${esc(it.key)}" data-index="${index}" role="option" tabindex="-1" draggable="true"${drag}${sel}`;
  const label = S.mode === "search" ? mark(it.name, S.query) : esc(it.name);
  const name = `<span class="nm" dir="auto" title="${esc(it.name)}">${label}</span>`;
  if (S.view === "details") {
    const cells = visibleCols().map((c, i) => (i === 0
      ? `<span class="cell first">${iconFor(it)}${name}</span>`
      : `<span class="cell${c === "size" ? " num" : ""} muted">${esc(cellText(it, c))}</span>`));
    return `<div ${a}>${cells.join("")}</div>`;
  }
  if (S.view === "tiles") {
    return `<div ${a}>${iconFor(it)}<span class="meta">${name}<span class="sub">${esc(it.type)}</span>
      <span class="sub">${esc(it.isDir ? `${fmtNum(it.count)} items` : fmtBytes(it.size))}</span></span></div>`;
  }
  if (S.view === "content") {
    const line = it.isDir ? `${fmtNum(it.count)} items` : [it.title, it.dtype ? DTYPE_LABEL[it.dtype] ?? it.dtype : "", it.type].filter(Boolean).join(" · ");
    const extra = S.mode === "search"
      ? `<span class="sub" dir="auto">${esc(it.folder || "")}</span>
         ${it.snippet ? `<span class="snippet" dir="auto">${mark(it.snippet, S.query)}</span>` : ""}
         <span class="why">${(it.why || []).map((w) => `<span class="tag">${esc(WHY[w] ?? w)}</span>`).join("")}</span>`
      : "";
    return `<div ${a}>${iconFor(it)}<span class="meta">${name}<span class="sub" dir="auto">${esc(line)}</span>${extra}</span>
      <span class="right">${esc(it.isDir ? "" : fmtBytes(it.size))}<br>${esc(it.isDir ? "" : fmtDate(it.mtime))}</span></div>`;
  }
  if (S.view === "list") return `<div ${a}>${iconFor(it)}${name}</div>`;
  return `<div ${a}>${iconFor(it)}${name}</div>`; // icon grids
}

const visibleCols = () => (S.mode === "search" && !S.cols.includes("folder") ? [...S.cols, "folder"] : S.cols);

function headHtml() {
  if (S.view !== "details") return "";
  const cells = visibleCols().map((c) => {
    const on = S.sortBy === c;
    const arrow = on ? `<span class="arrow">${S.sortDir === "asc" ? "▲" : "▼"}</span>` : "";
    return `<button type="button" data-col="${esc(c)}" title="Sort by ${esc(COLUMNS[c].label)}">${esc(COLUMNS[c].label)}${arrow}</button>`;
  });
  return `<div class="ex-head" id="exHead">${cells.join("")}</div>`;
}

function renderItems() {
  const box = root.querySelector("#exItems");
  const groups = build();
  S.rows = groups.flatMap((g) => g.items);
  if (S.cursor >= S.rows.length) S.cursor = Math.max(0, S.rows.length - 1);
  findMatches();     // before the rows are drawn: itemHtml marks the active one
  let i = 0;
  const body = groups.map((g) => {
    const head = g.label ? `<div class="ex-group">${esc(g.label)} <span>(${fmtNum(g.items.length)})</span></div>` : "";
    const html = g.items.map((it) => itemHtml(it, i++)).join("");
    return `${head}<div class="items" role="listbox" aria-multiselectable="true">${html}</div>`;
  }).join("");
  const empty = S.rows.length ? "" : `<p class="ex-empty">${
    S.mode === "search" ? `Nothing matched “${esc(S.query)}”.` : S.filter ? "No items match this filter." : "This folder is empty."}</p>`;
  updateFind();
  box.className = `ex-items v-${S.view}`;
  box.innerHTML = headHtml() + body + empty;
  if (S.view === "details") {
    box.style.setProperty("--cols", visibleCols().map((c) => COLUMNS[c].width).join(" "));
  }
  renderStatus();
}

/**
 * Selection, cursor and active match, painted onto the rows already on screen.
 *
 * WHY THIS IS NOT renderItems()
 *
 * Because rebuilding the list on a click is what broke double-click: the first
 * click replaced every row, so the second one landed on a DIFFERENT element and
 * the browser had no pair to report - `dblclick` fired on the container, or not
 * at all, and folders would not open. Exactly the trap V1 fell into with its
 * detail modal. Rebuilding 2,000 rows to tick one of them is also just waste.
 *
 * So: the row set changes -> renderItems(). Only which rows are MARKED changes
 * -> this.
 */
function applySelection() {
  const box = root?.querySelector("#exItems");
  if (!box) return;
  const hotIndex = S.mode === "search" && S.matches.length ? S.matches[S.matchPos] : -1;
  for (const el of box.querySelectorAll(".ex-item")) {
    const i = Number(el.dataset.index);
    // setAttribute, not toggleAttribute: the latter writes aria-selected="" and
    // the stylesheet matches [aria-selected="true"], so the row would be selected
    // without ever looking selected.
    if (S.selected.has(el.dataset.key)) el.setAttribute("aria-selected", "true");
    else el.removeAttribute("aria-selected");
    el.classList.toggle("cursor", i === S.cursor);
    el.classList.toggle("hot", i === hotIndex);
  }
  renderStatus();
}

function renderStatus() {
  const bar = root.querySelector("#exStatus");
  const sel = S.rows.filter((it) => S.selected.has(it.key));
  const bytes = sel.reduce((n, it) => n + (it.isDir ? 0 : it.size), 0);
  const parts = [esc(`${fmtNum(S.rows.length)} item${S.rows.length === 1 ? "" : "s"}`)];
  if (S.mode === "search") parts.push(`${fmtNum(S.matches.length)} showing “<bdi>${esc(S.query)}</bdi>”`);
  if (S.filter) parts.push(esc(`filtered from ${fmtNum(S.items.length)}`));
  if (sel.length) parts.push(`${fmtNum(sel.length)} selected${bytes ? ` · ${fmtBytes(bytes)}` : ""}`);
  if (S.listing?.more) parts.push("first 2,000 files only");
  if (S.clip) parts.push(`${S.clip.mode === "cut" ? "Cut" : "Copied"}: ${fmtNum(S.clip.items.length)}`);
  // Arabic queries sit inside an English sentence here: <bdi> keeps the two from
  // reordering each other. Everything else in the line is escaped on the way in.
  bar.querySelector(".info").innerHTML = parts.join("  |  ");
  for (const b of bar.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === S.view));
  syncCommands();
}

function syncCommands() {
  const n = S.selected.size;
  const one = n === 1;
  for (const [id, on] of [["cut", n > 0], ["copy", n > 0], ["rename", one], ["delete", n > 0], ["share", one], ["props", n > 0]]) {
    const b = root.querySelector(`[data-cmd="${id}"]`);
    if (b) b.disabled = !on;
  }
  const paste = root.querySelector('[data-cmd="paste"]');
  if (paste) paste.disabled = !S.clip;
}

/* ---- the tree -------------------------------------------------------- */

async function loadNode(path) {
  let node = S.nodes.get(path);
  if (!node) { node = { open: false, loaded: false, folders: [] }; S.nodes.set(path, node); }
  if (node.loaded) return node;
  // Share one request between concurrent callers: revealing a path and drawing
  // the tree both want the same children, and without this a single move fired
  // the same query twice for every open folder.
  if (!node.loading) {
    node.loading = api(`/api/library?folders=1&path=${encodeURIComponent(path)}`)
      .then((d) => { node.folders = d.folders; node.loaded = true; })
      .finally(() => { node.loading = null; });
  }
  await node.loading;
  return node;
}

function treeHtml(path, depth) {
  const node = S.nodes.get(path);
  if (!node?.open || !node.loaded) return "";
  return node.folders.map((f) => {
    const p = path ? `${path}/${f.name}` : f.name;
    const child = S.nodes.get(p);
    const expandable = f.subs > 0;
    const open = child?.open ? ' aria-expanded="true"' : expandable ? ' aria-expanded="false"' : "";
    const sel = S.path === p ? ' aria-selected="true"' : "";
    const row = `<div class="ex-node" data-path="${esc(p)}" role="treeitem"${open}${sel} data-depth="${depth}">
      <span class="twist" data-twist="${esc(p)}">${expandable ? ico("chev") : ""}</span>
      <span class="ex-ico folder">${FOLDER_SVG}</span>
      <span class="label" dir="auto">${esc(f.name)}</span><span class="n">${fmtNum(f.count)}</span></div>`;
    return row + treeHtml(p, depth + 1);
  }).join("");
}

function renderTree() {
  const el = root.querySelector("#exTree");
  const rootSel = S.path === "" ? ' aria-selected="true"' : "";
  const rootNode = S.nodes.get("");
  el.innerHTML = `<div class="ex-tree-head">Library</div>
    <div class="ex-node" data-path="" role="treeitem" aria-expanded="${rootNode?.open ? "true" : "false"}"${rootSel} data-depth="0">
      <span class="twist" data-twist="">${ico("chev")}</span><span class="ex-ico folder">${FOLDER_SVG}</span>
      <span class="label">All files</span></div>${treeHtml("", 1)}`;
  for (const n of el.querySelectorAll(".ex-node")) n.style.setProperty("--depth", n.dataset.depth);
}

async function toggleNode(path) {
  const node = await loadNode(path);
  node.open = !node.open;
  if (node.open) {
    // Children of the node being opened, in parallel: they are about to be drawn.
    await Promise.all(node.folders.map((f) => loadNode(path ? `${path}/${f.name}` : f.name).catch(() => {})));
  }
  renderTree();
}

/** Open the tree down to `path`, so the sidebar always shows where you are. */
async function revealInTree(path) {
  const parts = path ? path.split("/") : [];
  let acc = "";
  const chain = [""];
  for (const p of parts) { acc = acc ? `${acc}/${p}` : p; chain.push(acc); }
  for (const p of chain) {
    const node = await loadNode(p);
    node.open = true;
  }
  renderTree();
}

/* ---- menus ----------------------------------------------------------- */

let menuEl = null;
function closeMenu() {
  if (!menuEl) return;
  const opener = menuEl.dataset.owner && root.querySelector(`[data-cmd="${menuEl.dataset.owner}"]`);
  if (opener) opener.setAttribute("aria-expanded", "false");
  menuEl.remove();
  menuEl = null;
}

/**
 * One menu renderer for the command-bar dropdowns and the right-click menus, so
 * an action can never appear in one and be missing from the other. Positioned at
 * the pointer, then pulled back inside the viewport once its real size is known
 * - a menu opened near the bottom edge would otherwise put Delete off-screen.
 */
function openMenu(items, x, y, owner) {
  closeMenu();
  const el = document.createElement("div");
  el.className = "ex-menu";
  el.setAttribute("role", "menu");
  if (owner) el.dataset.owner = owner;
  el.innerHTML = items.map((it) => {
    if (it === "-") return "<hr>";
    if (it.head) return `<div class="head">${esc(it.head)}</div>`;
    const tick = it.checked != null ? `<span class="tick">${it.checked ? "✓" : ""}</span>` : it.icon ? ico(it.icon) : '<span class="tick"></span>';
    return `<button type="button" data-id="${esc(it.id)}"${it.disabled ? " disabled" : ""}${it.title ? ` title="${esc(it.title)}"` : ""}>
      ${tick}<span>${esc(it.label)}</span>${it.key ? `<span class="key">${esc(it.key)}</span>` : ""}</button>`;
  }).join("");
  (root ?? document.body).appendChild(el);
  const r = el.getBoundingClientRect();
  const pad = 8;
  el.style.left = `${Math.max(pad, Math.min(x, innerWidth - r.width - pad))}px`;
  el.style.top = `${Math.max(pad, Math.min(y, innerHeight - r.height - pad))}px`;
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b || b.disabled) return;
    const item = items.find((i) => i.id === b.dataset.id);
    closeMenu();
    item?.run?.();
  });
  menuEl = el;
  if (owner) root.querySelector(`[data-cmd="${owner}"]`)?.setAttribute("aria-expanded", "true");
}

function menuFromButton(btn, items) {
  const r = btn.getBoundingClientRect();
  openMenu(items, r.left, r.bottom + 4, btn.dataset.cmd);
}

/* ---- dialogs --------------------------------------------------------- */

function dialog(title, bodyHtml, { wide = false } = {}) {
  const d = document.createElement("dialog");
  d.className = "ex-dialog";
  d.innerHTML = `<h2>${esc(title)}</h2><div class="content">${bodyHtml}</div>
    <div class="foot"><button type="button" class="primary" data-close>Close</button></div>`;
  if (wide) d.style.width = "560px";
  (root ?? document.body).appendChild(d);
  d.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) d.close(); });
  d.addEventListener("close", () => d.remove());
  d.showModal();
  return d;
}

/**
 * Why a destructive command did nothing.
 *
 * Deliberately specific: what Atlas has done (nothing), what this command would
 * do, and what has to exist first. A grey button with no explanation teaches
 * nobody anything, and "coming soon" is not an answer about someone's files.
 */
function refuse(what, detail) {
  dialog("Preview mode", `<p><b>${esc(what)}</b> is not available yet.</p>
    <p>${esc(detail)}</p>
    <p class="why">Atlas has never moved, renamed or deleted a file. This library is a
    <b>plan</b>: each file's row records where it would go, and the folders you are browsing
    are built from those rows. Carrying a plan out needs the journalled apply step - every
    operation written to the <code>ops</code> table before the filesystem is touched, so an
    interrupted run can be finished or reversed. That step is not built yet, so the commands
    that would change your disk refuse instead of pretending.</p>`);
}

async function showProperties() {
  const sel = S.rows.filter((it) => S.selected.has(it.key));
  if (!sel.length) return;
  if (sel.length > 1) {
    const bytes = sel.reduce((n, it) => n + (it.isDir ? 0 : it.size), 0);
    const kinds = new Map();
    for (const it of sel) kinds.set(it.type, (kinds.get(it.type) ?? 0) + 1);
    dialog(`${sel.length} items`, `<dl>
      <dt>Items</dt><dd>${fmtNum(sel.length)} (${fmtNum(sel.filter((i) => i.isDir).length)} folders)</dd>
      <dt>Size</dt><dd>${fmtBytes(bytes)}</dd>
      <dt>Types</dt><dd>${[...kinds].map(([k, n]) => `${esc(k)} × ${n}`).join("<br>")}</dd>
      <dt>Location</dt><dd dir="auto">${esc(S.path || "Library")}</dd></dl>`);
    return;
  }
  const it = sel[0];
  if (it.isDir) {
    dialog(it.name, `<dl><dt>Type</dt><dd>File folder (library)</dd>
      <dt>Location</dt><dd dir="auto">${esc(S.path || "Library")}</dd>
      <dt>Contains</dt><dd>${fmtNum(it.count)} files, ${fmtBytes(it.size)}</dd></dl>
      <p class="why">Library folders are derived from the plan, not from disk. Nothing has been created.</p>`);
    return;
  }
  const d = await api(`/api/files/${it.id}`);
  const f = d.file;
  const c = d.content || {};
  const meta = c.meta || {};
  const rows = [
    ["Name", f.plan ? f.plan.split("/").pop() : it.name],
    ["Type", it.type],
    ["Size", `${fmtBytes(f.size)} (${fmtNum(f.size)} bytes)`],
    ["Planned location", f.plan ? f.plan.split("/").slice(0, -1).join(" / ") : ""],
    ["Filing rule", f.rule ?? ""],
    ["On disk", `${f.rootPath}\\${String(f.path).replace(/\//g, "\\")}`],
    ["Date modified", fmtDate(f.mtime)],
    ["Date created", fmtDate(f.ctime)],
    ["Document date", c.ddate ? `${fmtDate(c.ddate)} (${esc(c.dsrc ?? "")})` : ""],
    ["Category", c.dtype ? DTYPE_LABEL[c.dtype] ?? c.dtype : ""],
    ["Title", c.title ?? ""],
    ["Language", c.lang ? LANG_LABEL[c.lang] ?? c.lang : ""],
    ["Pages", c.pages ?? ""],
    ["Dimensions", c.width ? `${c.width} × ${c.height}` : ""],
    ["Text", c.tlen ? `${fmtNum(c.tlen)} characters` : ""],
    ["OCR", meta.ocr ? `${meta.ocr.engine}, ${fmtNum(meta.ocr.chars)} characters, ${meta.ocr.ms} ms` : ""],
    ["SHA-256", c.sha ? String(c.sha).toLowerCase() : ""],
    ["Copies", d.copies.length ? `${d.copies.length} other copy/copies of the same bytes` : "none"],
  ].filter(([, v]) => v !== "" && v != null);
  dialog(it.name, `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd dir="auto">${esc(String(v))}</dd>`).join("")}</dl>`, { wide: true });
}

/* ---- clipboard-ish actions ------------------------------------------- */

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    flash(`${what} copied`);
  } catch {
    dialog(what, `<p>Copy this:</p><p><code>${esc(text)}</code></p>`);
  }
}

let flashTimer = null;
function flash(msg, actionLabel, action) {
  const bar = root?.querySelector("#exStatus .flash");
  if (!bar) return;
  bar.innerHTML = esc(msg) + (actionLabel ? ` <button type="button" class="undo">${esc(actionLabel)}</button>` : "");
  const btn = bar.querySelector("button");
  if (btn) btn.onclick = () => { bar.innerHTML = ""; action?.(); };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { bar.innerHTML = ""; }, actionLabel ? 12000 : 2500);
}

/* ---- commands -------------------------------------------------------- */

const selectedItems = () => S.rows.filter((it) => S.selected.has(it.key));

function open(it) {
  if (!it) return;
  if (it.isDir) navigate(S.path ? `${S.path}/${it.name}` : it.name);
  else location.hash = `#/file/${it.id}`;
}

const CMD = {
  back: () => history.back(),
  forward: () => history.forward(),
  up: () => navigate(S.path.includes("/") ? S.path.slice(0, S.path.lastIndexOf("/")) : ""),
  refresh: () => load(S.path, true),
  new: () => refuse("New folder", "Atlas would have to create a folder on disk."),
  cut: () => { S.clip = { mode: "cut", items: selectedItems(), from: S.path }; renderStatus(); flash(`Cut ${S.clip.items.length} item(s)`); },
  copy: () => { S.clip = { mode: "copy", items: selectedItems(), from: S.path }; renderStatus(); flash(`Copied ${S.clip.items.length} item(s)`); },
  paste: () => refuse("Paste", `Atlas would have to ${S.clip?.mode === "cut" ? "move" : "copy"} ${S.clip?.items.length ?? 0} file(s) into this folder on disk.`),
  rename: () => refuse("Rename", "Atlas would have to rename the file on disk. Its planned name already follows the filing rules - open Properties to see which rule produced it."),
  delete: () => refuse("Delete", `Atlas would have to delete ${S.selected.size} file(s) from disk. During development no file is ever deleted, including duplicates.`),
  share: async () => {
    const it = selectedItems()[0];
    if (!it) return;
    const url = `${location.origin}/#/file/${it.id}`;
    if (navigator.share) { try { await navigator.share({ title: it.name, url }); return; } catch { /* cancelled: fall through to copying */ } }
    copyText(url, "Link");
  },
  props: () => showProperties(),
  selectAll: () => { S.selected = new Set(S.rows.map((it) => it.key)); applySelection(); updatePreview(); },
  selectNone: () => { S.selected.clear(); applySelection(); updatePreview(); },
  invert: () => { const next = new Set(); for (const it of S.rows) if (!S.selected.has(it.key)) next.add(it.key); S.selected = next; applySelection(); updatePreview(); },
  copyPath: async () => {
    const it = selectedItems()[0];
    if (!it) return;
    if (it.isDir) return copyText(S.path ? `${S.path}/${it.name}` : it.name, "Library path");
    const d = await api(`/api/files/${it.id}`);
    copyText(`${d.file.rootPath}\\${String(d.file.path).replace(/\//g, "\\")}`, "Path");
  },
  download: () => { const it = selectedItems()[0]; if (it && !it.isDir) location.href = `/api/files/${it.id}/content?download`; },
  openOriginal: () => { const it = selectedItems()[0]; if (it && !it.isDir) window.open(`/api/files/${it.id}/content`, "_blank", "noopener"); },
  // The counterpart to dragging: hand the file back to the filing rules.
  resetPlan: async () => {
    const files = selectedItems().filter((it) => !it.isDir);
    if (!files.length) return;
    await post("/api/plan/pin", { items: files.map((f) => ({ id: f.id, pin: null })) });
    flash(`${fmtNum(files.length)} file(s) handed back to the filing rules`);
    await refreshAfterPlanChange();
  },
  undo: () => undoMove(),
  /** Put every display setting back to how Atlas ships: one button, no memory of what you changed. */
  resetView: () => {
    Object.assign(S, {
      view: defaults.view, sortBy: defaults.sortBy, sortDir: defaults.sortDir, groupBy: defaults.groupBy,
      theme: defaults.theme, nav: defaults.nav, tree: defaults.tree, preview: defaults.preview, cols: [...defaults.cols],
    });
    S.filter = "";
    const input = root.querySelector("#exFilter");
    if (input) input.value = "";
    savePrefs();
    applyTheme();
    layout();
    renderItems();
    updatePreview();
    flash("View, sorting and grouping reset to default");
  },
  findNext: () => goToMatch(S.matchPos + 1),
  findPrev: () => goToMatch(S.matchPos - 1),
};

function setView(v) { S.view = v; savePrefs(); renderItems(); }
function setSort(by) {
  if (S.sortBy === by) S.sortDir = S.sortDir === "asc" ? "desc" : "asc";
  else { S.sortBy = by; S.sortDir = ["mtime", "ctime", "ddate", "size"].includes(by) ? "desc" : "asc"; }
  savePrefs();
  renderItems();
}
function setGroup(by) { S.groupBy = by; savePrefs(); renderItems(); }
function setTheme(t) { S.theme = t; savePrefs(); applyTheme(); }
function applyTheme() {
  if (S.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", S.theme);
}

/* ---- menu contents --------------------------------------------------- */

const viewMenu = () => [
  ...VIEWS.map(([id, label]) => ({ id, label, checked: S.view === id, run: () => setView(id) })),
  "-",
  { id: "reset-view", label: "Reset to default", icon: "refresh", run: CMD.resetView },
];
const sortMenu = () => [
  ...SORTS.map(([id, label]) => ({ id, label, checked: S.sortBy === id, run: () => setSort(id) })),
  "-",
  { id: "asc", label: "Ascending", checked: S.sortDir === "asc", run: () => { S.sortDir = "asc"; savePrefs(); renderItems(); } },
  { id: "desc", label: "Descending", checked: S.sortDir === "desc", run: () => { S.sortDir = "desc"; savePrefs(); renderItems(); } },
  "-",
  { id: "reset-view", label: "Reset to default", icon: "refresh", run: CMD.resetView },
];
const groupMenu = () => [
  ...GROUPS.map(([id, label]) => ({ id, label, checked: S.groupBy === id, run: () => setGroup(id) })),
  "-",
  { id: "reset-view", label: "Reset to default", icon: "refresh", run: CMD.resetView },
];
const selectMenu = () => [
  { id: "all", label: "Select all", key: "Ctrl+A", run: CMD.selectAll },
  { id: "none", label: "Select none", key: "Esc", run: CMD.selectNone },
  { id: "invert", label: "Invert selection", run: CMD.invert },
];
const columnsMenu = () => Object.entries(COLUMNS).map(([id, c]) => ({
  id, label: c.label, checked: S.cols.includes(id),
  disabled: id === "name",
  run: () => {
    S.cols = S.cols.includes(id) ? S.cols.filter((x) => x !== id) : [...S.cols, id];
    if (!S.cols.includes("name")) S.cols.unshift("name");
    savePrefs();
    renderItems();
  },
}));
const optionsMenu = () => [
  { head: "Appearance" },
  { id: "sys", label: "Match Windows", checked: S.theme === "system", run: () => setTheme("system") },
  { id: "light", label: "Light", checked: S.theme === "light", run: () => setTheme("light") },
  { id: "dark", label: "Dark", checked: S.theme === "dark", run: () => setTheme("dark") },
  "-",
  { head: "Panes" },
  { id: "tree", label: "Navigation pane", checked: S.tree, run: () => { S.tree = !S.tree; savePrefs(); layout(); } },
  { id: "prev", label: "Preview pane", checked: S.preview, run: () => { S.preview = !S.preview; savePrefs(); layout(); updatePreview(); } },
  "-",
  { head: "Details columns" },
  ...columnsMenu(),
  "-",
  { id: "reset-view", label: "Reset to default", icon: "refresh", run: CMD.resetView },
];

function itemMenu(it) {
  const many = S.selected.size > 1;
  return [
    { id: "open", label: it.isDir ? "Open" : "Open file", icon: "open", key: "Enter", disabled: many, run: () => open(it) },
    { id: "orig", label: "Open the original", icon: "eye", disabled: many || it.isDir, run: CMD.openOriginal },
    { id: "preview", label: "Preview pane", icon: "eye", checked: S.preview, run: () => { S.preview = !S.preview; savePrefs(); layout(); updatePreview(); } },
    "-",
    { id: "cut", label: "Cut", icon: "cut", key: "Ctrl+X", run: CMD.cut },
    { id: "copy", label: "Copy", icon: "copy", key: "Ctrl+C", run: CMD.copy },
    { id: "paste", label: "Paste", icon: "paste", key: "Ctrl+V", disabled: !S.clip, run: CMD.paste },
    "-",
    { id: "link", label: "Copy link", icon: "link", disabled: many || it.isDir, run: CMD.share },
    { id: "path", label: "Copy path on disk", icon: "link", disabled: many, run: CMD.copyPath },
    { id: "download", label: "Download a copy", icon: "download", disabled: many || it.isDir, run: CMD.download },
    "-",
    { id: "reset", label: "Let the rules decide where this goes", icon: "refresh", disabled: it.isDir, run: CMD.resetPlan },
    { id: "rename", label: "Rename", icon: "rename", key: "F2", disabled: many, run: CMD.rename },
    { id: "delete", label: "Delete", icon: "trash", key: "Del", run: CMD.delete },
    "-",
    { id: "props", label: "Properties", icon: "info", key: "Alt+Enter", run: CMD.props },
  ];
}

const emptyMenu = () => [
  { head: "View" },
  ...viewMenu(),
  "-",
  { head: "Sort by" },
  ...sortMenu(),
  "-",
  { head: "Group by" },
  ...groupMenu(),
  "-",
  { id: "refresh", label: "Refresh", icon: "refresh", key: "F5", run: CMD.refresh },
  { id: "paste", label: "Paste", icon: "paste", key: "Ctrl+V", disabled: !S.clip, run: CMD.paste },
  { id: "new", label: "New folder", icon: "add", key: "Ctrl+Shift+N", run: CMD.new },
  "-",
  { id: "all", label: "Select all", key: "Ctrl+A", run: CMD.selectAll },
];

/* ---- selection ------------------------------------------------------- */

function selectOnly(index) {
  const it = S.rows[index];
  S.selected = new Set(it ? [it.key] : []);
  S.anchor = index;
  S.cursor = index;
}

function selectRange(to) {
  const from = S.anchor ?? to;
  const [a, b] = from <= to ? [from, to] : [to, from];
  S.selected = new Set(S.rows.slice(a, b + 1).map((it) => it.key));
  S.cursor = to;
}

function toggleAt(index) {
  const it = S.rows[index];
  if (!it) return;
  if (S.selected.has(it.key)) S.selected.delete(it.key);
  else S.selected.add(it.key);
  S.anchor = index;
  S.cursor = index;
}

function moveCursor(next, e) {
  if (!S.rows.length) return;
  const i = Math.max(0, Math.min(S.rows.length - 1, next));
  if (e?.shiftKey) selectRange(i);
  else selectOnly(i);
  applySelection();
  root.querySelector(`.ex-item[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
}

/** The item visually below/above `index`, which is what arrows mean in a grid. */
function verticalNeighbour(index, dir) {
  const box = root.querySelector("#exItems");
  const cur = box.querySelector(`.ex-item[data-index="${index}"]`);
  if (!cur) return index + dir;
  const all = [...box.querySelectorAll(".ex-item")];
  const top = cur.offsetTop;
  const left = cur.offsetLeft;
  // The nearest row in that direction...
  let row = null;
  for (const el of all) {
    const t = el.offsetTop;
    if (dir > 0 ? t <= top : t >= top) continue;
    if (row === null || (dir > 0 ? t < row : t > row)) row = t;
  }
  if (row === null) return index;
  // ...then the item on it closest to the column we were in.
  let best = index;
  let bestD = Infinity;
  for (const el of all) {
    if (el.offsetTop !== row) continue;
    const d = Math.abs(el.offsetLeft - left);
    if (d < bestD) { bestD = d; best = Number(el.dataset.index); }
  }
  return best;
}

/* ---- preview pane ---------------------------------------------------- */

async function updatePreview() {
  if (!S.preview || !root) return;
  const box = root.querySelector("#exPreview");
  const sel = selectedItems();
  const seq = ++previewSeq;
  if (sel.length !== 1) { box.innerHTML = `<p class="ex-empty">${sel.length ? `${sel.length} items selected` : "Select a file to preview it."}</p>`; return; }
  const it = sel[0];
  if (it.isDir) { box.innerHTML = `<h3>${esc(it.name)}</h3><p>${fmtNum(it.count)} files · ${fmtBytes(it.size)}</p>`; return; }
  box.innerHTML = `<h3 dir="auto">${esc(it.name)}</h3><p class="ex-empty">Loading…</p>`;
  const d = await api(`/api/files/${it.id}`);
  if (seq !== previewSeq) return;
  const c = d.content || {};
  const src = `/api/files/${it.id}/content`;
  const media = c.kind === "image" ? `<img alt="" src="${src}">`
    : c.kind === "pdf" ? `<iframe title="preview" src="${src}"></iframe>` : "";
  const text = (d.ocrText || d.text || "").slice(0, 1200);
  box.innerHTML = `<h3 dir="auto">${esc(it.name)}</h3>${media}
    <dl>
      <dt>Type</dt><dd>${esc(it.type)}</dd>
      <dt>Size</dt><dd>${fmtBytes(it.size)}</dd>
      ${c.dtype ? `<dt>Category</dt><dd>${esc(DTYPE_LABEL[c.dtype] ?? c.dtype)}</dd>` : ""}
      ${c.lang ? `<dt>Language</dt><dd>${esc(LANG_LABEL[c.lang] ?? c.lang)}</dd>` : ""}
      <dt>Rule</dt><dd>${esc(d.file.rule ?? "")}</dd>
    </dl>
    ${text ? `<div class="snip" dir="auto">${esc(text)}</div>` : ""}`;
}

/* ---- layout ---------------------------------------------------------- */

function layout() {
  const body = root.querySelector("#exBody");
  body.classList.toggle("with-preview", S.preview);
  body.style.setProperty("--nav", S.tree ? `${S.nav}px` : "0px");
  root.querySelector("#exTree").hidden = !S.tree;
  root.querySelector("#exGrip").hidden = !S.tree;
  root.querySelector("#exPreview").hidden = !S.preview;
  root.querySelector("#exPreviewGrip").hidden = !S.preview;
  const bar = document.querySelector("#bar");
  root.style.setProperty("--ex-top", `${bar && !bar.hidden ? bar.offsetHeight : 0}px`);
}

/* ---- navigation and loading ------------------------------------------ */

function navigate(path) { location.hash = `#/lib/${encodeURIComponent(path)}`; }

function crumbHtml(path) {
  const parts = path ? path.split("/") : [];
  let acc = "";
  const links = [`<a href="#/lib/" data-crumb="">Library</a>`];
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    links.push(`<span class="chev">${ico("chev")}</span><a href="#/lib/${encodeURIComponent(acc)}" dir="auto">${esc(p)}</a>`);
  }
  return links.join("");
}

/** The match counter lives in the address bar but is decided by the rows. */
function updateFind() {
  const nav = root?.querySelector("#exFind");
  if (!nav || nav.hidden) return;
  nav.querySelector(".pos").textContent = S.matches.length ? `${S.matchPos + 1} / ${S.matches.length}` : "0 / 0";
  for (const b of nav.querySelectorAll("button")) b.disabled = !S.matches.length;
}

function renderAddress() {
  const box = root.querySelector("#exCrumbs");
  const nav = root.querySelector("#exFind");
  if (S.mode === "search") {
    box.innerHTML = `<span class="chev">${ico("filter")}</span><a href="#/lib/" data-crumb="">Library</a>
      <span class="chev">${ico("chev")}</span><span class="term" dir="auto">Results for “${esc(S.query)}”</span>
      <span class="count">${fmtNum(S.items.length)} in ${S.ms} ms</span>`;
    nav.hidden = false;
    updateFind();
  } else {
    box.innerHTML = crumbHtml(S.path);
    nav.hidden = true;
  }
}

async function load(path, force = false) {
  if (S.mode === "folder" && S.listing && S.path === path && !force) return;
  S.mode = "folder";
  S.query = "";
  S.matches = [];
  S.path = path;
  const d = await api(`/api/library?path=${encodeURIComponent(path)}`);
  S.listing = d;
  S.items = toItems(d);
  S.selected.clear();
  S.cursor = 0;
  S.anchor = null;
  S.filter = "";
  const input = root.querySelector("#exFilter");
  if (input) input.value = "";
  renderAddress();
  renderItems();
  updatePreview();
  revealInTree(path).catch(() => {});
}

/**
 * Two different questions, answered separately.
 *
 *   which files are RELEVANT?       the engine decided; that is the result list
 *   which ones literally SAY this?  marked yellow, and walkable with next/prev
 *
 * Marking is done over the rows already on screen, without re-filtering, so the
 * results that matched inside a document are still there when the literal
 * filename matches run out.
 */
function findMatches() {
  S.matches = [];
  if (S.mode !== "search" || !S.query) return;
  S.rows.forEach((it, i) => {
    // The snippet counts too: searching in Arabic finds files whose names are
    // all Latin, and a walker that only knew about names would sit at 0 of 0
    // on exactly the searches that needed it most.
    if (hasMatch(it.name, S.query) || hasMatch(it.folder ?? "", S.query) || hasMatch(it.snippet ?? "", S.query)) S.matches.push(i);
  });
  if (S.matchPos >= S.matches.length) S.matchPos = 0;
}

function goToMatch(pos) {
  if (!S.matches.length) return;
  // Wrap both ways, like every find bar: running off the end returns you to the
  // top rather than stopping dead.
  S.matchPos = ((pos % S.matches.length) + S.matches.length) % S.matches.length;
  const index = S.matches[S.matchPos];
  selectOnly(index);
  applySelection();
  updateFind();
  root.querySelector(`.ex-item[data-index="${index}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  updatePreview();
}

async function loadSearch(q) {
  S.mode = "search";
  S.query = q;
  S.listing = null;
  S.selected.clear();
  S.cursor = 0;
  S.anchor = null;
  S.matchPos = 0;
  const d = await api(`/api/search?limit=200&q=${encodeURIComponent(q)}`);
  S.items = hitsToItems(d.hits);
  S.ms = d.ms;
  renderAddress();
  renderItems();
  updatePreview();
}

/* ---- the shell ------------------------------------------------------- */

function shell() {
  const el = document.createElement("div");
  el.className = "ex";
  el.innerHTML = `
  <div class="ex-cmd">
    <button class="ex-btn" data-cmd="new" type="button">${ico("add")}<span>New</span></button>
    <span class="ex-sep"></span>
    <button class="ex-btn" data-cmd="cut" type="button" title="Cut (Ctrl+X)">${ico("cut")}</button>
    <button class="ex-btn" data-cmd="copy" type="button" title="Copy (Ctrl+C)">${ico("copy")}</button>
    <button class="ex-btn" data-cmd="paste" type="button" title="Paste (Ctrl+V)">${ico("paste")}</button>
    <button class="ex-btn" data-cmd="rename" type="button" title="Rename (F2)">${ico("rename")}</button>
    <button class="ex-btn" data-cmd="share" type="button" title="Share">${ico("share")}</button>
    <button class="ex-btn" data-cmd="delete" type="button" title="Delete">${ico("trash")}</button>
    <span class="ex-sep"></span>
    <button class="ex-btn" data-cmd="sort" type="button" aria-expanded="false">${ico("sort")}<span>Sort</span>${ico("caret", "caret")}</button>
    <button class="ex-btn" data-cmd="view" type="button" aria-expanded="false">${ico("view")}<span>View</span>${ico("caret", "caret")}</button>
    <button class="ex-btn" data-cmd="group" type="button" aria-expanded="false">${ico("group")}<span>Group</span>${ico("caret", "caret")}</button>
    <button class="ex-btn" data-cmd="select" type="button" aria-expanded="false">${ico("select")}<span>Select</span>${ico("caret", "caret")}</button>
    <span class="ex-spring"></span>
    <button class="ex-btn" data-cmd="props" type="button" title="Properties (Alt+Enter)">${ico("info")}</button>
    <button class="ex-btn" data-cmd="options" type="button" aria-expanded="false" title="Options">${ico("more")}</button>
  </div>
  <div class="ex-addr">
    <div class="ex-nav">
      <button class="ex-btn" data-cmd="back" type="button" title="Back (Alt+Left)">${ico("back")}</button>
      <button class="ex-btn" data-cmd="forward" type="button" title="Forward (Alt+Right)">${ico("forward")}</button>
      <button class="ex-btn" data-cmd="up" type="button" title="Up (Backspace)">${ico("up")}</button>
      <button class="ex-btn" data-cmd="refresh" type="button" title="Refresh (F5)">${ico("refresh")}</button>
    </div>
    <div class="ex-crumbs" id="exCrumbs"></div>
    <div class="ex-find" id="exFind" hidden>
      <button class="ex-btn" type="button" data-find="prev" title="Previous match (Shift+Enter)">${ico("back")}</button>
      <span class="pos">0 / 0</span>
      <button class="ex-btn" type="button" data-find="next" title="Next match (Enter)">${ico("forward")}</button>
    </div>
    <label class="ex-filter">${ico("filter")}<input id="exFilter" type="search" placeholder="Filter this folder" autocomplete="off" dir="auto"></label>
  </div>
  <div class="ex-body" id="exBody">
    <div class="ex-tree" id="exTree" role="tree"></div>
    <div class="ex-grip" id="exGrip"></div>
    <div class="ex-items v-details" id="exItems" tabindex="0"></div>
    <div class="ex-grip" id="exPreviewGrip" hidden></div>
    <div class="ex-preview" id="exPreview" hidden></div>
  </div>
  <div class="ex-status" id="exStatus">
    <span class="info"></span><span class="flash"></span><span class="grow"></span>
    <span class="views">
      <button type="button" data-view="details" title="Details" aria-pressed="false">${ico("sort")}</button>
      <button type="button" data-view="large" title="Large icons" aria-pressed="false">${ico("view")}</button>
    </span>
  </div>`;
  return el;
}

/* ---- events ---------------------------------------------------------- */

function wire() {
  const items = root.querySelector("#exItems");

  root.querySelector(".ex-cmd").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cmd]");
    if (!b || b.disabled) return;
    const id = b.dataset.cmd;
    if (id === "sort") return menuFromButton(b, sortMenu());
    if (id === "view") return menuFromButton(b, viewMenu());
    if (id === "group") return menuFromButton(b, groupMenu());
    if (id === "select") return menuFromButton(b, selectMenu());
    if (id === "options") return menuFromButton(b, optionsMenu());
    CMD[id]?.();
  });

  root.querySelector(".ex-nav").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cmd]");
    if (b) CMD[b.dataset.cmd]?.();
  });

  root.querySelector("#exFilter").addEventListener("input", (e) => {
    S.filter = e.target.value;
    S.selected.clear();
    renderItems();
  });

  // Tree: the twisty expands, the row navigates. Two targets, one row.
  root.querySelector("#exTree").addEventListener("click", (e) => {
    const tw = e.target.closest("[data-twist]");
    if (tw) { e.stopPropagation(); toggleNode(tw.dataset.twist); return; }
    const node = e.target.closest(".ex-node");
    if (node) navigate(node.dataset.path);
  });

  // Items: click selects, double-click opens. Ctrl adds, Shift extends.
  items.addEventListener("mousedown", (e) => {
    if (e.button === 2) return; // context menu handles its own selection
    const el = e.target.closest(".ex-item");
    items.focus({ preventScroll: true });
    if (!el) return; // empty space: the marquee handler deals with it
    const index = Number(el.dataset.index);
    if (e.ctrlKey || e.metaKey) toggleAt(index);
    else if (e.shiftKey) selectRange(index);
    else if (!S.selected.has(el.dataset.key)) selectOnly(index);
    else { S.cursor = index; }
    applySelection();
    updatePreview();
  });

  items.addEventListener("dblclick", (e) => {
    const el = e.target.closest(".ex-item");
    if (!el) return;
    // More than one picked changes what the marked rows MEAN: that is a batch,
    // and opening twenty tabs is never what the second click was asking for.
    if (S.selected.size > 1) { flash(`${fmtNum(S.selected.size)} files selected - opening one at a time`); return; }
    open(S.rows[Number(el.dataset.index)]);
  });

  items.addEventListener("click", (e) => {
    // Touch and pen have no double-click, so there a single tap opens.
    if (!matchMedia("(pointer: coarse)").matches) return;
    const el = e.target.closest(".ex-item");
    if (el) open(S.rows[Number(el.dataset.index)]);
  });

  items.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (marquee.consumeDrag()) return;
    const el = e.target.closest(".ex-item");
    if (el) {
      const index = Number(el.dataset.index);
      if (!S.selected.has(el.dataset.key)) { selectOnly(index); applySelection(); updatePreview(); }
      openMenu(itemMenu(S.rows[index]), e.clientX, e.clientY);
    } else {
      openMenu(emptyMenu(), e.clientX, e.clientY);
    }
  });

  // Details header: click to sort, right-click to choose columns.
  items.addEventListener("click", (e) => {
    const h = e.target.closest("#exHead button[data-col]");
    if (h) setSort(h.dataset.col);
  });
  items.addEventListener("contextmenu", (e) => {
    const h = e.target.closest("#exHead");
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(columnsMenu(), e.clientX, e.clientY);
  }, true);

  items.addEventListener("keydown", onKey);
  root.querySelector("#exStatus").addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (b) setView(b.dataset.view);
  });

  root.querySelector("#exFind").addEventListener("click", (e) => {
    const b = e.target.closest("[data-find]");
    if (b) (b.dataset.find === "next" ? CMD.findNext : CMD.findPrev)();
  });

  grip(root.querySelector("#exGrip"), (dx) => { S.nav = Math.max(140, Math.min(480, S.nav + dx)); savePrefs(); layout(); });
  marquee.attach(items);
  wireDrag();

  document.addEventListener("mousedown", (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
  window.addEventListener("resize", () => { closeMenu(); layout(); });
}

function grip(el, onMove) {
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    let x = e.clientX;
    const move = (ev) => { onMove(ev.clientX - x); x = ev.clientX; };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

/* ---- rubber band selection ------------------------------------------- */

const marquee = {
  box: null, start: null, dragged: false, justDragged: false, container: null,
  attach(container) {
    this.container = container;
    container.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest(".ex-item") || e.target.closest("#exHead")) return;
      const r = container.getBoundingClientRect();
      if (e.clientX - r.left > container.clientWidth) return; // the scrollbar itself

      this.start = { x: e.clientX - r.left + container.scrollLeft, y: e.clientY - r.top + container.scrollTop };
      this.dragged = false;
      const additive = e.ctrlKey || e.metaKey;
      const base = additive ? new Set(S.selected) : new Set();
      const move = (ev) => {
        const x = ev.clientX - r.left + container.scrollLeft;
        const y = ev.clientY - r.top + container.scrollTop;
        if (!this.dragged && Math.abs(x - this.start.x) + Math.abs(y - this.start.y) < 5) return;
        this.dragged = true;
        if (!this.box) {
          this.box = document.createElement("div");
          this.box.className = "ex-marquee";
          container.appendChild(this.box);
        }
        const left = Math.min(x, this.start.x);
        const top = Math.min(y, this.start.y);
        const w = Math.abs(x - this.start.x);
        const h = Math.abs(y - this.start.y);
        this.box.style.left = `${left}px`;
        this.box.style.top = `${top}px`;
        this.box.style.width = `${w}px`;
        this.box.style.height = `${h}px`;
        const next = new Set(base);
        for (const el of container.querySelectorAll(".ex-item")) {
          const hit = el.offsetLeft < left + w && el.offsetLeft + el.offsetWidth > left
            && el.offsetTop < top + h && el.offsetTop + el.offsetHeight > top;
          if (hit) next.add(el.dataset.key);
        }
        S.selected = next;
        for (const el of container.querySelectorAll(".ex-item")) {
          if (S.selected.has(el.dataset.key)) el.setAttribute("aria-selected", "true");
          else el.removeAttribute("aria-selected");
        }
        renderStatus();
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        this.box?.remove();
        this.box = null;
        if (!this.dragged && !additive) { S.selected.clear(); applySelection(); }
        this.justDragged = this.dragged;
        updatePreview();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  },
  // A right-drag that just finished is a selection, not a request for the menu.
  consumeDrag() { const d = this.justDragged; this.justDragged = false; return d; },
};

/* ---- drag and drop --------------------------------------------------- */

/**
 * Dropping files on a folder MOVES them in the library, which means it changes
 * where they are planned to go - `files.pin` - and nothing on disk. That is why
 * this gesture works while Cut/Paste refuses: one edits a plan, the other would
 * edit your disk.
 */
async function moveTo(items, folder) {
  const ids = items.filter((it) => !it.isDir).map((it) => it.id);
  if (!ids.length || !folder) return;
  const r = await post("/api/plan/move", { ids, folder });
  // Remember the previous pins so this is undoable: a move nobody can take back
  // is a move nobody should make by accident with a mouse.
  lastMove = { items: r.before ?? [], folder };
  flash(`Moved ${fmtNum(r.moved)} file(s) to ${folder}`, "Undo", undoMove);
  await refreshAfterPlanChange();
}

let lastMove = null;
async function undoMove() {
  if (!lastMove) return;
  const items = lastMove.items.map((b) => ({ id: b.id, pin: b.pin }));
  await post("/api/plan/pin", { items });
  lastMove = null;
  flash("Move undone");
  await refreshAfterPlanChange();
}

/**
 * Planning is asynchronous: give the engine a moment, then reload what is on
 * screen. Only OPEN tree nodes are re-fetched - their counts are the ones a move
 * changed and the ones you can see. Collapsed branches reload when opened.
 */
async function refreshAfterPlanChange() {
  await new Promise((r) => setTimeout(r, 350));
  if (S.mode === "search") await loadSearch(S.query);
  else await load(S.path, true);
  const open = [...S.nodes.entries()].filter(([, n]) => n.open).map(([p]) => p);
  for (const p of open) S.nodes.get(p).loaded = false;
  await Promise.all(open.map((p) => loadNode(p).catch(() => {})));
  renderTree();
}

const dragState = { items: [] };

function dragPayload(e) {
  const chosen = selectedItems();
  const el = e.target.closest(".ex-item");
  const it = el ? S.rows[Number(el.dataset.index)] : null;
  // Dragging something that was not selected drags THAT, the way every file
  // manager does, instead of silently carrying the old selection.
  const items = it && !S.selected.has(it.key) ? [it] : chosen;
  return items.slice(0, MAX_DRAGGED);
}

const isOurDrag = (e) => [...(e.dataTransfer?.types || [])].includes(DRAG_MIME);

function dropFolderFor(el) {
  if (el.dataset.path !== undefined) return el.dataset.path;            // a tree node
  const it = S.rows[Number(el.dataset.index)];
  if (it?.isDir) return S.path ? `${S.path}/${it.name}` : it.name;      // a folder row
  return null;
}

function wireDrag() {
  const items = root.querySelector("#exItems");

  items.addEventListener("dragstart", (e) => {
    const el = e.target.closest(".ex-item");
    if (!el) return;
    const picked = dragPayload(e);
    const files = picked.filter((it) => !it.isDir);
    if (!files.length) { e.preventDefault(); return; }  // folders are not movable: they are derived
    dragState.items = files;
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(files.map((f) => ({ id: f.id, name: f.name }))));
    e.dataTransfer.effectAllowed = "move";
    root.classList.add("dragging");
  });
  items.addEventListener("dragend", () => {
    root.classList.remove("dragging");
    for (const el of root.querySelectorAll(".drop")) el.classList.remove("drop");
  });

  const over = (e) => {
    if (!isOurDrag(e)) return;
    const el = e.target.closest("[data-path], .ex-item[data-folder]");
    for (const d of root.querySelectorAll(".drop")) if (d !== el) d.classList.remove("drop");
    if (!el) return;
    const folder = dropFolderFor(el);
    if (folder == null) return;
    e.preventDefault();                       // only a preventDefault makes it a drop target
    e.dataTransfer.dropEffect = "move";
    el.classList.add("drop");
  };
  const drop = async (e) => {
    if (!isOurDrag(e)) return;
    const el = e.target.closest("[data-path], .ex-item[data-folder]");
    if (!el) return;
    const folder = dropFolderFor(el);
    if (folder == null) return;
    e.preventDefault();
    el.classList.remove("drop");
    root.classList.remove("dragging");
    // Prefer the payload, so a drag begun before a re-render still moves the
    // right files; fall back to what dragstart recorded.
    let files = dragState.items;
    try {
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) files = parsed.filter((f) => Number.isInteger(f?.id));
      }
    } catch { /* malformed: a drop handler that throws leaves the page stuck mid-drag */ }
    try { await moveTo(files, folder); } catch (err) { flash(err.message); }
  };

  for (const zone of [items, root.querySelector("#exTree")]) {
    zone.addEventListener("dragover", over);
    zone.addEventListener("dragleave", (e) => e.target.closest?.(".drop")?.classList.remove("drop"));
    zone.addEventListener("drop", drop);
  }
}

/* ---- keyboard -------------------------------------------------------- */

function onKey(e) {
  const grid = ["xl", "large", "medium", "small", "list"].includes(S.view);
  if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); return CMD.back(); }
  if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); return CMD.forward(); }
  if (e.altKey && e.key === "Enter") { e.preventDefault(); return CMD.props(); }
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === "a") { e.preventDefault(); return CMD.selectAll(); }
    if (k === "c") { e.preventDefault(); return CMD.copy(); }
    if (k === "x") { e.preventDefault(); return CMD.cut(); }
    if (k === "v") { e.preventDefault(); return CMD.paste(); }
    if (k === "n" && e.shiftKey) { e.preventDefault(); return CMD.new(); }
    if (k === "z") { e.preventDefault(); return CMD.undo(); }
    return;
  }
  switch (e.key) {
    case "ArrowDown": e.preventDefault(); return moveCursor(grid ? verticalNeighbour(S.cursor, 1) : S.cursor + 1, e);
    case "ArrowUp": e.preventDefault(); return moveCursor(grid ? verticalNeighbour(S.cursor, -1) : S.cursor - 1, e);
    case "ArrowRight": if (!grid) return; e.preventDefault(); return moveCursor(S.cursor + 1, e);
    case "ArrowLeft": if (!grid) return; e.preventDefault(); return moveCursor(S.cursor - 1, e);
    case "Home": e.preventDefault(); return moveCursor(0, e);
    case "End": e.preventDefault(); return moveCursor(S.rows.length - 1, e);
    case "PageDown": e.preventDefault(); return moveCursor(S.cursor + 12, e);
    case "PageUp": e.preventDefault(); return moveCursor(S.cursor - 12, e);
    case "Enter": e.preventDefault(); return open(S.rows[S.cursor]);
    case "Backspace": e.preventDefault(); return CMD.up();
    case "Escape": e.preventDefault(); return CMD.selectNone();
    case "F2": e.preventDefault(); return CMD.rename();
    case "F3": e.preventDefault(); return e.shiftKey ? CMD.findPrev() : CMD.findNext();
    case "F5": e.preventDefault(); return CMD.refresh();
    case "Delete": e.preventDefault(); return CMD.delete();
    case " ": e.preventDefault(); toggleAt(S.cursor); applySelection(); return updatePreview();
    default: break;
  }
  // Type-ahead: the fastest way to reach a file in a folder of two thousand.
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
    const now = Date.now();
    S.typed = now - S.typedAt > 800 ? e.key : S.typed + e.key;
    S.typedAt = now;
    const q = S.typed.toLowerCase();
    const from = S.typed.length === 1 ? S.cursor + 1 : S.cursor;
    for (let n = 0; n < S.rows.length; n++) {
      const i = (from + n) % S.rows.length;
      if (S.rows[i].name.toLowerCase().startsWith(q)) { moveCursor(i); break; }
    }
  }
}

/* ---- entry point ----------------------------------------------------- */

export async function showExplorer(path, container) {
  const fresh = !root;
  if (fresh) {
    root = shell();
    container.replaceChildren(root);
    wire();
    applyTheme();
  } else if (!root.isConnected) {
    // Coming back from another route: re-attach the SAME element, so the tree
    // stays expanded and the scroll position survives.
    container.replaceChildren(root);
  }
  layout();
  if (fresh) {
    renderTree();
    await loadNode("").then((n) => { n.open = true; renderTree(); }).catch(() => {});
  }
  if (path === null) return;                 // mounted for a search; the caller loads it
  await load(path);
  root.querySelector("#exItems").focus({ preventScroll: true });
}

export async function showSearchResults(q, container) {
  await showExplorer(null, container);
  await loadSearch(q);
  root.querySelector("#exItems").focus({ preventScroll: true });
}

/** Walk the literal matches from outside (the header's search box). */
export function explorerFind(dir) { goToMatch(S.matchPos + dir); }

export function explorerActive() { return !!root && root.isConnected; }
