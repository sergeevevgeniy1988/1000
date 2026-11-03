import { BOLTS, DEAL, PHASES, SUIT_INFO } from '../core/constants.js';
import { getTrickPoints } from '../core/rules.js';
import { createElement } from './dom.js';
import { createCard, createOpponentHand } from './hand.js';
import {
  formatCards,
  formatScore,
  formatTricks,
  getPhaseName,
  getSuitNameLower,
  nameGenitive,
} from './format.js';

const ACTING_PHASES = new Set([
  PHASES.BIDDING,
  PHASES.PRIKUP,
  PHASES.GIVING,
  PHASES.PLAYING,
]);

/**
 * @param {object} state
 * @param {string} playerId
 * @returns {object | null}
 */
function findPlayer(state, playerId) {
  return state.players.find((player) => player.id === playerId) ?? null;
}

/**
 * @param {object} state
 * @param {object} player
 * @returns {boolean}
 */
function isActing(state, player) {
  return ACTING_PHASES.has(state.phase) && state.currentPlayerId === player.id;
}

/**
 * @param {string} text
 * @param {string} variant
 * @returns {HTMLElement}
 */
function createBadge(text, variant) {
  return createElement('span', {
    className: ['badge', `badge--${variant}`],
    text,
  });
}

/**
 * @param {string} text
 * @param {string} variant
 * @returns {HTMLElement}
 */
function createStatusChip(text, variant) {
  return createElement('span', {
    className: ['status-chip', `status-chip--${variant}`],
    text,
  });
}

/**
 * @param {object} state
 * @param {object} player
 * @returns {HTMLElement | null}
 */
function createStatus(state, player) {
  if (player.isDeclarer && state.contract !== null) {
    return createStatusChip(`Заказ ${state.contract}`, 'contract');
  }

  if (state.phase === PHASES.BIDDING) {
    if (player.passed) {
      return createStatusChip('Пас', 'pass');
    }

    if (player.bid !== null) {
      return createStatusChip(`Ставка ${player.bid}`, 'bid');
    }

    if (isActing(state, player)) {
      return createStatusChip(player.isHuman ? 'Ваш ход' : 'Ждёт ответа', 'turn');
    }

    return createStatusChip('Ждёт', 'idle');
  }

  if (player.passed) {
    return createStatusChip('Пас', 'pass');
  }

  return null;
}

/**
 * @returns {HTMLElement}
 */
function createThinkingIndicator() {
  const indicator = createElement('span', {
    className: 'thinking',
    attrs: { 'aria-label': 'Думает' },
  });

  indicator.append(
    document.createTextNode('думает'),
    createElement('span', {
      className: 'thinking__dots',
      attrs: { 'aria-hidden': 'true' },
    }, ...[1, 2, 3].map(() => createElement('span', {
      className: 'thinking__dot',
      text: '.',
    }))),
  );

  return indicator;
}

/**
 * @param {object} state
 * @param {object} player
 * @returns {HTMLElement}
 */
function createBolts(state, player) {
  const bolts = createElement('div', {
    className: 'bolts',
    attrs: { 'aria-label': `Болты: ${player.bolts} из ${BOLTS.LIMIT}` },
  });

  bolts.append(createElement('span', { className: 'bolts__label', text: 'Болты' }));

  for (let index = 0; index < BOLTS.LIMIT; index += 1) {
    const bolt = createElement('span', {
      className: ['bolt', index < player.bolts ? 'bolt--filled' : ''],
      attrs: { 'aria-hidden': 'true' },
    });

    bolts.append(bolt);
  }

  return bolts;
}

/**
 * Creates a player summary panel.
 *
 * @param {object} state
 * @param {object} player
 * @returns {HTMLElement}
 */
export function createPlayerPanel(state, player) {
  const panel = createElement('article', {
    className: [
      'player-card',
      player.isHuman ? 'player-card--human' : '',
      isActing(state, player) ? 'player-card--active' : '',
    ],
    dataset: { playerId: player.id },
  });

  const avatar = createElement('div', {
    className: 'player-card__avatar',
    text: player.name.slice(0, 1),
    attrs: { 'aria-hidden': 'true' },
  });

  const body = createElement('div', { className: 'player-card__body' });
  const head = createElement('div', { className: 'player-card__head' });
  const badges = createElement('div', { className: 'player-card__badges' });

  head.append(
    createElement('h2', { className: 'player-card__name', text: player.name }),
    badges,
  );

  if (state.dealerId === player.id) {
    badges.append(createBadge('Сдающий', 'dealer'));
  }

  if (player.isDeclarer) {
    badges.append(createBadge('Играющий', 'declarer'));
  }

  const stats = createElement('div', { className: 'player-card__stats' });
  const score = createElement('div', { className: 'score' });

  score.append(
    createElement('span', { className: 'score__label', text: 'Счёт' }),
    createElement('span', { className: 'score__value', text: formatScore(player.score) }),
  );

  stats.append(
    score,
    createBolts(state, player),
    createElement('span', { className: 'card-count', text: formatCards(player.cardCount) }),
  );

  const statusRow = createElement('div', { className: 'player-card__status' });
  const status = createStatus(state, player);

  if (status) {
    statusRow.append(status);
  }

  if (!player.isHuman && isActing(state, player)) {
    statusRow.append(createThinkingIndicator());
  }

  body.append(head, stats);

  if (statusRow.childElementCount > 0) {
    body.append(statusRow);
  }

  panel.append(avatar, body);

  if (!player.isHuman && player.cardCount > 0) {
    const handRow = createElement('div', { className: 'player-card__hand' });
    handRow.append(createOpponentHand(player.cardCount));
    panel.append(handRow);
  }

  return panel;
}

/**
 * @param {object} state
 * @param {object} player
 * @returns {'left' | 'right' | 'bottom' | 'center'}
 */
function getSeatPosition(state, player) {
  const human = state.players.find((entry) => entry.isHuman);

  if (human) {
    if (human.id === player.id) {
      return 'bottom';
    }

    const opponents = state.players.filter((entry) => !entry.isHuman);

    if (opponents[0]?.id === player.id) {
      return 'left';
    }

    if (opponents[1]?.id === player.id) {
      return 'right';
    }

    return 'center';
  }

  const index = state.players.indexOf(player);
  return ['left', 'right', 'center'][index] ?? 'center';
}

/**
 * @param {object} state
 * @param {object} player
 * @param {object} [options]
 * @param {string | null} [options.animatedCardId]
 * @param {string | null} [options.winnerId]
 * @returns {HTMLElement}
 */
function createTrickSlot(state, player, options = {}) {
  const entry = state.currentTrick.find((cardEntry) => cardEntry.playerId === player.id);
  const isWinner = options.winnerId === player.id;
  const slot = createElement('div', {
    className: [
      'trick-slot',
      `trick-slot--${getSeatPosition(state, player)}`,
      isWinner ? 'trick-slot--winner' : '',
    ].filter(Boolean),
    dataset: { playerId: player.id },
  });

  slot.append(createElement('span', { className: 'trick-slot__label', text: player.name }));

  if (entry) {
    const card = createCard(entry.cardId, { compact: true });

    if (entry.cardId === options.animatedCardId) {
      card.classList.add('card--played-now');
    }

    slot.append(card);
  } else {
    slot.append(createElement('span', {
      className: 'trick-slot__empty',
      text: '·',
      attrs: { 'aria-hidden': 'true' },
    }));
  }

  return slot;
}

/**
 * @param {object} state
 * @returns {string}
 */
function getCenterPhaseLabel(state) {
  const actor = findPlayer(state, state.currentPlayerId);
  const declarer = findPlayer(state, state.declarerId);

  switch (state.phase) {
    case PHASES.BIDDING:
      if (actor) {
        return actor.isHuman
          ? 'Торги · ваш ход'
          : `Торги · ход ${nameGenitive(actor.name)}`;
      }

      return 'Торги';
    case PHASES.PRIKUP:
      return declarer && !declarer.isHuman ? `Прикуп · ${declarer.name}` : 'Прикуп';
    case PHASES.GIVING:
      return declarer && !declarer.isHuman ? `Отдар · ${declarer.name}` : 'Отдар';
    case PHASES.PLAYING:
      if (actor) {
        return actor.isHuman ? 'Ваш ход' : `Ход ${nameGenitive(actor.name)}`;
      }

      return 'Розыгрыш';
    default:
      return getPhaseName(state.phase);
  }
}

/**
 * @param {string} label
 * @param {Node | string} value
 * @param {string | null} note
 * @returns {HTMLElement}
 */
function createIndicator(label, value, note = null) {
  const indicator = createElement('span', { className: 'indicator' });

  indicator.append(
    createElement('span', { className: 'indicator__label', text: label }),
    createElement('span', { className: 'indicator__value' }, value),
  );

  if (note) {
    indicator.append(createElement('span', { className: 'indicator__note', text: note }));
  }

  return indicator;
}

/**
 * @param {object} state
 * @returns {HTMLElement}
 */
function createTrumpIndicator(state) {
  if (!state.trumpSuit) {
    return createIndicator('Козырь', 'не объявлен');
  }

  const suit = SUIT_INFO[state.trumpSuit];
  const value = createElement('span', {
    className: ['indicator__suit', suit.color === 'red' ? 'suit--red' : ''],
  });

  value.append(
    createElement('span', { text: `${suit.symbol} ` }),
    document.createTextNode(getSuitNameLower(state.trumpSuit)),
  );

  const declarer = findPlayer(state, state.trumpDeclaredBy);

  return createIndicator('Козырь', value, declarer ? declarer.name : null);
}

/**
 * @param {object} state
 * @returns {HTMLElement}
 */
function createContractIndicator(state) {
  if (state.contract === null) {
    return createIndicator('Заказ', 'не определён');
  }

  const declarer = findPlayer(state, state.declarerId);

  return createIndicator(
    'Заказ',
    String(state.contract),
    declarer ? declarer.name : null,
  );
}

/**
 * Creates the central table area with the trick, phase and deal indicators.
 *
 * @param {object} state
 * @param {object} [options]
 * @param {string | null} [options.animatedCardId]
 * @param {string | null} [options.winnerId]
 * @returns {HTMLElement}
 */
export function createTableCenter(state, options = {}) {
  const inner = createElement('div', { className: 'table-center__inner' });
  const status = createElement('div', { className: 'center-status' });

  status.append(
    createElement('span', {
      className: 'phase-banner',
      text: getCenterPhaseLabel(state),
      attrs: { 'aria-live': 'polite' },
    }),
    createElement('span', {
      className: 'trick-counter',
      text: `${formatTricks(state.completedTricks.length)} из ${DEAL.TRICKS}`,
    }),
    createElement('span', {
      className: 'trick-points',
      attrs: { 'aria-label': 'Очки текущей взятки' },
    }, ...[
      createElement('span', { className: 'trick-points__label', text: 'Взятка' }),
      createElement('span', {
        className: 'trick-points__value',
        text: String(state.currentTrick.length === 0 ? 0 : getTrickPoints(state.currentTrick)),
      }),
    ]),
  );

  const trick = createElement('div', {
    className: 'trick',
    attrs: { 'aria-label': 'Карты текущей взятки' },
  });

  for (const player of state.players) {
    trick.append(createTrickSlot(state, player, options));
  }

  const meta = createElement('div', { className: 'center-meta' });
  meta.append(createTrumpIndicator(state), createContractIndicator(state));

  inner.append(status, trick, meta);
  return inner;
}

/**
 * Renders opponent panels, the human panel and the table center.
 *
 * @param {object} state
 * @param {object} elements
 * @param {HTMLElement} elements.opponents
 * @param {HTMLElement} elements.humanPanel
 * @param {HTMLElement} elements.tableCenter
 * @param {object} [options]
 * @param {string | null} [options.animatedCardId]
 * @param {string | null} [options.winnerId]
 */
export function renderTable(state, elements, options = {}) {
  const { opponents, humanPanel, tableCenter } = elements;
  const human = state.players.find((player) => player.isHuman) ?? state.players[0];
  const otherPlayers = state.players.filter((player) => player.id !== human.id);

  opponents.replaceChildren(
    ...otherPlayers.map((player) => createPlayerPanel(state, player)),
  );
  humanPanel.replaceChildren(createPlayerPanel(state, human));
  tableCenter.replaceChildren(createTableCenter(state, options));
}
