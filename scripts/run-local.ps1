$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LogDirectory = Join-Path $env:LOCALAPPDATA 'AnzeigenPiraten'
$LogFile = Join-Path $LogDirectory 'local-scan.log'
$Mutex = [System.Threading.Mutex]::new($false, 'Local\AnzeigenPiratenLocalScan')
$HasLock = $false

New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

function Write-RunLog([string]$Message) {
  Add-Content -LiteralPath $LogFile -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

try {
  try { $HasLock = $Mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $HasLock = $true }
  if (-not $HasLock) {
    Write-RunLog 'Skipped: another local scan is still running.'
    exit 0
  }

  $Branch = (& git -C $RepoRoot branch --show-current).Trim()
  if ($Branch -ne 'main') { throw "Expected branch 'main'; found '$Branch'." }

  $WorkingTree = & git -C $RepoRoot status --porcelain --untracked-files=normal
  if ($WorkingTree) { throw 'Working tree has local edits. Commit or stash them before the scheduled scan.' }

  Write-RunLog 'Starting product classification and product-price comparison.'
  & git -C $RepoRoot pull --rebase origin main *>> $LogFile
  if ($LASTEXITCODE -ne 0) { throw 'Could not synchronize main before scanning.' }

  Push-Location (Join-Path $RepoRoot 'scripts')
  try {
    & node scan.mjs --local *>> $LogFile
    if ($LASTEXITCODE -ne 0) { throw "Scanner exited with code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }

  & git -C $RepoRoot add -- data/deals.json data/meta.json data/state.json data/prices.json
  if ($LASTEXITCODE -ne 0) { throw 'Could not stage scanner data files.' }

  & git -C $RepoRoot diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-RunLog 'No feed or price database changes to publish.'
    exit 0
  }

  $UserName = (& git -C $RepoRoot config user.name 2>$null)
  if (-not $UserName) { & git -C $RepoRoot config user.name 'AnzeigenPiraten Local Scanner' }
  $UserEmail = (& git -C $RepoRoot config user.email 2>$null)
  if (-not $UserEmail) { & git -C $RepoRoot config user.email 'anzeigenpiraten-bot@users.noreply.github.com' }

  & git -C $RepoRoot commit -m 'data: refresh product labels and price comparisons' *>> $LogFile
  if ($LASTEXITCODE -ne 0) { throw 'Could not commit scanner output.' }
  & git -C $RepoRoot push origin main *>> $LogFile
  if ($LASTEXITCODE -ne 0) { throw 'Could not push scanner output. It will be retried on the next scheduled run.' }
  Write-RunLog 'Published updated feed and product-price database to origin/main.'
} catch {
  Write-RunLog "ERROR: $($_.Exception.Message)"
  exit 1
} finally {
  if ($HasLock) { $Mutex.ReleaseMutex() }
  $Mutex.Dispose()
}
