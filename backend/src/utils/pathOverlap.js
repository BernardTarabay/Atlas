// Whether two filesystem paths are the same folder, or one contains the other.
//
// WHY THIS EXISTS
//
// A storage location is a folder Atlas watches and scans. The mirror root is a
// folder Atlas WRITES INTO. Nothing prevented those from being the same place,
// or one from sitting inside the other, and the consequence is not a subtle
// one: the watcher sees the application's own writes, debounces, and queues a
// scan; the scan walks the tree and can enqueue work; that work writes again.
// The system observes itself and never settles.
//
// That is not hypothetical. On this installation a location named "Organized"
// -- the folder the relocate/mirror path writes into -- was registered with
// watch_enabled, and the result was 1,549 scans in a single day against a
// configured rescan interval of 60 minutes. One scan every 56 seconds, each
// one walking the tree, forever.
//
// No debounce value fixes that. A debounce coalesces a BURST into one scan; it
// cannot help when the scan is what causes the next burst. The cycle has to be
// broken structurally, by refusing to watch a folder the application writes
// to, which means something has to be able to answer "do these two paths
// overlap?" -- hence this module rather than an inline comparison at each of
// the three call sites that need it.
//
// CASE SENSITIVITY
//
// Compared case-insensitively on Windows and case-sensitively elsewhere,
// matching how the respective filesystems actually behave. Getting this
// backwards on Windows would let "C:\Organized" and "C:\organized" register as
// two distinct locations for one directory -- which is precisely the class of
// bug the containment check exists to prevent, reintroduced by the comparison
// itself.
const path = require("path");

const IS_WINDOWS = process.platform === "win32";

/**
 * A path in the canonical form the comparisons below assume.
 *
 * `path.resolve` collapses "..", normalises separators and makes the path
 * absolute, so "C:\Docs", "C:\Docs\" and "C:\Docs\Finance\.." all reduce to
 * the same string. Without that, containment is trivially defeated by a
 * trailing slash -- the same reasoning storageLocationService.normalizeRootPath
 * already applies to registration, generalised so the watcher gets it too.
 *
 * @param {string} p
 * @returns {string|null} null when there is no usable path
 */
function canonical(p) {
  const value = String(p ?? "").trim();
  if (!value) return null;
  const resolved = path.resolve(value);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

/**
 * Is `inner` the same folder as `outer`, or somewhere beneath it?
 *
 * The `outer + sep` test is the important half. A bare `startsWith` would
 * report "C:\Data-Archive" as living inside "C:\Data", because the string
 * genuinely does start with it -- the separator is what makes it a path
 * comparison rather than a text one. Same reasoning as utils/pathSafety.js,
 * which guards the other direction (escaping a root rather than colliding
 * with one).
 *
 * @param {string} outer
 * @param {string} inner
 * @returns {boolean}
 */
function contains(outer, inner) {
  const a = canonical(outer);
  const b = canonical(inner);
  if (!a || !b) return false;
  return b === a || b.startsWith(a + path.sep);
}

/**
 * Do these two paths refer to overlapping regions of the filesystem?
 *
 * True when they are the same folder, or either contains the other. This is
 * the question a caller actually has -- "can writing in one of these be seen
 * from the other" -- and it is symmetric, unlike `contains`.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function overlaps(a, b) {
  return contains(a, b) || contains(b, a);
}

/**
 * How `inner` relates to `outer`, for an error message that says something
 * useful.
 *
 * "That folder overlaps another one" leaves the user to work out which way
 * round and therefore what to do about it. "That folder is inside X" and
 * "That folder contains X" point at different fixes, so the distinction is
 * worth carrying.
 *
 * @returns {"same"|"inside"|"contains"|null} null when they do not overlap
 */
function relationship(outer, inner) {
  const a = canonical(outer);
  const b = canonical(inner);
  if (!a || !b) return null;
  if (a === b) return "same";
  if (b.startsWith(a + path.sep)) return "inside";
  if (a.startsWith(b + path.sep)) return "contains";
  return null;
}

module.exports = { canonical, contains, overlaps, relationship, IS_WINDOWS };
