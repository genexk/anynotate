# Changelog

All notable changes to Anynotate are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [0.6.5] - 2026-10-05

### Changed

- `anynotate doctor` lists every extension that has talked to the bridge in the last 14 days, one line per extension and version, labelled Chrome Web Store, dev build or unpacked build. Running two Chrome profiles, or a store build next to a dev build, no longer makes doctor flip between versions.
- `anynotate status` sums up all of those extensions instead of showing only the one that spoke last.
- An outdated extension stays a warning even when a current one is also connected.

### Fixed

- Requests that carry no browser origin are no longer recorded as an extension.
- The last extension version recorded by 0.6.4 is carried over on upgrade.

## [0.6.4] - 2026-10-04

### Added

- The bridge notices when the browser extension is older than it expects (before 0.3.1, or sending no version). Bundles from such an extension get a note at the top of their README and in `read_notes`; nothing is blocked.
- `anynotate doctor` and `anynotate status` show the last extension version seen and how to update it.
- Bug report and feature request forms on GitHub issues.
- Docs for setting and fixing the extension's keyboard shortcuts.

### Changed

- Windows and Linux support is marked beta across the README, website and support page.

## [0.6.3] - 2026-10-04

### Added

- `anynotate install` detects Claude Desktop, Cursor, Codex and Claude Code and connects each to Anynotate over MCP. Skip it with `--no-mcp` or `ANYNOTATE_NO_MCP=1`; apps you disconnect yourself stay disconnected.
- `anynotate doctor` points at any detected app that is not connected.
- The website links the Chrome Web Store listing.

### Changed

- The website headline and buttons were refreshed, and the guide shows the new glass panel.

## [0.6.2] - 2026-10-04

### Changed

- The `anynotate inbox` picker highlights the selected row, stripes the others and shows herdr workspace names.
- The website and guide have a new look and document every current feature.

## [0.6.1] - 2026-10-04

### Added

- Claude Code and Codex sessions outside herdr show their session title in the extension's target list, and herdr panes show their workspace name (protocol 0.5.0).
- Sessions waiting on a prompt hook share the Sessions list with herdr panes; a session in the Claude desktop app shows `Claude app` as its folder.

### Changed

- Notes sent to a session that is no longer running say so in the bundle README.
- The guide and privacy page cover annotations inside frames from other sites.

## [0.6.0] - 2026-10-03

### Added

- `anynotate mcp`: an MCP server that lets Claude Desktop, Cursor, Codex and Claude Code list, read and mark done your notes, and fetch their screenshots.
- `anynotate mcp install` and `anynotate mcp uninstall` add or remove Anynotate in each app's config.

### Changed

- All agents and apps read from one shared inbox.
- The guide and home page show how to mark a region.

## [0.5.1] - 2026-10-03

### Added

- Element annotations can carry a marked region, annotations can be flagged as off screen, and annotations inside iframes record which frame they came from (protocol 0.4.0). All fields are optional, so older extensions keep working.
- An illustrated how-to guide on the website.

## [0.5.0] - 2026-10-02

### Added

- A herdr plugin (macOS, Linux beta) with an inbox popup, "send latest notes here", a status notification and Ctrl-click on bundle README paths.
- `anynotate inbox`: a keyboard UI to browse, read, re-send and delete bundles, with `--plain` for a simple list.
- `anynotate deliver <id|latest> --pane <id>` sends a bundle to a herdr agent pane.
- `anynotate status [--notify]` prints the health check as one line.

### Changed

- The website has a visual landing page and a two-step install.

## [0.4.1] - 2026-10-01

### Added

- The Chrome Web Store build of the extension can connect to the bridge, alongside the dev build.
- A project website with install steps, the privacy policy and support.

## [0.4.0] - 2026-10-01

### Added

- Self-contained binaries for macOS (arm64, x64), Linux beta (x64, arm64) and Windows beta (x64), with one-line installers that verify checksums and need no admin rights.
- The bridge runs as a background service (launchd on macOS, systemd or autostart on Linux, a login entry on Windows) and registers with Chrome, Edge, Brave and Chromium.
- `anynotate install`, `uninstall` (`--purge` to remove data), `doctor` and `update`, which updates release binaries in place.
- Explain, change and approve intents on annotations, each with its own instruction in the bundle README (protocol 2; older clients still work).
- Bundles are deleted after a retention period, 30 days by default. Change it with `anynotate retention <days|off>` or `ANYNOTATE_RETENTION_DAYS`, or sweep now with `anynotate prune [--dry-run]`.
- Token-only access between the extension and the bridge.
