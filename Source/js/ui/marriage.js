import { SUIT_INFO } from '../core/constants.js';
import { createElement } from './dom.js';
import { formatMarriage } from './format.js';

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
