// A stand-in directory lister (ATLAS_WALKER), for faults the real one cannot be made to
// produce on demand. It speaks the same line protocol as bin/atlas-walk.exe:
//   V<TAB>volume<TAB>filesystem   D<TAB>dir   F<TAB>name<TAB>size<TAB>mtime<TAB>ctime<TAB>attrs<TAB>id
//   Z                             the listing reached the end (without this, nothing is
//                                 concluded from it, whatever the exit code)
//
// ATLAS_WALKER_FAULT picks the behaviour:
//   none (default) a faithful listing, to the end - the reference the faults are compared against
//   hang           lists two files, then goes quiet for ever (a share whose server died)
//   halfway        lists two files, then exits 0 as if all were well, with no end mark
//   silent         says nothing at all, ever
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const fault = process.env.ATLAS_WALKER_FAULT || "none";
const out = (line: string) => process.stdout.write(line + "\n");
const forever = () => setInterval(() => {}, 1 << 30);

if (fault === "silent") {
  forever();
} else {
  const st = fs.statSync(root);
  out(`V\t${BigInt(st.dev).toString(16).padStart(8, "0")}\tNTFS`);
  const walk = (rel: string): boolean => {
    out(`D\t${rel.replaceAll("/", "\\")}`);
    const entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    for (const e of entries.filter((x) => x.isFile())) {
      const s = fs.statSync(path.join(root, rel, e.name));
      out(`F\t${e.name}\t${s.size}\t${Math.floor(s.mtimeMs)}\t${Math.floor(s.birthtimeMs)}\t32\t${s.ino.toString(16)}`);
      listed++;
      if (fault !== "none" && listed >= 2) return false; // the share stops answering here
    }
    for (const e of entries.filter((x) => x.isDirectory())) if (!walk(rel ? `${rel}/${e.name}` : e.name)) return false;
    return true;
  };
  let listed = 0;
  const finished = walk("");
  if (finished) { out("Z"); process.exit(0); }
  if (fault === "halfway") process.exit(0); // gone, with half the folder unlisted and no end mark
  forever();                                // hang: still "listing", for ever
}
