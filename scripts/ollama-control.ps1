$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:apiBase = 'http://127.0.0.1:11434'
$script:ollamaPath = $null
$script:refreshBusy = $false

function Get-OllamaExecutable {
  if ($script:ollamaPath -and (Test-Path -LiteralPath $script:ollamaPath)) { return $script:ollamaPath }
  $command = Get-Command 'ollama.exe' -ErrorAction SilentlyContinue
  if ($command) { $script:ollamaPath = $command.Source; return $script:ollamaPath }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
    (Join-Path $env:ProgramFiles 'Ollama\ollama.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if ($candidates.Count -gt 0) { $script:ollamaPath = $candidates[0]; return $script:ollamaPath }
  throw 'ollama.exe wurde nicht gefunden. Installiere Ollama oder ergänze es zum PATH.'
}

function Get-OllamaStatus {
  try {
    $tags = Invoke-RestMethod -Uri "$script:apiBase/api/tags" -TimeoutSec 2 -ErrorAction Stop
    $running = Invoke-RestMethod -Uri "$script:apiBase/api/ps" -TimeoutSec 2 -ErrorAction Stop
    return [pscustomobject]@{
      Online = $true
      Models = @($tags.models)
      Loaded = @($running.models)
      Error = $null
    }
  } catch {
    return [pscustomobject]@{
      Online = $false
      Models = @()
      Loaded = @()
      Error = 'Ollama ist offline oder antwortet nicht auf 127.0.0.1:11434.'
    }
  }
}

function Get-OllamaServerProcess {
  $connections = @(Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue)
  foreach ($connection in $connections) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $processInfo) { continue }
    if ($processInfo.Name -ine 'ollama.exe') { continue }
    $expected = Get-OllamaExecutable
    if ($processInfo.ExecutablePath -and [IO.Path]::GetFullPath($processInfo.ExecutablePath) -ieq [IO.Path]::GetFullPath($expected)) {
      return $processInfo
    }
  }
  return $null
}

function Start-Ollama {
  if ((Get-OllamaStatus).Online) { throw 'Ollama läuft bereits.' }
  $executable = Get-OllamaExecutable
  Start-Process -FilePath $executable -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
  $script:messageLabel.Text = 'Ollama wird gestartet …'
  $script:messageLabel.ForeColor = [Drawing.Color]::FromArgb(245, 190, 90)
  $script:timer.Start()
}

function Stop-Ollama {
  if (-not (Get-OllamaStatus).Online) { throw 'Ollama läuft bereits nicht.' }
  $server = Get-OllamaServerProcess
  if (-not $server) {
    throw 'Der Prozess auf Port 11434 ist nicht eindeutig als Ollama identifizierbar. Aus Sicherheitsgründen wurde nichts beendet.'
  }

  # The PID was verified by executable path and by its Ollama API listener.
  # /T also closes Ollama runner processes owned by this server.
  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  $output = & $taskkill /PID $server.ProcessId /T /F 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Ollama konnte nicht beendet werden: $($output -join ' ')" }
  $script:messageLabel.Text = 'Ollama wurde beendet.'
  $script:messageLabel.ForeColor = [Drawing.Color]::FromArgb(120, 210, 150)
  Refresh-Ollama
}

function Restart-Ollama {
  $wasOnline = (Get-OllamaStatus).Online
  if ($wasOnline) { Stop-Ollama }
  Start-Ollama
  if (-not $wasOnline) {
    $script:messageLabel.Text = 'Ollama war offline und wird jetzt gestartet.'
  }
}

function Refresh-Ollama {
  if ($script:refreshBusy -or $form.IsDisposed) { return }
  $script:refreshBusy = $true
  try {
    $status = Get-OllamaStatus
    $script:statusLabel.Text = if ($status.Online) { 'Online' } else { 'Offline' }
    $script:statusLabel.ForeColor = if ($status.Online) {
      [Drawing.Color]::FromArgb(105, 220, 150)
    } else {
      [Drawing.Color]::FromArgb(245, 125, 125)
    }

    $loadedNames = @($status.Loaded | ForEach-Object { $_.name })
    $script:modelList.BeginUpdate()
    $script:modelList.Items.Clear()
    foreach ($model in ($status.Models | Sort-Object name)) {
      $label = [string]$model.name
      if ($loadedNames -contains $model.name) { $label += '   ·   geladen' }
      if ($model.size) { $label += '   ·   ' + [Math]::Round(($model.size / 1GB), 1).ToString('0.0') + ' GB' }
      [void]$script:modelList.Items.Add($label)
    }
    $script:modelList.EndUpdate()

    if (-not $status.Online) {
      $script:detailsLabel.Text = $status.Error
      $script:startButton.Enabled = $true
      $script:stopButton.Enabled = $false
      $script:restartButton.Enabled = $false
    } else {
      $loaded = if ($status.Loaded.Count) { ($status.Loaded | ForEach-Object { $_.name }) -join ', ' } else { 'Kein Modell geladen' }
      $script:detailsLabel.Text = "Geladen: $loaded"
      $script:startButton.Enabled = $false
      $script:stopButton.Enabled = $true
      $script:restartButton.Enabled = $true
      if ($script:messageLabel.Text -eq 'Ollama wird gestartet …') {
        $script:messageLabel.Text = 'Ollama ist gestartet.'
        $script:messageLabel.ForeColor = [Drawing.Color]::FromArgb(120, 210, 150)
      }
    }
  } finally { $script:refreshBusy = $false }
}

function Invoke-OllamaAction([scriptblock]$Action) {
  try { & $Action }
  catch {
    $script:messageLabel.Text = $_.Exception.Message
    $script:messageLabel.ForeColor = [Drawing.Color]::FromArgb(245, 125, 125)
  }
  Refresh-Ollama
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Ollama – lokale Steuerung'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(560, 440)
$form.MinimumSize = New-Object System.Drawing.Size(520, 420)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.BackColor = [Drawing.Color]::FromArgb(11, 17, 31)
$form.ForeColor = [Drawing.Color]::FromArgb(232, 237, 247)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Ollama Steuerung'
$title.Location = New-Object Drawing.Point(24, 20)
$title.Size = New-Object Drawing.Size(400, 32)
$title.Font = New-Object Drawing.Font('Segoe UI Semibold', 18)
$form.Controls.Add($title)

$script:statusLabel = New-Object System.Windows.Forms.Label
$script:statusLabel.Text = 'Status wird geprüft …'
$script:statusLabel.Location = New-Object Drawing.Point(26, 64)
$script:statusLabel.Size = New-Object Drawing.Size(300, 26)
$script:statusLabel.Font = New-Object Drawing.Font('Segoe UI Semibold', 12)
$form.Controls.Add($script:statusLabel)

$script:detailsLabel = New-Object System.Windows.Forms.Label
$script:detailsLabel.Text = 'Verbindung zu Ollama auf 127.0.0.1:11434'
$script:detailsLabel.Location = New-Object Drawing.Point(26, 92)
$script:detailsLabel.Size = New-Object Drawing.Size(500, 24)
$script:detailsLabel.ForeColor = [Drawing.Color]::FromArgb(160, 174, 198)
$form.Controls.Add($script:detailsLabel)

$modelsTitle = New-Object System.Windows.Forms.Label
$modelsTitle.Text = 'Verfügbare Modelle'
$modelsTitle.Location = New-Object Drawing.Point(26, 130)
$modelsTitle.Size = New-Object Drawing.Size(300, 24)
$modelsTitle.Font = New-Object Drawing.Font('Segoe UI Semibold', 10)
$form.Controls.Add($modelsTitle)

$script:modelList = New-Object System.Windows.Forms.ListBox
$script:modelList.Location = New-Object Drawing.Point(26, 158)
$script:modelList.Size = New-Object Drawing.Size(508, 170)
$script:modelList.BackColor = [Drawing.Color]::FromArgb(17, 26, 46)
$script:modelList.ForeColor = [Drawing.Color]::FromArgb(232, 237, 247)
$script:modelList.BorderStyle = 'FixedSingle'
$script:modelList.IntegralHeight = $false
$form.Controls.Add($script:modelList)

$script:messageLabel = New-Object System.Windows.Forms.Label
$script:messageLabel.Text = ''
$script:messageLabel.Location = New-Object Drawing.Point(26, 336)
$script:messageLabel.Size = New-Object Drawing.Size(508, 34)
$script:messageLabel.ForeColor = [Drawing.Color]::FromArgb(160, 174, 198)
$form.Controls.Add($script:messageLabel)

function New-ActionButton([string]$Text, [int]$X, [int]$Width) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Location = New-Object Drawing.Point($X, 382)
  $button.Size = New-Object Drawing.Size($Width, 36)
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(52, 70, 104)
  $button.BackColor = [Drawing.Color]::FromArgb(22, 34, 60)
  $button.ForeColor = [Drawing.Color]::FromArgb(232, 237, 247)
  $form.Controls.Add($button)
  return $button
}

$script:startButton = New-ActionButton 'Starten' 26 96
$script:stopButton = New-ActionButton 'Stoppen' 130 96
$script:restartButton = New-ActionButton 'Neu starten' 234 112
$refreshButton = New-ActionButton 'Aktualisieren' 414 120
$script:startButton.Add_Click({ Invoke-OllamaAction { Start-Ollama } })
$script:stopButton.Add_Click({ Invoke-OllamaAction { Stop-Ollama } })
$script:restartButton.Add_Click({ Invoke-OllamaAction { Restart-Ollama } })
$refreshButton.Add_Click({ Refresh-Ollama })

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 4000
$script:timer.Add_Tick({ Refresh-Ollama })
$form.Add_Shown({ Refresh-Ollama; $script:timer.Start() })
$form.Add_FormClosed({ $script:timer.Stop(); $script:timer.Dispose() })
[void]$form.ShowDialog()
