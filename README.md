# Anynotate

Annotate any web page and deliver the notes to a running AI CLI session: Claude Code, Codex, or any agent in a [herdr](https://herdr.dev) pane or able to read a file.

Website: [genexk.github.io/anynotate](https://genexk.github.io/anynotate/) ([support](https://genexk.github.io/anynotate/support/), [privacy policy](https://genexk.github.io/anynotate/privacy/)).

This repository holds the agent side: the local bridge, the `anynotate` CLI, the agent hooks and installer, and the [`@anynotate/protocol`](./packages/protocol) package. The Anynotate Chrome extension isn't publicly available yet; a Chrome Web Store release is planned. Until then you can send bundles by hand (see [Sending a bundle by hand](#sending-a-bundle-by-hand)) or build your own client on [`@anynotate/protocol`](./packages/protocol).

## Install

macOS and Linux:

```bash
curl -fsSL https://github.com/genexk/anynotate/releases/latest/download/install.sh | sh
```

Windows (PowerShell 5.1 or later):

```powershell
irm https://github.com/genexk/anynotate/releases/latest/download/install.ps1 | iex
```

The installer downloads the release binary for your machine (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` or `windows-x64`), checks it against the release's `SHA256SUMS`, puts it in place and runs `anynotate install`. It needs no root or administrator rights. Set `ANYNOTATE_VERSION=0.4.0` to pin a release, or `ANYNOTATE_BIN_DIR` to install elsewhere.

`anynotate install` (re-run it any time; it also restarts the bridge) writes:

| | macOS | Linux | Windows |
|---|---|---|---|
| Binary | `~/.local/bin/anynotate` | `~/.local/bin/anynotate` | `%LOCALAPPDATA%\anynotate\bin\anynotate.exe`, added to the user `PATH` |
| Bridge service | launchd agent `~/Library/LaunchAgents/dev.anynotate.bridge.plist` | systemd user unit `~/.config/systemd/user/anynotate-bridge.service`; without user systemd, `~/.config/autostart/anynotate-bridge.desktop` running `anynotate bridge --detach` | `HKCU\…\CurrentVersion\Run` value `Anynotate Bridge` starting `~\.anynotate\bridge.vbs`, which runs `anynotate bridge --detach` |
| Chrome helper | `dev.anynotate.host.json` in each browser's `NativeMessagingHosts` dir | same, under `~/.config` | `~\.anynotate\dev.anynotate.host.json`, registered under `HKCU\Software\<browser>\NativeMessagingHosts` |
| Data | `~/.anynotate` (token, origins, inbox, `install.json`) | same | `%USERPROFILE%\.anynotate` |

The Chrome helper is registered for Chrome, plus Edge, Brave and Chromium (on macOS and Linux, those that are installed). For Claude Code and Codex, when found, it also adds a prompt hook to `~/.claude/settings.json` / `~/.codex/hooks.json` and an `annotations` skill; hooks and services name the binary by absolute path. `anynotate install --dry-run` lists every step without writing anything.

If `~/.local/bin` is not on your `PATH`, the installer says so; add it in your shell profile (`export PATH="$HOME/.local/bin:$PATH"`). On Windows, open a new terminal after installing to pick up the `PATH` change.

### Check, update, remove

```bash
anynotate doctor               # install, PATH, service, bridge /health, token, Chrome helper, hooks, retention
anynotate update --dry-run     # show what an update would do
anynotate update               # install the latest release and restart the bridge
anynotate uninstall --dry-run
anynotate uninstall            # add --purge to delete ~/.anynotate (your notes) as well
```

`doctor` exits non-zero only when a required check fails. `update` downloads the newest release for your platform from GitHub, verifies it against `SHA256SUMS`, replaces the binary and re-runs `install`; on Windows the running binary is moved aside to `anynotate.exe.old`. `uninstall` stops the bridge and removes the service, the Chrome helper registrations, the hooks and skills (a `SKILL.md` you edited is kept), and the binary (on Windows it also takes the bin directory off the user `PATH`). It keeps `~/.anynotate` unless you pass `--purge`.

### Install from source (development)

Needs [Bun](https://bun.sh) 1.3.11 or later.

```bash
git clone https://github.com/genexk/anynotate.git
cd anynotate
bun install
bin/anynotate install --dry-run   # show what would be written
bin/anynotate install
```

A source install sets up the same service, hooks and Chrome helper, but links `~/.local/bin/anynotate` to the clone (on Windows an `anynotate.cmd` shim in `%LOCALAPPDATA%\anynotate\bin`, which `install` adds to the user `PATH` and `uninstall` removes; open a new terminal afterwards) and starts the helper through a `~/.anynotate/native-host` wrapper (`native-host.cmd` on Windows) that runs the CLI under Bun. Here `anynotate update` pulls the clone (`git pull --ff-only`), runs `bun install` and re-runs `install`; it needs a clean clone on `main` and otherwise refuses and changes nothing. Release binaries are built with `bun run build:binaries` (into `dist/bin`, with `SHA256SUMS`).

## Usage

Anynotate has two halves: a bridge on `127.0.0.1` that accepts annotation bundles, and a prompt hook that hands queued bundles to the CLI session they were aimed at.

```bash
anynotate bridge              # run the bridge in the foreground instead (default port 47291)
anynotate token               # print the bridge token (created on first use, mode 600)
anynotate annotations         # list the 10 newest bundles
anynotate annotations latest  # print one bundle's README (or pass an id); a queued bundle becomes delivered
anynotate inbox               # browse bundles: read, send to a herdr pane, delete (--plain prints a list)
anynotate deliver latest --pane <pane_id>   # type a bundle (or pass an id) into a herdr agent pane; --dry-run to preview
anynotate status              # one-line health summary; --notify shows it as a herdr notification
```

`install` adds the prompt hook and `annotations` skill only for CLIs it finds (`claude` / `codex` on `PATH`, or `~/.claude` / `~/.codex`) and logs `skip <cli> (not installed)` for the rest. `install` also removes Gemini CLI hooks left by older Anynotate versions (backup `.bak-anynotate`), and `~/.gemini/commands/annotations.toml` if it is unchanged.

### Any agent

An agent needs no Anynotate-specific setup to receive notes:

- In a herdr pane, any agent herdr detects is listed in the dock, and a bundle sent to it is typed into the pane as the bundle's README path.
- Anywhere else, the agent can read `~/.anynotate/inbox/latest/README.md` or run `anynotate annotations latest`. `inbox/latest` is a symlink to the bundle written last (a junction on Windows); `inbox/latest-id` holds that bundle's id, for when the link can't be created or followed.

The prompt hooks for Claude Code and Codex are an optional extra: they inject bundles queued for a session on its next prompt.

### herdr plugin

```bash
herdr plugin install genexk/anynotate/integrations/herdr   # herdr 0.9.0 or later; installs Anynotate too if needed
```

On macOS and Linux (Windows support for the plugin is coming), it adds an inbox popup (`anynotate inbox`), an action that sends the latest notes to the focused agent pane, a status check shown as a herdr notification, and Ctrl-click on a bundle's `README.md` path in any pane to open it in the inbox. It also starts the bridge with the herdr server. The plugin binds no keys; add these to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+i"
type = "plugin_action"
command = "anynotate.open-inbox"
description = "Anynotate inbox"

[[keys.command]]
key = "prefix+y"
type = "plugin_action"
command = "anynotate.send-latest-here"
description = "send the latest browser note to this agent"
```

See [integrations/herdr](./integrations/herdr/README.md) for every action, the link handler and uninstalling.

### Extension access

The Anynotate extension needs no copy-paste or pairing: `anynotate install` adds its id to `~/.anynotate/origins` and sets up a small Chrome helper (a native messaging host, `dev.anynotate.host`) that Chrome starts only for allow-listed extension ids. The extension fetches the token from that helper itself and sends it as `X-Anynotate-Token`, like every other caller. `anynotate token` prints the same token for the CLI and scripts. A development build of the extension has its own id; allow it with `anynotate origin add`, then re-run `anynotate install` so the helper allows it too. If the extension reports it can't reach the helper after you delete `~/.anynotate/token`, restart the bridge by re-running `anynotate install`.

To manage the allow-list by hand (the bridge reads the file at start, so re-run `anynotate install` afterwards to restart it):

```bash
anynotate origin add chrome-extension://<id>   # writes ~/.anynotate/origins (mode 600)
anynotate origin list
anynotate origin remove chrome-extension://<id>
```

The allow-list is the valid `chrome-extension://` entries from `ANYNOTATE_ALLOWED_ORIGINS` and `$ANYNOTATE_HOME/origins`; the bridge prints it at startup.

Every caller, the extension included, sends `X-Anynotate-Token: <anynotate token>` on every route except `/health`; an allow-listed `Origin` only earns CORS headers, since any local process can forge one. A bundle aimed at a herdr pane (`target.pane`) is typed into that pane once it is idle; anything else is queued and delivered by the hook on the session's next prompt.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `ANYNOTATE_HOME` | `~/.anynotate` | Token, inbox (`$ANYNOTATE_HOME/inbox`) and session state. Must be an absolute path; a blank or relative value is ignored. The Chrome helper always uses `~/.anynotate`; with a custom `ANYNOTATE_HOME` the extension cannot get the bridge's token |
| `ANYNOTATE_PORT` | `47291` | Bridge port (always bound to `127.0.0.1`) |
| `ANYNOTATE_ALLOWED_ORIGINS` | none | Comma-separated `chrome-extension://<id>` origins added to the allow-list, in addition to those in `$ANYNOTATE_HOME/origins`; other entries are ignored. An allowed origin gets CORS headers; the token is still required |
| `ANYNOTATE_HERDR` | `herdr` | herdr binary used to list and prompt panes |
| `ANYNOTATE_RETENTION_DAYS` | `30` | Days to keep a bundle, or `off`. Overrides `retentionDays` in `$ANYNOTATE_HOME/settings.json` |

### Retention

Bundles can hold sensitive screenshots, so the bridge deletes each one 30 days after it was delivered (or created, if it never was), at start and hourly, in both `inbox/` and `archive/`. Bundles with a delivery in progress are left alone.

```bash
anynotate retention            # show the setting and where it comes from
anynotate retention 7          # or `off`; writes ~/.anynotate/settings.json (mode 600)
anynotate prune --dry-run      # list what a sweep would delete; drop --dry-run to delete now
```

### Sending a bundle by hand

Build a bundle from the test fixture, aimed at a pane from `herdr agent list`:

```bash
bun -e 'import {sampleInput} from "./test/fixtures/sample.ts"; console.log(JSON.stringify(sampleInput))' \
  | jq --arg a codex --arg p '<pane_id>' '.target={agent:$a,pane:$p}' > sample-bundle.json

curl -s -H "X-Anynotate-Token: $(anynotate token)" \
  -F bundle=@sample-bundle.json -F page.md=@README.md \
  http://127.0.0.1:47291/bundles
```

Drop `pane` and set `cwd` to an open Claude session's directory instead (`.target={agent:"claude",cwd:"/path/to/repo"}`) to exercise the hook path: the bundle is queued and injected on that session's next prompt.

## License

Copyright 2026 Kun Xu.

AGPL-3.0-only (see [LICENSE](./LICENSE)), except [`packages/protocol`](./packages/protocol), which is Apache-2.0. Contributions require the [CLA](./CLA.md); see [CONTRIBUTING.md](./CONTRIBUTING.md).
