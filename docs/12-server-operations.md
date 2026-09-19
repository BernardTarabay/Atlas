# 12. Server Operations, Availability and Remote Maintenance

How Atlas stays up on a machine nobody is sitting at, how to get into that
machine from somewhere else, and what happens after each way it can fall over.

Everything in §12.1 was **measured on the Atlas host**, not assumed. Where a
claim is about Tailscale or Windows behaviour rather than about this machine,
it says so.

---

## 12.1 What is actually there today

| | |
|---|---|
| Host | One Windows desktop at the client's premises |
| OS | Windows 11 **Home** (`EditionID: Core`), build 26200 |
| Database | PostgreSQL 18, **Windows service**, `Automatic`, running |
| Job queue | Postgres (`processing_jobs`). No Redis, no broker — migration 040 |
| API | `node src/server.js`, listening on `::`/`0.0.0.0` port 5000, serving the built UI |
| Worker | `node src/workers/runner.js` — a separate process |
| Started by | Scheduled Task **"Atlas Document Platform"** → `scripts/start-atlas.bat` |
| Duplicate guard | `scripts/preflight-atlas.ps1`, tested by `scripts/test-preflight-atlas.ps1` |
| Remote access | Tailscale, **Windows service**, `Automatic`, running |
| Tailnet name | `atlas.tail869348.ts.net` → `100.121.80.12` |
| Published by | `tailscale serve` → `https://atlas...ts.net` proxies `http://127.0.0.1:5000` |
| Exposure | **Tailnet only.** Funnel is off; nothing is on the public internet |
| Network | **Wi-Fi** |

There is no process manager (no NSSM, no PM2, no node-windows) and no Windows
service for Atlas itself. That is deliberate and is explained in
§12.4.

**Neither the API nor the worker needs a terminal.** `start-atlas.bat` launches
both detached and windowless (`start "" /b /min`), so closing a console does
not take Atlas down. The frontend is not served by a separate process at all —
`backend/src/app.js` serves `frontend/dist`, so there is nothing else to keep
alive.

### Environment

`backend/.env` holds the database URL, JWT secrets and the Gemini key. It is
read at process start, so a change needs a restart. `NODE_ENV=production` is
set by `start-atlas.bat` itself rather than by the file, because that is the
one place it must be true — `config/env.js` only enforces its minimum
secret length under production.

---

## 12.2 Why it becomes unreachable — the four real causes

Ordered by how likely each one is on this host.

### 1. The machine goes to sleep. *(present today — the most likely cause)*

Measured: `Sleep after` on mains power is **1500 seconds — 25 minutes**.

Twenty-five idle minutes and the computer is gone. Not slow, not degraded:
nothing is executing, so nothing answers, no scheduled task fires, and
Tailscale leaves the tailnet. The symptom is "Atlas is down again" with
**nothing in any log**, because nothing was running to write one.

`powercfg /a` reports this host supports *S0 Low Power Idle — Network
Connected*, and that phrase misleads. It means the network adapter stays
powered so a small allow-list of background tasks can hold push connections
open. Ordinary user processes — `node.exe` — are suspended by the Desktop
Activity Moderator. A request to port 5000 arrives at a machine with nothing
listening.

**Fix:** `scripts\configure-server-power.ps1 -Apply`

### 2. An unattended reboot with nobody to log in. *(present today)*

Windows Update at 03:00, or mains power returning after a cut. Postgres and
Tailscale come back on their own — they are services. Atlas does not: the
scheduled task's only start trigger was **at logon**, with an interactive
principal, and nobody logs in.

The machine then sits on the tailnet answering pings, `https://atlas…ts.net`
returns a Tailscale 502, and it stays that way until a person walks to the
keyboard. This is precisely the scenario the whole arrangement exists to
prevent, and it was the one it did not cover.

**Fix:** re-run `scripts\install-autostart.ps1`. It now registers a **boot**
trigger with an **S4U** principal — "run whether the user is logged on or not",
no stored password. See §12.4 for what S4U costs.

### 3. A process dies.

Either process can exit — an unhandled rejection, an OOM, a stray Ctrl+C in a
console someone left open. This is already covered: the scheduled task re-runs
`start-atlas.bat` **every 5 minutes**, and the script starts whatever is
missing.

The important half is that it starts *only* what is missing. `preflight-atlas.ps1`
asks about the API and the worker **separately**, because the half-down
state — API alive, worker dead — is the one that hurts most: the UI answers
perfectly and nothing at all is scanned, hashed or classified. An
`api OR worker`-shaped check reported "Atlas is running" for two days while
the worker was dead.

### 4. Loss of internet, or Tailscale disconnecting.

Least worrying of the four. Tailscale runs as a system service with
`WantRunning: true` and `LoggedOut: false`; it retries continuously and
reconnects when the link returns, with no intervention and no logon. Sessions
in flight break; nothing needs restarting.

Two caveats:

- **Wi-Fi.** This host is on Wi-Fi. Wireless drops are ordinary, and Windows
  power-manages wireless adapters more aggressively than wired ones. Ethernet
  is a materially more reliable choice for a machine in this role.
- **DERP vs direct.** With no direct path, traffic relays through Tailscale's
  DERP servers — slower, and it still works. It is not a failure state.

### Not a cause: the terminal, or who is signed in

Closing a console does not stop Atlas (detached processes). Signing out does
not stop Tailscale or Postgres (services). After §12.2's fixes, signing out
does not stop Atlas either.

---

## 12.3 Host configuration required

Run these once on the Atlas machine, in order.

**Steps 1 and 2 need an ELEVATED PowerShell** (Run as administrator). Being a
member of Administrators is not enough — an ordinary shell runs with the
filtered token, and both are machine-wide changes: a boot trigger starts Atlas
before anyone signs in, and a power plan applies to the whole machine. Neither
script fails halfway. `configure-server-power` does nothing without `-Apply`,
and a refused `install-autostart` leaves the existing task exactly as it was —
verified by running it unelevated against this installation.

```powershell
cd <repo>

# 1. Stop it sleeping. Dry run first -- it prints exactly what it would change.
.\scripts\configure-server-power.ps1
.\scripts\configure-server-power.ps1 -Apply

# 2. Start at boot, not only at logon, plus the 5-minute watchdog.
powershell -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1

# 3. Publish it on the tailnet over HTTPS (once; it persists across reboots).
#    No elevation needed.
.\scripts\install-tailscale-serve.ps1

# 4. Confirm. Read-only, no elevation needed.
.\scripts\atlas-doctor.ps1
```

`atlas-doctor.ps1` should end with **"Everything checked is healthy."** If it
does not, it names each problem and the script that fixes it.

### In the BIOS/UEFI — the part no script can do

**Restore on AC Power Loss → Power On** (also called *AC Back*, *After Power
Failure*, or *Power On After Power Failure*).

Without it, a power cut leaves the machine off and it stays off until someone
presses the button. No software anywhere can change that; see §12.7.

### Recommended, not required

- **Ethernet instead of Wi-Fi.**
- **A UPS.** With one, a brief cut is not a reboot at all — which is better
  than recovering from a reboot quickly.
- **Disable Fast Startup** (`configure-server-power.ps1 -Apply
  -IncludeFastStartup`, elevated). With it on, "shut down" is a hibernate of
  the kernel session, so a reboot may not clear a stuck driver and the boot
  path taken on resume is not the one taken after a power cut — meaning the
  recovery you tested is not the recovery you get.

---

## 12.4 Process management: why a Scheduled Task and not a service

A Windows service is the conventional answer and it is the wrong one here.

A service runs as `LocalSystem`, which has **no user profile**. Every storage
location on this installation lives under `C:\Users\<name>\OneDrive\Desktop\…`.
SYSTEM can technically reach those paths, but the OneDrive and iCloud sync
clients are per-user and the placeholder/hydration behaviour is a property of
the user's session, not of the file system. Running as the user is what makes
the documents look the way the application expects.

A service also brings a dependency — NSSM, WinSW or node-windows — that has to
be installed, updated and understood by whoever maintains this next.

So: a Scheduled Task, with three triggers.

| Trigger | Covers |
|---|---|
| **At startup** (30s delay) | Reboots, including unattended ones |
| At logon | Someone signing in after stopping Atlas by hand |
| Every 15 minutes | A crash, and every cause nobody has diagnosed |

### It runs with no visible window, and that took a fix

The task's action is `wscript.exe //nologo scriptsun-hidden.vbs
scripts\start-atlas.bat`, not `cmd.exe /c start-atlas.bat`.

The direct version pops a console window every time the watchdog fires. That
went unnoticed because the installer carried a comment saying `-WindowStyle
Hidden` on the action prevented it — a parameter `New-ScheduledTaskAction` does
not have — and because `New-ScheduledTaskSettingsSet -Hidden` sounds like it is
about windows when it only hides the task from Task Scheduler's own list. The
result was a black rectangle stealing focus every five minutes on a machine
somebody was using.

`run-hidden.vbs` launches with window style 0, so no window is ever created,
and it returns the batch file's exit code so the "Last Run Result" column keeps
the meaning §12.4 gives it.

The interval moved from 5 minutes to 15 at the same time. Five bounded an
unnoticed outage slightly tighter and cost 288 wakeups a day, essentially all
of which logged *"refused: Atlas is already running"*. Fifteen still bounds an
outage well inside the time anyone takes to notice one.

The 30-second boot delay is not cosmetic: Postgres and Tailscale are still
starting, and an API that starts before Postgres accepts connections exits and
waits for the watchdog.

### What S4U costs

The principal is `S4U` — runs as the user, logged on or not, **no password
stored anywhere**. Three consequences, stated here rather than discovered
later:

- **No network credentials.** The session cannot authenticate to a UNC share or
  a mapped drive. Every storage location here is a local path, so nothing is
  lost — but a location added later on `\\server\share` will not be readable
  until someone signs in.
- **No OneDrive/iCloud sync client.** Those start at logon. Files already
  downloaded are ordinary files and read normally; a file still online-only
  stays a placeholder. This is already handled rather than newly broken —
  `hashProcessor` recognises a cloud placeholder, leaves the file in
  `discovered`, and a later scan picks it up once the bytes are local
  (`fileRepository.listUnprocessed`).
- **The account needs "Log on as a batch job".** Local administrators have it.
  If registration fails with a permission error, that is why, and
  `install-autostart.ps1` says so and exits non-zero rather than silently
  falling back.

### The watchdog is only safe because the launcher refuses duplicates

Running `start-atlas.bat` every five minutes would otherwise add an API and a
worker each time. Two APIs race for port 5000 and the **loser stays alive but
unbound** — healthy in the process list, serving nothing. Two workers double
the Gemini request rate.

`preflight-atlas.ps1` prevents that, and it has its own test suite
(`test-preflight-atlas.ps1`) because a guard this load-bearing should not be
verifiable only by breaking production. **Do not add the repeating trigger to a
copy of `start-atlas.bat` that has no preflight check.**

### Reading the watchdog's result

`start-atlas.bat`'s exit codes describe **the state of Atlas**, not the outcome
of the script:

| Code | Meaning |
|---|---|
| `0` | Atlas is up — started just now, or already was |
| `1` | Atlas is **not** up and the script could not fix it (guard missing) |
| `2` | Atlas is not up on purpose — a dev server owns port 5000 |

So Task Scheduler's *Last Run Result: The operation completed successfully*
means Atlas is running. It previously exited `1` in the healthy
"already running" case, so that column read as a permanent failure on a
perfectly healthy machine — which taught anyone who looked to ignore it, and
left a genuine failure nowhere to show up.

---

## 12.5 Remote maintenance

**The intended architecture works.** Developer's machine → authenticated into
the client's tailnet → the Atlas host → maintenance. Below is what is possible
on *this* host and what to configure.

### Which remote-shell options actually apply

| | |
|---|---|
| **Tailscale SSH** | **Not available.** Tailscale's SSH *server* runs on Linux, macOS and BSD. A Windows node can originate a Tailscale SSH session but cannot accept one. This is the first thing everyone reaches for and it does not apply to a Windows host. |
| **Remote Desktop** | **Not available on this host.** Windows 11 **Home** ships the RDP client only; it cannot host a session. On Pro it is a reasonable second route, and a bigger grant — a full desktop rather than a shell. |
| **OpenSSH Server** | **The answer.** Available on every edition including Home, ships with Windows as an optional feature, gives a real PowerShell session, and can be bound to **one address**. |

### Setting it up

```powershell
.\scripts\enable-remote-admin.ps1              # dry run: says exactly what it would do
.\scripts\enable-remote-admin.ps1 -Apply       # elevated
```

Three independent barriers, so a mistake in one is not an exposure:

1. **`ListenAddress <tailscale-ip>` in `sshd_config`.** The socket does not
   exist on the LAN or the internet — there is nothing to filter, and nothing
   to scan. This is stronger than any firewall rule.
2. **A firewall rule scoped to `100.64.0.0/10`**, the range Tailscale assigns
   from. The stock any-address OpenSSH rule is disabled, because a permissive
   rule beside a restrictive one is just a permissive rule.
3. **Tailscale ACLs**, which are the only barrier that survives someone editing
   the machine, and the only one that expresses the actual intent:

```jsonc
"acls": [
  // The client's devices reach the Atlas web UI, and only that.
  { "action": "accept", "src": ["*"],                "dst": ["tag:atlas:443", "tag:atlas:5000"] },
  // Administration is the developer, from their own devices, and nobody else.
  { "action": "accept", "src": ["autogroup:admin"],  "dst": ["tag:atlas:22"] }
]
```

Tag the node `tag:atlas` so those rules have something to attach to.

### Keys, and two failure modes that are silent

The script never creates, prints or installs key material — that is yours to
generate and paste. Two Windows-OpenSSH specifics will otherwise cost an hour:

- For a member of the **Administrators** group, Windows OpenSSH reads
  `C:\ProgramData\ssh\administrators_authorized_keys`, **not**
  `~/.ssh/authorized_keys`. A key in the home directory is ignored without a
  word and you are asked for a password forever.
- That file's ACL must be **Administrators + SYSTEM only**, or sshd refuses to
  read it — again silently.

```powershell
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /grant "Administrators:F" "SYSTEM:F"
```

Once the key works — **verify it first** — set `PasswordAuthentication no` and
`Restart-Service sshd`. In the wrong order you have locked yourself out of a
machine you cannot reach.

### What you can then do remotely

```powershell
ssh <user>@atlas.tail869348.ts.net
cd <repo>

.\scripts\atlas-doctor.ps1        # what is wrong, in one screen
.\scripts\restart-atlas.bat       # stop both, start both
git pull
cd frontend; npm ci; npm run build; cd ..
cd backend;  npm ci; npm run db:migrate; cd ..
.\scripts\restart-atlas.bat
.\scripts\atlas-doctor.ps1        # confirm
```

Logs are `logs\atlas-api.log`, `logs\atlas-worker.log`, `logs\atlas-start.log`
(what the watchdog did and when), and `logs\atlas-health.log` if the health
check below is scheduled. `atlas-doctor.ps1` tails the first three for you.

**Never `tailscale funnel`.** `serve` is tailnet-only; funnel publishes to the
open internet. On a machine indexing someone's private documents that
distinction is the entire security model. `atlas-doctor.ps1` reports funnel
being on as a failure, not a warning.

### A health history, optional

The doctor answers "is it healthy now". For "was it healthy at 04:00":

```powershell
$repo = "<repo>"
$a = New-ScheduledTaskAction -Execute "powershell.exe" `
      -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$repo\scripts\atlas-doctor.ps1`" -Brief -Log"
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
$t.Repetition.Duration = ""
Register-ScheduledTask -TaskName "Atlas health log" -Action $a -Trigger $t `
      -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -Hidden) -Force
```

One line per run in `logs\atlas-health.log`. Not installed by default: it is a
diagnostic convenience, not part of keeping Atlas up, and always-on machinery
on someone else's computer should be something they chose.

---

## 12.6 Disaster recovery — what happens, and when

Assumes §12.3 has been done.

| Event | What happens | Time to recover | Anyone needed? |
|---|---|---|---|
| API or worker crashes | Watchdog starts the missing one | ≤ 5 min | No |
| Both crash | Watchdog starts both | ≤ 5 min | No |
| Postgres stops | Service recovery restarts it; the API retries | Seconds–minutes | No |
| Machine reboots (update, or after a cut) | Services return; boot trigger starts Atlas after 30 s | ~1 min after boot | **No** — this needed a person before |
| Internet drops | Tailscale reconnects by itself; LAN access keeps working | On restoration | No |
| Tailscale disconnects | Same. `serve` config lives in `tailscaled` and returns with it | On restoration | No |
| Machine sleeps | It should not any more. If it does: nothing runs | Until woken | Yes — see §12.7 |
| Power cut, then power returns | **Only if the BIOS is set to Power On.** Otherwise it stays off | ~2 min, or never | Depends entirely on the BIOS |
| Disk failure | Restore from backup | Hours | Yes, physically |

Note the asymmetry: **every software failure is self-healing; every hardware or
power failure is not.**

### Data

`scripts\backup-database.ps1` and `scripts\install-backup-schedule.ps1` cover
the database; `scripts\verify-backup-restore.ps1` proves a backup actually
restores, which is the half people skip.

The database is the irreplaceable part and it is small. **Atlas holds no
document bytes** — it indexes files where they lie, and the organized folder is
shortcuts. So the documents' durability is the client's own drives and backup
regime, and the database is what carries every name, classification, subject
and description derived from them.

---

## 12.7 What cannot be solved remotely — plainly

**A powered-off machine.** If the computer has no power, or is off and the BIOS
is not set to restore on AC, no software can start it. Nothing in this
repository changes that. The remedies are hardware:

- BIOS **Restore on AC Power Loss → Power On** (free, and the single most
  valuable setting here).
- A **UPS**, so a brief cut never becomes an outage at all.
- Wake-on-LAN, which needs a magic packet from *inside* the client's LAN — so
  it does not help from outside unless another always-on device there can send
  it. It is not configured, and on a machine that should never be off it is
  solving the wrong problem.
- A smart plug or IPMI/vPro for genuine remote power. Real, and more
  infrastructure than this deployment warrants.

**A sleeping machine**, if the power configuration is ever reverted. Wake
timers are enabled, so a scheduled task *can* wake it — but a task cannot run
to notice a problem while the machine is asleep, so this is not a recovery
path. Prevention is the only answer.

**Hardware failure**, an OS that will not boot, a full disk, and anything
needing a BIOS screen. All require someone at the keyboard.

**Windows feature installs and firewall changes** need elevation, which needs
an interactive UAC prompt or an already-elevated session. Do these once, in
person, during setup — which is why `enable-remote-admin.ps1` is run at
install time rather than being needed later.

---

## 12.8 Operational checklist

Everything on this list is required. Nothing is here because it sounds good.

- [ ] Machine stays powered on; BIOS **Restore on AC Power Loss = Power On**
- [ ] `configure-server-power.ps1 -Apply` run — **sleep, hibernate and disk timeouts all "never"**
- [ ] Internet connection maintained; **Ethernet preferred over Wi-Fi**
- [ ] Tailscale installed, signed in, **service `Automatic`** (it is)
- [ ] `install-tailscale-serve.ps1` run — HTTPS name resolves and loads
- [ ] **Funnel off** (`tailscale funnel status` shows nothing)
- [ ] PostgreSQL service `Automatic` (it is)
- [ ] `install-autostart.ps1` run — task has a **boot trigger** and an **S4U** principal
- [ ] `frontend/dist` built, or the API serves a placeholder instead of the UI
- [ ] `enable-remote-admin.ps1 -Apply` run; key authentication verified; **passwords disabled**
- [ ] Tailscale ACL restricts port 22 to the developer
- [ ] `install-backup-schedule.ps1` run, and `verify-backup-restore.ps1` passed at least once
- [ ] `atlas-doctor.ps1` ends with **"Everything checked is healthy."**
