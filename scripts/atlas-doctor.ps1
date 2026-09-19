# "Atlas is down." One command that answers why, from anywhere on the tailnet.
#
# WHY THIS EXISTS
#
# Everything below could be worked out by hand -- Get-Service, Get-CimInstance,
# powercfg, tailscale status, curl, tail a log. That is roughly a dozen
# commands whose names and flags you have to remember while somebody is waiting,
# and the mistake this prevents is not forgetting one: it is stopping at the
# FIRST thing that looks wrong.
#
# The half-down states are the ones that cost days here. An API answering with
# a dead worker looks completely healthy from a browser: pages load, files
# list, and nothing at all is being scanned, hashed or classified. A pipeline
# busy re-queueing the same 1,426 files looks healthy to every depth-based
# check there is. So this asks every question every time and prints the whole
# answer, including the parts that are fine.
#
# READ-ONLY. It starts nothing, stops nothing and writes nothing. Diagnosis
# should never be the thing that changes the state you are diagnosing.
#
#   .\scripts\atlas-doctor.ps1            the full report
#   .\scripts\atlas-doctor.ps1 -Brief     skip the log tails
#   .\scripts\atlas-doctor.ps1 -Log       also append one line to logs/atlas-health.log
#
# THE HISTORY, AND WHY IT IS ONE LINE
#
# -Log exists for a question the live report cannot answer: "it is fine NOW --
# was it fine at four in the morning?". The watchdog's log records starts and
# refusals, which tells you when Atlas was restarted and not whether it was
# healthy in between.
#
# One line per run, so a check every fifteen minutes costs a few hundred KB a
# year and can be read with your eyes. To schedule it (no admin needed) see
# docs/12-server-operations.md, which carries the exact command.
#
# Deliberately NOT registered by install-autostart.ps1. It is a diagnostic
# convenience, not part of keeping Atlas up, and adding always-on machinery to
# someone else's computer should be something they chose.
#
# Over Tailscale, from the developer's machine, this is:
#   ssh <user>@atlas   then  cd <repo>; .\scripts\atlas-doctor.ps1
# See docs/12-server-operations.md for how that session is set up.

param(
    [switch]$Brief,
    [switch]$Log,
    [int]$Port = 5000
)

# NOT "Stop". This script's whole job is to keep going and report -- and the
# things it inspects are, by definition, the things that might be broken. A
# terminating error on the first missing service would abandon the report at
# the exact moment it is most needed.
$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot
$issues = @()
$Ok    = { param($m) Write-Host "  [ ok ] $m" -ForegroundColor Green }
$Bad   = { param($m) Write-Host "  [FAIL] $m" -ForegroundColor Red }
$Warn  = { param($m) Write-Host "  [warn] $m" -ForegroundColor Yellow }
$Note  = { param($m) Write-Host "         $m" -ForegroundColor DarkGray }

function Section($t) {
    Write-Host ""
    Write-Host "== $t " -NoNewline -ForegroundColor Cyan
    Write-Host ("=" * [Math]::Max(0, 62 - $t.Length)) -ForegroundColor Cyan
}

Write-Host ""
Write-Host "Atlas doctor -- $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') on $env:COMPUTERNAME" -ForegroundColor White

# ---------------------------------------------------------------- services
Section "Services Atlas depends on"
foreach ($svc in @(
    @{ Match = 'postgresql'; Label = 'PostgreSQL'; Fatal = $true },
    @{ Match = '^Tailscale$'; Label = 'Tailscale';  Fatal = $false }
)) {
    $s = Get-Service | Where-Object { $_.Name -match $svc.Match } | Select-Object -First 1
    if (-not $s) {
        & $Bad "$($svc.Label) service not found"
        $issues += "$($svc.Label) is not installed as a service"
        continue
    }
    if ($s.Status -eq 'Running' -and $s.StartType -eq 'Automatic') {
        & $Ok "$($svc.Label) ($($s.Name)) running, Automatic"
    } elseif ($s.Status -eq 'Running') {
        & $Warn "$($svc.Label) running but StartType is $($s.StartType) -- it will not come back after a reboot"
        $issues += "$($svc.Label) StartType is $($s.StartType), should be Automatic"
    } else {
        & $Bad "$($svc.Label) is $($s.Status)"
        $issues += "$($svc.Label) is not running"
    }
}

# ------------------------------------------------------------- our processes
#
# By PROCESS, and asking about the API and the worker SEPARATELY -- the same
# two rules preflight-atlas.ps1 exists to enforce, and for the same reason. A
# port probe cannot see an API that lost the race for 5000 and is alive but
# unbound, and OR-ing the two hides the half-down state that hurts most.
Section "Atlas processes"
$node = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
$norm = { param($p) if ($null -eq $p.CommandLine) { "" } else { $p.CommandLine.Replace([char]92, [char]47) } }

$api = @($node | Where-Object { (& $norm $_) -match 'src/server\.js' -and (& $norm $_) -notmatch 'nodemon|--watch' })
$wrk = @($node | Where-Object { (& $norm $_) -match 'workers/runner\.js' -and (& $norm $_) -notmatch 'nodemon|--watch' })
$dev = @($node | Where-Object { (& $norm $_) -match 'nodemon|--watch' })

if ($api.Count -eq 1) { & $Ok "API      PID $($api[0].ProcessId)" }
elseif ($api.Count -eq 0) { & $Bad "API      not running"; $issues += "the API is not running" }
else { & $Bad "API      $($api.Count) copies running -- they are fighting over port $Port"; $issues += "$($api.Count) API processes" }

if ($wrk.Count -eq 1) { & $Ok "worker   PID $($wrk[0].ProcessId)" }
elseif ($wrk.Count -eq 0) {
    & $Bad "worker   not running -- the UI will answer normally and NOTHING will be processed"
    $issues += "the worker is not running"
} else {
    & $Bad "worker   $($wrk.Count) copies running -- double the Gemini spend"
    $issues += "$($wrk.Count) worker processes"
}
if ($dev.Count -gt 0) { & $Warn "$($dev.Count) development watcher(s) present (nodemon / node --watch)" }

# ------------------------------------------------------------------- health
#
# The API's own opinion. Asked over loopback rather than over the tailnet name
# on purpose: this separates "Atlas is broken" from "the tunnel is broken",
# which are different problems with different fixes and look identical from a
# phone.
Section "API health (loopback)"
$health = $null
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 8
    $health = $r.Content | ConvertFrom-Json
} catch {
    & $Bad "no answer on http://127.0.0.1:$Port/api/health -- $($_.Exception.Message)"
    $issues += "the API is not answering on loopback"
}

if ($health) {
    if ($health.status -eq 'ok') { & $Ok "status: ok" } else { & $Warn "status: $($health.status)"; $issues += "health reports '$($health.status)'" }
    & $Note "database   : $($health.database)"
    if ($health.queue) {
        & $Note "queue      : $($health.queue.queued) queued, $($health.queue.workers) worker(s), oldest $($health.queue.oldestQueuedSeconds)s"
        # A worker PROCESS with no worker REGISTERED means it is running and not
        # claiming -- a distinct failure from the process being gone, and one
        # that looks identical from the process list.
        if ($wrk.Count -gt 0 -and $health.queue.workers -eq 0) {
            & $Warn "a worker process exists but the queue sees none registered"
            $issues += "the worker is running but not claiming jobs"
        }
    }
    if ($health.files) { & $Note "files      : $($health.files.awaitingRecovery) awaiting recovery, $($health.files.failedTerminal) failed for good" }
    if ($health.pipeline) { & $Note "pipeline   : $($health.pipeline.jobs24h) jobs/24h, $($health.pipeline.jobsPerFile) per file" }
    foreach ($w in $health.warnings) { & $Warn $w; $issues += $w }
}

# ---------------------------------------------------------------- tailscale
Section "Tailscale"
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) {
    $fallback = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
    if (Test-Path $fallback) { $ts = $fallback }
}
if (-not $ts) {
    & $Warn "the Tailscale CLI is not on this machine -- remote access is LAN-only"
} else {
    $self = $null
    try { $self = (& $ts status --json | ConvertFrom-Json) } catch { }
    if (-not $self) {
        & $Bad "tailscale status returned nothing -- signed out?"
        $issues += "Tailscale is not signed in"
    } else {
        if ($self.BackendState -eq 'Running') { & $Ok "backend: Running" }
        else { & $Bad "backend: $($self.BackendState)"; $issues += "Tailscale backend is $($self.BackendState)" }
        $name = if ($self.Self.DNSName) { $self.Self.DNSName.TrimEnd('.') } else { "(no MagicDNS name)" }
        & $Note "name       : $name"
        & $Note "addresses  : $($self.Self.TailscaleIPs -join ', ')"
        if ($self.Self.Online) { & $Ok "this node reports itself online" }
        else { & $Warn "this node is not currently online to the coordination server" }

        $serve = & $ts serve status
        if ($LASTEXITCODE -eq 0 -and ($serve -join "`n") -match "127\.0\.0\.1:$Port") {
            & $Ok "serve proxies https://$name -> http://127.0.0.1:$Port"
        } else {
            & $Warn "no serve config pointing at port $Port -- the HTTPS name will not reach Atlas"
            & $Note "fix: .\scripts\install-tailscale-serve.ps1"
            $issues += "tailscale serve is not configured"
        }
        # Never quietly. Funnel publishes a private document index to the open
        # internet, and it is the one setting on this machine whose accidental
        # presence is a security incident rather than an outage.
        if (($serve -join "`n") -match 'Funnel') {
            & $Bad "FUNNEL IS ON -- this machine is published to the public internet"
            $issues += "tailscale FUNNEL is enabled; run 'tailscale funnel off'"
        }
    }
}

# --------------------------------------------------------------- the watchdog
Section "Autostart and watchdog"
$task = $null
try { $task = Get-ScheduledTask -TaskName "Atlas Document Platform" -ErrorAction Stop } catch { }
if (-not $task) {
    & $Bad "the 'Atlas Document Platform' task is not registered -- Atlas will not start on its own"
    $issues += "the autostart task is missing (run scripts\install-autostart.ps1)"
} else {
    & $Ok "task registered, state: $($task.State)"
    $triggers = @($task.Triggers | ForEach-Object { $_.CimClass.CimClassName })
    $hasBoot = $triggers -contains 'MSFT_TaskBootTrigger'
    if ($hasBoot) { & $Ok "has a BOOT trigger -- starts without anyone signing in" }
    else {
        & $Warn "no boot trigger: after an unattended reboot Atlas stays down until somebody logs in"
        $issues += "the autostart task has no boot trigger (re-run scripts\install-autostart.ps1)"
    }
    $logon = $task.Principal.LogonType
    if ($logon -eq 'S4U' -or $logon -eq 'Password') { & $Ok "runs whether or not the user is signed in ($logon)" }
    else { & $Warn "principal LogonType is $logon -- it needs an interactive session to run" }

    $info = Get-ScheduledTaskInfo -TaskName "Atlas Document Platform"
    # 0 now means "Atlas is up" rather than "the script exited cleanly" -- see
    # the exit-code block in start-atlas.bat.
    switch ($info.LastTaskResult) {
        0 { & $Ok "last run: Atlas was up" }
        2 { & $Warn "last run: refused because a development server owns port $Port" }
        default {
            & $Warn "last run result: $($info.LastTaskResult)"
            $issues += "the watchdog's last run returned $($info.LastTaskResult)"
        }
    }
    & $Note "last run   : $($info.LastRunTime)"
    & $Note "next run   : $($info.NextRunTime)"
}

# ------------------------------------------------------------------- power
#
# Included in a SOFTWARE diagnostic because it is the most likely cause of the
# outage this script gets run for, and because it is invisible from every other
# angle: a sleeping machine leaves no log line saying it went to sleep.
Section "Power (the thing that leaves no log)"
$sleepRaw = & powercfg /query SCHEME_CURRENT 238c9fa8-0aad-41ed-83f4-97be242c8f20 29f6c1db-86da-48c5-9fdb-f2b67b1f44da
if ($LASTEXITCODE -eq 0) {
    $line = ($sleepRaw -split "`r?`n") | Where-Object { $_ -match 'Current AC Power Setting Index' } | Select-Object -First 1
    $secs = if ($line) { [Convert]::ToInt64((($line -split ':')[1]).Trim(), 16) } else { $null }
    if ($secs -eq 0) { & $Ok "sleep on mains: never" }
    elseif ($null -ne $secs) {
        & $Bad "sleep on mains: after $([int]($secs/60)) minutes idle -- Atlas disappears with the machine"
        & $Note "fix: .\scripts\configure-server-power.ps1 -Apply"
        $issues += "the machine sleeps after $([int]($secs/60)) minutes"
    }
}
$wifi = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and $_.PhysicalMediaType -match '802.11|Native 802.11' })
if ($wifi.Count -gt 0) {
    & $Warn "this host is on Wi-Fi ($($wifi[0].Name)) -- a wired connection is materially more reliable for a server"
}

# --------------------------------------------------------------- log tails
if (-not $Brief) {
    Section "Recent logs"
    foreach ($f in @("atlas-start.log", "atlas-api.log", "atlas-worker.log")) {
        $path = Join-Path $Root "logs\$f"
        Write-Host ""
        if (Test-Path $path) {
            Write-Host "  --- $f (last 12 lines) ---" -ForegroundColor DarkCyan
            Get-Content $path -Tail 12 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        } else {
            Write-Host "  --- $f : not present ---" -ForegroundColor DarkGray
        }
    }
}

# ------------------------------------------------------------------ verdict
# One line, appended BEFORE the verdict is printed, so a run that is about to
# exit non-zero still leaves its record behind.
if ($Log) {
    $logDir = Join-Path $Root "logs"
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
    $verdict = if ($issues.Count -eq 0) { "ok" } else { "PROBLEMS($($issues.Count)): " + ($issues -join "; ") }
    $healthWord = if ($health) { $health.status } else { "unreachable" }
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path (Join-Path $logDir "atlas-health.log") -Encoding utf8 `
        -Value "[$stamp] api=$($api.Count) worker=$($wrk.Count) health=$healthWord $verdict"
}

Section "Verdict"
if ($issues.Count -eq 0) {
    Write-Host "  Everything checked is healthy." -ForegroundColor Green
    Write-Host ""
    exit 0
}
Write-Host "  $($issues.Count) problem(s):" -ForegroundColor Yellow
$issues | ForEach-Object { Write-Host "    - $_" -ForegroundColor Yellow }
Write-Host ""
Write-Host "  Most problems here are fixed by:  .\scripts\restart-atlas.bat" -ForegroundColor White
Write-Host "  Full runbook: docs/12-server-operations.md" -ForegroundColor White
Write-Host ""
# Non-zero so this composes: `atlas-doctor.ps1; if (-not $?) { ... }`, or a
# monitoring check that only needs to know whether to page someone.
exit 1
