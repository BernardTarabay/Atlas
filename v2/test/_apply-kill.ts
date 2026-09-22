// A harness, not a test: runs one Apply batch and has the process killed outright at a
// chosen point of the protocol, the way a power cut would. Used by test/recover.test.ts
// and bench/apply-crash.ts.
//
//   node test/_apply-kill.ts <database> <batch> <kill point>
//
// Kill points, in the order a move goes through them:
//   before-move      nothing has been touched yet (the op is STARTED)
//   after-move       a same-disk rename has happened; the database does not know
//   after-copy       the copy exists under its temporary name, unproven
//   after-verify     the copy is proven, not yet in place (killed before its creation date)
//   after-place      the copy is in place; the original is still there
//   after-source     the original has been deleted; the database does not know
import { Db } from "../src/db/db.ts";
import { runBatch } from "../src/apply/apply.ts";
import { nativeFsOps } from "../src/apply/fsops.ts";

const [file, batchArg, point = "after-move"] = process.argv.slice(2);
const db = new Db(file);
const real = nativeFsOps();
const isTmp = (p: string) => p.includes(".atlas-");
/** No unwinding, no flush, no "finally": the process simply stops existing. */
const die = async () => { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); };

const fx = {
  ...real,
  async move(from: string, to: string) {
    if (point === "before-move" && !isTmp(from)) await die();
    // In the copy protocol, this same call puts the proven copy in place.
    if (point === "after-place" && isTmp(from)) { await real.move(from, to); await die(); }
    await real.move(from, to);
    if (point === "after-move" && !isTmp(from)) await die();
  },
  async copy(from: string, to: string) {
    // The copy protocol has no plain move to stop before: its first touch is the copy.
    if (point === "before-move") await die();
    await real.copy(from, to);
    if (point === "after-copy") await die();
  },
  async hash(f: string) {
    const sha = await real.hash(f);
    if (point === "after-verify") await die();
    return sha;
  },
  async remove(f: string) {
    await real.remove(f);
    if (point === "after-source" && !isTmp(f)) await die();
  },
};
await runBatch(db, Number(batchArg), fx);
real.close();
db.close();
console.log("finished without being killed");
