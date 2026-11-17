import { SUIT_INFO } from '../core/constants.js';
import { createElement } from './dom.js';
import { formatMarriage, getSuitNameLower } from './format.js';

/**
 * Creates the button that opens the marriage picker. The button is only
 * rendered when at least one marriage can legally be declared.
 *
 * @param {object} options
 * @param {ReadonlyArray<{ suit: string, value: number }>} options.available
 * @param {() => void} options.onOpen
 * @returns {HTMLElement}
 */
export function createMarriageButton({ available, onOpen }) {
  const button = createElement('button', {
    className: ['button', 'marriage-button'],
    attrs: {
      type: 'button',
      'aria-haspopup': 'true',
      'aria-label': 'Объявить марьяж',
    },
    dataset: { action: 'open-marriage' },
  });

  button.append(
    createElement('span', { text: 'Объявить марьяж' }),
    createElement('span', {
      className: 'marriage-button__count',
      text: String(available.length),
      attrs: { 'aria-hidden': 'true' },
    }),
  );

  button.addEventListener('click', onOpen);
  return button;
}

/**
 * Shows the pending marriage status and, for the owner, the cancel action.
 *
 * @param {object} options
 * @param {string} options.suit Declared marriage suit.
 * @param {string} options.playerName Name of the declaring player.
 * @param {boolean} options.isSelf Whether the viewer owns the pending marriage.
 * @param {(() => void) | null} options.onCancel Cancel handler for the owner.
 * @returns {HTMLElement}
 */
export function createPendingMarriageStatus({
  suit,
  playerName,
  isSelf,
  onCancel,
}) {
  const wrapper = createElement('div', {
    className: ['action-bar__group', 'marriage-pending'],
  });
  const text = isSelf
    ? `Марьяж: ${getSuitNameLower(suit)}. Выйдите королём или дамой`
    : `Марьяж: ${getSuitNameLower(suit)}. ${playerName} выходит королём или дамой`;

  wrapper.append(createElement('span', {
    className: 'action-bar__status',
    text,
  }));

  if (onCancel) {
    const cancelButton = createElement('button', {
      className: ['button', 'button--ghost', 'marriage-cancel'],
      text: 'Отменить',
      attrs: { type: 'button', 'aria-label': 'Отменить объявленный марьяж' },
      dataset: { action: 'cancel-marriage' },
    });

    cancelButton.addEventListener('click', onCancel);
    wrapper.append(cancelButton);
  }

  return wrapper;
}

/**
 * Creates the suit picker for declaring a marriage. Each option shows the
 * suit symbol, the Russian name and the immediate bonus.
 *
 * @param {object} options
 * @param {ReadonlyArray<{ suit: string, value: number }>} options.available
 * @param {(suit: string) => void} options.onDeclare
 * @returns {HTMLElement}
 */
export function createMarriageMenu({ available, onDeclare }) {
  const menu = createElement('div', {
    className: 'marriage-menu',
    attrs: { role: 'group', 'aria-label': 'Доступные марьяжи' },
  });

  for (const marriage of available) {
    const suit = SUIT_INFO[marriage.suit];
    const option = createElement('button', {
      className: ['marriage-option', suit.color === 'red' ? 'suit--red' : ''],
      attrs: {
        type: 'button',
        'aria-label': `${formatMarriage(marriage.suit)}, плюс ${marriage.value}`,
      },
      dataset: { suit: marriage.suit },
    });

    option.append(
      createElement('span', {
        className: 'marriage-option__suit',
        text: suit.symbol,
        attrs: { 'aria-hidden': 'true' },
      }),
      createElement('span', {
        className: 'marriage-option__label',
        text: formatMarriage(marriage.suit),
      }),
      createElement('span', {
        className: 'marriage-option__bonus',
        text: `+${marriage.value}`,
      }),
    );

    option.addEventListener('click', () => onDeclare(marriage.suit));
    menu.append(option);
  }

  return menu;
}
