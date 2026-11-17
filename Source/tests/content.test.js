import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CARD_VALUE_ROWS,
  MARRIAGE_ROWS,
  ROUNDING_ROWS,
  RULES_SECTIONS,
} from '../js/content/rules.js';
import { MARRIAGE_BONUSES, SUIT_INFO } from '../js/core/constants.js';
import { roundToFive } from '../js/core/scoring.js';

test('card table mirrors the 24-card deck and totals 120 points', () => {
  assert.equal(CARD_VALUE_ROWS.length, 6);

  const total = CARD_VALUE_ROWS.reduce((sum, row) => sum + row.value, 0) * 4;

  assert.equal(total, 120);
  assert.equal(total / 4, 30);
  assert.deepEqual(
    CARD_VALUE_ROWS.map((row) => [row.name, row.shortLabel, row.strength, row.value]),
    [
      ['Девятка', '9', 1, 0],
      ['Валет', 'В', 2, 2],
      ['Дама', 'Д', 3, 3],
      ['Король', 'К', 4, 4],
      ['Десятка', '10', 5, 10],
      ['Туз', 'Т', 6, 11],
    ],
  );
});

test('marriage table matches the core suit bonuses', () => {
  assert.equal(MARRIAGE_ROWS.length, 4);

  for (const row of MARRIAGE_ROWS) {
    assert.equal(row.bonus, MARRIAGE_BONUSES[row.suit]);
    assert.equal(row.symbol, SUIT_INFO[row.suit].symbol);
  }

  assert.deepEqual(
    MARRIAGE_ROWS.map((row) => row.bonus),
    [40, 60, 80, 100],
  );
});

test('rounding examples match the scoring implementation', () => {
  for (const row of ROUNDING_ROWS) {
    assert.equal(roundToFive(row.total), row.rounded);
  }
});

test('rules cover every section of the rulebook', () => {
  assert.deepEqual(
    RULES_SECTIONS.map((section) => section.id),
    [
      'deck',
      'players',
      'bidding',
      'prikup',
      'marriages',
      'tricks',
      'scoring',
      'bolts',
      'end',
      'not-implemented',
    ],
  );

  for (const section of RULES_SECTIONS) {
    assert.ok(section.title.length > 0);
    assert.ok(section.blocks.length > 0);
  }
});

test('prikup rules describe the public reveal before taking', () => {
  const section = RULES_SECTIONS.find((entry) => entry.id === 'prikup');
  const text = section.blocks
    .flatMap((block) => [block.text ?? '', ...(block.items ?? [])])
    .join(' ');

  assert.match(text, /прикуп раскрывается всем/i);
  assert.match(text, /видны до взятия/i);
  assert.match(text, /забирает их в руку/i);
  assert.match(text, /скрытой карты прикупа больше нет/i);
  assert.doesNotMatch(text, /видит только он/i);
  assert.doesNotMatch(text, /не раскрывается до момента/i);
});

test('rules describe one contract raise after the prikup', () => {
  const bidding = RULES_SECTIONS.find((entry) => entry.id === 'bidding');
  const prikup = RULES_SECTIONS.find((entry) => entry.id === 'prikup');
  const notImplemented = RULES_SECTIONS.find((entry) => entry.id === 'not-implemented');
  const biddingText = bidding.blocks
    .flatMap((block) => [block.text ?? '', ...(block.items ?? [])])
    .join(' ');
  const prikupText = prikup.blocks
    .flatMap((block) => [block.text ?? '', ...(block.items ?? [])])
    .join(' ');
  const notImplementedText = notImplemented.blocks
    .flatMap((block) => [block.text ?? '', ...(block.items ?? [])])
    .join(' ');

  assert.match(biddingText, /один раз повысить заказ/i);
  assert.match(prikupText, /один раз повысить заказ/i);
  assert.match(prikupText, /до первой карты отдара/i);
  assert.match(prikupText, /Играющий с отрицательным счётом не может повышать заказ/i);
  assert.doesNotMatch(biddingText, /После прикупа ставка не повышается/i);
  assert.doesNotMatch(notImplementedText, /повышение ставки после прикупа/i);
});

test('marriage rules require confirmation by king or queen', () => {
  const section = RULES_SECTIONS.find((entry) => entry.id === 'marriages');
  const text = section.blocks
    .flatMap((block) => [block.text ?? '', ...(block.items ?? [])])
    .join(' ');

  assert.match(text, /выйти королём или дамой/);
  assert.match(text, /только после этого хода/);
  assert.match(text, /можно отменить/);
  assert.match(text, /после подтверждения/i);
  assert.doesNotMatch(text, /немедленно становится козырем/i);
  assert.doesNotMatch(text, /Не требуется ходить/i);
  assert.doesNotMatch(text, /сразу начисляется/i);
});

test('visible rules text is fully Russian', () => {
  const visibleText = RULES_SECTIONS.flatMap((section) => [
    section.title,
    ...section.blocks.flatMap((block) => [
      block.text ?? '',
      block.caption ?? '',
      ...(block.items ?? []),
      ...(block.headers ?? []),
      ...(block.rows ?? []).flat(),
      ...(block.lines ?? []),
    ]),
  ]).join(' ');

  assert.doesNotMatch(visibleText, /[A-Za-z]/, 'Rules copy must not contain Latin letters.');
});

test('the not-implemented section lists v1 exclusions', () => {
  const section = RULES_SECTIONS.find((entry) => entry.id === 'not-implemented');
  const text = section.blocks
    .flatMap((block) => [block.text ?? '', ...(block.items ?? [])])
    .join(' ');

  assert.match(text, /бочка/i);
  assert.match(text, /самосвал/i);
  assert.match(text, /тузовый марьяж/i);
  assert.match(text, /пересдача/i);
  assert.match(text, /интернет/i);
  assert.doesNotMatch(text, /сетевая игра/i);
});
