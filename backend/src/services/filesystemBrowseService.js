// Server-side folder picker for registering a storage location.
//
// Hand-typing an absolute path is error-prone (normalizeRootPath() exists
// purely to patch around Windows "Copy as path" quoting), so this lets a user
// click through the backend's own filesystem instead.
//
// WHY THIS IS CONFINABLE RATHER THAN PERMISSION-GATED
//
// The original note here said an unsandboxed picker was fine "because this
// route is gated behind the same user.manage permission as creating a storage
// location". That stopped being true: registering a location moved to
// `storage.manage`, because pointing the app at your own folder is not an act
// of user administration -- and leaving the picker on `user.manage` left the
// primary "Add storage location" button 403ing for exactly the accounts that
// had just been given permission to add one.
//
// A permission was never the right control anyway. On a machine serving two
// accounts the risk is that one enumerates the other's home directory, and no
// per-user scope can narrow a bare directory listing -- there is nothing on it
// to scope BY. Containment can. So browsing is confinable to an explicit set
// of roots via BROWSE_ROOTS.
//
// The DEFAULT is unconfined, which is a deliberate reversal -- see browseRoots
// below for why, and warnIfSharedAndUnconfined for how the risk is surfaced
// when it actually arises.
//
// It returns directory NAMES only, never file contents.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { ValidationError } = require("../validators/validationError");

const IS_WINDOWS = process.platform === "win32";

/**
 * Where browsing is allowed to reach.
 *
 * THE DEFAULT IS UNCONFINED, AND THAT IS A REVERSAL
 *
 * This first shipped defaulting to the backend account's home directory, on
 * the reasoning that a shared server must not let one account enumerate
 * another's files. The reasoning is still right; the default was still wrong,
 * and measurably so -- on a normal Windows install it filtered out every
 * drive including C:\, so the picker offered no drives at all and a folder on
 * D:\ was unreachable. Defending against a second account that does not exist,
 * by breaking the primary function of the application for the account that
 * does, is the wrong trade.
 *
 * This app's actual deployment is self-hosted on the user's own desktop --
 * `fileService.revealInFileManager` spawns the host OS file manager and says
 * so outright. On that machine the backend's filesystem IS the user's
 * filesystem, and a picker that cannot see their external drive is a picker
 * that does not work.
 *
 * So: open by default, confinable by configuration, and the risk is surfaced
 * at boot exactly when it becomes real -- see warnIfSharedAndUnconfined,
 * which fires only once a second account exists.
 *
 *   BROWSE_ROOTS unset      no confinement (the desktop case)
 *   BROWSE_ROOTS=*          the same, stated explicitly
 *   BROWSE_ROOTS=C:\;E:\    exactly these (the shared-server case)
 *
 * @returns {string[]|null} null means no confinement
 */
function browseRoots() {
  const configured = (process.env.BROWSE_ROOTS || "").trim();
  if (!configured || configured === "*") return null;

  return configured
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

/**
 * Say something at boot if this install has grown a second account while the
 * picker is still unconfined.
 *
 * The point of a default is that nobody reads it. A single-user desktop should
 * not have to configure anything; a shared install should not silently expose
 * one user's home directory to another. Checking at startup catches the moment
 * the assumption stops holding, which is the only moment it matters -- and it
 * warns rather than clamping down, because silently narrowing the picker after
 * someone registers a second account would break the first account's setup for
 * reasons they could not possibly connect.
 */
async function warnIfSharedAndUnconfined() {
  try {
    // Lazy require: this module is otherwise database-free and unit-testable.
    const db = require("../config/database");
    const { rows } = await db.query("SELECT count(*)::int AS n FROM users");
    if (rows[0].n <= 1) return;

    // THE WARNING USED TO UNDERSTATE THE PROBLEM, IN A WAY THAT MATTERED.
    //
    // It said the risk was the folder PICKER enumerating the filesystem, and
    // returned early whenever BROWSE_ROOTS was set -- implying that setting it
    // closed the hole. It does not. `browseRoots` is consulted only inside this
    // module; `storageLocationService.create` validates a submitted root_path
    // against nothing at all. So a confined picker stops someone BROWSING to
    // C:\Users\someone-else and does not stop them typing it into the API and
    // scanning it.
    //
    // Enumeration is the smaller half. The larger half is that any account
    // holding `storage.manage` -- which the default "User" role carries -- can
    // register any directory on this machine as their own storage location and
    // then read every file in it through the ordinary download endpoint, as its
    // legitimate owner. Ownership scoping cannot see that: the attacker is not
    // reading someone else's rows, they are creating their own over the same
    // bytes.
    //
    // So this now fires whenever a second account exists, regardless of
    // BROWSE_ROOTS, and says which control actually applies.
    const confined = browseRoots() !== null;

    console.warn(
      `[security] ${rows[0].n} accounts exist on this install. Any of them holding ` +
      "`storage.manage` (which the default \"User\" role does) can register ANY directory on " +
      "this machine as a storage location and read every file in it -- storageLocationService" +
      ".create does not restrict the path. " +
      (confined
        ? "BROWSE_ROOTS is set, which confines the folder picker but NOT this: the picker is a " +
          "convenience, and the API accepts a path directly."
        : "BROWSE_ROOTS is also unset, so the picker can enumerate the whole filesystem too. " +
          `Set BROWSE_ROOTS to limit at least the picker, e.g. BROWSE_ROOTS=${path.resolve(os.homedir())}`) +
      " If these accounts are not all trusted with this machine's filesystem, remove " +
      "`storage.manage` from the roles they hold."
    );
  } catch {
    // A database that is not up yet is the server's problem to report, not
    // this warning's.
  }
}

/**
 * Is `target` inside one of the allowed roots?
 *
 * Compared on the RESOLVED path, so `..` cannot climb out: resolve() collapses
 * the traversal before this ever sees it. The separator suffix on the root is
 * what stops `C:\Usersomething` matching a root of `C:\Users` -- a prefix test
 * without it is the classic way this check is defeated.
 *
 * Case-insensitive on Windows, where `c:\users\me` and `C:\Users\Me` are the
 * same directory and a case-sensitive compare would reject half the paths the
 * picker itself produces.
 */
function isWithinRoots(target, roots) {
  if (roots === null) return true;
  const normalize = (p) => (IS_WINDOWS ? p.toLowerCase() : p);
  const resolved = normalize(path.resolve(target));

  return roots.some((root) => {
    const normalizedRoot = normalize(root);
    if (resolved === normalizedRoot) return true;
    const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
    return resolved.startsWith(withSep);
  });
}

/**
 * Where a user's Desktop actually is.
 *
 * On a machine with OneDrive folder redirection -- extremely common, and the
 * case on this one -- C:\Users\<name>\Desktop does not exist at all; the real
 * Desktop is C:\Users\<name>\OneDrive\Desktop. Starting the picker at the
 * home folder therefore shows 30-odd entries (3D Objects, NetHood, Tracing,
 * ...) with no Desktop among them, and the user has no way to guess they
 * need to go via OneDrive. Resolving it properly is the difference between
 * the picker being usable and not.
 */
function resolveKnownFolder(name) {
  const candidates = [];
  if (process.env.OneDrive) candidates.push(path.join(process.env.OneDrive, name));
  if (process.env.OneDriveCommercial) candidates.push(path.join(process.env.OneDriveCommercial, name));
  candidates.push(path.join(os.homedir(), name));
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isDirectory();
    } catch {
      return false;
    }
  }) || null;
}

/** Drive roots (Windows) or common mount points (POSIX) that exist AND are browsable. */
function listDrives(roots = browseRoots()) {
  const drives = [];
  const keep = (entry) => isWithinRoots(entry.path, roots);

  if (IS_WINDOWS) {
    for (let code = 65; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      try {
        fs.accessSync(root);
        const entry = { name: root, path: root };
        if (keep(entry)) drives.push(entry);
      } catch {
        // Drive letter not mounted -- an unplugged external is normal.
      }
    }
    return drives;
  }

  for (const root of ["/", "/Volumes", "/mnt", "/media"]) {
    try {
      if (fs.statSync(root).isDirectory()) {
        const entry = { name: root, path: root };
        if (keep(entry)) drives.push(entry);
      }
    } catch { /* not present */ }
  }
  return drives;
}

/**
 * The shortcuts shown down the side of the picker. These are the places
 * documents actually live; everything else is reachable by clicking.
 *
 * Filtered to what is reachable, so the picker never offers a shortcut that
 * answers "outside the folders this server allows" when clicked.
 */
function quickAccess(roots = browseRoots()) {
  const entries = [];
  const add = (label, target) => {
    if (!target) return;
    if (!isWithinRoots(target, roots)) return;
    if (!entries.some((e) => e.path === target)) entries.push({ label, path: target });
  };

  add("Desktop", resolveKnownFolder("Desktop"));
  add("Documents", resolveKnownFolder("Documents"));
  add("Downloads", resolveKnownFolder("Downloads"));
  add("Pictures", resolveKnownFolder("Pictures"));

  // The OneDrive root itself, so cloud-synced folders outside Desktop and
  // Documents are one click away.
  if (process.env.OneDrive) add("OneDrive", process.env.OneDrive);
  if (process.env.OneDriveCommercial) add("OneDrive (work)", process.env.OneDriveCommercial);

  add("Home", os.homedir());
  return entries;
}

/**
 * Default landing spot. The Desktop is where people keep the folder they are
 * about to register far more often than the home directory is.
 */
function defaultStartPath(roots = browseRoots()) {
  const desktop = resolveKnownFolder("Desktop");
  if (desktop && isWithinRoots(desktop, roots)) return desktop;
  const home = os.homedir();
  if (isWithinRoots(home, roots)) return home;
  // Confined somewhere that excludes home: start at the first allowed root
  // rather than at a path that will immediately be refused.
  return roots && roots.length ? roots[0] : home;
}

async function listDirectories(rawTargetPath) {
  const roots = browseRoots();
  const resolved = rawTargetPath
    ? path.resolve(String(rawTargetPath).trim())
    : defaultStartPath(roots);

  // Checked BEFORE the stat, so a refused path never reveals whether it
  // exists -- otherwise the error message distinguishes "outside the allowed
  // folders" from "does not exist", which turns this into a probe for what is
  // on the disk.
  if (!isWithinRoots(resolved, roots)) {
    throw new ValidationError(
      `That folder is outside the directories this server allows browsing. ` +
      `Allowed: ${roots.join(", ")}. Set BROWSE_ROOTS to widen it, or type the path directly when ` +
      "registering a location."
    );
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    throw new ValidationError(`Path does not exist or is not accessible: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new ValidationError(`Not a directory: ${resolved}`);
  }

  let entries;
  try {
    entries = await fsp.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    throw new ValidationError(`Cannot list directory (${err.code || err.message}): ${resolved}`);
  }

  const directories = [];
  let fileCount = 0;

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // dotfiles/dirs -- noise here

    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      // Mounted shares/NAS volumes are frequently symlinks -- resolve rather
      // than silently dropping them from the picker.
      try {
        isDir = (await fsp.stat(path.join(resolved, entry.name))).isDirectory();
      } catch {
        continue; // broken symlink
      }
    }

    if (isDir) {
      // A symlink can point outside the allowed roots, which is the one way
      // containment could be walked around without any `..` in the request.
      if (isWithinRoots(path.join(resolved, entry.name), roots)) directories.push(entry.name);
    } else if (entry.isFile()) {
      fileCount += 1;
    }
  }

  directories.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const parentPath = path.dirname(resolved);
  // Do not offer a "up" link that leads out of the sandbox -- a button that
  // exists and then refuses is worse than no button.
  const parent =
    parentPath !== resolved && isWithinRoots(parentPath, roots) ? parentPath : null;

  return {
    path: resolved,
    parent,
    // Surfaced so the picker can say "12 files here" -- registering a folder
    // that turns out to be empty is a confusing way to find out it was the
    // wrong one.
    fileCount,
    directories: directories.map((name) => ({ name, path: path.join(resolved, name) })),
    quickAccess: quickAccess(roots),
    drives: listDrives(roots),
    // So the UI can explain the boundary rather than only enforcing it.
    confinedTo: roots,
  };
}

module.exports = {
  listDirectories, quickAccess, listDrives, defaultStartPath, resolveKnownFolder,
  browseRoots, isWithinRoots, warnIfSharedAndUnconfined,
};
