# Anynotate installer for Windows (PowerShell 5.1 or later).
#
#   irm https://github.com/genexk/anynotate/releases/latest/download/install.ps1 | iex
#
# Downloads anynotate-windows-x64.exe, verifies it against the release's
# SHA256SUMS, installs it to %LOCALAPPDATA%\anynotate\bin, adds that directory
# to the user PATH and runs `anynotate install`. Needs no administrator rights.
#
# Environment:
#   ANYNOTATE_VERSION   install this release (e.g. 0.4.0) instead of the latest
#   ANYNOTATE_BASE_URL  download from this base URL instead (file:// works)
#   ANYNOTATE_BIN_DIR   install into this directory instead
#
# Everything runs from Install-Anynotate, called on the last line, so a
# truncated download never executes a partial script.

function Install-Anynotate {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  Set-StrictMode -Version Latest

  if ($env:OS -ne 'Windows_NT') {
    throw 'install.ps1 is for Windows; use install.sh'
  }

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {
  }

  if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'anynotate installer: unsupported platform: 32-bit Windows. Supported targets: windows-x64, darwin-arm64, darwin-x64, linux-x64, linux-arm64.'
  }

  $asset = 'anynotate-windows-x64.exe'
  $hostArch = $env:PROCESSOR_ARCHITEW6432
  if (-not $hostArch) {
    $hostArch = $env:PROCESSOR_ARCHITECTURE
  }
  if ($hostArch -eq 'ARM64') {
    Write-Host 'Note: this is ARM64 Windows; the x64 build runs under emulation (Windows 11).'
  }

  $base = $env:ANYNOTATE_BASE_URL
  if (-not $base) {
    $version = $env:ANYNOTATE_VERSION
    if ($version) {
      $base = 'https://github.com/genexk/anynotate/releases/download/v' + $version.TrimStart('v')
    } else {
      $base = 'https://github.com/genexk/anynotate/releases/latest/download'
    }
  }
  $base = $base.TrimEnd('/')

  $binDir = $env:ANYNOTATE_BIN_DIR
  if (-not $binDir) {
    if (-not $env:LOCALAPPDATA) {
      throw 'anynotate installer: LOCALAPPDATA is not set; set ANYNOTATE_BIN_DIR to choose an install directory.'
    }
    $binDir = Join-Path $env:LOCALAPPDATA 'anynotate\bin'
  }
  if ($binDir.Contains(';')) {
    throw "anynotate installer: install directory '$binDir' contains ';', which cannot go on PATH."
  }
  $binDir = [IO.Path]::GetFullPath($binDir).TrimEnd('\')
  $exe = Join-Path $binDir 'anynotate.exe'

  Write-Host 'Anynotate installer'
  Write-Host "  platform:  windows-x64"
  Write-Host "  download:  $base/$asset"
  Write-Host "  verify:    against $base/SHA256SUMS"
  Write-Host "  install:   $exe"
  Write-Host "  PATH:      add $binDir to your user PATH if missing"
  Write-Host "  then run:  $exe install (sets up the bridge service and browser hosts)"
  Write-Host ''

  $download = {
    param([string]$url, [string]$dest)
    $uri = [Uri]$url
    if ($uri.IsFile) {
      Copy-Item -LiteralPath $uri.LocalPath -Destination $dest -Force
    } else {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dest
    }
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('anynotate-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $downloaded = Join-Path $tmp $asset
    $sums = Join-Path $tmp 'SHA256SUMS'
    Write-Host "Downloading $base/$asset"
    & $download "$base/$asset" $downloaded
    & $download "$base/SHA256SUMS" $sums

    $expected = $null
    foreach ($line in (Get-Content -LiteralPath $sums)) {
      $fields = $line.Trim() -split '\s+'
      if ($fields.Count -ge 2 -and ($fields[1] -eq $asset -or $fields[1] -eq ('*' + $asset))) {
        $expected = $fields[0].ToLowerInvariant()
        break
      }
    }
    if (-not $expected) {
      throw "anynotate installer: no checksum for $asset in SHA256SUMS; refusing to install."
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloaded).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "anynotate installer: checksum mismatch for $asset (expected $expected, got $actual); refusing to install."
    }
    Write-Host "Verified SHA-256 $actual"

    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    $staged = "$exe.new"
    Copy-Item -LiteralPath $downloaded -Destination $staged -Force

    # A running anynotate.exe cannot be overwritten but can be renamed, so it
    # is moved aside to anynotate.exe.old (or anynotate.exe.<guid>.old while an
    # older one is still locked). Leftovers from earlier installs whose
    # processes have exited are removed here, best-effort.
    $leftovers = @(Get-ChildItem -LiteralPath $binDir -Filter 'anynotate.exe.*.old' -ErrorAction SilentlyContinue)
    $leftovers += @(Get-Item -LiteralPath "$exe.old" -ErrorAction SilentlyContinue)
    foreach ($leftover in $leftovers) {
      if ($leftover) {
        try { Remove-Item -LiteralPath $leftover.FullName -Force } catch { }
      }
    }
    $aside = $null
    if (Test-Path -LiteralPath $exe) {
      $aside = "$exe.old"
      if (Test-Path -LiteralPath $aside) {
        $aside = "$exe." + [Guid]::NewGuid().ToString('N') + '.old'
      }
      try {
        Move-Item -LiteralPath $exe -Destination $aside -Force
      } catch {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
        throw "anynotate installer: cannot replace $exe ($($_.Exception.Message))."
      }
    }
    try {
      Move-Item -LiteralPath $staged -Destination $exe -Force
    } catch {
      $reason = $_.Exception.Message
      $kept = ''
      if ($aside) {
        try {
          Move-Item -LiteralPath $aside -Destination $exe -Force
          $kept = '; the previous version was restored'
        } catch {
          $kept = "; the previous version is at $aside"
        }
      }
      Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
      throw "anynotate installer: cannot install $exe ($reason)$kept."
    }
    Write-Host "Installed $exe"

    # Read the raw user PATH so %VAR% entries stay unexpanded when written back.
    $envKey = 'HKCU:\Environment'
    if (-not (Test-Path -LiteralPath $envKey)) {
      New-Item -Path $envKey -Force | Out-Null
    }
    $rawPath = (Get-Item -LiteralPath $envKey).GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $wanted = $binDir.TrimEnd('\')
    $present = $false
    foreach ($entry in ($rawPath -split ';')) {
      if (-not $entry) { continue }
      $expanded = [Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\')
      if ($entry.TrimEnd('\') -ieq $wanted -or $expanded -ieq $wanted) {
        $present = $true
        break
      }
    }
    if (-not $present) {
      if ($rawPath) {
        $newPath = $rawPath.TrimEnd(';') + ';' + $binDir
      } else {
        $newPath = $binDir
      }
      Set-ItemProperty -LiteralPath $envKey -Name 'Path' -Value $newPath -Type ExpandString
      # Setting and clearing a throwaway user variable broadcasts the change,
      # so new terminals pick up the PATH without signing out.
      [Environment]::SetEnvironmentVariable('ANYNOTATE_PATH_REFRESH', '1', 'User')
      [Environment]::SetEnvironmentVariable('ANYNOTATE_PATH_REFRESH', $null, 'User')
      Write-Host "Added $binDir to your user PATH"
    }
    $sessionHas = $false
    foreach ($entry in ($env:Path -split ';')) {
      if ($entry -and $entry.TrimEnd('\') -ieq $wanted) {
        $sessionHas = $true
        break
      }
    }
    if (-not $sessionHas) {
      $env:Path = $env:Path.TrimEnd(';') + ';' + $binDir
    }

    Write-Host "Running $exe install"
    # Native stderr must not become a terminating error under 'Stop'.
    $ErrorActionPreference = 'Continue'
    & $exe install 2>&1 | Out-Host
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) {
      throw "anynotate installer: '$exe install' failed (exit $code); fix the problem above and run it again."
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host ''
  Write-Host 'Run: anynotate doctor'
}

Install-Anynotate
