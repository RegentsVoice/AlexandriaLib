$ErrorActionPreference = 'Stop'

$RepoUrl  = if ($env:ALEXANDRIA_REPO) { $env:ALEXANDRIA_REPO } else { 'https://github.com/RegentsVoice/AlexandriaLib.git' }
$RepoName = 'AlexandriaLib'
$MinNode  = 18

Write-Host '==> AlexandriaLib installer (Windows)'

function Test-Cmd([string]$Name) {
    try { Get-Command $Name -EA Stop | Out-Null; return $true } catch { return $false }
}

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Install-WingetPkg([string]$Id) {
    if (-not (Test-Cmd 'winget')) { return $false }
    try {
        winget install --id $Id -e --accept-package-agreements --accept-source-agreements --silent | Out-Null
        Refresh-Path
        return $true
    } catch {
        return $false
    }
}

function Ensure-Git {
    if (Test-Cmd 'git') { return }
    Write-Host '==> git...'
    if (-not (Install-WingetPkg 'Git.Git')) {
        Write-Host 'ERROR: install Git for Windows: https://git-scm.com/download/win'
        exit 1
    }
    Refresh-Path
    if (-not (Test-Cmd 'git')) {
        Write-Host 'ERROR: git installed but not on PATH. Open a NEW PowerShell and re-run.'
        exit 1
    }
}

function Ensure-Node {
    $ok = $false
    if (Test-Cmd 'node' -and Test-Cmd 'npm') {
        $major = [int]((node -v) -replace '^v', '').Split('.')[0]
        if ($major -ge $MinNode) {
            Write-Host "==> Node $(node -v)"
            return
        }
        Write-Host "==> Node $(node -v) < $MinNode, upgrading..."
    } else {
        Write-Host '==> Node.js...'
    }
    if (-not (Install-WingetPkg 'OpenJS.NodeJS.LTS')) {
        Write-Host 'ERROR: install Node.js LTS from https://nodejs.org/ and re-run.'
        exit 1
    }
    Refresh-Path
    if (-not (Test-Cmd 'node')) {
        Write-Host 'ERROR: Node installed but not on PATH. Open a NEW PowerShell and re-run.'
        exit 1
    }
    $major = [int]((node -v) -replace '^v', '').Split('.')[0]
    if ($major -lt $MinNode) {
        Write-Host "ERROR: Node.js >= $MinNode required (found $(node -v))"
        exit 1
    }
    Write-Host "==> Node $(node -v)"
}

function Ensure-Python {
    $py = $null
    foreach ($c in @('python', 'python3', 'py')) {
        if (Test-Cmd $c) {
            try {
                $verOut = & $c -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')" 2>$null
                if ($LASTEXITCODE -eq 0 -and $verOut) {
                    $parts = $verOut.Trim().Split('.')
                    if ([int]$parts[0] -gt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 9)) {
                        $py = $c
                        break
                    }
                }
            } catch {}
        }
    }
    if ($py) {
        $v = & $py -V 2>&1
        Write-Host "==> Python $v"
        return
    }
    Write-Host '==> Python 3.9+...'
    if (-not (Install-WingetPkg 'Python.Python.3.12')) {
        if (-not (Install-WingetPkg 'Python.Python.3.11')) {
            Write-Host 'ERROR: install Python 3.9+ from https://www.python.org/downloads/'
            Write-Host '       Enable «Add python.exe to PATH» during setup.'
            exit 1
        }
    }
    Refresh-Path
    if (-not (Test-Cmd 'python') -and -not (Test-Cmd 'py')) {
        Write-Host 'ERROR: Python installed but not on PATH. Open a NEW PowerShell and re-run.'
        exit 1
    }
    $v = if (Test-Cmd 'python') { python -V 2>&1 } else { py -V 2>&1 }
    Write-Host "==> Python $v"
}

# --- resolve root ---
$Root = $null
if ((Test-Path 'package.json') -and ((Get-Content 'package.json' -Raw) -match '"name"\s*:\s*"alexandria-lib"')) {
    $Root = (Get-Location).Path
    Write-Host '==> Using current directory'
} elseif ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\package.json'))) {
    $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    Write-Host '==> Using repo next to script'
} else {
    Ensure-Git
    Ensure-Node
    Ensure-Python
    $Target = if ($env:ALEXANDRIA_DIR) { $env:ALEXANDRIA_DIR } else { Join-Path $HOME $RepoName }
    if (Test-Path (Join-Path $Target '.git')) {
        Write-Host "==> Updating $Target"
        git -C $Target pull --ff-only 2>$null | Out-Null
    } else {
        Write-Host "==> Cloning → $Target"
        git clone --depth 1 $RepoUrl $Target 2>&1 | Out-Null
    }
    $Root = $Target
}

Set-Location $Root

Ensure-Git
Ensure-Node
Ensure-Python

Write-Host '==> npm install...'
npm install --silent --no-fund --no-audit 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '==> Python env + models (first run may take several minutes)...'
npm run setup 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'WARN: setup reported errors; try: npm run setup'
}

Write-Host ''
Write-Host '==> Done.'
Write-Host "    Path:   $Root"
Write-Host "    Start:  cd `"$Root`"; npm start"
Write-Host '    Open:   http://localhost:3000'
Write-Host ''
