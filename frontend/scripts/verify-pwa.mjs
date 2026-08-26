// Checks that the installable-app metadata is actually installable.
//
// WHY A SCRIPT AND NOT A GLANCE AT THE FILES
//
// Every failure mode here is silent. A manifest missing one required field, an
// icon whose real pixel size disagrees with its declared `sizes`, a service
// worker served with the wrong cache header -- none of them throw, none of
// them log, and none of them show up in the UI. They show up as the install
// button simply not appearing, on someone else's phone, with nothing to read.
//
// So the rules are asserted here instead, in the same spirit as
// backend/scripts/verify-*.js.
//
//   node scripts/verify-pwa.mjs                    static checks only
//   node scripts/verify-pwa.mjs http://localhost:5000   also check live headers
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const INDEX_HTML = path.join(here, "..", "index.html");

const failures = [];
const notes = [];
const check = (ok, message) => (ok ? notes.push(`  ok    ${message}`) : failures.push(`  FAIL  ${message}`));

// --- the manifest ---------------------------------------------------------
const manifestPath = path.join(PUBLIC_DIR, "manifest.webmanifest");
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  notes.push("  ok    manifest.webmanifest is valid JSON");
} catch (err) {
  console.error(`FAIL  manifest.webmanifest is not readable/parseable: ${err.message}`);
  process.exit(1);
}

// Chromium's install criteria. `short_name` is what ends up under the icon on
// a home screen, so an absent one is a silently ugly install, not a hard fail
// -- but it is still wrong, so it is checked.
for (const field of ["name", "short_name", "start_url", "scope", "display", "icons"]) {
  check(manifest[field] !== undefined, `manifest declares "${field}"`);
}
check(
  ["standalone", "fullscreen", "minimal-ui"].includes(manifest.display),
  `display is an installable value (got "${manifest.display}")`
);
check(/^#[0-9a-f]{6}$/i.test(manifest.background_color || ""), "background_color is a hex colour");
check(/^#[0-9a-f]{6}$/i.test(manifest.theme_color || ""), "theme_color is a hex colour");

// --- the icons ------------------------------------------------------------
/** Real pixel dimensions, read from the PNG's IHDR rather than trusted. */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(signature)) throw new Error("not a PNG");
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error("no IHDR chunk");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const pngIcons = (manifest.icons || []).filter((icon) => icon.type === "image/png");
check(pngIcons.length > 0, "manifest lists at least one PNG icon");

for (const icon of manifest.icons || []) {
  const file = path.join(PUBLIC_DIR, icon.src.replace(/^\//, ""));
  if (!fs.existsSync(file)) {
    check(false, `icon file exists: ${icon.src}`);
    continue;
  }
  if (icon.type !== "image/png") {
    check(true, `icon present: ${icon.src} (${icon.sizes})`);
    continue;
  }
  try {
    const { width, height } = pngSize(file);
    const [declaredW, declaredH] = icon.sizes.split("x").map(Number);
    // The mismatch this catches is real: capturePage returns pixels at the
    // display's scale factor, so generating icons on a 150%-scaled Windows
    // machine yields a 288px file happily labelled 192x192, and Chrome
    // rejects the icon without saying why.
    check(
      width === declaredW && height === declaredH,
      `${icon.src} is really ${declaredW}x${declaredH} (measured ${width}x${height})`
    );
  } catch (err) {
    check(false, `${icon.src} is a readable PNG (${err.message})`);
  }
}

// Chromium needs a >=192px icon to offer installation and a >=512px one for
// the splash screen; Android needs a maskable one or it puts the square icon
// inside a white circle.
const anyPurpose = (icon) => (icon.purpose || "any").split(/\s+/);
const largest = (predicate) =>
  Math.max(0, ...(manifest.icons || []).filter(predicate).map((i) => Number(i.sizes.split("x")[0]) || 0));

check(largest((i) => anyPurpose(i).includes("any") && i.type === "image/png") >= 192, "a PNG icon >= 192px with purpose any");
check(largest((i) => anyPurpose(i).includes("any") && i.type === "image/png") >= 512, "a PNG icon >= 512px with purpose any");
check(largest((i) => anyPurpose(i).includes("maskable")) >= 512, "a maskable icon >= 512px");

// --- the service worker ---------------------------------------------------
const swPath = path.join(PUBLIC_DIR, "sw.js");
check(fs.existsSync(swPath), "sw.js exists");
if (fs.existsSync(swPath)) {
  const sw = fs.readFileSync(swPath, "utf8");
  // The single most important property of this worker, asserted so a future
  // edit cannot quietly remove it: /api is never intercepted. Caching an
  // authenticated, live API behind the app's own back is the failure that
  // would be hardest to diagnose and most damaging to trust in the data.
  check(sw.includes('url.pathname.startsWith("/api/")'), "sw.js bypasses /api/");
  check(sw.includes('request.method !== "GET"'), "sw.js ignores non-GET requests");
  check(sw.includes("CACHE_VERSION"), "sw.js has a bumpable CACHE_VERSION");
}

// --- index.html -----------------------------------------------------------
const html = fs.readFileSync(INDEX_HTML, "utf8");
check(/<link[^>]+rel="manifest"/.test(html), "index.html links the manifest");
check(/<meta[^>]+name="theme-color"/.test(html), "index.html sets theme-color");
check(/<link[^>]+rel="apple-touch-icon"/.test(html), "index.html sets apple-touch-icon (iOS reads no manifest icons)");
check(/name="apple-mobile-web-app-capable"/.test(html), "index.html sets apple-mobile-web-app-capable");

// --- live headers, if a server was named ----------------------------------
const baseUrl = process.argv[2];
if (baseUrl) {
  const expectHeader = async (urlPath, header, matcher, description) => {
    try {
      const res = await fetch(new URL(urlPath, baseUrl), { method: "HEAD" });
      const value = res.headers.get(header);
      check(res.ok && matcher(value || ""), `${urlPath}: ${description} (got ${header}: ${value})`);
    } catch (err) {
      check(false, `${urlPath} is reachable (${err.message})`);
    }
  };

  await expectHeader("/manifest.webmanifest", "content-type", (v) => v.includes("manifest+json"), "served as manifest+json");
  await expectHeader("/sw.js", "content-type", (v) => v.includes("javascript"), "served as javascript");
  // A cached sw.js is the one failure a hard refresh cannot clear, because
  // the stale worker is what answers the reload.
  await expectHeader("/sw.js", "cache-control", (v) => v.includes("no-cache"), "is not cacheable");
  await expectHeader("/", "cache-control", (v) => v.includes("no-cache"), "index.html is not cacheable");
}

console.log(notes.join("\n"));
if (failures.length) {
  console.error("\n" + failures.join("\n"));
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} PWA checks passed.`);
