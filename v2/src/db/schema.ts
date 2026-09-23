// Schema, as forward-only migrations. Deliberately small: two hot tables
// (files, contents), text + search, the file-operation journal, sessions.
//
// files     one row per PATH seen under a root. Its `state` is the whole
//           lifecycle; the partial index files_todo holds only pending rows,
//           so the scheduler's "what next" query stays cheap at any size.
// contents  one row per unique SHA-256. Everything learned by reading bytes
//           (type, text quality, title, dates, OCR) lives here, so a duplicate
//           costs one read+hash and inherits the rest.
import type { Db } from "./db.ts";
import { planKey } from "../plan/key.ts";

/** A migration is SQL, or a function for what SQL cannot do (each runs in one transaction). */
export const MIGRATIONS: (string | ((db: Db) => void))[] = [
  `
  CREATE TABLE roots(
    id        INTEGER PRIMARY KEY,
    path      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role      TEXT NOT NULL DEFAULT 'source' CHECK (role IN ('source', 'library', 'backup')),
    enabled   INTEGER NOT NULL DEFAULT 1,
    online    INTEGER NOT NULL DEFAULT 1,
    volume    TEXT,
    fs        TEXT,
    gen       INTEGER NOT NULL DEFAULT 0,
    scan_at   INTEGER,
    scan_ms   INTEGER,
    scan_files INTEGER,
    scan_error TEXT,
    created   INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE files(
    id      INTEGER PRIMARY KEY,
    root    INTEGER NOT NULL,
    path    TEXT NOT NULL,              -- relative to the root, '/' separated, original case
    size    INTEGER NOT NULL,
    mtime   INTEGER NOT NULL,           -- ms since epoch
    ctime   INTEGER NOT NULL DEFAULT 0,
    attrs   INTEGER NOT NULL DEFAULT 0, -- Windows attributes (placeholder detection)
    fid     TEXT,                       -- volume:fileid on NTFS/ReFS = physical identity
    seen    INTEGER NOT NULL,           -- root scan generation that last saw it
    state   INTEGER NOT NULL DEFAULT 0, -- see pipeline/states.ts
    content INTEGER,                    -- contents.id once hashed
    tries   INTEGER NOT NULL DEFAULT 0,
    err     TEXT,
    plan    TEXT,                       -- planned location in the virtual library ('/' separated)
    rule    TEXT                        -- the rule that produced the plan
  ) STRICT;
  CREATE UNIQUE INDEX files_path ON files(root, path);
  CREATE INDEX files_todo ON files(state) WHERE state < 50;
  CREATE INDEX files_content ON files(content) WHERE content IS NOT NULL;
  CREATE INDEX files_fid ON files(fid) WHERE fid IS NOT NULL;
  CREATE INDEX files_plan ON files(plan) WHERE plan IS NOT NULL;

  CREATE TABLE contents(
    id      INTEGER PRIMARY KEY,
    sha     BLOB NOT NULL UNIQUE,       -- 32-byte SHA-256: the only proof of identity
    size    INTEGER NOT NULL,
    kind    TEXT NOT NULL DEFAULT '',   -- image|video|audio|pdf|doc|sheet|slides|text|archive|other
    mime    TEXT,
    state   INTEGER NOT NULL DEFAULT 0, -- 0 = hashed only, 10 = analyzed
    ocr     INTEGER NOT NULL DEFAULT 0, -- 0 n/a, 1 pending, 2 done, 3 failed, 4 no engine
    quality TEXT,                       -- text quality verdict
    lang    TEXT,
    dtype   TEXT,                       -- document type from content keywords
    title   TEXT,
    ddate   INTEGER,                    -- document/capture date (ms)
    dsrc    TEXT,
    width   INTEGER,
    height  INTEGER,
    pages   INTEGER,
    meta    TEXT,                       -- small JSON: camera, heading, pdf producer...
    tlen    INTEGER NOT NULL DEFAULT 0,
    av      INTEGER NOT NULL DEFAULT 0  -- analyzer version that produced this row
  ) STRICT;
  CREATE INDEX contents_ocr ON contents(ocr) WHERE ocr = 1;
  CREATE INDEX contents_title ON contents(title) WHERE title IS NOT NULL;

  CREATE TABLE texts(
    content INTEGER NOT NULL,
    src     TEXT NOT NULL,              -- 'x' extracted, 'o' OCR
    body    TEXT NOT NULL,
    PRIMARY KEY (content, src)
  ) STRICT;

  -- Contentless indexes: the text lives once, in texts / files. rowid = content id.
  CREATE VIRTUAL TABLE fts_text USING fts5(body, tokenize = 'unicode61 remove_diacritics 2', content = '', contentless_delete = 1);
  -- rowid = file id; normalized relative path, trigram for substrings (invoice numbers, partial names).
  CREATE VIRTUAL TABLE fts_name USING fts5(name, tokenize = 'trigram remove_diacritics 1', content = '', contentless_delete = 1);

  -- The journal. A row is written (durably) BEFORE the filesystem is touched.
  CREATE TABLE ops(
    id     INTEGER PRIMARY KEY,
    batch  INTEGER NOT NULL,
    kind   TEXT NOT NULL,               -- 'link' | 'lnk' | 'move' | 'quarantine' | 'restore'
    file   INTEGER,
    src    TEXT NOT NULL,
    dst    TEXT NOT NULL,
    fid    TEXT,
    size   INTEGER,
    mtime  INTEGER,
    state  INTEGER NOT NULL DEFAULT 0,  -- 0 planned, 1 started, 2 done, 3 failed, 4 undone
    err    TEXT,
    t0     INTEGER,
    t1     INTEGER
  ) STRICT;
  CREATE INDEX ops_open ON ops(state) WHERE state < 2;

  CREATE TABLE sessions(
    token   TEXT PRIMARY KEY,           -- sha256 of the cookie value, never the value itself
    created INTEGER NOT NULL,
    seen    INTEGER NOT NULL,
    remote  INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  `,
  // 2: a folder chosen by hand, which beats the filing rules. Plan-only: moving a
  // file in the library changes where it WOULD go, never where it is on disk.
  `ALTER TABLE files ADD COLUMN pin TEXT;`,
  // 3: the same idea for the name. Renaming in Atlas renames the file in the
  // PLAN; the bytes on disk keep the name they have until apply exists.
  `ALTER TABLE files ADD COLUMN pinname TEXT;`,
  // 4: a failure is kept, not retried every scan. Two kinds (pipeline/states.ts):
  //   content  the bytes themselves defeat the reader (hung parser, crash). Terminal
  //            until the file changes, `fsig` (analyzer version + limits) changes,
  //            or someone asks for a retry.
  //   access   the file could not be reached (locked, denied, still being written,
  //            too slow). Tried again at `fnext`, backing off 1 h -> 6 h -> 24 h.
  // The same for OCR, per content: `onext`/`orounds` defer a reading that failed
  // for a passing reason; `osig` is the OCR version a real failure was seen with.
  `
  ALTER TABLE files ADD COLUMN fclass TEXT;
  ALTER TABLE files ADD COLUMN fsig TEXT;
  ALTER TABLE files ADD COLUMN fnext INTEGER;
  ALTER TABLE files ADD COLUMN frounds INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE contents ADD COLUMN osig TEXT;
  ALTER TABLE contents ADD COLUMN onext INTEGER;
  ALTER TABLE contents ADD COLUMN orounds INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX files_failed ON files(fnext) WHERE state = 90;
  -- Failures recorded before failures had a kind: one fresh attempt each, to classify them.
  UPDATE files SET state = 0, tries = 0 WHERE state = 90;
  UPDATE contents SET ocr = 1 WHERE ocr = 3;
  `,
  // 5: the filesystem model (docs/18 Phase 4).
  //   files.missed   when a complete scan first failed to see the file (NULL = present). A
  //                  file is only MISSING once a LATER complete scan, at least 10 minutes on,
  //                  still does not see it: one bad listing, a drive that blinked, an editor
  //                  saving by delete-and-rename, is not a deletion.
  //   files.seenat   the scan before that - when the file was last known to be there.
  //   files.born     when a row was first seen. With seenat, it tells "a copy that turned up
  //                  when the other one vanished" (a move to another drive) from "a copy that
  //                  was always there" (NULL = before this was recorded: never assumed new).
  //   roots.seen_volume  a DIFFERENT volume found at the root's path (another disk under the
  //                  same letter): nothing is scanned until someone says it is the same folder.
  `
  ALTER TABLE files ADD COLUMN missed INTEGER;
  ALTER TABLE files ADD COLUMN seenat INTEGER;
  ALTER TABLE files ADD COLUMN born INTEGER;
  ALTER TABLE roots ADD COLUMN seen_volume TEXT;
  CREATE INDEX files_intent ON files(state) WHERE pin IS NOT NULL OR pinname IS NOT NULL;
  `,
  // 6: Apply (docs/18 Phase 6).
  //   files.plankey  the planned path as the disk compares it (plan/key.ts): collisions are
  //                  decided on this, so two names differing only in case never share a place.
  //   ops            what Apply must prove and restore: the content's SHA-256, the creation
  //                  time to keep on a copy, rename or copy, the temporary name of a copy, the
  //                  last step done (for people; recovery trusts the disk), the files row
  //                  before and after, and the op an undo reverses.
  `
  ALTER TABLE files ADD COLUMN plankey TEXT;
  CREATE INDEX files_plankey ON files(plankey) WHERE plankey IS NOT NULL;
  ALTER TABLE ops ADD COLUMN sha BLOB;
  ALTER TABLE ops ADD COLUMN birth INTEGER;
  ALTER TABLE ops ADD COLUMN mode TEXT;
  ALTER TABLE ops ADD COLUMN tmp TEXT;
  ALTER TABLE ops ADD COLUMN step TEXT;
  ALTER TABLE ops ADD COLUMN sroot INTEGER;
  ALTER TABLE ops ADD COLUMN spath TEXT;
  ALTER TABLE ops ADD COLUMN droot INTEGER;
  ALTER TABLE ops ADD COLUMN dpath TEXT;
  ALTER TABLE ops ADD COLUMN undoes INTEGER;
  CREATE INDEX ops_batch ON ops(batch);
  `,
  // 7: fill plankey; files already planned into one place (differing only in case) are
  // planned again, and the planner now numbers the second one.
  (db) => {
    const set = db.q("UPDATE files SET plankey = ? WHERE id = ?");
    const seen = new Set<string>();
    const clash = new Set<string>();
    for (const r of db.all<{ id: number; plan: string }>("SELECT id, plan FROM files WHERE plan IS NOT NULL ORDER BY id")) {
      const k = planKey(r.plan);
      set.run(k, r.id);
      if (seen.has(k)) clash.add(k); else seen.add(k);
    }
    for (const k of clash) db.run("UPDATE files SET state = 20 WHERE plankey = ? AND state = 50", k);
  },
  // 8: the work queue index carries the id as well as the state (docs/18 Phase 9).
  //   files_todo(state) could find the files waiting to be read or planned, but not hand
  //   them over IN ORDER, so "the next ones to plan" (state, then id) was answered by
  //   reading the whole table - on every pass of the loop, ten times a second. Invisible
  //   at five thousand files; at two hundred thousand it was most of the machine's work,
  //   and it grew with the library. With the id in the index, it is a seek.
  `
  DROP INDEX IF EXISTS files_todo;
  CREATE INDEX files_todo ON files(state, id) WHERE state < 50;
  `,
];
