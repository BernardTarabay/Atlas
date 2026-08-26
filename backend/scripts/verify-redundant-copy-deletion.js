// Proves the one case where deleting an original loses nothing -- and proves
// it refuses every case where it would.
//
// WHY THIS IS THE ONLY DELETION ATLAS DOES
//
// Atlas holds no bytes. A download streams from the original file where it
// lies, and the organized folder is shortcuts pointing at it. So "delete the
// source once the file is safely in Atlas" is data loss in general: finishing
// the pipeline never produced a second copy.
//
// The exception is a file whose EXACT bytes also exist somewhere else Atlas has
// indexed, in a duplicate group the user has resolved. Delete the non-canonical
// copy and the document is still on disk, still indexed, still downloadable.
//
// THE SAFETY ARGUMENT IS "THE OTHER COPY IS STILL THERE", SO THE TESTS BELOW
// ARE MOSTLY ABOUT SPOILING THAT
//
// Each negative case corrupts the premise in a different way -- the survivor is
// missing, the survivor's bytes changed, the copy is the last one left, the
// location is read-only -- and asserts that NOTHING was deleted. A test that
// only proved the happy path would pass on an implementation that deletes
// unconditionally.
//
//     node scripts/verify-redundant-copy-deletion.js

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const env = require("../src/config/env");
const redundantCopyService = require("../src/services/redundantCopyService");
const duplicateGroupRepository = require("../src/repositories/duplicateGroupRepository");
const { closeAllQueues } = require("../src/queues");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

const PREFIX = "__verify_redundant__";
let rootA, rootB, locA, locB;
const fixtureIds = [];
const groupIds = [];

async function cleanup() {
  try {
    if (fixtureIds.length) {
      await p.query("DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])", [fixtureIds]);
      await p.query("DELETE FROM files WHERE id = ANY($1::uuid[])", [fixtureIds]);
    }
    if (groupIds.length) await p.query("DELETE FROM duplicate_groups WHERE id = ANY($1::uuid[])", [groupIds]);
    for (const id of [locA, locB].filter(Boolean)) {
      await p.query("DELETE FROM files WHERE storage_location_id=$1", [id]);
      await p.query("DELETE FROM storage_locations WHERE id=$1", [id]);
    }
    for (const r of [rootA, rootB].filter(Boolean)) await fsp.rm(r, { recursive: true, force: true });
  } catch (e) { console.log(`   (cleanup) ${e.message}`); }
  await p.end().catch(() => {});
  await closeAllQueues().catch(() => {});
  
}

async function makeLocation(owner, name, root, readOnly = false) {
  const { rows } = await p.query(
    `INSERT INTO storage_locations (owner_user_id, name, type, root_path, access_mode, is_read_only)
     VALUES ($1,$2,'local',$3,'direct',$4) RETURNING id`,
    [owner, name, root, readOnly]
  );
  return rows[0].id;
}

async function makeFile(owner, locId, relPath, hash, size) {
  const { rows } = await p.query(
    `INSERT INTO files (storage_location_id, filename_original, filename_current, size_bytes,
                        original_path, current_path, status, owner_user_id, sha256_hash)
     VALUES ($1,$2,$2,$3,$4,$4,'active',$5,$6) RETURNING id`,
    [locId, path.basename(relPath), size, relPath, owner, hash]
  );
  fixtureIds.push(rows[0].id);
  return rows[0].id;
}

async function makeResolvedGroup(owner, keepId, copyId, hash) {
  const group = await duplicateGroupRepository.createGroup({
    ownerUserId: owner, groupType: "exact", detectionMethod: "hash",
    confidenceLevel: "high", confidenceScore: 1,
  });
  groupIds.push(group.id);
  await duplicateGroupRepository.addMember(group.id, keepId, 1);
  await duplicateGroupRepository.addMember(group.id, copyId, 1);
  await duplicateGroupRepository.setCanonicalFile(group.id, keepId, owner);
  void hash;
  return group.id;
}

const sha = (buf) => require("crypto").createHash("sha256").update(buf).digest("hex");
const exists = (f) => fs.existsSync(f);

(async () => {
  console.log("Verifying redundant copy deletion\n" + "=".repeat(48));
  try {
    const owner = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
    if (!owner) { console.log("   SKIP  needs a user"); return; }

    rootA = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-red-a-"));
    rootB = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-red-b-"));
    locA = await makeLocation(owner.id, `${PREFIX}A`, rootA);
    locB = await makeLocation(owner.id, `${PREFIX}B`, rootB);

    const body = Buffer.from("the same document, twice on disk");
    const hash = sha(body);
    await fsp.writeFile(path.join(rootA, "doc.txt"), body);
    await fsp.writeFile(path.join(rootB, "doc.txt"), body);
    const keep = await makeFile(owner.id, locA, "doc.txt", hash, body.length);
    const copy = await makeFile(owner.id, locB, "doc.txt", hash, body.length);
    await makeResolvedGroup(owner.id, keep, copy, hash);

    console.log("\n1. The dry run offers only the copy, never the keeper");

    const preview = await redundantCopyService.listRedundant(owner.id);
    const offered = preview.deletable.filter((r) => fixtureIds.includes(r.copy_id));
    check("the redundant copy is offered", offered.length === 1, `${offered.length} offered`);
    check("...and it is the COPY, not the file being kept",
      offered[0]?.copy_id === copy && offered[0]?.canonical_id === keep, "copy offered, keeper untouched");
    check("...with the space it would free", preview.reclaimableBytes >= body.length,
      `${preview.reclaimableBytes} bytes`);
    check("nothing has been deleted by looking",
      exists(path.join(rootB, "doc.txt")), "the file is still there after a preview");

    console.log("\n2. It refuses when the survivor cannot be trusted");

    // (a) the file that would survive has been tampered with since indexing.
    await fsp.writeFile(path.join(rootA, "doc.txt"), Buffer.from("something else entirely"));
    let result = await redundantCopyService.deleteRedundant(owner.id, { fileIds: [copy] });
    check("a survivor whose bytes changed blocks the delete",
      result.deleted === 0 && /contents have changed/i.test(result.skipped[0]?.reason || ""),
      result.skipped[0]?.reason || "(deleted anyway!)");
    check("...and the copy is still on disk", exists(path.join(rootB, "doc.txt")), "intact");

    // (b) the file that would survive is gone.
    await fsp.rm(path.join(rootA, "doc.txt"));
    result = await redundantCopyService.deleteRedundant(owner.id, { fileIds: [copy] });
    check("a survivor that no longer exists blocks the delete",
      result.deleted === 0 && /could not be read/i.test(result.skipped[0]?.reason || ""),
      result.skipped[0]?.reason || "(deleted anyway!)");
    check("...and the copy is STILL on disk -- the last copy was never at risk",
      exists(path.join(rootB, "doc.txt")), "intact");

    console.log("\n3. It refuses a read-only location");

    await fsp.writeFile(path.join(rootA, "doc.txt"), body); // restore the survivor
    await p.query("UPDATE storage_locations SET is_read_only = true WHERE id=$1", [locB]);
    const roPreview = await redundantCopyService.listRedundant(owner.id);
    const roBlocked = roPreview.blocked.filter((r) => r.copy_id === copy);
    check("a copy in a read-only location is not offered at all",
      roBlocked.length === 1 && /read-only/i.test(roBlocked[0].reason),
      roBlocked[0]?.reason || "(offered!)");
    await p.query("UPDATE storage_locations SET is_read_only = false WHERE id=$1", [locB]);

    console.log("\n4. With the survivor verified, it deletes -- and only the copy");

    result = await redundantCopyService.deleteRedundant(owner.id, { fileIds: [copy] });
    check("the redundant copy was deleted", result.deleted === 1, `${result.deleted} deleted`);
    check("...the file is gone from disk", !exists(path.join(rootB, "doc.txt")), "removed");
    check("...THE KEPT FILE IS STILL THERE", exists(path.join(rootA, "doc.txt")), "survivor intact");
    check("...and its bytes are unchanged",
      sha(await fsp.readFile(path.join(rootA, "doc.txt"))) === hash, "hash matches");
    check("...the space is reported", result.bytesFreed === body.length, `${result.bytesFreed} bytes freed`);

    const rowGone = await p.query("SELECT id FROM files WHERE id=$1", [copy]);
    check("...the row went with it, rather than pointing at nothing",
      rowGone.rowCount === 0, "row removed");
    const keepRow = await p.query("SELECT status FROM files WHERE id=$1", [keep]);
    check("...and the kept file is still indexed and active",
      keepRow.rows[0]?.status === "active", keepRow.rows[0]?.status);

    const audit = await p.query(
      "SELECT count(*)::int n FROM audit_logs WHERE action='file.redundant_copy_deleted' AND entity_id=$1", [copy]);
    check("...with an audit entry written before the delete, which now outlives it",
      audit.rows[0].n === 1, `${audit.rows[0].n} entry`);

    console.log("\n5. A file with no twin is never touched");

    const loneBody = Buffer.from("this document exists exactly once");
    await fsp.writeFile(path.join(rootB, "lonely.txt"), loneBody);
    const lone = await makeFile(owner.id, locB, "lonely.txt", sha(loneBody), loneBody.length);
    const after = await redundantCopyService.listRedundant(owner.id);
    check("a file that is nobody's duplicate is not offered",
      !after.deletable.some((r) => r.copy_id === lone), "absent from the list");
    check("...and it is still on disk", exists(path.join(rootB, "lonely.txt")), "intact");
  } catch (e) {
    failed += 1;
    console.log(`\n   ERROR ${e.stack}`);
  } finally {
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
