import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DEAL, PHASES } from '../js/core/constants.js';
import { getConnectionBanner, getSeatStatus } from '../js/net/lobby.js';
import { getPhaseAnnouncement } from '../js/ui/announcements.js';
import { getActionErrorMessage } from '../js/ui/errors.js';
import {
  formatDativeNames,
  formatGenitiveNames,
  resolveViewerId,
} from '../js/ui/format.js';
import { canViewerTakePrikup } from '../js/ui/prikup.js';
import { shouldShowThinking } from '../js/ui/table.js';

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
  assert.equal(
    getActionErrorMessage({ code: 'INVALID_RAISE' }),
    'Заказ можно повысить только до числа больше текущего, кратного 5 и не выше 120 плюс бонусы марьяжей на руке.',
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
      raiseDecided: true,
    })),
    'Отдар. Заказ — 85. Выберите по одной карте для Алисы и Бориса.',
  );
});

test('phase announcements ask the human declarer to raise or keep the contract', () => {
  assert.equal(
    getPhaseAnnouncement(createState({
      phase: PHASES.GIVING,
      currentPlayerId: 'human',
      declarerId: 'human',
      contract: 85,
      raiseDecided: false,
    })),
    'Отдар. Заказ — 85. Повысьте заказ или оставьте текущий, максимум — 120.',
  );

  assert.equal(
    getPhaseAnnouncement(createState({
      phase: PHASES.GIVING,
      currentPlayerId: 'human',
      declarerId: 'human',
      contract: 120,
      raiseDecided: false,
      players: [
        { id: 'alice', name: 'Алиса', isHuman: false, isAI: true },
        { id: 'boris', name: 'Борис', isHuman: false, isAI: true },
        {
          id: 'human',
          name: 'Вы',
          isHuman: true,
          isAI: false,
          score: 0,
          hand: ['HK', 'HQ', 'DK', 'DQ', 'SA', 'HA', 'DA', 'C10', 'S9', 'C9'],
        },
      ],
    })),
    'Отдар. Заказ — 120. Повысьте заказ или оставьте текущий, максимум — 300.',
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
      raiseDecided: false,
    })),
    'Отдар. Заказ — 85. Повысьте заказ или оставьте текущий, максимум — 120.',
  );
  assert.equal(
    getPhaseAnnouncement(createMultiHumanState({
      phase: PHASES.GIVING,
      declarerId: 'host',
      contract: 85,
      raiseDecided: true,
    })),
    'Отдар. Заказ — 85. Выберите по одной карте для Анны и Бориса.',
  );
  assert.equal(
    getPhaseAnnouncement(createMultiHumanState({
      viewerId: 'guest',
      phase: PHASES.GIVING,
      declarerId: 'host',
      contract: 85,
      raiseDecided: true,
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

test('seat presence badges describe AI, online and offline seats', () => {
  assert.equal(getSeatStatus({ occupied: false }), 'AI');
  assert.equal(getSeatStatus({ occupied: true, connected: true }), 'в комнате');
  assert.equal(getSeatStatus({ occupied: true, connected: false }), 'нет связи');
  assert.equal(getSeatStatus(null), 'AI');

  assert.match(getConnectionBanner({ connected: false }).className, /network-banner--offline/);
  assert.match(getConnectionBanner({ connected: false }).text, /Нет связи/);
  assert.match(getConnectionBanner({ connected: true }).className, /network-banner--online/);
});

test('only the declarer or the AI-controlling host may take the prikup', () => {
  assert.equal(canViewerTakePrikup({
    declarerId: 'guest',
    viewerId: 'guest',
  }), true);
  assert.equal(canViewerTakePrikup({
    declarerId: 'ai',
    viewerId: 'guest',
    declarerIsAI: true,
    isHost: true,
  }), true);
  assert.equal(canViewerTakePrikup({
    declarerId: 'ai',
    viewerId: 'guest',
    declarerIsAI: true,
    isHost: false,
  }), false);
  assert.equal(canViewerTakePrikup({
    declarerId: 'host',
    viewerId: 'guest',
    declarerIsAI: false,
    isHost: false,
  }), false);
  assert.equal(canViewerTakePrikup({ declarerId: null, viewerId: 'guest' }), false);
});

test('the thinking indicator belongs to an acting AI seat, never a live player', () => {
  const ai = { id: 'ai', name: 'Борис', isAI: true };
  const human = { id: 'guest', name: 'Анна', isAI: false };
  const state = createMultiHumanState({ currentPlayerId: 'ai' });

  assert.equal(shouldShowThinking(ai, state), true);
  assert.equal(shouldShowThinking(human, { ...state, currentPlayerId: 'guest' }), false);
  assert.equal(shouldShowThinking(ai, { ...state, currentPlayerId: 'guest' }), false);
  assert.equal(shouldShowThinking(human, state), false);
});

test('offline announcements wait for the disconnected acting seat', () => {
  const state = createMultiHumanState({
    viewerId: 'host',
    currentPlayerId: 'guest',
    network: {
      presence: [
        { playerId: 'host', name: 'Иван', occupied: true, connected: true },
        { playerId: 'guest', name: 'Анна', occupied: true, connected: false },
        { playerId: 'ai', name: 'Борис', occupied: false, connected: false },
      ],
    },
  });

  assert.equal(
    getPhaseAnnouncement(state, { humanId: 'host' }),
    'Ждём Анна — нет связи.',
  );
  assert.equal(
    getPhaseAnnouncement({ ...state, currentPlayerId: 'host' }, { humanId: 'host' }),
    'Ваш ход в торгах.',
  );
});

test('guest UI gates actions, pending status and host-only controls', () => {
  const controllerSource = readFileSync(
    new URL('../js/ui/controller.js', import.meta.url),
    'utf8',
  );
  const prikupSource = readFileSync(
    new URL('../js/ui/prikup.js', import.meta.url),
    'utf8',
  );
  const modalsSource = readFileSync(
    new URL('../js/ui/modals.js', import.meta.url),
    'utf8',
  );
  const lobbySource = readFileSync(
    new URL('../js/net/lobby.js', import.meta.url),
    'utf8',
  );
  const cssSource = readFileSync(
    new URL('../css/network.css', import.meta.url),
    'utf8',
  );
  const mainSource = readFileSync(
    new URL('../js/main.js', import.meta.url),
    'utf8',
  );

  assert.match(controllerSource, /isPending/);
  assert.match(controllerSource, /Отправляем…/);
  assert.match(controllerSource, /capabilities\?\.controlsAI === false/);
  assert.match(controllerSource, /capabilities\?\.canRestart === false/);
  assert.match(controllerSource, /isHost/);

  assert.match(prikupSource, /declarer\.id === resolvedViewerId/);
  assert.match(prikupSource, /isHost/);

  assert.match(modalsSource, /Следующая раздача/);
  assert.match(modalsSource, /isHost/);
  assert.match(modalsSource, /Ждём, пока хост начнёт новую игру/);

  assert.match(lobbySource, /network-banner--offline/);
  assert.match(lobbySource, /network-banner--online/);
  assert.match(cssSource, /\.network-banner--offline/);
  assert.match(cssSource, /\.network-banner--online/);

  assert.match(mainSource, /dispose\?\.\(\)/);
  assert.match(mainSource, /sessionclosed/);
});

test('the raise decision is inline in the action bar and no raise modal remains', () => {
  const controllerSource = readFileSync(
    new URL('../js/ui/controller.js', import.meta.url),
    'utf8',
  );
  const prikupSource = readFileSync(
    new URL('../js/ui/prikup.js', import.meta.url),
    'utf8',
  );
  const panelSource = readFileSync(
    new URL('../js/ui/raise-panel.js', import.meta.url),
    'utf8',
  );
  const cssSource = readFileSync(
    new URL('../css/game-ui.css', import.meta.url),
    'utf8',
  );

  assert.match(controllerSource, /from '\.\/raise-panel\.js'/);
  assert.match(controllerSource, /createRaiseControls\(/);
  assert.doesNotMatch(controllerSource, /openRaiseModal/);
  assert.doesNotMatch(prikupSource, /openRaiseModal/);
  assert.match(panelSource, /Повысить заказ\?/);
  assert.match(panelSource, /Максимум = 120 \+ бонусы марьяжей на руке\./);
  assert.match(panelSource, /aria-label': 'Новая сумма заказа'/);
  assert.match(panelSource, /isLegalRaiseAmount/);
  assert.match(cssSource, /\.raise-controls \{/);
  assert.match(cssSource, /\.raise-controls__input/);
  assert.match(cssSource, /\.raise-controls__hint/);
});
