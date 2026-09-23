// Atlas UI. No framework, no build step. The engine owns all state; this page
// only reads it and sends a few commands, so closing it changes nothing.
//
// This file is the shell: routing, search, and the pages that are not the
// library - one file's details, Folders, the frame Status is drawn in, signing
// in. Browsing the library itself is explorer.js, which is a file manager, and
// every page here is framed the way it is (see page()).
import { showExplorer, showSearchResults, showPhotos, explorerFind, currentScope, ico, FOLDER_SVG, isPicture, opensInTab, thumbUrl } from "./explorer.js";
import { mountAssistant } from "./assistant.js";
import { mountDashboard, unmountDashboard } from "./dashboard.js";
const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtBytes = (n) => { if (n == null) return ""; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`; };
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
const fmtWhen = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
const fmtNum = (n) => (n ?? 0).toLocaleString();
const STATE = { 0: "Waiting to be read", 20: "Read, not placed yet", 50: "Done", 70: "Missing from disk", 90: "Could not be read" };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: opts.body ? { "content-type": "application/json" } : {}, credentials: "same-origin" });
  if (res.status === 401 && !path.startsWith("/api/session")) { location.hash = "#/login"; throw new Error("sign in required"); }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}
const post = (path, body, method = "POST") => api(path, { method, body: JSON.stringify(body ?? {}) });

/* ---- the frame every page shares --------------------------------------- */

/**
 * A page, framed like the library: a command bar, an address bar with the way
 * back, the page itself, and a status bar. The bars are the explorer's own parts
 * (.ex-cmd, .ex-addr, .ex-status), not look-alikes, so a button here is the same
 * button there and the way back is always in the same place.
 *
 * `crumbs` is [label, href?][]: the last one is where you are. `up` is where the
 * Up button goes (nothing: it is disabled).
 */
function page({ crumbs = [], up = null, cmd = "", body = "", bodyClass = "", status = "" }) {
  const trail = crumbs.map(([label, href], i) =>
    `${i ? `<span class="chev">${ico("chev")}</span>` : ""}<a dir="auto" ${href ? `href="${esc(href)}"` : 'aria-current="page"'}>${esc(label)}</a>`).join("");
  const el = document.createElement("div");
  el.className = "pg";
  el.innerHTML = `
    <div class="ex-cmd">${cmd}</div>
    <div class="ex-addr">
      <div class="ex-nav">
        <button class="ex-btn" type="button" data-go="back" title="Back (Alt+Left)">${ico("back")}</button>
        <button class="ex-btn" type="button" data-go="forward" title="Forward (Alt+Right)">${ico("forward")}</button>
        <button class="ex-btn" type="button" data-go="up" title="Up" ${up ? "" : "disabled"}>${ico("up")}</button>
        <button class="ex-btn" type="button" data-go="refresh" title="Refresh">${ico("refresh")}</button>
      </div>
      <div class="ex-crumbs">${trail}</div>
    </div>
    <div class="pg-body ${bodyClass}">${body}</div>
    <div class="ex-status">${status}</div>`;
  el.querySelector(".ex-nav").addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]")?.dataset.go;
    if (go === "back") history.back();
    else if (go === "forward") history.forward();
    else if (go === "up" && up) location.hash = up;
    else if (go === "refresh") route();
  });
  view.replaceChildren(el);
  return el;
}

/** Something went wrong drawing a page: say so in the page's own frame. */
function problem(message) {
  page({ crumbs: [["Atlas"]], body: `<div class="ex-empty err">${esc(message)}</div>` });
}

/**
 * A question with two answers, in the library's dialog. Resolves true for the
 * button that does the thing, false for Cancel, Escape or closing it.
 */
function ask(title, bodyHtml, yes) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "ex-dialog";
    d.innerHTML = `<h2>${esc(title)}</h2><div class="content">${bodyHtml}</div>
      <div class="foot"><button type="button" data-no>Cancel</button><button type="button" class="primary" data-yes>${esc(yes)}</button></div>`;
    document.body.appendChild(d);
    let answer = false;
    d.addEventListener("click", (e) => {
      if (e.target.closest("[data-yes]")) { answer = true; d.close(); }
      else if (e.target.closest("[data-no]")) d.close();
    });
    d.addEventListener("close", () => { d.remove(); resolve(answer); });
    d.showModal();
    d.querySelector("[data-no]").focus();
  });
}

/** Copy, or - where the browser will not (plain http from another machine) - show it to copy by hand. */
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const label = btn?.querySelector("span");
    if (label) { const was = label.textContent; label.textContent = "Copied"; setTimeout(() => { label.textContent = was; }, 1500); }
  } catch {
    const d = document.createElement("dialog");
    d.className = "ex-dialog";
    d.innerHTML = `<h2>Copy this</h2><div class="content"><p><code dir="auto">${esc(text)}</code></p></div>
      <div class="foot"><button type="button" class="primary" data-close>Close</button></div>`;
    document.body.appendChild(d);
    d.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) d.close(); });
    d.addEventListener("close", () => d.remove());
    d.showModal();
  }
}

/* ---- the library, photos, search: explorer.js ------------------------- */

async function showLibrary(path) {
  document.body.classList.add("explorer");
  await showExplorer(path, view);
}

async function showSearch(q, scope = "") {
  $("#q").value = q;
  if (!q.trim()) {
    document.body.classList.remove("explorer");
    page({ crumbs: [["Search"]], body: `<div class="ex-empty">Type in the search box to search file names and contents.</div>` });
    return;
  }
  // Results are a place in the explorer, not a different page: same rows, same
  // selection, same views, same context menu.
  document.body.classList.add("explorer");
  return showSearchResults(q, scope, view);
}

/* ---- one file ------------------------------------------------------------ */

/**
 * Everything Atlas knows about one file, laid out like the photo viewer: the
 * file itself on the left, what was read from it on the right.
 */
async function showFile(id) {
  const d = await api(`/api/files/${id}`);
  const f = d.file, c = d.content || {};
  const name = (f.plan || f.path).split("/").pop();
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const it = { id: f.id, ext, isDir: false };
  const src = `/api/files/${id}/content`;
  const folder = f.plan ? f.plan.split("/").slice(0, -1) : null;
  const libHref = folder ? `#/lib/${encodeURIComponent(folder.join("/"))}` : null;
  const sep = f.rootPath.includes("\\") ? "\\" : "/";
  const original = f.rootPath.replace(/[\\/]$/, "") + sep + f.path.split("/").join(sep);
  const viewable = isPicture(it) || opensInTab(it);

  const none = (why) => `<div class="none"><span class="ex-ico ${esc(c.kind || "")}">${esc(ext || "?")}</span>
    <p>${esc(why)}</p><button type="button" class="btn primary" data-act="download">${ico("download")}<span>Download</span></button></div>`;
  let show;
  if (c.kind === "image") {
    // Whatever the browser cannot draw (HEIC, RAW, most TIFFs) still has the
    // thumbnail Windows made of it; failing that, say so.
    show = /heic|x-raw/.test(c.mime || "")
      ? `<img alt="" src="${thumbUrl(id, 512)}" data-fallback="none">`
      : `<img alt="" src="${src}" data-fallback="${thumbUrl(id, 512)}">`;
  } else if (c.kind === "pdf") show = `<iframe src="${src}" title="${esc(name)}"></iframe>`;
  else if (c.kind === "video") show = `<video src="${src}" controls preload="metadata"></video>`;
  else if (c.kind === "audio") show = `<audio src="${src}" controls preload="metadata"></audio>`;
  else if (d.text) show = `<pre dir="auto">${esc(d.text)}</pre>`;
  else show = none(c.kind ? "There is no preview for this kind of file." : "Atlas has not read this file yet.");

  const dl = (rows) => `<dl class="props">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const where = dl([
    ["In the library", f.plan ? `<a href="${esc(libHref)}" dir="auto">${esc(f.plan)}</a>`
      : `<span class="muted">${esc(f.rule === "alias" ? "same file as another path (hard link)" : f.rule === "duplicate" ? "identical copy of another file" : "not placed yet")}</span>`],
    f.rule ? ["Why here", esc(f.rule)] : null,
    ["On disk", `<span dir="auto">${esc(original)}</span>`],
  ]);
  const file = dl([
    ["Size", fmtBytes(f.size)],
    ["Modified", fmtWhen(f.mtime)],
    ["Type", esc([c.kind, c.mime].filter(Boolean).join(" · ")) || '<span class="muted">not read yet</span>'],
    c.width ? ["Dimensions", `${c.width} × ${c.height}`] : null,
    c.pages ? ["Pages", fmtNum(c.pages)] : null,
    c.meta?.camera ? ["Camera", esc(c.meta.camera)] : null,
    c.sha ? ["SHA-256", `<span class="muted sha">${esc(c.sha.toLowerCase())}</span>`] : null,
  ]);
  const read = [
    c.ddate ? ["Document date", `${fmtDate(c.ddate)} <span class="muted">(${esc(c.dsrc || "")})</span>`] : null,
    c.title ? ["Title", `<span dir="auto">${esc(c.title)}</span>`] : null,
    c.dtype ? ["Detected as", esc(c.dtype)] : null,
    c.lang ? ["Language", esc(c.lang)] : null,
    c.quality && c.quality !== "ok" ? ["Text", `<span class="warn">${esc(c.quality.replace(/_/g, " "))}</span>${c.ocr === 1 ? " - waiting for OCR" : ""}`] : null,
    c.ocr === 2 && c.meta?.ocr ? ["OCR", `${esc(c.meta.ocr.engine)} · ${fmtNum(c.meta.ocr.chars)} characters · ${fmtNum(c.meta.ocr.ms)} ms`] : null,
    c.ocr === 3 ? ["OCR", `<span class="err">failed: ${esc(c.meta?.ocrError || "")}</span>`] : null,
  ].filter(Boolean);
  const copies = d.copies.length ? `<div class="pg-head">Other copies (${d.copies.length})</div>
    <ul class="copies">${d.copies.map((x) => `<li><a href="#/file/${x.id}" dir="auto">${esc(x.rootPath + " › " + x.path)}</a><span class="m">${esc(x.rule === "alias" ? "same file" : x.role)}</span></li>`).join("")}</ul>
    <p class="pg-note">Identical bytes (SHA-256). Nothing is deleted; the library shows one of them.</p>` : "";

  const el = page({
    crumbs: [["Library", "#/lib/"], ...(folder ?? []).map((p, i) => [p, `#/lib/${encodeURIComponent(folder.slice(0, i + 1).join("/"))}`]), [name]],
    up: libHref ?? "#/lib/",
    cmd: `${viewable ? `<button class="ex-btn" type="button" data-act="open" title="Open it in a new tab">${ico("eye")}<span>Open</span></button>` : ""}
      <button class="ex-btn" type="button" data-act="download">${ico("download")}<span>Download</span></button>
      <span class="ex-sep"></span>
      ${libHref ? `<button class="ex-btn" type="button" data-act="folder" title="The folder it is in, in the library">${ico("open")}<span>Show in library</span></button>` : ""}
      <button class="ex-btn" type="button" data-act="path" title="${esc(original)}">${ico("copy")}<span>Copy path</span></button>`,
    bodyClass: "pg-file",
    body: `<div class="show">${show}</div><div class="grip"></div>
      <aside class="side">
        <h2 dir="auto">${esc(name)}</h2>
        <div class="pg-head">Where</div>${where}
        <div class="pg-head">File</div>${file}
        ${read.length ? `<div class="pg-head">What Atlas read</div>${dl(read)}` : ""}
        ${d.ocrText ? `<div class="pg-head">Text read by OCR</div><div class="snip" dir="auto">${esc(d.ocrText)}</div>` : ""}
        ${copies}
      </aside>`,
    status: `<span>${esc(STATE[f.state] ?? f.state)}</span>${f.err ? `<span class="err">${esc(f.err)}</span>` : ""}
      <span>${fmtBytes(f.size)}</span>${d.text && !["image", "pdf", "video", "audio"].includes(c.kind) && d.text.length >= 4000 ? '<span class="dim">Showing the first 4,000 characters of its text</span>' : ""}`,
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "open") window.open(src, "_blank", "noopener");
    else if (act === "download") location.href = `${src}?download`;
    else if (act === "folder") location.hash = libHref;
    else if (act === "path") copyText(original, b);
  });
  const img = $(".show > img", el);
  img?.addEventListener("error", () => {
    const next = img.dataset.fallback;
    if (next && next !== "none") { img.dataset.fallback = "none"; img.src = next; }
    else img.outerHTML = none("This picture can't be shown in the browser. Download it to open it.");
  });
}

/* ---- the folders Atlas reads ------------------------------------------ */

const ROLES = ["source", "library", "backup"];

async function showRoots() {
  const [roots, session] = await Promise.all([api("/api/roots"), api("/api/session")]);
  const online = roots.filter((r) => r.online).length;
  const state = (r) => r.seen_volume ? `<span class="dot off"></span>A different disk is here`
    : r.online ? `<span class="dot"></span>Online` : `<span class="dot off"></span>Not reachable`;
  const rows = roots.map((r) => `<tr>
      <td><div class="name"><span class="ex-ico folder">${FOLDER_SVG}</span><div>
        <div class="p" dir="auto">${esc(r.path)}</div>
        ${r.scan_error ? `<div class="note" dir="auto">${esc(r.scan_error)}</div>` : ""}</div></div></td>
      <td><select class="field small" data-role="${r.id}" aria-label="Role">${ROLES.map((x) => `<option ${x === r.role ? "selected" : ""}>${x}</option>`).join("")}</select></td>
      <td class="nowrap">${state(r)}</td>
      <td class="num hide-sm">${r.scan_files != null ? fmtNum(r.scan_files) : ""}</td>
      <td class="hide-sm nowrap">${fmtWhen(r.scan_at)}</td>
      <td class="acts">
        ${r.seen_volume ? `<button class="btn small primary" type="button" data-accept="${r.id}" title="The files at this path are this folder (for example the same data on a new disk): scan them as this folder.">Use this disk</button>` : ""}
        <button class="ex-btn" type="button" data-scan="${r.id}" title="Scan this folder again">${ico("refresh")}</button>
        <button class="ex-btn" type="button" data-del="${r.id}" title="Remove it from Atlas (nothing on disk is touched)">${ico("trash")}</button>
      </td></tr>`).join("");
  const el = page({
    crumbs: [["Folders"]],
    cmd: `<button class="ex-btn" type="button" data-add>${ico("add")}<span>Add a folder</span></button>
      <span class="ex-sep"></span>
      <button class="ex-btn" type="button" data-scan-all ${roots.length ? "" : "disabled"}>${ico("refresh")}<span>Scan all</span></button>`,
    body: `<table class="pg-table">
        <thead><tr><th>Folder</th><th>Role</th><th>State</th><th class="num hide-sm">Files</th><th class="hide-sm">Last scan</th><th></th></tr></thead>
        <tbody>${rows || '<tr class="empty"><td colspan="6">No folders yet. Add one to start.</td></tr>'}</tbody>
      </table>
      <div class="pg-foot">
        <p class="pg-note">Atlas reads these folders. <b>source</b>: your files. <b>library</b>: the preferred home when copies exist. <b>backup</b>: copies here are never chosen as the one to keep.</p>
        <p class="pg-note">A folder is identified by its disk, not its drive letter: if a drive comes back as another letter, Atlas follows it. A <b>different</b> disk at a folder's path is never scanned as that folder unless you say it is the same one.</p>
      </div>`,
    status: `<span>${roots.length} folder${roots.length === 1 ? "" : "s"}</span>${roots.length ? `<span>${online} online</span>` : ""}`,
  });
  const scanned = () => { location.hash = "#/status"; };
  el.querySelectorAll("[data-role]").forEach((s) => s.addEventListener("change", () => post(`/api/roots/${s.dataset.role}`, { role: s.value }, "PATCH").then(route)));
  el.querySelectorAll("[data-scan]").forEach((b) => b.addEventListener("click", () => post("/api/scan", { root: Number(b.dataset.scan) }).then(scanned)));
  $("[data-scan-all]", el).addEventListener("click", () => post("/api/scan", {}).then(scanned));
  el.querySelectorAll("[data-accept]").forEach((b) => b.addEventListener("click", async () => {
    if (await ask("Use this disk?", "<p>Scan the disk now at this path as this folder? Files that are not on it will be treated as missing.</p>", "Use this disk")) {
      post(`/api/roots/${b.dataset.accept}`, { acceptVolume: true }, "PATCH").then(route);
    }
  }));
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (await ask("Remove this folder?", "<p>Atlas forgets this folder and removes its files from the index. Nothing on disk is touched.</p>", "Remove")) {
      api(`/api/roots/${b.dataset.del}`, { method: "DELETE" }).then(route);
    }
  }));
  $("[data-add]", el).addEventListener("click", () => addFolder(session.local));
}

/**
 * "Add a folder", as a dialog. On the Atlas machine itself it can also browse
 * the disks: click a folder to choose it, double-click to go into it.
 */
function addFolder(local) {
  const d = document.createElement("dialog");
  d.className = "ex-dialog";
  d.style.width = "520px";
  d.innerHTML = `<form method="dialog">
    <h2>Add a folder</h2>
    <div class="content">
      <div class="form-row"><label for="rootPath">Folder</label><input class="field" id="rootPath" placeholder="D:\\Documents" dir="ltr" required autocomplete="off"></div>
      <div class="form-row"><label for="rootRole">Role</label><select class="field" id="rootRole">${ROLES.map((x) => `<option>${x}</option>`).join("")}</select></div>
      ${local ? `<div class="picker"><div class="where"><button class="ex-btn" type="button" data-parent title="Up" disabled>${ico("up")}</button><span>This computer</span></div><ul role="listbox" aria-label="Folders"></ul></div>` : ""}
      <p class="err" id="rootErr"></p>
    </div>
    <div class="foot"><button type="button" data-no>Cancel</button><button type="submit" class="primary">Add</button></div>
  </form>`;
  document.body.appendChild(d);
  const input = $("#rootPath", d);
  d.addEventListener("close", () => d.remove());
  $("[data-no]", d).addEventListener("click", () => d.close());
  $("form", d).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await post("/api/roots", { path: input.value, role: $("#rootRole", d).value });
      d.close();
      location.hash = "#/status";
    } catch (err) { $("#rootErr", d).textContent = err.message; }
  });
  d.showModal();
  input.focus();
  if (!local) return;

  let parent = null;
  const list = $(".picker ul", d);
  async function browse(p) {
    let r;
    try { r = await api(`/api/browse${p ? `?path=${encodeURIComponent(p)}` : ""}`); }
    catch (err) { $("#rootErr", d).textContent = err.message; return; }
    parent = r.parent ?? null;
    $("[data-parent]", d).disabled = !r.path;
    $(".picker .where span", d).textContent = r.path || "This computer";
    list.innerHTML = r.dirs.map((x) => `<li role="option" data-dir="${esc(x)}" title="${esc(x)}"><span class="ex-ico folder">${FOLDER_SVG}</span><span dir="auto">${esc(x.split(/[\\/]/).filter(Boolean).pop() || x)}</span></li>`).join("")
      || '<li class="muted" aria-disabled="true">No folders in here</li>';
    list.scrollTop = 0;
  }
  $("[data-parent]", d).addEventListener("click", () => browse(parent));
  list.addEventListener("click", (e) => {
    const li = e.target.closest("[data-dir]");
    if (!li) return;
    for (const x of list.querySelectorAll("[aria-selected]")) x.removeAttribute("aria-selected");
    li.setAttribute("aria-selected", "true");
    input.value = li.dataset.dir;
  });
  list.addEventListener("dblclick", (e) => {
    const li = e.target.closest("[data-dir]");
    if (li) { input.value = li.dataset.dir; browse(li.dataset.dir); }
  });
  browse(null);
}

/* ---- status: dashboard.js, in the same frame -------------------------- */

async function showStatus() {
  document.body.classList.remove("explorer");
  await mountDashboard(page({ crumbs: [["Status"]] }));
}

/* ---- signing in ---------------------------------------------------------- */

async function showLogin() {
  $("#bar").hidden = true;
  const s = await api("/api/session");
  if (s.authenticated) { location.hash = "#/lib/"; return; }
  const head = (t) => `<h2><img src="/icon.svg" alt="">${esc(t)}</h2>`;
  let dialog;
  if (s.setupNeeded && !s.local) {
    dialog = `<div class="ex-dialog">${head("Atlas is not set up yet")}<div class="content"><p>Finish setup on the Atlas machine itself.</p></div></div>`;
  } else if (s.setupNeeded) {
    dialog = `<form class="ex-dialog" id="f">${head("Set up Atlas")}<div class="content">
        <p class="muted">Enter the code from</p><code>${esc(s.setupFile)}</code><p class="muted">and choose the owner password.</p>
        <input class="field" id="code" placeholder="Setup code" inputmode="numeric" required autocomplete="off">
        <input class="field" id="pw" type="password" placeholder="Password (8+ characters)" minlength="8" required autocomplete="new-password">
        <p id="e" class="err"></p></div>
      <div class="foot"><button class="primary">Set password</button></div></form>`;
  } else {
    dialog = `<form class="ex-dialog" id="f">${head("Sign in to Atlas")}<div class="content">
        <input class="field" id="pw" type="password" placeholder="Password" required autofocus autocomplete="current-password">
        <p id="e" class="err"></p></div>
      <div class="foot"><button class="primary">Sign in</button></div></form>`;
  }
  view.innerHTML = `<div class="pg-login">${dialog}</div>`;
  $("#f input")?.focus();
  $("#f")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      if (s.setupNeeded) await post("/api/setup", { code: $("#code").value, password: $("#pw").value });
      else await post("/api/login", { password: $("#pw").value });
      location.hash = "#/lib/";
    } catch (err) { $("#e").textContent = err.message; }
  });
}

/* ---- routing ------------------------------------------------------------- */

async function route() {
  if (location.hash !== "#/status") unmountDashboard();
  const h = location.hash || "#/lib/";
  // A file's page and search results are places in the library: its tab stays on.
  const tab = h.startsWith("#/file/") || h.startsWith("#/search") ? "#/lib" : h;
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", tab.startsWith(`#/${a.dataset.nav}`)));
  try {
    if (h === "#/login") return await showLogin();
    $("#bar").hidden = false;
    syncBarHeight();
    if (!h.startsWith("#/lib/") && !h.startsWith("#/search") && h !== "#/photos") document.body.classList.remove("explorer");
    if (h.startsWith("#/lib/")) return await showLibrary(decodeURIComponent(h.slice(6)));
    if (h.startsWith("#/search")) {
      const p = new URLSearchParams(h.split("?")[1] || "");
      return await showSearch(p.get("q") || "", p.get("in") || "");
    }
    if (h === "#/photos") { document.body.classList.add("explorer"); return await showPhotos(view); }
    if (h.startsWith("#/file/")) return await showFile(Number(h.slice(7)));
    if (h === "#/status") return await showStatus();
    if (h === "#/roots") return await showRoots();
    location.hash = "#/lib/";
  } catch (e) {
    if (e.message !== "sign in required") problem(e.message);
  }
}

// The pages under the header are fixed to the window, so they need to know
// where the header ends: set when it appears, and again whenever it changes
// height (it wraps onto two lines on a phone).
function syncBarHeight() { document.documentElement.style.setProperty("--bar-h", `${$("#bar").offsetHeight}px`); }
new ResizeObserver(syncBarHeight).observe($("#bar"));

$("#searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#q").value;
  // Searching from inside a folder searches that folder. At the top of the
  // library - or anywhere that is not a folder - it searches everything.
  const scope = currentScope();
  const next = `#/search?q=${encodeURIComponent(q)}${scope ? `&in=${encodeURIComponent(scope)}` : ""}`;
  // Enter again on the same query walks to the next literal match instead of
  // re-running the search - the gesture every find bar has taught everyone.
  if (location.hash === next) explorerFind(1);
  else location.hash = next;
});
$("#q").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.shiftKey) return;
  e.preventDefault();
  explorerFind(-1);
});
function syncSearchScope() {
  const scope = currentScope();
  const box = $("#q");
  if (!box) return;
  box.placeholder = scope ? `Search in ${scope.split("/").pop()}` : "Search names and contents — English, العربية, français";
}

/**
 * Which part of the app a hash belongs to. Moving between parts cross-fades;
 * moving WITHIN one (folder to folder, search to search) does not, because
 * browsing has to stay instant.
 */
const section = (h) => (h.startsWith("#/lib/") || h.startsWith("#/search") ? "library" : h.split(/[/?]/)[1] || "library");
let currentSection = section(location.hash || "#/lib/");

window.addEventListener("hashchange", () => {
  const next = section(location.hash);
  const go = () => route().then(syncSearchScope);
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (next !== currentSection && document.startViewTransition && !calm) {
    // A transition is abandoned (and its promises reject) if another navigation
    // starts first or the tab is hidden. That is fine - the page still renders -
    // so the rejections are caught rather than reported as errors.
    const t = document.startViewTransition(go);
    for (const p of [t.ready, t.finished, t.updateCallbackDone]) p.catch(() => {});
  } else go();
  currentSection = next;
});
api("/api/session").then((s) => {
  if (!s.authenticated) { location.hash = "#/login"; route(); return; }
  route().then(syncSearchScope);
  mountAssistant();
});
