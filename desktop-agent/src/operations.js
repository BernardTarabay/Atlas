// Executes the typed operations the backend issues
// (docs/04-storage-architecture.md §4.5).
//
// The agent never receives a shell command and never an arbitrary path --
// only one of the operation types below, carrying a path the backend has
// already validated against the Storage Location root and the agent's
// registered directories.
//
// Even so, EVERY path is re-validated here against the local root before it
// is touched. That is not redundant: §4.5 says a compromised agent must not
// become arbitrary filesystem access, and the symmetric statement is that a
// compromised *backend* (or a bug in it) must not either. The agent owns
// the machine's safety; it does not delegate that to the server it happens
// to be talking to. This mirrors backend/src/utils/pathSafety.js on purpose
// -- the two implementations are independent by design, not shared.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// Refuses to read a file larger than this into memory for transport. The
// backend ships file bytes base64-encoded in an operation result (see
// AgentStorageService.readStream), which is fine for documents and wrong
// for media; failing loudly at the boundary beats an OOM on the user's
// laptop.
//
// THIS NUMBER IS HALF OF A PAIR. The other half is AGENT_RESULT_BODY_LIMIT in
// backend/src/routes/agentRoutes.js, and they must move together: base64
// inflates by 4/3, so the backend parser has to accept ~1.34x whatever is
// allowed here or the transfer dies with a 413 that reads like a server fault.
//
// For most of this agent's life the pair was silently inconsistent in the
// worse direction. This constant said 64MB while the backend's GLOBAL 1MB JSON
// limit -- written when nothing in that API carried bytes -- rejected anything
// over roughly 750KB. The advertised ceiling was 85x the real one, and the real
// one was an accident.
//
// WHAT THIS CEILING IS ACTUALLY FOR, AND WHY IT IS NOT LARGER
//
// It bounds peak memory, not file size in principle. Shipping one file holds,
// simultaneously: the raw buffer, its base64 string (+1.34x), and the
// JSON-serialised body (another near-copy) -- so a 200MB file transiently needs
// roughly 600-800MB on a laptop that is also running everything else its owner
// has open, and the same again on the server decoding it. There is also no
// resume: this is one POST, and a drop at 95% resends everything.
//
// 200MB is therefore a considered stopgap rather than a target. Past this,
// raising the constant stops being the fix -- see the chunked-transfer note in
// README.md's known gaps, which is the design that makes memory flat in file
// size and a dropped connection cost one chunk instead of the whole transfer.
const MAX_READ_BYTES = parseInt(
  process.env.AGENT_MAX_READ_BYTES || String(200 * 1024 * 1024),
  10
);

class PathEscapeError extends Error {}

function resolveWithinRoot(rootPath, relativePath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(root, relativePath || ".");
  // Compare against root + separator so a sibling directory sharing the
  // root's name prefix ("/data/repo-evil" vs "/data/repo") is rejected.
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new PathEscapeError(`Path "${relativePath}" resolves outside the agent's root.`);
  }
  return target;
}

function assertWithinRegistered(rootPath, relativePath, registeredDirectories = []) {
  if (!registeredDirectories || registeredDirectories.length === 0) return;

  const normalized = path
    .normalize(String(relativePath || "."))
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

  const allowed = registeredDirectories.some((dir) => {
    const d = String(dir).replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
    if (d === "" || d === ".") return true;
    return normalized === d || normalized.startsWith(`${d}/`);
  });

  if (!allowed) {
    throw new PathEscapeError(
      `Path "${relativePath}" is not inside a directory this agent was registered for.`
    );
  }
}

/** Incremental walk yielding root-relative entries; never builds the whole tree. */
async function* walk(rootPath, dirAbsolute) {
  let entries;
  try {
    entries = await fsp.readdir(dirAbsolute, { withFileTypes: true });
  } catch (err) {
    // An unreadable subdirectory (permissions, a vanished mount) must not
    // abort the entire scan -- the rest of the repository is still valid.
    if (["EACCES", "EPERM", "ENOENT"].includes(err.code)) return;
    throw err;
  }

  for (const entry of entries) {
    const absolute = path.join(dirAbsolute, entry.name);
    if (entry.isDirectory()) {
      yield* walk(rootPath, absolute);
    } else if (entry.isFile()) {
      try {
        const s = await fsp.stat(absolute);
        yield {
          name: entry.name,
          path: path.relative(rootPath, absolute).replace(/\\/g, "/"),
          size: s.size,
          mtime: s.mtime.toISOString(),
          ctime: s.birthtime ? s.birthtime.toISOString() : s.ctime.toISOString(),
        };
      } catch {
        // Same reasoning: skip the one entry, keep the scan going.
      }
    }
  }
}

/**
 * Creates an executor bound to one root path and registered-directory set.
 *
 * @param {object} opts
 * @param {string} opts.rootPath
 * @param {string[]} opts.registeredDirectories
 */
function createExecutor({ rootPath, registeredDirectories = [] }) {
  const guard = (relativePath) => {
    assertWithinRegistered(rootPath, relativePath, registeredDirectories);
    return resolveWithinRoot(rootPath, relativePath);
  };

  const handlers = {
    async list_directory({ path: startPath = ".", cursor = null, pageSize = 500 }) {
      const start = guard(startPath);
      const entries = [];
      let skipped = 0;
      const skipTo = cursor ? Number(cursor) : 0;

      for await (const entry of walk(rootPath, start)) {
        // Cursor is an offset into a stable-ordered walk. Simple, and
        // correct as long as the tree isn't being rewritten mid-scan --
        // in which case the next scan reconciles anyway (docs/04 §4.6).
        if (skipped < skipTo) {
          skipped += 1;
          continue;
        }
        entries.push(entry);
        if (entries.length >= pageSize) break;
      }

      const nextCursor = entries.length === pageSize ? String(skipTo + entries.length) : null;
      return { entries, nextCursor };
    },

    async stat({ path: targetPath }) {
      const absolute = guard(targetPath);
      try {
        const s = await fsp.stat(absolute);
        return {
          exists: true,
          size: s.size,
          mtime: s.mtime.toISOString(),
          ctime: s.birthtime ? s.birthtime.toISOString() : s.ctime.toISOString(),
        };
      } catch (err) {
        if (err.code === "ENOENT") return { exists: false, size: 0, mtime: null, ctime: null };
        throw err;
      }
    },

    async read_file({ path: targetPath }) {
      const absolute = guard(targetPath);
      const s = await fsp.stat(absolute);
      if (s.size > MAX_READ_BYTES) {
        throw new Error(
          `File is ${s.size} bytes, above the agent's ${MAX_READ_BYTES}-byte transport limit.`
        );
      }
      const buffer = await fsp.readFile(absolute);
      return { contentBase64: buffer.toString("base64"), size: s.size };
    },

    async rename({ path: currentPath, newFileName, targetRelativeDir = null }) {
      const current = guard(currentPath);
      if (!newFileName || /[\\/]/.test(newFileName)) {
        // A separator here would redirect the rename into another directory,
        // bypassing the targetRelativeDir check below.
        throw new PathEscapeError("newFileName must be a bare filename with no path separators.");
      }

      const targetDir = targetRelativeDir ? guard(targetRelativeDir) : path.dirname(current);
      await fsp.mkdir(targetDir, { recursive: true });

      const target = resolveWithinRoot(rootPath, path.relative(rootPath, path.join(targetDir, newFileName)));
      await fsp.rename(current, target);
      return { newPath: path.relative(rootPath, target).replace(/\\/g, "/") };
    },

    async move({ fromPath, toPath }) {
      const from = guard(fromPath);
      const to = guard(toPath);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      return { newPath: path.relative(rootPath, to).replace(/\\/g, "/") };
    },

    async remove({ path: targetPath }) {
      await fsp.unlink(guard(targetPath));
      return { removed: true };
    },
  };

  return {
    async execute(operationType, payload) {
      const handler = handlers[operationType];
      if (!handler) throw new Error(`Unsupported operation type "${operationType}".`);
      return handler(payload || {});
    },
    supportedOperations: Object.keys(handlers),
  };
}

module.exports = {
  createExecutor,
  resolveWithinRoot,
  assertWithinRegistered,
  PathEscapeError,
  MAX_READ_BYTES,
};
