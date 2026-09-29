import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Status } from "@anynotate/protocol";
import { BUNDLE_ID, bundleDir, latestBundleId, listBundles, readBundle, readStatus, updateStatus } from "../inbox/store";

// Applied under the claim: a status that moved on since readStatus is kept as is.
export function pullTransition(s: Status): Status {
  return s.state === "queued" ? { ...s, state: "delivered", via: "pull" } : s;
}

export function runAnnotations(args: string[]): string {
  const [arg] = args;
  if (!arg) {
    const rows = listBundles(10);
    if (!rows.length) return "No browser notes yet.";
    return rows
      .map(({ bundle, status }) => {
        // A null status means another process holds the claim right now.
        const st = status ? (status.via ? `${status.state}(${status.via})` : status.state) : "busy";
        return `${bundle.id}  ${st}  ${bundle.target.agent}  "${bundle.title}"`;
      })
      .join("\n");
  }

  const id = arg === "latest" ? latestBundleId() : arg;
  // Check the id shape first: bundleDir throws on anything that isn't a bundle id (e.g. "../x").
  if (!id || !BUNDLE_ID.test(id) || !existsSync(join(bundleDir(id), "annotations.json"))) {
    return `No bundle "${arg}". Run \`anynotate annotations\` to list.`;
  }
  readBundle(id);
  if (readStatus(id)?.state === "queued") {
    updateStatus(id, `pull-${process.pid}`, pullTransition);
  }
  return `${readFileSync(join(bundleDir(id), "README.md"), "utf8")}\nBundle folder: ${bundleDir(id)}`;
}
