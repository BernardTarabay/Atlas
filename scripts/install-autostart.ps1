# Makes Atlas start automatically -- at BOOT, at logon, and every few minutes
# thereafter as a watchdog -- and puts a shortcut on the Desktop, so the person
# using it never opens a terminal.
#
# Deliberately a Scheduled Task rather than a Windows Service:
#  - A service runs as SYSTEM, which has no user profile, so
#    C:\Users\<name>\OneDrive\... and the iCloud folder -- exactly where the
#    documents live -- are not its to see. Running as the USER is what makes
#    those paths reachable.
#  - It needs no extra dependency (no NSSM, no node-windows).
#
# AT STARTUP, NOT ONLY AT LOGON. THIS IS THE CHANGE THAT MATTERS.
#
# The task used to have a logon trigger and an interactive principal, and that
# combination has a hole big enough to lose the whole platform through: after
# an UNATTENDED reboot -- Windows Update at 03:00, or mains power returning
# after a cut -- nobody logs in, so the logon trigger never fires and Atlas
# never starts. Postgres and Tailscale come back on their own because they are
# services; the machine answers on the tailnet, looking perfectly healthy, and
# serves nothing. It stays that way until a human walks to the keyboard and
# signs in, which is precisely the situation this whole arrangement exists to
# avoid.
#
# So the principal is now S4U ("run whether the user is logged on or not") and
# there is a boot trigger. S4U runs as the user WITHOUT an interactive session
# and without storing a password anywhere: the profile is loaded, so every
# local path under the user's home is reachable exactly as before.
#
# WHAT S4U COSTS, said plainly rather than discovered later:
#
#  - No network credentials. A session started this way cannot authenticate to
#    a UNC share or a mapped drive letter. Every storage location on this
#    installation is a local path under the user's home, so nothing is lost
#    here -- but a location added later on \\server\share will NOT be readable
#    until somebody logs in. Register such a location and this assumption needs
#    revisiting.
#  - No OneDrive/iCloud SYNC CLIENT. Those start at logon and are not services.
#    Files already downloaded are ordinary files and are read normally; a file
#    still online-only stays a placeholder until someone signs in. That is
#    already handled rather than newly broken -- hashProcessor recognises a
#    cloud placeholder, leaves the file in `discovered`, and picks it up on a
#    later scan once the bytes are local (see fileRepository.listUnprocessed).
#  - The account needs the "Log on as a batch job" right. Local administrators
#    have it by default; if registration fails with "The user account does not
#    have permission", that is what is missing.
#
# The logon trigger is KEPT as well. It costs nothing -- start-atlas.bat
# refuses a duplicate -- and it covers the one case the boot trigger cannot:
# somebody who has just signed in after stopping Atlas by hand.
#
# Usage (normal PowerShell, no admin needed):
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove

param([switch]$Remove)

$ErrorActionPreference = "Stop"

# ELEVATION IS CHECKED FIRST, AND SAID PLAINLY.
#
# A boot trigger fires before any user session exists, so registering one is a
# machine-wide act and Windows requires an administrator to do it -- regardless
# of whether the account is IN the Administrators group, because an ordinary
# shell runs with the filtered token.
#
# Checked up front rather than discovered from the exception, because the
# exception is "Access is denied" with no hint as to what was denied or why,
# and the first guess it invites (the "Log on as a batch job" right) is the
# wrong one on a machine where the user is already an admin.
$IsElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
              ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$TaskName = "Atlas Document Platform"
$Root     = Split-Path -Parent $PSScriptRoot
$StartBat = Join-Path $Root "scripts\start-atlas.bat"
$Desktop  = [Environment]::GetFolderPath("Desktop")
$Shortcut = Join-Path $Desktop "Atlas Documents.url"

if ($Remove) {
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "Removed the scheduled task." }
    catch { Write-Host "No scheduled task to remove." }
    if (Test-Path $Shortcut) { Remove-Item $Shortcut; Write-Host "Removed the desktop shortcut." }
    return
}

if (-not (Test-Path $StartBat)) { throw "Cannot find $StartBat" }

# Warn rather than fail: the app still runs, it just serves the dev-server
# message instead of the UI until the frontend is built.
$Dist = Join-Path $Root "frontend\dist\index.html"
if (-not (Test-Path $Dist)) {
    Write-Warning "frontend\dist not found -- run 'npm run build' in frontend\ so the API can serve the UI."
}

# NO VISIBLE WINDOW, AND THIS TIME IT IS ACTUALLY TRUE.
#
# The action used to be `cmd.exe /c start-atlas.bat`, under a comment claiming
# that "-WindowStyle Hidden on the action keeps the console from flashing at
# logon". There was no -WindowStyle on the action -- New-ScheduledTaskAction
# has no such parameter -- and the `-Hidden` in the settings below only hides
# the task from Task Scheduler's own list. So a console window popped up every
# time the watchdog fired: every five minutes, all day, on a machine somebody
# was trying to use. The comment described an intention nobody had implemented
# and nobody re-checked, and the log shows it doing this 288 times a day.
#
# run-hidden.vbs launches with window style 0, which never creates a window at
# all, and passes the batch file's exit code back so Task Scheduler's "Last Run
# Result" still means what start-atlas.bat says it means. See that file.
$Shim = Join-Path $PSScriptRoot "run-hidden.vbs"
if (-not (Test-Path $Shim)) { throw "Cannot find $Shim -- it is what keeps the watchdog silent." }

$action = New-ScheduledTaskAction -Execute "wscript.exe" `
    -Argument "//nologo `"$Shim`" `"$StartBat`"" -WorkingDirectory $Root
# At logon, AND every few minutes thereafter -- the repetition turns this task
# into a watchdog.
#
# WHY A WATCHDOG AND NOT A FIX FOR ONE CAUSE
#
# Atlas has stopped twice without explanation: both times the API and worker
# were simply gone, and both times it stayed down until somebody looked. The
# suspected cause (a stray console Ctrl+C) did NOT reproduce under test -- a
# real CTRL_C_EVENT fired at both the current launch form and a hardened one
# killed neither. Hardening against it would have been guesswork.
#
# A repeating trigger does not care why Atlas stopped. Every few minutes it
# runs start-atlas.bat, which either starts a dead Atlas or refuses because one
# is already running. That covers the causes we understand and the ones we do
# not.
#
# THIS IS ONLY SAFE BECAUSE start-atlas.bat REFUSES DUPLICATES. Without that
# guard this trigger would start a second API and a second worker every few
# minutes, which is far worse than the outage it fixes. The two changes belong
# together; do not add this repetition to a copy of start-atlas.bat that has no
# preflight check.
# FIFTEEN MINUTES, NOT FIVE.
#
# Five was chosen when the only question was "how fast should a dead Atlas come
# back", and in isolation faster is better. It is not in isolation: the log
# shows the watchdog waking 288 times a day and answering "refused: Atlas is
# already running" on essentially every one of them. That is the cost side of
# the trade, and it was never weighed.
#
# Fifteen still bounds an unnoticed outage to a quarter of an hour -- well
# inside the time it takes anyone to notice and report one -- for a third of
# the wakeups. If Atlas is crashing often enough for the difference between 5
# and 15 to matter, the crash is the thing to fix.
$WatchdogMinutes = 15

# TWO triggers, not one with a repetition bolted on.
#
# Attaching the repetition to the LOGON trigger looked right and was not: a
# logon trigger's repetition only begins when that trigger fires, and by the
# time this script runs the user has already logged in. The task registered
# cleanly, reported `Repeat every: PT5M`, and had an EMPTY NextRunTime -- a
# watchdog that would not have run again until the next logon, which is exactly
# when it is least needed.
#
# So the watchdog is its own `-Once` trigger starting now and repeating
# forever, and the logon trigger stays for the cold-boot case.
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# THE BOOT TRIGGER. See the header: without this, an unattended reboot leaves
# Atlas down until a human signs in, and that is the exact scenario nobody is
# there for.
#
# `-AtStartup` fires before the user session exists, which is why the principal
# below had to change at the same time -- an interactive principal simply
# cannot run then. The two are one change; do not keep one without the other.
#
# The delay is not cosmetic. At startup, Postgres (Automatic) and Tailscale
# (Automatic) are still coming up, and an API that starts before Postgres
# accepts connections exits and waits for the watchdog. Thirty seconds turns
# "down for up to five minutes after every reboot" into "up almost at once",
# and the watchdog is still behind it if the estimate is wrong on a slow disk.
$bootTrigger = New-ScheduledTaskTrigger -AtStartup
$bootTrigger.Delay = "PT30S"

$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes)
# An empty Duration means "repeat indefinitely". A fixed duration would make the
# watchdog quietly expire, which is the one failure mode a watchdog must not
# have.
$watchdogTrigger.Repetition.Duration = ""

$trigger = @($bootTrigger, $logonTrigger, $watchdogTrigger)

# -RestartCount / -RestartInterval: if the ACTION itself fails to launch (a
# transient file lock on the .bat, a disk still spinning up at boot), Task
# Scheduler retries rather than waiting a whole watchdog interval.
#
# -MultipleInstances IgnoreNew is the safety net behind start-atlas.bat's own
# guard: a watchdog tick that arrives while a previous one is still working is
# dropped instead of running a second copy alongside it.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
            -MultipleInstances IgnoreNew

# S4U: runs as this user, logged on or not, with no password stored anywhere.
# See the header for what that costs and why it is the right trade here.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "Registered scheduled task '$TaskName':" -ForegroundColor Green
    Write-Host "  - at STARTUP (30s delay), whether or not anyone signs in"
    Write-Host "  - at logon as $env:USERNAME"
    Write-Host "  - every $WatchdogMinutes minute(s) as a watchdog -- start-atlas.bat refuses duplicates"
}
catch {
    # Windows says "Access is denied" and nothing else, which is true and
    # useless. The two causes are listed in order of likelihood, most likely
    # first.
    #
    # A FAILURE HERE LEAVES THE PREVIOUS TASK ALONE. Register-ScheduledTask
    # -Force replaces atomically or not at all, so a refused registration does
    # not leave the machine with no autostart -- it leaves it with the old one,
    # which is worse than the new one and far better than nothing. Verified by
    # running this unelevated against a live installation: the existing task
    # was still Ready afterwards.
    Write-Host ""
    Write-Host "Could not register the task: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    if (-not $IsElevated) {
        Write-Host "This shell is not elevated, and a BOOT trigger needs elevation --" -ForegroundColor Yellow
        Write-Host "it starts Atlas before anyone signs in, which is a machine-wide change."
        Write-Host "Being a member of Administrators is not enough; the shell has to be"
        Write-Host "running with the administrator token."
        Write-Host ""
        Write-Host "  Right-click PowerShell -> Run as administrator, then:"
        Write-Host "    cd `"$Root`""
        Write-Host "    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1"
    } else {
        Write-Host "This shell IS elevated, so the likely cause is that $env:USERNAME lacks the"
        Write-Host "'Log on as a batch job' right, which S4U requires."
        Write-Host "Grant it via secpol.msc:"
        Write-Host "  Local Policies -> User Rights Assignment -> Log on as a batch job"
    }
    Write-Host ""
    Write-Host "Your EXISTING autostart task has been left exactly as it was." -ForegroundColor Yellow
    Write-Host "If it is the old logon-only one, Atlas still starts when somebody signs in --"
    Write-Host "but an unattended reboot leaves it down until they do. That is the hole this"
    Write-Host "script exists to close, and it is not cosmetic."
    exit 1
}

# WHAT THIS DOES NOT COVER, said here rather than left to be discovered:
#
#   - The machine being ASLEEP. A scheduled task does not run on a sleeping
#     computer, and this host currently sleeps after 25 minutes idle. Run
#     scripts\configure-server-power.ps1 -Apply.
#   - The machine being OFF after a power cut. No software can start a computer
#     that has no power; that is a BIOS/UEFI setting ("Restore on AC Power
#     Loss" = Power On) plus, ideally, a UPS. See docs/12-server-operations.md.
Write-Host ""
Write-Host "Two things this does NOT fix, both required for unattended uptime:" -ForegroundColor Yellow
Write-Host "  1. Sleep. A scheduled task does not run on a sleeping machine."
Write-Host "     Run:  powershell -ExecutionPolicy Bypass -File scripts\configure-server-power.ps1 -Apply"
Write-Host "  2. Power loss. Set 'Restore on AC Power Loss' to Power On in the BIOS."
Write-Host ""

# A .url shortcut rather than a .lnk: it opens in the default browser with
# no console window and needs no target executable path.
@"
[InternetShortcut]
URL=http://localhost:5000
IconIndex=0
"@ | Set-Content -Path $Shortcut -Encoding ASCII

Write-Host "Created desktop shortcut: $Shortcut"
Write-Host ""
Write-Host "Start it now without rebooting:  $StartBat"
Write-Host "Then open:                       http://localhost:5000"
