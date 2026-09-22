// Imported first by tests that touch config: point Atlas at a throwaway home.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ATLAS_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), "atlas-test-"));
process.env.ATLAS_LOG_LEVEL ??= "error";
// Test files are written moments before they are read; the settle window (config.settleMs)
// would make every test wait. Tests of settling itself pass their own window.
process.env.ATLAS_SETTLE_S ??= "0";
