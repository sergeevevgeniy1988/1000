import { PHASES, RANK_INFO, SUITS, SUIT_INFO } from '../core/constants.js';
import { getCardById } from '../core/deck.js';
import { clearElement, createElement } from './dom.js';
import { formatCards, getCardLabel } from './format.js';

const SUIT_ORDER = new Map(SUITS.map((suit, index) => [suit, index]));

/**
 * @typedef {import('../core/deck.js').Card} Card
 */

/**
 * @param {Card | string} cardLike
 * @returns {Card}
 */
function resolveCard(cardLike) {
  return typeof cardLike === 'string' ? getCardById(cardLike) : cardLike;
}

/**
 * Returns hand cards sorted by suit and descending strength.
 *
 * @param {ReadonlyArray<string | Card>} cardIds
 * @returns {Card[]}
 */
export function sortHand(cardIds) {
  return [...cardIds]
    .map(resolveCard)
    .sort((left, right) => {
      const suitDifference = SUIT_ORDER.get(left.suit) - SUIT_ORDER.get(right.suit);

      if (suitDifference !== 0) {
        return suitDifference;
      }

      return right.strength - left.strength;
    });
}

/**
 * Builds the visual card surface. Inner nodes are spans so the same markup can
 * live inside a `<button>` or a non-interactive `<div>`.
 *
 * @param {Card} card
 * @param {boolean} compact
 * @param {'button' | 'div'} tag
 * @returns {HTMLElement}
 */
function buildCardSurface(card, compact, tag) {
  const rank = RANK_INFO[card.rank];
  const suit = SUIT_INFO[card.suit];
  const isRed = suit.color === 'red';

  const surface = createElement(tag, {
    className: [
      'card',
      compact ? 'card--compact' : '',
      isRed ? 'card--red' : 'card--black',
    ],
    dataset: { cardId: card.id },
  });

  const topCorner = createElement('span', { className: 'card__corner card__corner--top' });
  topCorner.append(
    createElement('span', { className: 'card__rank', text: rank.shortLabel }),
    createElement('span', { className: 'card__suit', text: suit.symbol }),
  );

  const bottomCorner = createElement('span', { className: 'card__corner card__corner--bottom' });
  bottomCorner.append(
    createElement('span', { className: 'card__rank', text: rank.shortLabel }),
    createElement('span', { className: 'card__suit', text: suit.symbol }),
  );

  surface.append(
    topCorner,
    createElement('span', { className: 'card__center', text: suit.symbol }),
    bottomCorner,
  );

  return surface;
}

/**
 * Creates a card. With `interactive` it is a real button, otherwise a visual
 * surface exposed as an image with an accessible label.
 *
 * @param {Card | string} cardLike
 * @param {object} [options]
 * @param {boolean} [options.compact]
 * @param {boolean} [options.interactive]
 * @param {boolean | undefined} [options.legal]
 * @param {((card: Card) => void) | null} [options.onSelect]
 * @param {(() => void) | null} [options.onIllegal]
 * @returns {HTMLElement}
 */
export function createCard(cardLike, options = {}) {
  const {
    compact = false,
    interactive = false,
    legal,
    onSelect = null,
    onIllegal = null,
  } = options;
  const card = resolveCard(cardLike);
  const label = getCardLabel(card);
  const statusLabel = legal === false
    ? 'Сейчас играть нельзя'
    : (legal === true ? 'Можно сыграть' : null);
  const accessibleLabel = statusLabel ? `${label}. ${statusLabel}` : label;
  const surface = buildCardSurface(card, compact, interactive ? 'button' : 'div');

  surface.classList.add('card--surface');
  surface.setAttribute('title', accessibleLabel);
  surface.setAttribute('aria-label', accessibleLabel);

  if (interactive) {
    surface.setAttribute('type', 'button');
    surface.classList.add('card--interactive');

    if (legal === true) {
      surface.classList.add('card--legal');
    } else if (legal === false) {
      surface.classList.add('card--illegal');
      surface.setAttribute('aria-disabled', 'true');
      surface.tabIndex = -1;
    }

    if (typeof onSelect === 'function') {
      surface.addEventListener('click', () => {
        if (legal !== false) {
          onSelect(card);
        } else {
          onIllegal?.();
        }
      });
    }
  } else {
    surface.setAttribute('role', 'img');
  }

  return surface;
}

/**
 * Creates a card back used for opponents' hands.
 *
 * @param {object} [options]
 * @param {boolean} [options.compact]
 * @returns {HTMLElement}
 */
export function createCardBack({ compact = true } = {}) {
  return createElement('span', {
    className: ['card-back', compact ? 'card-back--compact' : ''],
    attrs: { 'aria-hidden': 'true' },
  });
}

/**
 * Creates a compact fan of card backs for an opponent panel.
 *
 * @param {number} cardCount
 * @returns {HTMLElement}
 */
export function createOpponentHand(cardCount) {
  const hand = createElement('div', {
    className: 'opponent-hand',
    attrs: { 'aria-hidden': 'true' },
  });

  for (let index = 0; index < cardCount; index += 1) {
    hand.append(createCardBack());
  }

  return hand;
}

/**
 * Renders the human hand from a game state snapshot.
 *
 * @param {object} state
 * @param {object} elements
 * @param {HTMLElement} elements.handEl
 * @param {string} elements.playerId
 * @param {((card: Card) => void) | null} [elements.onCardSelect]
 * @param {ReadonlyArray<string> | null} [elements.legalCardIds]
 * @param {(() => void) | null} [elements.onIllegalCard]
 */
export function renderHand(state, elements) {
  const {
    handEl,
    playerId,
    onCardSelect = null,
    legalCardIds = null,
    onIllegalCard = null,
  } = elements;
  const player = state.players.find((entry) => entry.id === playerId);
  const previousCards = handEl.querySelector('.hand__cards');
  const previousScrollLeft = previousCards instanceof HTMLElement
    ? previousCards.scrollLeft
    : 0;

  clearElement(handEl);

  if (!player) {
    return;
  }

  const head = createElement('div', { className: 'hand__head' });
  head.append(
    createElement('h2', { className: 'hand__title', text: 'Ваши карты' }),
    createElement('span', { className: 'hand__count', text: formatCards(player.cardCount) }),
  );

  handEl.append(head);

  if (player.hand.length === 0) {
    let message = 'После раздачи здесь появятся ваши карты.';

    if (state.phase === PHASES.SCORING || state.phase === PHASES.DEAL_END) {
      message = 'Раздача завершена — итоги в журнале.';
    } else if (state.phase === PHASES.GAME_OVER) {
      message = 'Игра завершена.';
    }

    handEl.append(createElement('p', { className: 'hand__empty', text: message }));
    return;
  }

  const cards = sortHand(player.hand);
  const legalSet = legalCardIds === null ? null : new Set(legalCardIds);
  const cardsEl = createElement('div', { className: 'hand__cards' });
  const interactive = typeof onCardSelect === 'function';

  for (const card of cards) {
    cardsEl.append(
      createCard(card, {
        interactive,
        legal: legalSet === null ? undefined : legalSet.has(card.id),
        onSelect: onCardSelect,
        onIllegal: onIllegalCard,
      }),
    );
  }

  handEl.append(cardsEl);
  cardsEl.scrollLeft = previousScrollLeft;
}
