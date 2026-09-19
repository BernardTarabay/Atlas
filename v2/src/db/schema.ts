// Schema, as forward-only migrations. Deliberately small: two hot tables
// (files, contents), text + search, the file-operation journal, sessions.
//
// files     one row per PATH seen under a root. Its `state` is the whole
//           lifecycle; the partial index files_todo holds only pending rows,
//           so the scheduler's "what next" query stays cheap at any size.
// contents  one row per unique SHA-256. Everything learned by reading bytes
//           (type, text quality, title, dates, OCR) lives here, so a duplicate
//           costs one read+hash and inherits the rest.
export const MIGRATIONS: string[] = [
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
];
