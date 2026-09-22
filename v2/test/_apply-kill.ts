// Runs one Apply batch and has the process killed outright in the middle of it, the way
// a power cut would: after the Nth file has moved on disk but before the database says so.
// Used by test/recover.test.ts. Arguments: <database> <batch> <after N moves>
import { Db } from "../src/db/db.ts";
import { runBatch } from "../src/apply/apply.ts";
import { nativeFsOps } from "../src/apply/fsops.ts";

const [file, batchArg, afterArg] = process.argv.slice(2);
const db = new Db(file);
const real = nativeFsOps();
let moves = 0;
const after = Number(afterArg ?? 1);
const fx = {
  ...real,
  async move(from: string, to: string) {
    await real.move(from, to);
    if (++moves >= after) {
      // No unwinding, no flush, no "finally": the process simply stops existing.
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
  },
};
await runBatch(db, Number(batchArg), fx);
real.close();
db.close();
console.log("finished without being killed");
