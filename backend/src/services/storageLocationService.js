// Storage locations, now owned.
//
// WHAT CHANGED AND WHY
//
// Registering a folder used to require `user.manage` -- the permission for
// creating and deactivating other people's ACCOUNTS. Nothing about pointing
// this app at your own Documents folder is an act of user administration, and
// the conflation had a concrete cost: the only account on this install holds
// the `User` role, so it could not perform the first step the application
// exists for. The route is now gated on `storage.manage`, and every function
// here takes the acting user and scopes its queries to them.
//
// Ownership is enforced by the QUERY, not by a check after the fact:
// `findByIdForOwner` returns null for somebody else's location, which becomes
// a 404. There is deliberately no code path that loads a location by id alone
// and then compares owners -- that shape invites the check being skipped.
const path = require("path");
const storageLocationRepository = require("../repositories/storageLocationRepository");
const deviceRepository = require("../repositories/deviceRepository");
const fileRepository = require("../repositories/fileRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const filesystemScanRepository = require("../repositories/filesystemScanRepository");
const { enqueueJob } = require("../queues");
const { ValidationError } = require("../validators/validationError");
const { requireOwner, NotOwnedError } = require("../repositories/ownership");
const pathOverlap = require("../utils/pathOverlap");
const { JobType, StorageType, StorageAccessMode } = require("../models/enums");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

const VALID_TYPES = new Set(Object.values(StorageType));
const VALID_ACCESS_MODES = new Set(Object.values(StorageAccessMode));

/**
 * Enriches each location with its most recent scan (status/when/counts) so
 * the Storage Locations page can show "last scanned" without a separate
 * request per card.
 */
async function list(ownerUserId) {
  requireOwner(ownerUserId, "storageLocationService.list");
  const locations = await storageLocationRepository.listActive(ownerUserId);
  const [latestScans, backlog] = await Promise.all([
    filesystemScanRepository.findLatestForLocations(locations.map((l) => l.id)),
    fileRepository.countBacklogByLocation(ownerUserId),
  ]);
  return locations.map((loc) => attachLastScan(loc, latestScans[loc.id], backlog[loc.id]));
}

function attachLastScan(location, scan, backlog) {
  // Always present, even at zero -- "0 waiting" is information, whereas a
  // missing field renders as nothing and is indistinguishable from a broken
  // count.
  const processing = { inFlight: backlog?.inFlight || 0, stalled: backlog?.stalled || 0 };
  const device = location.device_id
    ? {
        id: location.device_id,
        name: location.device_name,
        kind: location.device_kind,
        status: location.device_status,
        lastSeenAt: location.device_last_seen_at,
      }
    : null;

  if (!scan) return { ...location, last_scan: null, processing, device };
  return {
    ...location,
    processing,
    device,
    last_scan: {
      status: scan.status,
      startedAt: scan.started_at,
      finishedAt: scan.finished_at,
      filesDiscovered: scan.files_discovered,
      filesNew: scan.files_new,
      filesRecovered: scan.files_recovered,
    },
  };
}

async function getById(id, ownerUserId) {
  requireOwner(ownerUserId, "storageLocationService.getById");
  const location = await storageLocationRepository.findByIdForOwner(id, ownerUserId);
  // Same message whether the id is unknown or simply not theirs -- see
  // ownership.NotOwnedError for why distinguishing the two is a disclosure.
  if (!location) throw new NotFoundError("Storage location not found.");
  return location;
}

/**
 * Windows' Explorer "Copy as path" wraps the result in literal double quotes
 * (e.g. `"C:\Users\me\Desktop\docs"`), and it's an easy paste to not notice.
 * A quoted string doesn't look absolute to Node's path resolver, so it was
 * silently getting treated as relative and joined onto the backend's cwd --
 * that's what produced the ENOENT in the scan worker. Strip a single layer
 * of wrapping quotes and trim whitespace before it ever reaches the DB.
 */
function normalizeRootPath(rootPath) {
  const trimmed = String(rootPath).trim();
  const unquoted = /^"(.*)"$/.test(trimmed) || /^'(.*)'$/.test(trimmed)
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  // Resolve to a canonical absolute form so the same folder registered as
  // "C:\Docs", "C:\Docs\" and "C:\Docs\Finance\.." all compare equal --
  // otherwise the duplicate-location check below is trivially defeated by a
  // trailing slash.
  return path.resolve(unquoted);
}

/**
 * Refuse a folder that NESTS with one this user already has registered.
 *
 * WHAT THIS CATCHES THAT THE EQUALITY CHECK DOES NOT
 *
 * `findByRootPath` catches the same folder added twice. Nesting is the case it
 * misses, and it is the more damaging one, because nothing about it looks
 * wrong from the UI: two locations with different names and different paths,
 * both scanning happily, both indexing the same bytes under two location ids.
 * Every file beneath the inner folder then exists twice, with two independent
 * pipelines, two AI bills, and a duplicate group pairing each file with itself.
 *
 * TWO DELIBERATE NON-REJECTIONS
 *
 * The SAME path is passed through rather than refused. `remove()` only
 * deactivates, so re-registering a folder is a supported and important flow --
 * it is what lets an already-ingested tree keep its file identities instead of
 * being re-ingested as duplicates. That case belongs to the reactivation
 * branch below, so this check steps aside for it and lets the more specific
 * handling win.
 *
 * Overlapping MIRROR_ROOT is also allowed. Indexing the organized tree is a
 * reasonable thing to want, and the real hazard there is WATCHING it -- a write
 * queues a scan which causes the next write. That is handled where it belongs,
 * in jobs/storageWatcher.js, which withholds the watch and leaves the periodic
 * sweep to cover the folder. Refusing registration outright would take away a
 * legitimate capability to solve a problem that is already solved elsewhere.
 *
 * Scoped to ACTIVE locations only: an inactive one is neither watched nor
 * scanned, so nothing beneath it is being double-indexed today.
 */
async function assertDoesNotOverlapExisting(rootPath, actorUserId) {
  const active = await storageLocationRepository.listActive(actorUserId);

  for (const location of active) {
    const relation = pathOverlap.relationship(location.root_path, rootPath);
    // null      -- unrelated, fine.
    // "same"    -- the reactivation flow's business, not this check's.
    if (!relation || relation === "same") continue;

    // Phrased from the NEW folder's point of view, because that is the one the
    // user just chose and the one they have to change. Naming the other
    // location and its path means the message is actionable without going and
    // looking it up.
    const detail =
      relation === "inside"
        ? `it is inside "${location.name}" (${location.root_path}), which is already registered`
        : `it contains "${location.name}" (${location.root_path}), which is already registered`;

    throw new ValidationError(
      `That folder cannot be registered because ${detail}. ` +
      "Two registered folders that overlap index the same files twice -- once under each " +
      "location -- which doubles processing, doubles AI cost, and reports every file as a " +
      "duplicate of itself. Register the outer folder only, or remove the other location first."
    );
  }
}

/**
 * Register a Storage Location -- or re-activate the one already registered
 * for this folder BY THIS USER.
 *
 * Re-registering matters because `remove()` only deactivates (see its own
 * note on why a hard delete isn't offered). Without this check, removing a
 * folder and adding it back produced a SECOND location row for the same
 * directory; `scanProcessor` looks up existing files by
 * (storage_location_id, current_path), found nothing under the new id, and
 * ingested every file a second time. Four files became eight, each pair a
 * duplicate of the other -- with the older copies still carrying all the
 * classification, AI titles and rename history.
 *
 * Reusing the row instead means the scan reconciles against the files it
 * already knows about, which is exactly what the reconciliation design in
 * docs/04 §4.6 is for: a file that went missing and came back becomes
 * 'active' again rather than becoming a new File with a new identity.
 */
async function create(
  { name, type = StorageType.LOCAL, rootPath, accessMode = "direct", config = {}, isReadOnly = true, deviceId = null },
  actorUserId
) {
  requireOwner(actorUserId, "storageLocationService.create");
  if (!name || !rootPath) {
    throw new ValidationError("A name and a folder path are required.");
  }
  if (!VALID_TYPES.has(type)) {
    throw new ValidationError(`Unknown storage type "${type}".`);
  }
  if (!VALID_ACCESS_MODES.has(accessMode)) {
    throw new ValidationError(`Unknown access mode "${accessMode}".`);
  }

  rootPath = normalizeRootPath(rootPath);

  // Which machine's disk this is. A `direct` location is on the server by
  // definition; an `agent` location must name a device the caller owns, and
  // the ownership check is what stops "attach my account to someone else's
  // computer" -- a hand-written deviceId for a stranger's laptop is rejected
  // here, not merely hidden from the picker.
  let resolvedDeviceId = null;
  if (accessMode === StorageAccessMode.AGENT) {
    if (!deviceId) {
      throw new ValidationError(
        "An agent-brokered location must say which of your devices holds the folder."
      );
    }
    const device = await deviceRepository.findByIdForOwner(deviceId, actorUserId);
    if (!device) throw new NotOwnedError("That device");
    resolvedDeviceId = device.id;
  } else {
    const serverDevice = await deviceRepository.ensureServerDevice(actorUserId);
    resolvedDeviceId = serverDevice.id;
  }

  // OVERLAP, NOT JUST EQUALITY.
  //
  // findByRootPath below catches the same folder registered twice. It does not
  // catch a folder registered INSIDE one that is already registered, and that
  // is the case that actually caused damage here.
  //
  // Two failures come out of an overlap, and they are separate. Both locations
  // index the same bytes under two location ids, so every file beneath the
  // inner folder exists twice with two independent pipelines, two sets of AI
  // costs, and a duplicate group joining them to themselves. And if either
  // folder is one this application writes into -- the mirror -- watching it
  // turns each write into a scan and each scan into the next write.
  //
  // Checked before the equality case so the more specific message wins, and
  // scoped to the caller's own locations, matching every other read here.
  await assertDoesNotOverlapExisting(rootPath, actorUserId);

  const existing = await storageLocationRepository.findByRootPath(rootPath, actorUserId);
  if (existing) {
    if (existing.is_active) {
      throw new ValidationError(
        `That folder is already registered as "${existing.name}". ` +
        "Scan it again instead of adding it a second time."
      );
    }

    const reactivated = await storageLocationRepository.reactivate(existing.id, actorUserId, {
      name, type, accessMode, config,
    });

    await auditLogRepository.record({
      userId: actorUserId,
      action: "storage_location.reactivated",
      entityType: "storage_location",
      entityId: existing.id,
      previousState: { isActive: false, name: existing.name },
      newState: { isActive: true, name, type, rootPath, accessMode },
      reason:
        "This folder was previously registered and removed; reusing the existing " +
        "location so its already-ingested files keep their identity and history " +
        "instead of being re-ingested as duplicates.",
    });

    return reactivated;
  }

  const location = await storageLocationRepository.create({
    ownerUserId: actorUserId,
    name, type, rootPath, accessMode, config, isReadOnly,
    deviceId: resolvedDeviceId,
  });

  await auditLogRepository.record({
    userId: actorUserId,
    action: "storage_location.created",
    entityType: "storage_location",
    entityId: location.id,
    newState: { name, type, rootPath, accessMode, isReadOnly, deviceId: resolvedDeviceId },
    reason: isReadOnly
      ? "Registered read-only: files here are indexed and named, but never renamed or moved on disk."
      : "Registered writable: approved renames will be applied to the files themselves.",
  });

  return location;
}

/**
 * Edit a location's settings.
 *
 * Replaces the old single-purpose setReadOnly(). Turning read-only OFF is
 * still the consequential direction -- it grants this app permission to
 * rename and move somebody's real files -- so that specific transition is
 * audited with the reason spelled out rather than recorded as a bare field
 * change.
 *
 * `rootPath` is deliberately NOT editable. Repointing a location at a
 * different folder would leave every already-ingested file's current_path
 * describing a directory that no longer belongs to it, and the next scan
 * would mark the whole corpus missing. Registering the new folder is the
 * correct action, and it keeps both histories.
 */
async function update(id, patch, actorUserId) {
  const location = await getById(id, actorUserId);

  const updated = await storageLocationRepository.updateForOwner(id, actorUserId, patch);
  if (!updated) throw new NotFoundError("Storage location not found.");

  const readOnlyChanged =
    patch.isReadOnly !== undefined && Boolean(patch.isReadOnly) !== location.is_read_only;

  await auditLogRepository.record({
    userId: actorUserId,
    action: readOnlyChanged ? "storage_location.read_only_changed" : "storage_location.updated",
    entityType: "storage_location",
    entityId: id,
    previousState: {
      name: location.name,
      isReadOnly: location.is_read_only,
      watchEnabled: location.watch_enabled,
      autoApplyNaming: location.auto_apply_naming,
      replicationEnabled: location.replication_enabled,
    },
    newState: {
      name: updated.name,
      isReadOnly: updated.is_read_only,
      watchEnabled: updated.watch_enabled,
      autoApplyNaming: updated.auto_apply_naming,
      replicationEnabled: updated.replication_enabled,
    },
    reason: readOnlyChanged
      ? (updated.is_read_only
          ? "Set read-only: approved renames will no longer touch files in this location."
          : "Set writable: approved renames will now rename and move the actual files on disk.")
      : "Edited from the Storage Locations page",
  });

  return updated;
}

/** Kept as a thin alias so existing callers and tests keep working. */
async function setReadOnly(id, isReadOnly, actorUserId) {
  return update(id, { isReadOnly: Boolean(isReadOnly) }, actorUserId);
}

/**
 * Kicks off Discovery + Ingestion (docs/06-processing-pipeline.md) as a job,
 * never synchronously -- an HTTP request must never block on walking a
 * potentially huge directory tree (spec §18/§30).
 */
async function triggerScan(storageLocationId, actorUserId) {
  const location = await getById(storageLocationId, actorUserId);
  if (!location.is_active) {
    throw new ValidationError(
      `"${location.name}" has been removed. Add the folder again to re-activate it before scanning.`
    );
  }

  // A scan of a folder on another machine needs that machine to answer. Said
  // up front, because the alternative is a job that sits queued for hours and
  // then fails with a timeout nobody connects to the closed laptop.
  if (location.access_mode === StorageAccessMode.AGENT && location.device_id) {
    const online = await deviceRepository.isOnline(location.device_id);
    if (!online) {
      const device = await deviceRepository.findByIdForOwner(location.device_id, actorUserId);
      throw new ValidationError(
        `"${location.name}" is on ${device?.name || "another device"}, which is not connected right now. ` +
        "Start the agent on that machine and try again."
      );
    }
  }

  const job = await enqueueJob(
    JobType.SCAN,
    { storageLocationId },
    { storageLocationId, createdBy: actorUserId, ownerUserId: actorUserId }
  );

  await auditLogRepository.record({
    userId: actorUserId,
    action: "scan.started",
    entityType: "storage_location",
    entityId: storageLocationId,
    newState: { processingJobId: job.id },
  });

  return job;
}

/**
 * Deactivates a Storage Location (the "x" remove action). Files already
 * ingested from it are untouched and stay browsable/searchable -- this
 * only stops it from being scanned again and hides it from the active
 * list. (A true hard delete isn't offered: ON DELETE RESTRICT on
 * files.storage_location_id would just make it fail anyway once anything's
 * been ingested, and silently cascading file deletes on top of real
 * filesystem content is exactly the kind of destructive default this
 * project's schema was deliberately designed to avoid.)
 */
async function remove(id, actorUserId) {
  const location = await getById(id, actorUserId);

  const updated = await storageLocationRepository.deactivate(id, actorUserId);

  await auditLogRepository.record({
    userId: actorUserId,
    action: "storage_location.removed",
    entityType: "storage_location",
    entityId: id,
    previousState: { isActive: true, name: location.name },
    newState: { isActive: false },
    reason: "Removed from the Storage Locations page",
  });

  return updated;
}

module.exports = {
  NotFoundError, list, getById, create, update, setReadOnly, triggerScan, remove,
  // Exported for tests: this is the function that decides whether two
  // spellings of a path are the same folder, which is what stops a re-add
  // from creating a second location.
  normalizeRootPath,
};
