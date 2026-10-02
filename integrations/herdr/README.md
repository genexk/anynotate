# Anynotate for herdr

A [herdr](https://herdr.dev) plugin (herdr 0.9.0 or newer, on macOS and Linux) that brings your Anynotate browser notes into herdr: an inbox popup, a one-key "send the latest note to this agent", a status check, and Ctrl-click on a bundle's `README.md` path to open it in the inbox.

## Install

Windows support for the plugin is coming. `build.ps1` and the `.ps1`/`.cmd` scripts in `bin/` are a start on it: they are untested and the manifest does not use them.

```sh
herdr plugin install genexk/anynotate/integrations/herdr
```

herdr shows a preview of the build and startup commands; confirm it. The build step:

- if `anynotate` is already installed (`~/.local/bin/anynotate`, or on `PATH`), runs `anynotate update` when it is older than the plugin, then `anynotate install`;
- otherwise runs the Anynotate installer (`scripts/install.sh` from the same checkout herdr just cloned), which downloads the release binary, verifies its checksum and runs `anynotate install`.

If the build fails, herdr does not register the plugin; fix the problem the build printed and run the install command again. There is no update command for herdr plugins: run the install command again to get a newer version.

When the herdr server starts, the plugin runs `anynotate bridge --ensure`: it starts the bridge only if none answers and no launchd or systemd service from `anynotate install` is there to run it.

## Actions

herdr has no command palette, so actions run from a key you bind (below), from `herdr plugin action invoke <id>`, or from a link click.

| Action | What it does |
|---|---|
| `anynotate.open-inbox` | Opens the inbox in a popup: browse recent bundles, read them, send one to an agent pane, delete. |
| `anynotate.send-latest-here` | Delivers the newest bundle to the focused pane (it must be an agent pane) with `anynotate deliver latest --pane <pane>`, and shows the result as a herdr notification. |
| `anynotate.status` | Runs `anynotate status --notify`: a one-line health check (bridge, browser hosts, agent hooks) as a notification. |
| `anynotate.open-bundle` | Used by the link handler: Ctrl-click a path like `~/.anynotate/inbox/<bundle-id>/README.md` in any pane to open the inbox on that bundle. |

The link handler only recognises bundles under a directory named `.anynotate`; if you moved the data directory with `ANYNOTATE_HOME`, Ctrl-click will not pick those paths up.

## Keybindings

The plugin binds nothing by itself. Add these to herdr's `config.toml` (`~/.config/herdr/config.toml`) and reload the config:

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

Both go through herdr's prefix key, so they never reach the program running in a pane. `prefix+i` and `prefix+y` are not used by herdr 0.9's default bindings; if you or another plugin already use them, pick other keys (`herdr config check` reports problems). Bind `anynotate.status` the same way if you want it on a key.

## Uninstall

```sh
herdr plugin uninstall anynotate
```

This removes only the plugin. Anynotate itself stays installed; remove it with `anynotate uninstall`.
