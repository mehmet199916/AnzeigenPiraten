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

function Invoke-LoggedProcess([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
  $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $StartInfo.FileName = $FilePath
  $StartInfo.Arguments = ($Arguments | ForEach-Object { '"' + $_.Replace('"', '\\"') + '"' }) -join ' '
  $StartInfo.WorkingDirectory = $WorkingDirectory
  $StartInfo.UseShellExecute = $false
  $StartInfo.CreateNoWindow = $true
  $StartInfo.RedirectStandardOutput = $true
  $StartInfo.RedirectStandardError = $true
  $StartInfo.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'

  $Process = New-Object System.Diagnostics.Process
  $Process.StartInfo = $StartInfo
  [void]$Process.Start()
  $Stdout = $Process.StandardOutput.ReadToEndAsync()
  $Stderr = $Process.StandardError.ReadToEndAsync()
  $Process.WaitForExit()
  if ($Stdout.Result) { Add-Content -LiteralPath $LogFile -Value $Stdout.Result -Encoding UTF8 }
  if ($Stderr.Result) { Add-Content -LiteralPath $LogFile -Value $Stderr.Result -Encoding UTF8 }
  if ($Process.ExitCode -ne 0) {
    throw "Command '$FilePath' exited with code $($Process.ExitCode)."
  }
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
  $Git = (Get-Command git.exe -ErrorAction Stop).Source
  $Node = (Get-Command node.exe -ErrorAction Stop).Source
  Invoke-LoggedProcess $Git @('-C', $RepoRoot, 'pull', '--rebase', 'origin', 'main') $RepoRoot

  Invoke-LoggedProcess $Node @('scan.mjs', '--local') (Join-Path $RepoRoot 'scripts')

  Invoke-LoggedProcess $Git @('-C', $RepoRoot, 'add', '--', 'data/deals.json', 'data/meta.json', 'data/state.json', 'data/prices.json', 'data/product-prices.json') $RepoRoot

  & git -C $RepoRoot diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-RunLog 'No feed or price database changes to publish.'
    exit 0
  }

  $UserName = (& git -C $RepoRoot config user.name 2>$null)
  if (-not $UserName) { & git -C $RepoRoot config user.name 'AnzeigenPiraten Local Scanner' }
  $UserEmail = (& git -C $RepoRoot config user.email 2>$null)
  if (-not $UserEmail) { & git -C $RepoRoot config user.email 'anzeigenpiraten-bot@users.noreply.github.com' }

  Invoke-LoggedProcess $Git @('-C', $RepoRoot, 'commit', '-m', 'data: refresh product labels and price comparisons') $RepoRoot
  Invoke-LoggedProcess $Git @('-C', $RepoRoot, 'push', 'origin', 'main') $RepoRoot
  Write-RunLog 'Published updated feed and product-price database to origin/main.'
} catch {
  Write-RunLog "ERROR: $($_.Exception.Message)"
  exit 1
} finally {
  if ($HasLock) { $Mutex.ReleaseMutex() }
  $Mutex.Dispose()
}
