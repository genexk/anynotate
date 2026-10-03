# Anynotate protocol v2

The bridge is an HTTP server on `127.0.0.1`, port `47291` by default (`ANYNOTATE_PORT`). Clients send annotation **bundles**; the bridge stores each one as a folder and delivers it to an AI agent session. Constants and schemas live in `@anynotate/protocol`; request/response examples for the extension-facing endpoints live in `@anynotate/protocol/fixtures` (`conformance`).

## Handshake

`POST /health` (or `GET`) → `{ "ok": true, "bridgeVersion": "0.6.0", "protocol": { "version": 2, "min": 1 } }`.

A client supports a range of protocol versions (the extension: `min 2, max 2`) and calls `compatibility(clientRange, response.protocol)`:

- `ok` — the ranges overlap; proceed.
- `bridge-too-old` — ask the user to update the bridge; don't send.
- `extension-too-old` — ask the user to update the client.

A `/health` body without `protocol` comes from a pre-v1 bridge: treat it as `bridge-too-old`.

## Access

Checked in this order:

| Request | Result |
|---|---|
| `Host` is not `127.0.0.1:<port>` or `localhost:<port>` | `403 {"error":"bad host"}` |
| `Origin` present and not on the allow-list | `403 {"error":"forbidden origin"}` (preflight too) |
| `OPTIONS` | `204`, with CORS headers for an allowed origin |
| `/health` | answered, no credentials needed |
| `X-Anynotate-Token` equal to `$ANYNOTATE_HOME/token` | allowed |
| anything else | `401 {"error":"bad token"}` |

An `Origin` on the allow-list earns CORS headers only; **the token is still required**, because any local process can send any `Origin`.

The allow-list is the valid `chrome-extension://` entries from `$ANYNOTATE_HOME/origins` and `ANYNOTATE_ALLOWED_ORIGINS`; `anynotate install` adds the Anynotate extension's id, and `anynotate origin add chrome-extension://<id>` adds a development build. Chrome attaches `Origin` to an extension's non-GET requests only, so **browser clients use the POST endpoints**; the GET variants remain for the CLI and scripts.

### How the extension gets the token

`anynotate install` registers a Chrome native messaging host named `dev.anynotate.host` (macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.anynotate.host.json`) whose `allowed_origins` are the allow-listed extension ids. Chrome launches it only for those extensions, running `~/.anynotate/native-host` as the user. Chrome starts the helper without the user's environment, so `ANYNOTATE_HOME` does not apply: the helper always reads `~/.anynotate/token` and `~/.anynotate/origins`. Messages use Chrome's native messaging framing (a 4-byte little-endian length, then UTF-8 JSON): the request `{ "type": "token" }` is answered with `{ "ok": true, "token": "<64 hex>" }`, or `{ "ok": false, "error": "<reason>" }` if the calling origin is not allowed or the request is unknown. The extension then sends the token as `X-Anynotate-Token`; nobody copies it by hand.

## Endpoints

| Method and path | Body | Response |
|---|---|---|
| `GET` / `POST /health` | — | `HealthResponse` |
| `GET` / `POST /sessions` | — | `Session[]`: live push sessions, herdr panes (`method: "herdr"`), then sessions seen by the prompt hook outside herdr (`method: "next-prompt"`) |
| `POST /bundles` | `multipart/form-data`: field `bundle` = JSON `BundleInput`; files `page.md`, `screenshot.png`, optional `snapshot.html`, `crops/A<n>.png` | `201 SendResponse` (`{ id, status }`); `400 ErrorResponse` for an invalid bundle or file name |
| `POST /bundles/<id>/status`, `GET /bundles/<id>` | — | `BundleStatusResponse` (`{ bundle, status }`; `status` is `null` if the status file is missing or unreadable); `404` if unknown |
| `POST /bundles/<id>/ack` | `AckRequest` (`{ "summary"?: string }`) | `OkResponse`; `404` if unknown or busy |
| `POST /register` | `{ id, agent, cwd, title? }` | `OkResponse`; registers a push adapter (`400` for an invalid agent name) |
| `POST /heartbeat` | `{ id }` | `OkResponse`, or `404 {"ok":false}` if not registered |
| `GET /adapter/<id>/events` | — | Server-sent events: a `: connected` comment, then `event: deliver` / `data: { "bundleId": … }`, plus a comment ping every 15 s; `404 {"error":"not registered"}` if not registered |

Every error body is `ErrorResponse` (`{ "error": string }`), except `/heartbeat`'s `404 {"ok":false}` and a body over the 50 MB cap, which the server refuses before the bridge handles the request.

## Bundle folder

Each bundle is written to `$ANYNOTATE_HOME/inbox/<id>/` (default `~/.anynotate`); older bundles move to `$ANYNOTATE_HOME/archive/`. Ids match `BUNDLE_ID`, e.g. `2026-09-24T153200-tomato-soup-recipes`.

| File | Contents |
|---|---|
| `README.md` | Human-readable summary for the agent: page, notes with quotes and comments, file list |
| `annotations.json` | The `Bundle` (the `BundleInput` plus `id` and `files`) |
| `page.md` | Page text as Markdown, with `⟦A<n>⟧` markers where notes attach |
| `screenshot.png` | Viewport screenshot with numbered markers |
| `snapshot.html` | Optional full DOM archive |
| `crops/A<n>.png` | Per-note crops |
| `status.json` | `Status`: `queued` → `delivered` → `acked` |

`$ANYNOTATE_HOME/inbox/latest` points at the newest bundle.

## Intents

Each annotation may carry an `intent` telling the agent what the user wants. `INTENTS` lists the current ones; `README.md` puts a directive line under the note's heading instead of naming the intent:

| `intent` | Directive in `README.md` |
|---|---|
| `explain` | `**Explain** this.` |
| `change` | `**Change requested.**` |
| `approve` | `**Approved** — no change needed.` |

The v1 values `question`, `bug` and `note` are still accepted and appear in the heading as before, with no directive line. `change` was also a v1 value; it keeps its name and now gets the directive line. No `intent` means no directive either.

### Region notes

On pages that draw into a `<canvas>` (online documents, design tools, maps), there is no text or element under the user's pointer worth selecting, so the user draws a rectangle instead. Such a note is an `element` annotation whose `element` is the node under the rectangle (usually the `<canvas>`) and which carries an optional `region`:

```ts
region?: { x: number; y: number; w: number; h: number }
```

The rectangle is in CSS pixels, relative to the viewport at capture time; add `viewport.scrollY` for the page offset. `w` and `h` are non-negative. `box` still describes the whole element, and `crops/A<n>.png` shows just the rectangle. `README.md` adds a line under the note's heading, such as `Region: 420×180 at (310, 96) on <canvas#board> · see crops/A3.png`.

`region` is only valid on `kind: "element"`; a `text` annotation with a `region` is rejected. It is an additive field: a bridge that predates it parses the annotation as a plain element note and drops `region`, so the agent still gets the comment, element and crop.

### Notes inside frames

A note made on text or an element inside a same-origin `<iframe>` carries the frames on its anchor:

```ts
anchor.frames?: string[]
```

Each entry is a CSS selector for an `<iframe>`, outermost first, resolved in the document of the frame before it (the first in the top page). `css`, `hosts`, `path` and `quote` then refer to the innermost frame's document, while `box` and `region` stay in the top page's viewport. `README.md` names the frames after the note's selector, such as ``selector: `p#inner` inside iframe `iframe#card` ``. It is additive: a bridge that predates it drops `frames`, and the agent gets a selector without the frame it lives in.

## Evolution

- Additive changes — optional fields, new endpoints — keep `PROTOCOL_VERSION`. Both sides ignore fields they don't know.
- Removing, renaming or changing the meaning of anything bumps `PROTOCOL_VERSION`; the bridge keeps accepting the previous version (`PROTOCOL_MIN`) for at least one release.
- The bundle format has its own `v` (currently `1`); the agent-facing `README.md` stays human-readable.

### Version history

- **v1** — handshake, token-only access, native-host token delivery.
- **v2** — intents `explain`, `change`, `approve` (legacy `question`, `bug`, `note` still accepted). `PROTOCOL_MIN` stays `1`: a v2 bridge accepts v1 clients.
  - Optional `region` on element annotations (additive, `@anynotate/protocol` 0.4.0, bridge 0.5.1).
  - Optional `offscreen: true` on any annotation whose target was not on screen at send time (`box` and crop are from when it was last seen); `README.md` adds `(off-screen when sent)` to its heading (additive, same releases).
  - Optional `anchor.frames` on notes made inside same-origin iframes; `README.md` names the frames after the selector (additive, same releases).

## Threat model

- **Web pages** can reach `127.0.0.1` from the user's browser. They are refused by `Origin` (including preflights), and DNS-rebinding pages by `Host`; a web request without an `Origin` (such as an `<img>` GET) fails the token check.
- **Other users, and sandboxed processes that cannot read `$ANYNOTATE_HOME/token`,** can reach the loopback port and can forge any `Origin`, but the token is required on every route except `/health`, and `$ANYNOTATE_HOME` and its contents are owner-only. They are refused.
- **Processes running as the user** can read the token file or run the native host themselves; the bridge does not defend against code already running as the user.
- **Bundle handling**: file names are allow-listed, ids are validated, bodies are capped at 50 MB, and the bridge loads no remote code.
- **The token** is compared in constant time. The extension receives it only from the native host, which Chrome starts only for allow-listed extension ids.
- **Extension ids** are what the native host trusts. An extension the user side-loads in developer mode with a copied public key gets the same id and is treated as Anynotate.
- **A compromised extension renderer** can change the stored bridge URL, but the extension only ever sends the token to `127.0.0.1`.
- **While the bridge is not running**, another local user could listen on its port and receive the extension's token. Keep the bridge running (launchd restarts it), and treat the token as exposed if that may have happened: delete `~/.anynotate/token` and restart the bridge to rotate it.
