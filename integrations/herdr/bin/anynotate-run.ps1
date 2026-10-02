# Runs the installed anynotate.exe with every argument passed through.
#
# Lookup order:
#   1. $env:ANYNOTATE_BIN_DIR\anynotate.exe (the installer's override)
#   2. %LOCALAPPDATA%\anynotate\bin\anynotate.exe (the installer's default)
#   3. anynotate.exe on PATH
#
#   anynotate-run --locate   prints the path it would run and exits

$ErrorActionPreference = 'Stop'

function Find-Anynotate {
    $candidates = @()
    if ($env:ANYNOTATE_BIN_DIR) { $candidates += Join-Path $env:ANYNOTATE_BIN_DIR 'anynotate.exe' }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'anynotate\bin\anynotate.exe' }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $onPath = Get-Command 'anynotate.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    return $null
}

$exe = Find-Anynotate
$locate = ($args.Count -gt 0 -and $args[0] -eq '--locate')

if (-not $exe) {
    $message = 'anynotate is not installed. Install it with: irm https://github.com/genexk/anynotate/releases/latest/download/install.ps1 | iex'
    [Console]::Error.WriteLine("anynotate-run: $message")
    if ($env:HERDR_BIN_PATH -and -not $locate) {
        try { & $env:HERDR_BIN_PATH notification show 'Anynotate' --body $message *> $null } catch { }
    }
    exit 127
}

if ($locate) {
    Write-Output $exe
    exit 0
}

& $exe @args
exit $LASTEXITCODE
