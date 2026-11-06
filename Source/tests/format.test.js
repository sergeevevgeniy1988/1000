import test from 'node:test';
import assert from 'node:assert/strict';

import { PHASES } from '../js/core/constants.js';
import {
  formatBolts,
  formatCards,
  formatPoints,
  formatScore,
  formatSignedScore,
  formatTricks,
  formatTrump,
  getCardLabel,
  getCardName,
  getPhaseName,
  nameDative,
  nameGenitive,
  pluralizeRu,
} from '../js/ui/format.js';

test('pluralizeRu chooses Russian forms for cardinal numbers', () => {
  const forms = ['очко', 'очка', 'очков'];

  assert.equal(pluralizeRu(1, ...forms), 'очко');
  assert.equal(pluralizeRu(2, ...forms), 'очка');
  assert.equal(pluralizeRu(5, ...forms), 'очков');
  assert.equal(pluralizeRu(11, ...forms), 'очков');
  assert.equal(pluralizeRu(21, ...forms), 'очко');
  assert.equal(pluralizeRu(22, ...forms), 'очка');
  assert.equal(pluralizeRu(-3, ...forms), 'очка');
});

test('count formatters produce natural Russian phrases', () => {
  assert.equal(formatTricks(0), '0 взяток');
  assert.equal(formatTricks(1), '1 взятка');
  assert.equal(formatTricks(2), '2 взятки');
  assert.equal(formatTricks(5), '5 взяток');
  assert.equal(formatBolts(2), '2 болта');
  assert.equal(formatCards(0), '0 карт');
  assert.equal(formatCards(7), '7 карт');
  assert.equal(formatPoints(0), '0 очков');
  assert.equal(formatPoints(1), '1 очко');
  assert.equal(formatPoints(10), '10 очков');
  assert.equal(formatPoints(22), '22 очка');
});

test('card names use Russian rank and genitive suit forms', () => {
  assert.equal(getCardName('H10'), 'Десятка червей');
  assert.equal(getCardName('SJ'), 'Валет пик');
  assert.equal(getCardName('D9'), 'Девятка бубен');
  assert.equal(getCardLabel('H10'), 'Десятка червей, 10 очков');
  assert.equal(getCardLabel('S9'), 'Девятка пик, 0 очков');
  assert.equal(getCardLabel('DA'), 'Туз бубен, 11 очков');
});

test('scores use the typographic minus and signed deltas', () => {
  assert.equal(formatScore(0), '0');
  assert.equal(formatScore(-120), '−120');
  assert.equal(formatScore(1000), '1000');
  assert.equal(formatSignedScore(100), '+100');
  assert.equal(formatSignedScore(-120), '−120');
  assert.equal(formatSignedScore(0), '0');
});

test('trump and phase labels are human readable', () => {
  assert.equal(formatTrump('H'), 'Козырь — черви');
  assert.equal(formatTrump('D'), 'Козырь — бубны');
  assert.equal(formatTrump(null), 'Козырь не объявлен');
  assert.equal(getPhaseName(PHASES.BIDDING), 'Торги');
  assert.equal(getPhaseName(PHASES.GIVING), 'Отдар');
  assert.equal(getPhaseName(PHASES.DEAL_END), 'Итоги раздачи');
});

test('names decline for "ход Алисы" and "отдать Борису"', () => {
  assert.equal(nameGenitive('Алиса'), 'Алисы');
  assert.equal(nameGenitive('Борис'), 'Бориса');
  assert.equal(nameGenitive('Вы'), 'Вас');
  assert.equal(nameDative('Алиса'), 'Алисе');
  assert.equal(nameDative('Борис'), 'Борису');
  assert.equal(nameDative('Вы'), 'Вам');
});
