import {
  BIDDING,
  DEAL,
  GAME_EVENTS,
  PHASES,
  SUITS,
  TARGET_SCORE,
} from './constants.js';
import { createDeck, deal, getCardById, shuffle } from './deck.js';
import { EventEmitter } from './events.js';
import { GameError } from './errors.js';
import { deepFreeze, normalizeDeck, normalizePlayers } from './game-setup.js';
import {
  getAvailableMarriages,
  getLegalCards,
  getTrickPoints,
  getTrickWinner,
} from './rules.js';
import { checkGameOver, scoreDeal } from './scoring.js';

const PLAYER_COUNT = DEAL.PLAYER_COUNT;
const SUIT_SET = new Set(SUITS);

/**
 * @typedef {import('./deck.js').Card} Card
 */

/**
 * The complete three-player game state machine.
 *
 * The engine owns the only source of truth, validates every action against the
 * current phase, and emits semantic events. It never touches the DOM, timers or
 * external storage. UI code should render from `getPlayerView`/`getState` and
 * mutate state only through the public methods below.
 */
export class Game {
  #players;
  #rng;
  #targetScore;
  #fixedDeck;
  #emitter = new EventEmitter();

  #phase = PHASES.IDLE;
  #dealNumber = 0;
  #dealerIndex = null;
  #firstBidderId = null;
  #prikup = /** @type {Card[]} */ ([]);
  #prikupTaken = false;
  #contract = null;
  #declarerId = null;
  #currentBid = 0;
  #activeBidderIds = /** @type {string[]} */ ([]);
  #currentBidderId = null;
  #givenCards = /** @type {{ fromId: string, toId: string, card: Card }[]} */ ([]);
  #trumpSuit = null;
  #trumpDeclaredBy = null;
  #currentTrick = /** @type {{ playerId: string, card: Card }[]} */ ([]);
  #trickLeaderId = null;
  #completedTricks = /** @type {{ winnerId: string, cards: { playerId: string, card: Card }[], points: number }[]} */ ([]);
  #marriagesThisTurn = 0;
  #lastDealResult = null;
  #winnerId = null;
  #log = /** @type {object[]} */ ([]);

  /**
   * @param {object} options
   * @param {ReadonlyArray<{ id: string, name: string, isHuman?: boolean }>} options.players
   *   Players in clockwise seating order.
   * @param {() => number} [options.rng] Random source returning values in [0, 1).
   * @param {number} [options.targetScore] Score required for an outright win.
   * @param {ReadonlyArray<Card | string> | null} [options.deck]
   *   Optional fixed deck. When supplied it is used in the given order without
   *   shuffling, which makes scenario tests fully deterministic.
   */
  constructor({ players, rng = Math.random, targetScore = TARGET_SCORE, deck = null } = {}) {
    this.#players = normalizePlayers(players);

    if (typeof rng !== 'function') {
      throw new GameError('INVALID_ARGUMENT', 'Генератор случайных чисел должен быть функцией.');
    }

    if (typeof targetScore !== 'number' || !Number.isFinite(targetScore) || targetScore <= 0) {
      throw new GameError('INVALID_ARGUMENT', 'Целевой счёт должен быть положительным числом.');
    }

    this.#rng = rng;
    this.#targetScore = targetScore;
    this.#fixedDeck = deck === null || deck === undefined ? null : normalizeDeck(deck);
  }

  /**
   * Starts a new game: chooses the first dealer, deals the cards and opens
   * bidding. May be called only while the game is in the IDLE phase.
   *
   * @returns {object} A frozen state snapshot.
   */
  start() {
    this.#assertPhase(PHASES.IDLE, 'start');

    const randomValue = this.#rng();
    const normalized = typeof randomValue === 'number' && Number.isFinite(randomValue)
      ? Math.min(1 - Number.EPSILON, Math.max(0, randomValue))
      : 0;

    this.#dealerIndex = Math.min(PLAYER_COUNT - 1, Math.floor(normalized * PLAYER_COUNT));
    this.#beginDeal();

    return this.getState();
  }

  /**
   * Places a bid or passes during the BIDDING phase.
   *
   * The opening bidder must bid exactly 100 and may not pass. Every following
   * bid must be a multiple of five, greater than the current bid by at least
   * five and no higher than 120. A bid of 120 ends bidding immediately.
   *
   * @param {string} playerId
   * @param {number | string | null} amountOrPass Bid amount, `null` or the
   *   string "pass"/"пас" to pass.
   * @returns {object} A frozen state snapshot.
   * @throws {GameError} When the action is not allowed.
   */
  bid(playerId, amountOrPass) {
    this.#assertPhase(PHASES.BIDDING, 'bid');

    const player = this.#getPlayer(playerId);

    if (player.passed) {
      this.#fail('PLAYER_PASSED', `Игрок ${player.name} уже спасовал в этой раздаче.`);
    }

    if (this.#currentBidderId !== player.id) {
      this.#fail('NOT_YOUR_TURN', `Сейчас очередь не игрока ${player.name}.`);
    }

    const passValue = typeof amountOrPass === 'string'
      ? amountOrPass.trim().toLowerCase()
      : null;
    const isPass = amountOrPass === null || passValue === 'pass' || passValue === 'пас';

    if (isPass) {
      if (this.#currentBid === 0) {
        this.#fail('CANNOT_PASS', 'Открывающий торги обязан сказать 100 и не может пасовать.');
      }

      this.#handlePass(player);
      return this.#emitStateChange();
    }

    if (typeof amountOrPass !== 'number' || !Number.isInteger(amountOrPass)) {
      this.#fail('INVALID_BID', 'Ставка должна быть целым числом или пасом.');
    }

    const amount = amountOrPass;

    if (
      amount < BIDDING.MIN
      || amount > BIDDING.MAX
      || amount % BIDDING.STEP !== 0
    ) {
      this.#fail(
        'INVALID_BID',
        `Ставка должна быть кратна ${BIDDING.STEP} и находиться в диапазоне ${BIDDING.MIN}–${BIDDING.MAX}.`,
        { amount },
      );
    }

    if (this.#currentBid === 0) {
      if (amount !== BIDDING.MIN) {
        this.#fail('INVALID_BID', 'Открывающая ставка должна быть ровно 100.', { amount });
      }
    } else if (amount < this.#currentBid + BIDDING.STEP) {
      this.#fail(
        'INVALID_BID',
        `Новая ставка должна быть выше текущей минимум на ${BIDDING.STEP}.`,
        { amount, currentBid: this.#currentBid },
      );
    }

    this.#handleBid(player, amount);

    return this.#emitStateChange();
  }

  /**
   * Gives one card from the declarer to an opponent during the GIVING phase.
   * Exactly one card must be given to each opponent.
   *
   * @param {string} toPlayerId Opponent who receives the card.
   * @param {Card | string} cardId Card from the declarer's hand.
   * @returns {object} A frozen state snapshot.
   * @throws {GameError} When the gift is not allowed.
   */
  giveCard(toPlayerId, cardId) {
    this.#assertPhase(PHASES.GIVING, 'giveCard');

    const declarer = this.#getPlayer(this.#declarerId);
    const target = this.#getPlayer(toPlayerId);

    if (target.id === declarer.id) {
      this.#fail('INVALID_TARGET', 'Играющий должен отдать карту сопернику, а не себе.');
    }

    if (this.#givenCards.some((gift) => gift.toId === target.id)) {
      this.#fail(
        'TARGET_ALREADY_RECEIVED',
        `Игрок ${target.name} уже получил карту от играющего.`,
      );
    }

    const card = this.#resolveCard(cardId);
    const cardIndex = declarer.hand.findIndex((entry) => entry.id === card.id);

    if (cardIndex === -1) {
      this.#fail('CARD_NOT_IN_HAND', `Карты ${card.id} нет в руке играющего.`, {
        cardId: card.id,
      });
    }

    declarer.hand.splice(cardIndex, 1);
    target.hand.push(card);
    this.#givenCards.push({ fromId: declarer.id, toId: target.id, card });

    const payload = deepFreeze({
      fromId: declarer.id,
      toId: target.id,
      cardId: card.id,
    });

    this.#addLog('gift', payload);
    this.#emitter.emit(GAME_EVENTS.GIFT, payload);

    if (this.#givenCards.length === PLAYER_COUNT - 1) {
      this.#phase = PHASES.PLAYING;
      this.#trickLeaderId = declarer.id;
      this.#currentTrick = [];
      this.#marriagesThisTurn = 0;
    }

    return this.#emitStateChange();
  }

  /**
   * Declares a marriage before leading a trick. The suit immediately becomes
   * trump and its bonus is added to the player's deal total.
   *
   * @param {string} playerId
   * @param {string} suit Marriage suit id: S, C, D or H.
   * @returns {object} A frozen state snapshot.
   * @throws {GameError} When the marriage cannot be declared.
   */
  declareMarriage(playerId, suit) {
    this.#assertPhase(PHASES.PLAYING, 'declareMarriage');

    const player = this.#getPlayer(playerId);

    if (this.#getActingPlayerId() !== player.id) {
      this.#fail('NOT_YOUR_TURN', `Сейчас очередь не игрока ${player.name}.`);
    }

    if (this.#currentTrick.length > 0) {
      this.#fail('MARRIAGE_NOT_ALLOWED', 'Марьяж объявляется только перед первым ходом взятки.');
    }

    if (this.#completedTricks.length < 1) {
      this.#fail('MARRIAGE_NOT_ALLOWED', 'Марьяж нельзя объявлять до завершения первой взятки.');
    }

    if (this.#marriagesThisTurn > 0) {
      this.#fail('MARRIAGE_LIMIT', 'За один ход можно объявить только один марьяж.');
    }

    if (typeof suit !== 'string' || !SUIT_SET.has(suit)) {
      this.#fail('INVALID_SUIT', `Неизвестная масть марьяжа: ${String(suit)}.`, { suit });
    }

    if (player.declaredMarriages.includes(suit)) {
      this.#fail('MARRIAGE_ALREADY_DECLARED', 'Этот марьяж уже объявлен в текущей раздаче.');
    }

    const marriage = getAvailableMarriages(player.hand, player.declaredMarriages)
      .find((entry) => entry.suit === suit);

    if (!marriage) {
      this.#fail('MARRIAGE_UNAVAILABLE', 'Для этого марьяжа нужны король и дама на руке.');
    }

    player.marriagePoints += marriage.value;
    player.declaredMarriages.push(suit);
    this.#trumpSuit = suit;
    this.#trumpDeclaredBy = player.id;
    this.#marriagesThisTurn += 1;

    const payload = deepFreeze({
      playerId: player.id,
      suit,
      value: marriage.value,
      trumpSuit: suit,
      marriagePoints: player.marriagePoints,
    });

    this.#addLog('marriage', payload);
    this.#emitter.emit(GAME_EVENTS.MARRIAGE, payload);

    return this.#emitStateChange();
  }

  /**
   * Plays one legal card during the PLAYING phase. When the third card of a
   * trick is played, the engine determines the winner, awards its points and
   * either starts the next trick or scores the deal.
   *
   * @param {string} playerId
   * @param {Card | string} cardId
   * @returns {object} A frozen state snapshot.
   * @throws {GameError} When the card or turn is not allowed.
   */
  playCard(playerId, cardId) {
    this.#assertPhase(PHASES.PLAYING, 'playCard');

    const player = this.#getPlayer(playerId);

    if (this.#getActingPlayerId() !== player.id) {
      this.#fail('NOT_YOUR_TURN', `Сейчас очередь не игрока ${player.name}.`);
    }

    const card = this.#resolveCard(cardId);
    const cardIndex = player.hand.findIndex((entry) => entry.id === card.id);

    if (cardIndex === -1) {
      this.#fail('CARD_NOT_IN_HAND', `Карты ${card.id} нет в руке игрока ${player.name}.`, {
        cardId: card.id,
      });
    }

    const leadSuit = this.#currentTrick.length === 0
      ? null
      : this.#currentTrick[0].card.suit;

    const legalCards = getLegalCards(player.hand, leadSuit, this.#trumpSuit);

    if (!legalCards.some((legalCard) => legalCard.id === card.id)) {
      this.#fail(
        'ILLEGAL_CARD',
        `Карта ${card.id} не является легальной в текущей взятке.`,
        { cardId: card.id, leadSuit, trumpSuit: this.#trumpSuit },
      );
    }

    player.hand.splice(cardIndex, 1);
    this.#currentTrick.push({ playerId: player.id, card });

    const playedPayload = deepFreeze({
      playerId: player.id,
      cardId: card.id,
      trickSize: this.#currentTrick.length,
    });

    this.#addLog('cardplayed', playedPayload);
    this.#emitter.emit(GAME_EVENTS.CARD_PLAYED, playedPayload);

    if (this.#currentTrick.length === PLAYER_COUNT) {
      this.#completeTrick();
    }

    return this.#emitStateChange();
  }

  /**
   * Starts the next deal after the results of the previous one have been shown.
   * The dealer moves clockwise and scores/bolts are preserved.
   *
   * @returns {object} A frozen state snapshot.
   * @throws {GameError} When the previous deal is not finished or the game is over.
   */
  nextDeal() {
    this.#assertPhase(PHASES.DEAL_END, 'nextDeal');

    this.#dealerIndex = (this.#dealerIndex + 1) % PLAYER_COUNT;
    this.#beginDeal();

    return this.getState();
  }

  /**
   * Subscribes to state changes. Two forms are supported:
   * `subscribe(listener)` and `subscribe(eventName, listener)`.
   *
   * @param {string | ((state: object) => void)} listenerOrEvent
   * @param {((payload: unknown) => void)} [maybeListener]
   * @returns {() => void} Unsubscribe function.
   */
  subscribe(listenerOrEvent, maybeListener) {
    if (typeof listenerOrEvent === 'string') {
      if (typeof maybeListener !== 'function') {
        throw new TypeError('Event listener must be a function.');
      }

      return this.#emitter.on(listenerOrEvent, maybeListener);
    }

    if (typeof listenerOrEvent === 'function') {
      return this.#emitter.on(GAME_EVENTS.STATE_CHANGE, listenerOrEvent);
    }

    throw new TypeError('Subscribe requires an event name or a listener function.');
  }

  /**
   * Subscribes to a specific semantic event.
   *
   * @param {string} eventName
   * @param {(payload: unknown) => void} listener
   * @returns {() => void} Unsubscribe function.
   */
  on(eventName, listener) {
    return this.#emitter.on(eventName, listener);
  }

  /**
   * Removes a previously registered listener.
   *
   * @param {string} eventName
   * @param {(payload: unknown) => void} listener
   * @returns {boolean}
   */
  off(eventName, listener) {
    return this.#emitter.off(eventName, listener);
  }

  /**
   * Returns a full, deeply frozen snapshot of the game state. This snapshot
   * contains every hand and is intended for tests, debug tools and trusted UI
   * code. Untrusted consumers (AI) must use {@link Game#getPlayerView}.
   *
   * @returns {object}
   */
  getState() {
    return this.#buildSnapshot(null);
  }

  /**
   * Returns a frozen snapshot that hides every other player's hand, the hidden
   * prikup and the deck order. This is the only state AI code may receive.
   *
   * @param {string} playerId
   * @returns {object}
   * @throws {GameError} When the player id is unknown.
   */
  getPlayerView(playerId) {
    this.#getPlayer(playerId);
    return this.#buildSnapshot(playerId);
  }

  /**
   * Deals a new hand and opens bidding. The first card goes to the player to
   * the left of the dealer, who also opens the bidding.
   */
  #beginDeal() {
    this.#phase = PHASES.DEALING;
    this.#dealNumber += 1;
    this.#resetDealState();

    const deck = this.#fixedDeck ?? shuffle(createDeck(), this.#rng);
    const { hands, prikup } = deal(deck);
    const openerIndex = (this.#dealerIndex + 1) % PLAYER_COUNT;

    for (let offset = 0; offset < PLAYER_COUNT; offset += 1) {
      this.#players[(openerIndex + offset) % PLAYER_COUNT].hand = hands[offset];
    }

    this.#prikup = prikup;
    this.#firstBidderId = this.#players[openerIndex].id;
    this.#activeBidderIds = Array.from(
      { length: PLAYER_COUNT },
      (_, offset) => this.#players[(openerIndex + offset) % PLAYER_COUNT].id,
    );
    this.#currentBidderId = this.#firstBidderId;
    this.#phase = PHASES.BIDDING;

    const payload = deepFreeze({
      dealNumber: this.#dealNumber,
      dealerId: this.#players[this.#dealerIndex].id,
      firstBidderId: this.#firstBidderId,
    });

    this.#addLog('dealstarted', payload);
    this.#emitter.emit(GAME_EVENTS.DEAL_STARTED, payload);
    this.#emitStateChange();
  }

  /**
   * Clears all per-deal data while preserving scores, bolts and the log.
   */
  #resetDealState() {
    for (const player of this.#players) {
      player.hand = [];
      player.bid = null;
      player.passed = false;
      player.tricksWon = 0;
      player.trickPoints = 0;
      player.marriagePoints = 0;
      player.declaredMarriages = [];
      player.isDeclarer = false;
    }

    this.#prikup = [];
    this.#prikupTaken = false;
    this.#contract = null;
    this.#declarerId = null;
    this.#currentBid = 0;
    this.#activeBidderIds = [];
    this.#currentBidderId = null;
    this.#givenCards = [];
    this.#trumpSuit = null;
    this.#trumpDeclaredBy = null;
    this.#currentTrick = [];
    this.#trickLeaderId = null;
    this.#completedTricks = [];
    this.#marriagesThisTurn = 0;
    this.#lastDealResult = null;
  }

  /**
   * Applies a bid and advances bidding or finishes it.
   *
   * @param {object} player
   * @param {number} amount
   */
  #handleBid(player, amount) {
    player.bid = amount;
    this.#currentBid = amount;

    const payload = deepFreeze({
      playerId: player.id,
      amount,
      currentBid: amount,
    });

    this.#addLog('bid', payload);
    this.#emitter.emit(GAME_EVENTS.BID, payload);

    if (amount === BIDDING.MAX) {
      this.#finishBidding(player.id);
      return;
    }

    const nextBidderId = this.#findNextActiveBidder(player.id);

    if (nextBidderId === null) {
      this.#finishBidding(player.id);
      return;
    }

    this.#currentBidderId = nextBidderId;
  }

  /**
   * Applies a pass and advances bidding or finishes it.
   *
   * @param {object} player
   */
  #handlePass(player) {
    player.passed = true;
    this.#activeBidderIds = this.#activeBidderIds.filter((id) => id !== player.id);

    const payload = deepFreeze({ playerId: player.id });

    this.#addLog('pass', payload);
    this.#emitter.emit(GAME_EVENTS.PASS, payload);

    if (this.#activeBidderIds.length === 1) {
      this.#finishBidding(this.#activeBidderIds[0]);
      return;
    }

    const nextBidderId = this.#findNextActiveBidder(player.id);

    if (nextBidderId === null) {
      this.#finishBidding(this.#activeBidderIds[0]);
      return;
    }

    this.#currentBidderId = nextBidderId;
  }

  /**
   * Finishes bidding, assigns the contract and moves the prikup to the
   * declarer. The PRIKUP event is emitted while the phase is PRIKUP; immediately
   * afterwards the phase becomes GIVING.
   *
   * @param {string} winnerId
   */
  #finishBidding(winnerId) {
    const winner = this.#getPlayer(winnerId);

    this.#phase = PHASES.PRIKUP;
    this.#declarerId = winnerId;
    this.#contract = this.#currentBid;
    this.#activeBidderIds = [winnerId];
    this.#currentBidderId = null;

    for (const player of this.#players) {
      player.isDeclarer = player.id === winnerId;
    }

    const prikupCards = this.#prikup.map((card) => card.id);
    winner.hand.push(...this.#prikup);
    this.#prikupTaken = true;

    const payload = deepFreeze({
      declarerId: winnerId,
      cards: prikupCards,
      handSize: winner.hand.length,
    });

    this.#addLog('prikup', { playerId: winnerId, count: prikupCards.length });
    this.#emitter.emit(GAME_EVENTS.PRIKUP, payload);
    this.#phase = PHASES.GIVING;
  }

  /**
   * Completes the current trick and either continues play or scores the deal.
   */
  #completeTrick() {
    const winnerId = getTrickWinner(this.#currentTrick, this.#trumpSuit);
    const points = getTrickPoints(this.#currentTrick);
    const cards = this.#currentTrick.map((entry) => ({
      playerId: entry.playerId,
      card: entry.card,
    }));
    const winner = this.#getPlayer(winnerId);

    winner.tricksWon += 1;
    winner.trickPoints += points;
    this.#completedTricks.push({ winnerId, cards, points });

    const payload = deepFreeze({
      winnerId,
      points,
      tricksWon: winner.tricksWon,
      cards: cards.map((entry) => ({
        playerId: entry.playerId,
        cardId: entry.card.id,
      })),
    });

    this.#addLog('trickwon', payload);
    this.#emitter.emit(GAME_EVENTS.TRICK_WON, payload);

    this.#currentTrick = [];
    this.#trickLeaderId = winnerId;
    this.#marriagesThisTurn = 0;

    if (this.#completedTricks.length === DEAL.TRICKS) {
      this.#scoreDeal();
    }
  }

  /**
   * Scores the finished deal, applies bolts and checks the end of the game.
   */
  #scoreDeal() {
    this.#phase = PHASES.SCORING;

    const result = scoreDeal({
      players: this.#players.map((player) => ({
        id: player.id,
        score: player.score,
        bolts: player.bolts,
        tricksWon: player.tricksWon,
        trickPoints: player.trickPoints,
        marriagePoints: player.marriagePoints,
      })),
      declarerId: this.#declarerId,
      contract: this.#contract,
    });

    for (const playerResult of result.players) {
      const player = this.#getPlayer(playerResult.id);
      player.score = playerResult.scoreAfter;
      player.bolts = playerResult.boltsAfter;
    }

    const gameResult = checkGameOver(
      this.#players.map((player) => ({ id: player.id, score: player.score })),
      this.#targetScore,
    );

    const fullResult = deepFreeze({
      ...result,
      dealNumber: this.#dealNumber,
      gameResult,
    });

    this.#lastDealResult = fullResult;

    this.#addLog('scored', {
      declarerId: this.#declarerId,
      contract: this.#contract,
      contractMet: result.contractMet,
      boltsAwarded: [...result.boltsAwarded],
      boltsReset: [...result.boltsReset],
    });

    this.#emitter.emit(GAME_EVENTS.SCORED, fullResult);

    if (gameResult.isOver) {
      this.#phase = PHASES.GAME_OVER;
      this.#winnerId = gameResult.winnerId;

      const payload = deepFreeze({
        winnerId: gameResult.winnerId,
        dealNumber: this.#dealNumber,
        targetScore: this.#targetScore,
        scores: this.#players.map((player) => ({
          id: player.id,
          name: player.name,
          score: player.score,
        })),
      });

      this.#addLog('gameover', {
        winnerId: gameResult.winnerId,
        topScore: gameResult.topScore,
      });

      this.#emitter.emit(GAME_EVENTS.GAME_OVER, payload);
    } else {
      this.#phase = PHASES.DEAL_END;
    }
  }

  /**
   * Builds a fresh snapshot. With a viewer id, every hidden piece of
   * information is removed.
   *
   * @param {string | null} viewerId
   * @returns {object}
   */
  #buildSnapshot(viewerId) {
    const currentPlayerId = this.#getActingPlayerId();
    const marriageOwnerId = viewerId ?? currentPlayerId;
    const marriageOwner = marriageOwnerId === null
      ? null
      : this.#players.find((player) => player.id === marriageOwnerId);
    const dealer = this.#dealerIndex === null
      ? null
      : this.#players[this.#dealerIndex];
    const prikupVisible = viewerId === null
      || (this.#prikupTaken && viewerId === this.#declarerId);

    const players = this.#players.map((player) => {
      const handVisible = viewerId === null || viewerId === player.id;

      return {
        id: player.id,
        name: player.name,
        isHuman: player.isHuman,
        hand: handVisible ? player.hand.map((card) => card.id) : [],
        cardCount: player.hand.length,
        score: player.score,
        bolts: player.bolts,
        bid: player.bid,
        passed: player.passed,
        tricksWon: player.tricksWon,
        trickPoints: player.trickPoints,
        marriagePoints: player.marriagePoints,
        declaredMarriages: [...player.declaredMarriages],
        isDeclarer: player.isDeclarer,
      };
    });

    return deepFreeze({
      phase: this.#phase,
      dealNumber: this.#dealNumber,
      targetScore: this.#targetScore,
      dealerIndex: this.#dealerIndex,
      dealerId: dealer ? dealer.id : null,
      firstBidderId: this.#firstBidderId,
      players,
      prikup: prikupVisible ? this.#prikup.map((card) => card.id) : [],
      prikupTaken: this.#prikupTaken,
      contract: this.#contract,
      declarerId: this.#declarerId,
      currentBid: this.#currentBid,
      activeBidderIds: [...this.#activeBidderIds],
      currentBidderId: this.#currentBidderId,
      currentPlayerId,
      givenCards: this.#givenCards.map((gift) => ({
        fromId: gift.fromId,
        toId: gift.toId,
        cardId: gift.card.id,
      })),
      trumpSuit: this.#trumpSuit,
      trumpDeclaredBy: this.#trumpDeclaredBy,
      currentTrick: this.#currentTrick.map((entry) => ({
        playerId: entry.playerId,
        cardId: entry.card.id,
      })),
      trickLeaderId: this.#trickLeaderId,
      completedTricks: this.#completedTricks.map((trick) => ({
        winnerId: trick.winnerId,
        points: trick.points,
        cards: trick.cards.map((entry) => ({
          playerId: entry.playerId,
          cardId: entry.card.id,
        })),
      })),
      availableMarriages: marriageOwner
        ? getAvailableMarriages(marriageOwner.hand, marriageOwner.declaredMarriages)
        : [],
      lastDealResult: this.#lastDealResult,
      winnerId: this.#winnerId,
      log: [...this.#log],
    });
  }

  /**
   * Returns the player whose action is expected now, if any.
   *
   * @returns {string | null}
   */
  #getActingPlayerId() {
    switch (this.#phase) {
      case PHASES.BIDDING:
        return this.#currentBidderId;
      case PHASES.PRIKUP:
      case PHASES.GIVING:
        return this.#declarerId;
      case PHASES.PLAYING: {
        if (this.#currentTrick.length === 0) {
          return this.#trickLeaderId;
        }

        const lastEntry = this.#currentTrick[this.#currentTrick.length - 1];
        const lastIndex = this.#indexOfPlayer(lastEntry.playerId);

        return this.#players[(lastIndex + 1) % PLAYER_COUNT].id;
      }
      default:
        return null;
    }
  }

  /**
   * Finds the next player clockwise who is still active in bidding.
   *
   * @param {string} fromPlayerId
   * @returns {string | null}
   */
  #findNextActiveBidder(fromPlayerId) {
    const fromIndex = this.#indexOfPlayer(fromPlayerId);

    for (let offset = 1; offset < PLAYER_COUNT; offset += 1) {
      const candidate = this.#players[(fromIndex + offset) % PLAYER_COUNT];

      if (this.#activeBidderIds.includes(candidate.id)) {
        return candidate.id;
      }
    }

    return null;
  }

  /**
   * @param {string} playerId
   * @returns {number}
   */
  #indexOfPlayer(playerId) {
    return this.#players.findIndex((player) => player.id === playerId);
  }

  /**
   * @param {string} playerId
   * @returns {object}
   */
  #getPlayer(playerId) {
    if (typeof playerId !== 'string' || playerId.length === 0) {
      this.#fail('UNKNOWN_PLAYER', 'Не указан идентификатор игрока.');
    }

    const player = this.#players.find((entry) => entry.id === playerId);

    if (!player) {
      this.#fail('UNKNOWN_PLAYER', `Неизвестный игрок: ${playerId}.`, { playerId });
    }

    return player;
  }

  /**
   * Resolves a card id or a card-like object to a canonical deck card.
   *
   * @param {Card | string} cardLike
   * @returns {Card}
   */
  #resolveCard(cardLike) {
    const cardId = typeof cardLike === 'string'
      ? cardLike
      : (cardLike && typeof cardLike === 'object' && typeof cardLike.id === 'string'
        ? cardLike.id
        : null);

    if (cardId === null) {
      this.#fail('INVALID_CARD', 'Карта должна быть объектом или стабильным идентификатором.');
    }

    try {
      return getCardById(cardId);
    } catch (error) {
      if (error instanceof GameError) {
        this.#fail(error.code, error.message, error.details);
      }

      throw error;
    }
  }

  /**
   * @param {string} expected
   * @param {string} action
   */
  #assertPhase(expected, action) {
    if (this.#phase !== expected) {
      this.#fail(
        'INVALID_PHASE',
        `Действие «${action}» недоступно в фазе ${this.#phase}.`,
        { expected, actual: this.#phase },
      );
    }
  }

  /**
   * Records a semantic log entry. Log entries never contain hidden information
   * such as the prikup cards or other players' hands.
   *
   * @param {string} type
   * @param {object} [data]
   * @returns {object}
   */
  #addLog(type, data = {}) {
    const entry = deepFreeze({
      ...data,
      type,
      dealNumber: this.#dealNumber,
    });

    this.#log.push(entry);
    return entry;
  }

  /**
   * Builds and emits the current state.
   *
   * @returns {object}
   */
  #emitStateChange() {
    const state = this.getState();
    this.#emitter.emit(GAME_EVENTS.STATE_CHANGE, state);
    return state;
  }

  /**
   * Emits the error event and throws a GameError.
   *
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   * @returns {never}
   */
  #fail(code, message, details) {
    const error = new GameError(code, message, details);
    this.#emitter.emit(GAME_EVENTS.ERROR, error);
    throw error;
  }
}
