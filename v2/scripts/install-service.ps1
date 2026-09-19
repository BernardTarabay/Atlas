<#
.SYNOPSIS
  Install, update, remove or inspect the Atlas Engine Windows service.

.DESCRIPTION
  Install/Update copies the app to -Target (default C:\Program Files\Atlas) -- never
  run the service from a OneDrive-synced folder -- pins the current node.exe next
  to it, and registers "AtlasEngine":
    - starts at boot (delayed auto-start), runs with nobody logged in
    - restarts automatically if it fails (5 s, 10 s, then 60 s)
    - data (database, logs, setup code) in %ProgramData%\Atlas
  Re-running Install on an installed machine is the update path: the service is
  stopped, the app mirrored, and the service started again. Data is not touched.

  Must be run from an ELEVATED PowerShell.

.EXAMPLE
  .\install-service.ps1                 # install or update
  .\install-service.ps1 -Action Status
  .\install-service.ps1 -Action Uninstall
#>
param(
  [ValidateSet("Install", "Uninstall", "Status")] [string] $Action = "Install",
  [string] $Target = "$env:ProgramFiles\Atlas"
)
$ErrorActionPreference = "Stop"
$Service = "AtlasEngine"
$Source = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $env:ProgramData "Atlas"

function Assert-Admin {
  $p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this from an elevated PowerShell (right-click PowerShell > Run as administrator)."
  }
}

function Get-Svc { Get-Service -Name $Service -ErrorAction SilentlyContinue }

if ($Action -eq "Status") {
  $s = Get-Svc
  if (-not $s) { "Atlas Engine is not installed."; return }
  sc.exe qc $Service | Select-String "START_TYPE|BINARY_PATH|SERVICE_START_NAME"
  "State: $($s.Status)"
  $log = Get-ChildItem (Join-Path $DataDir "logs") -Filter "atlas-*.log" -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
  if ($log) { "--- last engine log lines ($($log.Name))"; Get-Content $log.FullName -Tail 10 }
  $svcLog = Join-Path $DataDir "logs\service.log"
  if (Test-Path $svcLog) { "--- service host"; Get-Content $svcLog -Tail 5 }
  return
}

Assert-Admin

if ($Action -eq "Uninstall") {
  if (Get-Svc) {
    Stop-Service $Service -ErrorAction SilentlyContinue
    sc.exe delete $Service | Out-Null
    "Service removed. App files remain in $Target and data in $DataDir; delete them yourself if you want them gone."
  } else { "Atlas Engine is not installed." }
  return
}

# --- Install / update ---
if (-not (Test-Path (Join-Path $Source "bin\AtlasService.exe"))) { throw "Native helpers are not built. Run 'npm run build:native' in $Source first." }
if (-not (Test-Path (Join-Path $Source "node_modules"))) { throw "Dependencies are missing. Run 'npm install' in $Source first." }
$node = (Get-Command node -ErrorAction Stop).Source

$existing = Get-Svc
if ($existing -and $existing.Status -ne "Stopped") { "Stopping $Service..."; Stop-Service $Service; $existing.WaitForStatus("Stopped", "00:00:40") }

"Copying app to $Target"
foreach ($dir in "src", "ui", "bin", "node_modules") {
  robocopy (Join-Path $Source $dir) (Join-Path $Target $dir) /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying $dir failed (robocopy code $LASTEXITCODE)." }
}
Copy-Item (Join-Path $Source "package.json") $Target -Force
New-Item -ItemType Directory -Force (Join-Path $Target "node") | Out-Null
Copy-Item $node (Join-Path $Target "node\node.exe") -Force
New-Item -ItemType Directory -Force $DataDir | Out-Null

$exe = Join-Path $Target "bin\AtlasService.exe"
if (-not $existing) {
  sc.exe create $Service binPath= "`"$exe`"" start= delayed-auto DisplayName= "Atlas Engine" obj= LocalSystem | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed ($LASTEXITCODE)." }
} else {
  sc.exe config $Service binPath= "`"$exe`"" start= delayed-auto | Out-Null
}
sc.exe description $Service "Atlas: scans, deduplicates and organizes your files on this machine. Keeps working with nobody signed in." | Out-Null
sc.exe failure $Service reset= 86400 actions= restart/5000/restart/10000/restart/60000 | Out-Null
sc.exe failureflag $Service 1 | Out-Null

Start-Service $Service
(Get-Svc).WaitForStatus("Running", "00:00:30")
"Atlas Engine is running. Open http://127.0.0.1:7717"
$code = Join-Path $DataDir "setup-code.txt"
Start-Sleep -Seconds 3
if (Test-Path $code) { "First run: " + (Get-Content $code -First 1) }
