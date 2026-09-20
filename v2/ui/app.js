// Atlas UI. No framework, no build step. The engine owns all state; this page
// only reads it and sends a few commands, so closing it changes nothing.
//
// This file is the shell: routing, search, status, folders, one file's detail.
// Browsing the library itself is explorer.js, which is a file manager.
import { showExplorer, showSearchResults, showPhotos, explorerFind, currentScope } from "./explorer.js";
import { mountAssistant } from "./assistant.js";
const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtBytes = (n) => { if (n == null) return ""; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`; };
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
const fmtNum = (n) => (n ?? 0).toLocaleString();
const STATE = { 0: "new", 20: "identified", 50: "done", 70: "missing", 90: "failed" };
let refreshTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: opts.body ? { "content-type": "application/json" } : {}, credentials: "same-origin" });
  if (res.status === 401 && !path.startsWith("/api/session")) { location.hash = "#/login"; throw new Error("sign in required"); }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}
const post = (path, body, method = "POST") => api(path, { method, body: JSON.stringify(body ?? {}) });

function icon(kind, name) {
  const ext = (name.split(".").pop() || "").slice(0, 4);
  return `<span class="icon" title="${esc(kind || "")}">${esc(kind === "image" ? "img" : kind === "video" ? "vid" : ext || kind || "?")}</span>`;
}

function crumbs(path) {
  const parts = path ? path.split("/") : [];
  let acc = "";
  const links = parts.map((p) => { acc = acc ? `${acc}/${p}` : p; return `<span>/</span><a href="#/lib/${encodeURIComponent(acc)}" dir="auto">${esc(p)}</a>`; });
  return `<div class="crumbs"><a href="#/lib/">Library</a>${links.join("")}</div>`;
}

async function showLibrary(path) {
  document.body.classList.add("explorer");
  await showExplorer(path, view);
}

async function showSearch(q, scope = "") {
  $("#q").value = q;
  if (!q.trim()) { document.body.classList.remove("explorer"); view.innerHTML = `<p class="muted">Type to search file names and contents.</p>`; return; }
  // Results are a place in the explorer, not a different page: same rows, same
  // selection, same views, same context menu.
  document.body.classList.add("explorer");
  return showSearchResults(q, scope, view);
}

async function showSearchOld(q) {
  $("#q").value = q;
  const d = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const items = d.hits.map((h) => {
    const name = (h.plan || h.path).split("/").pop();
    return `<li>${icon(h.kind, name)}<div class="name"><a dir="auto" href="#/file/${h.id}">${esc(name)}</a>
      ${h.snippet ? `<div class="snippet" dir="auto">${esc(h.snippet)}</div>` : ""}
      <div class="tags">${h.why.map((w) => `<span class="tag">${esc(w)}</span>`).join("")}<span class="tag" dir="auto">${esc(h.plan ? h.plan.split("/").slice(0, -1).join(" / ") : h.path)}</span></div></div>
      <span class="meta">${fmtBytes(h.size)}</span></li>`;
  });
  view.innerHTML = `<h1>Results for “<span dir="auto">${esc(q)}</span>”</h1><p class="muted small">${d.hits.length} result(s) in ${d.ms} ms</p><div class="panel"><ul class="list">${items.join("") || "<li class='muted'>No matches.</li>"}</ul></div>`;
}

async function showFile(id) {
  const d = await api(`/api/files/${id}`);
  const f = d.file, c = d.content || {};
  const name = (f.plan || f.path).split("/").pop();
  const src = `/api/files/${id}/content`;
  let preview = "";
  if (c.kind === "image" && !/heic|x-raw/.test(c.mime || "")) preview = `<img class="preview" src="${src}" alt="">`;
  else if (c.kind === "pdf") preview = `<iframe class="preview" src="${src}" title="preview"></iframe>`;
  else if (c.kind === "video") preview = `<video class="preview" src="${src}" controls preload="metadata"></video>`;
  else if (c.kind === "audio") preview = `<audio src="${src}" controls preload="metadata"></audio>`;
  else if (d.text) preview = `<pre class="text" dir="auto">${esc(d.text)}</pre>`;
  const sep = f.rootPath.includes("\\") ? "\\" : "/";
  const original = f.rootPath.replace(/[\\/]$/, "") + sep + f.path.split("/").join(sep);
  const rows = [
    ["In the library", f.plan ? `<a href="#/lib/${encodeURIComponent(f.plan.split("/").slice(0, -1).join("/"))}" dir="auto">${esc(f.plan)}</a>` : `<span class="muted">${esc(f.rule === "alias" ? "same file as another path (hard link)" : f.rule === "duplicate" ? "identical copy of another file" : "not placed yet")}</span>`],
    ["Why here", esc(f.rule || "")],
    ["On disk", `<span dir="auto">${esc(original)}</span>`],
    ["Size", fmtBytes(f.size)],
    ["Modified", fmtDate(f.mtime)],
    ["Type", esc([c.kind, c.mime].filter(Boolean).join(" · "))],
    c.ddate ? ["Document date", `${fmtDate(c.ddate)} <span class="muted small">(${esc(c.dsrc || "")})</span>`] : null,
    c.title ? ["Title", `<span dir="auto">${esc(c.title)}</span>`] : null,
    c.dtype ? ["Detected as", esc(c.dtype)] : null,
    c.lang ? ["Language", esc(c.lang)] : null,
    c.width ? ["Dimensions", `${c.width} × ${c.height}`] : null,
    c.pages ? ["Pages", c.pages] : null,
    c.meta?.camera ? ["Camera", esc(c.meta.camera)] : null,
    c.quality && c.quality !== "ok" ? ["Text", `<span class="warn">${esc(c.quality.replace(/_/g, " "))}</span>${c.ocr === 1 ? " — waiting for OCR" : ""}`] : null,
    c.ocr === 2 && c.meta?.ocr ? ["OCR", `${esc(c.meta.ocr.engine)} · ${c.meta.ocr.chars} characters · ${c.meta.ocr.ms} ms`] : null,
    c.ocr === 3 ? ["OCR", `<span class="err">failed: ${esc(c.meta?.ocrError || "")}</span>`] : null,
    ["Status", esc(STATE[f.state] || f.state) + (f.err ? ` <span class="err">${esc(f.err)}</span>` : "")],
    c.sha ? ["SHA-256", `<span class="small muted">${esc(c.sha.toLowerCase())}</span>`] : null,
  ].filter(Boolean);
  const copies = d.copies.length
    ? `<div class="panel"><h2>Other copies (${d.copies.length})</h2><ul class="list">${d.copies.map((x) => `<li><span class="icon">${x.rule === "alias" ? "=" : "dup"}</span><a class="name" dir="auto" href="#/file/${x.id}">${esc(x.rootPath + " › " + x.path)}</a><span class="meta">${esc(x.role)}</span></li>`).join("")}</ul><p class="muted small">Identical bytes (SHA-256). Nothing is deleted; the library shows one representative.</p></div>` : "";
  view.innerHTML = `${crumbs(f.plan ? f.plan.split("/").slice(0, -1).join("/") : "")}
    <h1 dir="auto">${esc(name)}</h1>
    <div class="row" style="margin-bottom:12px"><a href="${src}" target="_blank" rel="noopener"><button>Open</button></a><a href="${src}?download"><button class="ghost">Download</button></a></div>
    ${preview ? `<div class="panel">${preview}</div>` : ""}
    ${d.ocrText ? `<div class="panel"><h2>Text read by OCR</h2><pre class="text" dir="auto">${esc(d.ocrText)}</pre></div>` : ""}
    <div class="panel"><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>${copies}`;
}

async function showStatus() {
  const s = await api("/api/status");
  const by = Object.fromEntries(s.states.map((x) => [x.state, x]));
  const total = s.states.reduce((a, x) => a + x.n, 0);
  const done = by[50]?.n ?? 0, pending = (by[0]?.n ?? 0) + (by[20]?.n ?? 0);
  const pct = total ? Math.round((done / total) * 100) : 100;
  const scanning = s.scan.scanning != null ? s.roots.find((r) => r.id === s.scan.scanning)?.path : null;
  view.innerHTML = `<h1>Status</h1>
    <div class="panel"><div class="row" style="justify-content:space-between"><b>${s.busy ? "Working" : "Idle — everything processed"}</b><span class="muted small">up ${Math.round(s.uptime / 60)} min · ${s.workers.busy}/${s.workers.total} workers busy</span></div>
      <div class="bar-track" style="margin-top:10px"><div class="bar-fill" style="width:${pct}%"></div></div>
      <p class="muted small">${fmtNum(done)} of ${fmtNum(total)} files processed (${pct}%)${scanning ? ` · scanning ${esc(scanning)}` : ""}</p></div>
    <div class="grid">
      <div class="stat"><span class="muted">Files</span><b>${fmtNum(total)}</b><span class="muted small">${fmtBytes(s.states.reduce((a, x) => a + (x.bytes || 0), 0))}</span></div>
      <div class="stat"><span class="muted">Waiting</span><b>${fmtNum(pending)}</b></div>
      <div class="stat"><span class="muted">Duplicate copies</span><b>${fmtNum(s.duplicates.copies)}</b><span class="muted small">${fmtBytes(s.duplicates.bytes)} reclaimable later</span></div>
      <div class="stat"><span class="muted">Waiting for OCR</span><b>${fmtNum(s.ocrPending)}</b></div>
      <div class="stat"><span class="muted">Missing</span><b>${fmtNum(by[70]?.n ?? 0)}</b></div>
      <div class="stat"><span class="muted">Could not read</span><b class="${by[90] ? "err" : ""}">${fmtNum(by[90]?.n ?? 0)}</b></div>
    </div>
    <div class="panel" style="margin-top:16px"><h2>Folders</h2><ul class="list">${s.roots.map((r) => `<li><span class="name" dir="auto">${esc(r.path)}</span><span class="meta">${esc(r.role)} · ${r.online ? '<span class="ok">online</span>' : '<span class="err">offline</span>'}${r.scan_at ? ` · scanned ${fmtDate(r.scan_at)} (${fmtNum(r.scan_files)} files, ${(r.scan_ms / 1000).toFixed(1)} s)` : ""}${r.scan_error ? ` · <span class="warn">${esc(r.scan_error)}</span>` : ""}</span></li>`).join("") || '<li class="muted">No folders yet.</li>'}</ul></div>`;
  refreshTimer = setTimeout(() => location.hash === "#/status" && route(), 2000);
}

async function showRoots() {
  const [roots, session] = await Promise.all([api("/api/roots"), api("/api/session")]);
  view.innerHTML = `<h1>Folders</h1>
    <div class="panel"><ul class="list">${roots.map((r) => `<li><span class="name" dir="auto">${esc(r.path)}</span>
      <select data-role="${r.id}">${["source", "library", "backup"].map((x) => `<option ${x === r.role ? "selected" : ""}>${x}</option>`).join("")}</select>
      <button class="ghost" data-scan="${r.id}">Rescan</button><button class="ghost" data-del="${r.id}">Remove</button></li>`).join("") || '<li class="muted">No folders yet.</li>'}</ul></div>
    <div class="panel"><h2>Add a folder</h2>
      <form id="addRoot" class="row"><input id="rootPath" placeholder="D:\\Documents" style="flex:1" dir="ltr" required>
      <select id="rootRole"><option>source</option><option>library</option><option>backup</option></select><button>Add</button></form>
      <p class="muted small">Atlas only reads these folders. <b>source</b>: your files. <b>library</b>: the preferred home when copies exist. <b>backup</b>: copies here are never chosen as the one to keep.</p>
      ${session.local ? '<div id="browser" class="dirs"></div>' : ""}<p id="rootErr" class="err"></p></div>`;
  view.querySelectorAll("[data-role]").forEach((el) => el.addEventListener("change", () => post(`/api/roots/${el.dataset.role}`, { role: el.value }, "PATCH").then(route)));
  view.querySelectorAll("[data-scan]").forEach((el) => el.addEventListener("click", () => post("/api/scan", { root: Number(el.dataset.scan) }).then(() => (location.hash = "#/status"))));
  view.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", () => {
    if (confirm("Forget this folder? Atlas removes it from the index. Nothing on disk is touched.")) api(`/api/roots/${el.dataset.del}`, { method: "DELETE" }).then(route);
  }));
  $("#addRoot").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await post("/api/roots", { path: $("#rootPath").value, role: $("#rootRole").value }); location.hash = "#/status"; }
    catch (err) { $("#rootErr").textContent = err.message; }
  });
  if (session.local) browseInto(null);
}

async function browseInto(p) {
  const d = await api(`/api/browse${p ? `?path=${encodeURIComponent(p)}` : ""}`);
  const box = $("#browser");
  if (!box) return;
  box.innerHTML = `<p class="muted small">Browse: ${esc(d.path || "this computer")}</p><ul class="list">${d.parent ? `<li><a href="#" data-dir="${esc(d.parent)}">..</a></li>` : ""}${d.dirs.map((x) => `<li><a href="#" data-dir="${esc(x)}" dir="auto">${esc(x.split(/[\\/]/).filter(Boolean).pop() || x)}</a><button class="ghost" data-pick="${esc(x)}">Choose</button></li>`).join("")}</ul>`;
  box.querySelectorAll("[data-dir]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); browseInto(a.dataset.dir); }));
  box.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => { $("#rootPath").value = b.dataset.pick; }));
}

async function showLogin() {
  $("#bar").hidden = true;
  const s = await api("/api/session");
  if (s.authenticated) { location.hash = "#/lib/"; return; }
  if (s.setupNeeded) {
    view.innerHTML = s.local
      ? `<div class="center panel"><h1>Set up Atlas</h1><p class="muted small">Enter the code from<br><code>${esc(s.setupFile)}</code><br>and choose the owner password.</p>
        <form id="f"><input id="code" placeholder="Setup code" inputmode="numeric" required><input id="pw" type="password" placeholder="Password (8+ characters)" minlength="8" required><button>Set password</button><p id="e" class="err"></p></form></div>`
      : `<div class="center panel"><h1>Atlas is not set up yet</h1><p class="muted">Finish setup on the Atlas machine itself.</p></div>`;
  } else {
    view.innerHTML = `<div class="center panel"><h1>Atlas</h1><form id="f"><input id="pw" type="password" placeholder="Password" required autofocus><button>Sign in</button><p id="e" class="err"></p></form></div>`;
  }
  $("#f")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      if (s.setupNeeded) await post("/api/setup", { code: $("#code").value, password: $("#pw").value });
      else await post("/api/login", { password: $("#pw").value });
      location.hash = "#/lib/";
    } catch (err) { $("#e").textContent = err.message; }
  });
}

async function route() {
  clearTimeout(refreshTimer);
  const h = location.hash || "#/lib/";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", h.startsWith(`#/${a.dataset.nav}`)));
  try {
    if (h === "#/login") return await showLogin();
    $("#bar").hidden = false;
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
    if (e.message !== "sign in required") view.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

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

window.addEventListener("hashchange", () => { route().then(syncSearchScope); });
api("/api/session").then((s) => {
  if (!s.authenticated) { location.hash = "#/login"; route(); return; }
  route().then(syncSearchScope);
  mountAssistant();
});
