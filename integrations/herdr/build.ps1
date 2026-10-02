# herdr build hook on Windows; mirrors build.sh.
#
# - anynotate.exe already installed: try `anynotate update` if it is older
#   than this plugin (a failed update only warns), then run
#   `anynotate install` (idempotent).
# - not installed: run the release installer, which downloads and verifies
#   the binary and runs `anynotate install` itself. The installer is taken
#   from this checkout (..\..\scripts\install.ps1) when ..\..\integrations\herdr
#   is this directory, and otherwise downloaded, to a file.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$run = Join-Path $root 'bin\anynotate-run.ps1'
$installerUrl = 'https://github.com/genexk/anynotate/releases/latest/download/install.ps1'

function Say([string]$text) { Write-Output "anynotate plugin: $text" }
function Fail([string]$text) {
    [Console]::Error.WriteLine("anynotate plugin build failed: $text")
    exit 1
}

function Get-PluginVersion {
    $line = Get-Content -LiteralPath (Join-Path $root 'herdr-plugin.toml') | Where-Object { $_ -match '^version\s*=\s*"([^"]*)"' } | Select-Object -First 1
    if ($line -match '^version\s*=\s*"([^"]*)"') { return $Matches[1] }
    return $null
}

function Find-Anynotate {
    $ErrorActionPreference = 'Continue'
    try {
        $found = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $run --locate 2>$null
        if ($LASTEXITCODE -eq 0 -and $found) { return ($found | Select-Object -First 1) }
    } catch { }
    return $null
}

function Test-AnynotateCheckout {
    $there = Join-Path $root '..\..\integrations\herdr'
    if (-not (Test-Path -LiteralPath (Join-Path $there 'herdr-plugin.toml') -PathType Leaf)) { return $false }
    $a = (Get-Item -LiteralPath $root).FullName.TrimEnd('\')
    $b = (Get-Item -LiteralPath $there).FullName.TrimEnd('\')
    return $a -eq $b
}

function Invoke-Installer {
    $local = Join-Path $root '..\..\scripts\install.ps1'
    if ((Test-Path -LiteralPath $local -PathType Leaf) -and (Test-AnynotateCheckout)) {
        Say "installing anynotate with $local"
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $local
        if ($LASTEXITCODE -ne 0) { Fail 'the anynotate installer failed; see the output above.' }
        return
    }
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("anynotate-plugin-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $script = Join-Path $tmp 'install.ps1'
        Say "downloading the anynotate installer from $installerUrl"
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -UseBasicParsing -Uri $installerUrl -OutFile $script
        } catch {
            Fail "could not download ${installerUrl}: $($_.Exception.Message)"
        }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
        if ($LASTEXITCODE -ne 0) { Fail 'the anynotate installer failed; see the output above.' }
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$exe = Find-Anynotate
if ($exe) {
    $wanted = Get-PluginVersion
    $have = $null
    try { $have = (& $exe --version | Select-Object -First 1) } catch { }
    Say "found $exe $have"
    $older = $true
    if ($have) {
        try { $older = ([version]($have.Trim() -replace '[^0-9.].*$', '')) -lt [version]$wanted } catch { $older = $true }
    }
    if ($wanted -and $older) {
        Say "updating anynotate to at least $wanted"
        & $exe update
        if ($LASTEXITCODE -ne 0) { Say "warning: '$exe update' failed; the plugin needs anynotate $wanted or newer, so update it by hand (re-run its installer)." }
    }
    & $exe install
    if ($LASTEXITCODE -ne 0) { Fail "'$exe install' failed; fix the problem above and install the plugin again." }
} else {
    Invoke-Installer
    if (-not (Find-Anynotate)) { Fail 'the installer finished but anynotate.exe was not found.' }
}

Say 'ready'
