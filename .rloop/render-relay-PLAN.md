# План: интернет-режим «Тысячи» через Render relay

<!-- Формат rloop: ровно один чекбокс `- [ ] **N.**` на этап.
     Исполнитель выполняет ровно один этап за запуск и отмечает только
     свой чекбокс. Всё остальное — обычные списки. -->

**Масштаб:** L — новый Node-relay, CORS, клиентский транспорт и выкатка на Render; 4 этапа, потому что тесты, миграции и изменения игрового ядра в прототип не входят.
**Пути:** файлы указаны от корня репозитория; команды выполняются из каталога `E:\AI_Develop\1000\GitHubPages`.

## 1. Цель и границы

**Цель.** Добавить к статическому сайту на GitHub Pages небольшой Node-relay, размещаемый на Render, чтобы хост и гости могли играть через интернет. Фронтенд, игровое ядро и приглашения остаются на `https://sergeevevgeniy1988.github.io/1000/`; relay только передаёт действия и персональные снимки стола. Прототип должен работать локально и быть готов к деплою на Render Free.

**Не входит.** Создание аккаунта и самого сервиса Render, фактический деплой и проверка из двух разных сетей; восстановление удалённого набора тестов и `npm test`; повышение версии и полный пересмотр `ACCEPTANCE.md`; возврат PowerShell-сервера `tools/`; WebRTC/P2P, аккаунты, рейтинги, чат, зрители, host migration и хранение партий на диске; настройка собственного домена и TLS сверх того, что даёт Render.

**Допущения.**
- Пользователь создаст Render Web Service и после деплоя впишет его HTTPS-адрес в meta `relay-base-url` в `index.html`; без этого сетевой режим на Pages останется недоступен, а локальная игра продолжит работать.
- Origin GitHub Pages — ровно `https://sergeevevgeniy1988.github.io`; собственный домен не используется. Если он появится, `FRONTEND_ORIGINS` нужно обновить.
- Render Free засыпает после 15 минут без запросов и просыпается около минуты; это принято для прототипа.
- Relay хранит комнаты только в памяти, без БД и диска; после перезапуска или сна Render комнаты исчезают, что соответствует TTL.
- Вкладка хоста остаётся открытой: игровое состояние считается в браузере хоста, relay лишь передаёт сообщения.
- Node.js на Render — 18+; внешние npm-зависимости не добавляются.
- Прототип проверяется смоук-командами, а не набором тестов; полноценный `tests/` и `npm test` остаются вне рамок.
- Режим уточнений не указан, используется `balanced`.

## 2. Исходное состояние (до этапа 1)

- `index.html` — статическая точка входа версии 1.3.0; в `<head>` нет настройки relay, в описании и футере упомянута только локальная сеть. Модуль `js/main.js` подключается в конце `<body>`.
- `js/main.js` создаёт `new RelayClient()` без `baseUrl`, поэтому все запросы идут на same-origin `/api/...`. При открытии `?room=CODE` вызывается `openNetwork(roomFromUrl)`.
- `js/net/relay-client.js` — same-origin JSON-клиент с заголовком `X-Room-Token`, таймаутом 8 с и ретраями; `health()` вызывается без ретраев.
- `js/net/lobby.js` — `NetworkLobby.checkHealth()`, `createRoom()`, `joinRoom()`, `resumeGuest()`, лобби и модалка. Тексты `LAN_INSTRUCTION` и `SERVER_INSTRUCTION` требуют `start-lan.cmd`; подзаголовок модалки — «Комната в локальной сети».
- `js/net/protocol.js` — `isLanHealth()` требует `health.lan === true`; там же интервалы polling, лимиты и формы действий.
- `js/session/host-session.js` и `js/session/guest-session.js` уже умеют работать через relay-подобный клиент: хост публикует снимки и опрашивает очередь, гость опрашивает свой view и отправляет действия. Сетевой слой менять не нужно.
- `package.json` — `"type": "module"`, есть только `"test": "node --test tests/"`; папки `tests/` нет, поэтому `npm test` сейчас не работает. Скрипта `start` нет.
- Каталогов `server/`, `tools/`, `tests/` нет. PowerShell-сервер и тесты были удалены коммитом `ce2eff8`; в истории они лежат под `Source/tools` и `Source/tests`.
- Сайт развёрнут на GitHub Pages: `https://sergeevevgeniy1988.github.io/1000/` отдаёт статику, а `/api/health` возвращает 404.
- Соглашения проекта: ESM без сборщика и зависимостей, игровое ядро отделено от DOM, токены только в заголовке, хостовый браузер авторитетен, комнаты живут в памяти.

## 3. Этапы

### Этап 1

- [x] **1.** Этап 1 — HTTP-сервер relay, CORS, health, комнаты и лобби

**Результат.** Локальный Node-сервер отдаёт `/api/health`, создаёт и принимает комнаты, возвращает лобби, отвечает на CORS-preflight для GitHub Pages и умеет отдавать статику игры для локальной проверки. Эндпоинты хоста, публикации, действий и игрового polling в этот этап не входят.

**Зависимость.** Нет.

**Файлы.** `Изменить:` `package.json`. `Создать/удалить:` `server/config.js`, `server/relay.js`, `server/http.js`, `server/index.js`.

**Опорные функции.** `readConfig(env)`; `createRelay({ roomTtlMs, maxRooms, presenceTimeoutMs })`; `relay.createRoom(name)`, `relay.joinRoom(code, name)`, `relay.getLobby(room)`, `relay.cleanup()`; `createHttpServer({ config, relay, rootDir })`; `sendJson`, `sendError`, `readJsonBody`, `applyCors`, `handlePreflight`, `serveStatic`; `startServer(config)`. Модель комнаты: `code`, `hostToken`, `players`, `lobbyVersion`, `hostLastSeen`, `createdAt`, `closedAt`.

**Работа.**

1. `server/config.js`: прочитать `PORT` (по умолчанию 8787), `HOST` (по умолчанию `127.0.0.1`), `FRONTEND_ORIGINS` (по умолчанию `https://sergeevevgeniy1988.github.io,http://localhost:8787,http://127.0.0.1:8787`), `ROOM_TTL_SECONDS` (120), `MAX_ROOMS` (200), `SERVE_STATIC` (1), лимиты тела и заголовков. Валидировать числа и не падать на мусоре.
   **Проверка:** `node --check server/config.js`; ожидаемо код выхода 0.
2. `server/relay.js`: реализовать комнаты с местами `human`/`alice`/`boris`, генерацию кода из `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, криптостойкие токены, проверку имён 1–24 без управляющих символов, уникальность имён без учёта регистра, лимит комнат, лобби с `version`, `started`, `maxPlayers`, `seats`, `connected`, `lastSeen`, TTL по `hostLastSeen` и периодическую очистку. Проверка TTL должна срабатывать на доступе, а не только в таймере.
   **Проверка:** `node --check server/relay.js`; ожидаемо код выхода 0.
3. `server/http.js`: реализовать `GET /api/health` с `{ ok: true, lan: true, network: true, version, roomTtlSeconds }`, `POST /api/rooms` с `{ name }`, `POST /api/rooms/:code/join` с `{ name }`, JSON-ошибки `{ ok: false, error, message }`, ограничение тела 512 КБ, `Content-Type: application/json`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. CORS: точный allowlist, `Vary: Origin`, `Access-Control-Allow-Origin` на успешных и ошибочных ответах, preflight `OPTIONS` с `Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers: Content-Type, X-Room-Token`, `Max-Age: 600`, без `Allow-Credentials`. Чужой Origin — 403.
   **Проверка:** `node --check server/http.js`; ожидаемо код выхода 0.
4. `server/http.js`: добавить безопасную раздачу статики для локальной проверки: разрешить только `/`, `/index.html`, `/css/*`, `/js/*`, `/favicon.svg`; отклонять `..`, dot-файлы и `/server/*`; корректные MIME для html/css/js/svg; 404 на остальное. `HEAD` обрабатывать как `GET` без тела.
   **Проверка:** `node --check server/http.js`; ожидаемо код выхода 0.
5. `server/index.js`: создать HTTP-сервер с `maxHeaderSize`, таймаутом запроса, подключить relay и роутер, слушать `HOST`/`PORT`, логировать только метод, путь и статус без заголовков и тел, корректно завершаться по `SIGINT`/`SIGTERM` и очищать таймер relay.
   **Проверка:** `node --check server/index.js`; ожидаемо код выхода 0.
6. `package.json`: добавить `"start": "node server/index.js"` и `"engines": { "node": ">=18" }`; не менять существующий `test` и не добавлять зависимости.
   **Проверка:** `node -p "require('./package.json').scripts.start"`; ожидаемо `node server/index.js`.

**Гейт этапа.** Запустить сервер на 8788 и проверить health, создание комнаты, join, CORS-preflight, отказ чужому Origin, статику и path traversal:

```powershell
$env:PORT='8788'; $env:HOST='127.0.0.1'; $env:FRONTEND_ORIGINS='https://sergeevevgeniy1988.github.io'; $env:SERVE_STATIC='1'; $p=Start-Process node -ArgumentList 'server/index.js' -PassThru -WindowStyle Hidden; try { Start-Sleep -Seconds 2; $h=Invoke-RestMethod 'http://127.0.0.1:8788/api/health'; if(-not $h.ok -or $h.lan -ne $true){throw 'health'}; $r=Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8788/api/rooms' -ContentType 'application/json' -Body '{"name":"Host"}'; if($r.roomCode.Length -ne 6 -or $r.playerId -ne 'human'){throw 'create'}; $j=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8788/api/rooms/$($r.roomCode)/join" -ContentType 'application/json' -Body '{"name":"Guest"}'; if($j.playerId -ne 'alice'){throw 'join'}; $o=Invoke-WebRequest -Method Options -Uri 'http://127.0.0.1:8788/api/rooms' -Headers @{Origin='https://sergeevevgeniy1988.github.io';'Access-Control-Request-Method'='POST';'Access-Control-Request-Headers'='content-type,x-room-token'} -UseBasicParsing; if($o.StatusCode -ne 204){throw 'preflight'}; if(@($o.Headers['Access-Control-Allow-Origin'])[0] -ne 'https://sergeevevgeniy1988.github.io'){throw 'cors'}; $bad=$false; try { Invoke-WebRequest -Method Options -Uri 'http://127.0.0.1:8788/api/rooms' -Headers @{Origin='https://evil.example';'Access-Control-Request-Method'='POST'} -UseBasicParsing | Out-Null; $bad=$true } catch { if([int]$_.Exception.Response.StatusCode -ne 403){throw} }; if($bad){throw 'bad-origin-allowed'}; $s=Invoke-WebRequest 'http://127.0.0.1:8788/' -UseBasicParsing; if($s.StatusCode -ne 200 -or $s.Content -notmatch '<title>1000'){throw 'static'}; $t=curl.exe --path-as-is -s -o NUL -w "%{http_code}" 'http://127.0.0.1:8788/../server/index.js'; if($t -ne '404'){throw 'traversal'}; 'OK' } finally { if(-not $p.HasExited){ Stop-Process -Id $p.Id -Force } }
```

- `node --check server/config.js`, `server/relay.js`, `server/http.js`, `server/index.js` — код выхода 0.
- `git diff --check` — без вывода.
- Ожидаемо: команда печатает `OK`.

**Вне автоматической приёмки.** Реальный Render, браузерный CORS с Pages и поведение за NAT/прокси не проверяются; локальный смоук подтверждает только контракт API и наличие заголовков.

### Этап 2

- [x] **2.** Этап 2 — host/publish/player/action и жизненный цикл комнаты

**Результат.** Полный транспорт партии: хост опрашивает очередь и публикует версии, гость получает только свой снимок и дельты журнала/сообщений, действия дедуплицируются, работают kick/close/leave, TTL и коды ошибок. Клиентские модули в этот этап не входят.

**Зависимость.** Этап 1.

**Файлы.** `Изменить:` `server/relay.js`, `server/http.js`. `Создать/удалить:` Нет.

**Опорные функции.** `relay.requireHost(token)`, `relay.requireGuest(token)`, `relay.touchPresence(room, seat)`, `relay.bumpLobby(room)`; `relay.publish(code, token, body)`, `relay.hostPoll(code, token, { actionSince, lobbySince })`, `relay.playerPoll(code, token, { viewSince, logSince, logEpoch, messageSince })`, `relay.addAction(code, token, { actionId, type, payload })`, `relay.kick(code, token, playerId)`, `relay.close(code, token)`, `relay.leave(code, token)`; поля комнаты `actions`, `actionSeq`, `views`, `viewVersion`, `log`, `logEpoch`, `logTotal`, `messages`, `messageTotal`.

**Работа.**

1. Добавить host/guest-авторизацию по `X-Room-Token` с timing-safe сравнением, обновление `lastSeen` при успешных poll/publish/action, вычисление `connected` по таймауту присутствия и увеличение `lobbyVersion` при join/leave/kick/смене connected/старте. Хост poll и publish должны обновлять `hostLastSeen` только после проверки TTL, иначе комната никогда не истечёт.
   **Проверка:** `node --check server/relay.js`; ожидаемо код выхода 0.
2. Реализовать `POST /api/rooms/:code/publish`: принимать `{ version, started, gameReset, logEpoch, views, log, messages }`, проверять монотонность версии, идемпотентность одинаковой версии, лимиты размеров, сбрасывать журнал при `gameReset` или смене `logEpoch`, присваивать записям `{ seq, entry }`, сообщениям `{ seq, payload }`, сохранять `views` по местам и `viewVersion`, возвращать `{ ok: true, version, lobbyVersion }`. Повтор версии не должен применять тело повторно; старая версия — 409 `stale_version`.
   **Проверка:** `node --check server/relay.js`; ожидаемо код выхода 0.
3. Реализовать `GET /api/rooms/:code/host`: отдавать `{ lobby?, lobbyVersion, actions, cursor }`, где `actions` — записи с `seq > actionSince`, `cursor` — последний выданный `actionSeq`, лобби — при `lobbySince < lobbyVersion`. Сортировать действия по `seq`; не отдавать тела чужих действий сверх очереди.
   **Проверка:** `node --check server/relay.js`; ожидаемо код выхода 0.
4. Реализовать `GET /api/rooms/:code/player`: отдавать `{ lobby, started, view?, viewVersion, log, logEpoch, logTotal, messages, messageTotal }`. `view` — только при `viewVersion > viewSince`; при смене `logEpoch` отдавать журнал с начала эпохи, иначе только `seq > logSince`; сообщения — только адресованные этому месту с `seq > messageSince`. Никаких чужих view и токенов в ответе.
   **Проверка:** `node --check server/relay.js`; ожидаемо код выхода 0.
5. Реализовать `POST /api/rooms/:code/action`: авторизовать гостя, проверять `actionId` 1–64 без управляющих символов, `type` строкой, `payload` объектом и размер; дедуплицировать по паре `playerId + actionId` (повтор возвращает прежний `seq`), ограничить очередь 100 записями, присваивать `seq`, возвращать `{ ok: true, seq }`. `playerId` брать только из токена, поля клиента игнорировать. До старта партии — 409, при закрытой комнате — 410.
   **Проверка:** `node --check server/relay.js`; ожидаемо код выхода 0.
6. Реализовать `POST /api/rooms/:code/kick` (только хост, только гость: освободить место, удалить его действия, обнулить токен), `POST /api/rooms/:code/close` (только хост: пометить комнату закрытой, все последующие запросы — 410), `POST /api/rooms/:code/leave` (только гость: освободить место). Закрытые и истёкшие комнаты держать в памяти ограниченное время, чтобы отдавать 410, затем удалять.
   **Проверка:** `node --check server/relay.js`; ожидаемо код выхода 0.
7. Свести коды ошибок и заголовки: 400 `bad_json`/`bad_name`/`bad_query`, 401 `missing_token`/`invalid_token`, 403 `not_host`/`not_guest`/`bad_origin`, 404 `room_not_found`, 409 `room_full`/`name_taken`/`room_started`/`stale_version`, 410 `room_closed`, 413 `body_too_large`, 429 `action_queue_full`, 405 с `Allow`. Все ошибки — `{ ok: false, error, message }` и с CORS-заголовками.
   **Проверка:** `node --check server/http.js`; ожидаемо код выхода 0.

**Гейт этапа.** Полный жизненный цикл на 8790: host + 2 гостя, publish, host poll, player poll, action, дедупликация, delta, stale version, неверный токен, kick и close:

```powershell
$env:PORT='8790'; $env:HOST='127.0.0.1'; $env:FRONTEND_ORIGINS='https://sergeevevgeniy1988.github.io'; $p=Start-Process node -ArgumentList 'server/index.js' -PassThru -WindowStyle Hidden; try { Start-Sleep -Seconds 2; $h=Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8790/api/rooms' -ContentType 'application/json' -Body '{"name":"Host"}'; $g1=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/join" -ContentType 'application/json' -Body '{"name":"Guest1"}'; $g2=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/join" -ContentType 'application/json' -Body '{"name":"Guest2"}'; if($g1.playerId -ne 'alice' -or $g2.playerId -ne 'boris'){throw 'seats'}; $pub=@{version=1;started=$true;gameReset=$true;logEpoch=1;views=@{human=@{viewerId='human'};alice=@{viewerId='alice'};boris=@{viewerId='boris'}};log=@(@{type='dealstarted'});messages=@{alice=@(@{code='hello';message='hi'})}} | ConvertTo-Json -Depth 12; $pr=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/publish" -Headers @{'X-Room-Token'=$h.token} -ContentType 'application/json' -Body $pub; if(-not $pr.ok){throw 'publish'}; $hp=Invoke-RestMethod -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/host?actionSince=0&lobbySince=0" -Headers @{'X-Room-Token'=$h.token}; if($hp.cursor -ne 0){throw 'host-poll'}; $gp=Invoke-RestMethod -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0" -Headers @{'X-Room-Token'=$g1.token}; if($gp.view.viewerId -ne 'alice' -or $gp.viewVersion -ne 1 -or @($gp.log)[0].seq -ne 1 -or @($gp.messages)[0].seq -ne 1){throw 'player-poll'}; $a=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/action" -Headers @{'X-Room-Token'=$g1.token} -ContentType 'application/json' -Body '{"actionId":"a1","type":"pass","payload":{}}'; if(-not $a.ok -or $a.seq -ne 1){throw 'action'}; $a2=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/action" -Headers @{'X-Room-Token'=$g1.token} -ContentType 'application/json' -Body '{"actionId":"a1","type":"pass","payload":{}}'; if($a2.seq -ne 1){throw 'dedupe'}; $hp2=Invoke-RestMethod -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/host?actionSince=0&lobbySince=0" -Headers @{'X-Room-Token'=$h.token}; if(@($hp2.actions).Count -ne 1 -or @($hp2.actions)[0].playerId -ne 'alice'){throw 'queue'}; $pub2=@{version=2;started=$true;gameReset=$false;logEpoch=1;views=@{human=@{viewerId='human'};alice=@{viewerId='alice'};boris=@{viewerId='boris'}};log=@(@{type='bid'});messages=@{}} | ConvertTo-Json -Depth 12; $pr2=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/publish" -Headers @{'X-Room-Token'=$h.token} -ContentType 'application/json' -Body $pub2; if(-not $pr2.ok){throw 'publish2'}; $gp2=Invoke-RestMethod -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/player?viewSince=1&logSince=1&logEpoch=1&messageSince=1" -Headers @{'X-Room-Token'=$g1.token}; if($gp2.viewVersion -ne 2 -or @($gp2.log)[0].seq -ne 2){throw 'delta'}; $stale=$false; try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/publish" -Headers @{'X-Room-Token'=$h.token} -ContentType 'application/json' -Body $pub | Out-Null; $stale=$true } catch { if([int]$_.Exception.Response.StatusCode -ne 409){throw} }; if($stale){throw 'stale-allowed'}; $badtoken=$false; try { Invoke-RestMethod -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/host?actionSince=0&lobbySince=0" -Headers @{'X-Room-Token'='bad'} | Out-Null; $badtoken=$true } catch { if([int]$_.Exception.Response.StatusCode -ne 401){throw} }; if($badtoken){throw 'bad-token-allowed'}; $k=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/kick" -Headers @{'X-Room-Token'=$h.token} -ContentType 'application/json' -Body '{"playerId":"alice"}'; if($k.lobby.seats | Where-Object { $_.playerId -eq 'alice' -and $_.occupied }){throw 'kick'}; $kicked=$false; try { Invoke-RestMethod -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0" -Headers @{'X-Room-Token'=$g1.token} | Out-Null; $kicked=$true } catch { if([int]$_.Exception.Response.StatusCode -ne 401){throw} }; if($kicked){throw 'kicked-token-allowed'}; $c=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/close" -Headers @{'X-Room-Token'=$h.token} -ContentType 'application/json' -Body '{}'; $closed=$false; try { Invoke-RestMethod -Uri "http://127.0.0.1:8790/api/rooms/$($h.roomCode)/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0" -Headers @{'X-Room-Token'=$g2.token} | Out-Null; $closed=$true } catch { if([int]$_.Exception.Response.StatusCode -ne 410){throw} }; if($closed){throw 'closed-allowed'}; 'OK' } finally { if(-not $p.HasExited){ Stop-Process -Id $p.Id -Force } }
```

Проверить TTL отдельным процессом с `ROOM_TTL_SECONDS=2`:

```powershell
$env:PORT='8791'; $env:HOST='127.0.0.1'; $env:ROOM_TTL_SECONDS='2'; $env:FRONTEND_ORIGINS='https://sergeevevgeniy1988.github.io'; $p=Start-Process node -ArgumentList 'server/index.js' -PassThru -WindowStyle Hidden; try { Start-Sleep -Seconds 2; $h=Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8791/api/rooms' -ContentType 'application/json' -Body '{"name":"Host"}'; Start-Sleep -Seconds 3; $expired=$false; try { Invoke-RestMethod -Uri "http://127.0.0.1:8791/api/rooms/$($h.roomCode)/host?actionSince=0&lobbySince=0" -Headers @{'X-Room-Token'=$h.token} | Out-Null; $expired=$true } catch { if([int]$_.Exception.Response.StatusCode -ne 410){throw} }; if($expired){throw 'ttl-not-enforced'}; 'OK' } finally { if(-not $p.HasExited){ Stop-Process -Id $p.Id -Force } }
```

- `node --check server/relay.js` и `node --check server/http.js` — код выхода 0.
- `git diff --check` — без вывода.
- Ожидаемо: обе команды печатают `OK`.

**Вне автоматической приёмки.** Одновременные гонки нескольких клиентов, поведение браузерного `fetch` при реальном CORS и длительная партия на три вкладки автоматически не воспроизводятся.

### Этап 3

- [ ] **3.** Этап 3 — клиентский relay URL, health-ретраи и тексты

**Результат.** Страница на GitHub Pages умеет обращаться к внешнему Render relay через настройку `relay-base-url`, health-проверка переживает холодный старт, а тексты лобби больше не отправляют пользователя запускать `start-lan.cmd`. Локальный запуск через статику relay остаётся same-origin.

**Зависимость.** Этап 2.

**Файлы.** `Изменить:` `index.html`, `js/main.js`, `js/net/relay-client.js`, `js/net/protocol.js`, `js/net/lobby.js`. `Создать/удалить:` `js/config.js`.

**Опорные функции.** `RELAY_BASE_URL` из `js/config.js`; `new RelayClient({ baseUrl })`; `RelayClient.health()`, `#request()`, `#requestOnce()`; `HEALTH_TIMEOUT_MS`, `HEALTH_RETRY_ATTEMPTS`; `isLanHealth()`, `getHealthInstruction()`, `LAN_INSTRUCTION`, `SERVER_INSTRUCTION`; начальный статус `checkHealth()` в `openNetworkLobbyModal`.

**Работа.**

1. `index.html`: добавить в `<head>` `<meta name="relay-base-url" content="">` с комментарием, что сюда вписывается HTTPS-адрес Render; обновить `description` и футер с «сеть по локальной сети» на «сеть через интернет». Версию 1.3.0 не менять.
   **Проверка:** `Select-String -Path index.html -Pattern 'name="relay-base-url"' -Quiet`; ожидаемо `True`.
2. `js/config.js`: прочитать meta, обрезать пробелы и завершающий `/`, определить same-origin (если origin настройки совпадает с `location.origin`, вернуть пустую строку), вернуть пустую строку в Node/без DOM. Экспортировать `RELAY_BASE_URL`. Никаких секретов в файле нет.
   **Проверка:** `node --check js/config.js`; затем `node --input-type=module -e "import('./js/config.js').then(m=>{if(m.RELAY_BASE_URL!=='')throw new Error('expected empty in Node')})"`; ожидаемо код выхода 0.
3. `js/main.js`: импортировать `RELAY_BASE_URL` и создавать `new RelayClient({ baseUrl: RELAY_BASE_URL })` вместо клиента без baseUrl. Не менять логику `?room=` и приглашений.
   **Проверка:** `Select-String -Path js/main.js -Pattern 'RELAY_BASE_URL' -Quiet`; ожидаемо `True`.
4. `js/net/protocol.js`: добавить `HEALTH_TIMEOUT_MS = 30000` и `HEALTH_RETRY_ATTEMPTS = 2`, не меняя таймауты игровых запросов.
   **Проверка:** `$p=Get-Content js/net/protocol.js -Raw; if($p -notmatch 'HEALTH_TIMEOUT_MS' -or $p -notmatch 'HEALTH_RETRY_ATTEMPTS'){throw 'health constants'}`; ожидаемо код выхода 0.
5. `js/net/relay-client.js`: добавить health-специфичные таймаут и число попыток; `health()` вызывает `#request` с `retry: true`, `timeoutMs` и `attempts`; `#request`/`#requestOnce` принимают таймаут на вызов. Остальные методы сохраняют прежние 8 с и 3 попытки.
   **Проверка:** `node --check js/net/relay-client.js`; ожидаемо код выхода 0.
6. `js/net/lobby.js`: заменить `LAN_INSTRUCTION` и `SERVER_INSTRUCTION` на тексты про сервер сетевой игры без `start-lan.cmd`; подзаголовок модалки — «Сетевая комната»; `checkHealth()` перед ожиданием выставляет статус «Проверяем сервер…» и перерисовывает модалку; `getHealthInstruction()` принимает `health.network === true` как доступный режим.
   **Проверка:** `if(Select-String -Path js/net/lobby.js -Pattern 'start-lan\.cmd' -Quiet){throw 'old instruction'}`; ожидаемо код выхода 0 без вывода.
7. `js/net/lobby.js`: сохранить поведение при недоступном relay — показывать «Сервер сетевой игры не отвечает…» и кнопку «Проверить снова»; локальная игра остаётся доступной. Не добавлять автоматический retry-цикл, который блокирует UI.
   **Проверка:** `node --check js/net/lobby.js`; ожидаемо код выхода 0.

**Гейт этапа.** Синтаксис всех изменённых модулей и проверка, что статика relay отдаёт новую настройку:

```powershell
$files='js/config.js','js/main.js','js/net/relay-client.js','js/net/protocol.js','js/net/lobby.js'; foreach($f in $files){ node --check $f; if($LASTEXITCODE -ne 0){ throw "syntax: $f" } }; node --input-type=module -e "import('./js/config.js').then(m=>{if(m.RELAY_BASE_URL!=='')throw new Error('expected empty in Node')})"; if($LASTEXITCODE -ne 0){ throw 'config' }; if(-not (Select-String -Path index.html -Pattern 'name="relay-base-url"' -Quiet)){ throw 'meta missing' }; if(-not (Select-String -Path js/main.js -Pattern 'RELAY_BASE_URL' -Quiet)){ throw 'main config missing' }; if(Select-String -Path js/net/lobby.js -Pattern 'start-lan\.cmd' -Quiet){ throw 'old instruction' }; $env:PORT='8792'; $env:HOST='127.0.0.1'; $env:FRONTEND_ORIGINS='https://sergeevevgeniy1988.github.io'; $p=Start-Process node -ArgumentList 'server/index.js' -PassThru -WindowStyle Hidden; try { Start-Sleep -Seconds 2; $s=Invoke-WebRequest 'http://127.0.0.1:8792/js/config.js' -UseBasicParsing; if($s.StatusCode -ne 200 -or $s.Content -notmatch 'RELAY_BASE_URL'){throw 'config static'}; $i=Invoke-WebRequest 'http://127.0.0.1:8792/' -UseBasicParsing; if($i.Content -notmatch 'relay-base-url'){throw 'meta static'}; 'OK' } finally { if(-not $p.HasExited){ Stop-Process -Id $p.Id -Force } }
```

- `git diff --check` — без вывода.
- Ожидаемо: команда печатает `OK`.

**Вне автоматической приёмки.** Реальный браузер, отрисовка модалки, фактический CORS из `https://sergeevevgeniy1988.github.io` и холодный старт Render проверяются только после деплоя; локальный смоук подтверждает синтаксис, наличие настройки и её раздачу.

### Этап 4

- [ ] **4.** Этап 4 — render.yaml, инструкция деплоя, README и сквозной смоук

**Результат.** В репозитории есть готовый Render Blueprint и пошаговая инструкция, README честно описывает интернет-прототип, а одна локальная команда проверяет весь путь от создания комнаты до закрытия. Фактический деплой остаётся за пользователем.

**Зависимость.** Этап 3.

**Файлы.** `Изменить:` `README.md`. `Создать/удалить:` `render.yaml`, `docs/RENDER.md`.

**Опорные функции.** Render Web Service: `type: web`, `runtime: node`, `plan: free`, `buildCommand: npm install`, `startCommand: npm start`, `healthCheckPath: /api/health`, env `HOST=0.0.0.0`, `FRONTEND_ORIGINS`, `ROOM_TTL_SECONDS`, `NODE_VERSION`; meta `relay-base-url`; смоук-сценарий комнаты.

**Работа.**

1. `render.yaml`: описать один web-сервис `thousand-relay`, ветку `main`, runtime Node, Free, команды сборки и запуска, health check `/api/health`, переменные `HOST=0.0.0.0`, `FRONTEND_ORIGINS=https://sergeevevgeniy1988.github.io`, `ROOM_TTL_SECONDS=120`, `NODE_VERSION=22`; не добавлять базы данных и диски.
   **Проверка:** `$y=Get-Content render.yaml -Raw; if($y -notmatch 'type:\s*web' -or $y -notmatch 'plan:\s*free' -or $y -notmatch 'startCommand:\s*npm start' -or $y -notmatch 'healthCheckPath:\s*/api/health' -or $y -notmatch 'FRONTEND_ORIGINS'){throw 'render.yaml'}`; ожидаемо код выхода 0.
2. `docs/RENDER.md`: описать создание аккаунта, `New → Web Service`, подключение GitHub-репозитория, ветку, runtime, build/start, Free, env, деплой, проверку `/api/health`, копирование адреса в meta `relay-base-url`, push в Pages, холодный старт, 410 после сна, CORS-ошибки и откат. Указать, что альтернатива — Blueprint из `render.yaml`.
   **Проверка:** `Select-String -Path docs/RENDER.md -Pattern 'New Web Service|FRONTEND_ORIGINS|relay-base-url|onrender.com' -Quiet`; ожидаемо `True`.
3. `README.md`: добавить раздел «Сетевая игра через интернет (Render)»: Pages — фронтенд, Render — relay, приглашения остаются на `github.io`, адрес relay задаётся в meta. Обновить ограничения (вкладка хоста, сон Render, комнаты в памяти, нет аккаунтов), безопасность (CORS только для Pages, токены в заголовке, HTTPS, без wildcard), структуру (`server/`, `js/config.js`, `docs/RENDER.md`) и раздел тестов (набор 1.3.0 не восстановлен, прототип проверяется смоук-командами). Не менять `PROMPT.md` и `ACCEPTANCE.md`.
   **Проверка:** `Select-String -Path README.md -Pattern 'Render|relay-base-url|FRONTEND_ORIGINS|CORS' -Quiet`; ожидаемо `True`.
4. `README.md`: явно указать, что без заполненного `relay-base-url` на Pages сетевой режим покажет недоступность сервера, а локальная игра продолжит работать; что relay не хранит данные и после сна Render комнаты исчезают.
   **Проверка:** `Select-String -Path README.md -Pattern 'relay-base-url|в памяти|засыпает' -Quiet`; ожидаемо `True`.
5. `docs/RENDER.md`: описать проверку после деплоя: открыть `https://<service>.onrender.com/api/health`, затем Pages, создать комнату, пригласить второй профиль браузера, проверить, что приглашение ведёт на `github.io`; отдельно описать, что при 403 нужно сверить Origin, при 404 — код комнаты, при 410 — комнату пересоздать. Это инструкция для пользователя, а не гейт.
   **Проверка:** `Select-String -Path docs/RENDER.md -Pattern '403|404|410' -Quiet`; ожидаемо `True`.

**Гейт этапа.** Сквозной локальный смоук: health, CORS, создание, join, publish, host poll, player poll, action, delta, close, плюс синтаксис всех файлов и чистота diff:

```powershell
$files='server/config.js','server/relay.js','server/http.js','server/index.js','js/config.js','js/main.js','js/net/relay-client.js','js/net/protocol.js','js/net/lobby.js'; foreach($f in $files){ node --check $f; if($LASTEXITCODE -ne 0){ throw "syntax: $f" } }; $y=Get-Content render.yaml -Raw; if($y -notmatch 'type:\s*web' -or $y -notmatch 'plan:\s*free' -or $y -notmatch 'startCommand:\s*npm start' -or $y -notmatch 'FRONTEND_ORIGINS'){ throw 'render.yaml' }; if(-not (Select-String -Path docs/RENDER.md -Pattern 'New Web Service|relay-base-url' -Quiet)){ throw 'render docs' }; if(-not (Select-String -Path README.md -Pattern 'Render|relay-base-url' -Quiet)){ throw 'readme' }; $env:PORT='8793'; $env:HOST='127.0.0.1'; $env:FRONTEND_ORIGINS='https://sergeevevgeniy1988.github.io'; $p=Start-Process node -ArgumentList 'server/index.js' -PassThru -WindowStyle Hidden; try { Start-Sleep -Seconds 2; $h=Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8793/api/rooms' -ContentType 'application/json' -Body '{"name":"Host"}'; $g=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8793/api/rooms/$($h.roomCode)/join" -ContentType 'application/json' -Body '{"name":"Guest"}'; $pub=@{version=1;started=$true;gameReset=$true;logEpoch=1;views=@{human=@{viewerId='human'};alice=@{viewerId='alice'};boris=@{viewerId='boris'}};log=@(@{type='dealstarted'});messages=@{alice=@(@{code='hello';message='hi'})}} | ConvertTo-Json -Depth 12; Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8793/api/rooms/$($h.roomCode)/publish" -Headers @{'X-Room-Token'=$h.token} -ContentType 'application/json' -Body $pub | Out-Null; $hp=Invoke-RestMethod -Uri "http://127.0.0.1:8793/api/rooms/$($h.roomCode)/host?actionSince=0&lobbySince=0" -Headers @{'X-Room-Token'=$h.token}; if($hp.cursor -ne 0){throw 'host'}; $gp=Invoke-RestMethod -Uri "http://127.0.0.1:8793/api/rooms/$($h.roomCode)/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0" -Headers @{'X-Room-Token'=$g.token}; if($gp.view.viewerId -ne 'alice'){throw 'player'}; $a=Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8793/api/rooms/$($h.roomCode)/action" -Headers @{'X-Room-Token'=$g.token} -ContentType 'application/json' -Body '{"actionId":"a1","type":"pass","payload":{}}'; if($a.seq -ne 1){throw 'action'}; $o=Invoke-WebRequest -Method Options -Uri 'http://127.0.0.1:8793/api/rooms' -Headers @{Origin='https://sergeevevgeniy1988.github.io';'Access-Control-Request-Method'='POST';'Access-Control-Request-Headers'='content-type,x-room-token'} -UseBasicParsing; if($o.StatusCode -ne 204){throw 'cors'}; $s=Invoke-WebRequest 'http://127.0.0.1:8793/' -UseBasicParsing; if($s.StatusCode -ne 200 -or $s.Content -notmatch 'relay-base-url'){throw 'static'}; Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8793/api/rooms/$($h.roomCode)/close" -Headers @{'X-Room-Token'=$h.token} -ContentType 'application/json' -Body '{}' | Out-Null; 'OK' } finally { if(-not $p.HasExited){ Stop-Process -Id $p.Id -Force } }
```

- `git diff --check` — без вывода.
- Ожидаемо: команда печатает `OK`.

**Вне автоматической приёмки.** Фактический деплой на Render, холодный старт, HTTPS-сертификат, CORS из настоящего браузера на Pages и игра из двух разных сетей проверяются пользователем по `docs/RENDER.md`; локальный смоук не заменяет эту проверку.

## 4. Риски и откат

- **CORS отклоняет Pages.** Неверный origin (схема, порт, слэш) блокирует все запросы. Влияние: сетевой режим не работает, локальная игра цела. Мера: точный allowlist, `Vary: Origin`, проверить preflight и чужой Origin. Откат: очистить `relay-base-url` в `index.html` и вернуть клиент на same-origin; либо откатить коммит.
- **Холодный старт Render дольше health-таймаута.** Первый запрос после сна может занять около минуты. Влияние: лобби показывает недоступность, пользователь повторяет. Мера: `HEALTH_TIMEOUT_MS` и две попытки, статус «Проверяем сервер…», инструкция в `docs/RENDER.md`. Откат: перейти на VPS или Render Starter без изменения кода.
- **Render засыпает и теряет комнаты.** Это ожидаемо: комнаты в памяти, TTL 120 с. Влияние: текущая партия завершается, гости получают 410. Мера: документировать и создавать новую комнату. Откат: не требуется, данные не хранятся.
- **Публичный relay используют посторонние.** Возможен спам комнатами и памятью. Влияние: лимит комнат, отказ в создании, деградация. Мера: `MAX_ROOMS`, лимиты тела и очереди, базовая защита по IP при создании/join, отсутствие секретов в ответах. Откат: приостановить сервис в Render; Pages продолжит работать локально.
- **Утечка токенов.** Токены в URL, логах или ответах чужому месту. Влияние: захват места. Мера: только `X-Room-Token`, timing-safe сравнение, логи без заголовков и тел, player view только для своего места. Откат: закрыть комнату/сервис, перевыпустить токены новой комнатой.
- **Ошибка в TTL.** Комната живёт вечно или умирает слишком рано. Влияние: память или обрыв партии. Мера: проверка TTL на каждом доступе до обновления `hostLastSeen`, смоук с `ROOM_TTL_SECONDS=2`. Откат: увеличить TTL через env без изменения кода.
- **Path traversal в статике.** Чтение `server/` или файлов вне корня. Влияние: раскрытие кода (секретов там нет). Мера: allowlist `/`, `/index.html`, `/css/`, `/js/`, `/favicon.svg`, запрет `..` и dot-файлов, проверка `curl --path-as-is`. Откат: отключить `SERVE_STATIC` на Render.
- **Preflight на каждый меняющийся query.** Больше запросов и задержка. Влияние: замедление polling. Мера: `Access-Control-Max-Age: 600`, точные заголовки; при проблемах открывать игру прямо с Render-домена (same-origin). Откат: перевести фронтенд на Render целиком.
- **Пользователь не заполнил `relay-base-url`.** Pages остаётся без relay. Влияние: сетевая игра недоступна, локальная работает. Мера: явное сообщение в README и `docs/RENDER.md`, статус в лобби. Откат: заполнить meta и перепубликовать Pages.
- **Node/ESM на Render.** Несовпадение версии или пути запуска. Влияние: сервис не стартует. Мера: `engines.node >=18`, `NODE_VERSION=22`, `startCommand: npm start`, проверка `/api/health`. Откат: изменить env/команду в Render или вернуть предыдущий деплой.
- **Совместимость с игровым ядром.** Relay передаёт непрозрачный JSON, но неверные дельты ломают гостя. Влияние: гость не видит обновления. Мера: контракты `host/player/publish` из этапа 2 и сквозной смоук; ядро не менять. Откат: отключить сетевой режим, вернуть `relay-base-url` в пустую строку.
