Item **1** done and marked `[x]`.

## What I did
Added the stage-1 relay: `server/config.js` (validated env config, package version, origin allowlist), `server/relay.js` (in-memory rooms, seats `human`/`alice`/`boris`, crypto tokens, name validation and uniqueness, lobby snapshot, TTL enforced on access + periodic cleanup), `server/http.js` (routing for `/api/health`, `/api/rooms`, `/api/rooms/:code/join`; CORS allowlist with `Vary: Origin`, 204 preflight, JSON errors, 512 KB body limit, `no-store`/`nosniff`; allowlisted static server for `/`, `/index.html`, `/favicon.svg`, `/css/*`, `/js/*` with `HEAD` support and traversal/dot-file rejection), and `server/index.js` (listener with `maxHeaderSize` and request timeout, method/path/status logging, `SIGINT`/`SIGTERM` shutdown, relay timer cleanup). Added `start` script and `engines.node >=18` to `package.json`.

## Findings (important for later items)
1. `createRelay` already exposes `requireActiveRoom`, `bumpLobby` and `markClosed` as internal helpers, and rooms carry the stage-2 fields container (`players`, `lobbyVersion`, `hostLastSeen`, `closedAt`); stage 2 should add `actions`, `views`, `log`, `messages` to the room object inside `createRoom`.
2. `relay.getLobby(room)` is exported and computes `connected` from `presenceTimeoutMs`; host presence uses `hostLastSeen`. Stage 2 must update `hostLastSeen` only after the TTL check in host poll/publish.
3. Errors are thrown as `RelayError(code, message, status)` from `server/relay.js`; `server/http.js` maps them to `{ ok: false, error, message }`. Reuse this instead of adding a second error type.
4. The CORS check in `createHttpServer` rejects any request with a non-allowlisted `Origin` (including static), and preflight answers 204 before routing; stage-2 routes only need to add method/path handling and their `Allow` values.
5. Encoded traversal (`/js/%2e%2e/server/index.js`) is normalized by the URL parser and then rejected by the static allowlist (404), confirmed by smoke. `curl.exe --path-as-is /../server/index.js` also returns 404.
6. `readJsonBody` drains oversized bodies and returns 413 `body_too_large`; reuse it for publish/action bodies but pass the item-specific size limits.
7. `server/index.js` serves static from the repository root resolved via `import.meta.url`, so it works regardless of the current directory.

---
