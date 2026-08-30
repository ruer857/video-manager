$ErrorActionPreference = "Stop"
$appRoot = $PSScriptRoot
$appUrl = "http://127.0.0.1:47128"
$expectedServerVersion = "2026.08.28.04"
$versionedAppUrl = "$appUrl/?appVersion=$expectedServerVersion"
$portableAppData = Join-Path $appRoot "data"
$env:APPDATA = $portableAppData
$bundledNode = "C:\Users\Gluo\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$electronPath = Join-Path $appRoot "node_modules\electron\dist\electron.exe"
$electronMain = Join-Path $appRoot "desktop\electron-main.cjs"
New-Item -ItemType Directory -Path $portableAppData -Force | Out-Null

$expectedServerScript = Join-Path $appRoot "desktop\server.mjs"
$listener = Get-NetTCPConnection -LocalPort 47128 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$listenerProcess = $null
$runningIsVideoManager = $false
$runningIsThisPackage = $false
if ($listener) {
  $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  $runningIsVideoManager = $listenerProcess -and $listenerProcess.Name -match "^node(\.exe)?$" -and $listenerProcess.CommandLine -match "desktop[\\/]server\.mjs"
  $runningIsThisPackage = $runningIsVideoManager -and $listenerProcess.CommandLine -like "*$expectedServerScript*"
}

$alreadyRunning = $false
try {
  $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 1
  $alreadyRunning = $health.ok -eq $true -and $health.version -eq $expectedServerVersion -and $runningIsThisPackage
} catch {
  $alreadyRunning = $false
}

if (-not $alreadyRunning) {
  if ($runningIsVideoManager) {
    Stop-Process -Id $listener.OwningProcess -Force
    Start-Sleep -Milliseconds 250
  }

  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  $nodePath = if ($nodeCommand) { $nodeCommand.Source } elseif (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { $null }
  if (-not $nodePath) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("The local runtime was not found.", "Video Manager") | Out-Null
    exit 1
  }
  Start-Process -FilePath $nodePath `
    -ArgumentList @((Join-Path $appRoot "desktop\server.mjs")) `
    -WorkingDirectory $appRoot `
    -WindowStyle Hidden

  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    try {
      $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 1
      if ($health.ok -and $health.version -eq $expectedServerVersion) {
        $alreadyRunning = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 150
    }
  }
}

if (-not $alreadyRunning) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Video Manager could not start.", "Video Manager") | Out-Null
  exit 1
}

if (-not (Test-Path -LiteralPath $electronPath) -or -not (Test-Path -LiteralPath $electronMain)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("The desktop runtime was not found.", "Video Manager") | Out-Null
  exit 1
}

$serverListener = Get-NetTCPConnection -LocalPort 47128 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $serverListener) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Video Manager server was not found.", "Video Manager") | Out-Null
  exit 1
}

Start-Process -FilePath $electronPath `
  -ArgumentList @($electronMain, "--app-url=$versionedAppUrl", "--server-pid=$($serverListener.OwningProcess)") `
  -WorkingDirectory $appRoot
