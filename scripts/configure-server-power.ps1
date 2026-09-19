# Makes this desktop behave like a server instead of like a desktop.
#
# WHY THIS EXISTS
#
# Atlas is reachable from anywhere on the tailnet, restarts itself when it
# crashes, and comes back after a reboot. None of that matters if the computer
# is asleep, and a Windows desktop is configured out of the box to go to sleep.
#
# Measured on the Atlas host before this script was written:
#
#     Sleep after (AC) ........ 1500 seconds = 25 minutes
#     Hibernate after (AC) .... never  (correct already)
#     Turn off disks (AC) ..... 30 seconds
#     Fast Startup ............ enabled
#
# Twenty-five idle minutes and the machine is gone. Nothing is running, no
# scheduled task fires, and Tailscale drops off the tailnet -- so the symptom
# is "Atlas is down again" with nothing in any log to explain it, because
# nothing was running to write one. It is the most likely single cause of an
# unexplained outage on this deployment and it is invisible from the software
# side, which is exactly why it belongs in the repository rather than in
# somebody's memory of a settings dialog.
#
# WHY MODERN STANDBY DOES NOT SAVE US
#
# This host supports S0 Low Power Idle, listed by `powercfg /a` as "Network
# Connected", and the name invites the assumption that the network keeps
# working. It does not mean what it looks like it means: S0 keeps the NIC
# powered so that a small set of allow-listed background tasks can maintain
# push connections, while ordinary user-session processes -- node.exe, for
# instance -- are suspended by the Desktop Activity Moderator. An HTTP request
# to port 5000 has nothing listening for it. "Network Connected" is about the
# adapter, not about your application.
#
# WHAT IT CHANGES, and nothing else:
#
#   Sleep after (AC)          -> never
#   Hibernate after (AC)      -> never
#   Turn off hard disk (AC)   -> never
#   USB selective suspend     -> disabled
#   Fast Startup              -> disabled            (-IncludeFastStartup)
#   NIC "allow the computer to turn off this device" -> off  (-IncludeNic)
#
# Battery ("DC") settings are deliberately left alone. This is a desktop; if it
# is ever on a UPS reporting as a battery, its behaviour on battery should be
# to shut down cleanly, not to stay awake until the UPS is flat.
#
#   .\scripts\configure-server-power.ps1                 show what would change
#   .\scripts\configure-server-power.ps1 -Apply          make the changes
#   .\scripts\configure-server-power.ps1 -Apply -IncludeFastStartup -IncludeNic
#
# DRY RUN BY DEFAULT, on purpose. These are machine-wide settings on somebody
# else's computer; a script that changes them the moment it is double-clicked
# is a script nobody should run. Without -Apply this only reads and reports.
#
# The last two need an elevated shell and are opt-in because each has a real
# trade-off, spelled out where it is applied.

param(
    [switch]$Apply,
    [switch]$IncludeFastStartup,
    [switch]$IncludeNic
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Write-Head($text) {
    Write-Host ""
    Write-Host $text -ForegroundColor Cyan
    Write-Host ("-" * $text.Length)
}

# powercfg prints "Current AC Power Setting Index: 0x0000012c". Reading the
# CURRENT value first, rather than setting blindly, is what lets this script
# report "already correct" instead of claiming a change it did not make -- and
# it is the difference between a report you can trust and one that always says
# the same thing.
#
# GUIDS RATHER THAN ALIASES. `SUB_SLEEP` and friends are convenient and not
# universally present -- SUB_USB in particular is absent on this host, and
# powercfg answers a name it does not know with "Invalid Parameters" on stderr
# and a non-zero exit. Under `$ErrorActionPreference = "Stop"` that terminated
# the whole script partway through its report. The GUIDs are stable across
# Windows versions and editions; the aliases are not.
#
# stderr is deliberately NOT redirected. In Windows PowerShell 5.1, `2>$null`
# on a native executable turns each stderr line into an ErrorRecord and trips
# the same "Stop" preference this is trying to avoid -- the redirect causes the
# failure it looks like it is suppressing. The exit code is checked instead.
function Get-AcIndex($sub, $setting) {
    $raw = & powercfg /query SCHEME_CURRENT $sub $setting
    if ($LASTEXITCODE -ne 0) { return $null }
    $line = ($raw -split "`r?`n") | Where-Object { $_ -match 'Current AC Power Setting Index' } | Select-Object -First 1
    if (-not $line) { return $null }
    return [Convert]::ToInt64((($line -split ':')[1]).Trim(), 16)
}

# The subgroup/setting GUIDs used below, named so the calls read as English.
$SUB_SLEEP     = "238c9fa8-0aad-41ed-83f4-97be242c8f20"
$STANDBYIDLE   = "29f6c1db-86da-48c5-9fdb-f2b67b1f44da"
$HIBERNATEIDLE = "9d7815a6-7ee4-497e-8888-515a05f02364"
$SUB_DISK      = "0012ee47-9041-4b5d-9b77-535fba8b1442"
$DISKIDLE      = "6738e2c4-e8a5-4a42-b16a-e040e769756e"
$SUB_USB       = "2a737441-1930-4402-8d77-b2bebba308a3"
$USBSUSPEND    = "48e6b7a6-50f5-4782-a5d4-53bb8f07e226"

function Show-Seconds($n) {
    if ($null -eq $n) { return "unknown" }
    if ($n -eq 0) { return "never" }
    if ($n % 60 -eq 0) { return "$([int]($n / 60)) min" }
    return "$n s"
}

$changes = @()
$alreadyOk = @()

# ---------------------------------------------------------------- timeouts
# All three are "minutes of idle before Windows takes something away". Zero
# means never, which is the only correct answer on a machine whose entire job
# is to answer requests that arrive while nobody is at the keyboard.
$timeouts = @(
    @{ Sub = $SUB_SLEEP; Setting = $STANDBYIDLE;   Label = "Sleep after";
       Why  = "the machine stops answering entirely, and no scheduled task runs" },
    @{ Sub = $SUB_SLEEP; Setting = $HIBERNATEIDLE; Label = "Hibernate after";
       Why  = "same, and slower to come back" },
    @{ Sub = $SUB_DISK;  Setting = $DISKIDLE;      Label = "Turn off hard disk after";
       Why  = "a spin-up stalls the first request after every quiet spell" }
)

Write-Head "Idle timeouts (mains power)"
foreach ($t in $timeouts) {
    $current = Get-AcIndex $t.Sub $t.Setting
    if ($current -eq 0) {
        Write-Host ("  OK       {0,-26} never" -f $t.Label) -ForegroundColor Green
        $alreadyOk += $t.Label
        continue
    }
    Write-Host ("  CHANGE   {0,-26} {1}  ->  never" -f $t.Label, (Show-Seconds $current)) -ForegroundColor Yellow
    Write-Host ("             because {0}" -f $t.Why) -ForegroundColor DarkGray
    $changes += $t.Label
    if ($Apply) {
        & powercfg /setacvalueindex SCHEME_CURRENT $t.Sub $t.Setting 0 | Out-Null
    }
}

# ------------------------------------------------------- USB selective suspend
# Not about power saving: a scanner or an external drive holding a storage
# location that has been suspended comes back as an I/O error, which the
# pipeline records as a file that failed to hash. The saving is milliwatts.
Write-Head "USB selective suspend"
$usb = Get-AcIndex $SUB_USB $USBSUSPEND
if ($null -eq $usb) {
    Write-Host "  ?        this machine exposes no USB selective-suspend setting -- nothing to do" -ForegroundColor DarkGray
} elseif ($usb -eq 0) {
    Write-Host "  OK       already disabled" -ForegroundColor Green
    $alreadyOk += "USB selective suspend"
} else {
    Write-Host "  CHANGE   enabled  ->  disabled" -ForegroundColor Yellow
    Write-Host "             a suspended external disk reads as an I/O error, not as a retry" -ForegroundColor DarkGray
    $changes += "USB selective suspend"
    if ($Apply) { & powercfg /setacvalueindex SCHEME_CURRENT $SUB_USB $USBSUSPEND 0 | Out-Null }
}

if ($Apply -and $changes.Count -gt 0) {
    # Nothing above takes effect until the scheme is re-activated. Omitting
    # this is the classic powercfg mistake: every command returns success and
    # nothing changes.
    & powercfg /setactive SCHEME_CURRENT | Out-Null
}

# ------------------------------------------------------------- fast startup
#
# "Shut down" with Fast Startup on is not a shutdown -- it hibernates the
# kernel session and restores it next time. Two consequences that matter here:
# a driver or service in a bad state survives the "reboot" that was supposed to
# clear it, and the boot path taken on resume is not the one taken after a
# power cut, so the recovery you tested is not the recovery you get.
#
# Opt-in because it genuinely costs a slower cold boot on a mechanical disk.
Write-Head "Fast Startup"
$hiberboot = $null
try {
    $hiberboot = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' `
                  -Name HiberbootEnabled -ErrorAction Stop).HiberbootEnabled
} catch { }

if ($hiberboot -eq 0) {
    Write-Host "  OK       already disabled" -ForegroundColor Green
} elseif (-not $IncludeFastStartup) {
    Write-Host "  SKIPPED  enabled -- pass -IncludeFastStartup to disable it" -ForegroundColor DarkYellow
    Write-Host "             it makes 'shut down' a hibernate, so a reboot may not clear a stuck driver" -ForegroundColor DarkGray
} elseif (-not $isAdmin) {
    Write-Host "  BLOCKED  needs an elevated PowerShell" -ForegroundColor Red
} else {
    Write-Host "  CHANGE   enabled  ->  disabled" -ForegroundColor Yellow
    $changes += "Fast Startup"
    if ($Apply) {
        Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' `
            -Name HiberbootEnabled -Value 0 -Type DWord
    }
}

# ------------------------------------------------------------------- the NIC
#
# "Allow the computer to turn off this device to save power" is per-adapter and
# independent of the power plan. When Windows powers the NIC down, Tailscale
# does not fail -- it drops off the tailnet and reconnects a moment later,
# repeatedly, and the visible symptom is Atlas being intermittently unreachable
# from the phone with nothing wrong on the machine itself.
Write-Head "Network adapter power management"
$adapters = @()
try {
    $adapters = Get-NetAdapter -Physical -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' }
} catch {
    Write-Host "  Could not enumerate adapters: $($_.Exception.Message)" -ForegroundColor DarkGray
}

foreach ($a in $adapters) {
    $pm = $null
    try { $pm = Get-NetAdapterPowerManagement -Name $a.Name -ErrorAction Stop } catch { }
    if (-not $pm) {
        Write-Host ("  ?        {0}: no power-management settings exposed" -f $a.Name) -ForegroundColor DarkGray
        continue
    }
    if ($pm.AllowComputerToTurnOffDevice -eq 'Disabled') {
        Write-Host ("  OK       {0}: already prevented from being powered down" -f $a.Name) -ForegroundColor Green
        continue
    }
    if (-not $IncludeNic) {
        Write-Host ("  SKIPPED  {0}: pass -IncludeNic to stop Windows powering it down" -f $a.Name) -ForegroundColor DarkYellow
        continue
    }
    if (-not $isAdmin) {
        Write-Host ("  BLOCKED  {0}: needs an elevated PowerShell" -f $a.Name) -ForegroundColor Red
        continue
    }
    Write-Host ("  CHANGE   {0}: allowed  ->  prevented" -f $a.Name) -ForegroundColor Yellow
    $changes += "NIC power management ($($a.Name))"
    if ($Apply) {
        $pm.AllowComputerToTurnOffDevice = 'Disabled'
        Set-NetAdapterPowerManagement -InputObject $pm
    }
}

# ------------------------------------------------------------------ verdict
Write-Head "Result"
if ($changes.Count -eq 0) {
    Write-Host "  Nothing to change -- this machine is already configured to stay awake." -ForegroundColor Green
} elseif ($Apply) {
    Write-Host ("  Applied {0} change(s):" -f $changes.Count) -ForegroundColor Green
    $changes | ForEach-Object { Write-Host "    - $_" }
    Write-Host ""
    Write-Host "  Confirm by re-running this script: everything should report OK."
} else {
    Write-Host ("  {0} change(s) needed. Nothing was written -- this was a dry run." -f $changes.Count) -ForegroundColor Yellow
    Write-Host "  Re-run with -Apply to make them."
}

Write-Host ""
Write-Host "STILL NOT COVERED BY ANY SCRIPT:" -ForegroundColor Yellow
Write-Host "  A power cut. Software cannot start a computer that has no power."
Write-Host "  Set 'Restore on AC Power Loss' (or 'AC Back' / 'After Power Failure')"
Write-Host "  to 'Power On' in the BIOS/UEFI, and put the machine on a UPS so a"
Write-Host "  brief cut does not become a reboot at all."
Write-Host "  See docs/12-server-operations.md."
Write-Host ""
