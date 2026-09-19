// Real-time ingestion: notice a new or changed file in a watched storage
// location and ingest it without anyone pressing "Run scan".
//
// The person this is built for is not going to open the app, click Scan,
// wait, and approve a queue of proposals. He saves a file where he already
// saves files; a few seconds later it should be named, classified and
// findable. Everything else here follows from that.
//
// Built on fs.watch({recursive:true}) rather than a watcher library --
// same "platform over dependency" reasoning as the rest of this codebase.
// The honest limitation: recursive watching is native on Windows and macOS
// but NOT on Linux, where Node would have to walk and watch every
// subdirectory. Rather than pretend, Linux falls back to the periodic
// rescan below, which is the safety net on every platform anyway.
//
// The periodic rescan is not optional even where watching works. Events are
// missed whenever the machine sleeps, a drive is unplugged and reconnected,
// or a sync client writes in bulk. A watcher alone silently drifts; a
// watcher plus a scheduled sweep converges.
const fs = require("fs");
const path = require("path");

const storageLocationRepository = require("../repositories/storageLocationRepository");
const { enqueueJob } = require("../queues");
const { JobType } = require("../models/enums");
const env = require("../config/env");
const pathOverlap = require("../utils/pathOverlap");

const RECURSIVE_SUPPORTED = process.platform === "win32" || process.platform === "darwin";

/**
 * The floor on how often ONE location may be scanned, whatever the events say.
 *
 * This is not the debounce, and it is not a smaller version of it. The debounce
 * (WATCH_DEBOUNCE_MS) coalesces a burst of events into one scan, which is the
 * right answer when a folder is being copied in: the events stop, the scan
 * runs. It is no answer at all when the scan is what CAUSES the next event --
 * then each debounce window closes, fires a scan, and opens a fresh one.
 *
 * That is what happened here. The mirror/relocate path writes into a folder
 * that was itself registered as a watched location, and the result was 1,549
 * scans in one day against a configured rescan interval of 60 minutes: one
 * every 56 seconds, each walking the whole tree. The overlap guard in
 * `watchableLocations` is the real fix and removes the cause. This is the
 * backstop for every other way a folder can be written to while being watched
 * -- a sync client reconciling, an editor autosaving, a backup tool touching
 * mtimes -- none of which this application controls.
 *
 * Sixty seconds is chosen against what a scan is FOR rather than what it
 * costs: it is a safety net for changes the watcher may have missed, and a
 * change that arrived one second ago is still there a minute from now. Real-time
 * ingestion of a genuinely new file is unaffected in the normal case, because
 * the previous scan was minutes or hours ago, not seconds.
 */
const MIN_SCAN_INTERVAL_MS = parseInt(process.env.WATCH_MIN_SCAN_INTERVAL_MS || "60000", 10);

// Directories that generate constant noise and never contain documents.
const IGNORED_SEGMENTS = new Set([
  "node_modules", ".git", ".svn", "$RECYCLE.BIN", "System Volume Information",
  ".Trash", ".Trashes", ".DS_Store", "__pycache__",
]);

// Sync clients and Office write temp files constantly; ingesting them
// produces garbage rows that vanish moments later.
const IGNORED_PATTERNS = [
  /^~\$/,           // Office lock files
  /\.tmp$/i,
  /\.crdownload$/i,
  /\.partial$/i,
  /^\.~lock\./,     // LibreOffice
  /\.swp$/i,
];

function shouldIgnore(relativePath) {
  if (!relativePath) return true;
  const segments = relativePath.split(/[/\\]/);
  if (segments.some((s) => IGNORED_SEGMENTS.has(s))) return true;
  const base = segments[segments.length - 1];
  return IGNORED_PATTERNS.some((re) => re.test(base));
}

/**
 * Split active locations into the ones it is safe to WATCH and the ones that
 * must rely on the periodic sweep instead.
 *
 * THE DISTINCTION, AND WHY IT IS NOT "SKIP THESE ENTIRELY"
 *
 * A folder this application writes into cannot be watched, because the write
 * produces the event that produces the scan that produces the write. But it
 * can still be SWEPT: the periodic pass runs on a timer that no amount of
 * writing can accelerate, so it cannot form a cycle. Dropping these folders
 * altogether would mean a file the user drops into their organized tree by
 * hand is never noticed, which trades a runaway loop for silent data loss.
 *
 * So watching is what gets withheld, and only from folders that overlap:
 *
 *   MIRROR_ROOT        the shortcut tree this application builds and prunes.
 *                      Every sync writes here, so watching it is a guaranteed
 *                      cycle rather than a possible one.
 *   another location   two watchers over one directory means every change is
 *                      seen twice and scanned twice, under two location ids,
 *                      against two sets of file rows for the same bytes. The
 *                      OUTER folder keeps the watch, since its watcher already
 *                      covers everything beneath it.
 *
 * Sorting by path length puts parents before children, so "outer keeps the
 * watch" falls out of the iteration order rather than needing a second pass.
 */
function splitWatchable(locations) {
  const watch = [];
  const sweepOnly = [];

  const byDepth = [...locations].sort(
    (a, b) => String(a.root_path).length - String(b.root_path).length
  );

  for (const location of byDepth) {
    if (env.mirrorRoot && pathOverlap.overlaps(env.mirrorRoot, location.root_path)) {
      sweepOnly.push({ location, why: "it overlaps MIRROR_ROOT, which this application writes into" });
      continue;
    }

    const enclosing = watch.find((accepted) =>
      pathOverlap.overlaps(accepted.root_path, location.root_path)
    );
    if (enclosing) {
      sweepOnly.push({ location, why: `it overlaps the watched location "${enclosing.name}"` });
      continue;
    }

    watch.push(location);
  }

  return { watch, sweepOnly };
}

class StorageWatcher {
  constructor() {
    this.watchers = new Map(); // locationId -> fs.FSWatcher
    this.pending = new Map();  // locationId -> timeout
    this.lastScanAt = new Map(); // locationId -> ms timestamp of the last scan WE queued
    this.warnedSweepOnly = new Set(); // locationId -- so the reason is logged once, not hourly
    this.rescanTimer = null;
    this.started = false;
  }

  /**
   * Queue a scan for one location unless one was queued too recently.
   *
   * The single place a scan is enqueued, so the floor cannot be bypassed by
   * adding a caller. Returns whether it actually queued, which is what lets
   * `sweep` report an honest count.
   */
  async queueScan(location, trigger) {
    const last = this.lastScanAt.get(location.id) || 0;
    const sinceMs = Date.now() - last;

    if (sinceMs < MIN_SCAN_INTERVAL_MS) {
      // Deliberately quiet at debug volume rather than a warning: being asked
      // to scan more often than the floor allows is NORMAL for an active
      // folder, and a line per suppression would be its own noise problem.
      return false;
    }

    this.lastScanAt.set(location.id, Date.now());
    // `trigger` rides in the PAYLOAD, not in opts -- enqueueJob's options are a
    // closed set (owner, location, creator, progress) and an unrecognised key
    // there would be silently dropped. scanProcessor destructures only
    // storageLocationId, so an extra field costs it nothing, and it makes
    // "which scans came from the watcher and which from the timer" answerable
    // from processing_jobs alone. That question had no answer while this was
    // queueing a scan every 56 seconds.
    await enqueueJob(
      JobType.SCAN,
      { storageLocationId: location.id, trigger },
      { storageLocationId: location.id }
    );
    return true;
  }

  async start() {
    if (this.started || !env.watch.enabled) return;
    this.started = true;

    await this.refresh();

    // Re-read the location list periodically so a folder registered while
    // the server is running starts being watched without a restart, and a
    // removed one stops.
    this.rescanTimer = setInterval(() => {
      this.refresh().catch((err) => console.error("[watcher] refresh failed:", err.message));
      this.sweep().catch((err) => console.error("[watcher] periodic rescan failed:", err.message));
    }, Math.max(1, env.watch.rescanIntervalMinutes) * 60 * 1000);
    this.rescanTimer.unref();

    console.log(
      `[watcher] Started. Recursive watching ${RECURSIVE_SUPPORTED ? "enabled" : "UNAVAILABLE on this platform -- relying on the periodic rescan"}; ` +
      `rescan every ${env.watch.rescanIntervalMinutes} minute(s); ` +
      `at most one scan per location per ${Math.round(MIN_SCAN_INTERVAL_MS / 1000)}s.`
    );
  }

  /** Every location eligible for real-time ingestion at all. */
  async eligibleLocations() {
    return (await storageLocationRepository.listActiveAllOwners()).filter(
      (l) => l.watch_enabled && l.access_mode === "direct"
    );
  }

  /** Sync the set of active watchers with the set of watched locations. */
  async refresh() {
    const { watch: locations, sweepOnly } = splitWatchable(await this.eligibleLocations());

    // Say once, per location, why a folder the user asked to watch is not being
    // watched. Silence here would look like the setting simply not working, and
    // repeating it every refresh would be an hourly log line forever.
    for (const { location, why } of sweepOnly) {
      if (this.warnedSweepOnly.has(location.id)) continue;
      this.warnedSweepOnly.add(location.id);
      console.warn(
        `[watcher] Not watching "${location.name}" (${location.root_path}) because ${why}. ` +
        "Watching a folder this application writes into makes each write queue a scan that " +
        "causes the next write. It is still covered by the periodic rescan, so changes are " +
        "picked up -- just on the timer rather than instantly."
      );
    }

    // A location that stops being watchable must lose its watcher, so the
    // wanted set is the WATCHABLE list, not the eligible one.
    const wanted = new Set(locations.map((l) => l.id));

    for (const [id, watcher] of this.watchers) {
      if (!wanted.has(id)) {
        watcher.close();
        this.watchers.delete(id);
      }
    }

    if (!RECURSIVE_SUPPORTED) return;

    for (const location of locations) {
      if (this.watchers.has(location.id)) continue;
      try {
        const watcher = fs.watch(
          location.root_path,
          { recursive: true, persistent: false },
          (eventType, filename) => {
            if (filename && shouldIgnore(filename)) return;
            this.scheduleScan(location);
          }
        );
        // A watched drive being yanked emits an error; drop the watcher and
        // let refresh() re-establish it when the drive is back.
        watcher.on("error", (err) => {
          console.error(`[watcher] ${location.name}: ${err.message}`);
          watcher.close();
          this.watchers.delete(location.id);
        });
        this.watchers.set(location.id, watcher);
        console.log(`[watcher] Watching "${location.name}" (${location.root_path})`);
      } catch (err) {
        // An offline external drive is expected, not exceptional.
        console.warn(`[watcher] Could not watch "${location.name}": ${err.message}`);
      }
    }
  }

  /**
   * Coalesce a burst of events into one scan.
   *
   * Copying a folder in fires an event per file, and a large file fires
   * many while it is still being written. Debouncing means one scan after
   * things settle, rather than hundreds of scans over a half-written file.
   */
  scheduleScan(location) {
    if (this.pending.has(location.id)) clearTimeout(this.pending.get(location.id));
    const timer = setTimeout(() => {
      this.pending.delete(location.id);
      this.queueScan(location, "watch")
        .then((queued) => {
          if (queued) console.log(`[watcher] Change detected in "${location.name}" -- scan queued.`);
        })
        .catch((err) => console.error(`[watcher] Could not queue scan for "${location.name}":`, err.message));
    }, env.watch.debounceMs);
    timer.unref();
    this.pending.set(location.id, timer);
  }

  /**
   * The safety net: scan every eligible location regardless of events.
   *
   * Deliberately over the ELIGIBLE list rather than the watchable one. The
   * folders excluded from watching are excluded because writes to them are
   * self-triggering, which is a statement about events and not about whether
   * their contents deserve indexing -- this timer is the mechanism that keeps
   * them current, so skipping them here would turn a loop fix into a coverage
   * hole.
   */
  async sweep() {
    const locations = await this.eligibleLocations();
    let queued = 0;
    for (const location of locations) {
      if (!fs.existsSync(location.root_path)) continue; // drive offline -- skip quietly
      if (await this.queueScan(location, "sweep")) queued += 1;
    }
    if (queued) console.log(`[watcher] Periodic rescan queued for ${queued} location(s).`);
  }

  stop() {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    // Both of these are in-memory caches of things that are only true while
    // this instance is running: the scan floor must not suppress the first scan
    // after a restart, and the sweep-only reason should be logged again for a
    // fresh process so the operator sees it on the run they are looking at.
    this.lastScanAt.clear();
    this.warnedSweepOnly.clear();
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    this.started = false;
    console.log("[watcher] Stopped.");
  }
}

const storageWatcher = new StorageWatcher();

module.exports = {
  storageWatcher,
  StorageWatcher,
  shouldIgnore,
  splitWatchable,
  RECURSIVE_SUPPORTED,
  MIN_SCAN_INTERVAL_MS,
};
