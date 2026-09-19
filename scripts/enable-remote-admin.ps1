# Gives the developer a way in, over the tailnet and nowhere else.
#
# THE PROBLEM THIS SOLVES
#
# Atlas is reachable remotely; the MACHINE is not. `tailscale serve` publishes
# port 5000 and nothing else, so from anywhere but the keyboard you can read
# the document library and you cannot restart the worker, read a log, pull a
# fix, or find out why the API stopped. Every real maintenance action requires
# somebody to physically walk to the computer.
#
# WHAT THE OPTIONS ACTUALLY ARE ON THIS HOST, checked rather than assumed:
#
#   Tailscale SSH      NOT AVAILABLE. Tailscale's SSH *server* runs on Linux,
#                      macOS and BSD only; on Windows the client can originate
#                      a Tailscale SSH session but cannot accept one. This is
#                      the recommendation everyone reaches for first and it
#                      does not apply to a Windows host. (`tailscale up --ssh`
#                      is refused here.)
#
#   Remote Desktop     Depends on the edition, and the check below is not
#                      pedantry: Windows 11 HOME cannot HOST an RDP session at
#                      all -- it ships the client only. The Atlas machine this
#                      was written against is Home, so RDP is not the answer
#                      there. On Pro it is a reasonable second route.
#
#   OpenSSH Server     Available on every edition including Home, ships with
#                      Windows as an optional feature, gives a real PowerShell
#                      session, and -- the part that matters -- can be bound to
#                      ONE address. That is what makes "reachable over the
#                      tailnet and nowhere else" a property of the listener
#                      rather than a firewall rule somebody can undo.
#
# So: OpenSSH, bound to this node's Tailscale address.
#
# LEAST PRIVILEGE, CONCRETELY
#
#   - sshd listens on the Tailscale IP only. Not 0.0.0.0. A device on the same
#     Wi-Fi cannot see port 22, and neither can the internet; there is no port
#     forward and nothing to scan.
#   - The firewall rule is scoped to the tailnet range (100.64.0.0/10) as a
#     second, independent barrier. Either one alone would do; both means a
#     mistake in one is not an exposure.
#   - Tailscale ACLs are the third, and the only one that survives someone
#     editing this machine. The snippet is printed at the end -- apply it in
#     the admin console so that only the developer's own node may reach :22.
#
# WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
#
#   - It never creates, installs, prints or handles a key or a password. Key
#     material is the operator's to generate on their own machine and paste
#     into administrators_authorized_keys themselves; a script that did it for
#     them would put a private key somewhere neither of them chose.
#   - It does not enable password authentication. Instructions for turning
#     passwords OFF are printed instead, because an SSH server on a document
#     archive should accept a key or nothing.
#
#   .\scripts\enable-remote-admin.ps1               report what it would do
#   .\scripts\enable-remote-admin.ps1 -Apply        do it (elevated)
#   .\scripts\enable-remote-admin.ps1 -Remove       stop and disable sshd
#
# Dry run by default: this opens a way into somebody's computer, and that
# should never happen because a file was double-clicked.

param(
    [switch]$Apply,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$FirewallRule = "Atlas remote admin (SSH over Tailscale)"

function Head($t) {
    Write-Host ""
    Write-Host $t -ForegroundColor Cyan
    Write-Host ("-" * $t.Length)
}

Head "Where this machine stands"

$edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID
$caption = (Get-CimInstance Win32_OperatingSystem).Caption
Write-Host "  $caption  (EditionID: $edition)"

# RDP is reported on rather than configured. On Home it is impossible; on Pro
# it is a decision about exposing a full interactive desktop, which is a bigger
# grant than a shell and belongs to the operator, not to this script.
if ($edition -match 'Core') {
    Write-Host "  Remote Desktop HOSTING is not available on this edition -- SSH is the route." -ForegroundColor DarkGray
} else {
    Write-Host "  This edition can host Remote Desktop. See docs/12-server-operations.md before enabling it;" -ForegroundColor DarkGray
    Write-Host "  it grants a full desktop where SSH grants a shell, and it is not configured here." -ForegroundColor DarkGray
}

# ------------------------------------------------------- the tailnet address
#
# Everything below binds to this. Without it there is nothing to bind to, and
# binding to 0.0.0.0 instead would be exactly the exposure this avoids -- so a
# missing address is a hard stop, not a fallback.
$tailscale = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tailscale) {
    $fb = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
    if (Test-Path $fb) { $tailscale = $fb }
}

$tsIp = $null
$tsName = $null
if ($tailscale) {
    try {
        $st = & $tailscale status --json | ConvertFrom-Json
        $tsIp = @($st.Self.TailscaleIPs) | Where-Object { $_ -notmatch ':' } | Select-Object -First 1
        if ($st.Self.DNSName) { $tsName = $st.Self.DNSName.TrimEnd('.') }
    } catch { }
}

if (-not $tsIp) {
    Write-Host ""
    Write-Host "  No Tailscale IPv4 address on this machine." -ForegroundColor Red
    Write-Host "  Install Tailscale and sign in first -- without it there is no private network to"
    Write-Host "  restrict SSH to, and this script will not fall back to exposing it more widely."
    exit 1
}
Write-Host "  Tailscale address: $tsIp   ($tsName)" -ForegroundColor Green

# -------------------------------------------------------------------- remove
if ($Remove) {
    Head "Removing remote administration"
    if (-not $isAdmin) { Write-Host "  Needs an elevated PowerShell." -ForegroundColor Red; exit 1 }
    try { Stop-Service sshd -ErrorAction Stop; Write-Host "  sshd stopped." } catch { Write-Host "  sshd was not running." }
    try { Set-Service sshd -StartupType Disabled -ErrorAction Stop; Write-Host "  sshd set to Disabled." } catch { }
    try { Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction Stop; Write-Host "  Firewall rule removed." } catch { Write-Host "  No firewall rule to remove." }
    Write-Host ""
    Write-Host "  The OpenSSH feature is left INSTALLED -- removing a Windows capability is a"
    Write-Host "  slower and more disruptive operation than this script should perform, and a"
    Write-Host "  disabled service listens on nothing."
    exit 0
}

# ------------------------------------------------------------------- capability
Head "OpenSSH Server"
$cap = $null
try {
    $cap = Get-WindowsCapability -Online -Name OpenSSH.Server* | Select-Object -First 1
} catch {
    Write-Host "  Cannot query Windows capabilities without elevation." -ForegroundColor Yellow
    Write-Host "  Re-run this script from an elevated PowerShell to see the full picture."
}

if ($cap) { Write-Host "  $($cap.Name): $($cap.State)" }

$sshd = Get-Service sshd -ErrorAction SilentlyContinue
if ($sshd) { Write-Host "  sshd service: $($sshd.Status), StartType $($sshd.StartType)" }
else { Write-Host "  sshd service: not present" }

if (-not $Apply) {
    Head "Dry run -- nothing was changed"
    Write-Host "  With -Apply, and from an ELEVATED PowerShell, this would:"
    Write-Host "    1. Install the OpenSSH.Server Windows capability, if it is not installed."
    Write-Host "    2. Set the sshd service to Automatic and start it."
    Write-Host "    3. Write 'ListenAddress $tsIp' into sshd_config, so it listens ONLY on the"
    Write-Host "       tailnet -- not on the LAN, not on 0.0.0.0."
    Write-Host "    4. Add a firewall rule for TCP 22 scoped to 100.64.0.0/10."
    Write-Host "    5. Print the key setup and the Tailscale ACL to apply by hand."
    Write-Host ""
    Write-Host "  Re-run with -Apply once you have read the header of this file."
    exit 0
}

if (-not $isAdmin) {
    Write-Host ""
    Write-Host "  -Apply needs an elevated PowerShell (installing a Windows capability and" -ForegroundColor Red
    Write-Host "  writing a firewall rule both require it)." -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------------- 1. install
if ($cap -and $cap.State -ne 'Installed') {
    Write-Host "  Installing OpenSSH.Server ..." -ForegroundColor Yellow
    Add-WindowsCapability -Online -Name $cap.Name | Out-Null
    Write-Host "  Installed." -ForegroundColor Green
}

# --------------------------------------------------------------- 2. the service
# Automatic, not Manual: a maintenance route that needs somebody to start it is
# not a maintenance route. This is the service whose absence means driving to
# the office.
Set-Service -Name sshd -StartupType Automatic
Write-Host "  sshd set to Automatic." -ForegroundColor Green

# ------------------------------------------------------------ 3. bind narrowly
#
# ListenAddress is the load-bearing line. sshd's default is every interface;
# naming one address means the socket does not exist on the LAN at all, which
# is a stronger statement than any firewall rule -- there is nothing listening
# to filter.
#
# Rewritten idempotently rather than appended: running this twice must not
# leave two ListenAddress lines, and an existing 0.0.0.0 must be REPLACED
# rather than joined by a narrower one (sshd would honour both).
$cfg = Join-Path $env:ProgramData "ssh\sshd_config"
if (Test-Path $cfg) {
    $lines = Get-Content $cfg
    $kept = $lines | Where-Object { $_ -notmatch '^\s*#?\s*ListenAddress\b' -and $_ -notmatch '^# Atlas:' }
    $new = @(
        "# Atlas: bound to the tailnet only -- see scripts/enable-remote-admin.ps1.",
        "# Anything on the LAN, and the internet, has nothing to connect to.",
        "ListenAddress $tsIp"
    ) + $kept
    Set-Content -Path $cfg -Value $new -Encoding utf8
    Write-Host "  sshd_config: listening on $tsIp only." -ForegroundColor Green
} else {
    Write-Host "  sshd_config not found at $cfg -- start sshd once, then re-run." -ForegroundColor Yellow
}

Restart-Service sshd
Write-Host "  sshd restarted." -ForegroundColor Green

# ------------------------------------------------------------- 4. the firewall
#
# Second barrier, independent of the first. 100.64.0.0/10 is the CGNAT range
# Tailscale assigns from; scoping to it means that even if ListenAddress is
# ever widened by an upgrade or an edit, the rule still refuses everything that
# did not arrive over the tailnet.
#
# The stock "OpenSSH-Server-In-TCP" rule Windows adds is DISABLED here rather
# than left alongside: it allows any remote address, and a permissive rule next
# to a restrictive one is just a permissive rule.
try {
    Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction Stop | Disable-NetFirewallRule
    Write-Host "  Disabled the default any-address OpenSSH firewall rule." -ForegroundColor Green
} catch { }

try { Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction Stop } catch { }
New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 22 -RemoteAddress "100.64.0.0/10" -Profile Any | Out-Null
Write-Host "  Firewall: TCP 22 allowed from 100.64.0.0/10 only." -ForegroundColor Green

# --------------------------------------------------------------- 5. what is left
Head "Two things left, both of which are yours to do"

Write-Host ""
Write-Host "A. THE KEY. On YOUR machine, not this one:" -ForegroundColor White
Write-Host "     ssh-keygen -t ed25519 -C `"atlas-maintenance`""
Write-Host ""
Write-Host "   Then paste the PUBLIC half (.pub) into this file on the Atlas machine:"
Write-Host "     $env:ProgramData\ssh\administrators_authorized_keys"
Write-Host ""
Write-Host "   That path, not ~/.ssh/authorized_keys: for a member of the Administrators"
Write-Host "   group, Windows OpenSSH reads only the machine-wide file. A key in the home"
Write-Host "   directory is silently ignored and you will be asked for a password forever."
Write-Host ""
Write-Host "   Its ACL must also be Administrators + SYSTEM and nothing else, or sshd"
Write-Host "   refuses to read it -- again silently:"
Write-Host "     icacls `"$env:ProgramData\ssh\administrators_authorized_keys`" /inheritance:r"
Write-Host "     icacls `"$env:ProgramData\ssh\administrators_authorized_keys`" /grant `"Administrators:F`" `"SYSTEM:F`""
Write-Host ""
Write-Host "   Once the key works, turn passwords off in $env:ProgramData\ssh\sshd_config:"
Write-Host "     PasswordAuthentication no"
Write-Host "   and  Restart-Service sshd.  Verify the key FIRST -- do this in the wrong"
Write-Host "   order and you have locked yourself out of a machine you cannot reach."
Write-Host ""

Write-Host "B. THE TAILSCALE ACL. In the admin console, https://login.tailscale.com/admin/acls" -ForegroundColor White
Write-Host "   This is the barrier that survives someone editing this machine, and it is the"
Write-Host "   one that expresses the actual intent: the CLIENT's devices may use Atlas, and"
Write-Host "   only the developer may administer the host."
Write-Host ""
Write-Host '     "acls": ['
Write-Host '       // Everyone in the tailnet reaches the Atlas web UI, and only that port.'
Write-Host '       { "action": "accept", "src": ["*"], "dst": ["tag:atlas:443", "tag:atlas:5000"] },'
Write-Host '       // Administration is the developer, from their own devices, and nobody else.'
Write-Host '       { "action": "accept", "src": ["autogroup:admin"], "dst": ["tag:atlas:22"] }'
Write-Host '     ]'
Write-Host ""
Write-Host "   Tag this node `"tag:atlas`" so those rules have something to attach to."
Write-Host ""

Head "Then, from anywhere on the tailnet"
Write-Host "  ssh $env:USERNAME@$tsName"
Write-Host "  cd `"$(Split-Path -Parent $PSScriptRoot)`""
Write-Host "  .\scripts\atlas-doctor.ps1        # what is wrong"
Write-Host "  .\scripts\restart-atlas.bat       # the usual fix"
Write-Host ""
