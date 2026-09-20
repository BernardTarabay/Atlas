// The assistant: a small panel in the bottom-right corner that does what the
// toolbar does, by conversation.
//
// WHAT IT CAN AND CANNOT DO
//
// It proposes; the browser runs. Actions that only change what is on screen -
// go there, search, find, select, arrange - run the moment they arrive, because
// making someone click Apply to receive the answer they just asked for is
// friction pretending to be safety. Actions that change the PLAN - move, rename
// - are drawn as a card with an Apply button, and are undoable afterwards like
// any other move. Nothing in its vocabulary touches the disk, so there is no
// action it could take that a person could not take back.
//
// One model call per message. Never per file.
import { agent } from "./explorer.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ICON = {
  spark: "M10 3l1.8 4.2L16 9l-4.2 1.8L10 15l-1.8-4.2L4 9l4.2-1.8z",
  send: "M3 10l14-6-6 14-2-6z",
  close: "M5 5l10 10M15 5L5 15",
};
const svg = (name) => `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;

const state = { open: false, busy: false, history: [], pending: new Map(), available: null };
let el = null;

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

const dateMs = (s) => {
  if (!s) return undefined;
  const t = Date.parse(String(s).length === 10 ? `${s}T00:00:00` : s);
  return Number.isFinite(t) ? t : undefined;
};

/** Run one looking action. Returns a line to show under the reply, or "". */
async function runLook(a) {
  switch (a.type) {
    case "navigate": agent.navigate(a.path ?? ""); return "";
    case "search": agent.search(a.query ?? "", a.scope ?? ""); return "";
    case "photos": agent.photos(a.status ?? "all"); return "";
    case "open": agent.open(Number(a.ids?.[0])); return "";
    case "view": agent.view(a.mode); return "";
    case "sort": agent.sort(a.by, a.dir); return "";
    case "group": agent.group(a.by); return "";
    case "reset": agent.reset(); return "";
    case "select": {
      if (Array.isArray(a.ids) && a.ids.length) return `${agent.select(a.ids.map(Number))} selected`;
      const files = await findFiles(a.criteria);
      agent.showFiles(files.files, a.summary);
      agent.select(files.files.map((f) => f.id));
      return `${files.total} matched`;
    }
    case "find": {
      const files = await findFiles(a.criteria);
      agent.showFiles(files.files, a.summary);
      return `${files.total} matched${files.total > files.files.length ? `, showing ${files.files.length}` : ""}`;
    }
    default: return "";
  }
}

async function findFiles(criteria) {
  const c = criteria ?? {};
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({
    ext: c.ext, kind: c.kind, dtype: c.dtype, lang: c.lang, folder: c.folder, name: c.nameContains,
    after: dateMs(c.after), before: dateMs(c.before), minSize: c.minSize, maxSize: c.maxSize,
  })) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return api(`/api/find?${q}`);
}

async function apply(a) {
  if (a.type === "move") {
    const ids = Array.isArray(a.ids) && a.ids.length ? a.ids.map(Number) : (await findFiles(a.criteria)).files.map((f) => f.id);
    if (!ids.length) throw new Error("nothing matched, so nothing was moved");
    await agent.move(ids, a.path);
    return `Moved ${ids.length} file(s) to ${a.path}`;
  }
  if (a.type === "rename") {
    const id = Number(a.ids?.[0]);
    if (!Number.isInteger(id)) throw new Error("no file to rename");
    await agent.rename(id, a.name);
    return `Renamed to ${a.name}`;
  }
  return "";
}

function line(role, html, cls = "") {
  const box = el.querySelector(".log");
  const div = document.createElement("div");
  div.className = `msg ${role} ${cls}`.trim();
  div.innerHTML = html;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function actionCard(a) {
  const id = `a${Math.random().toString(36).slice(2, 9)}`;
  state.pending.set(id, a);
  return `<div class="card" data-card="${id}">
    <div class="what">${esc(a.summary)}</div>
    <div class="row">
      <button type="button" data-apply="${id}">Apply</button>
      <button type="button" class="ghost" data-drop="${id}">No</button>
      <span class="note">changes the plan, not your disk</span>
    </div>
  </div>`;
}

async function send(text) {
  if (state.busy || !text.trim()) return;
  state.busy = true;
  el.querySelector("input").value = "";
  line("me", esc(text));
  const thinking = line("bot", '<span class="dots">Thinking…</span>');
  try {
    const answer = await api("/api/ai/chat", { message: text, history: state.history, context: agent.context() });
    state.history.push({ role: "user", text }, { role: "assistant", text: answer.reply });
    const done = [];
    for (const a of answer.actions.filter((x) => !x.confirm)) {
      try { const note = await runLook(a); done.push(`${a.summary}${note ? ` — ${note}` : ""}`); }
      catch (e) { done.push(`${a.summary} — failed: ${e.message}`); }
    }
    const cards = answer.actions.filter((x) => x.confirm).map(actionCard).join("");
    thinking.innerHTML = `${esc(answer.reply).replace(/\n/g, "<br>")}
      ${done.length ? `<div class="did">${done.map((d) => `<div>✓ ${esc(d)}</div>`).join("")}</div>` : ""}
      ${cards}`;
  } catch (e) {
    thinking.className = "msg bot err";
    thinking.textContent = e.message;
  } finally {
    state.busy = false;
    el.querySelector(".log").scrollTop = el.querySelector(".log").scrollHeight;
  }
}

function build() {
  el = document.createElement("div");
  el.className = "ai";
  el.innerHTML = `
    <button class="launch" type="button" title="Ask Atlas">${svg("spark")}<span>Ask</span></button>
    <div class="panel" hidden>
      <header>
        <span class="t">${svg("spark")} Ask Atlas</span>
        <button type="button" class="x" title="Close">${svg("close")}</button>
      </header>
      <div class="log">
        <div class="msg bot hint">Ask for what you want: “show me every PDF from 2023”, “put these in Documents/Contracts”,
        “rename this to Lease 2024.pdf”, “group by type”. I can move and rename things in the library —
        which changes the plan, never your files on disk.</div>
      </div>
      <form class="ask">
        <input type="text" placeholder="Ask about your files…" autocomplete="off" dir="auto">
        <button type="submit" title="Send">${svg("send")}</button>
      </form>
    </div>`;
  document.body.appendChild(el);

  const panel = el.querySelector(".panel");
  const toggle = (on) => {
    state.open = on;
    panel.hidden = !on;
    el.querySelector(".launch").hidden = on;
    if (on) el.querySelector("input").focus();
  };
  el.querySelector(".launch").addEventListener("click", () => toggle(true));
  el.querySelector(".x").addEventListener("click", () => toggle(false));
  el.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); send(el.querySelector("input").value); });
  el.addEventListener("click", async (e) => {
    const drop = e.target.closest("[data-drop]");
    if (drop) { state.pending.delete(drop.dataset.drop); drop.closest(".card").remove(); return; }
    const btn = e.target.closest("[data-apply]");
    if (!btn) return;
    const a = state.pending.get(btn.dataset.apply);
    if (!a) return;
    btn.disabled = true;
    const card = btn.closest(".card");
    try {
      const note = await apply(a);
      card.outerHTML = `<div class="card done">✓ ${esc(note)}</div>`;
    } catch (err) {
      btn.disabled = false;
      card.querySelector(".note").textContent = err.message;
      card.querySelector(".note").classList.add("bad");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.open) toggle(false);
  });
}

/** Mounted once, and only when there is a key: an assistant that cannot answer is worse than none. */
export async function mountAssistant() {
  if (el) return;
  try {
    const s = await api("/api/ai");
    state.available = s?.available;
    if (!s?.available) return;
  } catch { return; }
  build();
}
