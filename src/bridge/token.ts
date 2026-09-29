import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ensureHome, tokenPath } from "../inbox/paths";

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
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return token;
}
