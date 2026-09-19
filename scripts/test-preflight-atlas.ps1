# Tests the start guard against made-up process lists.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-preflight-atlas.ps1
#
# Every case here is a state Atlas has actually been in, including the one
# that kept it down for two days. None of them require stopping the running
# platform to reproduce, which is the point.

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "preflight-atlas.ps1")

$script:failed = 0

function Proc($pid_, $ppid, $cmd) {
    [PSCustomObject]@{ ProcessId = $pid_; ParentProcessId = $ppid; CommandLine = $cmd }
}

function Case($name, $expected, $procs) {
    $actual = Get-AtlasAction -Processes @($procs)
    if ($actual -eq $expected) {
        Write-Host ("  PASS  " + $name + "  -> " + $actual)
    } else {
        Write-Host ("  FAIL  " + $name + "  expected " + $expected + ", got " + $actual)
        $script:failed++
    }
}

Write-Host "preflight-atlas decisions:"

Case "nothing running -> start both" 0 @()

Case "healthy Atlas -> refuse, both up" 4 @(
    (Proc 100 1 'node  src\server.js'),
    (Proc 101 1 'node  src\workers\runner.js')
)

# The half-down state the old OR-ed guard could never repair.
Case "API up, worker dead -> start worker only" 3 @(
    (Proc 100 1 'node  src\server.js')
)

Case "worker up, API dead -> start API only" 2 @(
    (Proc 101 1 'node  src\workers\runner.js')
)

# THE OUTAGE OF 2026-08-29..31, exactly as it was found: five abandoned
# `node --watch src/server.js` parents whose children had exited, no API, no
# worker. The old guard answered "Atlas is already running" and refused 1,049
# times. The correct answer is to start both.
Case "stale dev husks only -> start both" 0 @(
    (Proc 200 1 'node  --watch src/server.js'),
    (Proc 201 1 'node  --watch src/server.js'),
    (Proc 202 1 'node  --watch src/server.js'),
    (Proc 203 1 'node  --watch src/server.js'),
    (Proc 204 1 'node  --watch src/server.js')
)

# A husk must not mask a genuinely dead worker either.
Case "stale husk plus live API -> start worker only" 3 @(
    (Proc 200 1 'node  --watch src/server.js'),
    (Proc 100 1 'node  src\server.js')
)

# A watcher WITH a child is a real dev server: refuse, as always.
Case "live dev watcher -> refuse" 1 @(
    (Proc 300 1 'node  --watch src/server.js'),
    (Proc 301 300 'node  src/server.js')
)

Case "live nodemon -> refuse" 1 @(
    (Proc 400 1 'node  node_modules/nodemon/bin/nodemon.js src/server.js'),
    (Proc 401 400 'node  src/server.js')
)

# A dev watcher's child is spelled like the production API. It must never be
# counted as production -- the refusal above is the correct answer, not
# "Atlas is already running".
Case "dev child is not the production API" 1 @(
    (Proc 300 1 'node  --watch src/server.js'),
    (Proc 301 300 'node  src/server.js'),
    (Proc 101 1 'node  src\workers\runner.js')
)

# Both path spellings must be seen. This is the assertion that fails if the
# backslash normalisation is ever replaced with a regex character class again.
Case "forward-slash spelling is recognised" 4 @(
    (Proc 100 1 'node  src/server.js'),
    (Proc 101 1 'node  src/workers/runner.js')
)

Case "backslash spelling is recognised" 4 @(
    (Proc 100 1 'node  src\server.js'),
    (Proc 101 1 'node  src\workers\runner.js')
)

# Unrelated node processes on this machine (editors, tooling) must not count.
Case "unrelated node is ignored" 0 @(
    (Proc 500 1 'node  C:\Users\x\AppData\Local\some-editor\server.js'),
    (Proc 501 1 'node  scripts/dev-db.js'),
    (Proc 502 1 $null)
)

Write-Host ""
if ($script:failed -gt 0) {
    Write-Host ("FAILED: " + $script:failed + " case(s)")
    exit 1
}
Write-Host "All cases passed."
exit 0
