import { BIDDING } from '../core/constants.js';
import { createElement } from './dom.js';

/**
 * @typedef {import('../core/game.js').Game} Game
 */

/**
 * Returns every legal raise for the current auction. An opening auction only
 * allows exactly 100; later raises may jump, but must stay within 100–120.
 *
 * @param {number} currentBid Current bid, 0 when bidding has not opened yet.
 * @returns {number[]}
 */
export function getBidOptions(currentBid) {
  const base = Number.isFinite(currentBid) ? currentBid : 0;

  if (base <= 0) {
    return [BIDDING.MIN];
  }

  const options = [];

  for (
    let amount = base + BIDDING.STEP;
    amount <= BIDDING.MAX;
    amount += BIDDING.STEP
  ) {
    options.push(amount);
  }

  return options;
}

/**
 * Creates the bid button row for the human player. Buttons stay visible but
 * disabled when the turn belongs to an AI, so the auction context is clear.
 *
 * @param {object} options
 * @param {object} options.state Full game state snapshot.
 * @param {string} options.humanId Human player id.
 * @param {(amount: number) => void} options.onBid
 * @param {() => void} options.onPass
 * @returns {HTMLElement}
 */
export function createBiddingControls({
  state,
  humanId,
  onBid,
  onPass,
}) {
  const container = createElement('div', {
    className: 'bidding-controls',
    attrs: { role: 'group', 'aria-label': 'Торги' },
  });
  const actor = state.players.find((player) => player.id === state.currentBidderId);
  const isHumanTurn = state.currentBidderId === humanId;
  const options = getBidOptions(state.currentBid);
  const canPass = isHumanTurn && state.currentBid > 0;

  const info = createElement('div', { className: 'bidding-controls__info' });
  const title = createElement('span', {
    className: 'bidding-controls__title',
    text: state.currentBid === 0 ? 'Открытие торгов' : `Ставка ${state.currentBid}`,
  });
  const turn = createElement('span', {
    className: 'bidding-controls__turn',
    text: isHumanTurn
      ? 'Ваш ход'
      : (actor ? `Ходит ${actor.name}` : 'Торги завершаются'),
  });

  info.append(title, turn);

  const buttons = createElement('div', { className: 'bidding-controls__buttons' });

  for (const amount of options) {
    const button = createElement('button', {
      className: ['button', 'bid-button'],
      text: String(amount),
      attrs: {
        type: 'button',
        'aria-label': `Поставить ${amount}`,
      },
      dataset: { bid: amount },
    });

    button.disabled = !isHumanTurn;
    button.addEventListener('click', () => {
      if (!button.disabled) {
        onBid(amount);
      }
    });
    buttons.append(button);
  }

  const passButton = createElement('button', {
    className: ['button', 'button--ghost', 'bid-button', 'bid-button--pass'],
    text: 'Пас',
    attrs: { type: 'button', 'aria-label': 'Сказать «Пас»' },
    dataset: { action: 'pass' },
  });

  passButton.disabled = !canPass;
  passButton.addEventListener('click', () => {
    if (!passButton.disabled) {
      onPass();
    }
  });

  buttons.append(passButton);
  container.append(info, buttons);

  return container;
}

/**
 * Adds one speech bubble to a player panel. The bubble is intentionally
 * transient: panels are rebuilt on every state change and the controller
 * re-applies the stored bid bubble afterwards.
 *
 * @param {HTMLElement} panel
 * @param {string} text
 * @returns {HTMLElement}
 */
export function createSpeechBubble(panel, text) {
  const bubble = createElement('div', {
    className: 'speech-bubble',
    text,
    attrs: { role: 'status' },
  });

  panel.append(bubble);
  return bubble;
}

/**
 * Renders the last bid or pass of every AI player as a speech bubble.
 *
 * @param {HTMLElement} container Usually the opponents' grid.
 * @param {ReadonlyMap<string, string>} bubbles Player id to bubble text.
 * @returns {void}
 */
export function applySpeechBubbles(container, bubbles) {
  if (!container || bubbles.size === 0) {
    return;
  }

  const panels = [...container.querySelectorAll('[data-player-id]')];

  for (const [playerId, text] of bubbles) {
    const panel = panels.find((entry) => entry.dataset.playerId === playerId);

    if (panel) {
      createSpeechBubble(panel, text);
    }
  }
}
