# Anynotate protocol v1

The bridge is an HTTP server on `127.0.0.1`, port `47291` by default (`ANYNOTATE_PORT`). Clients send annotation **bundles**; the bridge stores each one as a folder and delivers it to an AI agent session. Constants and schemas live in `@anynotate/protocol`; request/response examples for the extension-facing endpoints live in `@anynotate/protocol/fixtures` (`conformance`).

## Handshake

`POST /health` (or `GET`) → `{ "ok": true, "bridgeVersion": "0.2.0", "protocol": { "version": 1, "min": 1 } }`.

A client supports a range of protocol versions (the extension: `min 1, max 1`) and calls `compatibility(clientRange, response.protocol)`:

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

## Evolution

- Additive changes — optional fields, new endpoints — keep `PROTOCOL_VERSION`. Both sides ignore fields they don't know.
- Removing, renaming or changing the meaning of anything bumps `PROTOCOL_VERSION`; the bridge keeps accepting the previous version (`PROTOCOL_MIN`) for at least one release.
- The bundle format has its own `v` (currently `1`); the agent-facing `README.md` stays human-readable.

## Threat model

- **Web pages** can reach `127.0.0.1` from the user's browser. They are refused by `Origin` (including preflights), and DNS-rebinding pages by `Host`; a web request without an `Origin` (such as an `<img>` GET) fails the token check.
- **Other users, and sandboxed processes that cannot read `$ANYNOTATE_HOME/token`,** can reach the loopback port and can forge any `Origin`, but the token is required on every route except `/health`, and `$ANYNOTATE_HOME` and its contents are owner-only. They are refused.
- **Processes running as the user** can read the token file or run the native host themselves; the bridge does not defend against code already running as the user.
- **Bundle handling**: file names are allow-listed, ids are validated, bodies are capped at 50 MB, and the bridge loads no remote code.
- **The token** is compared in constant time. The extension receives it only from the native host, which Chrome starts only for allow-listed extension ids.
- **Extension ids** are what the native host trusts. An extension the user side-loads in developer mode with a copied public key gets the same id and is treated as Anynotate.
- **A compromised extension renderer** can change the stored bridge URL, but the extension only ever sends the token to `127.0.0.1`.
- **While the bridge is not running**, another local user could listen on its port and receive the extension's token. Keep the bridge running (launchd restarts it), and treat the token as exposed if that may have happened: delete `~/.anynotate/token` and restart the bridge to rotate it.
