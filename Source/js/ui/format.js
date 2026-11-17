import { PHASES, RANK_INFO, SUIT_INFO } from '../core/constants.js';
import { getCardById } from '../core/deck.js';

/**
 * @typedef {import('../core/deck.js').Card} Card
 */

/**
 * Resolves the player whose seat the current snapshot belongs to. New
 * snapshots carry `viewerId`; older fixtures without it fall back to an
 * explicit id or to the single `isHuman` player.
 *
 * @param {object | null | undefined} state
 * @param {string | null} [fallbackId]
 * @returns {string | null}
 */
export function resolveViewerId(state, fallbackId = null) {
  if (state && typeof state.viewerId === 'string' && state.viewerId.length > 0) {
    return state.viewerId;
  }

  if (typeof fallbackId === 'string' && fallbackId.length > 0) {
    return fallbackId;
  }

  const humanPlayers = Array.isArray(state?.players)
    ? state.players.filter((player) => player?.isHuman === true)
    : [];

  return humanPlayers.length === 1 ? humanPlayers[0].id : null;
}

/**
 * Chooses the Russian plural form for a number.
 *
 * @param {number} count
 * @param {string} one Form for 1, 21, 31…
 * @param {string} few Form for 2–4, 22–24…
 * @param {string} many Form for 0, 5–20, 25–30…
 * @returns {string}
 */
export function pluralizeRu(count, one, few, many) {
  const absolute = Math.abs(Number(count)) % 100;
  const lastDigit = absolute % 10;

  if (absolute > 10 && absolute < 20) {
    return many;
  }

  if (lastDigit === 1) {
    return one;
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }

  return many;
}

/**
 * @param {number} count
 * @returns {string} For example "3 взятки".
 */
export function formatTricks(count) {
  return `${count} ${pluralizeRu(count, 'взятка', 'взятки', 'взяток')}`;
}

/**
 * @param {number} count
 * @returns {string} For example "2 болта".
 */
export function formatBolts(count) {
  return `${count} ${pluralizeRu(count, 'болт', 'болта', 'болтов')}`;
}

/**
 * @param {number} count
 * @returns {string} For example "7 карт".
 */
export function formatCards(count) {
  return `${count} ${pluralizeRu(count, 'карта', 'карты', 'карт')}`;
}

/**
 * @param {number} count
 * @returns {string} For example "10 очков".
 */
export function formatPoints(count) {
  return `${count} ${pluralizeRu(count, 'очко', 'очка', 'очков')}`;
}

/**
 * Formats a score with the typographic minus sign.
 *
 * @param {number} score
 * @returns {string}
 */
export function formatScore(score) {
  if (!Number.isFinite(score)) {
    return '—';
  }

  return String(score).replace('-', '−');
}

/**
 * Formats a score delta with an explicit sign.
 *
 * @param {number} delta
 * @returns {string}
 */
export function formatSignedScore(delta) {
  if (!Number.isFinite(delta) || delta === 0) {
    return '0';
  }

  return `${delta > 0 ? '+' : '−'}${formatScore(Math.abs(delta))}`;
}

/**
 * Resolves a card id or card-like object to the canonical card.
 *
 * @param {Card | string} cardLike
 * @returns {Card}
 */
function resolveCard(cardLike) {
  return typeof cardLike === 'string' ? getCardById(cardLike) : cardLike;
}

/**
 * Returns the full Russian card name: "Десятка червей".
 *
 * @param {Card | string} cardLike
 * @returns {string}
 */
export function getCardName(cardLike) {
  const card = resolveCard(cardLike);
  return `${RANK_INFO[card.rank].name} ${SUIT_INFO[card.suit].genitive}`;
}

/**
 * Returns the short Russian card name: "10♥".
 *
 * @param {Card | string} cardLike
 * @returns {string}
 */
export function getCardShortLabel(cardLike) {
  const card = resolveCard(cardLike);
  return `${RANK_INFO[card.rank].shortLabel}${SUIT_INFO[card.suit].symbol}`;
}

/**
 * Returns the accessible card label: "Десятка червей, 10 очков".
 *
 * @param {Card | string} cardLike
 * @returns {string}
 */
export function getCardLabel(cardLike) {
  const card = resolveCard(cardLike);
  return `${getCardName(card)}, ${formatPoints(card.value)}`;
}

/**
 * @param {string} suit
 * @returns {string} Lower-case plural suit name: "черви".
 */
export function getSuitNameLower(suit) {
  return SUIT_INFO[suit].name.toLowerCase();
}

/**
 * @param {string | null | undefined} suit
 * @returns {string}
 */
export function formatTrump(suit) {
  if (!suit || !SUIT_INFO[suit]) {
    return 'Козырь не объявлен';
  }

  return `Козырь — ${getSuitNameLower(suit)}`;
}

/**
 * @param {string} suit
 * @returns {string} For example "червовый марьяж".
 */
export function formatMarriage(suit) {
  return `${SUIT_INFO[suit].adjective} марьяж`;
}

/**
 * @param {string} phase
 * @returns {string}
 */
export function getPhaseName(phase) {
  switch (phase) {
    case PHASES.IDLE:
      return 'Ожидание';
    case PHASES.DEALING:
      return 'Раздача';
    case PHASES.BIDDING:
      return 'Торги';
    case PHASES.PRIKUP:
      return 'Прикуп';
    case PHASES.GIVING:
      return 'Отдар';
    case PHASES.PLAYING:
      return 'Розыгрыш';
    case PHASES.SCORING:
      return 'Подсчёт';
    case PHASES.DEAL_END:
      return 'Итоги раздачи';
    case PHASES.GAME_OVER:
      return 'Игра окончена';
    default:
      return 'Партия';
  }
}

/**
 * @param {string} name
 * @returns {boolean} True for names that look feminine in Russian.
 */
export function isFeminineName(name) {
  return /[ая]$/i.test(name);
}

/**
 * @param {string} name
 * @returns {string} Genitive form used in "ход Алисы" and similar phrases.
 */
export function nameGenitive(name) {
  if (name === 'Вы') {
    return 'Вас';
  }

  if (/[ая]$/i.test(name)) {
    return `${name.slice(0, -1)}${name.endsWith('я') ? 'и' : 'ы'}`;
  }

  return `${name}а`;
}

/**
 * @param {string} name
 * @returns {string} Dative form used in "отдать Борису".
 */
export function nameDative(name) {
  if (name === 'Вы') {
    return 'Вам';
  }

  if (/[ая]$/i.test(name)) {
    return `${name.slice(0, -1)}е`;
  }

  return `${name}у`;
}

/**
 * @param {ReadonlyArray<string>} names
 * @param {(name: string) => string} decline
 * @returns {string}
 */
function joinDeclinedNames(names, decline) {
  const forms = names
    .filter((name) => typeof name === 'string' && name.length > 0)
    .map(decline);

  if (forms.length === 0) {
    return '';
  }

  if (forms.length === 1) {
    return forms[0];
  }

  return `${forms.slice(0, -1).join(', ')} и ${forms[forms.length - 1]}`;
}

/**
 * @param {ReadonlyArray<string>} names
 * @returns {string} For example "Анны и Бориса".
 */
export function formatGenitiveNames(names) {
  return joinDeclinedNames(names, nameGenitive);
}

/**
 * @param {ReadonlyArray<string>} names
 * @returns {string} For example "Анне и Борису".
 */
export function formatDativeNames(names) {
  return joinDeclinedNames(names, nameDative);
}
