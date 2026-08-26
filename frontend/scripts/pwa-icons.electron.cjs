// Runs inside Electron. See generate-pwa-icons.mjs for why.
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const OUT_DIR = path.resolve(__dirname, "..", "public");

// The Atlas mark, lifted verbatim from public/favicon.svg (viewBox 0 0 48 46).
const MARK_PATH =
  "M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z";

// index.css: --color-brand-500 / --color-brand-700. Moved from violet to
// blue with the palette; keep these in step with the tokens or the installed
// app icon stops matching the app it opens.
const BRAND_FROM = "#3b82f6";
const BRAND_TO = "#1d4ed8";

/**
 * @param {number} size      output edge length in px
 * @param {number} markScale fraction of the canvas the mark's height occupies
 * @param {number} radius    corner radius in px (0 = full bleed, for maskable)
 */
function html(size, markScale, radius) {
  const markHeight = Math.round(size * markScale);
  const markWidth = Math.round((markHeight * 48) / 46);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
    .tile{width:${size}px;height:${size}px;border-radius:${radius}px;
      background:linear-gradient(135deg,${BRAND_FROM},${BRAND_TO});
      display:flex;align-items:center;justify-content:center}
    svg{display:block;width:${markWidth}px;height:${markHeight}px}
  </style></head><body>
    <div class="tile"><svg viewBox="0 0 48 46" xmlns="http://www.w3.org/2000/svg">
      <path fill="#ffffff" d="${MARK_PATH}"/>
    </svg></div>
  </body></html>`;
}

// markScale is the load-bearing number per target:
//  - standard icons sit on their own tile, so the mark can be generous
//  - MASKABLE is cropped by the OS to an arbitrary shape; only the centre
//    circle of diameter 80% is guaranteed visible, so the mark is smaller and
//    the tile is full-bleed (radius 0) -- rounding corners here would show as
//    clipped notches once Android applies its own mask on top
//  - apple-touch-icon is masked by iOS too, but to a known squircle, and iOS
//    renders no transparency -- so full-bleed with a middling mark
const TARGETS = [
  { file: "icon-192.png", size: 192, markScale: 0.5, radius: 42 },
  { file: "icon-512.png", size: 512, markScale: 0.5, radius: 112 },
  { file: "icon-maskable-512.png", size: 512, markScale: 0.4, radius: 0 },
  { file: "apple-touch-icon.png", size: 180, markScale: 0.48, radius: 0 },
];

// One window, reused. Creating a fresh BrowserWindow per icon looked tidier
// but the second offscreen window's loadURL reliably failed with ERR_FAILED
// (-2) while the first one's teardown was still in flight. Reusing a single
// window sidesteps the teardown race entirely, and resizing it per target is
// cheaper anyway.
//
// The page is written to a temp FILE rather than passed as a data: URL --
// a 1.5KB data URL is within spec but leaves the failure mode above hard to
// tell apart from a URL-length problem, and loadFile makes the rendered page
// inspectable when an icon comes out wrong.
let win = null;

async function render({ file, size, markScale, radius }, tmpDir) {
  const pagePath = path.join(tmpDir, `icon-${size}-${radius}.html`);
  fs.writeFileSync(pagePath, html(size, markScale, radius), "utf8");

  win.setContentSize(size, size);
  await win.loadFile(pagePath);
  // One frame to let the gradient and the path actually paint before capture.
  await new Promise((resolve) => setTimeout(resolve, 150));

  const captured = await win.webContents.capturePage();
  // Capture comes back at the display's device scale factor, which on a
  // Windows machine at 150% would silently produce a 288px "192px" icon.
  // Resizing to the declared size makes the output independent of whatever
  // display this happens to run on -- the manifest's `sizes` must not lie.
  const exact =
    captured.getSize().width === size
      ? captured
      : captured.resize({ width: size, height: size, quality: "best" });

  fs.writeFileSync(path.join(OUT_DIR, file), exact.toPNG());
  console.log(`  ${file}  ${exact.getSize().width}x${exact.getSize().height}`);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-pwa-icons-"));
  win = new BrowserWindow({
    width: 512,
    height: 512,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { sandbox: true },
  });

  try {
    console.log(`Writing PWA icons to ${OUT_DIR}`);
    for (const target of TARGETS) {
      await render(target, tmpDir);
    }
    console.log("Done.");
  } catch (err) {
    // Exit non-zero: a half-written icon set that reports success is worse
    // than an obvious failure, because the manifest keeps pointing at sizes
    // that are no longer there.
    console.error(`Icon generation failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    win.destroy();
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
