import { existsSync, readFileSync } from "node:fs";
import { ensureHome, tokenPath } from "../inbox/paths";
import { writePrivateFile } from "../platform/files";

const TOKEN = /^[0-9a-f]{64}$/;

// An empty or corrupted token file would otherwise authenticate an empty header, so anything
// that is not a well-formed token is replaced.
export function loadOrCreateToken(): string {
  const path = tokenPath();
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (TOKEN.test(existing)) return existing;
  }
  ensureHome();
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  writePrivateFile(path, `${token}\n`);
  return token;
}
