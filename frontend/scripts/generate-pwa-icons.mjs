// Rasterises the Atlas mark into the PNG sizes a PWA install needs.
//
// WHY THIS EXISTS RATHER THAN A COMMITTED SET OF PNGs
//
// favicon.svg is the source of truth for the mark. Hand-exported PNGs drift
// from it silently -- the SVG gets tweaked, the install icon does not, and
// nobody notices because the install icon is only ever seen on a phone home
// screen. Regenerating from the SVG keeps them honest.
//
// WHY ELECTRON
//
// Rasterising an arbitrary SVG path needs a renderer. Electron is already a
// devDependency of desktop-agent/, so this adds no new dependency to a repo
// that deliberately carries none for images. It is a build-time tool, run by
// hand when the mark changes -- not part of `npm run build`, because a client
// deployment should never need a browser engine to build the UI.
//
//   node scripts/generate-pwa-icons.mjs        (from frontend/)
//
// Requires desktop-agent/node_modules to be installed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
// Resolved to the real executable, NOT the .bin/electron.cmd shim: since
// Node 20 (CVE-2024-27980) spawning a .cmd without `shell: true` fails with
// EINVAL, and turning the shell on to work around that would put this path
// through cmd.exe quoting for no benefit. electron/path.txt is the package's
// own declaration of where its binary lives.
const electronPkg = path.join(repoRoot, "desktop-agent", "node_modules", "electron");
const electronBin = fs.existsSync(path.join(electronPkg, "path.txt"))
  ? path.join(electronPkg, "dist", fs.readFileSync(path.join(electronPkg, "path.txt"), "utf8").trim())
  : path.join(electronPkg, "dist", process.platform === "win32" ? "electron.exe" : "electron");

if (!fs.existsSync(electronBin)) {
  console.error(
    `Electron not found at ${electronBin}\n` +
      "Run `npm install` in desktop-agent/ first -- this script borrows its Electron."
  );
  process.exit(1);
}

const result = spawnSync(electronBin, [path.join(here, "pwa-icons.electron.cjs")], {
  stdio: "inherit",
  cwd: here,
});
process.exit(result.status ?? 1);
