param(
    [switch]$NoBrowser,
    [switch]$SkipAiRecovery
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$python = Join-Path $backend '.venv\Scripts\python.exe'

function Stop-WithMessage([string]$message) {
    Write-Host "`nERROR: $message" -ForegroundColor Red
    exit 1
}

try {
    Set-Location $root
    $branch = & git branch --show-current
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
        Stop-WithMessage 'Use the main worktree at C:\Programme\demo\SeekJournal. This worktree is not on main.'
    }
    $head = & git rev-parse HEAD
    Write-Host "Code: main @ $head"
    Write-Host "Directory: $root"
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-WithMessage 'Docker is not installed or not on PATH.' }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Stop-WithMessage 'Node.js/npm is not on PATH.' }
    if (-not (Test-Path $python)) { Stop-WithMessage 'Backend .venv is missing. See README.md for setup.' }
    if (-not (Test-Path (Join-Path $backend '.env'))) { Stop-WithMessage 'backend/.env is missing. See README.md for setup.' }
    if (-not (Test-Path (Join-Path $frontend 'node_modules\vite\bin\vite.js'))) { Stop-WithMessage 'Frontend dependencies are missing. See README.md for setup.' }

    Write-Host '1/3 Checking Docker and starting PostgreSQL...'
    & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Start Docker Desktop and wait until its engine is ready.' }
    $container = & docker compose --env-file (Join-Path $backend '.env') ps -a -q postgres
    if ($LASTEXITCODE -ne 0 -or -not $container) { Stop-WithMessage 'The existing PostgreSQL container was not found. No database was created.' }
    & docker start $container | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'PostgreSQL did not start; see Docker output above.' }

    Write-Host 'Checking database revision (read only)...'
    Set-Location $backend
    $check = @'
from app.database import engine
from sqlalchemy import create_engine, text
from alembic.config import Config
from alembic.script import ScriptDirectory
import sys
try:
    probe = create_engine(engine.url, connect_args={'connect_timeout': 2})
    with probe.connect() as conn:
        conn.execute(text('SET TRANSACTION READ ONLY'))
        assert conn.execute(text('SELECT 1')).scalar_one() == 1
        current = set(conn.execute(text('SELECT version_num FROM alembic_version')).scalars())
    expected = set(ScriptDirectory.from_config(Config('alembic.ini')).get_heads())
    if current != expected:
        print('Database revision:', ', '.join(sorted(current)) or '(none)')
        print('Code revision:', ', '.join(sorted(expected)) or '(none)')
        sys.exit(1)
except Exception as exc:
    print('Database check failed:', type(exc).__name__)
    sys.exit(2)
print('Database connection and revision verified (read only).')
'@
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        $check | & $python -B -
        $checkResult = $LASTEXITCODE
        if ($checkResult -ne 2) { break }
        if ($attempt -lt 30) { Start-Sleep -Seconds 1 }
    }
    if ($checkResult -ne 0) { Stop-WithMessage 'Database is unavailable or revision differs. Do not upgrade the personal database without separate approval and a verified backup.' }

    $runDirectory = Join-Path $root '.local-run'
    $statePath = Join-Path $runDirectory 'runtime.json'
    $backendListener = Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue
    $frontendListener = Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue
    if ($backendListener -and $frontendListener -and (Test-Path $statePath)) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $backendRunning = Get-Process -Id $state.backendPid -ErrorAction SilentlyContinue
        $frontendRunning = Get-Process -Id $state.frontendPid -ErrorAction SilentlyContinue
        if ($state.root -eq $root -and $state.head -eq $head -and
            $backendRunning -and $frontendRunning -and
            $backendListener.OwningProcess -contains $state.backendPid -and
            $frontendListener.OwningProcess -contains $state.frontendPid -and
            $backendRunning.StartTime.ToUniversalTime().Ticks -eq $state.backendStarted -and
            $frontendRunning.StartTime.ToUniversalTime().Ticks -eq $state.frontendStarted) {
            $health = Invoke-RestMethod 'http://127.0.0.1:8000/api/health' -TimeoutSec 3
            $page = Invoke-WebRequest 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 3
            if ($health.status -eq 'ok' -and $page.StatusCode -eq 200) {
                Write-Host 'This main version is already running: http://127.0.0.1:5173/' -ForegroundColor Green
                if ($state.skipAiRecovery) { Write-Host 'AI startup recovery was skipped for the running session.' }
                if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5173/' }
                exit 0
            }
        }
    }
    foreach ($port in @(8000, 5173)) {
        if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
            Stop-WithMessage "Port $port is already in use. Close the existing service yourself, then retry."
        }
    }

    New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    Write-Host '2/3 Starting backend...'
    $backendArguments = @('-B', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000')
    if ($SkipAiRecovery) {
        $backendArguments += @('--lifespan', 'off')
        Write-Host 'AI startup recovery skipped for this session; no automatic recovery writes.'
    }
    Start-Process -FilePath $python -ArgumentList $backendArguments -WorkingDirectory $backend -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runDirectory "backend-$stamp.out.log") -RedirectStandardError (Join-Path $runDirectory "backend-$stamp.err.log") | Out-Null
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:8000/api/health' -TimeoutSec 1
            if ($health.status -eq 'ok') { $ready = $true; break }
        } catch { }
    }
    if (-not $ready) { Stop-WithMessage "Backend did not become ready. Check $runDirectory for logs." }

    Write-Host '3/3 Starting frontend...'
    $env:VITE_API_BASE_URL = 'http://127.0.0.1:8000'
    $vite = Join-Path $frontend 'node_modules\vite\bin\vite.js'
    Start-Process -FilePath 'node.exe' -ArgumentList @(('"{0}"' -f $vite), '--host', '127.0.0.1', '--port', '5173', '--strictPort') -WorkingDirectory $frontend -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runDirectory "frontend-$stamp.out.log") -RedirectStandardError (Join-Path $runDirectory "frontend-$stamp.err.log") | Out-Null
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            $response = Invoke-WebRequest 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
    }
    if (-not $ready) { Stop-WithMessage "Frontend did not become ready. Check $runDirectory for logs." }
    $backendPid = (Get-NetTCPConnection -State Listen -LocalPort 8000).OwningProcess | Select-Object -Unique
    $frontendPid = (Get-NetTCPConnection -State Listen -LocalPort 5173).OwningProcess | Select-Object -Unique
    @{
        root = $root; head = $head; skipAiRecovery = [bool]$SkipAiRecovery
        backendPid = $backendPid; frontendPid = $frontendPid
        backendStarted = (Get-Process -Id $backendPid).StartTime.ToUniversalTime().Ticks
        frontendStarted = (Get-Process -Id $frontendPid).StartTime.ToUniversalTime().Ticks
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5173/' }
    Write-Host "SeekJournal is ready: http://127.0.0.1:5173/ (main). Logs: $runDirectory" -ForegroundColor Green
} catch {
    Stop-WithMessage "Startup failed: $($_.Exception.Message)"
}
