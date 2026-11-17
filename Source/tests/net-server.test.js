import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import test, { after, afterEach, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(sourceDir, 'tools', 'serve.ps1');

let sharedServer = null;
let sharedGetOutput = () => '';
let baseUrl = '';
let sharedPort = 0;
const trackedRooms = [];

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function tryListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

async function findFreePort() {
  for (let port = 8765; port <= 8785; port += 1) {
    if (await tryListen(port)) {
      return port;
    }
  }

  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function startServerProcess(args) {
  const child = spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      serverScript,
      ...args,
    ],
    {
      cwd: sourceDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let output = '';
  const collect = (chunk) => {
    output += chunk.toString('utf8');
  };

  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  return {
    child,
    getOutput: () => output,
  };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (!settled) {
        settled = true;

        if (timer) {
          clearTimeout(timer);
        }

        resolve();
      }
    };

    child.once('exit', finish);
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
    });

    if (!settled) {
      timer = setTimeout(finish, 3000);
    }
  });
}

function waitForExit(child, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }

    const timer = setTimeout(() => resolve(null), timeoutMs);

    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForHealth(origin, child, getOutput) {
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early: ${getOutput()}`);
    }

    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });

      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Server is still starting.
    }

    await delay(150);
  }

  throw new Error(`server did not start: ${getOutput()}`);
}

async function requestAt(origin, pathname, options = {}) {
  const headers = { ...(options.headers ?? {}) };

  if (options.token) {
    headers['X-Room-Token'] = options.token;
  }

  const init = {
    method: options.method ?? 'GET',
    headers,
    signal: AbortSignal.timeout(10000),
  };

  if (options.body !== undefined) {
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);

    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const response = await fetch(origin + pathname, init);
  const text = await response.text();
  let json = null;

  if (text !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
  };
}

function api(pathname, options = {}) {
  return requestAt(baseUrl, pathname, options);
}

function rawRequest(port, payload, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      reject(new Error('raw request timed out'));
    }, timeout);

    socket.on('connect', () => {
      socket.write(payload);
    });

    socket.on('data', (chunk) => {
      chunks.push(chunk);
    });

    socket.on('end', () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });

    socket.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function parseRawResponse(buffer) {
  const text = buffer.toString('utf8');
  const divider = text.indexOf('\r\n\r\n');
  const head = divider >= 0 ? text.slice(0, divider) : text;
  const lines = head.split('\r\n');
  const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '');

  return {
    status: statusMatch ? Number(statusMatch[1]) : 0,
    headerLines: lines.slice(1),
    body: divider >= 0 ? text.slice(divider + 4) : '',
  };
}

function rawGet(port, requestPath, extraHeaders = '') {
  const payload =
    `GET ${requestPath} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    'Connection: close\r\n' +
    extraHeaders +
    '\r\n';

  return rawRequest(port, payload);
}

async function createRoom(name = 'Host') {
  const response = await api('/api/rooms', {
    method: 'POST',
    body: { name },
  });

  assert.equal(response.status, 200, response.text);
  trackedRooms.push({
    code: response.json.roomCode,
    token: response.json.token,
  });
  return response.json;
}

async function joinRoom(roomCode, name) {
  const response = await api(`/api/rooms/${roomCode}/join`, {
    method: 'POST',
    body: { name },
  });

  assert.equal(response.status, 200, response.text);
  return response.json;
}

before(async () => {
  if (!isWindows) {
    return;
  }

  sharedPort = await findFreePort();
  baseUrl = `http://127.0.0.1:${sharedPort}`;

  const started = startServerProcess([
    '-Lan',
    '-BindAddress',
    '127.0.0.1',
    '-Port',
    String(sharedPort),
    '-NoBrowser',
  ]);

  sharedServer = started.child;
  sharedGetOutput = started.getOutput;
  await waitForHealth(baseUrl, sharedServer, sharedGetOutput);
});

afterEach(async () => {
  if (!isWindows) {
    return;
  }

  while (trackedRooms.length > 0) {
    const room = trackedRooms.pop();

    try {
      await api(`/api/rooms/${room.code}/close`, {
        method: 'POST',
        token: room.token,
        body: {},
      });
    } catch {
      // The room can already be closed or expired.
    }
  }
});

after(async () => {
  await stopServer(sharedServer);
});

test('health reports LAN mode, version and no CORS headers', { skip: !isWindows }, async () => {
  const response = await api('/api/health');

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.lan, true);
  assert.equal(response.json.bindAddress, '127.0.0.1');
  assert.equal(response.json.port, sharedPort);
  assert.equal(response.json.lanUrl, `${baseUrl}/`);
  assert.equal(typeof response.json.version, 'string');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('create room and join guests in seat order, third guest gets 409', { skip: !isWindows }, async () => {
  const host = await createRoom('Хост');

  assert.match(host.roomCode, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(host.playerId, 'human');
  assert.match(host.token, /^[0-9a-f]{64}$/);
  assert.equal(host.lobby.started, false);
  assert.equal(host.lobby.maxPlayers, 3);
  assert.equal(host.lobby.seats.filter((seat) => seat.occupied).length, 1);

  const alice = await joinRoom(host.roomCode, 'Алиса');
  const boris = await joinRoom(host.roomCode, 'Борис');

  assert.equal(alice.playerId, 'alice');
  assert.equal(boris.playerId, 'boris');
  assert.notEqual(alice.token, boris.token);
  assert.match(alice.token, /^[0-9a-f]{64}$/);

  const fullLobby = await api(`/api/rooms/${host.roomCode}/host?actionSince=0&lobbySince=0`, {
    token: host.token,
  });

  assert.equal(fullLobby.status, 200);
  assert.equal(fullLobby.json.lobby.seats.filter((seat) => seat.occupied).length, 3);
  assert.equal(fullLobby.json.lobby.seats[1].name, 'Алиса');
  assert.equal(fullLobby.json.lobby.seats[2].name, 'Борис');

  const third = await api(`/api/rooms/${host.roomCode}/join`, {
    method: 'POST',
    body: { name: 'Третий' },
  });

  assert.equal(third.status, 409);
  assert.equal(third.json.error, 'room_full');
});

test('room names are trimmed, unique and limited to 24 characters', { skip: !isWindows }, async () => {
  const host = await createRoom('Host');
  await joinRoom(host.roomCode, 'Guest');

  const duplicate = await api(`/api/rooms/${host.roomCode}/join`, {
    method: 'POST',
    body: { name: 'guest' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error, 'name_taken');

  const tooLong = await api(`/api/rooms/${host.roomCode}/join`, {
    method: 'POST',
    body: { name: 'a'.repeat(25) },
  });
  assert.equal(tooLong.status, 400);

  const empty = await api(`/api/rooms/${host.roomCode}/join`, {
    method: 'POST',
    body: { name: '   ' },
  });
  assert.equal(empty.status, 400);

  const controlCharacter = await api(`/api/rooms/${host.roomCode}/join`, {
    method: 'POST',
    body: { name: 'bad\nname' },
  });
  assert.equal(controlCharacter.status, 400);
});

test('publish stores per-player views, log and targeted messages with deltas', { skip: !isWindows }, async () => {
  const host = await createRoom('Host');
  const guest = await joinRoom(host.roomCode, 'Guest');
  const boris = await joinRoom(host.roomCode, 'Boris');

  const humanView = { viewerId: 'human', hand: [{ id: 'h1' }] };
  const guestView = { viewerId: 'alice', hand: [{ id: 'a1' }], hidden: true };

  const publish = await api(`/api/rooms/${host.roomCode}/publish`, {
    method: 'POST',
    token: host.token,
    body: {
      version: 1,
      started: true,
      gameReset: false,
      views: {
        human: humanView,
        alice: guestView,
      },
      log: [{ type: 'announce', text: 'Deal 1' }],
      messages: {
        alice: [{ code: 'welcome', message: 'Hello' }],
      },
    },
  });

  assert.equal(publish.status, 200, publish.text);
  assert.equal(publish.json.version, 1);
  assert.equal(publish.json.started, true);
  assert.equal(publish.json.gameReset, false);
  assert.equal(publish.json.duplicate, false);
  assert.equal(publish.json.log.length, 1);
  assert.equal(publish.json.log[0].seq, 1);
  assert.equal(publish.json.messages.alice.length, 1);
  assert.equal(publish.json.messages.alice[0].seq, 1);
  assert.equal(publish.text.includes(host.token), false, 'publish must not echo the host token');

  const firstPoll = await api(
    `/api/rooms/${host.roomCode}/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0`,
    { token: guest.token },
  );

  assert.equal(firstPoll.status, 200, firstPoll.text);
  assert.deepEqual(firstPoll.json.view, guestView);
  assert.equal(firstPoll.json.viewVersion, 1);
  assert.equal(firstPoll.json.started, true);
  assert.equal(firstPoll.json.lobby.started, true);
  assert.equal(firstPoll.json.log.length, 1);
  assert.equal(firstPoll.json.log[0].entry.text, 'Deal 1');
  assert.equal(firstPoll.json.messages.length, 1);
  assert.equal(firstPoll.json.messages[0].payload.code, 'welcome');
  assert.equal(firstPoll.text.includes(guest.token), false, 'player polls must not echo tokens');
  assert.equal(firstPoll.text.includes(host.token), false, 'player polls must not echo foreign tokens');
  assert.equal(firstPoll.text.includes(boris.token), false, 'player polls must not echo foreign tokens');

  const hostPlayerPoll = await api(
    `/api/rooms/${host.roomCode}/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0`,
    { token: host.token },
  );
  assert.equal(hostPlayerPoll.status, 200);
  assert.deepEqual(hostPlayerPoll.json.view, humanView);

  const borisPoll = await api(
    `/api/rooms/${host.roomCode}/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0`,
    { token: boris.token },
  );
  assert.equal(borisPoll.status, 200);
  assert.equal(Object.hasOwn(borisPoll.json, 'view'), false);
  assert.deepEqual(borisPoll.json.messages, []);

  const lateJoin = await api(`/api/rooms/${host.roomCode}/join`, {
    method: 'POST',
    body: { name: 'Late' },
  });
  assert.equal(lateJoin.status, 409);
  assert.equal(lateJoin.json.error, 'game_started');

  const deltaPoll = await api(
    `/api/rooms/${host.roomCode}/player?viewSince=1&logSince=1&logEpoch=0&messageSince=1`,
    { token: guest.token },
  );

  assert.equal(deltaPoll.status, 200);
  assert.equal(Object.hasOwn(deltaPoll.json, 'view'), false);
  assert.deepEqual(deltaPoll.json.log, []);
  assert.deepEqual(deltaPoll.json.messages, []);

  const duplicate = await api(`/api/rooms/${host.roomCode}/publish`, {
    method: 'POST',
    token: host.token,
    body: { version: 1, views: { alice: { tampered: true } } },
  });

  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.duplicate, true);
  assert.deepEqual(duplicate.json.log, []);

  const nextVersion = await api(`/api/rooms/${host.roomCode}/publish`, {
    method: 'POST',
    token: host.token,
    body: { version: 2, views: { alice: { viewerId: 'alice', hand: [] } } },
  });
  assert.equal(nextVersion.status, 200);

  const staleVersion = await api(`/api/rooms/${host.roomCode}/publish`, {
    method: 'POST',
    token: host.token,
    body: { version: 1, views: {} },
  });
  assert.equal(staleVersion.status, 409);
  assert.equal(staleVersion.json.error, 'stale_version');

  const guestCannotPublish = await api(`/api/rooms/${host.roomCode}/publish`, {
    method: 'POST',
    token: guest.token,
    body: { version: 3 },
  });
  assert.equal(guestCannotPublish.status, 403);
  assert.equal(guestCannotPublish.json.error, 'not_host');
});

test('action queue is player-scoped, retries are idempotent and bad tokens do not mutate', { skip: !isWindows }, async () => {
  const host = await createRoom('Host');
  const guest = await joinRoom(host.roomCode, 'Guest');

  const action = await api(`/api/rooms/${host.roomCode}/action`, {
    method: 'POST',
    token: guest.token,
    body: {
      actionId: 'action-1',
      type: 'bid',
      payload: { amount: 100, playerId: 'boris' },
    },
  });

  assert.equal(action.status, 200, action.text);
  assert.equal(action.json.ok, true);
  assert.equal(action.json.seq, 1);

  const retry = await api(`/api/rooms/${host.roomCode}/action`, {
    method: 'POST',
    token: guest.token,
    body: {
      actionId: 'action-1',
      type: 'bid',
      payload: { amount: 100 },
    },
  });

  assert.equal(retry.status, 200);
  assert.equal(retry.json.seq, 1);

  const invalidToken = await api(`/api/rooms/${host.roomCode}/action`, {
    method: 'POST',
    token: '0'.repeat(64),
    body: {
      actionId: 'forged',
      type: 'playCard',
      payload: {},
    },
  });

  assert.equal(invalidToken.status, 401);
  assert.equal(invalidToken.json.error, 'invalid_token');

  const hostPoll = await api(`/api/rooms/${host.roomCode}/host?actionSince=0&lobbySince=0`, {
    token: host.token,
  });

  assert.equal(hostPoll.status, 200);
  assert.equal(hostPoll.json.actions.length, 1);
  assert.equal(hostPoll.json.actions[0].seq, 1);
  assert.equal(hostPoll.json.actions[0].playerId, 'alice');
  assert.equal(hostPoll.json.actions[0].type, 'bid');
  assert.equal(hostPoll.json.actions[0].payload.amount, 100);
  assert.equal(hostPoll.json.cursor, 1);

  const noNewActions = await api(`/api/rooms/${host.roomCode}/host?actionSince=1&lobbySince=0`, {
    token: host.token,
  });

  assert.equal(noNewActions.status, 200);
  assert.deepEqual(noNewActions.json.actions, []);

  const guestPoll = await api(
    `/api/rooms/${host.roomCode}/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0`,
    { token: guest.token },
  );
  assert.equal(guestPoll.status, 200);
});

test('action queue is limited to one hundred entries', { skip: !isWindows }, async () => {
  const host = await createRoom('Host');
  const guest = await joinRoom(host.roomCode, 'Guest');

  for (let index = 0; index < 100; index += 1) {
    const response = await api(`/api/rooms/${host.roomCode}/action`, {
      method: 'POST',
      token: guest.token,
      body: {
        actionId: `action-${index}`,
        type: 'bid',
        payload: { index },
      },
    });

    assert.equal(response.status, 200, `action ${index}: ${response.text}`);
  }

  const overflow = await api(`/api/rooms/${host.roomCode}/action`, {
    method: 'POST',
    token: guest.token,
    body: {
      actionId: 'action-overflow',
      type: 'bid',
      payload: {},
    },
  });

  assert.equal(overflow.status, 429);
  assert.equal(overflow.json.error, 'action_queue_full');
});

test('kick and leave free guest seats and invalidate their tokens', { skip: !isWindows }, async () => {
  const host = await createRoom('Host');
  const alice = await joinRoom(host.roomCode, 'Alice');
  const boris = await joinRoom(host.roomCode, 'Boris');

  const kick = await api(`/api/rooms/${host.roomCode}/kick`, {
    method: 'POST',
    token: host.token,
    body: { playerId: 'alice' },
  });

  assert.equal(kick.status, 200, kick.text);
  assert.equal(kick.json.lobby.seats.find((seat) => seat.playerId === 'alice').occupied, false);

  const kickedPoll = await api(
    `/api/rooms/${host.roomCode}/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0`,
    { token: alice.token },
  );
  assert.equal(kickedPoll.status, 401);

  const kickHost = await api(`/api/rooms/${host.roomCode}/kick`, {
    method: 'POST',
    token: host.token,
    body: { playerId: 'human' },
  });
  assert.equal(kickHost.status, 403);

  const leave = await api(`/api/rooms/${host.roomCode}/leave`, {
    method: 'POST',
    token: boris.token,
  });

  assert.equal(leave.status, 200);
  assert.equal(leave.json.lobby.seats.find((seat) => seat.playerId === 'boris').occupied, false);

  const leftPoll = await api(
    `/api/rooms/${host.roomCode}/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0`,
    { token: boris.token },
  );
  assert.equal(leftPoll.status, 401);

  const rejoined = await joinRoom(host.roomCode, 'Alice Again');
  assert.equal(rejoined.playerId, 'alice');
});

test('closed rooms return 410 for every room route', { skip: !isWindows }, async () => {
  const host = await createRoom('Host');
  const guest = await joinRoom(host.roomCode, 'Guest');

  const close = await api(`/api/rooms/${host.roomCode}/close`, {
    method: 'POST',
    token: host.token,
    body: {},
  });

  assert.equal(close.status, 200);
  assert.equal(close.json.ok, true);

  const hostPoll = await api(`/api/rooms/${host.roomCode}/host`, { token: host.token });
  assert.equal(hostPoll.status, 410);
  assert.equal(hostPoll.json.error, 'room_closed');

  const join = await api(`/api/rooms/${host.roomCode}/join`, {
    method: 'POST',
    body: { name: 'Late' },
  });
  assert.equal(join.status, 410);

  const playerPoll = await api(
    `/api/rooms/${host.roomCode}/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0`,
    { token: guest.token },
  );
  assert.equal(playerPoll.status, 410);
});

test('bad JSON, missing publish version and bad query parameters return 400', { skip: !isWindows }, async () => {
  const badJson = await api('/api/rooms', {
    method: 'POST',
    body: '{"name":',
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error, 'bad_json');

  const host = await createRoom('Host');

  const missingVersion = await api(`/api/rooms/${host.roomCode}/publish`, {
    method: 'POST',
    token: host.token,
    body: { started: true },
  });
  assert.equal(missingVersion.status, 400);
  assert.equal(missingVersion.json.error, 'bad_version');

  const badQuery = await api(`/api/rooms/${host.roomCode}/host?actionSince=oops`, {
    token: host.token,
  });
  assert.equal(badQuery.status, 400);
  assert.equal(badQuery.json.error, 'bad_query');

  const badAction = await api(`/api/rooms/${host.roomCode}/action`, {
    method: 'POST',
    token: host.token,
    body: { actionId: '', type: 'bid' },
  });
  assert.equal(badAction.status, 400);
  assert.equal(badAction.json.error, 'bad_action');

  const invalidPublish = await api(`/api/rooms/${host.roomCode}/publish`, {
    method: 'POST',
    token: host.token,
    body: {
      version: 2,
      started: true,
      log: [{ text: 'should-not-apply' }],
      messages: { alice: 'not-an-array' },
    },
  });
  assert.equal(invalidPublish.status, 400);
  assert.equal(invalidPublish.json.error, 'bad_publish');

  const unchanged = await api(
    `/api/rooms/${host.roomCode}/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0`,
    { token: host.token },
  );
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.json.started, false);
  assert.deepEqual(unchanged.json.log, []);
});

test('request body over 512 KiB is rejected with 413', { skip: !isWindows }, async () => {
  const payload =
    'POST /api/rooms HTTP/1.1\r\n' +
    `Host: 127.0.0.1:${sharedPort}\r\n` +
    `Origin: http://127.0.0.1:${sharedPort}\r\n` +
    'Content-Type: application/json\r\n' +
    'Content-Length: 524289\r\n' +
    'Connection: close\r\n' +
    '\r\n';

  const response = parseRawResponse(await rawRequest(sharedPort, payload));
  assert.equal(response.status, 413);
});

test('path traversal is blocked while static files, MIME and HEAD still work', { skip: !isWindows }, async () => {
  const traversal = parseRawResponse(await rawGet(sharedPort, '/..%2fpackage.json'));
  assert.equal(traversal.status, 403);

  const nestedTraversal = parseRawResponse(await rawGet(sharedPort, '/%2e%2e/%2e%2e/Windows/win.ini'));
  assert.equal(nestedTraversal.status, 403);

  const index = await api('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal(index.headers.get('cache-control'), 'no-store');
  assert.match(index.text, /<html/i);

  const head = await api('/js/main.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.match(head.headers.get('content-type'), /javascript/);

  const postStatic = await api('/', { method: 'POST' });
  assert.equal(postStatic.status, 405);
});

test('Host, Origin and CORS checks reject foreign requests', { skip: !isWindows }, async () => {
  const badHost =
    'GET /api/health HTTP/1.1\r\n' +
    'Host: evil.example:8765\r\n' +
    'Connection: close\r\n' +
    '\r\n';
  assert.equal(parseRawResponse(await rawRequest(sharedPort, badHost)).status, 403);

  const missingHost = 'GET /api/health HTTP/1.1\r\nConnection: close\r\n\r\n';
  assert.equal(parseRawResponse(await rawRequest(sharedPort, missingHost)).status, 400);

  const body = '{"name":"Host"}';
  const badOrigin =
    'POST /api/rooms HTTP/1.1\r\n' +
    `Host: 127.0.0.1:${sharedPort}\r\n` +
    'Origin: http://evil.example\r\n' +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n' +
    '\r\n' +
    body;
  assert.equal(parseRawResponse(await rawRequest(sharedPort, badOrigin)).status, 403);

  const preflight =
    'OPTIONS /api/rooms HTTP/1.1\r\n' +
    `Host: 127.0.0.1:${sharedPort}\r\n` +
    `Origin: http://127.0.0.1:${sharedPort}\r\n` +
    'Connection: close\r\n' +
    '\r\n';
  const preflightResponse = parseRawResponse(await rawRequest(sharedPort, preflight));
  assert.equal(preflightResponse.status, 405);
  assert.equal(
    preflightResponse.headerLines.some((line) => /^access-control-/i.test(line)),
    false,
  );
});

test('room tokens are accepted only from X-Room-Token, never from the query string', { skip: !isWindows }, async () => {
  const host = await createRoom('Host');
  const guest = await joinRoom(host.roomCode, 'Guest');

  const queryOnly = await api(`/api/rooms/${host.roomCode}/host?actionSince=0&token=${host.token}`);

  assert.equal(queryOnly.status, 401);
  assert.equal(queryOnly.json.error, 'missing_token');

  const queryPlayer = await api(
    `/api/rooms/${host.roomCode}/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0&token=${guest.token}`,
  );

  assert.equal(queryPlayer.status, 401);
  assert.equal(queryPlayer.json.error, 'missing_token');

  const queryAction = await api(
    `/api/rooms/${host.roomCode}/action?token=${guest.token}`,
    {
      method: 'POST',
      body: { actionId: 'query-token', type: 'bid', payload: { amount: 80 } },
    },
  );

  assert.equal(queryAction.status, 401);
  assert.equal(queryAction.json.error, 'missing_token');
  assert.equal(
    (await api(`/api/rooms/${host.roomCode}/host?actionSince=0`, { token: host.token })).json.actions.length,
    0,
    'a query token must not enqueue anything',
  );
});

test('LAN mode refuses a public bind address instead of listening on it', { skip: !isWindows }, async () => {
  const port = await findFreePort();
  const started = startServerProcess([
    '-Lan',
    '-BindAddress',
    '8.8.8.8',
    '-Port',
    String(port),
    '-NoBrowser',
  ]);
  const code = await waitForExit(started.child);

  assert.equal(code, 1);
  assert.match(
    started.getOutput(),
    /not a private IPv4 address|Public bind addresses are refused/i,
  );
});


test('room limit opens at most eight rooms', { skip: !isWindows }, async () => {
  for (let index = 0; index < 8; index += 1) {
    await createRoom(`Host ${index}`);
  }

  const overflow = await api('/api/rooms', {
    method: 'POST',
    body: { name: 'Overflow' },
  });

  assert.equal(overflow.status, 429);
  assert.equal(overflow.json.error, 'too_many_rooms');
});

test('targeted messages are capped at fifty per player', { skip: !isWindows }, async () => {
  const host = await createRoom('Host');
  const guest = await joinRoom(host.roomCode, 'Guest');
  const messages = Array.from({ length: 55 }, (_, index) => ({
    code: 'message',
    message: `#${index + 1}`,
  }));

  const publish = await api(`/api/rooms/${host.roomCode}/publish`, {
    method: 'POST',
    token: host.token,
    body: {
      version: 1,
      messages: { alice: messages },
    },
  });

  assert.equal(publish.status, 200, publish.text);

  const poll = await api(
    `/api/rooms/${host.roomCode}/player?viewSince=0&logSince=0&logEpoch=0&messageSince=0`,
    { token: guest.token },
  );

  assert.equal(poll.status, 200);
  assert.equal(poll.json.messages.length, 50);
  assert.equal(poll.json.messages[0].seq, 6);
  assert.equal(poll.json.messages[49].seq, 55);
  assert.equal(poll.json.messageTotal, 55);
});

test('server console never prints room tokens or player names', { skip: !isWindows }, async () => {
  const hostName = `SecretHost${Date.now()}`;
  const guestName = 'SecretGuest';
  const host = await createRoom(hostName);
  const guest = await joinRoom(host.roomCode, guestName);

  await delay(200);
  const output = sharedGetOutput();

  assert.equal(output.includes(host.token), false);
  assert.equal(output.includes(guest.token), false);
  assert.equal(output.includes(hostName), false);
  assert.equal(output.includes(guestName), false);
});

test('expired room returns 410 after the TTL', { skip: !isWindows }, async () => {
  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const started = startServerProcess([
    '-Lan',
    '-BindAddress',
    '127.0.0.1',
    '-Port',
    String(port),
    '-NoBrowser',
    '-RoomTtlSeconds',
    '1',
  ]);

  try {
    await waitForHealth(origin, started.child, started.getOutput);

    const created = await requestAt(origin, '/api/rooms', {
      method: 'POST',
      body: { name: 'Host' },
    });
    assert.equal(created.status, 200, created.text);

    await delay(2500);

    const hostPoll = await requestAt(
      origin,
      `/api/rooms/${created.json.roomCode}/host?actionSince=0&lobbySince=0`,
      { token: created.json.token },
    );
    assert.equal(hostPoll.status, 410);
    assert.equal(hostPoll.json.error, 'room_closed');

    const join = await requestAt(origin, `/api/rooms/${created.json.roomCode}/join`, {
      method: 'POST',
      body: { name: 'Late' },
    });
    assert.equal(join.status, 410);
  } finally {
    await stopServer(started.child);
  }
});

test('non-LAN mode serves the game on loopback with lan:false and no room API', { skip: !isWindows }, async () => {
  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const started = startServerProcess(['-NoBrowser', '-Port', String(port)]);

  try {
    const health = await waitForHealth(origin, started.child, started.getOutput);

    assert.equal(health.ok, true);
    assert.equal(health.lan, false);
    assert.equal(health.bindAddress, '127.0.0.1');
    assert.equal(health.port, port);
    assert.equal(health.lanUrl, `${origin}/`);

    const index = await requestAt(origin, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(index.text, /<html/i);

    const rooms = await requestAt(origin, '/api/rooms', {
      method: 'POST',
      body: { name: 'Host' },
    });
    assert.equal(rooms.status, 404);
  } finally {
    await stopServer(started.child);
  }
});
