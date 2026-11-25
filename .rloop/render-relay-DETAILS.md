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

Item **3** done and marked `[x]`.

## What I did
Added `js/config.js` with `RELAY_BASE_URL`: it reads the `relay-base-url` meta tag, trims whitespace, strips trailing slashes, collapses a URL on the current `location.origin` to an empty string (same-origin), returns an empty string for invalid values and in Node/without a DOM, and exports `resolveRelayBaseUrl` for that normalization. Added `<meta name="relay-base-url" content="">` with a Render comment to `index.html` and changed the description/footer wording from a LAN to an internet network without touching version 1.3.0. `js/main.js` now imports `RELAY_BASE_URL` and builds `new RelayClient({ baseUrl: RELAY_BASE_URL })`; the `?room=` and invite flow are unchanged. Added `HEALTH_TIMEOUT_MS = 30000` and `HEALTH_RETRY_ATTEMPTS = 2` to `js/net/protocol.js`. `RelayClient` gained `healthTimeoutMs`/`healthRetryAttempts` (constructor options plus private fields); `health()` now uses `retry: true` with those per-call `timeoutMs`/`attempts`, and `#request`/`#requestOnce` accept a per-call timeout, while every other method keeps 8000 ms and 3 attempts. In `js/net/lobby.js` the instruction texts no longer mention `start-lan.cmd`, `getHealthInstruction()` accepts `health.network === true` as an available relay, the modal's `checkHealth()` shows «Проверяем сервер…» while waiting and clears it on success, and the modal subtitle is now «Сетевая комната»; the unavailable-relay branch still shows the instruction plus «Проверить снова» and «Играть локально».

## Findings (important for later items)
1. `RELAY_BASE_URL` is evaluated once at module load from the meta tag; because module scripts run after `head` is parsed, the meta is always visible. An empty value keeps requests same-origin, so the local relay server still works without configuration.
2. `resolveRelayBaseUrl` collapses same-origin and invalid values to `''`; this is also the safe fallback if the user writes a malformed address (the lobby then just fails health instead of hitting a bogus origin).
3. `RelayClient` still sends `credentials: 'same-origin'`, so cross-origin requests to Render carry no cookies and the server's CORS never enables `Allow-Credentials`; the room token stays in `X-Room-Token`.
4. Health now performs up to two 30 s attempts (`healthTimeoutMs`/`healthRetryAttempts` are constructor options for tests), while `createRoom`/`joinRoom`/`kick`/`close`/`leave` never retry and polls/publish/action keep 8 s and 3 attempts.
5. `getHealthInstruction()` still accepts the legacy `lan: true` flag, so a stage-1/stage-2 relay without `network` keeps working; the check order is `ok && (lan || network)` first, then `lan_disabled`-style text for an `ok` relay without either flag, then `server_unavailable`.
6. The stage-3 gate prints `OK` (syntax, Node-empty `RELAY_BASE_URL`, meta present, `RELAY_BASE_URL` in `js/main.js`, no `start-lan.cmd` in `js/net/lobby.js`, static serving of `/js/config.js` and the meta in `/`). Extra checks: `resolveRelayBaseUrl` for remote/same-origin/invalid/undefined, `health()` hitting `<baseUrl>/api/health` with two attempts on timeout, `createRoom` not retrying, `hostPoll` still three attempts.
7. For stage 4 docs: `relay-base-url` must be the bare HTTPS origin (for example `https://thousand-relay.onrender.com`, no trailing slash needed) and changing it requires a Pages redeploy.

---

Item **4** done and marked `[x]`.

## What I did
Added `render.yaml` with a single Render web service `thousand-relay` (`type: web`, `runtime: node`, `plan: free`, `branch: main`, `buildCommand: npm install`, `startCommand: npm start`, `healthCheckPath: /api/health`, `autoDeploy: true`, env `HOST=0.0.0.0`, `FRONTEND_ORIGINS=https://sergeevevgeniy1988.github.io`, `ROOM_TTL_SECONDS=120`, `NODE_VERSION=22`; no databases or disks). Added `docs/RENDER.md` with account/Blueprint and manual **New Web Service** steps, env vars, `/api/health` verification, filling `relay-base-url`, Pages redeploy, post-deploy two-profile check, cold start/sleep behavior, 403/404/410 troubleshooting, rollback and prototype limits. Reworked `README.md` so it honestly describes the internet prototype: Pages frontend plus Render relay, invites on `github.io`, `relay-base-url` in the meta tag, local run via `npm start` on `127.0.0.1:8787`, Render limitations (host tab, Free sleep, in-memory rooms after sleep, no accounts), CORS/`FRONTEND_ORIGINS`/token/HTTPS security notes, actual `server/` + `js/config.js` + `docs/RENDER.md` structure, a tests section stating the 1.3.0 suite is not restored and the prototype is verified by smoke commands, and updated troubleshooting/known limitations.

## Findings (important for later items)
1. The stage-4 gate was executed directly from the plan line (all syntax checks, `render.yaml`/README/docs regexes, and the full room lifecycle smoke on port 8793) and printed `OK`; `git diff --check` is clean.
2. `README.md` previously still documented removed `start.cmd`, `start-lan.cmd`, `run-tests.cmd`, `tools/` and `tests/`; these current-state sections were replaced, while the historical "Что нового в v1.2.0" changelog was intentionally left as history.
3. `package.json` still has `"test": "node --test tests/"` while `tests/` does not exist; README now states this explicitly instead of claiming 240 tests. Restoring the suite remains out of scope.
4. `server/config.js` defaults `SERVE_STATIC` to true, and `render.yaml` does not override it, so the Render service also serves the static allowlist even though Pages is the frontend. README mentions `SERVE_STATIC=0` as an optional switch.
5. The relay has no per-IP rate limiting; abuse protection is only `MAX_ROOMS`, body/header/queue/view limits. README and `docs/RENDER.md` say so explicitly.
6. `relay-base-url` must be the bare HTTPS origin (for example `https://thousand-relay.onrender.com`, no trailing slash); a malformed value collapses to same-origin in `js/config.js`, and any change needs a Pages redeploy. The actual Render deploy, cold start and cross-network play are user-run checks per `docs/RENDER.md`.

---
