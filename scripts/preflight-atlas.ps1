# Decides what start-atlas.bat should launch, and is the whole reason that
# script can run unattended every few minutes without doing damage.
#
# WHY THIS IS ITS OWN FILE
#
# It used to be two one-line PowerShell commands embedded in the .bat. Both
# were wrong in ways that stayed invisible until Atlas had been down for a
# day, and neither could be exercised without actually starting the platform.
#
# So the decision lives in a function that takes a list of processes, and the
# live process list is only fetched at the bottom. test-preflight-atlas.ps1
# dot-sources this file and calls that function with made-up processes, which
# is how the cases below are checked WITHOUT having to stop a running Atlas to
# reproduce an outage. A guard that can only be tested by breaking production
# is a guard nobody tests.
#
# EXIT CODES. start-atlas.bat tests these in DESCENDING order, because cmd's
# `if errorlevel N` means "N or greater", not "equals N".
#
#   0  start both -- nothing of ours is running
#   1  refuse -- a live development server is running
#   2  start the API only -- the worker is already up
#   3  start the worker only -- the API is already up
#   4  refuse -- both are already running

$ErrorActionPreference = "Stop"

# ONE SPELLING OF A PATH.
#
# Every previous version of this guard carried a comment warning that the
# production launcher writes "src\server.js" while the npm scripts write
# "src/server.js", and that matching one spelling silently misses the other.
# It then tried to hold both spellings in a regex character class -- which is
# precisely the fragile part, since a single dropped backslash turns
# "backslash or slash" into "slash only" and the guard stops seeing the
# production API it exists to find. That is not hypothetical: it happened
# while writing this file, and the guard reported "nothing is running" with
# Atlas running in front of it.
#
# So the spelling is normalised once, here, by character code. Nothing below
# contains a backslash escape, and the whole class of bug goes with it.
function Get-Cmd($p) {
    if ($null -eq $p.CommandLine) { return "" }
    return $p.CommandLine.Replace([char]92, [char]47)
}

# BOTH FORMS OF A DEV SERVER.
#
# This is the bug that took Atlas down from 2026-08-29 to 08-31. The old check
# looked for 'nodemon' alone. The dev script had moved to
# `node --watch src/server.js`, so five abandoned watchers were never
# recognised as dev servers at all -- they fell through to the "is Atlas
# running?" question, matched server.js there, and made the watchdog report
# "Atlas is already running" 1,049 times while the worker was dead.
function Test-IsDev($p) {
    $c = Get-Cmd $p
    return ($c -match 'nodemon') -or ($c -match '--watch')
}

function Get-AtlasAction {
    param([object[]]$Processes)

    $node = @($Processes)

    # A parent -> children index. Needed to tell a working watcher from a
    # husk; see the staleness rule below.
    $children = @{}
    foreach ($p in $node) {
        $key = [string]$p.ParentProcessId
        if (-not $children.ContainsKey($key)) { $children[$key] = @() }
        $children[$key] += $p
    }

    $dev = @($node | Where-Object { Test-IsDev $_ })

    # THE STALENESS RULE.
    #
    # `node --watch` and nodemon both run the server as a CHILD process, and
    # both deliberately stay alive after that child exits, waiting for a file
    # change that will never come once the terminal is gone. So a watcher with
    # no child is not a running server, it is a husk -- and treating it as
    # proof that Atlas was up is exactly what kept the platform down.
    #
    # The presence of a process is not evidence of service. A watcher counts
    # only if something is still running underneath it.
    $liveDev = @($dev | Where-Object { $children.ContainsKey([string]$_.ProcessId) })
    $husks   = @($dev | Where-Object { -not $children.ContainsKey([string]$_.ProcessId) })

    foreach ($h in $husks) {
        Write-Host ("  ignoring stale dev watcher PID " + $h.ProcessId + " -- no child process, its server has exited")
    }

    if ($liveDev.Count -gt 0) {
        foreach ($d in $liveDev) { Write-Host ("  live dev server PID " + $d.ProcessId) }
        return 1
    }

    # THE API AND THE WORKER ARE ASKED ABOUT SEPARATELY.
    #
    # The old check OR-ed them into a single question, so a surviving API
    # proved "Atlas is running" and the watchdog could never restart a dead
    # worker. That half-down state is the one that hurts most: the UI answers
    # normally while nothing consumes the job queue, so no file is scanned,
    # hashed, classified or organised, and nothing anywhere says so.
    #
    # Dev processes are excluded from both. A watcher's child is spelled
    # exactly like the production API, so counting it here would let a dev
    # server pose as the production one. It cannot reach this point anyway --
    # a live watcher returns above -- but the exclusion makes that a property
    # of this filter rather than an accident of ordering.
    $api = @($node | Where-Object { -not (Test-IsDev $_) -and (Get-Cmd $_) -match 'src/server\.js' })
    $wrk = @($node | Where-Object { -not (Test-IsDev $_) -and (Get-Cmd $_) -match 'workers/runner\.js' })

    if ($api.Count -gt 0 -and $wrk.Count -gt 0) { return 4 }
    if ($api.Count -gt 0) { Write-Host "  API is up, worker is missing"; return 3 }
    if ($wrk.Count -gt 0) { Write-Host "  worker is up, API is missing"; return 2 }
    return 0
}

# Only decide-and-exit when this file is RUN. When it is dot-sourced (by the
# test script) InvocationName is ".", and it should define the functions and
# stop -- exiting there would kill the test run on its first case.
if ($MyInvocation.InvocationName -ne '.') {
    exit (Get-AtlasAction -Processes @(Get-CimInstance Win32_Process -Filter "Name='node.exe'"))
}
