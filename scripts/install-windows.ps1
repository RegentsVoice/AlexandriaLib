$ErrorActionPreference = 'Stop'

$RepoUrl  = if ($env:ALEXANDRIA_REPO) { $env:ALEXANDRIA_REPO } else { 'https://github.com/RegentsVoice/AlexandriaLib.git' }
$RepoName = 'AlexandriaLib'
$MinNode  = 18

Write-Host ''
Write-Host '  AlexandriaLib installer (Windows)'
Write-Host '  ---------------------------------'
Write-Host ''

function Step([string]$Msg) { Write-Host "==> $Msg" }
function Ok([string]$Msg)   { Write-Host "    ok: $Msg" }

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

function Invoke-WithSpinner {
    param(
        [string]$Message,
        [scriptblock]$Action
    )
    $frames = @('|', '/', '-', '\')
    $i = 0
    $job = Start-Job -ScriptBlock $Action
    while ($job.State -eq 'Running') {
        Write-Host -NoNewline ("`r    {0} {1}" -f $Message, $frames[$i % 4])
        $i++
        Start-Sleep -Milliseconds 200
    }
    Write-Host -NoNewline ("`r" + (' ' * 60) + "`r")
    $result = Receive-Job $job -ErrorAction SilentlyContinue
    $err = $job.ChildJobs[0].Error
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    if ($job.State -eq 'Failed' -or $err) {
        throw ($err | Out-String)
    }
    return $result
}

function Ensure-Git {
    if (Test-Cmd 'git') {
        Ok ("git " + (git --version))
        return
    }
    Step 'Installing git...'
    if (-not (Install-WingetPkg 'Git.Git')) {
        Write-Host 'ERROR: install Git for Windows: https://git-scm.com/download/win'
        exit 1
    }
    Refresh-Path
    if (-not (Test-Cmd 'git')) {
        Write-Host 'ERROR: git installed but not on PATH. Open a NEW PowerShell and re-run.'
        exit 1
    }
    Ok 'git installed'
}

function Ensure-Node {
    if ((Test-Cmd 'node') -and (Test-Cmd 'npm')) {
        $major = [int]((node -v) -replace '^v', '').Split('.')[0]
        if ($major -ge $MinNode) {
            Ok ("Node $(node -v), npm $(npm -v)")
            return
        }
        Step "Node $(node -v) is too old (< $MinNode), upgrading..."
    } else {
        Step 'Installing Node.js LTS...'
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
    Ok ("Node $(node -v)")
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
        Ok ("Python $v")
        return
    }
    Step 'Installing Python 3.12...'
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
    Ok ("Python $v")
}

$Root = $null
if ((Test-Path 'package.json') -and ((Get-Content 'package.json' -Raw) -match '"name"\s*:\s*"alexandria-lib"')) {
    $Root = (Get-Location).Path
    Step 'Using current directory'
} elseif ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\package.json'))) {
    $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    Step 'Using repo next to script'
} else {
    Ensure-Git
    Ensure-Node
    Ensure-Python
    $Target = if ($env:ALEXANDRIA_DIR) { $env:ALEXANDRIA_DIR } else { Join-Path $HOME $RepoName }
    if (Test-Path (Join-Path $Target '.git')) {
        Step "Updating $Target"
        git -C $Target pull --ff-only 2>$null | Out-Null
        Ok 'updated'
    } else {
        Step "Cloning repository → $Target"
        Write-Host '    git clone in progress...'
        git clone --depth 1 $RepoUrl $Target
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Ok 'cloned'
    }
    $Root = $Target
}

Set-Location $Root
Ok "project: $Root"

Ensure-Git
Ensure-Node
Ensure-Python

Step 'npm install (Node packages)...'
Write-Host '    this may take a minute...'
$npmLog = Join-Path $env:TEMP 'al-npm.log'
npm install --no-fund --no-audit *> $npmLog
if ($LASTEXITCODE -ne 0) {
    Write-Host 'ERROR: npm install failed — last lines:'
    Get-Content $npmLog -Tail 30 -ErrorAction SilentlyContinue
    exit $LASTEXITCODE
}
Ok 'npm packages'

Step 'Python venv + pip + TTS models...'
Write-Host '    (torch / Silero — first time can take several minutes)'
Write-Host '    please wait, progress appears below...'
$setupLog = Join-Path $env:TEMP 'al-setup.log'
npm run setup 2>&1 | Tee-Object -FilePath $setupLog
if ($LASTEXITCODE -ne 0) {
    Write-Host 'ERROR: setup failed — last lines:'
    Get-Content $setupLog -Tail 40 -ErrorAction SilentlyContinue
    exit $LASTEXITCODE
}
Ok 'python + models'

Step 'Installing hf_xet for faster model downloads...'
$venvPython = Join-Path $Root 'python\.venv\Scripts\python.exe'
if (Test-Path $venvPython) {
    & $venvPython -m pip install hf_xet 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok 'hf_xet installed' }
    else { Ok 'hf_xet not available, falling back to HTTP' }
} else {
    Ok 'venv python not found, skipping hf_xet'
}

Write-Host ''
Write-Host '  ---------------------------------'
Write-Host '  Installation complete'
Write-Host "  Path:   $Root"
Write-Host "  Start:  cd `"$Root`"; npm start"
Write-Host '  Open:   http://localhost:3000'
Write-Host '  ---------------------------------'
Write-Host ''
