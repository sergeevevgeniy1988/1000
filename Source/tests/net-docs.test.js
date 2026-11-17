import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RULES_SECTIONS } from '../js/content/rules.js';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testsDir, '..');
const projectDir = path.resolve(sourceDir, '..');

/**
 * @param {string} absolutePath
 * @returns {string}
 */
function readFile(absolutePath) {
  return readFileSync(absolutePath, 'utf8');
}

/**
 * @param {object} block
 * @returns {string[]}
 */
function blockText(block) {
  return [
    block.text ?? '',
    block.caption ?? '',
    ...(block.items ?? []),
    ...(block.headers ?? []),
    ...(block.rows ?? []).flat(),
    ...(block.lines ?? []),
  ];
}

/**
 * @param {object} section
 * @returns {string}
 */
function sectionText(section) {
  return section.blocks.flatMap(blockText).join(' ');
}

test('README documents both launchers, the invite link and the network limitations', () => {
  const readme = readFile(path.join(sourceDir, 'README.md'));

  assert.match(readme, /start-lan\.cmd/);
  assert.match(readme, /start\.cmd/);
  assert.match(readme, /run-tests\.cmd/);
  assert.match(readme, /room=CODE/);
  assert.match(readme, /1–3/);
  assert.match(readme, /переподключ/i);
  assert.match(readme, /localStorage/);
  assert.match(readme, /Firewall/i);
  assert.match(readme, /антивирус|EDR/i);
  assert.match(readme, /HTTP/i);
  assert.match(readme, /вкладк[аи] хоста/i);
  assert.match(readme, /одной локальной сети/i);
  assert.match(readme, /## Решение проблем/);
  assert.match(readme, /js\/net\//);
  assert.match(readme, /relay\.ps1/);
  assert.match(readme, /node --test tests\//);
  assert.doesNotMatch(readme, /нет сетевой игры|сетевой игры нет/i);
});

test('README lists the network test files and the automated acceptance limits', () => {
  const readme = readFile(path.join(sourceDir, 'README.md'));

  for (const fileName of [
    'net-server.test.js',
    'net-security.test.js',
    'net-docs.test.js',
    'net-protocol.test.js',
    'net-lobby.test.js',
    'net-host-session.test.js',
    'net-guest-session.test.js',
  ]) {
    assert.ok(readme.includes(fileName), `README must mention ${fileName}`);
  }

  assert.match(readme, /e2e/i);
  assert.match(readme, /не покрываются|ограничени/i);
});

test('ACCEPTANCE is the v1.2.0 report with commands and network limits', () => {
  const acceptance = readFile(path.join(sourceDir, 'ACCEPTANCE.md'));

  assert.match(acceptance, /^# Приёмка «Тысячи» v1\.2\.0/m);
  assert.match(acceptance, /node --test tests\//);
  assert.match(acceptance, /run-tests\.cmd/);
  assert.match(acceptance, /All tests passed/);
  assert.match(acceptance, /Firewall/i);
  assert.match(acceptance, /антивирус|EDR/i);
  assert.match(acceptance, /HTTP/i);
  assert.match(acceptance, /вкладк[аи] хоста/i);
  assert.match(acceptance, /Ограничения автоматической приёмки/);
  assert.match(acceptance, /PROMPT\.md/);
  assert.match(acceptance, /227 тест/);
});

test('package.json exposes version 1.2.0 and the standard test script', () => {
  const packageJson = JSON.parse(readFile(path.join(sourceDir, 'package.json')));
  const serve = readFile(path.join(sourceDir, 'tools', 'serve.ps1'));

  assert.equal(packageJson.version, '1.2.0');
  assert.equal(packageJson.scripts.test, 'node --test tests/');
  assert.equal(packageJson.private, true);
  assert.match(serve, /\$script:ServerVersion = '1\.2\.0'/);
});

test('index.html shows the v1.2.0 footer and no longer claims to be offline-only', () => {
  const index = readFile(path.join(sourceDir, 'index.html'));

  assert.match(index, /Версия 1\.2\.0/);
  assert.match(index, /локальной сети/i);
  assert.match(index, /css\/network\.css/);
  assert.doesNotMatch(index, /Локальная игра без подключения к сети/);
});

test('rules describe the network mode, free AI seats and drop the old denial', () => {
  const rulesText = RULES_SECTIONS.map(sectionText).join(' ');
  const notImplemented = RULES_SECTIONS.find((section) => section.id === 'not-implemented');
  const notImplementedText = sectionText(notImplemented);

  assert.doesNotMatch(rulesText, /сетевой игры нет|нет сетевой игры/i);
  assert.match(rulesText, /сетевом режиме/i);
  assert.match(rulesText, /локальной сети/i);
  assert.match(rulesText, /свободные места/i);
  assert.match(rulesText, /компьютер/i);
  assert.match(rulesText, /1\.2\.0/);
  assert.doesNotMatch(rulesText, /1\.1\.0/);
  assert.match(notImplementedText, /интернет/i);
  assert.doesNotMatch(notImplementedText, /сетевая игра/i);
});

test('PROMPT.md stays the original v1.1.0 spec and the divergence is documented', () => {
  const prompt = readFile(path.join(projectDir, 'PROMPT.md'));
  const readme = readFile(path.join(sourceDir, 'README.md'));
  const acceptance = readFile(path.join(sourceDir, 'ACCEPTANCE.md'));

  assert.match(prompt, /v1\.1\.0/);
  assert.doesNotMatch(prompt, /сетевой режим/i);

  for (const document of [readme, acceptance]) {
    assert.match(document, /PROMPT\.md/);
    assert.match(document, /1\.1\.0/);
    assert.match(document, /1\.2\.0/);
  }
});
