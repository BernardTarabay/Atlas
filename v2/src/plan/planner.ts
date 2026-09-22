// Turns IDENT files into DONE ones: choose each duplicate group's representative,
// give the representative a unique place in the virtual library, index its name.
//
// Keep policy (which copy represents identical content), in order:
//   1. a copy under a 'library' root   2. not under a 'backup' root
//   3. shallowest path   4. oldest mtime   5. lowest id (determinism)
// Copies that share the representative's NTFS file ID are the SAME file seen
// through a hard link, not duplicates, and are labelled 'alias'.
import type { Db } from "../db/db.ts";
import { S } from "../pipeline/states.ts";
import { plan, type PlanInput } from "./rules.ts";
import { nameText } from "../search/text.ts";
import { splitName } from "./names.ts";

interface Cand {
  id: number; root: number; path: string; mtime: number; ctime: number; content: number | null; fid: string | null; plan: string | null; pin: string | null; pinname: string | null;
  role: string; kind: string | null; dtype: string | null; title: string | null; quality: string | null;
  ddate: number | null; dsrc: string | null; meta: string | null; cstate: number | null; sha: string | null;
}

interface Member { id: number; root: number; path: string; mtime: number; fid: string | null; role: string; plan: string | null }

const roleRank = (r: string) => (r === "library" ? 0 : r === "backup" ? 2 : 1);
const depth = (p: string) => p.split("/").length;
/**
 * Final tiebreak everywhere: root, then relative path. NOT the row id -- ids depend
 * on scan history (an interrupted first scan numbers files differently), and the
 * organization must come out the same however it was reached.
 */
const byLocation = (a: { root: number; path: string }, b: { root: number; path: string }) =>
  a.root - b.root || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * A library name was given up (its file was re-planned elsewhere, demoted to a
 * duplicate, or went missing). Files numbered after it -- "X (2).txt", "X (3).txt" --
 * are re-planned so the numbering compacts exactly as a fresh run would number it.
 */
export function releaseName(db: Db, plan: string) {
  const slash = plan.lastIndexOf("/");
  const [stem, ext] = splitName(plan.slice(slash + 1));
  const base = `${plan.slice(0, slash)}/${stem.replace(/ \(\d+\)$/, "")} (`;
  const tail = ext ? `%).${ext.replace(/[\\%_]/g, "\\$&")}` : "%)";
  db.run(`UPDATE files SET state = ${S.IDENT} WHERE state = ${S.DONE} AND plan >= ? AND plan < ? AND plan LIKE ? ESCAPE '\\'`,
    base, base.slice(0, -1) + ")", tail);
}

export function chooseRepresentative(members: Member[]): Member {
  return [...members].sort((a, b) =>
    roleRank(a.role) - roleRank(b.role) || depth(a.path) - depth(b.path) || a.mtime - b.mtime || byLocation(a, b))[0];
}

/**
 * Plan up to `limit` files. `extracting` holds content hashes still being analyzed
 * by a worker: their files wait, so they are planned with the full analysis.
 */
export function planBatch(db: Db, limit: number, extracting: Set<string>): number {
  const rows = db.all<Cand>(
    `SELECT f.id, f.root, f.path, f.mtime, f.ctime, f.content, f.fid, f.plan, f.pin, f.pinname, r.role,
            c.kind, c.dtype, c.title, c.quality, c.ddate, c.dsrc, c.meta, c.state AS cstate, hex(c.sha) AS sha
     FROM files f JOIN roots r ON r.id = f.root LEFT JOIN contents c ON c.id = f.content
     WHERE f.state = ${S.IDENT} ORDER BY f.id LIMIT ?`, limit);
  if (!rows.length) return 0;
  const members = db.q(
    `SELECT f.id, f.root, f.path, f.mtime, f.fid, r.role, f.plan FROM files f JOIN roots r ON r.id = f.root
     WHERE f.content = ? AND f.state IN (${S.IDENT}, ${S.DONE})`);
  const setPlan = db.q(`UPDATE files SET plan = ?, rule = ?, state = ${S.DONE} WHERE id = ?`);
  const clearPlan = db.q(`UPDATE files SET plan = NULL, rule = ?, state = ${S.DONE} WHERE id = ?`);
  const replanRep = db.q(`UPDATE files SET state = ${S.IDENT} WHERE id = ? AND state = ${S.DONE}`);
  const holder = db.q("SELECT id, root, path FROM files WHERE plan = ? AND id <> ? LIMIT 1");
  // Giving up a name re-plans a PLANNED file. A file still waiting to be read (NEW, an
  // edited file keeps its old plan until then) keeps waiting: making it IDENT here would
  // file it without ever reading it.
  const evict = db.q(`UPDATE files SET plan = NULL, state = CASE WHEN state = ${S.DONE} THEN ${S.IDENT} ELSE state END WHERE id = ?`);
  const titleShared = db.q("SELECT count(*) AS n FROM (SELECT 1 FROM contents WHERE title = ? LIMIT 5)");
  const delName = db.q("DELETE FROM fts_name WHERE rowid = ?");
  const addName = db.q("INSERT INTO fts_name(rowid, name) VALUES(?, ?)");
  let done = 0;

  db.tx(() => {
    for (const f of rows) {
      if (f.sha && f.cstate === 0 && extracting.has(f.sha)) continue; // analysis still running
      let isRep = true;
      let label = "";
      if (f.content != null) {
        const group = members.all(f.content) as unknown as Member[];
        if (group.length > 1) {
          const rep = chooseRepresentative(group);
          isRep = rep.id === f.id;
          if (!isRep) {
            label = rep.fid && rep.fid === f.fid ? "alias" : "duplicate";
            // The representative changed (role change, a copy went missing) and has no place yet: plan it.
            if (!rep.plan) replanRep.run(rep.id);
          } else for (const m of group) {
            if (m.id !== f.id && m.plan) { clearPlan.run(m.fid && m.fid === f.fid ? "alias" : "duplicate", m.id); releaseName(db, m.plan); }
          }
        }
      }
      delName.run(f.id);
      addName.run(f.id, nameText(f.path.replaceAll("/", " ")));
      if (!isRep) {
        clearPlan.run(label, f.id);
        if (f.plan) releaseName(db, f.plan);
        done++;
        continue;
      }
      const meta = f.meta ? (JSON.parse(f.meta) as Record<string, unknown>) : {};
      const input: PlanInput = {
        path: f.path, kind: (f.kind || "") as PlanInput["kind"], dtype: f.dtype, title: f.title,
        titleShared: f.title ? ((titleShared.get(f.title) as { n: number }).n >= 5) : false,
        heading: (meta.heading as string) ?? null, quality: f.quality, ddate: f.ddate, dsrc: f.dsrc,
        camera: (meta.camera as string) ?? null, mtime: f.mtime, ctime: f.ctime,
      };
      const p = plan(input);
      // A folder chosen by hand wins over the rule that would have picked one.
      // The NAME still comes from the rules, and so does collision handling, so a
      // moved file is numbered against its new neighbours like any other.
      if (f.pin) { p.folder = f.pin; p.rule = "manual"; }
      if (f.pinname) { p.name = f.pinname; p.rule = "manual"; }
      // Two different files may earn the same place. The file that sorts first by
      // location always wins a name: if the current holder sorts after this file, it is
      // evicted and re-planned into the next number. The result does not depend on the
      // order files were planned in, so it survives crashes and reruns unchanged.
      const [stem, ext] = splitName(p.name);
      let target = "";
      for (let n = 1; ; n++) {
        target = n === 1 ? `${p.folder}/${p.name}` : `${p.folder}/${stem} (${n})${ext ? "." + ext : ""}`;
        const h = holder.get(target, f.id) as { id: number; root: number; path: string } | undefined;
        if (!h) break;
        if (byLocation(f, h) < 0) { evict.run(h.id); break; }
      }
      setPlan.run(target, p.rule, f.id);
      if (f.plan && f.plan !== target) releaseName(db, f.plan);
      done++;
    }
  });
  return done;
}
