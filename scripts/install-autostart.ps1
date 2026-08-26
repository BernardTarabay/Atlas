# Makes Atlas start automatically at logon and puts a shortcut on the
# Desktop, so the person using it never opens a terminal.
#
# Deliberately a Scheduled Task at logon rather than a Windows Service:
#  - A service runs as SYSTEM, which cannot see the user's mapped drives,
#    OneDrive folder, or iCloud folder -- exactly the places the documents
#    live. Running at logon as the user is what makes those paths reachable.
#  - It needs no extra dependency (no NSSM, no node-windows).
#
# Usage (normal PowerShell, no admin needed):
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove

param([switch]$Remove)

$ErrorActionPreference = "Stop"

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

# -WindowStyle Hidden on the action keeps the console from flashing at logon.
$action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$StartBat`"" -WorkingDirectory $Root
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
$WatchdogMinutes = 5

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

$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes)
# An empty Duration means "repeat indefinitely". A fixed duration would make the
# watchdog quietly expire, which is the one failure mode a watchdog must not
# have.
$watchdogTrigger.Repetition.Duration = ""

$trigger = @($logonTrigger, $watchdogTrigger)
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (runs at logon as $env:USERNAME,"
Write-Host "then every $WatchdogMinutes minute(s) as a watchdog -- start-atlas.bat refuses duplicates)."

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
