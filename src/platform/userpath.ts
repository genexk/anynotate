import type { Exec } from "./exec";

// The bin dir comes from the environment so no path is ever spliced into the script text. The raw registry value is
// edited so %VAR% entries stay unexpanded and the value stays REG_EXPAND_SZ. An entry matches case-insensitively
// (PowerShell's -ne/-ieq), with or without a trailing backslash, as written or expanded; the value is only written when
// it changes, and setting then clearing a throwaway variable broadcasts the change to Explorer.
const BROADCAST = [
  "    [Environment]::SetEnvironmentVariable('ANYNOTATE_TMP', 'x', 'User')",
  "    [Environment]::SetEnvironmentVariable('ANYNOTATE_TMP', $null, 'User')",
];

export const REMOVE_PATH_ENTRY = [
  "$ErrorActionPreference = 'Stop'",
  "$d = $env:ANYNOTATE_BIN_DIR.TrimEnd('\\')",
  "$p = (Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
  "if ($p) {",
  "  $parts = @($p -split ';' | Where-Object { $_ })",
  "  $kept = @($parts | Where-Object { $_.TrimEnd('\\') -ne $d -and [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ne $d })",
  "  if ($kept.Count -ne $parts.Count) {",
  "    Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value ($kept -join ';') -Type ExpandString",
  ...BROADCAST,
  "  }",
  "}",
].join("\n");

// Prints "added" or "present" so the caller can say which.
export const ADD_PATH_ENTRY = [
  "$ErrorActionPreference = 'Stop'",
  "$d = $env:ANYNOTATE_BIN_DIR.TrimEnd('\\')",
  "if (-not (Test-Path -LiteralPath 'HKCU:\\Environment')) { New-Item -Path 'HKCU:\\Environment' -Force | Out-Null }",
  "$p = (Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
  "$parts = @($p -split ';' | Where-Object { $_ })",
  "$present = @($parts | Where-Object { $_.TrimEnd('\\') -ieq $d -or [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ieq $d })",
  "if ($present.Count -gt 0) { 'present' } else {",
  "    Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value (@($parts + $d) -join ';') -Type ExpandString",
  ...BROADCAST,
  "    'added'",
  "}",
].join("\n");

export const pathEntryArgv = (script: string) => ["powershell", "-NoProfile", "-NonInteractive", "-Command", script];

export const runPathEntry = (exec: Exec, script: string, dir: string) => exec(pathEntryArgv(script), undefined, { ANYNOTATE_BIN_DIR: dir });
