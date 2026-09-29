# Anynotate protocol (0.1.x)

The bridge is an HTTP server on `127.0.0.1`, port `47291` by default (`ANYNOTATE_PORT`). Clients send annotation **bundles**; the bridge stores each one as a folder and delivers it to an AI agent session.

## Access

- Browser callers are recognised by `Origin`. A request carrying an `Origin` that is not on the bridge's allow-list (`$ANYNOTATE_HOME/origins` plus `ANYNOTATE_ALLOWED_ORIGINS`) gets `403`. Allowed origins get CORS headers.
- Every endpoint except `GET /health` and `OPTIONS` requires the header `X-Anynotate-Token: <token>`, where the token is the contents of `$ANYNOTATE_HOME/token` (`anynotate token`). A missing or wrong token gets `401`.

## Endpoints

| Method and path | Body | Response |
|---|---|---|
| `GET /health` | — | `{ "ok": true }` |
| `GET /sessions` | — | `Session[]`: live push sessions, herdr panes (`method: "herdr"`), then sessions seen by the prompt hook (`method: "next-prompt"`) |
| `POST /bundles` | `multipart/form-data`: field `bundle` = JSON `BundleInput`; file fields named `page.md`, `screenshot.png`, optional `snapshot.html`, `crops/A<n>.png` | `201 { id, status: Status }` |
| `GET /bundles/<id>` | — | `{ bundle: Bundle, status: Status }` or `404` |
| `POST /bundles/<id>/ack` | `{ "summary"?: string }` | `{ "ok": true }`, or `404` if unknown or busy |
| `POST /register` | `{ id, agent, cwd, title? }` | `{ "ok": true }`, registers a push adapter |
| `POST /heartbeat` | `{ id }` | `{ "ok": true }`, or `404` if not registered |
| `GET /adapter/<id>/events` | — | Server-sent events: `event: deliver` / `data: { "bundleId": … }`, plus a comment ping every 15 s |

Request bodies are capped at 50 MB. Upload file names outside the list above are rejected.

## Bundle folder

Each bundle is written to `$ANYNOTATE_HOME/inbox/<id>/` (default `~/.anynotate`), and older bundles are moved to `$ANYNOTATE_HOME/archive/`. Ids match `BUNDLE_ID`, e.g. `2026-09-28T101502-example-com`.

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

## Versioning

Bundles carry `v: 1`. Consumers must ignore fields they don't know.
