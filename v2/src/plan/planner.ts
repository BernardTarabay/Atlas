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
import { planKey } from "./key.ts";

interface Cand {
  id: number; root: number; path: string; mtime: number; ctime: number; content: number | null; fid: string | null; plan: string | null; pin: string | null; pinname: string | null;
  role: string; kind: string | null; dtype: string | null; title: string | null; quality: string | null;
  ddate: number | null; dsrc: string | null; meta: string | null; cstate: number | null; sha: string | null;
}

interface Member { id: number; root: number; path: string; mtime: number; fid: string | null; role: string; plan: string | null }
/** Whoever holds one numbered place of one name. */
interface Holder { id: number; root: number; path: string }

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
  // Compared as the disk compares names (plan/key.ts): "Report (2).pdf" follows "REPORT.pdf".
  const key = planKey(plan);
  const slash = key.lastIndexOf("/");
  const [stem, ext] = splitName(key.slice(slash + 1));
  const freed = Number(/ \((\d+)\)$/.exec(stem)?.[1] ?? 1);
  const base = `${key.slice(0, slash)}/${stem.replace(/ \(\d+\)$/, "")} (`;
  const tail = ext ? `%).${ext.replace(/[\\%_]/g, "\\$&")}` : "%)";
  // Only the numbers ABOVE the one given up can move down: "(2)" is unaffected when
  // "(7)" goes. Re-planning the whole group instead made a crowd of files churn - in
  // the 200,000-file benchmark whole groups went back to being planned again and again,
  // and the count of filed files visibly went backwards (docs/18 Phase 9). Giving up the
  // LAST number, the common case, now costs nothing at all.
  const replan = db.q(`UPDATE files SET state = ${S.IDENT} WHERE id = ? AND state = ${S.DONE}`);
  for (const r of db.all<{ id: number; plankey: string }>(
    `SELECT id, plankey FROM files WHERE state = ${S.DONE} AND plankey >= ? AND plankey < ? AND plankey LIKE ? ESCAPE '\\'`,
    base, base.slice(0, -1) + ")", tail)) {
    if (Number(/ \((\d+)\)(\.[^.]*)?$/.exec(r.plankey)?.[1] ?? 1) > freed) replan.run(r.id);
  }
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
     WHERE f.state = ${S.IDENT} AND f.state < ${S.DONE} ORDER BY f.id LIMIT ?`, limit);
  if (!rows.length) return 0;
  const members = db.q(
    `SELECT f.id, f.root, f.path, f.mtime, f.fid, r.role, f.plan FROM files f JOIN roots r ON r.id = f.root
     WHERE f.content = ? AND f.state IN (${S.IDENT}, ${S.DONE})`);
  const setPlan = db.q(`UPDATE files SET plan = ?, plankey = ?, rule = ?, state = ${S.DONE} WHERE id = ?`);
  const clearPlan = db.q(`UPDATE files SET plan = NULL, plankey = NULL, rule = ?, state = ${S.DONE} WHERE id = ?`);
  const replanRep = db.q(`UPDATE files SET state = ${S.IDENT} WHERE id = ? AND state = ${S.DONE}`);
  // Who holds a place is asked the way the disk would: ignoring case (plan/key.ts).
  // All the names taken for one base - the name itself and its numbered forms - read
  // ONCE per batch over the plankey index, then kept up to date in memory as files are
  // placed. Asking the database per attempt ("is (2) free? is (3) free?") is quadratic
  // in the size of a group, and so is re-reading the whole group for every file in it.
  // Real archives are full of files that all want one name: 413 of them in a single
  // group of the 200,000-file benchmark (docs/18 Phase 9).
  const takenNames = db.q(
    `SELECT id, root, path, plankey FROM files
     WHERE plankey = ? OR (plankey >= ? AND plankey < ? AND plankey LIKE ? ESCAPE '\\')`);
  const groups = new Map<string, Map<number, Holder>>();       // base name -> number -> who holds it
  const held = new Map<number, { base: string; n: number }>(); // file -> the place it holds here
  const groupFor = (baseKey: string, prefix: string, numbered: string) => {
    let g = groups.get(baseKey);
    if (g) return g;
    g = new Map<number, Holder>();
    for (const r of takenNames.all(baseKey, prefix, prefix.slice(0, -1) + ")", numbered) as unknown as (Holder & { plankey: string })[]) {
      const n = r.plankey === baseKey ? 1 : Number(/ \((\d+)\)(\.[^.]*)?$/.exec(r.plankey)?.[1] ?? 0);
      if (!n || g.has(n)) continue;
      g.set(n, { id: r.id, root: r.root, path: r.path });
      held.set(r.id, { base: baseKey, n });
    }
    groups.set(baseKey, g);
    return g;
  };
  /** This file no longer holds what it held: evicted, cleared, or placed somewhere else. */
  const release = (id: number) => {
    const w = held.get(id);
    if (!w) return;
    held.delete(id);
    const g = groups.get(w.base);
    if (g?.get(w.n)?.id === id) g.delete(w.n);
  };
  const take = (baseKey: string, n: number, h: Holder) => {
    release(h.id);
    groups.get(baseKey)?.set(n, h);
    held.set(h.id, { base: baseKey, n });
  };
  // Giving up a name re-plans a PLANNED file. A file still waiting to be read (NEW, an
  // edited file keeps its old plan until then) keeps waiting: making it IDENT here would
  // file it without ever reading it.
  const evict = db.q(`UPDATE files SET plan = NULL, plankey = NULL, state = CASE WHEN state = ${S.DONE} THEN ${S.IDENT} ELSE state END WHERE id = ?`);
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
            if (m.id !== f.id && m.plan) { clearPlan.run(m.fid && m.fid === f.fid ? "alias" : "duplicate", m.id); release(m.id); releaseName(db, m.plan); }
          }
        }
      }
      delName.run(f.id);
      addName.run(f.id, nameText(f.path.replaceAll("/", " ")));
      if (!isRep) {
        clearPlan.run(label, f.id);
        release(f.id);
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
      const baseKey = planKey(`${p.folder}/${p.name}`);
      const prefix = planKey(`${p.folder}/${stem} (`);
      const numbered = ext ? `%).${planKey(ext).replace(/[\\%_]/g, "\\$&")}` : "%)";
      const taken = groupFor(baseKey, prefix, numbered);
      let target = "";
      let slot = 1;
      for (let n = 1; ; n++) {
        target = n === 1 ? `${p.folder}/${p.name}` : `${p.folder}/${stem} (${n})${ext ? "." + ext : ""}`;
        slot = n;
        const h = taken.get(n);
        if (!h || h.id === f.id) break;
        if (byLocation(f, h) < 0) { evict.run(h.id); release(h.id); break; }
      }
      take(baseKey, slot, { id: f.id, root: f.root, path: f.path });
      setPlan.run(target, planKey(target), p.rule, f.id);
      if (f.plan && f.plan !== target) releaseName(db, f.plan);
      done++;
    }
  });
  return done;
}
