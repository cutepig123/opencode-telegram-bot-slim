<#
.SYNOPSIS
  Setup and run the OpenCode Telegram Bot from source on this machine.

.DESCRIPTION
  Builds the bot from src\ and runs it. Everything that can be generated
  (node_modules, dist, .env, logs) stays out of git; this script creates it.

.EXAMPLE
  .\setup-bot.cmd install

.EXAMPLE
  .\setup-bot.cmd install -OpenCodeUrl http://192.168.1.137:4096 -BrowserRoots "C:\,D:\"

.EXAMPLE
  .\setup-bot.cmd install -TelegramApiRoot https://tg.example.com -CaCert .\certs\ca.crt
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet("install", "run", "start", "stop", "status", "config", "clean")]
    [string]$Action = "run",
    [string]$EnvFile,
    [string]$OpenCodeUrl,
    [string]$BrowserRoots,
    [string]$TelegramApiRoot,
    [string]$CaCert,
    [string]$Locale,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DistDir = Join-Path $RepoRoot "dist"
$DistCli = Join-Path $DistDir "cli.js"
$NodeModules = Join-Path $RepoRoot "node_modules"
$EnvExample = Join-Path $RepoRoot ".env.example"
# The bot resolves its app home from OPENCODE_TELEGRAM_HOME when set (installed
# mode otherwise uses %APPDATA%), so the script's log lookup must match it.
$HomeOverride = $env:OPENCODE_TELEGRAM_HOME
if ($HomeOverride -and $HomeOverride.Trim().Length -gt 0) {
    $DefaultAppHome = $HomeOverride
}
else {
    $DefaultAppHome = Join-Path $env:APPDATA "opencode-telegram-bot"
}

if (-not $EnvFile) {
    $EnvFile = Join-Path $DefaultAppHome ".env"
}

$MinNodeMajor = 22
$MinNodeMinor = 14

function Write-Step([string]$Message) { Write-Host "[*] $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "[+] $Message" -ForegroundColor Green }
function Write-WarnMsg([string]$Message) { Write-Host "[!] $Message" -ForegroundColor Yellow }
function Write-ErrMsg([string]$Message) { Write-Host "[x] $Message" -ForegroundColor Red }

function Assert-Command([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        Write-ErrMsg "$Name was not found in PATH."
        throw "$Name missing"
    }
    return $command.Source
}

function Assert-NodeVersion([string]$NodeExe) {
    $raw = (& $NodeExe -v).Trim()
    if ($raw -notmatch '^v(\d+)\.(\d+)\.') {
        Write-ErrMsg "Cannot parse Node.js version: $raw"
        throw "Unsupported Node.js"
    }

    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]

    $tooOld = ($major -lt $MinNodeMajor) -or ($major -eq $MinNodeMajor -and $minor -lt $MinNodeMinor)
    if ($tooOld) {
        Write-ErrMsg "Node.js $raw is too old. The bot needs 22.14+, 23.6+, or 24+."
        throw "Unsupported Node.js"
    }

    Write-Ok "Node.js $raw"
}

# Latin1 round-trips bytes unchanged, so the UTF-8 comments in .env.example
# survive an edit and dotenv still reads the file the same way.
function Set-EnvLine([string]$File, [string]$Key, [string]$Value) {
    $encoding = [System.Text.Encoding]::GetEncoding(28591)
    $raw = if (Test-Path $File) { [System.IO.File]::ReadAllText($File, $encoding) } else { "" }
    $newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = @($raw -split "`r?`n")
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq "") {
        $lines = $lines[0..($lines.Count - 2)]
    }

    $line = "$Key=$Value"
    $pattern = "^" + [regex]::Escape($Key) + "="
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) {
            $lines[$i] = $line
            $found = $true
        }
    }
    if (-not $found) { $lines += $line }

    $directory = Split-Path -Parent $File
    if ($directory -and -not (Test-Path $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($File, ($lines -join $newline) + $newline, $encoding)
}

function Read-EnvValue([string]$File, [string]$Key) {
    if (-not (Test-Path $File)) { return $null }
    $match = Select-String -Path $File -Pattern "^$Key=(.*)$"
    if ($match) { return $match.Matches[0].Groups[1].Value.Trim() }
    return $null
}

function Install-Dependencies([string]$NodeExe, [string]$NpmExe) {
    $lockFile = Join-Path $RepoRoot "package-lock.json"
    if (-not (Test-Path $lockFile)) {
        Write-ErrMsg "package-lock.json is missing; npm ci cannot run."
        throw "Missing lockfile"
    }

    Write-Step "Installing dependencies (npm ci)..."
    Push-Location $RepoRoot
    try {
        # --include=dev: a machine-wide NODE_ENV=production would otherwise skip
        #   tsc and the build would fail.
        # --ignore-scripts: better-sqlite3 ships prebuilt binaries in the tarball,
        #   but its binding.gyp makes npm run node-gyp rebuild, which needs Visual
        #   Studio on Windows. The prebuilds are what actually get loaded.
        & $NpmExe ci --include=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
    Write-Ok "Dependencies installed."
}

function Build-Bot([string]$NpmExe) {
    Write-Step "Building (npm run build)..."
    Push-Location $RepoRoot
    try {
        & $NpmExe run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path $DistCli)) {
        Write-ErrMsg "Build finished but $DistCli is missing."
        throw "Build output missing"
    }
    Write-Ok "Build complete."
}

function Initialize-EnvFile {
    if ((Test-Path $EnvFile) -and -not $Force) {
        Write-Ok "Reusing existing $EnvFile"
    }
    else {
        if (-not (Test-Path $EnvExample)) {
            Write-ErrMsg ".env.example is missing; cannot seed $EnvFile"
            throw "Missing .env.example"
        }
        $directory = Split-Path -Parent $EnvFile
        if ($directory -and -not (Test-Path $directory)) {
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
        }
        Copy-Item $EnvExample $EnvFile -Force
        Write-Ok "Created $EnvFile from .env.example"
    }

    if ($OpenCodeUrl) { Set-EnvLine $EnvFile "OPENCODE_API_URL" $OpenCodeUrl }
    if ($BrowserRoots) { Set-EnvLine $EnvFile "OPEN_BROWSER_ROOTS" $BrowserRoots }
    if ($TelegramApiRoot) { Set-EnvLine $EnvFile "TELEGRAM_API_ROOT" $TelegramApiRoot }
    if ($Locale) { Set-EnvLine $EnvFile "BOT_LOCALE" $Locale }

    $token = Read-EnvValue $EnvFile "TELEGRAM_BOT_TOKEN"
    $userId = Read-EnvValue $EnvFile "TELEGRAM_ALLOWED_USER_ID"
    if (-not $token -or -not $userId) {
        Write-WarnMsg "TELEGRAM_BOT_TOKEN and/or TELEGRAM_ALLOWED_USER_ID are still empty in:"
        Write-WarnMsg "  $EnvFile"
        Write-WarnMsg "Edit the file, or run:  .\setup-bot.cmd config"
    }
}

function Resolve-CaCert {
    $candidate = $CaCert
    if (-not $candidate) {
        $candidate = [Environment]::GetEnvironmentVariable("NODE_EXTRA_CA_CERTS", "User")
    }
    if (-not $candidate -or -not (Test-Path $candidate)) {
        return $null
    }

    $resolved = (Resolve-Path $candidate).Path
    $env:NODE_EXTRA_CA_CERTS = $resolved
    Write-Ok "NODE_EXTRA_CA_CERTS=$resolved"
    return $resolved
}

function Assert-Ready([string]$NodeExe, [string]$NpmExe) {
    $missingDeps = -not (Test-Path $NodeModules)
    $missingBuild = -not (Test-Path $DistCli)

    if ($missingDeps -or $missingBuild -or $Force) {
        Write-WarnMsg "Install state is incomplete; running install first."
        Install-Dependencies $NodeExe $NpmExe
        Build-Bot $NpmExe
        Initialize-EnvFile
        return
    }

    if (-not (Test-Path $EnvFile)) {
        Write-WarnMsg "No env file at $EnvFile; seeding one."
        Initialize-EnvFile
    }
}

function Invoke-Install([string]$NodeExe, [string]$NpmExe) {
    Write-Step "Node.js: $((& $NodeExe -v).Trim())"
    Install-Dependencies $NodeExe $NpmExe
    Build-Bot $NpmExe
    Initialize-EnvFile
    Write-Host ""
    Write-Ok "Install complete."
    Write-Host "Next:"
    Write-Host "  .\start-bot.cmd              run in the foreground (Ctrl+C to stop)"
    Write-Host "  .\setup-bot.cmd start        run in the background"
    Write-Host "  .\setup-bot.cmd status       check the background process"
}

function Invoke-Run([string]$NodeExe, [string]$NpmExe) {
    Assert-Ready $NodeExe $NpmExe
    Resolve-CaCert | Out-Null

    Write-Step "Starting the bot in the foreground (Ctrl+C to stop)..."
    Push-Location $RepoRoot
    try {
        & $NodeExe $DistCli start
    }
    finally {
        Pop-Location
    }
}

function Invoke-Start([string]$NodeExe, [string]$NpmExe) {
    Assert-Ready $NodeExe $NpmExe
    Resolve-CaCert | Out-Null

    Write-Step "Starting the bot in the background..."
    Push-Location $RepoRoot
    try {
        & $NodeExe $DistCli start --daemon
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to start the daemon (exit code $LASTEXITCODE)"
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-Stop([string]$NodeExe) {
    if (-not (Test-Path $DistCli)) {
        Write-WarnMsg "Nothing to stop: $DistCli does not exist yet."
        return
    }

    Push-Location $RepoRoot
    try {
        & $NodeExe $DistCli stop
    }
    finally {
        Pop-Location
    }
}

function Invoke-Status([string]$NodeExe) {
    if (-not (Test-Path $DistCli)) {
        Write-WarnMsg "Not built yet. Run:  .\setup-bot.cmd install"
        return
    }

    Push-Location $RepoRoot
    try {
        & $NodeExe $DistCli status
    }
    finally {
        Pop-Location
    }

    $logsDir = Join-Path $DefaultAppHome "logs"
    if (Test-Path $logsDir) {
        $latest = Get-ChildItem $logsDir -Filter "*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latest) {
            Write-Host ""
            Write-Step "Last lines of $($latest.Name)"
            Get-Content $latest.FullName -Tail 15
        }
    }
}

function Invoke-Config([string]$NodeExe, [string]$NpmExe) {
    Assert-Ready $NodeExe $NpmExe
    Push-Location $RepoRoot
    try {
        & $NodeExe $DistCli config
    }
    finally {
        Pop-Location
    }
}

function Invoke-Clean {
    Write-Step "Removing build output and dependencies..."
    foreach ($target in @($DistDir, $NodeModules)) {
        if (Test-Path $target) {
            Remove-Item $target -Recurse -Force
            Write-Ok "Removed $target"
        }
    }
    Write-Ok "Clean complete. The .env file was left in place: $EnvFile"
}

try {
    $nodeExe = Assert-Command "node"

    switch ($Action) {
        "install" {
            Assert-NodeVersion $nodeExe
            $npmExe = Assert-Command "npm"
            Invoke-Install $nodeExe $npmExe
        }
        "run" {
            Assert-NodeVersion $nodeExe
            $npmExe = Assert-Command "npm"
            Invoke-Run $nodeExe $npmExe
        }
        "start" {
            Assert-NodeVersion $nodeExe
            $npmExe = Assert-Command "npm"
            Invoke-Start $nodeExe $npmExe
        }
        "stop" {
            Invoke-Stop $nodeExe
        }
        "status" {
            Invoke-Status $nodeExe
        }
        "config" {
            Assert-NodeVersion $nodeExe
            $npmExe = Assert-Command "npm"
            Invoke-Config $nodeExe $npmExe
        }
        "clean" {
            Invoke-Clean
        }
    }
}
catch {
    Write-ErrMsg $_.Exception.Message
    exit 1
}
