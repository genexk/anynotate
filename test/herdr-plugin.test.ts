import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_ID } from "@anynotate/protocol";
import { EXAMPLE_BUNDLE_ID } from "@anynotate/protocol/fixtures";

const repo = join(import.meta.dir, "..");
const pluginDir = join(repo, "integrations", "herdr");
const posix = process.platform !== "win32";
const PLATFORMS = ["linux", "macos"];
const SYSTEM_BINARIES = new Set(["sh"]);

type Command = { command: string[]; platforms?: string[] };
type Manifest = {
  id: string;
  name: string;
  version: string;
  min_herdr_version: string;
  platforms: string[];
  description?: string;
  build: Command[];
  startup: Command[];
  panes: (Command & { id: string; title: string; placement?: string; width?: string | number; height?: string | number })[];
  actions: (Command & { id: string; title: string })[];
  link_handlers: { id: string; title: string; pattern: string; action: string; platforms?: string[] }[];
};

const manifest = Bun.TOML.parse(readFileSync(join(pluginDir, "herdr-plugin.toml"), "utf8")) as Manifest;
const allCommands = (): Command[] => [...manifest.build, ...manifest.startup, ...manifest.panes, ...manifest.actions];
const linkPattern = new RegExp(manifest.link_handlers[0]!.pattern);

describe("herdr plugin manifest", () => {
  test("has the required top-level keys", () => {
    expect(manifest.id).toBe("anynotate");
    expect(manifest.name).toBe("Anynotate");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.min_herdr_version).toBe("0.9.0");
    expect([...manifest.platforms].sort()).toEqual(PLATFORMS);
    expect(manifest.description?.length).toBeGreaterThan(20);
  });

  test("declares the inbox popup, the actions and the link handler", () => {
    expect(manifest.panes.map((p) => p.id)).toEqual(["inbox"]);
    const inbox = manifest.panes[0]!;
    expect(inbox).toMatchObject({ title: "Anynotate inbox", placement: "popup", width: "80%", height: "70%" });
    expect(inbox.command).toEqual(["bin/anynotate-plugin", "inbox-pane"]);

    const actions = Object.fromEntries(manifest.actions.map((a) => [a.id, a.command]));
    expect(actions).toEqual({
      "open-inbox": ["bin/anynotate-plugin", "open-inbox"],
      "send-latest-here": ["bin/anynotate-plugin", "send-here"],
      status: ["bin/anynotate-run", "status", "--notify"],
      "open-bundle": ["bin/anynotate-plugin", "open-link"],
    });
    for (const handler of manifest.link_handlers) {
      expect(manifest.actions.some((a) => a.id === handler.action)).toBe(true);
    }
  });

  test("ids are unique and local (no dots)", () => {
    for (const ids of [manifest.actions.map((a) => a.id), manifest.panes.map((p) => p.id), manifest.link_handlers.map((h) => h.id)]) {
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_:-]+$/);
    }
  });

  test("build and startup cover every platform exactly once", () => {
    for (const hooks of [manifest.build, manifest.startup]) {
      const covered = hooks.flatMap((h) => h.platforms ?? PLATFORMS).sort();
      expect(covered).toEqual(PLATFORMS);
    }
    expect(manifest.build.map((b) => b.command)).toEqual([["sh", "build.sh"]]);
    expect(manifest.startup.map((s) => s.command)).toEqual([["bin/anynotate-run", "bridge", "--ensure"]]);
  });

  test("every entry is limited to macOS and Linux", () => {
    for (const entry of [...allCommands(), ...manifest.link_handlers]) {
      expect(entry.platforms).toEqual(PLATFORMS);
    }
  });

  test("no command refers to a Windows script", () => {
    for (const { command } of allCommands()) {
      expect(command.join(" ")).not.toMatch(/powershell|\.ps1|\.cmd/);
    }
  });

  test("every command refers to a file in the plugin or a system binary", () => {
    for (const { command } of allCommands()) {
      const [program, ...args] = command;
      expect(program).toBeDefined();
      if (SYSTEM_BINARIES.has(program!)) {
        expect(existsSync(join(pluginDir, args[0]!))).toBe(true);
        continue;
      }
      expect(existsSync(join(pluginDir, program!))).toBe(true);
    }
  });

  test(".cmd shims forward every argument to their .ps1", () => {
    for (const name of ["anynotate-run", "anynotate-plugin"]) {
      const cmd = readFileSync(join(pluginDir, "bin", `${name}.cmd`), "utf8");
      expect(cmd).toContain(`-File "%~dp0${name}.ps1" %*`);
      expect(cmd).toContain("exit /b %ERRORLEVEL%");
    }
  });
});

describe("bundle link handler", () => {
  const id = EXAMPLE_BUNDLE_ID;

  test("uses the protocol's bundle id format", () => {
    expect(BUNDLE_ID.test(id)).toBe(true);
    expect(manifest.link_handlers[0]!.pattern).toContain(BUNDLE_ID.source.slice(1, -1).replaceAll("\\d", "[0-9]"));
  });

  test("spells digits as [0-9] so herdr's Unicode-aware Rust regex only takes ASCII digits", () => {
    expect(manifest.link_handlers[0]!.pattern).not.toContain("\\d");
  });

  test.each([
    `~/.anynotate/inbox/${id}/README.md`,
    `/home/me/.anynotate/inbox/${id}/README.md`,
    `/Users/me/.anynotate/inbox/${id}/README.md`,
    `file:///home/me/.anynotate/inbox/${id}/README.md`,
    `C:\\Users\\me\\.anynotate\\inbox\\${id}\\README.md`,
    `C:/Users/me/.anynotate/inbox/${id}/README.md`,
    `~\\.anynotate\\inbox\\${id}\\README.md`,
  ])("matches %s", (path) => {
    expect(linkPattern.test(path)).toBe(true);
  });

  test.each([
    `/home/me/.anynotate/inbox/${id}/page.md`,
    `/home/me/.anynotate/inbox/${id}/README.md.bak`,
    `/home/me/anynotate/inbox/${id}/README.md`,
    `/home/me/.anynotate/outbox/${id}/README.md`,
    `/home/me/.anynotate/inbox/not-a-bundle/README.md`,
    `/home/me/.anynotate/inbox/${id.toUpperCase()}/README.md`,
    `/home/me/.anynotate/inbox/README.md`,
    `/home/me/my notes/.anynotate/inbox/${id}/README.md`,
    `see /home/me/.anynotate/inbox/${id}/README.md`,
    "README.md",
  ])("rejects %s", (path) => {
    expect(linkPattern.test(path)).toBe(false);
  });
});

describe.skipIf(!posix)("plugin scripts", () => {
  const SCRIPTS = ["build.sh", "bin/anynotate-run", "bin/anynotate-plugin"];
  const SEP = "\u001f";
  // Each fake appends one line per call: its name, then its arguments, separated by SEP.
  const recorder = (name: string, body = "") =>
    `#!/bin/sh\n{ printf '%s' ${name}; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; } >> "$RECORD"\n${body}`;

  let tmp: string;
  let home: string;
  let fakebin: string;
  let record: string;
  let herdr: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "anynotate-herdr-plugin-"));
    home = join(tmp, "home");
    fakebin = join(tmp, "fakebin");
    record = join(tmp, "record");
    herdr = join(tmp, "herdr");
    mkdirSync(home);
    mkdirSync(fakebin);
    writeFileSync(record, "");
    writeExe(herdr, recorder("herdr"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeExe(path: string, content: string) {
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }

  function fakeAnynotate(dir = fakebin, body = "") {
    mkdirSync(dir, { recursive: true });
    writeExe(join(dir, "anynotate"), recorder(dir === fakebin ? "anynotate" : `anynotate@${dir}`, body));
  }

  function run(script: string, args: string[], env: Record<string, string> = {}) {
    return spawnSync(join(pluginDir, script), args, {
      cwd: pluginDir,
      encoding: "utf8",
      env: { PATH: `${fakebin}:/usr/bin:/bin`, HOME: home, RECORD: record, HERDR_BIN_PATH: herdr, ...env },
    });
  }

  function calls(): string[][] {
    return readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => line.split(SEP));
  }

  test.each(SCRIPTS)("%s passes sh -n", (script) => {
    const result = spawnSync("sh", ["-n", join(pluginDir, script)], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  test.each(SCRIPTS)("%s is executable", (script) => {
    const result = spawnSync("test", ["-x", join(pluginDir, script)]);
    expect(result.status).toBe(0);
  });

  describe("anynotate-run", () => {
    test("forwards every argument unchanged to anynotate on PATH", () => {
      fakeAnynotate(fakebin, "exit 7\n");
      const result = run("bin/anynotate-run", ["deliver", "latest", "--pane", "a b", "", "--x=$HOME"]);
      expect(result.status).toBe(7);
      expect(calls()).toEqual([["anynotate", "deliver", "latest", "--pane", "a b", "", "--x=$HOME"]]);
    });

    test("prefers ~/.local/bin over PATH, and ANYNOTATE_BIN_DIR over both", () => {
      fakeAnynotate();
      const local = join(home, ".local", "bin");
      fakeAnynotate(local);
      run("bin/anynotate-run", ["doctor"]);
      const custom = join(tmp, "custom");
      fakeAnynotate(custom);
      run("bin/anynotate-run", ["doctor"], { ANYNOTATE_BIN_DIR: custom });
      expect(calls()).toEqual([[`anynotate@${local}`, "doctor"], [`anynotate@${custom}`, "doctor"]]);
      expect(run("bin/anynotate-run", ["--locate"]).stdout.trim()).toBe(join(local, "anynotate"));
    });

    test("fails with exit 127 and a notification when anynotate is missing", () => {
      const result = run("bin/anynotate-run", ["status"]);
      expect(result.status).toBe(127);
      expect(result.stderr).toContain("anynotate is not installed");
      const [call] = calls();
      expect(call?.slice(0, 4)).toEqual(["herdr", "notification", "show", "Anynotate"]);
      expect(call?.[5]).toContain("install.sh");
    });

    test("--locate fails quietly when anynotate is missing", () => {
      const result = run("bin/anynotate-run", ["--locate"]);
      expect(result.status).toBe(127);
      expect(result.stdout).toBe("");
      expect(calls()).toEqual([]);
    });
  });

  describe("anynotate-plugin send-here", () => {
    const context = JSON.stringify({ workspace_id: "w1", focused_pane_id: "w1-p2", focused_pane_cwd: "/home/me/project", selected_text: "x" });

    test("delivers the latest note to the focused pane from the context JSON and notifies the result", () => {
      fakeAnynotate(fakebin, "echo 'note delivered'\necho\n");
      const result = run("bin/anynotate-plugin", ["send-here"], { HERDR_PLUGIN_CONTEXT_JSON: context, HERDR_PANE_ID: "w9-p9" });
      expect(result.status).toBe(0);
      expect(calls()).toEqual([
        ["anynotate", "deliver", "latest", "--pane", "w1-p2"],
        ["herdr", "notification", "show", "Anynotate", "--body", "note delivered"],
      ]);
    });

    test("falls back to HERDR_PANE_ID and to a generic message", () => {
      fakeAnynotate();
      run("bin/anynotate-plugin", ["send-here"], { HERDR_PLUGIN_CONTEXT_JSON: "{}", HERDR_PANE_ID: "w3-p1" });
      expect(calls()).toEqual([
        ["anynotate", "deliver", "latest", "--pane", "w3-p1"],
        ["herdr", "notification", "show", "Anynotate", "--body", "Sent the latest note to pane w3-p1."],
      ]);
    });

    test("passes on deliver's failure and its error message", () => {
      fakeAnynotate(fakebin, "echo 'anynotate: pane w1-p2 is not an agent pane' >&2\nexit 3\n");
      const result = run("bin/anynotate-plugin", ["send-here"], { HERDR_PLUGIN_CONTEXT_JSON: context });
      expect(result.status).toBe(3);
      expect(calls()[1]).toEqual(["herdr", "notification", "show", "Anynotate", "--body", "anynotate: pane w1-p2 is not an agent pane"]);
    });

    test("refuses without a usable pane id", () => {
      fakeAnynotate();
      const bad = JSON.stringify({ focused_pane_id: "w1; rm -rf /" });
      const envs: Record<string, string>[] = [
        {},
        { HERDR_PLUGIN_CONTEXT_JSON: bad },
        { HERDR_PANE_ID: "w1:p2\nw1:p3" },
        { HERDR_PANE_ID: "w1:p2\n--dry-run" },
        { HERDR_PANE_ID: "-w1" },
        { HERDR_PANE_ID: ".w1" },
        { HERDR_PANE_ID: "w\u00e91" },
        { HERDR_PANE_ID: "w\u0661" },
      ];
      for (const env of envs) {
        writeFileSync(record, "");
        const result = run("bin/anynotate-plugin", ["send-here"], env);
        expect(result.status).toBe(1);
        expect(calls()).toEqual([["herdr", "notification", "show", "Anynotate", "--body", "No focused pane to send the latest note to."]]);
      }
    });
  });

  test("send-here shows exactly one notification when anynotate is missing", () => {
    const result = run("bin/anynotate-plugin", ["send-here"], { HERDR_PANE_ID: "w1:p2" });
    expect(result.status).toBe(127);
    const notes = calls().filter((c) => c[0] === "herdr");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.slice(0, 5)).toEqual(["herdr", "notification", "show", "Anynotate", "--body"]);
    expect(notes[0]![5]).toContain("anynotate is not installed");
  });

  describe("anynotate-plugin inbox", () => {
    const id = EXAMPLE_BUNDLE_ID;
    const paneOpen = ["herdr", "plugin", "pane", "open", "--plugin", "anynotate", "--entrypoint", "inbox", "--cwd", pluginDir];

    test("open-inbox opens the plugin's popup", () => {
      const result = run("bin/anynotate-plugin", ["open-inbox"], { HERDR_PLUGIN_ID: "anynotate" });
      expect(result.status).toBe(0);
      expect(calls()).toEqual([paneOpen]);
    });

    test.each([
      `/home/me/.anynotate/inbox/${id}/README.md`,
      `~/.anynotate/inbox/${id}/README.md`,
      `file:///home/me/.anynotate/inbox/${id}/README.md`,
      `C:\\Users\\me\\.anynotate\\inbox\\${id}\\README.md`,
    ])("open-link opens the popup on the bundle in %s", (url) => {
      const result = run("bin/anynotate-plugin", ["open-link"], { HERDR_PLUGIN_CLICKED_URL: url });
      expect(result.status).toBe(0);
      expect(calls()).toEqual([[...paneOpen, "--env", `ANYNOTATE_INBOX_SELECT=${id}`]]);
    });

    test.each([
      "/home/me/.anynotate/inbox/nope/README.md",
      `/home/me/.anynotate/inbox/${id}\nevil/README.md`,
      `/home/me/.anynotate/inbox/${id}x\n/README.md`,
      `/home/me/.anynotate/inbox/${id.toUpperCase()}/README.md`,
    ])("open-link refuses %j without echoing it", (url) => {
      const result = run("bin/anynotate-plugin", ["open-link"], { HERDR_PLUGIN_CLICKED_URL: url });
      expect(result.status).toBe(1);
      expect(calls()).toEqual([["herdr", "notification", "show", "Anynotate", "--body", "That link is not an Anynotate bundle README."]]);
    });

    test("inbox-pane selects the bundle handed over by open-link", () => {
      fakeAnynotate();
      run("bin/anynotate-plugin", ["inbox-pane"], { ANYNOTATE_INBOX_SELECT: id });
      run("bin/anynotate-plugin", ["inbox-pane"], { ANYNOTATE_INBOX_SELECT: "../../etc" });
      run("bin/anynotate-plugin", ["inbox-pane"], { ANYNOTATE_INBOX_SELECT: `${id}\n--plain` });
      run("bin/anynotate-plugin", ["inbox-pane"]);
      expect(calls()).toEqual([["anynotate", "inbox", "--select", id], ["anynotate", "inbox"], ["anynotate", "inbox"], ["anynotate", "inbox"]]);
    });

    test("an unknown subcommand prints usage", () => {
      const result = run("bin/anynotate-plugin", ["bogus"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage: anynotate-plugin");
    });
  });

  describe("build.sh with anynotate already installed", () => {
    const versionBody = (version: string) => `[ "$1" = --version ] && echo ${version}\nexit 0\n`;

    test("runs anynotate install when the installed version is current", () => {
      fakeAnynotate(join(home, ".local", "bin"), versionBody(manifest.version));
      const result = run("build.sh", []);
      expect(result.status).toBe(0);
      const local = `anynotate@${join(home, ".local", "bin")}`;
      expect(calls()).toEqual([[local, "--version"], [local, "install"]]);
    });

    const upgradingBody = (updateWorks: boolean, after: string) =>
      `marker="$HOME/.anynotate-updated"\n` +
      `if [ "$1" = --version ]; then if [ -f "$marker" ]; then echo ${after}; else echo 0.4.1; fi; exit 0; fi\n` +
      `if [ "$1" = update ]; then ${updateWorks ? 'touch "$marker"; exit 0' : "exit 1"}; fi\n` +
      `exit 0\n`;

    test("updates an older anynotate before installing", () => {
      fakeAnynotate(fakebin, upgradingBody(true, manifest.version));
      const result = run("build.sh", []);
      expect(result.status).toBe(0);
      expect(calls()).toEqual([["anynotate", "--version"], ["anynotate", "update"], ["anynotate", "--version"], ["anynotate", "install"]]);
    });

    test("fails the build, without installing, when the update fails", () => {
      fakeAnynotate(fakebin, upgradingBody(false, manifest.version));
      const result = run("build.sh", []);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("update` failed");
      expect(calls()).toEqual([["anynotate", "--version"], ["anynotate", "update"]]);
    });

    test("fails the build when anynotate is still too old after updating", () => {
      fakeAnynotate(fakebin, upgradingBody(true, "0.4.1"));
      const result = run("build.sh", []);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("still 0.4.1 after updating");
      expect(calls()).toEqual([["anynotate", "--version"], ["anynotate", "update"], ["anynotate", "--version"]]);
    });

    test("does not update a newer anynotate", () => {
      fakeAnynotate(fakebin, versionBody("1.0.0"));
      run("build.sh", []);
      expect(calls()).toEqual([["anynotate", "--version"], ["anynotate", "install"]]);
    });

    test("fails with a clear message when anynotate install fails", () => {
      fakeAnynotate(fakebin, `[ "$1" = --version ] && echo ${manifest.version} && exit 0\nexit 1\n`);
      const result = run("build.sh", []);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("anynotate plugin build failed");
    });
  });
  describe("build.sh with anynotate missing", () => {
    const URL = "https://github.com/genexk/anynotate/releases/latest/download/install.sh";
    const installerBody = (name: string) =>
      recorder(name, 'mkdir -p "$HOME/.local/bin"\nprintf \'#!/bin/sh\\nexit 0\\n\' > "$HOME/.local/bin/anynotate"\nchmod +x "$HOME/.local/bin/anynotate"\n');

    function copyPlugin(dest: string): string {
      mkdirSync(dest, { recursive: true });
      for (const f of ["build.sh", "herdr-plugin.toml", "bin"]) cpSync(join(pluginDir, f), join(dest, f), { recursive: true });
      return dest;
    }

    function build(plugin: string, path = `${fakebin}:/usr/bin:/bin`) {
      return spawnSync(join(plugin, "build.sh"), [], {
        cwd: plugin,
        encoding: "utf8",
        env: { PATH: path, HOME: home, RECORD: record },
      });
    }

    function fakeDownloader(name: "curl" | "wget", help = "") {
      writeExe(
        join(fakebin, name),
        recorder(
          name,
          `${help ? `[ "$1" = --help ] && { echo '${help}'; exit 0; }\n` : ""}o=""\nwhile [ $# -gt 0 ]; do case $1 in -o|-O) o=$2; shift ;; esac; shift; done\ncat > "$o" <<'EOF'\n${installerBody("downloaded-installer")}\nEOF\n`,
        ),
      );
    }

    test("runs the installer from the anynotate checkout it was cloned with", () => {
      const repoCopy = join(tmp, "repo");
      const plugin = copyPlugin(join(repoCopy, "integrations", "herdr"));
      mkdirSync(join(repoCopy, "scripts"));
      writeExe(join(repoCopy, "scripts", "install.sh"), installerBody("checkout-installer"));
      fakeDownloader("curl");
      const result = build(plugin);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(calls()).toEqual([["checkout-installer"]]);
      expect(result.stdout).toContain("ready");
    });

    test("downloads the installer when ../../integrations/herdr is not this plugin", () => {
      const elsewhere = join(tmp, "elsewhere");
      const plugin = copyPlugin(join(elsewhere, "plugins", "herdr"));
      mkdirSync(join(elsewhere, "scripts"));
      writeExe(join(elsewhere, "scripts", "install.sh"), installerBody("planted-installer"));
      fakeDownloader("curl");
      const result = build(plugin);
      expect(result.status).toBe(0);
      const [curl, installer] = calls();
      expect(curl![0]).toBe("curl");
      expect(curl).toContain("=https");
      expect(curl!.at(-1)).toBe(URL);
      expect(installer).toEqual(["downloaded-installer"]);
      expect(calls().some((c) => c[0] === "planted-installer")).toBe(false);
    });

    test("downloads the installer with curl when the checkout has none", () => {
      const plugin = copyPlugin(join(tmp, "lone", "herdr"));
      fakeDownloader("curl");
      const result = build(plugin);
      expect(result.status).toBe(0);
      expect(calls().map((c) => c[0])).toEqual(["curl", "downloaded-installer"]);
    });

    test("falls back to wget, with --https-only when it supports it", () => {
      const plugin = copyPlugin(join(tmp, "lone", "herdr"));
      const tools = join(tmp, "tools");
      mkdirSync(tools);
      for (const tool of ["sh", "sed", "head", "mktemp", "rm", "dirname", "grep", "cat", "mkdir", "chmod"]) {
        const at = Bun.which(tool, { PATH: "/usr/bin:/bin" });
        if (at) symlinkSync(at, join(tools, tool));
      }
      fakeDownloader("wget", "  --https-only   only follow secure HTTPS links");
      const result = build(plugin, `${fakebin}:${tools}`);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const download = calls().find((c) => c[0] === "wget" && c[1] !== "--help");
      expect(download).toEqual(["wget", "-q", "--https-only", "-O", download![4]!, URL]);
      expect(calls().at(-1)).toEqual(["downloaded-installer"]);

      writeFileSync(record, "");
      rmSync(join(home, ".local"), { recursive: true, force: true });
      fakeDownloader("wget", "an old wget");
      expect(build(plugin, `${fakebin}:${tools}`).status).toBe(0);
      expect(calls().find((c) => c[0] === "wget" && c[1] !== "--help")?.slice(0, 3)).toEqual(["wget", "-q", "-O"]);
    });

    test("fails clearly when the installer leaves no anynotate behind", () => {
      const plugin = copyPlugin(join(tmp, "lone", "herdr"));
      writeExe(join(fakebin, "curl"), recorder("curl", 'o=""\nwhile [ $# -gt 0 ]; do case $1 in -o) o=$2; shift ;; esac; shift; done\nprintf \'exit 0\\n\' > "$o"\n'));
      const result = build(plugin);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("anynotate was not found");
    });
  });
});
