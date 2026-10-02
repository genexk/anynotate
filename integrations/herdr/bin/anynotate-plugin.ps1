# herdr glue for the Anynotate plugin on Windows; mirrors bin/anynotate-plugin.
#
#   anynotate-plugin send-here    deliver the latest note to the focused pane
#   anynotate-plugin open-inbox   open the inbox popup
#   anynotate-plugin open-link    open the inbox popup on the clicked bundle
#   anynotate-plugin inbox-pane   the popup's own command

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$run = Join-Path $here 'anynotate-run.ps1'
$herdr = if ($env:HERDR_BIN_PATH) { $env:HERDR_BIN_PATH } else { 'herdr' }
$pluginId = if ($env:HERDR_PLUGIN_ID) { $env:HERDR_PLUGIN_ID } else { 'anynotate' }
# \z, not $: $ also matches before a trailing newline. [0-9], not \d: \d takes any Unicode digit.
$bundleId = '\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}-[a-z0-9-]+\z'
$paneId = '\A[A-Za-z0-9][A-Za-z0-9_.:-]*\z'

function Send-Notice([string]$text) {
    try { & $herdr notification show 'Anynotate' --body $text *> $null } catch { }
}

function Get-FocusedPane {
    $pane = $null
    if ($env:HERDR_PLUGIN_CONTEXT_JSON) {
        try { $pane = ($env:HERDR_PLUGIN_CONTEXT_JSON | ConvertFrom-Json).focused_pane_id } catch { }
    }
    if (-not $pane) { $pane = $env:HERDR_PANE_ID }
    if ($pane -is [string] -and $pane -cmatch $paneId) { return $pane }
    return $null
}

function Get-BundleFromUrl([string]$url) {
    $path = $url -replace '^file://', ''
    $path = $path -replace '[\\/]?README\.md$', ''
    $id = ($path -split '[\\/]')[-1]
    if ($id -cmatch $bundleId) { return $id }
    return $null
}

function Open-Inbox([string]$select) {
    $open = @('plugin', 'pane', 'open', '--plugin', $pluginId, '--entrypoint', 'inbox', '--cwd', $root)
    if ($select) { $open += @('--env', "ANYNOTATE_INBOX_SELECT=$select") }
    & $herdr @open
    exit $LASTEXITCODE
}

$command = if ($args.Count -gt 0) { $args[0] } else { '' }
switch ($command) {
    'send-here' {
        $pane = Get-FocusedPane
        if (-not $pane) {
            Send-Notice 'No focused pane to send the latest note to.'
            exit 1
        }
        # Windows PowerShell turns redirected native stderr into error records,
        # which 'Stop' would throw on; stringify them instead.
        $ErrorActionPreference = 'Continue'
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $run deliver latest --pane $pane 2>&1 | ForEach-Object { "$_" } | Out-String
        $status = $LASTEXITCODE
        Write-Output $output
        $summary = ($output -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
        if (-not $summary) {
            $summary = if ($status -eq 0) { "Sent the latest note to pane $pane." } else { "Could not send the latest note to pane $pane (exit $status)." }
        }
        Send-Notice $summary
        exit $status
    }
    'open-inbox' { Open-Inbox $null }
    'open-link' {
        $id = Get-BundleFromUrl $env:HERDR_PLUGIN_CLICKED_URL
        if (-not $id) {
            Send-Notice 'That link is not an Anynotate bundle README.'
            exit 1
        }
        Open-Inbox $id
    }
    'inbox-pane' {
        $select = $env:ANYNOTATE_INBOX_SELECT
        if ($select -and $select -cmatch $bundleId) {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $run inbox --select $select
        } else {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $run inbox
        }
        exit $LASTEXITCODE
    }
    default {
        [Console]::Error.WriteLine('usage: anynotate-plugin <send-here|open-inbox|open-link|inbox-pane>')
        exit 2
    }
}
