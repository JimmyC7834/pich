<#
build.ps1 -- Windows wrapper: run bundled ctags then make_vocab.py.

Uses the portable ctags.exe shipped in code-vocab/bin/ (no system install
required). Override with -Ctags to point at a different binary.
#>
param(
    [string]$Root          = (Get-Location).Path,
    [string]$Mode          = "grand",
    [int]   $TokensPerFile = 80,
    [int]   $AtlasBudget   = 2000,
    [string]$Scope         = "",
    [string]$TagsOut       = ".pi/code-vocab/tags.json",
    [string]$VocabOut      = ".pi/code-vocab/vocabulary.md",
    [string]$Ctags         = ""
)

$ErrorActionPreference = "Stop"
$pkgDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Resolve ctags: explicit -Ctags, else bundled, else PATH.
if (-not $Ctags) {
    $bundled = Join-Path $pkgDir "bin\ctags.exe"
    if (Test-Path $bundled) { $Ctags = $bundled }
    elseif (Get-Command ctags -ErrorAction SilentlyContinue) { $Ctags = "ctags" }
    else { throw "ctags not found. Bundled bin\ctags.exe missing and ctags not on PATH." }
}

$rootPath = (Resolve-Path $Root).Path
$tagsPath = Join-Path $rootPath $TagsOut
$vocabPath = Join-Path $rootPath $VocabOut

$artDir = Split-Path -Parent $tagsPath
if (-not (Test-Path $artDir)) { New-Item -ItemType Directory -Force $artDir | Out-Null }
if (Test-Path $tagsPath) { Remove-Item $tagsPath -Force }

Write-Host "ctags: $Ctags"
# Run ctags from inside the repo root with `.` so tag paths are RELATIVE
# (agent/extensions/foo.ts), not absolute C:\Users\... — the atlas buckets by
# path segments and absolute paths would collapse into one root bucket.
Push-Location $rootPath
try {
    & $Ctags `
        --recurse `
        --output-format=json `
        --fields=+nKzS `
        --languages=Python,JavaScript,TypeScript,Go,Rust,Java,Kotlin,Ruby,C,C++,C#,PHP,Lua `
        --links=no `
        --exclude=.git --exclude=.pi --exclude=node_modules --exclude=.venv `
        --exclude=venv --exclude=dist --exclude=build `
        --exclude=target --exclude=__pycache__ `
        --exclude=*.egg-info --exclude=*.min.js --exclude=*.log `
        --exclude=package-lock.json --exclude=yarn.lock `
        --exclude=pnpm-lock.yaml --exclude=*.bundle.js `
        -f "$TagsOut" .
} finally {
    Pop-Location
}

if (-not (Test-Path $tagsPath)) { throw "ctags produced no tags.json" }

$py = "python"
$makeVocab = Join-Path $pkgDir "make_vocab.py"
$pyArgs = @($makeVocab, "--root", $rootPath, "--tags", $tagsPath,
            "--tokens-per-file", $TokensPerFile, "--atlas-budget", $AtlasBudget)
if ($Scope) { $pyArgs += @("--scope", $Scope) }
& $py @pyArgs

$tagsSize = (Get-Item $tagsPath).Length
$vocabSize = (Get-Item $vocabPath).Length
Write-Host "tags.json:     $tagsPath ($tagsSize bytes)"
Write-Host "vocabulary.md: $vocabPath ($vocabSize bytes)"
