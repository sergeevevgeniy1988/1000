import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testsDir, '..');

/**
 * @param {string} relativePath
 * @returns {string}
 */
function readSource(relativePath) {
  return readFileSync(path.join(sourceDir, relativePath), 'utf8');
}

/**
 * @param {string} directory
 * @param {(filePath: string) => boolean} [filter]
 * @returns {string[]} Absolute file paths.
 */
function listFiles(directory, filter = () => true) {
  const result = [];
  const entries = readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      result.push(...listFiles(absolute, filter));
    } else if (filter(absolute)) {
      result.push(absolute);
    }
  }

  return result;
}

const netFiles = listFiles(path.join(sourceDir, 'js', 'net'), (file) => file.endsWith('.js'));
const sessionFiles = listFiles(path.join(sourceDir, 'js', 'session'), (file) => file.endsWith('.js'));
const allJsFiles = listFiles(path.join(sourceDir, 'js'), (file) => file.endsWith('.js'));
const toolFiles = listFiles(path.join(sourceDir, 'tools'), (file) => file.endsWith('.ps1'));

/**
 * @param {string[]} files
 * @returns {Array<{ file: string, text: string }>}
 */
function readAll(files) {
  return files.map((file) => ({
    file: path.relative(sourceDir, file),
    text: readFileSync(file, 'utf8'),
  }));
}

test('LAN sources never emit CORS headers', () => {
  assert.ok(netFiles.length > 0);
  assert.ok(toolFiles.length > 0);

  for (const { file, text } of readAll([...netFiles, ...toolFiles])) {
    assert.doesNotMatch(text, /access-control-/i, `${file} must not emit CORS headers`);
  }
});

test('room tokens travel only in the X-Room-Token header', () => {
  const relayClient = readSource('js/net/relay-client.js');
  const protocol = readSource('js/net/protocol.js');

  assert.match(relayClient, /headers\['X-Room-Token'\] = token/);

  for (const { file, text } of readAll(allJsFiles)) {
    assert.doesNotMatch(text, /[?&]token=/i, `${file} must not put a token in a URL`);
    assert.doesNotMatch(text, /searchParams\.set\(\s*['"]token/i, `${file} must not put a token in a URL`);
    assert.doesNotMatch(text, /params\.set\(\s*['"]token/i, `${file} must not put a token in a URL`);

    for (const line of text.split(/\r?\n/)) {
      if (/console\./.test(line)) {
        assert.doesNotMatch(line, /token/i, `${file} must not log tokens`);
      }
    }
  }

  // The invite link carries only the room code.
  assert.match(protocol, /\?room=\$\{encodeURIComponent\(normalized\)\}/);
  assert.doesNotMatch(protocol, /token=\$\{/i);

  const locationUsers = readAll([
    ...netFiles,
    ...sessionFiles,
    path.join(sourceDir, 'js', 'main.js'),
  ]);

  for (const { file, text } of locationUsers) {
    assert.doesNotMatch(text, /location\.href\s*=/, `${file} must not rewrite location.href`);
    assert.doesNotMatch(text, /location\.search\s*=/, `${file} must not rewrite location.search`);
    assert.doesNotMatch(text, /location\.(?:assign|replace)\(/, `${file} must not navigate with a token`);
    assert.doesNotMatch(text, /history\.(?:push|replace)State\(/, `${file} must not rewrite history`);

    for (const line of text.split(/\r?\n/)) {
      if (/console\./.test(line)) {
        assert.doesNotMatch(line, /token/i, `${file} must not log tokens`);
      }
    }
  }
});

test('the app fetches only its own origin and has no external URLs', () => {
  const fetchUsers = allJsFiles.filter((file) => /\bfetch\s*\(|fetchImpl/.test(readFileSync(file, 'utf8')));

  assert.deepEqual(
    fetchUsers.map((file) => path.relative(sourceDir, file).replaceAll('\\', '/')),
    ['js/net/relay-client.js'],
    'only RelayClient may perform HTTP requests',
  );

  const relayClient = readSource('js/net/relay-client.js');

  assert.match(relayClient, /baseUrl = ''/);
  assert.match(relayClient, /#request\('GET', '\/api\/health'/);
  assert.match(relayClient, /#request\('POST', '\/api\/rooms'/);
  assert.match(relayClient, /buildRoomPath\(code, 'join'\)/);
  assert.match(relayClient, /return `\$\{base\}\$\{pathname\}\$\{suffix\}`/);

  for (const { file, text } of readAll(allJsFiles)) {
    assert.doesNotMatch(text, /https?:\/\//i, `${file} must not contain an absolute URL`);
  }

  const index = readSource('index.html');
  const cssFiles = listFiles(path.join(sourceDir, 'css'), (file) => file.endsWith('.css'));

  assert.doesNotMatch(index, /(?:src|href)="https?:/i);
  assert.doesNotMatch(index, /@import/i);

  for (const { file, text } of readAll(cssFiles)) {
    assert.doesNotMatch(text, /url\(\s*['"]?https?:/i, `${file} must not load external resources`);
    assert.doesNotMatch(text, /@import/i, `${file} must not import external styles`);
  }
});

test('session timer defaults never forward native timers without a wrapper', () => {
  for (const relative of ['js/session/guest-session.js', 'js/session/host-session.js']) {
    const text = readSource(relative);

    assert.doesNotMatch(text, /setTimer\s*=\s*setTimeout\b/, `${relative} must wrap setTimeout`);
    assert.doesNotMatch(text, /clearTimer\s*=\s*clearTimeout\b/, `${relative} must wrap clearTimeout`);
    assert.match(text, /setTimer = defaultSetTimer/, `${relative} must default to the wrapper`);
    assert.match(text, /clearTimer = defaultClearTimer/, `${relative} must default to the wrapper`);
    assert.match(
      text,
      /function defaultSetTimer\(callback, milliseconds\) \{\s*return setTimeout\(callback, milliseconds\);/,
      `${relative} must call the global timer as a plain function`,
    );
    assert.match(
      text,
      /function defaultClearTimer\(timer\) \{\s*clearTimeout\(timer\);/,
      `${relative} must call the global timer as a plain function`,
    );
    assert.match(text, /\(callback, milliseconds\) => setTimer\(callback, milliseconds\)/);
    assert.match(text, /\(timer\) => clearTimer\(timer\)/);
  }
});

test('launchers and tools avoid AV/firewall/autostart triggers', () => {
  const launchers = ['start.cmd', 'start-lan.cmd', 'run-tests.cmd'];
  const forbidden = [
    [/\bNew-Service\b/i, 'service creation'],
    [/\bsc(?:\.exe)?\s+create\b/i, 'sc create'],
    [/\breg(?:\.exe)?\s+add\b/i, 'registry writes'],
    [/\bHKLM\b/i, 'HKLM writes'],
    [/\bNew-NetFirewallRule\b/i, 'firewall rules'],
    [/\bnetsh\s+advfirewall\b/i, 'netsh firewall'],
    [/\bInvoke-WebRequest\b/i, 'downloads'],
    [/\bDownloadFile\b/i, 'downloads'],
    [/\bInvoke-Expression\b/i, 'dynamic code'],
    [/-EncodedCommand\b/i, 'encoded commands'],
    [/\bschtasks\b/i, 'scheduled tasks'],
    [/CurrentVersion\\+Run/i, 'autostart registry keys'],
  ];

  for (const relative of launchers) {
    const text = readSource(relative);

    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(text, pattern, `${relative} must not use ${label}`);
    }
  }

  for (const { file, text } of readAll(toolFiles)) {
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(text, pattern, `${file} must not use ${label}`);
    }

    assert.doesNotMatch(text, /access-control-allow-origin/i, `${file} must not enable CORS`);
  }
});

test('start-lan.cmd is the only LAN entry point and start.cmd stays loopback-only', () => {
  const start = readSource('start.cmd');
  const startLan = readSource('start-lan.cmd');
  const runTests = readSource('run-tests.cmd');

  assert.match(start, /tools\\serve\.ps1/);
  assert.doesNotMatch(start, /-Lan\b/);
  assert.doesNotMatch(start, /-BindAddress\b/);

  assert.match(startLan, /tools\\serve\.ps1" -Lan/);
  assert.match(startLan, /Firewall/i);
  assert.match(startLan, /PRIVATE networks/i);
  assert.match(startLan, /host browser tab/i);
  assert.match(startLan, /trusted local network/i);

  assert.doesNotMatch(runTests, /-Lan\b/);
  assert.match(runTests, /node --test tests\//);

  const rootCmdFiles = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.cmd'))
    .map((entry) => entry.name.toLowerCase())
    .sort();

  assert.deepEqual(rootCmdFiles, ['run-tests.cmd', 'start-lan.cmd', 'start.cmd']);

  const rootPowerShell = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ps1'));

  assert.deepEqual(rootPowerShell, [], 'PowerShell helpers live in tools/');
});

test('the repository contains no executables, installers or drivers', () => {
  const forbiddenExtensions = new Set([
    '.exe',
    '.dll',
    '.msi',
    '.com',
    '.scr',
    '.sys',
    '.vbs',
    '.jse',
  ]);

  const binaries = listFiles(sourceDir)
    .filter((file) => forbiddenExtensions.has(path.extname(file).toLowerCase()))
    .map((file) => path.relative(sourceDir, file));

  assert.deepEqual(binaries, []);
});

test('server sources keep the hardening markers for limits, TTL and path checks', () => {
  const serve = readSource('tools/serve.ps1');
  const relay = readSource('tools/relay.ps1');

  assert.match(serve, /\$script:MaxHeaderBytes = 32768/);
  assert.match(serve, /\$script:MaxBodyBytes = 524288/);
  assert.match(serve, /\$script:ReadTimeoutMs = 5000/);
  assert.match(serve, /function Test-RequestSecurity/);
  assert.match(serve, /ServerAllowedHosts/);
  assert.match(serve, /ServerRootPrefix/);
  assert.match(serve, /Test-PrivateIPv4Address/);
  assert.match(serve, /Test-LoopbackIPv4Address/);
  assert.match(serve, /Public bind addresses are refused/);
  assert.match(serve, /X-Room-Token/);

  assert.match(relay, /MaxRooms = 8/);
  assert.match(relay, /MaxQueuedActions = 100/);
  assert.match(relay, /MaxPlayerMessages = 50/);
  assert.match(relay, /TtlSeconds = \$TtlSeconds/);
  assert.match(relay, /function Test-RelayName/);
  assert.match(relay, /function Test-RelayNameTaken/);
  assert.match(relay, /New-RelayRandomBytes -Count 32/);
});
