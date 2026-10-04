import { expect, test } from "bun:test";
import { spawnExec } from "../src/platform/exec";
import { BROWSERS, browserConfigRoot, browserRegistryKey, currentPlatform, exeName, installPaths } from "../src/platform/os";

test("currentPlatform accepts the three supported platforms", () => {
  expect(currentPlatform("darwin")).toBe("darwin");
  expect(currentPlatform("linux")).toBe("linux");
  expect(currentPlatform("win32")).toBe("win32");
});

test("currentPlatform rejects anything else", () => {
  expect(() => currentPlatform("freebsd")).toThrow(/unsupported platform/);
});

test("exeName adds .exe only on Windows", () => {
  expect(exeName("win32")).toBe("anynotate.exe");
  expect(exeName("linux")).toBe("anynotate");
  expect(exeName("darwin")).toBe("anynotate");
});

test("installPaths on linux", () => {
  expect(installPaths("linux", "/home/me", {})).toEqual({
    binDir: "/home/me/.local/bin",
    binPath: "/home/me/.local/bin/anynotate",
    dataDir: "/home/me/.anynotate",
    logPath: "/home/me/.anynotate/bridge.log",
  });
});

test("installPaths on darwin uses the same layout as linux", () => {
  expect(installPaths("darwin", "/home/me", {}).binPath).toBe("/home/me/.local/bin/anynotate");
});

test("installPaths on win32 uses LOCALAPPDATA and backslashes", () => {
  const p = installPaths("win32", "C:\\Users\\me", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
  expect(p.binDir).toBe("C:\\Users\\me\\AppData\\Local\\anynotate\\bin");
  expect(p.binPath).toBe("C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe");
  expect(p.dataDir).toBe("C:\\Users\\me\\.anynotate");
  expect(p.logPath).toBe("C:\\Users\\me\\.anynotate\\bridge.log");
});

test("installPaths on win32 falls back to AppData\\Local without LOCALAPPDATA", () => {
  expect(installPaths("win32", "C:\\Users\\me", {}).binDir).toBe("C:\\Users\\me\\AppData\\Local\\anynotate\\bin");
});

test("installPaths on win32 ignores a blank or relative LOCALAPPDATA", () => {
  for (const LOCALAPPDATA of ["", "   ", "AppData\\Local", ".\\Local"]) {
    expect(installPaths("win32", "C:\\Users\\me", { LOCALAPPDATA }).binDir).toBe("C:\\Users\\me\\AppData\\Local\\anynotate\\bin");
  }
  expect(installPaths("win32", "C:\\Users\\me", { LOCALAPPDATA: "  D:\\Local  " }).binDir).toBe("D:\\Local\\anynotate\\bin");
});

test("installPaths honours an absolute ANYNOTATE_HOME", () => {
  const p = installPaths("linux", "/home/me", { ANYNOTATE_HOME: "/srv/an" });
  expect(p.dataDir).toBe("/srv/an");
  expect(p.logPath).toBe("/srv/an/bridge.log");
});

test("installPaths ignores a relative or blank ANYNOTATE_HOME", () => {
  expect(installPaths("linux", "/home/me", { ANYNOTATE_HOME: "rel/dir" }).dataDir).toBe("/home/me/.anynotate");
  expect(installPaths("linux", "/home/me", { ANYNOTATE_HOME: "   " }).dataDir).toBe("/home/me/.anynotate");
  expect(installPaths("linux", "/home/me", { ANYNOTATE_HOME: "" }).dataDir).toBe("/home/me/.anynotate");
});

test("BROWSERS lists the supported browsers", () => {
  expect([...BROWSERS]).toEqual(["chrome", "edge", "brave", "chromium"]);
});

test("browserConfigRoot on darwin", () => {
  expect(browserConfigRoot("darwin", "brave", "/home/me", {})).toBe(
    "/home/me/Library/Application Support/BraveSoftware/Brave-Browser",
  );
  expect(browserConfigRoot("darwin", "chrome", "/home/me", {})).toBe("/home/me/Library/Application Support/Google/Chrome");
  expect(browserConfigRoot("darwin", "edge", "/home/me", {})).toBe("/home/me/Library/Application Support/Microsoft Edge");
  expect(browserConfigRoot("darwin", "chromium", "/home/me", {})).toBe("/home/me/Library/Application Support/Chromium");
});

test("browserConfigRoot on linux honours XDG_CONFIG_HOME", () => {
  expect(browserConfigRoot("linux", "edge", "/home/me", { XDG_CONFIG_HOME: "/home/me/cfg" })).toBe(
    "/home/me/cfg/microsoft-edge",
  );
  expect(browserConfigRoot("linux", "chrome", "/home/me", {})).toBe("/home/me/.config/google-chrome");
  expect(browserConfigRoot("linux", "chromium", "/home/me", {})).toBe("/home/me/.config/chromium");
});

test("browserConfigRoot ignores a blank or relative XDG_CONFIG_HOME and LOCALAPPDATA", () => {
  for (const XDG_CONFIG_HOME of ["", "  ", "cfg", "./cfg"]) {
    expect(browserConfigRoot("linux", "chrome", "/home/me", { XDG_CONFIG_HOME })).toBe("/home/me/.config/google-chrome");
  }
  for (const LOCALAPPDATA of ["", "  ", "AppData\\Local"]) {
    expect(browserConfigRoot("win32", "chrome", "C:\\Users\\me", { LOCALAPPDATA })).toBe(
      "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data",
    );
  }
});

test("browserConfigRoot on win32", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
  expect(browserConfigRoot("win32", "chrome", "C:\\Users\\me", env)).toBe(
    "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data",
  );
  expect(browserConfigRoot("win32", "edge", "C:\\Users\\me", {})).toBe(
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data",
  );
  expect(browserConfigRoot("win32", "brave", "C:\\Users\\me", env)).toBe(
    "C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data",
  );
});

test("browserRegistryKey", () => {
  expect(browserRegistryKey("edge")).toBe("HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\dev.anynotate.host");
  expect(browserRegistryKey("chrome")).toBe("HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.anynotate.host");
});

test("spawnExec reports a missing binary as 127 without throwing", () => {
  const r = spawnExec(["definitely-not-a-binary-xyz"]);
  expect(r.code).toBe(127);
  expect(r.stderr).not.toBe("");
});

test("spawnExec captures stdout", () => {
  expect(spawnExec([process.execPath, "-e", "console.log(1)"]).stdout.trim()).toBe("1");
});

test.skipIf(process.platform === "win32")("spawnExec stops a command that outlives its timeout and reports 124", () => {
  const started = Date.now();
  const r = spawnExec(["sleep", "5"], undefined, undefined, { timeoutMs: 200 });
  expect(r.code).toBe(124);
  expect(r.stderr).toContain("timed out");
  expect(Date.now() - started).toBeLessThan(4000);
});
