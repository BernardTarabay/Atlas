const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const { canonical, contains, overlaps, relationship, IS_WINDOWS } = require("../src/utils/pathOverlap");

// Built from the platform's own separator so the same assertions are true on
// Windows and POSIX. Hard-coding "C:\..." would make this suite pass on the
// machine it was written on and fail everywhere else, which is worse than no
// test -- the guard it covers is the one thing standing between this install
// and a 7.8-million-row queue table.
const root = path.resolve(path.sep, "atlas");
const under = (...parts) => path.join(root, ...parts);

test("canonical collapses the forms that mean the same folder", () => {
  const forms = [under("docs"), under("docs") + path.sep, under("docs", "finance", "..")];
  const [first, ...rest] = forms.map(canonical);
  for (const form of rest) assert.strictEqual(form, first);
});

test("canonical refuses empty input rather than resolving to the cwd", () => {
  // path.resolve("") returns process.cwd(), which would make an empty root_path
  // silently overlap everything beneath the working directory.
  assert.strictEqual(canonical(""), null);
  assert.strictEqual(canonical("   "), null);
  assert.strictEqual(canonical(null), null);
  assert.strictEqual(canonical(undefined), null);
});

test("contains is true for the folder itself and for descendants", () => {
  assert.ok(contains(root, root));
  assert.ok(contains(root, under("docs")));
  assert.ok(contains(root, under("docs", "2019", "invoices")));
});

test("contains is false in the upward direction", () => {
  assert.ok(!contains(under("docs"), root));
});

test("a sibling with a shared name PREFIX is not contained", () => {
  // The bug this exists to prevent: "/atlas-archive" genuinely starts with
  // "/atlas" as a string, and a bare startsWith would call it a descendant.
  const sibling = path.resolve(path.sep, "atlas-archive");
  assert.ok(!contains(root, sibling));
  assert.ok(!overlaps(root, sibling));
  assert.strictEqual(relationship(root, sibling), null);
});

test("overlaps is symmetric where contains is not", () => {
  const child = under("docs");
  assert.ok(overlaps(root, child));
  assert.ok(overlaps(child, root));
  assert.ok(!contains(child, root));
});

test("relationship distinguishes the two directions and equality", () => {
  assert.strictEqual(relationship(root, root), "same");
  assert.strictEqual(relationship(root, under("docs")), "inside");
  assert.strictEqual(relationship(under("docs"), root), "contains");
});

test("unrelated trees do not overlap", () => {
  const other = path.resolve(path.sep, "elsewhere", "docs");
  assert.ok(!overlaps(root, other));
  assert.strictEqual(relationship(root, other), null);
});

test("case sensitivity follows the platform", () => {
  const upper = under("DOCS");
  const lower = under("docs");
  // On Windows these are one directory; on Linux they are two. Asserting the
  // platform's actual behaviour rather than a fixed answer is the point --
  // treating them as distinct on Windows would let one folder be registered
  // twice, which is exactly what the guard is for.
  assert.strictEqual(overlaps(upper, lower), IS_WINDOWS);
});
