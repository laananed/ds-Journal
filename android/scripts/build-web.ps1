# Builds the SeekJournal web frontend and places it inside the Android assets folder.
#
#   powershell -ExecutionPolicy Bypass -File android\scripts\build-web.ps1
#   powershell -ExecutionPolicy Bypass -File android\scripts\build-web.ps1 -ApiBaseUrl https://api.example.com
#   powershell -ExecutionPolicy Bypass -File android\scripts\build-web.ps1 -DistDir ..\frontend\dist
#
# Behaviour:
#   * Default mode runs `vite build` in frontend/ with VITE_API_BASE_URL taken from
#     android/apk.properties, and writes the output directly into
#     android/app/src/main/assets/www (so frontend/ sources are never modified).
#   * -DistDir instead packages an existing build output (e.g. produced by the
#     frontend owner), without running the bundler.
#   * -ApiBaseUrl overrides the value from apk.properties for this run only.
#
# The script refuses non-https base urls: the APK blocks cleartext HTTP on purpose.
# ASCII only, on purpose: Windows PowerShell 5.1 misreads UTF-8 without BOM.

param(
    [string]$ApiBaseUrl = '',
    [string]$DistDir = ''
)

$ErrorActionPreference = 'Stop'

$androidDir  = Split-Path -Parent $PSScriptRoot
$repoRoot    = Split-Path -Parent $androidDir
$frontendDir = Join-Path $repoRoot 'frontend'
$propsFile   = Join-Path $androidDir 'apk.properties'
$wwwDir      = Join-Path $androidDir 'app\src\main\assets\www'

# ---- 1. resolve the cloud API base url -------------------------------------
$props = @{}
if (Test-Path $propsFile) {
    # Read as UTF-8 explicitly: Windows PowerShell 5.1 would otherwise decode the
    # Chinese comments with the ANSI code page and can swallow line breaks.
    $propLines = [System.IO.File]::ReadAllLines($propsFile, [System.Text.Encoding]::UTF8)
    foreach ($line in $propLines) {
        $text = $line.Trim()
        if ($text -and -not $text.StartsWith('#') -and $text.Contains('=')) {
            $idx = $text.IndexOf('=')
            $props[$text.Substring(0, $idx).Trim()] = $text.Substring($idx + 1).Trim()
        }
    }
}

if (-not $ApiBaseUrl) { $ApiBaseUrl = $props['seekjournal.apiBaseUrl'] }
if (-not $ApiBaseUrl) {
    throw "No API base url. Set seekjournal.apiBaseUrl in $propsFile or pass -ApiBaseUrl."
}
if (-not $ApiBaseUrl.StartsWith('https://')) {
    throw "API base url must start with https:// (cleartext HTTP is blocked in the APK): $ApiBaseUrl"
}
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')

# ---- 2. clean the packaged assets folder (build product, safe to recreate) --
New-Item -ItemType Directory -Force -Path $wwwDir | Out-Null
Get-ChildItem -Path $wwwDir -Force |
    Where-Object { $_.Name -ne '.gitkeep' } |
    Remove-Item -Recurse -Force

# ---- 3. build the frontend, or copy an existing dist ----------------------
if ($DistDir) {
    $resolvedDist = (Resolve-Path $DistDir).Path
    if (-not (Test-Path (Join-Path $resolvedDist 'index.html'))) {
        throw "-DistDir does not look like a Vite build output (index.html missing): $resolvedDist"
    }
    Copy-Item -Path (Join-Path $resolvedDist '*') -Destination $wwwDir -Recurse -Force
    $source = "copied from $resolvedDist (dist already built with API base $ApiBaseUrl)"
    if ($ApiBaseUrl -like '*.invalid') {
        Write-Warning "The copied dist may have been built with another VITE_API_BASE_URL; this script cannot rewrite it."
    }
}
else {
    $env:VITE_API_BASE_URL = $ApiBaseUrl
    Push-Location $frontendDir
    try {
        & npm.cmd exec -- vite build --outDir $wwwDir --emptyOutDir --logLevel warn
        if ($LASTEXITCODE -ne 0) { throw "vite build failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
        Remove-Item Env:\VITE_API_BASE_URL -ErrorAction SilentlyContinue
    }
    $source = "vite build from frontend/ (VITE_API_BASE_URL=$ApiBaseUrl)"
}

# ---- 4. record what was packaged (reproducibility evidence) --------------
# vite --emptyOutDir 会清掉整个 outDir，包括占位的 .gitkeep；在这里补回
$gitkeep = Join-Path $wwwDir '.gitkeep'
if (-not (Test-Path $gitkeep)) {
    New-Item -ItemType File -Path $gitkeep -Force | Out-Null
}

$gitHead       = (& git -C $repoRoot rev-parse HEAD).Trim()
$frontendDirty = [bool]((& git -C $repoRoot status --porcelain -- frontend) -join '')
$files         = Get-ChildItem -Path $wwwDir -Recurse -File
$totalBytes    = ($files | Measure-Object -Property Length -Sum).Sum
$indexHash     = (Get-FileHash -Algorithm SHA256 (Join-Path $wwwDir 'index.html')).Hash.ToLower()

$info = [ordered]@{
    apiBaseUrl     = $ApiBaseUrl
    apiBaseUrlStatus = $(if ($ApiBaseUrl -like '*.invalid') { 'placeholder' } else { 'configured' })
    source         = $source
    builtAt        = (Get-Date).ToString('o')
    gitHead        = $gitHead
    frontendDirty  = $frontendDirty
    fileCount      = $files.Count
    totalBytes     = [long]$totalBytes
    indexSha256    = $indexHash
}
$info | ConvertTo-Json | Set-Content -Path (Join-Path $wwwDir 'build-info.json') -Encoding UTF8

# ---- 5. report -----------------------------------------------------------
Write-Host "assets -> $wwwDir"
Write-Host "api    -> $ApiBaseUrl"
Write-Host "head   -> $gitHead (frontend modified: $frontendDirty)"
Write-Host ("files  -> {0} files, {1:N0} bytes, index.html sha256 {2}" -f $files.Count, $totalBytes, $indexHash)
if ($ApiBaseUrl -like '*.invalid') {
    Write-Warning "PLACEHOLDER api base url: this build talks to no real backend. Not a final usable package."
}
Write-Host ""
Write-Host "Next: android\gradlew.bat assembleDebug"
