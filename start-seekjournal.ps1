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
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-WithMessage 'Docker is not installed or not on PATH.' }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Stop-WithMessage 'Node.js/npm is not on PATH.' }
    if (-not (Test-Path $python)) { Stop-WithMessage 'Backend .venv is missing. See README.md for setup.' }
    if (-not (Test-Path (Join-Path $backend '.env'))) { Stop-WithMessage 'backend/.env is missing. See README.md for setup.' }
    if (-not (Test-Path (Join-Path $frontend 'node_modules\vite\bin\vite.js'))) { Stop-WithMessage 'Frontend dependencies are missing. See README.md for setup.' }

    Write-Host '1/3 Checking Docker and starting PostgreSQL...'
    & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Start Docker Desktop and wait until its engine is ready.' }
    & docker compose --env-file (Join-Path $backend '.env') up -d --no-recreate postgres
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'PostgreSQL did not start; see Docker output above.' }

    Write-Host 'Checking database revision (read only)...'
    Set-Location $backend
    $check = @'
from app.database import engine
from sqlalchemy import text
from alembic.config import Config
from alembic.script import ScriptDirectory
import sys
try:
    with engine.connect() as conn:
        conn.execute(text('SET TRANSACTION READ ONLY'))
        current = set(conn.execute(text('SELECT version_num FROM alembic_version')).scalars())
    expected = set(ScriptDirectory.from_config(Config('alembic.ini')).get_heads())
    if current != expected:
        print('Database revision:', ', '.join(sorted(current)) or '(none)')
        print('Code revision:', ', '.join(sorted(expected)) or '(none)')
        sys.exit(1)
except Exception as exc:
    print('Database check failed:', type(exc).__name__)
    sys.exit(2)
print('Database revision matches.')
'@
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        $check | & $python -B -
        $checkResult = $LASTEXITCODE
        if ($checkResult -ne 2) { break }
        if ($attempt -lt 30) { Start-Sleep -Seconds 1 }
    }
    if ($checkResult -ne 0) { Stop-WithMessage 'Database is unavailable or revision differs. Do not upgrade the personal database without separate approval and a verified backup.' }

    foreach ($port in @(8000, 5173)) {
        if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
            Stop-WithMessage "Port $port is already in use. Close the existing service yourself, then retry."
        }
    }

    Write-Host '2/3 Starting backend in a separate window...'
    $backendCommand = "Set-Location -LiteralPath '$($backend.Replace("'", "''"))'; & '$($python.Replace("'", "''"))' -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
    Start-Process powershell.exe -ArgumentList @('-NoExit', '-NoProfile', '-Command', $backendCommand) | Out-Null
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:8000/api/health' -TimeoutSec 1
            if ($health.status -eq 'ok') { $ready = $true; break }
        } catch { }
    }
    if (-not $ready) { Stop-WithMessage 'Backend did not become ready. Check its window for the error.' }

    Write-Host '3/3 Starting frontend in a separate window...'
    $env:VITE_API_BASE_URL = 'http://127.0.0.1:8000'
    $frontendCommand = "Set-Location -LiteralPath '$($frontend.Replace("'", "''"))'; npm run dev"
    Start-Process powershell.exe -ArgumentList @('-NoExit', '-NoProfile', '-Command', $frontendCommand) | Out-Null
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            $response = Invoke-WebRequest 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
    }
    if (-not $ready) { Stop-WithMessage 'Frontend did not become ready. Check its window for the error.' }
    Start-Process 'http://127.0.0.1:5173/'
    Write-Host 'SeekJournal is ready. Keep the backend and frontend windows open.' -ForegroundColor Green
} catch {
    Stop-WithMessage "Startup failed: $($_.Exception.Message)"
}
