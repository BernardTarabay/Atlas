// The file lifecycle. One integer per file; the database always knows where
// every file is, and restarting simply resumes every row below DONE.
//
//   NEW     discovered or changed; needs read + hash (+ analysis if the content is new)
//   IDENT   hashed and linked to a content row (or a cloud placeholder, which is never read);
//           needs planning
//   DONE    planned into the virtual library (or recognized as a copy of a planned file)
//   MISSING not seen by the last complete scan of its root
//   FAILED  could not be read after config.maxTries attempts; retried on the next scan
export const S = { NEW: 0, IDENT: 20, DONE: 50, MISSING: 70, FAILED: 90 } as const;

/** FILE_ATTRIBUTE_OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS: reading would trigger a cloud download. */
export const PLACEHOLDER_ATTRS = 0x1000 | 0x40000 | 0x400000;

export const isPlaceholder = (attrs: number) => (attrs & PLACEHOLDER_ATTRS) !== 0;

/** Content analysis levels. */
export const C = { HASHED: 0, ANALYZED: 10 } as const;

/** contents.ocr */
export const OCR = { NA: 0, PENDING: 1, DONE: 2, FAILED: 3, NO_ENGINE: 4 } as const;
