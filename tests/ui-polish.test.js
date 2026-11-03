import assert from 'node:assert/strict';
import test from 'node:test';

import { DEAL, PHASES } from '../js/core/constants.js';
import { getPhaseAnnouncement } from '../js/ui/announcements.js';
import { getActionErrorMessage } from '../js/ui/errors.js';

/**
 * @param {Partial<object>} [overrides]
 * @returns {object}
 */
function createState(overrides = {}) {
  return {
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
      { id: 'alice', name: 'Алиса', isHuman: false },
      { id: 'boris', name: 'Борис', isHuman: false },
      { id: 'human', name: 'Вы', isHuman: true },
    ],
    ...overrides,
  };
}

test('engine errors become short Russian messages without internal ids', () => {
  assert.match(getActionErrorMessage({ code: 'ILLEGAL_CARD', message: 'Карта S10...' }), /масти/);
  assert.equal(
    getActionErrorMessage({ code: 'CANNOT_PASS' }),
    'Открывающий торги обязан сказать 100 и не может пасовать.',
  );
  assert.match(getActionErrorMessage({ code: 'MARRIAGE_NOT_ALLOWED' }), /первой завершённой взятки/);
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
