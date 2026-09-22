// The status page: cards you can arrange, change and add to.
//
// WHAT V1 TAUGHT, KEPT
//
// - Headline totals are NUMBERS, not charts. A number is the clearest way to show
//   one number.
// - Every figure is an aggregate, true at any size. V1's first dashboard counted a
//   paged list and reported "200 files" on a 9,398-file library.
// - Poll fast only while something is happening, and let finished work linger so
//   a fast file does not flash past unseen.
// - Charts use one hue for magnitude; state colours never carry meaning alone.
//
// WHAT IS NEW
//
// A card is DATA - { type, spec } - not code. So the page is yours to arrange:
// drag cards by holding the left button, turn the "by type" card through file
// kinds, change what a breakdown splits by, add and remove cards. And a card can
// be described in a sentence: that costs ONE assistant request to turn into a
// spec, and nothing ever again, because the spec is answered by the local
// database on every refresh. The free Gemini tier is for asking, not for keeping
// numbers up to date.
import { thumbUrl } from "./explorer.js";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtNum = (n) => Math.round(n ?? 0).toLocaleString();
const fmtBytes = (n) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < 4) { v /= 1024; i++; }
  return `${v.toFixed(i && v < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtDur = (s) => {
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s < 60) return `${Math.ceil(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
};
const base = (p) => String(p ?? "").split(/[\\/]/).pop();

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET", credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (res.status === 401) { location.hash = "#/login"; throw new Error("sign in required"); }
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

/* ---- vocabulary ------------------------------------------------------- */

// The "by type" card turns through these. Kind is what the analyzer decided the
// bytes are; the label is what a person calls it.
const TYPES = [
  { kind: "pdf", label: "PDF" }, { kind: "doc", label: "Word" }, { kind: "sheet", label: "Excel" },
  { kind: "slides", label: "PowerPoint" }, { kind: "image", label: "Images" }, { kind: "video", label: "Video" },
  { kind: "audio", label: "Audio" }, { kind: "text", label: "Text" }, { kind: "archive", label: "Archives" },
];
const KIND_LABEL = Object.fromEntries(TYPES.map((t) => [t.kind, t.label]));
const DTYPE = {
  invoice: "Invoices", receipt: "Receipts", contract: "Contracts", statement: "Bank statements", payslip: "Payslips",
  letter: "Letters", cv: "CVs", certificate: "Certificates", report: "Reports", minutes: "Minutes", medical: "Medical",
  tax: "Tax", identity: "Identity", registration: "Registration forms", quote: "Quotes", order: "Orders", insurance: "Insurance",
  unclassified: "Not classified",
};
const LANG = { en: "English", ar: "العربية", fr: "Français", unknown: "Unknown" };
const BY_LABEL = { kind: "File kind", ext: "Extension", dtype: "Document type", lang: "Language", year: "Year", month: "Month", folder: "Top folder", rule: "Filing rule", state: "Pipeline state" };
const keyLabel = (by, k) => (by === "kind" ? KIND_LABEL[k] ?? k : by === "dtype" ? DTYPE[k] ?? k : by === "lang" ? LANG[k] ?? k : by === "ext" ? `.${k}` : k);
const PALETTE = ["#2563eb", "#0f766e", "#7c3aed", "#b45309", "#be123c", "#0369a1"];

/* ---- the cards -------------------------------------------------------- */

const CARDS = {
  files: { title: "Files", span: 1 },
  waiting: { title: "Waiting", span: 1 },
  photos: { title: "Photos", span: 1 },
  duplicates: { title: "Duplicates resolved", span: 1 },
  failed: { title: "Could not read", span: 1 },
  pipeline: { title: "Pipeline, live", span: 2 },
  bytype: { title: "By type", span: 1 },
  breakdown: { title: "Breakdown", span: 1 },
  folders: { title: "Folders", span: 2 },
};

const DEFAULT_LAYOUT = [
  { id: "files", type: "files" },
  { id: "waiting", type: "waiting" },
  { id: "photos", type: "photos" },
  { id: "dups", type: "duplicates" },
  { id: "failed", type: "failed" },
  { id: "pipe", type: "pipeline", span: 2 },
  { id: "bytype", type: "bytype", spec: { kind: "pdf" } },
  { id: "doctypes", type: "breakdown", spec: { title: "Documents by type", by: "dtype", metric: "count", chart: "bars" } },
  { id: "years", type: "breakdown", spec: { title: "Library by year", by: "year", metric: "count", chart: "columns" } },
  { id: "folders", type: "folders", span: 2 },
];

/**
 * A card's size, in grid cells: w columns by h rows. Bigger is not just bigger -
 * each card has more to say at more room (see render), so resizing a card is how
 * you ask it for more detail.
 */
const sizeOf = (c) => ({ w: c.w ?? c.span ?? CARDS[c.type].span, h: c.h ?? 1 });
const MAX_W = 3;
const MAX_H = 2;
let gridCols = 3;

/** Spans are set from JS so a 3-wide card on a 2-column screen takes 2, not 3. */
function applySize(el, c) {
  const { w, h } = sizeOf(c);
  el.style.gridColumn = `span ${Math.min(w, gridCols)}`;
  el.style.gridRow = `span ${h}`;
  el.dataset.w = String(w);
  el.dataset.h = String(h);
}

function measureCols() {
  const grid = D.root?.querySelector(".dash-grid");
  if (!grid) return;
  gridCols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length);
}

const STORE = "atlas.dashboard";
function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "null");
    if (Array.isArray(saved) && saved.every((c) => c && CARDS[c.type])) return saved;
  } catch { /* a private window, or a layout from an older build: start fresh */ }
  return structuredClone(DEFAULT_LAYOUT);
}
function saveLayout() {
  try { localStorage.setItem(STORE, JSON.stringify(D.layout)); } catch { /* not persisting is fine */ }
}

const D = {
  layout: loadLayout(),
  dash: null, act: null,
  stats: new Map(),            // card id -> { key, at, data }
  timers: [], mounted: false, root: null,
};

/* ---- smooth numbers --------------------------------------------------- */

/**
 * A number that glides to its new value instead of jumping. 450 ms, ease-out,
 * on requestAnimationFrame - so it stops the moment the tab is hidden.
 */
function tween(el, to, fmt = fmtNum) {
  if (!el) return;
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = String(to);
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 450);
    const e = 1 - (1 - k) ** 3;
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1 && el.dataset.v === String(to)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const setBar = (el, v) => el?.style.setProperty("--v", String(Math.max(0, Math.min(1, v || 0))));

/**
 * Is anything actually happening? Decided from what the workers are doing, not
 * from the engine's busy flag - which deliberately stays up for a minute after
 * the last file, and would show "Working" over six idle readers.
 */
const working = (a) => Boolean(a && (a.scan?.scanning != null || a.workers.some((w) => w.file) || a.ocr.length));

function stateLine(a) {
  if (!a) return "";
  if (a.scan?.scanning != null) return "Scanning folders…";
  const readers = a.workers.filter((w) => w.file).length;
  if (readers || a.ocr.length) {
    const parts = [];
    if (readers) parts.push(`${readers} of ${a.workers.length} readers busy`);
    if (a.ocr.length) parts.push(`${a.ocr.length} reading text`);
    return `Working — ${parts.join(", ")}`;
  }
  if (a.waiting || a.ocrPending) return `${fmtNum(a.waiting + a.ocrPending)} queued`;
  return "Idle — everything processed";
}

/* ---- rendering each card ---------------------------------------------- */

const MENU_ICON = '<svg viewBox="0 0 20 20"><circle cx="4" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="16" cy="10" r="1.6"/></svg>';

function shell(c) {
  const def = CARDS[c.type];
  const el = document.createElement("section");
  el.className = "card enter";
  el.dataset.id = c.id;
  el.innerHTML = `<div class="card-top"><span class="t">${esc(c.spec?.title ?? def.title)}</span><span class="grow"></span>
    <button type="button" class="card-menu" data-menu="${esc(c.id)}" title="Card options">${MENU_ICON}</button></div>
    <div class="card-body"></div>
    <span class="resize" data-resize title="Drag to resize"></span>`;
  // The entrance plays once. Left in place, it would replay every time another
  // animation on the card ended - after every drag, every card would rise again.
  el.addEventListener("animationend", (e) => { if (e.animationName === "card-in") el.classList.remove("enter"); }, { once: false });
  applySize(el, c);
  return el;
}

function body(id) { return D.root?.querySelector(`.card[data-id="${CSS.escape(id)}"] .card-body`); }

/** Build a card's inner structure once; later updates only change numbers and bars. */
function ensure(el, html) {
  if (el.dataset.built !== html.length.toString() || !el.firstChild) {
    el.innerHTML = html;
    el.dataset.built = html.length.toString();
  }
}

const render = {
  files(c) {
    const b = body(c.id); const d = D.dash; if (!b || !d) return;
    const { w, h } = sizeOf(c);
    ensure(b, `<div class="big" data-n></div><div class="sub" data-s></div><div class="fine" data-f></div><div class="more" data-more></div>`);
    tween(b.querySelector("[data-n]"), d.placed);
    b.querySelector("[data-s]").textContent = `in the library · ${fmtBytes(d.placedBytes)}`;
    b.querySelector("[data-f]").textContent = `${fmtNum(d.files)} seen on disk, ${fmtNum(d.unique)} unique by content`;
    // Given room, it says what the library is made of.
    const more = b.querySelector("[data-more]");
    const rows = w * h > 1 ? d.byKind.slice(0, h > 1 ? 9 : 4) : [];
    more.hidden = !rows.length;
    if (rows.length) {
      const max = Math.max(1, ...rows.map((r) => r.n));
      keyed(more, "rows", rows.map((r) => ({ ...r, key: r.kind })),
        (r) => `<div class="brow" data-k="${esc(r.key)}"><span class="k">${esc(KIND_LABEL[r.key] ?? r.key)}</span><div class="track thin"><i></i></div><span class="v"></span></div>`,
        (el, r) => { el.querySelector("i").style.setProperty("--v", String(r.n / max)); el.querySelector(".v").textContent = fmtNum(r.n); });
    }
  },
  waiting(c) {
    const b = body(c.id); const d = D.dash; if (!b || !d) return;
    ensure(b, `<div class="big" data-n></div><div class="sub" data-s></div><div class="fine" data-f></div>`);
    const n = d.waiting + d.ocr.pending;
    const big = b.querySelector("[data-n]");
    tween(big, n);
    big.className = `big ${n ? "warn" : "good"}`;
    b.querySelector("[data-s]").textContent = n ? `${fmtNum(d.waiting)} to read · ${fmtNum(d.ocr.pending)} for OCR` : "Nothing waiting — all caught up";
    b.querySelector("[data-f]").textContent = D.act?.rate?.files > 0.05 ? `about ${fmtDur(n / D.act.rate.files)} at the current pace` : "";
  },
  photos(c) {
    const b = body(c.id); const d = D.dash; if (!b || !d) return;
    ensure(b, `<div class="big" data-n></div><div class="sub" data-s></div><div class="track thin gap-top"><i></i></div><div class="fine" data-f></div>`);
    tween(b.querySelector("[data-n]"), d.photos);
    b.querySelector("[data-s]").textContent = fmtBytes(d.photoBytes);
    const read = d.ocr.read;
    const all = d.ocr.read + d.ocr.pending + d.ocr.failed;
    setBar(b.querySelector(".track i"), all ? read / all : 0);
    b.querySelector("[data-f]").textContent = all ? `${Math.round((read / all) * 100)}% of scans and photos read by OCR` : "";
    // Given room, the newest pictures - as thumbnails, so this costs kilobytes.
    const { w, h } = sizeOf(c);
    let strip = b.querySelector(".strip");
    const want = w * h > 1 ? Math.min(12, w * (h > 1 ? 6 : 3)) : 0;
    if (!want) { strip?.remove(); return; }
    if (!strip) { strip = document.createElement("div"); strip.className = "strip"; b.appendChild(strip); }
    if (strip.dataset.n === String(want) && strip.dataset.at && Date.now() - Number(strip.dataset.at) < 30000) return;
    strip.dataset.n = String(want);
    strip.dataset.at = String(Date.now());
    api(`/api/photos?limit=${want}`).then((r) => {
      strip.innerHTML = r.files.map((f) => `<a href="#/photos" title="${esc(f.name)}"><img loading="lazy" alt="" src="${thumbUrl(f.id, 72)}"></a>`).join("");
    }).catch(() => {});
  },
  duplicates(c) {
    const b = body(c.id); const d = D.dash; if (!b || !d) return;
    ensure(b, `<div class="big" data-n></div><div class="sub" data-s></div><div class="fine" data-f></div>`);
    tween(b.querySelector("[data-n]"), d.duplicates.copies);
    b.querySelector("[data-s]").textContent = `${fmtBytes(d.duplicates.bytes)} would be freed · ${fmtNum(d.duplicates.groups)} groups`;
    // Said on the card itself, because "resolved" must never be read as "deleted".
    b.querySelector("[data-f]").textContent = "Each group keeps one copy in the library. Nothing has been deleted.";
    const { w, h } = sizeOf(c);
    listMore(b, w * h > 1 && d.duplicates.groups ? `/api/duplicates?limit=${h > 1 ? 10 : 4}` : null,
      (g) => `<div class="it"><span class="p" dir="auto" title="${esc(g.name)}">${esc(g.name)}</span><span class="m">${fmtNum(g.copies)} extra · ${fmtBytes(g.wasted)}</span></div>`);
  },
  failed(c) {
    const b = body(c.id); const d = D.dash; if (!b || !d) return;
    ensure(b, `<div class="big" data-n></div><div class="sub" data-s></div><div class="fine" data-f></div>
      <div class="card-actions" data-actions hidden><button type="button" class="act" data-retry>Try again now</button></div>`);
    const big = b.querySelector("[data-n]");
    tween(big, d.failed);
    big.className = `big ${d.failed ? "bad" : "good"}`;
    b.querySelector("[data-s]").textContent = d.failed ? "files could not be read" : "every file was readable";
    // Failures are kept, not retried on every scan: say which wait for what.
    const aside = d.failed - (d.failedAccess ?? 0);
    b.querySelector("[data-f]").textContent = [
      aside ? `${fmtNum(aside)} set aside until they change` : "",
      d.failedAccess ? `${fmtNum(d.failedAccess)} tried again later` : "",
      d.ocr.failed ? `${fmtNum(d.ocr.failed)} OCR failures` : "",
      d.ocr.deferred ? `${fmtNum(d.ocr.deferred)} OCR readings waiting to try again` : "",
      d.missing ? `${fmtNum(d.missing)} missing from disk` : "",
      d.suspect ? `${fmtNum(d.suspect)} not seen in the last scan (checking again)` : "",
      d.unresolved ? `${fmtNum(d.unresolved)} choice(s) for moved files could not be placed for sure` : "",
    ].filter(Boolean).join(" · ");
    b.querySelector("[data-actions]").hidden = !(d.failed || d.ocr.failed || d.ocr.deferred);
    const { w, h } = sizeOf(c);
    const when = (f) => (f.fnext ? ` · again in ${fmtDur(Math.max(60, (f.fnext - Date.now()) / 1000))}` : "");
    listMore(b, w * h > 1 && d.failed ? `/api/failed?limit=${h > 1 ? 12 : 4}` : null,
      (f) => `<div class="it"><span class="p" dir="auto" title="${esc(f.root)} › ${esc(f.path)}">${esc(base(f.path))}</span><span class="m">${esc((f.err ?? "unreadable") + when(f))}</span></div>`);
  },
  pipeline(c) {
    const b = body(c.id); const a = D.act; if (!b || !a) return;
    ensure(b, `
      <div class="pipe-state"><b data-state></b><span class="grow"></span><span class="pct" data-pct></span></div>
      <div class="track big-bar"><i data-bar></i></div>
      <div class="pipe-meta"><span><b data-done></b> of <b data-total></b> files</span><span data-rate></span><span data-eta></span><span data-ocr></span></div>
      <div class="lanes-head">Readers</div><div class="lanes" data-lanes></div>
      <div class="lanes-head" data-ocrhead>OCR</div><div class="lanes" data-ocrlanes></div>
      <div class="lanes-head">Just finished</div><div class="recent" data-recent></div>`);
    const done = Math.max(0, a.total - a.waiting);
    const frac = a.total ? done / a.total : 1;
    b.querySelector("[data-state]").textContent = stateLine(a);
    tween(b.querySelector("[data-pct]"), frac * 100, (v) => `${Math.floor(v)}%`);
    const bar = b.querySelector("[data-bar]");
    setBar(bar, frac);
    bar.classList.toggle("shine", working(a));
    tween(b.querySelector("[data-done]"), done);
    tween(b.querySelector("[data-total]"), a.total);
    b.querySelector("[data-rate]").textContent = a.rate.files > 0.05 ? `${a.rate.files.toFixed(a.rate.files < 10 ? 1 : 0)} files/s · ${fmtBytes(a.rate.bytes)}/s` : "";
    b.querySelector("[data-eta]").textContent = working(a) && a.rate.files > 0.05 && a.waiting ? `about ${fmtDur(a.waiting / a.rate.files)} left` : "";
    b.querySelector("[data-ocr]").textContent = a.ocrPending ? `${fmtNum(a.ocrPending)} waiting for OCR` : "";
    lanes(b.querySelector("[data-lanes]"), a.workers.map((w) => ({
      who: `Reader ${w.worker}`, file: w.file, since: w.since,
      what: w.file ? { reading: "reading", analyzing: "analyzing", linking: "linking copy" }[w.stage] ?? w.stage : "idle",
    })), a.now);
    b.querySelector("[data-ocrhead]").hidden = !a.ocrSlots;
    const ocrRows = Array.from({ length: a.ocrSlots }, (_, i) => a.ocr[i]
      ? { who: `OCR ${i + 1}`, file: a.ocr[i].file, since: a.ocr[i].since, what: "reading text" }
      : { who: `OCR ${i + 1}`, file: null, since: 0, what: "idle" });
    lanes(b.querySelector("[data-ocrlanes]"), ocrRows, a.now);
    const rec = b.querySelector("[data-recent]");
    const sig = a.recent.map((r) => r.at).join(",");
    if (rec.dataset.sig !== sig) {
      rec.dataset.sig = sig;
      const label = { new: "new", copy: "copy", ocr: "OCR", failed: "failed" };
      rec.innerHTML = a.recent.length
        ? a.recent.map((r) => `<div><span class="chip ${r.outcome}">${label[r.outcome]}</span><span title="${esc(r.file)}">${esc(base(r.file))}</span></div>`).join("")
        : `<div><span>Nothing in the last minute.</span></div>`;
    }
  },
  bytype(c) {
    const b = body(c.id); const d = D.dash; if (!b || !d) return;
    const kind = c.spec?.kind ?? "pdf";
    const t = TYPES.find((x) => x.kind === kind) ?? TYPES[0];
    const row = d.byKind.find((r) => r.kind === kind) ?? { n: 0, bytes: 0 };
    const all = d.byKind.reduce((s, r) => s + r.n, 0) || 1;
    const html = `<div class="types">${TYPES.map((x) => `<button type="button" data-kind="${x.kind}" class="${x.kind === kind ? "on" : ""}">${esc(x.label)}</button>`).join("")}</div>
      <div class="type-body" data-for="${kind}">
        <div class="flipper"><button type="button" data-step="-1" title="Previous type">‹</button>
          <div class="grow"><div class="big" data-n></div><div class="sub" data-s></div></div>
          <button type="button" data-step="1" title="Next type">›</button></div>
        <div class="track thin gap-top"><i data-share></i></div>
        <div class="fine" data-f></div>
      </div>`;
    if (b.dataset.kind !== kind) { b.innerHTML = html; b.dataset.kind = kind; b.dataset.built = ""; }
    tween(b.querySelector("[data-n]"), row.n);
    b.querySelector("[data-s]").textContent = `${t.label} files · ${fmtBytes(row.bytes)}`;
    setBar(b.querySelector("[data-share]"), row.n / all);
    b.querySelector("[data-f]").textContent = `${((row.n / all) * 100).toFixed(1)}% of the library`;
    const { w, h } = sizeOf(c);
    let yrs = b.querySelector(".years");
    if (w * h < 2) { yrs?.remove(); return; }
    if (!yrs) { yrs = document.createElement("div"); yrs.className = "years gap-top"; b.querySelector(".type-body").appendChild(yrs); }
    if (yrs.dataset.kind === kind && Date.now() - Number(yrs.dataset.at || 0) < 30000) return;
    yrs.dataset.kind = kind;
    yrs.dataset.at = String(Date.now());
    api(`/api/stats?by=year&kind=${encodeURIComponent(kind)}&limit=12`).then((st) => {
      const max = Math.max(1, ...st.rows.map((r) => r.n));
      keyed(yrs, "cols", st.rows, (r) => `<div class="c" data-k="${esc(r.key)}" title="${esc(r.key)}: ${fmtNum(r.n)}"><b></b><span>${esc(String(r.key).slice(-2))}</span></div>`,
        (el, r) => el.querySelector("b").style.setProperty("--v", String(r.n / max)));
    }).catch(() => {});
  },
  breakdown(c) {
    const b = body(c.id); const s = D.stats.get(c.id)?.data; if (!b || !s) return;
    const spec = c.spec ?? {};
    const rows = s.rows;
    const val = (r) => (s.metric === "bytes" ? r.bytes : r.n);
    const fmt = (v) => (s.metric === "bytes" ? fmtBytes(v) : fmtNum(v));
    const max = Math.max(1, ...rows.map(val));
    const total = Math.max(1, s.metric === "bytes" ? s.total.bytes : s.total.n);
    if (!rows.length) { b.innerHTML = `<div class="fine">Nothing to show yet.</div>`; return; }
    if (spec.chart === "columns") {
      keyed(b, "cols", rows, (r) => `<div class="c" data-k="${esc(r.key)}" title="${esc(keyLabel(s.by, r.key))}: ${esc(fmt(val(r)))}"><b></b><span>${esc(String(r.key).slice(-5))}</span></div>`,
        (el, r) => el.querySelector("b").style.setProperty("--v", String(val(r) / max)));
    } else if (spec.chart === "donut") {
      const top = rows.slice(0, 5);
      const C = 2 * Math.PI * 42;
      let acc = 0;
      b.innerHTML = `<div class="donut"><svg viewBox="0 0 100 100">${top.map((r, i) => {
        const len = (val(r) / total) * C;
        const seg = `<circle cx="50" cy="50" r="42" stroke="${PALETTE[i % PALETTE.length]}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-acc}"></circle>`;
        acc += len;
        return seg;
      }).join("")}</svg><div class="legend">${top.map((r, i) => `<span><i data-c="${i % PALETTE.length}"></i>${esc(keyLabel(s.by, r.key))} · ${esc(fmt(val(r)))}</span>`).join("")}</div></div>`;
      // Legend swatches coloured through CSSOM: the page's CSP forbids style="" in markup.
      for (const i of b.querySelectorAll(".legend i")) i.style.background = PALETTE[Number(i.dataset.c)];
    } else if (spec.chart === "list") {
      b.innerHTML = `<div class="list">${rows.map((r) => `<div class="it"><span class="p" dir="auto">${esc(keyLabel(s.by, r.key))}</span><span class="m">${esc(fmt(val(r)))}</span></div>`).join("")}</div>`;
    } else {
      keyed(b, "rows", rows, (r) => `<div class="brow" data-k="${esc(r.key)}"><span class="k" dir="auto" title="${esc(keyLabel(s.by, r.key))}">${esc(keyLabel(s.by, r.key))}</span><div class="track thin"><i></i></div><span class="v"></span></div>`,
        (el, r) => { el.querySelector("i").style.setProperty("--v", String(val(r) / max)); el.querySelector(".v").textContent = fmt(val(r)); });
    }
  },
  folders(c) {
    const b = body(c.id); const d = D.dash; if (!b || !d) return;
    b.innerHTML = d.roots.length
      ? `<div class="list">${d.roots.map((r) => `<div class="it"><span class="p" dir="auto" title="${esc(r.path)}">${esc(r.path)}</span>
          <span class="m">${esc(r.role)} · ${r.online ? '<span class="ok">online</span>' : '<span class="bad">offline</span>'}${r.scan_at ? ` · ${fmtNum(r.scan_files)} files, scanned in ${(r.scan_ms / 1000).toFixed(1)} s` : " · not scanned yet"}${r.scan_error ? ` · <span class="bad">${esc(r.scan_error)}</span>` : ""}</span></div>`).join("")}</div>`
      : `<div class="fine">No folders yet. Add one under <a href="#/roots">Folders</a>.</div>`;
  },
};

/**
 * Rows keyed by their label, created once and then only updated - so a bar that
 * grows is the SAME element growing, which is what makes it glide instead of
 * being redrawn at its new length.
 */
function keyed(host, cls, rows, make, update) {
  let box = host.querySelector(`.${cls}`);
  if (!box) { host.innerHTML = `<div class="${cls}"></div>`; box = host.firstChild; }
  const want = new Set(rows.map((r) => String(r.key)));
  for (const el of [...box.children]) if (!want.has(el.dataset.k)) el.remove();
  let prev = null;
  for (const r of rows) {
    let el = box.querySelector(`[data-k="${CSS.escape(String(r.key))}"]`);
    if (!el) {
      const tmp = document.createElement("div");
      tmp.innerHTML = make(r);
      el = tmp.firstElementChild;
    }
    if (prev ? prev.nextSibling !== el : box.firstChild !== el) box.insertBefore(el, prev ? prev.nextSibling : box.firstChild);
    // Let the new element lay out at 0 first, so it grows into place.
    requestAnimationFrame(() => update(el, r));
    prev = el;
  }
}

/** A list that appears below a card's figures when the card is given room for it. */
function listMore(b, url, row) {
  let box = b.querySelector(".more-list");
  if (!url) { box?.remove(); return; }
  if (!box) { box = document.createElement("div"); box.className = "list more-list gap-top"; b.appendChild(box); }
  if (box.dataset.url === url && Date.now() - Number(box.dataset.at || 0) < 20000) return;
  box.dataset.url = url;
  box.dataset.at = String(Date.now());
  api(url).then((rows) => { box.innerHTML = rows.map(row).join("") || `<div class="fine">Nothing to list.</div>`; }).catch(() => {});
}

/** One lane per worker, updated in place: a worker is a place, and places do not reshuffle. */
function lanes(box, rows, now) {
  while (box.children.length < rows.length) {
    const d = document.createElement("div");
    d.className = "lane";
    d.innerHTML = `<span class="who"></span><span class="what"></span><span class="file"><span class="nm"></span></span><span class="ms"></span>`;
    box.appendChild(d);
  }
  while (box.children.length > rows.length) box.lastChild.remove();
  rows.forEach((r, i) => {
    const el = box.children[i];
    el.classList.toggle("idle", !r.file);
    el.querySelector(".who").textContent = r.who;
    el.querySelector(".what").textContent = r.what;
    const nm = el.querySelector(".nm");
    nm.textContent = r.file ? base(r.file) : "—";
    nm.title = r.file ?? "";
    el.querySelector(".ms").textContent = r.file ? `${((now - r.since) / 1000).toFixed(1)} s` : "";
  });
}

/* ---- data ------------------------------------------------------------- */

function statsKey(c) {
  const spec = c.spec ?? {};
  const { w, h } = sizeOf(c);
  const p = new URLSearchParams();
  for (const k of ["by", "metric", "kind", "ext", "dtype", "lang", "folder"]) if (spec[k]) p.set(k, spec[k]);
  // More room, more rows: a small card shows the top few, a large one the long tail.
  const rows = spec.chart === "columns" ? 8 * w : [6, 10, 22][Math.min(2, w * h - 1)] ?? 22;
  p.set("limit", String(Math.min(60, rows)));
  return p.toString();
}

async function refreshStats(force = false) {
  const now = Date.now();
  await Promise.all(D.layout.filter((c) => c.type === "breakdown").map(async (c) => {
    const key = statsKey(c);
    const have = D.stats.get(c.id);
    if (!force && have && have.key === key && now - have.at < (D.act?.busy ? 15000 : 60000)) return;
    try {
      const data = await api(`/api/stats?${key}`);
      D.stats.set(c.id, { key, at: now, data });
      render.breakdown(c);
    } catch { /* one card failing must not blank the page */ }
  }));
}

async function refreshDash() {
  try { D.dash = await api("/api/dashboard"); } catch { return; }
  for (const c of D.layout) if (c.type !== "pipeline" && c.type !== "breakdown") render[c.type]?.(c);
  paintLive();
  paintSafety();
}

/**
 * The database itself: checked at startup, backed up daily. One quiet line while
 * all is well; a banner that cannot be missed when the check fails - Atlas has
 * stopped changing the database, and the way back is a restore.
 */
function paintSafety() {
  const s = D.dash?.safety;
  const line = D.root?.querySelector("[data-safety]");
  const alarm = D.root?.querySelector("[data-alarm]");
  if (!line || !alarm) return;
  if (!s) { line.textContent = ""; alarm.hidden = true; return; }
  const b = s.backup;
  const backup = b.running ? "backing up now"
    : b.error ? `last backup failed: ${b.error}`
    : b.at ? `backed up ${fmtDur(Math.max(60, (Date.now() - b.at) / 1000))} ago (${fmtBytes(b.bytes)}, ${b.count} kept)`
    : "first backup in a few minutes";
  line.textContent = s.integrity === "checking" ? "Checking the database…"
    : s.integrity === "ok" ? `Database checked · ${backup}` : "Database damaged";
  line.className = `safety ${s.integrity === "failed" ? "bad" : b.error ? "warn" : ""}`;
  line.title = b.dir ? `Backups: ${b.dir}` : "";
  alarm.hidden = s.integrity !== "failed";
  if (s.integrity === "failed") {
    alarm.innerHTML = `<b>The database failed its integrity check.</b> Atlas has stopped changing it, and no file on disk is
      affected. To recover: stop Atlas, run <code>npm run db -- restore</code>, and follow what it prints.
      <span class="fine">${esc(s.detail.join(" · "))}</span>`;
  }
}

function paintLive() {
  const live = D.root?.querySelector(".live");
  if (!live) return;
  const on = working(D.act);
  live.classList.toggle("on", on);
  live.querySelector("span").textContent = on ? "Working" : D.act && (D.act.waiting || D.act.ocrPending) ? "Queued" : "Idle";
}

async function refreshActivity() {
  try { D.act = await api("/api/activity"); } catch { return; }
  for (const c of D.layout) if (c.type === "pipeline") render.pipeline(c);
  for (const c of D.layout) if (c.type === "waiting") render.waiting(c);
  paintLive();
}

/**
 * Fast while something is happening, slow when it is not, nothing when the tab
 * is hidden. Activity reads memory and costs nothing; the headline numbers are
 * GROUP BYs, so they follow at half the pace.
 */
function schedule() {
  for (const t of D.timers) clearTimeout(t);
  D.timers = [];
  if (!D.mounted) return;
  const busy = D.act?.busy ?? D.dash?.busy;
  const loop = (fn, fast, slow) => {
    const run = async () => {
      if (!D.mounted) return;
      if (!document.hidden) await fn();
      D.timers.push(setTimeout(run, working(D.act) || D.act?.waiting ? fast : slow));
    };
    D.timers.push(setTimeout(run, (busy ? fast : slow)));
  };
  loop(refreshActivity, 1000, 4000);
  loop(refreshDash, 2000, 10000);
  loop(() => refreshStats(), 15000, 60000);
}

/* ---- layout: drawing, dragging, editing ------------------------------- */

function drawGrid() {
  const grid = D.root.querySelector(".dash-grid");
  measureCols();
  grid.replaceChildren(...D.layout.map(shell), addCard());
  for (const c of D.layout) {
    if (c.type === "breakdown") render.breakdown(c);
    else if (c.type === "pipeline") render.pipeline(c);
    else render[c.type]?.(c);
  }
}

/**
 * FLIP: record where every card is, change the layout, then play each card from
 * where it WAS to where it IS - on a spring, so they settle the way icons settle
 * on a phone. Only `transform` moves, so it stays at 60 fps.
 */
function flip(except, mutate) {
  const cards = [...D.root.querySelectorAll(".card:not(.add)")].filter((c) => c !== except);
  const first = new Map(cards.map((c) => [c, c.getBoundingClientRect()]));
  mutate();
  for (const c of cards) {
    const a = first.get(c);
    const b = c.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (!dx && !dy) continue;
    c.classList.remove("spring");
    c.style.transition = "none";
    c.style.transform = `translate(${dx}px, ${dy}px)`;
    c.getBoundingClientRect();                 // commit the inverted position
    c.style.transition = "";
    c.classList.add("spring");
    c.style.transform = "";
    clearTimeout(c._springEnd);
    c._springEnd = setTimeout(() => c.classList.remove("spring"), 560);
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Re-draw one card after its size changed, so it shows more (or less). */
function rerender(c) {
  const b = body(c.id);
  if (b) { b.innerHTML = ""; b.dataset.built = ""; b.dataset.kind = ""; }
  if (c.type === "breakdown") refreshStats(true);
  else if (c.type === "pipeline") render.pipeline(c);
  else render[c.type]?.(c);
}

function setSize(c, w, h) {
  const el = D.root.querySelector(`.card[data-id="${CSS.escape(c.id)}"]`);
  const now = sizeOf(c);
  if (!el || (now.w === w && now.h === h)) return;
  flip(null, () => { c.w = w; c.h = h; delete c.span; applySize(el, c); });
  rerender(c);
}

function wireDrag() {
  const grid = D.root.querySelector(".dash-grid");
  let drag = null;

  /**
   * Lift, the way an app icon lifts on a phone: it grows a little, turns to
   * glass you can see the other cards through, and everything else starts to
   * shiver to say "you are rearranging now". It follows the pointer exactly -
   * no easing on the follow, because easing there is what makes a drag feel
   * like wading - and the others spring out of its way.
   */
  const lift = (e) => {
    const { card } = drag;
    drag.live = true;
    clearTimeout(drag.hold);
    try { card.setPointerCapture(drag.pointer); } catch { /* the pointer already left */ }
    card.classList.add("lifting");
    grid.classList.add("editing");
    follow(e);
  };

  const follow = (e) => {
    const { card } = drag;
    // Where the card would be with no offset, and the offset that keeps it under the pointer.
    card.style.transform = "none";
    const r = card.getBoundingClientRect();
    card.style.transform = `translate(${e.clientX - drag.ox - r.left}px, ${e.clientY - drag.oy - r.top}px)`;
  };

  grid.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const card = e.target.closest(".card:not(.add)");
    if (!card) return;
    if (e.target.closest("[data-resize]")) { startResize(e, card); return; }
    if (e.target.closest("button, input, select, a, form")) return;
    const r = card.getBoundingClientRect();
    drag = { card, sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, live: false, pointer: e.pointerId, last: e };
    // Hold still for a moment and it lifts in place, like a long-press on a phone.
    drag.hold = setTimeout(() => { if (drag && !drag.live) lift(drag.last); }, 320);
  });

  grid.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag.last = e;
    if (!drag.live) {
      // A few pixels of intent before lifting, so a click stays a click.
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
      lift(e);
    }
    follow(e);
    aim(e);
  });

  /**
   * Which card the dragged one should take the place of - decided calmly.
   *
   * WHY IT USED TO SHAKE
   *
   * It hit-tested cards where they were DRAWN. After a swap, the other card
   * springs away from under the pointer, but for half a second it is still drawn
   * there - so the next pointer move found it again, swapped it back, and the two
   * traded places as fast as the mouse moved. Cards of different sizes made it
   * worse: one swap reflows the grid and slides a third card under the pointer.
   *
   * WHAT STOPS IT
   *
   *   where it WILL be   cards are hit-tested at their layout slot (offsetLeft/
   *                      offsetTop ignore transforms), never mid-animation
   *   firm borders       only the middle 60% of a card counts as "over it"
   *   dwell              the pointer rests on a card for a beat before anything
   *                      moves, the way a phone waits before icons shift
   *   settle             after a swap, nothing else moves for a moment, and the
   *                      card just swapped with is ignored until you leave it
   */
  const DWELL_MS = 130;
  const SETTLE_MS = 220;
  const ZONE = 0.2; // the outer 20% on each side is border, not target

  function slotAt(card, x, y) {
    const g = grid.getBoundingClientRect();
    for (const el of grid.querySelectorAll(".card:not(.add)")) {
      if (el === card) continue;
      const left = g.left + el.offsetLeft;
      const top = g.top + el.offsetTop;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (x > left + w * ZONE && x < left + w * (1 - ZONE) && y > top + h * ZONE && y < top + h * (1 - ZONE)) return el;
    }
    return null;
  }

  function aim(e) {
    if (!drag?.live) return;
    const target = slotAt(drag.card, e.clientX, e.clientY);
    // Leaving the card we just traded with makes it a valid target again.
    if (drag.ignore && target !== drag.ignore) drag.ignore = null;
    if (!target || target === drag.ignore) { clearTimeout(drag.dwell); drag.aimed = null; return; }
    if (target === drag.aimed) return;              // already waiting on this one
    drag.aimed = target;
    clearTimeout(drag.dwell);
    const wait = Math.max(DWELL_MS, (drag.settleUntil ?? 0) - performance.now());
    drag.dwell = setTimeout(() => swapInto(target), wait);
  }

  function swapInto(target) {
    if (!drag?.live || drag.aimed !== target) return;
    const { card } = drag;
    const cards = [...grid.querySelectorAll(".card:not(.add)")];
    const from = cards.indexOf(card);
    const to = cards.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    flip(card, () => { grid.insertBefore(card, from < to ? target.nextSibling : target); });
    drag.ignore = target;
    drag.aimed = null;
    drag.settleUntil = performance.now() + SETTLE_MS;
    follow(drag.last);
  }

  const end = (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const { card, live } = drag;
    clearTimeout(drag.hold);
    clearTimeout(drag.dwell);
    drag = null;
    if (!live) return;
    // Let go: spring from where it was dropped into its slot, and settle.
    grid.classList.remove("editing");
    card.classList.remove("lifting");
    card.classList.add("settling");
    requestAnimationFrame(() => { card.style.transform = ""; });
    setTimeout(() => card.classList.remove("settling"), 520);
    const order = [...grid.querySelectorAll(".card:not(.add)")].map((c) => c.dataset.id);
    D.layout.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    saveLayout();
  };
  grid.addEventListener("pointerup", end);
  grid.addEventListener("pointercancel", end);

  /**
   * Resize from the corner grip, snapping to whole grid cells. Every cell the
   * card crosses changes what it shows, live, so you can see what the extra
   * room buys before letting go.
   */
  function startResize(e, card) {
    const c = D.layout.find((x) => x.id === card.dataset.id);
    if (!c) return;
    e.preventDefault();
    const start = sizeOf(c);
    const rect = card.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 16;
    const cols = Math.min(start.w, gridCols);
    const colW = (rect.width - (cols - 1) * gap) / cols;
    const rowH = (rect.height - (start.h - 1) * gap) / start.h;
    try { card.setPointerCapture(e.pointerId); } catch { /* released already: the move listeners still work */ }
    card.classList.add("resizing");
    const move = (ev) => {
      const w = clamp(Math.round((rect.width + ev.clientX - e.clientX + gap) / (colW + gap)), 1, Math.min(MAX_W, gridCols));
      const h = clamp(Math.round((rect.height + ev.clientY - e.clientY + gap) / (rowH + gap)), 1, MAX_H);
      setSize(c, w, h);
    };
    const done = () => {
      card.removeEventListener("pointermove", move);
      card.classList.remove("resizing");
      saveLayout();
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", done, { once: true });
    card.addEventListener("pointercancel", done, { once: true });
  }

  // Inside a card: the type chips, the flipper, the menu.
  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    const c = card && D.layout.find((x) => x.id === card.dataset.id);
    const chip = e.target.closest("[data-kind]");
    if (c && chip) { c.spec = { ...c.spec, kind: chip.dataset.kind }; saveLayout(); render.bytype(c); return; }
    const stepper = e.target.closest("[data-step]");
    if (c && stepper) {
      const i = TYPES.findIndex((t) => t.kind === (c.spec?.kind ?? "pdf"));
      const next = TYPES[(i + Number(stepper.dataset.step) + TYPES.length) % TYPES.length];
      c.spec = { ...c.spec, kind: next.kind };
      saveLayout();
      render.bytype(c);
      return;
    }
    const m = e.target.closest("[data-menu]");
    if (c && m) openCardMenu(c, m);
    const retry = e.target.closest("[data-retry]");
    if (retry) {
      retry.disabled = true;
      retry.textContent = "Trying again…";
      api("/api/retry", {}).then(() => refreshDash()).catch(() => {}).finally(() => {
        retry.disabled = false;
        retry.textContent = "Try again now";
      });
    }
  });
}

let pop = null;
function closePop() { pop?.remove(); pop = null; }

function openCardMenu(c, btn) {
  closePop();
  pop = document.createElement("div");
  pop.className = "card-pop";
  const def = CARDS[c.type];
  const now = sizeOf(c);
  const spec = c.spec ?? {};
  const editor = c.type === "breakdown" ? `
    <label>Split by <select data-f="by">${Object.entries(BY_LABEL).map(([k, v]) => `<option value="${k}"${spec.by === k ? " selected" : ""}>${v}</option>`).join("")}</select></label>
    <label>Measure <select data-f="metric"><option value="count"${spec.metric !== "bytes" ? " selected" : ""}>Number of files</option><option value="bytes"${spec.metric === "bytes" ? " selected" : ""}>Total size</option></select></label>
    <label>Show as <select data-f="chart">${["bars", "columns", "donut", "list"].map((k) => `<option value="${k}"${(spec.chart ?? "bars") === k ? " selected" : ""}>${k[0].toUpperCase() + k.slice(1)}</option>`).join("")}</select></label>
    <label>Only <select data-f="kind"><option value="">All kinds</option>${TYPES.map((t) => `<option value="${t.kind}"${spec.kind === t.kind ? " selected" : ""}>${t.label}</option>`).join("")}</select></label>
    <label>Title <input data-f="title" value="${esc(spec.title ?? "")}"></label><hr>` : "";
  const SIZES = [["1x1", "Small"], ["2x1", "Wide"], ["1x2", "Tall"], ["2x2", "Large"], ["3x1", "Full width"], ["3x2", "Full width, tall"]];
  pop.innerHTML = `${editor}
    <div class="sizes">${SIZES.map(([k, label]) => `<button type="button" data-size="${k}" class="${`${now.w}x${now.h}` === k ? "on" : ""}" title="${label}"><i class="sz-${k}"></i><span>${label}</span></button>`).join("")}</div>
    <div class="fine pad">Bigger cards show more. You can also drag a card's bottom-right corner.</div><hr>
    <button type="button" data-do="remove">Remove this card</button>`;
  D.root.appendChild(pop);
  const r = btn.getBoundingClientRect();
  const w = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.right - w.width, innerWidth - w.width - 8))}px`;
  pop.style.top = `${Math.min(r.bottom + 6, innerHeight - w.height - 8)}px`;
  pop.addEventListener("change", async (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    c.spec = { ...c.spec, [f]: e.target.value || undefined };
    saveLayout();
    D.root.querySelector(`.card[data-id="${CSS.escape(c.id)}"] .t`).textContent = c.spec.title ?? def.title;
    const b = body(c.id);
    if (b) { b.innerHTML = ""; b.dataset.built = ""; }
    if (f !== "title") await refreshStats(true);
  });
  pop.addEventListener("click", (e) => {
    const sz = e.target.closest("[data-size]")?.dataset.size;
    if (sz) {
      const [w, h] = sz.split("x").map(Number);
      closePop();
      setSize(c, w, h);
      saveLayout();
      return;
    }
    const d = e.target.closest("[data-do]")?.dataset.do;
    if (!d) return;
    closePop();
    if (d === "remove") {
      const el = D.root.querySelector(`.card[data-id="${CSS.escape(c.id)}"]`);
      el.style.opacity = "0";
      el.style.transform = "scale(.96)";
      setTimeout(() => {
        flip(el, () => el.remove());
        D.layout = D.layout.filter((x) => x.id !== c.id);
        saveLayout();
        D.root.querySelector(".card.add")?.replaceWith(addCard());
      }, 220);
    }
  });
}

function addCard() {
  const el = document.createElement("section");
  el.className = "card add";
  const missing = Object.keys(CARDS).filter((t) => !["breakdown", "bytype"].includes(t) && !D.layout.some((c) => c.type === t));
  el.innerHTML = `<div class="card-top"><span class="t">Add a card</span></div>
    <div class="presets">
      ${missing.map((t) => `<button type="button" data-add="${t}">${esc(CARDS[t].title)}</button>`).join("")}
      <button type="button" data-add="bytype">By type</button>
      <button type="button" data-add="breakdown" data-spec='{"title":"By extension","by":"ext","metric":"count","chart":"bars"}'>By extension</button>
      <button type="button" data-add="breakdown" data-spec='{"title":"Size by kind","by":"kind","metric":"bytes","chart":"donut"}'>Size by kind</button>
      <button type="button" data-add="breakdown" data-spec='{"title":"By month","by":"month","metric":"count","chart":"columns"}'>By month</button>
      <button type="button" data-add="breakdown" data-spec='{"title":"Languages","by":"lang","metric":"count","chart":"donut"}'>Languages</button>
    </div>
    ${D.ai ? `<form data-ai><input type="text" placeholder="Or describe one: “Arabic invoices by year”" dir="auto"><button class="dash-btn primary" type="submit">Make</button></form>
      <div class="note">Uses one assistant request to design the card. After that it updates itself for free.</div>` : ""}`;
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-add]");
    if (!b) return;
    const type = b.dataset.add;
    const spec = b.dataset.spec ? JSON.parse(b.dataset.spec) : type === "bytype" ? { kind: "pdf" } : undefined;
    addToLayout({ id: `${type}-${Date.now().toString(36)}`, type, spec, w: CARDS[type].span, h: 1 });
  });
  el.querySelector("[data-ai]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const s = await api("/api/ai/card", { request: text });
      addToLayout({ id: `ai-${Date.now().toString(36)}`, type: "breakdown", spec: { title: s.title, by: s.by, metric: s.metric, chart: s.chart, kind: s.kind || undefined, ext: s.ext || undefined, dtype: s.dtype || undefined, lang: s.lang || undefined, folder: s.folder || undefined } });
    } catch (err) {
      e.target.parentElement.querySelector(".note").textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Make";
    }
  });
  return el;
}

async function addToLayout(c) {
  D.layout.push(c);
  saveLayout();
  const grid = D.root.querySelector(".dash-grid");
  const el = shell(c);
  flip(null, () => grid.insertBefore(el, grid.querySelector(".card.add")));
  grid.querySelector(".card.add").replaceWith(addCard());
  if (c.type === "breakdown") await refreshStats(true);
  else if (c.type === "pipeline") render.pipeline(c);
  else render[c.type]?.(c);
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ---- mount ------------------------------------------------------------ */

export async function mountDashboard(view) {
  D.mounted = true;
  const page = document.createElement("div");
  page.className = "dash";
  page.innerHTML = `<div class="dash-head"><h1>Status</h1><span class="live"><i></i><span>…</span></span>
    <span class="safety" data-safety></span><span class="grow"></span>
    <button type="button" class="dash-btn" data-reset>Reset layout</button></div>
    <div class="alarm" data-alarm role="alert" hidden></div>
    <div class="dash-grid"></div>`;
  view.replaceChildren(page);
  D.root = page;
  try { D.ai = (await api("/api/ai")).available; } catch { D.ai = false; }
  await Promise.all([refreshDash(), refreshActivity()]);
  drawGrid();
  await refreshStats(true);
  wireDrag();
  page.querySelector("[data-reset]").addEventListener("click", () => {
    D.layout = structuredClone(DEFAULT_LAYOUT);
    D.stats.clear();
    saveLayout();
    drawGrid();
    refreshStats(true);
  });
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("resize", onResize);
  schedule();
}

/** A narrower window has fewer columns: a 3-wide card takes what there is. */
let resizeFrame = 0;
function onResize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    const before = gridCols;
    measureCols();
    if (gridCols === before) return;
    for (const c of D.layout) {
      const el = D.root?.querySelector(`.card[data-id="${CSS.escape(c.id)}"]`);
      if (el) applySize(el, c);
    }
  });
}

function onOutside(e) { if (pop && !pop.contains(e.target) && !e.target.closest("[data-menu]")) closePop(); }
function onVisible() { if (!document.hidden && D.mounted) { refreshActivity(); refreshDash(); } }

export function unmountDashboard() {
  if (!D.mounted) return;
  D.mounted = false;
  for (const t of D.timers) clearTimeout(t);
  D.timers = [];
  closePop();
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("resize", onResize);
  D.root = null;
}
