// Sets up everything needed to try the Filesystem Agent end to end:
// a small test folder, an agent-mode storage location pointing at it, and
// a registered agent. Prints the three values to paste into the app.
//
// Deliberately uses its OWN folder rather than any real data -- an
// agent-mode location can only be scanned while the agent is running, so
// pointing this at something that matters would make those files
// unreachable the moment the agent is closed.
//
//   node scripts/setup-agent-demo.js            # create
//   node scripts/setup-agent-demo.js --remove   # tear it back down
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");

const env = require("../src/config/env");
const { Pool } = require("pg");
const storageLocationService = require("../src/services/storageLocationService");
const agentService = require("../src/services/agentService");
const { closeAllQueues } = require("../src/queues");

const DEMO_FOLDER = path.join(os.homedir(), "Documents", "DMS Agent Demo");
const LOCATION_NAME = "Agent Demo Folder";

const pool = new Pool({ connectionString: env.databaseUrl });

async function remove() {
  const { rows } = await pool.query("SELECT id FROM storage_locations WHERE name = $1", [LOCATION_NAME]);
  for (const { id } of rows) {
    await pool.query("DELETE FROM agent_operations WHERE agent_id IN (SELECT id FROM filesystem_agents WHERE storage_location_id = $1)", [id]);
    await pool.query("DELETE FROM filesystem_agents WHERE storage_location_id = $1", [id]);
    await pool.query("DELETE FROM files WHERE storage_location_id = $1", [id]);
    await pool.query("DELETE FROM filesystem_scans WHERE storage_location_id = $1", [id]);
    await pool.query("DELETE FROM processing_jobs WHERE storage_location_id = $1", [id]);
    await pool.query("DELETE FROM storage_locations WHERE id = $1", [id]);
  }
  await fsp.rm(DEMO_FOLDER, { recursive: true, force: true }).catch(() => {});
  console.log(`Removed the demo location, its agent, and ${DEMO_FOLDER}`);
}

async function create() {
  await remove(); // idempotent -- re-running gives a clean slate and a fresh key

  await fsp.mkdir(path.join(DEMO_FOLDER, "Invoices"), { recursive: true });
  await fsp.writeFile(
    path.join(DEMO_FOLDER, "meeting notes.txt"),
    "Notes from the provincial meeting held in Beirut. The treasurer presented the budget " +
    "for the coming year and the assembly approved it subject to a review of staffing costs."
  );
  await fsp.writeFile(
    path.join(DEMO_FOLDER, "Invoices", "invoice 1042.txt"),
    "Invoice 1042. Couvent St Elie. Amount due 1,250 USD. Issued July 2026. Payable within 30 days."
  );
  await fsp.writeFile(
    path.join(DEMO_FOLDER, "scan_0099.txt"),
    "Scanned letter regarding the pilgrimage of the relics of Saint Therese to Lebanon, 2026."
  );

  const admin = await pool.query(`
    SELECT u.id, u.email FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles r ON r.id = ur.role_id
    WHERE r.name = 'Admin' AND u.status = 'active'
    ORDER BY u.created_at LIMIT 1`);
  if (!admin.rows.length) throw new Error("No active Admin user found.");

  const location = await storageLocationService.create(
    { name: LOCATION_NAME, type: "local", rootPath: DEMO_FOLDER, accessMode: "agent" },
    admin.rows[0].id
  );

  const { agent, apiKey } = await agentService.register(
    { storageLocationId: location.id, name: "Demo Agent", registeredDirectories: [] },
    admin.rows[0].id
  );

  console.log("\n================ PASTE THESE INTO THE AGENT ================\n");
  console.log(`  Server URL   http://localhost:${env.port}`);
  console.log(`  Agent ID     ${agent.id}`);
  console.log(`  API key      ${apiKey}`);
  console.log("\n============================================================");
  console.log(`\nDemo folder (3 files):  ${DEMO_FOLDER}`);
  console.log(`Storage location:       "${LOCATION_NAME}" (access_mode=agent, read_only=${location.is_read_only})`);
  console.log("\nThe API key is shown ONCE -- only its bcrypt hash is stored.");
  console.log("Re-run this script to start over with a fresh key.");
  console.log("Tear it all down with:  node scripts/setup-agent-demo.js --remove\n");
}

(process.argv.includes("--remove") ? remove() : create())
  .catch((e) => console.error("FAILED:", e.message))
  .finally(async () => {
    await pool.end();
    await closeAllQueues();
   
  });
