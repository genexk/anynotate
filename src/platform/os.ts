import { posix, win32 } from "node:path";

export type Platform = "darwin" | "linux" | "win32";
export type Env = Record<string, string | undefined>;

export function currentPlatform(p: string = process.platform): Platform {
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  throw new Error(`anynotate: unsupported platform ${JSON.stringify(p)}`);
}

export const exeName = (p: Platform) => (p === "win32" ? "anynotate.exe" : "anynotate");

// Paths are built with the target platform's separator regardless of the host, so callers and tests are host-independent.
const pathFor = (p: Platform) => (p === "win32" ? win32 : posix);

const localAppData = (home: string, env: Env) => env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local");

export type InstallPaths = { binDir: string; binPath: string; dataDir: string; logPath: string };

// dataDir follows anynotateHome(): an absolute, non-blank ANYNOTATE_HOME wins, otherwise ~/.anynotate.
export function installPaths(p: Platform, home: string, env: Env): InstallPaths {
  const path = pathFor(p);
  const binDir = p === "win32" ? win32.join(localAppData(home, env), "anynotate", "bin") : posix.join(home, ".local", "bin");
  const override = env.ANYNOTATE_HOME?.trim();
  const dataDir = override && path.isAbsolute(override) ? override : path.join(home, ".anynotate");
  return { binDir, binPath: path.join(binDir, exeName(p)), dataDir, logPath: path.join(dataDir, "bridge.log") };
}

export type Browser = "chrome" | "edge" | "brave" | "chromium";
export const BROWSERS: readonly Browser[] = ["chrome", "edge", "brave", "chromium"];

const DARWIN_DIRS: Record<Browser, string[]> = {
  chrome: ["Google", "Chrome"],
  edge: ["Microsoft Edge"],
  brave: ["BraveSoftware", "Brave-Browser"],
  chromium: ["Chromium"],
};
const LINUX_DIRS: Record<Browser, string[]> = {
  chrome: ["google-chrome"],
  edge: ["microsoft-edge"],
  brave: ["BraveSoftware", "Brave-Browser"],
  chromium: ["chromium"],
};
const WIN32_DIRS: Record<Browser, string[]> = {
  chrome: ["Google", "Chrome"],
  edge: ["Microsoft", "Edge"],
  brave: ["BraveSoftware", "Brave-Browser"],
  chromium: ["Chromium"],
};

export function browserConfigRoot(p: Platform, b: Browser, home: string, env: Env): string {
  switch (p) {
    case "darwin":
      return posix.join(home, "Library", "Application Support", ...DARWIN_DIRS[b]);
    case "linux":
      return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, ".config"), ...LINUX_DIRS[b]);
    case "win32":
      return win32.join(localAppData(home, env), ...WIN32_DIRS[b], "User Data");
  }
}

export function browserRegistryKey(b: Browser): string {
  return `HKCU\\Software\\${WIN32_DIRS[b].join("\\")}\\NativeMessagingHosts\\dev.anynotate.host`;
}
