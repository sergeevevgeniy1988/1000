import { BIDDING, PHASES } from '../core/constants.js';
import { getCardById } from '../core/deck.js';
import { GameError } from '../core/errors.js';
import {
  getAvailableMarriages,
  getLegalCards,
  getTrickPoints,
  getTrickWinner,
} from '../core/rules.js';
import {
  evaluateDiscardRisk,
  evaluateGiftRisk,
  evaluateHand,
  evaluateLeadCard,
  getBossCardIds,
  resolveCards,
} from './evaluate.js';

/**
 * @typedef {import('../core/deck.js').Card} Card
 */

/**
 * Generic AI personalities. Alice is cautious, Boris is aggressive; the same
 * settings are used when an AI drives the human seat in tests.
 */
export const AI_PERSONALITIES = Object.freeze({
  cautious: Object.freeze({
    name: 'cautious',
    bidBias: -6,
    bidVariance: 10,
    randomness: 0.6,
  }),
  balanced: Object.freeze({
    name: 'balanced',
    bidBias: 0,
    bidVariance: 10,
    randomness: 0.9,
  }),
  aggressive: Object.freeze({
    name: 'aggressive',
    bidBias: 6,
    bidVariance: 14,
    randomness: 1.3,
  }),
});

const PERSONALITY_BY_PLAYER = Object.freeze({
  alice: 'cautious',
  boris: 'aggressive',
  human: 'balanced',
});

/**
 * Picks a personality: an explicit one, one based on the player id, or the
 * balanced default.
 *
 * @param {string | object | null | undefined} personality
 * @param {string | null} [playerId]
 * @returns {object}
 */
function resolvePersonality(personality, playerId = null) {
  if (typeof personality === 'string') {
    return AI_PERSONALITIES[personality] ?? AI_PERSONALITIES.balanced;
  }

  if (personality && typeof personality === 'object') {
    return Object.freeze({ ...AI_PERSONALITIES.balanced, ...personality });
  }

  const preset = playerId === null ? null : PERSONALITY_BY_PLAYER[playerId];

  return preset ? AI_PERSONALITIES[preset] : AI_PERSONALITIES.balanced;
}

/**
 * Normalizes the optional settings object accepted by every public AI helper.
 *
 * @param {object} [options]
 * @returns {{ playerId: string | null, personality: object, rng: () => number }}
 */
function normalizeOptions(options = {}) {
  return {
    playerId: typeof options.playerId === 'string' ? options.playerId : null,
    personality: resolvePersonality(options.personality, options.playerId),
    rng: typeof options.rng === 'function' ? options.rng : Math.random,
  };
}

/**
 * Reads a random value and guards against a broken injected RNG.
 *
 * @param {() => number} rng
 * @returns {number}
 */
function randomValue(rng) {
  const value = rng();

  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1 - Number.EPSILON, Math.max(0, value))
    : 0.5;
}

/**
 * Finds the acting player and verifies that the snapshot is a player view.
 * Only the acting player's hand may be visible; a full `getState()` snapshot is
 * rejected so AI cannot accidentally peek at foreign hands.
 *
 * @param {object} view
 * @param {string} actorId
 * @returns {object}
 */
function getSelf(view, actorId) {
  if (!view || typeof view !== 'object' || !Array.isArray(view.players)) {
    throw new GameError('INVALID_VIEW', 'AI ожидает снимок состояния игры.');
  }

  const self = view.players.find((player) => player && player.id === actorId);

  if (!self) {
    throw new GameError('UNKNOWN_PLAYER', `В снимке нет игрока ${actorId}.`);
  }

  const visibleHands = view.players.filter(
    (player) => player && Array.isArray(player.hand) && player.hand.length > 0,
  );

  if (visibleHands.some((player) => player.id !== actorId)) {
    throw new GameError(
      'FOREIGN_HAND_VISIBLE',
      'AI получил полное состояние вместо player view: видны чужие руки.',
    );
  }

  return self;
}

/**
 * Resolves the player whose turn it is for the requested action.
 *
 * @param {object} view
 * @param {'bid' | 'gifts' | 'raise' | 'play'} action
 * @param {{ playerId: string | null }} options
 * @returns {string}
 */
function resolveActorId(view, action, options) {
  const candidates = {
    bid: view?.currentBidderId,
    gifts: view?.declarerId,
    raise: view?.declarerId,
    play: view?.currentPlayerId,
  };
  const actorId = candidates[action];

  if (typeof actorId !== 'string' || actorId.length === 0) {
    throw new GameError('INVALID_STATE', `В фазе ${String(view?.phase)} нет активного игрока.`);
  }

  if (options.playerId !== null && options.playerId !== actorId) {
    throw new GameError(
      'NOT_AI_TURN',
      `AI игрока ${options.playerId} не может действовать за игрока ${actorId}.`,
    );
  }

  return actorId;
}

/**
 * @param {object} view
 * @param {string} actorId
 * @returns {{ self: object, hand: Card[] }}
 */
function getSelfHand(view, actorId) {
  const self = getSelf(view, actorId);

  return {
    self,
    hand: resolveCards(self.hand),
  };
}

/**
 * Collects public information about cards already played in this deal.
 *
 * @param {object} view
 * @returns {string[]}
 */
function getPlayedCardIds(view) {
  const ids = [];

  for (const trick of view.completedTricks ?? []) {
    for (const entry of trick.cards ?? []) {
      ids.push(entry.cardId);
    }
  }

  for (const entry of view.currentTrick ?? []) {
    ids.push(entry.cardId);
  }

  return ids;
}

/**
 * Infers which suits a player is known to be void in, based on public tricks.
 *
 * @param {object} view
 * @returns {Map<string, Set<string>>}
 */
function inferVoidSuits(view) {
  const voids = new Map();

  const inspectTrick = (entries) => {
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }

    const leadSuit = getCardById(entries[0].cardId).suit;

    for (const entry of entries) {
      const card = getCardById(entry.cardId);

      if (card.suit !== leadSuit) {
        const suits = voids.get(entry.playerId) ?? new Set();
        suits.add(leadSuit);
        voids.set(entry.playerId, suits);
      }
    }
  };

  for (const trick of view.completedTricks ?? []) {
    inspectTrick(trick.cards);
  }

  inspectTrick(view.currentTrick);

  return voids;
}

/**
 * Checks whether this AI has already declared a marriage during the current
 * trick. The public log is enough to answer this without any hidden data.
 *
 * @param {object} view
 * @param {string} actorId
 * @returns {boolean}
 */
function hasDeclaredMarriageThisTrick(view, actorId) {
  const log = Array.isArray(view.log) ? view.log : [];

  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index];

    if (entry.type === 'trickwon') {
      return false;
    }

    if (entry.type === 'marriage' && entry.playerId === actorId) {
      return true;
    }
  }

  return false;
}

/**
 * Returns legal cards derived from the view, or null when the view is not in a
 * playable state.
 *
 * @param {object} view
 * @param {string} actorId
 * @param {Card[]} hand
 * @returns {Card[] | null}
 */
function getViewLegalCards(view, actorId, hand) {
  if (!Array.isArray(view.currentTrick)) {
    return null;
  }

  const leadSuit = view.currentTrick.length === 0
    ? null
    : getCardById(view.currentTrick[0].cardId).suit;

  return getLegalCards(hand, leadSuit, view.trumpSuit ?? null);
}

/**
 * Resolves a legal-card list supplied by the caller and keeps only entries that
 * are actually in the hand and legal in the view.
 *
 * @param {ReadonlyArray<Card | string> | null | undefined} legalCards
 * @param {Card[]} hand
 * @param {Card[]} expectedLegal
 * @returns {Card[]}
 */
function normalizeLegalCards(legalCards, hand, expectedLegal) {
  if (legalCards === null || legalCards === undefined) {
    return expectedLegal;
  }

  if (!Array.isArray(legalCards)) {
    throw new GameError('INVALID_ARGUMENT', 'Список легальных карт должен быть массивом.');
  }

  const resolved = legalCards.map((entry) => {
    if (typeof entry === 'string') {
      return getCardById(entry);
    }

    if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
      return getCardById(entry.id);
    }

    throw new GameError('INVALID_CARD', 'В списке легальных карт есть некорректная запись.');
  });
  const handIds = new Set(hand.map((card) => card.id));
  const expectedIds = new Set(expectedLegal.map((card) => card.id));
  const filtered = resolved.filter(
    (card) => handIds.has(card.id) && expectedIds.has(card.id),
  );

  if (filtered.length === 0) {
    throw new GameError('INVALID_LEGAL_CARDS', 'Список легальных карт не соответствует состоянию.');
  }

  return filtered;
}

/**
 * Builds the fallback card list directly from a view. Used when the main
 * heuristics or the supplied legal list fail.
 *
 * @param {object} view
 * @param {ReadonlyArray<Card | string> | null | undefined} legalCards
 * @returns {Card[]}
 */
function getFallbackLegalCards(view, legalCards) {
  const actorId = view?.currentPlayerId;

  if (typeof actorId !== 'string') {
    return [];
  }

  const self = view.players?.find((player) => player && player.id === actorId);

  if (!self || !Array.isArray(self.hand)) {
    return [];
  }

  try {
    const hand = resolveCards(self.hand);
    const legal = getViewLegalCards(view, actorId, hand) ?? [];

    if (legal.length > 0) {
      return legal;
    }

    const resolvedProvided = Array.isArray(legalCards)
      ? legalCards.map((entry) => (typeof entry === 'string' ? getCardById(entry) : getCardById(entry?.id)))
      : [];
    const handIds = new Set(hand.map((card) => card.id));

    return resolvedProvided.filter((card) => handIds.has(card.id));
  } catch {
    return [];
  }
}

/**
 * Chooses a lead card (the AI is the first player in the trick).
 *
 * @param {object} view
 * @param {string} actorId
 * @param {Card[]} hand
 * @param {Card[]} legal
 * @param {object} settings
 * @returns {Card}
 */
function chooseLeadCard(view, actorId, hand, legal, settings) {
  const playedCards = getPlayedCardIds(view);
  const voidSuits = inferVoidSuits(view);
  const opponents = view.players.filter(
    (player) => player.id !== actorId && player.cardCount > 0,
  );
  const isDeclarer = view.declarerId === actorId;
  const trumpSuit = view.trumpSuit ?? null;

  let best = null;

  for (const card of legal) {
    let score = evaluateLeadCard(card, hand, { trumpSuit, playedCards });
    const isTrump = Boolean(trumpSuit && card.suit === trumpSuit);

    if (!isTrump) {
      const voidCount = opponents.filter(
        (player) => voidSuits.get(player.id)?.has(card.suit),
      ).length;

      if (voidCount > 0) {
        score -= voidCount * 22;
      }
    }

    if (isDeclarer && getBossCardIds(hand, playedCards).has(card.id)) {
      score += 4;
    }

    score += randomValue(settings.rng) * settings.personality.randomness;

    if (best === null || score > best.score) {
      best = { card, score };
    }
  }

  return best.card;
}

/**
 * Chooses a card when following the current trick.
 *
 * @param {object} view
 * @param {string} actorId
 * @param {Card[]} hand
 * @param {Card[]} legal
 * @param {object} settings
 * @returns {Card}
 */
function chooseFollowCard(view, actorId, hand, legal, settings) {
  const trumpSuit = view.trumpSuit ?? null;
  const currentTrick = view.currentTrick;
  const currentWinnerId = getTrickWinner(currentTrick, trumpSuit);
  const trickPoints = getTrickPoints(currentTrick);
  const isDeclarer = view.declarerId === actorId;
  const playedPlayerIds = new Set(currentTrick.map((entry) => entry.playerId));
  const unplayedCount = view.players.filter(
    (player) => player.id !== actorId && !playedPlayerIds.has(player.id) && player.cardCount > 0,
  ).length;
  const isLast = unplayedCount === 0;
  const declaredMarriages = view.players.find((player) => player.id === actorId)?.declaredMarriages ?? [];

  let winDesire = trickPoints + 4;

  if (isLast) {
    winDesire += 10;
  } else {
    winDesire -= 6;
  }

  if (isDeclarer) {
    winDesire += 6;
  } else if (currentWinnerId === view.declarerId) {
    winDesire += 10;
  }

  let bestWinning = null;
  let bestDiscard = null;

  for (const card of legal) {
    const isTrump = Boolean(trumpSuit && card.suit === trumpSuit);
    const isMarriageCard = (card.rank === 'K' || card.rank === 'Q')
      && hand.some((entry) => entry.suit === card.suit
        && entry.rank === (card.rank === 'K' ? 'Q' : 'K'))
      && !declaredMarriages.includes(card.suit);
    const wins = getTrickWinner(
      [...currentTrick, { playerId: actorId, cardId: card.id }],
      trumpSuit,
    ) === actorId;

    if (wins) {
      let cost = 2 + Math.min(card.value, 11) * 0.6;

      if (isTrump) {
        cost += 10;
      }

      if (card.rank === 'A' || card.rank === '10') {
        cost += 6;
      }

      if (isMarriageCard) {
        cost += 8;
      }

      cost -= card.strength * 0.5;

      if (bestWinning === null || cost < bestWinning.cost) {
        bestWinning = { card, cost };
      }
    } else {
      const risk = evaluateDiscardRisk(card, hand, {
        trumpSuit,
        declaredMarriages,
      }) + randomValue(settings.rng) * settings.personality.randomness;

      if (bestDiscard === null || risk < bestDiscard.risk) {
        bestDiscard = { card, risk };
      }
    }
  }

  if (bestWinning && winDesire >= bestWinning.cost) {
    return bestWinning.card;
  }

  if (bestDiscard) {
    return bestDiscard.card;
  }

  // Every legal card wins the trick but none is attractive; spend the cheapest.
  return bestWinning.card;
}

/**
 * Chooses a bid for the current auction. The opening bidder is forced to say
 * exactly BIDDING.MIN (80); everyone else may pass or raise by a legal step.
 * A player with a negative score can only make the forced opening bid.
 *
 * @param {object} view Player view of the bidding AI.
 * @param {number | null} [currentBid] Current bid from the view.
 * @param {object} [options]
 * @param {string} [options.playerId] Expected acting player.
 * @param {string | object} [options.personality] Personality preset or overrides.
 * @param {() => number} [options.rng] Random source for slight variation.
 * @returns {number | null} Bid amount or null for a pass.
 */
export function chooseBid(view, currentBid = view?.currentBid, options = {}) {
  const settings = normalizeOptions(options);
  const knownBid = Number.isFinite(currentBid)
    ? currentBid
    : (Number.isFinite(view?.currentBid) ? view.currentBid : 0);

  try {
    if (!view || view.phase !== PHASES.BIDDING) {
      throw new GameError('INVALID_PHASE', 'Выбор ставки доступен только в фазе торгов.');
    }

    const actorId = resolveActorId(view, 'bid', settings);
    const { self, hand } = getSelfHand(view, actorId);

    if (knownBid === 0) {
      return BIDDING.MIN;
    }

    if (Number.isFinite(self.score) && self.score < 0) {
      return null;
    }

    if (knownBid >= BIDDING.MAX) {
      return null;
    }

    const nextBid = Math.floor(knownBid / BIDDING.STEP) * BIDDING.STEP + BIDDING.STEP;

    if (nextBid > BIDDING.MAX) {
      return null;
    }

    const evaluation = evaluateHand(hand);
    const noise = (randomValue(settings.rng) - 0.5) * settings.personality.bidVariance;
    const rawCeiling = evaluation.estimatedPoints
      + settings.personality.bidBias
      + noise;
    const ceiling = Math.min(
      BIDDING.MAX,
      Math.max(
        BIDDING.MIN,
        Math.floor(rawCeiling / BIDDING.STEP) * BIDDING.STEP,
      ),
    );

    return nextBid <= ceiling ? nextBid : null;
  } catch (error) {
    console.error('[AI] Не удалось выбрать ставку, используется резервное решение.', error);

    return knownBid === 0 ? BIDDING.MIN : null;
  }
}

/**
 * Chooses whether to raise the contract after taking the prikup. The decision
 * compares the evaluated ten-card hand with the current contract and never
 * proposes a raise for negative-score players.
 *
 * @param {object} view Player view of the declarer.
 * @param {object} [options]
 * @param {string} [options.playerId] Expected acting player.
 * @param {string | object} [options.personality] Personality preset or overrides.
 * @param {() => number} [options.rng] Random source for slight variation.
 * @returns {number | null} A legal contract amount or null to decline.
 */
export function chooseContractRaise(view, options = {}) {
  const settings = normalizeOptions(options);

  try {
    if (!view || view.phase !== PHASES.GIVING) {
      return null;
    }

    const actorId = resolveActorId(view, 'raise', settings);
    const { self, hand } = getSelfHand(view, actorId);

    if (view.raiseDecided === true) {
      return null;
    }

    if (Array.isArray(view.givenCards) && view.givenCards.length > 0) {
      return null;
    }

    if (Number.isFinite(self.score) && self.score < 0) {
      return null;
    }

    const contract = Number.isFinite(view.contract) ? view.contract : 0;

    if (contract >= BIDDING.MAX) {
      return null;
    }

    const evaluation = evaluateHand(hand);
    const noise = (randomValue(settings.rng) - 0.5) * settings.personality.bidVariance;
    const estimate = evaluation.estimatedPoints
      + settings.personality.bidBias
      + noise
      - BIDDING.STEP * 2;
    const target = Math.floor(estimate / BIDDING.STEP) * BIDDING.STEP;

    if (target <= contract) {
      return null;
    }

    return Math.min(BIDDING.MAX, target);
  } catch (error) {
    console.error('[AI] Не удалось выбрать повышение заказа.', error);

    return null;
  }
}

/**
 * Chooses one gift card for every opponent who has not received one yet.
 *
 * @param {object} view Player view of the declarer.
 * @param {object} [options]
 * @param {string} [options.playerId] Expected acting player.
 * @param {() => number} [options.rng] Random source for tie-breaking.
 * @returns {{ toPlayerId: string, cardId: string }[]}
 */
export function chooseCardsToGive(view, options = {}) {
  const settings = normalizeOptions(options);

  try {
    if (!view || view.phase !== PHASES.GIVING) {
      throw new GameError('INVALID_PHASE', 'Отдар доступен только в фазе GIVING.');
    }

    const actorId = resolveActorId(view, 'gifts', settings);
    const { self, hand } = getSelfHand(view, actorId);
    const received = new Set((view.givenCards ?? []).map((gift) => gift.toId));
    const targets = view.players.filter(
      (player) => player.id !== actorId && !received.has(player.id),
    );

    if (targets.length === 0) {
      return [];
    }

    const declaredMarriages = self.declaredMarriages ?? [];
    const ranked = [...hand]
      .map((card) => ({
        card,
        risk: evaluateGiftRisk(card, hand, { declaredMarriages })
          + randomValue(settings.rng) * 0.01,
      }))
      .sort((left, right) => left.risk - right.risk);
    const gifts = [];

    for (const target of targets) {
      const choice = ranked.shift();

      if (!choice) {
        break;
      }

      gifts.push({
        toPlayerId: target.id,
        cardId: choice.card.id,
      });
    }

    return gifts;
  } catch (error) {
    console.error('[AI] Не удалось выбрать карты для отдара.', error);

    return [];
  }
}

/**
 * Chooses a marriage to declare before leading a trick. Returns null when no
 * marriage is legal or useful right now.
 *
 * @param {object} view Player view of the leading AI.
 * @param {object} [options]
 * @param {string} [options.playerId] Expected acting player.
 * @param {() => number} [options.rng] Random source for tie-breaking.
 * @returns {string | null} Suit id.
 */
export function chooseMarriage(view, options = {}) {
  const settings = normalizeOptions(options);

  try {
    if (!view || view.phase !== PHASES.PLAYING) {
      return null;
    }

    const actorId = resolveActorId(view, 'play', settings);
    const { self, hand } = getSelfHand(view, actorId);

    if (!Array.isArray(view.currentTrick) || view.currentTrick.length > 0) {
      return null;
    }

    if (!Array.isArray(view.completedTricks) || view.completedTricks.length < 1) {
      return null;
    }

    if (hasDeclaredMarriageThisTrick(view, actorId)) {
      return null;
    }

    const available = getAvailableMarriages(hand, self.declaredMarriages ?? []);

    if (available.length === 0) {
      return null;
    }

    const isDeclarer = view.declarerId === actorId;
    const contract = Number.isFinite(view.contract) ? view.contract : 0;
    const collected = (self.trickPoints ?? 0) + (self.marriagePoints ?? 0);

    let best = null;

    for (const marriage of available) {
      const suitCards = hand.filter((card) => card.suit === marriage.suit);
      const highCards = suitCards.filter(
        (card) => card.rank === 'A' || card.rank === '10',
      ).length;
      let score = marriage.value + suitCards.length * 6 + highCards * 4;

      if (view.trumpSuit === marriage.suit) {
        score += 6;
      } else if (!view.trumpSuit) {
        score += 18;
      }

      if (!isDeclarer && view.trumpDeclaredBy && view.trumpDeclaredBy !== actorId) {
        score += 12;
      }

      if (isDeclarer && collected < contract) {
        score += 10;
      }

      if (settings.personality.name === 'aggressive') {
        score += 4;
      } else if (settings.personality.name === 'cautious') {
        score -= 2;
      }

      score += randomValue(settings.rng) * 0.5;

      if (best === null || score > best.score) {
        best = { suit: marriage.suit, score };
      }
    }

    return best.suit;
  } catch (error) {
    console.error('[AI] Не удалось выбрать марьяж.', error);

    return null;
  }
}

/**
 * Chooses a legal card for the current trick.
 *
 * @param {object} view Player view of the acting AI.
 * @param {ReadonlyArray<Card | string> | null} [legalCards] Legal cards supplied
 *   by the caller. When omitted, they are derived from the view.
 * @param {object} [options]
 * @param {string} [options.playerId] Expected acting player.
 * @param {() => number} [options.rng] Random source for tie-breaking.
 * @returns {Card}
 */
export function chooseCard(view, legalCards = null, options = {}) {
  const settings = normalizeOptions(options);

  try {
    if (!view || view.phase !== PHASES.PLAYING) {
      throw new GameError('INVALID_PHASE', 'Выбор карты доступен только в фазе розыгрыша.');
    }

    const actorId = resolveActorId(view, 'play', settings);
    const { hand } = getSelfHand(view, actorId);
    const derivedLegal = getViewLegalCards(view, actorId, hand);

    if (!derivedLegal || derivedLegal.length === 0) {
      throw new GameError('NO_LEGAL_CARDS', 'Для текущего хода нет легальных карт.');
    }

    const legal = normalizeLegalCards(legalCards, hand, derivedLegal);

    if (view.currentTrick.length === 0) {
      return chooseLeadCard(view, actorId, hand, legal, settings);
    }

    return chooseFollowCard(view, actorId, hand, legal, settings);
  } catch (error) {
    console.error('[AI] Не удалось выбрать карту, играется первая легальная.', error);

    const fallback = getFallbackLegalCards(view, legalCards)[0];

    if (!fallback) {
      throw new GameError('NO_LEGAL_CARDS', 'AI не смог найти ни одной легальной карты.', {
        cause: error,
      });
    }

    return fallback;
  }
}

/**
 * Creates a bound AI player. Each opponent gets its own deterministic RNG when
 * tests inject one, while the game engine remains the source of all card data.
 *
 * @param {object} options
 * @param {string} options.playerId Stable player id.
 * @param {string | object} [options.personality] Personality preset or overrides.
 * @param {() => number} [options.rng] Random source; defaults to Math.random.
 * @returns {{
 *   playerId: string,
 *   personality: string,
 *   chooseBid: (view: object, currentBid?: number) => number | null,
 *   chooseContractRaise: (view: object) => number | null,
 *   chooseCardsToGive: (view: object) => { toPlayerId: string, cardId: string }[],
 *   chooseMarriage: (view: object) => string | null,
 *   chooseCard: (view: object, legalCards?: ReadonlyArray<Card | string> | null) => Card,
 * }}
 */
export function createAI({ playerId, personality, rng = Math.random } = {}) {
  if (typeof playerId !== 'string' || playerId.length === 0) {
    throw new GameError('INVALID_ARGUMENT', 'AI нужен идентификатор игрока.');
  }

  if (typeof rng !== 'function') {
    throw new GameError('INVALID_ARGUMENT', 'Генератор случайных чисел AI должен быть функцией.');
  }

  const settings = resolvePersonality(personality, playerId);
  const options = Object.freeze({
    playerId,
    personality: settings,
    rng,
  });

  return Object.freeze({
    playerId,
    personality: settings.name,
    chooseBid(view, currentBid = view?.currentBid) {
      return chooseBid(view, currentBid, options);
    },
    chooseContractRaise(view) {
      return chooseContractRaise(view, options);
    },
    chooseCardsToGive(view) {
      return chooseCardsToGive(view, options);
    },
    chooseMarriage(view) {
      return chooseMarriage(view, options);
    },
    chooseCard(view, legalCards = null) {
      return chooseCard(view, legalCards, options);
    },
  });
}
