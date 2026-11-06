import { SUIT_INFO } from '../core/constants.js';
import { getCardById } from '../core/deck.js';
import { clearElement, createElement } from './dom.js';
import {
  formatCards,
  formatMarriage,
  getCardLabel,
  getCardShortLabel,
  getSuitNameLower,
  isFeminineName,
  nameDative,
} from './format.js';

const RED_SUITS = new Set(['D', 'H']);

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
 * @param {string} playerId
 * @returns {string}
 */
function playerName(state, playerId) {
  return findPlayer(state, playerId)?.name ?? 'Игрок';
}

/**
 * @param {object | null} player
 * @param {string} masculine
 * @param {string} feminine
 * @param {string} plural
 * @returns {string}
 */
function verbForPlayer(player, masculine, feminine, plural) {
  if (player?.isHuman) {
    return plural;
  }

  return isFeminineName(player?.name ?? '') ? feminine : masculine;
}

/**
 * @param {string} cardId
 * @returns {HTMLElement}
 */
function createCardChip(cardId) {
  const card = getCardById(cardId);
  const chip = createElement('span', {
    className: ['log-card', RED_SUITS.has(card.suit) ? 'log-card--red' : ''],
    text: getCardShortLabel(card),
    attrs: {
      title: getCardLabel(card),
      'aria-label': getCardLabel(card),
    },
  });

  return chip;
}

/**
 * @param {object} entry
 * @returns {{ symbol: string, isRed: boolean }}
 */
function getIcon(entry) {
  switch (entry.type) {
    case 'dealstarted':
      return { symbol: '♠', isRed: false };
    case 'bid':
      return { symbol: '↑', isRed: false };
    case 'pass':
      return { symbol: '—', isRed: false };
    case 'prikup':
      return { symbol: '↧', isRed: false };
    case 'gift':
      return { symbol: '⇄', isRed: false };
    case 'marriage': {
      const suit = entry.suit ? SUIT_INFO[entry.suit] : null;
      return {
        symbol: suit?.symbol ?? '♥',
        isRed: suit?.color === 'red',
      };
    }
    case 'cardplayed': {
      const suit = entry.cardId ? SUIT_INFO[getCardById(entry.cardId).suit] : null;
      return {
        symbol: suit?.symbol ?? '♦',
        isRed: suit?.color === 'red',
      };
    }
    case 'trickwon':
      return { symbol: '★', isRed: false };
    case 'scored':
      return { symbol: 'Σ', isRed: false };
    case 'gameover':
      return { symbol: '✓', isRed: false };
    default:
      return { symbol: '•', isRed: false };
  }
}

/**
 * Adds text to a log message.
 *
 * @param {HTMLElement} container
 * @param {string} value
 */
function addText(container, value) {
  container.append(document.createTextNode(value));
}

/**
 * Adds a highlighted number to a log message.
 *
 * @param {HTMLElement} container
 * @param {string | number} value
 */
function addStrong(container, value) {
  container.append(
    createElement('span', { className: 'log-entry__strong', text: String(value) }),
  );
}

/**
 * Creates one semantic log entry in Russian.
 *
 * @param {object} entry
 * @param {object} state
 * @returns {HTMLElement}
 */
export function createLogEntry(entry, state) {
  const element = createElement('article', {
    className: ['log-entry', `log-entry--${entry.type}`],
    dataset: { logType: entry.type },
  });
  const icon = getIcon(entry);
  const iconElement = createElement('span', {
    className: ['log-entry__icon', icon.isRed ? 'log-entry__icon--red' : ''],
    text: icon.symbol,
    attrs: { 'aria-hidden': 'true' },
  });
  const text = createElement('p', { className: 'log-entry__text' });

  switch (entry.type) {
    case 'dealstarted': {
      addText(text, `Раздача ${entry.dealNumber}. Сдаёт ${playerName(state, entry.dealerId)}.`);
      break;
    }
    case 'bid': {
      addText(text, `${playerName(state, entry.playerId)}: `);
      addStrong(text, entry.amount);
      break;
    }
    case 'pass': {
      addText(text, `${playerName(state, entry.playerId)}: Пас.`);
      break;
    }
    case 'prikup': {
      addText(
        text,
        `${playerName(state, entry.playerId)} берёт прикуп — ${formatCards(entry.count)}.`,
      );
      break;
    }
    case 'gift': {
      addText(text, `${playerName(state, entry.fromId)} отдаёт `);
      text.append(createCardChip(entry.cardId));
      addText(text, ` ${nameDative(playerName(state, entry.toId))}.`);
      break;
    }
    case 'marriage': {
      const player = findPlayer(state, entry.playerId);
      const verb = verbForPlayer(player, 'объявил', 'объявила', 'объявили');

      addText(
        text,
        `${playerName(state, entry.playerId)} ${verb} ${formatMarriage(entry.suit)} `
          + `(+${entry.value}). Козырь — ${getSuitNameLower(entry.suit)}.`,
      );
      break;
    }
    case 'cardplayed': {
      const player = findPlayer(state, entry.playerId);

      addText(
        text,
        `${playerName(state, entry.playerId)} ${player?.isHuman ? 'кладёте' : 'кладёт'} `,
      );
      text.append(createCardChip(entry.cardId));
      addText(text, '.');
      break;
    }
    case 'trickwon': {
      const player = findPlayer(state, entry.winnerId);
      const verb = verbForPlayer(player, 'взял', 'взяла', 'взяли');

      addText(text, `${playerName(state, entry.winnerId)} ${verb} взятку: `);
      addStrong(text, entry.points);
      addText(text, '.');
      break;
    }
    case 'scored': {
      addText(
        text,
        `Заказ ${entry.contract}: ${entry.contractMet ? 'выполнен' : 'не выполнен'}. `
          + `Играющий — ${playerName(state, entry.declarerId)}.`,
      );

      if (entry.boltsAwarded?.length > 0) {
        addText(text, ` Болт: ${entry.boltsAwarded.map((id) => playerName(state, id)).join(', ')}.`);
      }

      if (entry.boltsReset?.length > 0) {
        addText(
          text,
          ` Третий болт: ${entry.boltsReset.map((id) => playerName(state, id)).join(', ')} (−120).`,
        );
      }

      break;
    }
    case 'gameover': {
      addText(text, `Игра окончена. Победитель — ${playerName(state, entry.winnerId)}.`);
      break;
    }
    default: {
      addText(text, `Событие «${entry.type}».`);
    }
  }

  element.append(iconElement, text);
  return element;
}

/**
 * Clears the event log and forgets how many entries were rendered.
 *
 * @param {HTMLElement} logEl
 */
export function resetLog(logEl) {
  clearElement(logEl);
  delete logEl.dataset.renderedCount;
}

/**
 * Appends new semantic events and keeps the log scrolled to the latest entry.
 *
 * @param {object} state
 * @param {HTMLElement} logEl
 */
export function renderLog(state, logEl) {
  const parsed = Number.parseInt(logEl.dataset.renderedCount ?? '0', 10);
  const renderedCount = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  const entries = state.log;

  if (entries.length < renderedCount) {
    resetLog(logEl);
    return renderLog(state, logEl);
  }

  if (entries.length === 0) {
    if (!logEl.querySelector('.game-log__empty')) {
      logEl.append(
        createElement('p', {
          className: 'game-log__empty',
          text: 'Ставки, взятки и итоги раздач будут появляться здесь.',
        }),
      );
    }

    logEl.dataset.renderedCount = '0';
    return;
  }

  const empty = logEl.querySelector('.game-log__empty');

  if (empty) {
    empty.remove();
  }

  for (let index = renderedCount; index < entries.length; index += 1) {
    logEl.append(createLogEntry(entries[index], state));
  }

  logEl.dataset.renderedCount = String(entries.length);
  logEl.scrollTop = logEl.scrollHeight;
}
