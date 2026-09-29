# Anynotate

Annotate any web page and deliver the notes to a running AI CLI session: Claude Code, Codex, or any agent in a [herdr](https://herdr.dev) pane or able to read a file.

This repository holds the agent side: the local bridge, the `anynotate` CLI, the agent hooks and installer, and the [`@anynotate/protocol`](./packages/protocol) package. The Anynotate Chrome extension isn't publicly available yet; a Chrome Web Store release is planned. Until then you can send bundles by hand (see [Sending a bundle by hand](#sending-a-bundle-by-hand)) or build your own client on [`@anynotate/protocol`](./packages/protocol).

## Requirements

- macOS (Linux and Windows support is planned)
- [Bun](https://bun.sh) 1.3.11 or later
- Claude Code or Codex (optional — any agent that can read a file works)

## Install from source

```bash
git clone https://github.com/genexk/anynotate.git
cd anynotate
bun install
bin/anynotate install --dry-run   # show what would be written
bin/anynotate install             # links ~/.local/bin/anynotate, adds hooks, writes the launchd plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.anynotate.bridge.plist
```

`install --dry-run` lists what would be written to `~/.claude` and `~/.codex` (only if installed), `~/.anynotate/origins`, `~/.local/bin` and the launchd plist; the `launchctl` line starts the bridge.

## Usage

Anynotate has two halves: a bridge on `127.0.0.1` that accepts annotation bundles, and a prompt hook that hands queued bundles to the CLI session they were aimed at.

```bash
anynotate bridge              # run the bridge in the foreground instead (default port 47291)
anynotate token               # print the bridge token (created on first use, mode 600)
anynotate annotations         # list the 10 newest bundles
anynotate annotations latest  # print one bundle's README (or pass an id); a queued bundle becomes delivered
```

`install` adds the prompt hook and `annotations` skill only for CLIs it finds (`claude` / `codex` on `PATH`, or `~/.claude` / `~/.codex`) and logs `skip <cli> (not installed)` for the rest. `install` also removes Gemini CLI hooks left by older Anynotate versions (backup `.bak-anynotate`), and `~/.gemini/commands/annotations.toml` if it is unchanged.

### Any agent

An agent needs no Anynotate-specific setup to receive notes:

- In a herdr pane, any agent herdr detects is listed in the dock, and a bundle sent to it is typed into the pane as the bundle's README path.
- Anywhere else, the agent can read `~/.anynotate/inbox/latest/README.md` (a symlink to the bundle written last) or run `anynotate annotations latest`.

The prompt hooks for Claude Code and Codex are an optional extra: they inject bundles queued for a session on its next prompt.

### Pairing the extension

The bridge only answers browser requests from origins on its allow-list. `anynotate install` adds the Anynotate extension's origin (the ids in `assets/extension-ids.json`) to `~/.anynotate/origins`, so pairing needs only the token. Paste it into the extension's options page:

```bash
anynotate token
```

To manage the allow-list by hand (the bridge reads the file at start):

```bash
anynotate origin add chrome-extension://<id>   # writes ~/.anynotate/origins (mode 600)
anynotate origin list
anynotate origin remove chrome-extension://<id>
launchctl kickstart -k gui/$(id -u)/dev.anynotate.bridge
```

The allow-list is `ANYNOTATE_ALLOWED_ORIGINS` plus `$ANYNOTATE_HOME/origins`; the bridge prints it at startup.

Every bridge route except `GET /health` needs the `X-Anynotate-Token` header. A bundle aimed at a herdr pane (`target.pane`) is typed into that pane once it is idle; anything else is queued and delivered by the hook on the session's next prompt.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `ANYNOTATE_HOME` | `~/.anynotate` | Token, inbox (`$ANYNOTATE_HOME/inbox`) and session state |
| `ANYNOTATE_PORT` | `47291` | Bridge port (always bound to `127.0.0.1`) |
| `ANYNOTATE_ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed to call the bridge, e.g. `chrome-extension://<id>`, in addition to those in `$ANYNOTATE_HOME/origins`. Requests without an `Origin` header need only the token |
| `ANYNOTATE_HERDR` | `herdr` | herdr binary used to list and prompt panes |

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
