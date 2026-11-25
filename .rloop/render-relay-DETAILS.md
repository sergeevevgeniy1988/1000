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

Item **2** done and marked `[x]`.

## What I did
Extended `server/relay.js` with the full game transport and room lifecycle: timing-safe host/guest/seat authorization (`missing_token`, `invalid_token`, `not_host`, `not_guest`), presence refresh on every successful poll/publish/action, `connected` reconciliation with `lobbyVersion` bumps, `publish` (monotonic versions, idempotent duplicate, `stale_version`, size limits, `gameReset`/`logEpoch` log reset, `{seq, entry}` log and `{seq, payload}` messages, per-seat views and `viewVersion`), `hostPoll` (action queue window + conditional lobby), `playerPoll` (own view, log epoch/delta, targeted messages only), `addAction` (token-derived `playerId`, `actionId` validation, `playerId + actionId` receipts, 100-entry queue, 429 `action_queue_full`), plus `kick`, `close` and `leave` freeing seats, dropping their actions/views/messages and invalidating tokens. Reworked `server/http.js` into one room-route dispatcher for join/publish/host/player/action/kick/close/leave with per-route `Allow` headers, strict `bad_query` cursor parsing, tokens read only from `X-Room-Token`, and the stage-1 CORS/JSON/static behavior preserved.

## Findings (important for later items)
1. `publish` returns exactly `{ ok, version, lobbyVersion }`; a repeated current version is a no-op that never re-applies log/messages/views, and any lower version is 409 `stale_version`. The host session already handles that 409 by bumping its local version.
2. `hostPoll` returns `lobby` only when `lobbySince < lobbyVersion` and always returns `cursor = actionSeq`; actions are filtered to `seq > actionSince` and sorted ascending.
3. `playerPoll` accepts any occupied seat token (host included) and never returns another seat's view; on `logEpoch` mismatch it returns the whole current log, otherwise `seq > logSince`.
4. A valid token used on the wrong route is 403 (`not_host`/`not_guest`); an unknown or removed-seat token is 401 `invalid_token`. This is what makes a kicked guest see 401 and a guest calling `close` see 403.
5. Kick is allowed after the game started (the stage-2 gate kicks `alice` after `started=true`); the old PowerShell relay refused that, so do not reintroduce a `room_started` guard there.
6. Room fields for stage 3: `publishVersion`, `viewVersion`, `views`, `log`, `logEpoch`, `logTotal`, `messages`, `messageTotal`, `actions`, `actionSeq`, `presence`. Limits live as exported constants in `server/relay.js` (100 actions, 500 log entries, 100 messages per seat, 64 KB view).
7. Transport error codes in use: 400 `bad_room_code`/`bad_version`/`bad_publish`/`bad_action`/`bad_name`/`bad_json`/`bad_query`, 401 `missing_token`/`invalid_token`, 403 `bad_origin`/`not_host`/`not_guest`, 404 `room_not_found`, 409 `room_started`/`room_full`/`name_taken`/`stale_version`, 410 `room_closed`, 413 `body_too_large`, 429 `action_queue_full`/`room_limit`, 405 with `Allow`.
8. Both plan gates (`stage 2` lifecycle and `ROOM_TTL_SECONDS=2`) print `OK`, the stage-1 gate still prints `OK`, and an extra local check confirmed duplicate publish, `gameReset`, kick/leave token invalidation, wrong-role 403s and CORS headers on errors.

---
