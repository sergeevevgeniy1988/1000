import assert from 'node:assert/strict';
import test from 'node:test';

import { DEAL, PHASES } from '../js/core/constants.js';
import { getPhaseAnnouncement } from '../js/ui/announcements.js';
import { getActionErrorMessage } from '../js/ui/errors.js';
import {
  formatDativeNames,
  formatGenitiveNames,
  resolveViewerId,
} from '../js/ui/format.js';

/**
 * @param {Partial<object>} [overrides]
 * @returns {object}
 */
function createState(overrides = {}) {
  return {
    viewerId: 'human',
    phase: PHASES.BIDDING,
    dealNumber: 1,
    targetScore: 1000,
    dealerId: 'alice',
    currentBid: 0,
    currentPlayerId: 'human',
    declarerId: null,
    trumpSuit: null,
    completedTricks: [],
    lastDealResult: null,
    winnerId: null,
    players: [
      { id: 'alice', name: 'Алиса', isHuman: false, isAI: true },
      { id: 'boris', name: 'Борис', isHuman: false, isAI: true },
      { id: 'human', name: 'Вы', isHuman: true, isAI: false },
    ],
    ...overrides,
  };
}

/**
 * A state with two live people at the table and one AI seat.
 *
 * @param {Partial<object>} [overrides]
 * @returns {object}
 */
function createMultiHumanState(overrides = {}) {
  return createState({
    viewerId: 'host',
    dealerId: 'host',
    currentPlayerId: 'host',
    players: [
      { id: 'host', name: 'Иван', isHuman: true, isAI: false },
      { id: 'guest', name: 'Анна', isHuman: true, isAI: false },
      { id: 'ai', name: 'Борис', isHuman: false, isAI: true },
    ],
    ...overrides,
  });
}

test('engine errors become short Russian messages without internal ids', () => {
  assert.match(getActionErrorMessage({ code: 'ILLEGAL_CARD', message: 'Карта S10...' }), /масти/);
  assert.equal(
    getActionErrorMessage({ code: 'CANNOT_PASS' }),
    'Открывающий торги обязан сказать 80 и не может пасовать.',
  );
  assert.equal(
    getActionErrorMessage({ code: 'NEGATIVE_SCORE_CANNOT_BID' }),
    'При отрицательном счёте нельзя повышать ставку или пасовать. Можно только открыть 80.',
  );
  assert.equal(
    getActionErrorMessage({ code: 'NEGATIVE_SCORE_NO_RAISE' }),
    'При отрицательном счёте повышать заказ нельзя.',
  );
  assert.equal(
    getActionErrorMessage({ code: 'RAISE_WINDOW_CLOSED' }),
    'Повысить заказ можно только до первой отданной карты.',
  );
  assert.equal(
    getActionErrorMessage({ code: 'RAISE_ALREADY_DECIDED' }),
    'Решение о повышении заказа уже принято.',
  );
  assert.match(getActionErrorMessage({ code: 'MARRIAGE_NOT_ALLOWED' }), /первой завершённой взятки/);
  assert.equal(
    getActionErrorMessage({ code: 'MARRIAGE_PENDING' }),
    'Сначала подтвердите или отмените объявленный марьяж.',
  );
  assert.equal(
    getActionErrorMessage({ code: 'MARRIAGE_CARD_REQUIRED' }),
    'После объявления марьяжа нужно выйти королём или дамой этой масти.',
  );
  assert.equal(
    getActionErrorMessage({ code: 'NO_PENDING_MARRIAGE' }),
    'Нет объявленного марьяжа для отмены.',
  );
  assert.equal(
    getActionErrorMessage({ code: 'NOT_MARRIAGE_OWNER' }),
    'Отменить марьяж может только объявивший его игрок.',
  );
  assert.equal(getActionErrorMessage({ code: 'NOT_YOUR_TURN' }), 'Сейчас не ваш ход. Дождитесь своей очереди.');
});

test('unknown errors keep a readable engine message or a generic fallback', () => {
  assert.equal(getActionErrorMessage({ code: 'SOMETHING_NEW', message: 'Понятное сообщение.' }), 'Понятное сообщение.');
  assert.equal(
    getActionErrorMessage({ code: 'SOMETHING_NEW', message: '   ' }),
    'Не удалось выполнить действие. Попробуйте ещё раз.',
  );
  assert.equal(
    getActionErrorMessage(null),
    'Не удалось выполнить действие. Попробуйте ещё раз.',
  );
});

test('phase announcements describe the human bidding turn and current bid', () => {
  assert.equal(
    getPhaseAnnouncement(createState({ currentBid: 105 })),
    'Ваш ход в торгах. Текущая ставка — 105.',
  );
  assert.equal(
    getPhaseAnnouncement(createState({ currentPlayerId: 'alice' })),
    'Ход Алисы в торгах.',
  );
});

test('phase announcements describe the public prikup reveal', () => {
  assert.equal(
    getPhaseAnnouncement(createState({
      phase: PHASES.PRIKUP,
      currentPlayerId: 'human',
      declarerId: 'human',
    })),
    'Прикуп раскрыт всем игрокам. Заберите три карты.',
  );
  assert.equal(
    getPhaseAnnouncement(createState({
      phase: PHASES.PRIKUP,
      currentPlayerId: 'alice',
      declarerId: 'alice',
    })),
    'Прикуп раскрыт всем игрокам. Алиса забирает карты.',
  );
});

test('phase announcements include the final contract during gifts', () => {
  assert.equal(
    getPhaseAnnouncement(createState({
      phase: PHASES.GIVING,
      currentPlayerId: 'human',
      declarerId: 'human',
      contract: 85,
    })),
    'Отдар. Заказ — 85. Выберите по одной карте для Алисы и Бориса.',
  );
});

test('phase announcements describe a pending marriage', () => {
  assert.equal(
    getPhaseAnnouncement(createState({
      phase: PHASES.PLAYING,
      currentPlayerId: 'human',
      declarerId: 'human',
      pendingMarriage: { playerId: 'human', suit: 'H', value: 100 },
    })),
    'Марьяж: черви. Выйдите королём или дамой.',
  );
  assert.equal(
    getPhaseAnnouncement(createState({
      phase: PHASES.PLAYING,
      currentPlayerId: 'alice',
      declarerId: 'alice',
      pendingMarriage: { playerId: 'alice', suit: 'H', value: 100 },
    })),
    'Марьяж: черви. Алиса выходит королём или дамой.',
  );
});

test('phase announcements describe trump, trick progress and deal results', () => {
  const playing = createState({
    phase: PHASES.PLAYING,
    currentPlayerId: 'boris',
    trumpSuit: 'H',
    completedTricks: [{}, {}],
  });

  assert.equal(
    getPhaseAnnouncement(playing),
    `Ход Бориса. Взятка 3 из ${DEAL.TRICKS}. Козырь — черви.`,
  );

  const dealEnd = createState({
    phase: PHASES.DEAL_END,
    dealNumber: 4,
    lastDealResult: { contract: 110, contractMet: false },
  });

  assert.equal(
    getPhaseAnnouncement(dealEnd),
    'Итоги раздачи 4. Заказ 110 не выполнен.',
  );
});

test('phase announcements report a completed trick and the winner', () => {
  assert.equal(
    getPhaseAnnouncement(createState(), {
      reveal: { winnerId: 'alice', points: 24 },
    }),
    'Взятка: 24 очка. Победитель — Алиса.',
  );

  assert.equal(
    getPhaseAnnouncement(createState({
      phase: PHASES.GAME_OVER,
      winnerId: 'human',
    })),
    'Игра окончена. Победитель — Вы.',
  );
});

test('announcements follow the viewer when two live people are at the table', () => {
  assert.equal(
    getPhaseAnnouncement(createMultiHumanState()),
    'Ваш ход в торгах.',
  );
  assert.equal(
    getPhaseAnnouncement(createMultiHumanState({ currentPlayerId: 'guest' })),
    'Ход Анны в торгах.',
  );
  assert.equal(
    getPhaseAnnouncement(createMultiHumanState({ currentPlayerId: 'ai' })),
    'Ход Бориса в торгах.',
  );
  assert.equal(
    getPhaseAnnouncement(createMultiHumanState({
      viewerId: 'guest',
      currentPlayerId: 'host',
    })),
    'Ход Ивана в торгах.',
  );
});

test('announcements build gift names from the current players', () => {
  assert.equal(
    getPhaseAnnouncement(createMultiHumanState({
      phase: PHASES.GIVING,
      declarerId: 'host',
      contract: 85,
    })),
    'Отдар. Заказ — 85. Выберите по одной карте для Анны и Бориса.',
  );
  assert.equal(
    getPhaseAnnouncement(createMultiHumanState({
      viewerId: 'guest',
      phase: PHASES.GIVING,
      declarerId: 'host',
      contract: 85,
    })),
    'Отдар. Заказ — 85. Иван отдаёт карты соперникам.',
  );
  assert.equal(
    getPhaseAnnouncement(createMultiHumanState({
      phase: PHASES.PRIKUP,
      declarerId: 'host',
    })),
    'Прикуп раскрыт всем игрокам. Заберите три карты.',
  );
  assert.equal(
    getPhaseAnnouncement(createMultiHumanState({
      viewerId: 'guest',
      phase: PHASES.PRIKUP,
      declarerId: 'host',
    })),
    'Прикуп раскрыт всем игрокам. Иван забирает карты.',
  );
});

test('viewer resolution and name lists keep the "Вы" forms', () => {
  assert.equal(resolveViewerId(createState()), 'human');
  assert.equal(resolveViewerId(createMultiHumanState()), 'host');
  assert.equal(resolveViewerId(createMultiHumanState({ viewerId: undefined })), null);
  assert.equal(
    resolveViewerId(createMultiHumanState({ viewerId: undefined }), 'guest'),
    'guest',
  );
  assert.equal(formatGenitiveNames(['Анна', 'Борис']), 'Анны и Бориса');
  assert.equal(formatDativeNames(['Анна', 'Борис']), 'Анне и Борису');
  assert.equal(formatGenitiveNames(['Вы']), 'Вас');
  assert.equal(formatDativeNames(['Вы']), 'Вам');
});
