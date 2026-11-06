/**
 * @typedef {'S' | 'C' | 'D' | 'H'} Suit
 * @typedef {'9' | 'J' | 'Q' | 'K' | '10' | 'A'} Rank
 */

const SUIT_DEFINITIONS = [
  {
    id: 'S',
    symbol: '♠',
    color: 'black',
    name: 'Пики',
    adjective: 'пиковый',
    genitive: 'пик',
    marriageBonus: 40,
  },
  {
    id: 'C',
    symbol: '♣',
    color: 'black',
    name: 'Трефы',
    adjective: 'трефовый',
    genitive: 'треф',
    marriageBonus: 60,
  },
  {
    id: 'D',
    symbol: '♦',
    color: 'red',
    name: 'Бубны',
    adjective: 'бубновый',
    genitive: 'бубен',
    marriageBonus: 80,
  },
  {
    id: 'H',
    symbol: '♥',
    color: 'red',
    name: 'Черви',
    adjective: 'червовый',
    genitive: 'червей',
    marriageBonus: 100,
  },
];

const RANK_DEFINITIONS = [
  { id: '9', name: 'Девятка', shortLabel: '9', strength: 1, value: 0 },
  { id: 'J', name: 'Валет', shortLabel: 'В', strength: 2, value: 2 },
  { id: 'Q', name: 'Дама', shortLabel: 'Д', strength: 3, value: 3 },
  { id: 'K', name: 'Король', shortLabel: 'К', strength: 4, value: 4 },
  { id: '10', name: 'Десятка', shortLabel: '10', strength: 5, value: 10 },
  { id: 'A', name: 'Туз', shortLabel: 'Т', strength: 6, value: 11 },
];

/** Suit ids in display order. */
export const SUITS = Object.freeze(SUIT_DEFINITIONS.map((suit) => suit.id));

/** Metadata for every suit, frozen for safe sharing. */
export const SUIT_INFO = Object.freeze(
  Object.fromEntries(
    SUIT_DEFINITIONS.map((suit) => [suit.id, Object.freeze({ ...suit })]),
  ),
);

/** Marriage bonus points keyed by suit. */
export const MARRIAGE_BONUSES = Object.freeze(
  Object.fromEntries(
    Object.values(SUIT_INFO).map((suit) => [suit.id, suit.marriageBonus]),
  ),
);

/** Rank ids from weakest to strongest. */
export const RANKS = Object.freeze(RANK_DEFINITIONS.map((rank) => rank.id));

/** Metadata for every rank, frozen for safe sharing. */
export const RANK_INFO = Object.freeze(
  Object.fromEntries(
    RANK_DEFINITIONS.map((rank) => [rank.id, Object.freeze({ ...rank })]),
  ),
);

/** Game phases in transition order. */
export const PHASES = Object.freeze({
  IDLE: 'IDLE',
  DEALING: 'DEALING',
  BIDDING: 'BIDDING',
  PRIKUP: 'PRIKUP',
  GIVING: 'GIVING',
  PLAYING: 'PLAYING',
  SCORING: 'SCORING',
  DEAL_END: 'DEAL_END',
  GAME_OVER: 'GAME_OVER',
});

/** Bidding limits. Every bid must be within the range and divisible by the step. */
export const BIDDING = Object.freeze({
  MIN: 80,
  MAX: 120,
  STEP: 5,
});

/** Card and deal sizes for the three-player game. */
export const DEAL = Object.freeze({
  CARD_COUNT: 24,
  CARDS_PER_SUIT: 6,
  PLAYER_COUNT: 3,
  INITIAL_HAND_SIZE: 7,
  PRIKUP_SIZE: 3,
  DECLARER_HAND_SIZE: 10,
  PLAYING_HAND_SIZE: 8,
  TRICKS: 8,
});

/** Bolt rules: three bolts cost 120 points and reset the counter. */
export const BOLTS = Object.freeze({
  LIMIT: 3,
  PENALTY: 120,
});

/** Score required for an outright win. */
export const TARGET_SCORE = 1000;

/** Semantic game event names emitted by the core. */
export const GAME_EVENTS = Object.freeze({
  STATE_CHANGE: 'statechange',
  DEAL_STARTED: 'dealstarted',
  BID: 'bid',
  PASS: 'pass',
  PRIKUP: 'prikup',
  GIFT: 'gift',
  MARRIAGE: 'marriage',
  CARD_PLAYED: 'cardplayed',
  TRICK_WON: 'trickwon',
  SCORED: 'scored',
  GAME_OVER: 'gameover',
  ERROR: 'error',
});
