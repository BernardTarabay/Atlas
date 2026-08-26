# Puts Atlas behind a real HTTPS name on the owner's private network.
#
# WHAT THIS SOLVES
#
# Atlas serves the UI on port 5000, so reaching it from a second device means
# handing someone http://192.168.1.101:5000. That address is wrong in three
# ways at once:
#
#   1. It moves. It is a DHCP lease, so it changes when the router reboots and
#      the client is left with a bookmark that goes nowhere.
#   2. It only exists on that LAN. Off the network, there is no Atlas.
#   3. It is not a secure context, and that is the load-bearing one: browsers
#      refuse to register a service worker over plain http on a non-loopback
#      address, so `Add to Home Screen` never appears and Atlas can never be
#      installed as an app on a phone. The manifest and worker are correct and
#      simply never get the chance to run.
#
# `tailscale serve` fixes all three: a stable MagicDNS name, reachable from any
# device signed into the same tailnet whether or not it is on the LAN, with a
# genuine Let's Encrypt certificate. No port forwarding, no router config, no
# self-signed certificate to install on every device, nothing exposed to the
# public internet.
#
#   .\scripts\install-tailscale-serve.ps1           set it up, print the URL
#   .\scripts\install-tailscale-serve.ps1 -Status   show the current config
#   .\scripts\install-tailscale-serve.ps1 -Remove   tear it down
#
# SERVE, NOT FUNNEL. `tailscale funnel` publishes to the entire internet. This
# script only ever calls `serve`, which is reachable exclusively by devices
# signed into this tailnet. On a machine that indexes someone's private
# documents that distinction is the whole security model, so it is not exposed
# as an option here -- turning it on should require deliberately typing a
# different command, not passing a flag to this one.

param(
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = "Stop"

$Port = 5000
$Root = Split-Path -Parent $PSScriptRoot

# How long `tailscale serve` gets before it is assumed to be waiting on someone
# rather than working. Generous: it provisions a certificate on first run, which
# is a real network round trip, and killing a legitimate slow success would be a
# worse bug than the hang this guards against.
$ServeTimeoutSeconds = 45

# ---------------------------------------------------------------------------
# Locate the CLI.
#
# Deliberately does NOT install Tailscale. Installing it requires accepting its
# terms and signing into an account, which is the operator's decision to make
# and cannot be made on their behalf by a script.
# ---------------------------------------------------------------------------
$tailscale = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tailscale) {
    $fallback = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
    if (Test-Path $fallback) { $tailscale = $fallback }
}

if (-not $tailscale) {
    Write-Host ""
    Write-Host "Tailscale is not installed on this machine." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  1. Install it:      https://tailscale.com/download/windows"
    Write-Host "  2. Sign in, and sign the client's phone/laptop into the SAME account."
    Write-Host "  3. In the admin console, enable MagicDNS and HTTPS Certificates:"
    Write-Host "     https://login.tailscale.com/admin/dns"
    Write-Host "  4. Run this script again."
    Write-Host ""
    exit 1
}

function Get-TailscaleSelf {
    $raw = & $tailscale status --json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    try { return ($raw | ConvertFrom-Json).Self } catch { return $null }
}

# ---------------------------------------------------------------------------
# Teardown / inspection
# ---------------------------------------------------------------------------
if ($Remove) {
    & $tailscale serve reset
    if ($?) { Write-Host "Removed the Atlas serve configuration." -ForegroundColor Green }
    Write-Host "Atlas is still running on http://localhost:$Port -- only the HTTPS name is gone."
    return
}

if ($Status) {
    & $tailscale serve status
    return
}

# ---------------------------------------------------------------------------
# Preconditions, each checked separately so a failure names itself.
#
# `tailscale serve` reports most of these as one generic error, which is what
# makes this setup annoying to debug. Asking each question directly costs three
# subprocess calls and turns "something went wrong" into an instruction.
# ---------------------------------------------------------------------------
$self = Get-TailscaleSelf
if (-not $self) {
    Write-Host "Tailscale is installed but not signed in." -ForegroundColor Yellow
    Write-Host "Run:  tailscale up"
    exit 1
}

$dnsName = $self.DNSName
if (-not $dnsName) {
    Write-Host "This machine has no MagicDNS name." -ForegroundColor Yellow
    Write-Host "Enable MagicDNS: https://login.tailscale.com/admin/dns"
    exit 1
}
$host_name = $dnsName.TrimEnd('.')
$url = "https://$host_name"

# Are HTTPS certificates enabled for the tailnet?
#
# Without them there is no certificate to terminate TLS with, and `serve` cannot
# work. The node advertises this as an 'https' capability, so it can be asked
# before doing anything -- which is much better than finding out from a command
# that stops and waits (see the timeout below for why that matters).
$caps = @()
if ($self.CapMap) { $caps = $self.CapMap.PSObject.Properties.Name }
elseif ($self.Capabilities) { $caps = $self.Capabilities }

if ($caps -notcontains "https") {
    Write-Host "HTTPS certificates are not enabled for this tailnet." -ForegroundColor Yellow
    Write-Host "Enable them, then re-run this script:"
    Write-Host "  https://login.tailscale.com/admin/dns"
    exit 1
}

# Is Atlas actually up? Serving a name that proxies to a dead port produces a
# 502 from Tailscale, which reads like a Tailscale problem and is not one.
$atlasUp = $false
try {
    $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 5
    $atlasUp = ($probe.StatusCode -eq 200)
} catch { $atlasUp = $false }

if (-not $atlasUp) {
    Write-Host "Warning: nothing is answering http://127.0.0.1:$Port/api/health" -ForegroundColor Yellow
    Write-Host "         Start Atlas first (scripts\start-atlas.bat), or the HTTPS name will 502."
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Configure the proxy.
#
# --bg keeps it running after this shell exits AND persists it across reboots:
# the config lives in tailscaled, not in this process, so it comes back with
# the service. That matters because the whole point is an address the client
# can rely on without anyone logging into this machine to re-establish it.
# ---------------------------------------------------------------------------
Write-Host "Configuring tailscale serve -> http://127.0.0.1:$Port ..."

# RUN IT WITH A DEADLINE, because it does not always come back.
#
# This was written assuming `tailscale serve` reports a missing precondition by
# exiting non-zero. It does not. With Serve not yet enabled on the tailnet it
# prints an enablement URL and then BLOCKS, waiting for someone to click it --
# so the first real run of this script never returned. `$LASTEXITCODE` is never
# reached, and an exit-code check is not a guard against a command that has not
# exited.
#
# A deadline is used rather than a check for that one condition on purpose:
# whatever else Tailscale might one day stop and wait for, the failure mode this
# has to survive is "hangs", not "hangs for this specific reason". A script wired
# into a logon task must fail rather than wait forever.
#
# Output is captured to files instead of inherited, so it can still be shown
# after a kill -- the enablement URL is printed before it blocks, and it is the
# single most useful thing to hand back.
# System.Diagnostics.Process rather than Start-Process -PassThru.
#
# Start-Process's object does not populate ExitCode here -- it came back empty
# even for `cmd /c exit 3`, which reported a SUCCESSFUL serve as a failure the
# first time this was tested. The documented `$p.Handle` workaround did not help
# either. Constructing the process directly gives a real ExitCode.
#
# The streams are drained ASYNCHRONOUSLY, started before the wait. Reading them
# synchronously would deadlock the moment the output outgrew the pipe buffer --
# the child blocks writing, the parent blocks reading, and the timeout below
# never gets a chance to run because we are stuck before reaching it.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $tailscale
$psi.Arguments = "serve --bg $Port"
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true

$proc = [System.Diagnostics.Process]::Start($psi)
$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()

$exited = $proc.WaitForExit($ServeTimeoutSeconds * 1000)
if (-not $exited) { try { $proc.Kill() } catch { } }

# Killing the child closes its stream ends, so both tasks complete either way.
$serveOutput = @()
foreach ($task in @($outTask, $errTask)) {
    try { if ($task.Result) { $serveOutput += ($task.Result -split "`r?`n" | Where-Object { $_ -ne "" }) } } catch { }
}

if (-not $exited) {
    Write-Host ""
    Write-Host "tailscale serve did not finish within $ServeTimeoutSeconds seconds - stopped it." -ForegroundColor Red
    Write-Host ""
    if ($serveOutput) {
        Write-Host "It said:" -ForegroundColor Yellow
        $serveOutput | ForEach-Object { Write-Host "  $_" }
        Write-Host ""
    }
    Write-Host "It waits rather than failing when the tailnet has not enabled Serve."
    Write-Host "If a link is shown above, open it, approve it, then re-run this script."
    exit 1
}

if ($proc.ExitCode -ne 0) {
    Write-Host ""
    Write-Host "tailscale serve failed (exit $($proc.ExitCode))." -ForegroundColor Red
    if ($serveOutput) { $serveOutput | ForEach-Object { Write-Host "  $_" } }
    Write-Host ""
    Write-Host "Enable HTTPS certificates and Serve, then re-run:"
    Write-Host "  https://login.tailscale.com/admin/dns"
    exit 1
}

$serveOutput | ForEach-Object { Write-Host $_ }

Write-Host ""
Write-Host "Atlas is now reachable at:" -ForegroundColor Green
Write-Host "  $url" -ForegroundColor Green
Write-Host ""
Write-Host "On this machine, http://localhost:$Port still works and is faster --"
Write-Host "the desktop shortcut is right to keep pointing at it."
Write-Host ""
Write-Host "On the client's phone or laptop:"
Write-Host "  1. Install Tailscale and sign into the same account."
Write-Host "  2. Open $url"
Write-Host "  3. Install it: Chrome/Edge show an install icon in the address bar;"
Write-Host "     iOS Safari uses Share -> Add to Home Screen."
Write-Host ""
Write-Host "Note: this is a different origin from the LAN address, so signing in"
Write-Host "      again there is expected -- tokens are per-origin."
Write-Host ""
Write-Host "Confirm the install metadata is being served correctly over TLS:"
Write-Host "  cd frontend; npm run verify:pwa -- $url"
Write-Host ""
