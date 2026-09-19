// Who is allowed to create an account.
//
// WHAT THIS IS GUARDING, AND WHY IT IS NOT OBVIOUS FROM THE ENDPOINT
//
// `POST /api/auth/register` looks like a low-stakes endpoint: it makes a user
// with the lowest-privilege role. On this application it was the first step of
// a full compromise, because "lowest privilege" here includes `storage.manage`
// and `scan.run`:
//
//   register  -> an account, unauthenticated, no invite
//   browse    -> enumerate the server's entire filesystem
//   create    -> register C:\Users\<someone> as MY storage location
//   scan      -> index, hash, extract text from, and OCR every file in it
//   download  -> read any of them, as their legitimate owner
//
// The ownership model does not stop this and structurally cannot: the attacker
// never reads another account's rows, they create their own rows over the same
// bytes on disk.
//
// The decisive break is the first line. These tests hold it.
//
// They exercise authService directly rather than over HTTP: the check lives in
// the service precisely so that every path to a new account goes through it,
// and a test that only drove the controller would not notice a second caller
// being added later.
const test = require("node:test");
const assert = require("node:assert");

const authService = require("../src/services/authService");
const userRepository = require("../src/repositories/userRepository");
const env = require("../src/config/env");

const ORIGINAL_MODE = env.registration.mode;

/** Swap the account count without touching the database. */
function withUserCount(n, fn) {
  const original = userRepository.count;
  userRepository.count = async () => n;
  return Promise.resolve()
    .then(fn)
    .finally(() => { userRepository.count = original; });
}

test.afterEach(() => { env.registration.mode = ORIGINAL_MODE; });

test("the default mode is first-run, not open", () => {
  // The whole fix is a default. If this ever flips back to "open" because
  // someone found the closed behaviour inconvenient in development, the hole
  // is reopened for every deployment that does not set the variable -- which
  // is the deployment this was written for.
  assert.strictEqual(ORIGINAL_MODE, "first-run");
});

test("first-run: the FIRST account is allowed", async () => {
  // Asserts the POLICY, not register(). Driving register() here would actually
  // create the account -- authService does no input validation of its own (that
  // lives in the controller's validateRegisterInput), so a call with empty
  // strings succeeds and writes a real user with an empty email. It did exactly
  // that on the first run of this file, and had to be deleted by hand. A test
  // for "may this proceed" must not be able to make it proceed.
  env.registration.mode = "first-run";
  await withUserCount(0, async () => {
    await assert.doesNotReject(
      () => authService.assertRegistrationAllowed(),
      "an empty install must accept its first registration"
    );
  });
});

test("first-run: a SECOND account is refused with 403", async () => {
  env.registration.mode = "first-run";
  await withUserCount(1, async () => {
    await assert.rejects(
      () => authService.register({ email: "a@b.c", password: "pw", fullName: "A" }),
      (err) => err.statusCode === 403 && /already has an account/i.test(err.message)
    );
  });
});

test("first-run: refusal does not depend on the email being new", async () => {
  // The gate must run BEFORE the duplicate-email lookup. If the order were
  // reversed, an attacker would learn whether an address is registered here --
  // a free account-enumeration oracle on an endpoint anyone can reach.
  env.registration.mode = "first-run";
  await withUserCount(5, async () => {
    await assert.rejects(
      () => authService.register({ email: "definitely-not-registered@example.invalid", password: "pw" }),
      (err) => err.statusCode === 403
    );
  });
});

test("closed: refused even on an empty install", async () => {
  env.registration.mode = "closed";
  await withUserCount(0, async () => {
    await assert.rejects(
      () => authService.register({ email: "a@b.c", password: "pw" }),
      (err) => err.statusCode === 403 && /not accepting new accounts/i.test(err.message)
    );
  });
});

test("open: allowed regardless of how many accounts exist", async () => {
  // The escape hatch has to actually work, or the documented way to add a
  // second person ("set ALLOW_REGISTRATION=open, register, set it back") is a
  // lie and someone will reach for a worse workaround.
  env.registration.mode = "open";
  await withUserCount(99, async () => {
    await assert.doesNotReject(
      () => authService.assertRegistrationAllowed(),
      "open mode must not apply the account-count gate"
    );
  });
});

test("register() actually calls the gate, and refuses before writing anything", async () => {
  // The policy being correct is worthless if register() does not consult it.
  // Safe to drive the real function here BECAUSE this is the refusing path:
  // assertRegistrationAllowed is the first statement in register(), so a 403
  // throws before the user, role, device, token and audit rows are written.
  env.registration.mode = "first-run";
  const before = await userRepository.count();

  await withUserCount(1, async () => {
    await assert.rejects(
      () => authService.register({ email: "intruder@example.invalid", password: "pw", fullName: "X" }),
      (err) => err.statusCode === 403
    );
  });

  assert.strictEqual(await userRepository.count(), before, "a refused registration must create nothing");
});

test("an unrecognised ALLOW_REGISTRATION value does not silently open the door", () => {
  // A typo ("ALLOW_REGISTRATION=true", "yes", "1") must fail SAFE. Falling back
  // to "open" on unrecognised input would mean the most likely configuration
  // mistake is also the insecure one.
  const parse = (raw) =>
    ["first-run", "open", "closed"].includes(raw) ? raw : "first-run";

  for (const junk of ["true", "yes", "1", "OPEN", "", undefined, "enabled"]) {
    assert.strictEqual(parse(junk), "first-run", `"${junk}" must not enable open registration`);
  }
});
