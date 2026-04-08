# Install conclave-node-worker as a Windows service.
#
# Uses NSSM (https://nssm.cc) — the simplest reliable way to wrap a node
# process as a Windows service. Install NSSM first via:
#
#   choco install nssm        # Chocolatey
#   scoop install nssm        # Scoop
#
# Then run this script from an elevated PowerShell prompt in the
# apps\node-worker directory:
#
#   .\install\install-windows.ps1
#
# Pre-reqs:
#   1. Node.js >= 18 on PATH
#   2. NSSM on PATH
#   3. %USERPROFILE%\.conclave\node.json populated
#
# Logs: %ProgramData%\conclave\node-worker\{stdout,stderr}.log
# Remove: nssm remove ConclaveNodeWorker confirm

$ErrorActionPreference = 'Stop'

$ServiceName = 'ConclaveNodeWorker'
$WorkerDir   = (Resolve-Path "$PSScriptRoot\..").Path
$WorkerEntry = Join-Path $WorkerDir 'index.js'
$NodeExe     = (Get-Command node -ErrorAction SilentlyContinue).Source
$Nssm        = (Get-Command nssm -ErrorAction SilentlyContinue).Source
$LogDir      = Join-Path $env:ProgramData 'conclave\node-worker'

if (-not $NodeExe) { throw 'node.exe not found on PATH (need Node.js >= 18)' }
if (-not $Nssm)    { throw 'nssm.exe not found on PATH — install via `choco install nssm` or `scoop install nssm`' }
if (-not (Test-Path $WorkerEntry)) { throw "missing $WorkerEntry" }

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# Remove any prior copy so re-install is idempotent.
& $Nssm stop $ServiceName 2>$null
& $Nssm remove $ServiceName confirm 2>$null

& $Nssm install   $ServiceName $NodeExe $WorkerEntry
& $Nssm set       $ServiceName AppDirectory  $WorkerDir
& $Nssm set       $ServiceName AppStdout     (Join-Path $LogDir 'stdout.log')
& $Nssm set       $ServiceName AppStderr     (Join-Path $LogDir 'stderr.log')
& $Nssm set       $ServiceName AppRotateFiles 1
& $Nssm set       $ServiceName AppRotateBytes 10485760
& $Nssm set       $ServiceName Start          SERVICE_AUTO_START
& $Nssm set       $ServiceName AppExit        Default Restart
& $Nssm set       $ServiceName AppRestartDelay 10000

& $Nssm start $ServiceName

Write-Host ""
Write-Host "  installed:  service '$ServiceName'"
Write-Host "  logs:       $LogDir\{stdout,stderr}.log"
Write-Host "  to remove:  nssm stop $ServiceName; nssm remove $ServiceName confirm"
