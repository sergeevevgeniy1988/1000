import { GAME_EVENTS, PHASES, TARGET_SCORE } from '../core/constants.js';
import { getCardById } from '../core/deck.js';
import { Game } from '../core/game.js';
import { mulberry32 } from '../core/rng.js';
import { getLegalCards } from '../core/rules.js';
import { createAI } from '../ai/ai.js';
import { clearElement, createElement } from './dom.js';
import { formatCards, nameGenitive } from './format.js';
import { renderHand } from './hand.js';
import { renderLog, resetLog } from './log.js';
import { renderTable } from './table.js';
import { applySpeechBubbles, createBiddingControls } from './bidding.js';
import { createMarriageButton, createMarriageMenu } from './marriage.js';
import { openPrikupModal } from './prikup.js';
import {
  closeModal,
  getOpenModalKind,
  openConfirmNewGameModal,
  openDealResultsModal,
  openGameOverModal,
  resetToasts,
  showToast,
} from './modals.js';
import {
  animationsAllowed,
  cancelAnimations,
  playDealAnimation,
  playTrickCollect,
  TRICK_REVEAL_MS,
} from './animations.js';
import { playSound } from './sound.js';

const AI_MIN_DELAY = 500;
const AI_MAX_DELAY = 980;
const BUBBLE_PHASES = new Set([PHASES.BIDDING, PHASES.GIVING]);

/**
 * @typedef {import('../core/deck.js').Card} Card
 */

/**
 * Connects the pure game engine to the browser. The controller owns the only
 * AI timer, renders every state change and validates every human action through
 * the public `Game` API.
 */
export class Controller {
  #players;
  #humanId;
  #elements;
  #seed;
  #targetScore;
  #game = null;
  #gameIndex = 0;
  #started = false;
  #unsubscribers = [];
  #aiCache = new Map();
  #aiTimer = null;
  #aiBusy = false;
  #paused = false;
  #trickReveal = null;
  #trickRevealTimer = null;
  #lastPlayedCardId = null;
  #bubbles = new Map();
  #marriageMenuOpen = false;
  #newGameHandler = null;

  /**
   * @param {object} options
   * @param {ReadonlyArray<{ id: string, name: string, isHuman?: boolean }>} options.players
   *   Players in clockwise seating order.
   * @param {string} options.humanId
   * @param {number | null} [options.seed] Deterministic seed for tests and demos.
   * @param {number} [options.targetScore] Score required to win; 1000 by default.
   * @param {object} options.elements
   * @param {HTMLElement} options.elements.opponents
   * @param {HTMLElement} options.elements.humanPanel
   * @param {HTMLElement} options.elements.tableCenter
   * @param {HTMLElement} options.elements.hand
   * @param {HTMLElement} options.elements.gameLog
   * @param {HTMLElement} options.elements.actionBar
   * @param {HTMLElement} options.elements.board
   * @param {HTMLElement} options.elements.targetScore
   * @param {HTMLElement} options.elements.dealNumber
   * @param {HTMLButtonElement | null} [options.elements.newGameButton]
   */
  constructor({ players, humanId, seed = null, targetScore = TARGET_SCORE, elements }) {
    this.#players = players.map((player) => Object.freeze({ ...player }));
    this.#humanId = humanId;
    this.#seed = seed === null || !Number.isFinite(seed) ? null : seed >>> 0;
    this.#targetScore = targetScore;
    this.#elements = elements;

    this.#newGameHandler = () => this.requestNewGame();

    if (elements.newGameButton) {
      elements.newGameButton.addEventListener('click', this.#newGameHandler);
    }
  }

  /**
   * Creates the first game and starts the first deal.
   *
   * @returns {void}
   */
  start() {
    if (this.#started) {
      return;
    }

    this.#started = true;
    this.#game = this.#createGame();
    this.#bindGame(this.#game);
    this.#game.start();
  }

  /**
   * Starts a fresh game after the user confirms it. All timers, modals and
   * per-deal UI state are cleared before the new game starts.
   *
   * @returns {void}
   */
  newGame() {
    this.#clearTimers();
    this.#paused = false;
    this.#aiBusy = false;
    this.#trickReveal = null;
    this.#bubbles.clear();
    this.#marriageMenuOpen = false;
    this.#lastPlayedCardId = null;
    closeModal({ silent: true });
    cancelAnimations(this.#elements.board, this.#elements.tableCenter);
    resetLog(this.#elements.gameLog);
    resetToasts();

    this.#unsubscribeAll();
    this.#gameIndex += 1;
    this.#aiCache.clear();
    this.#game = this.#createGame();
    this.#bindGame(this.#game);
    this.#game.start();
  }

  /**
   * Asks for confirmation and starts a new game when appropriate.
   *
   * @returns {void}
   */
  requestNewGame() {
    if (!this.#game) {
      return;
    }

    const state = this.#game.getState();

    if (state.phase === PHASES.IDLE || state.dealNumber === 0) {
      this.newGame();
      return;
    }

    this.#paused = true;
    this.#clearAITimer();
    this.#clearTrickReveal();
    this.#render(this.#game.getState());

    openConfirmNewGameModal({
      onConfirm: () => this.newGame(),
      onCancel: () => {
        this.#paused = false;
        this.#syncModals(this.#game.getState());
        this.#scheduleAI();
      },
    });
  }

  /**
   * Pauses AI decisions while a dialog is open. Human actions are already
   * blocked by the modal overlay, but timers must not fire behind it.
   *
   * @returns {void}
   */
  pause() {
    if (!this.#game) {
      return;
    }

    this.#paused = true;
    this.#clearAITimer();
  }

  /**
   * Resumes AI decisions after a dialog closes and restores the correct modal
   * for the current phase, if one is required.
   *
   * @returns {void}
   */
  resume() {
    if (!this.#game) {
      return;
    }

    this.#paused = false;
    this.#syncModals(this.#game.getState());
    this.#scheduleAI();
  }

  /**
   * Detaches listeners and stops timers. Intended for tests and hot reloads.
   *
   * @returns {void}
   */
  dispose() {
    this.#clearTimers();
    this.#unsubscribeAll();
    closeModal({ silent: true });

    if (this.#elements.newGameButton && this.#newGameHandler) {
      this.#elements.newGameButton.removeEventListener('click', this.#newGameHandler);
    }
  }

  /**
   * @returns {Game}
   */
  #createGame() {
    const seed = this.#seed === null
      ? null
      : (this.#seed + this.#gameIndex * 104729) >>> 0;
    const rng = seed === null ? Math.random : mulberry32(seed);

    return new Game({
      players: this.#players,
      targetScore: this.#targetScore,
      rng,
    });
  }

  /**
   * Subscribes to every event needed by the interface.
   *
   * @param {Game} game
   * @returns {void}
   */
  #bindGame(game) {
    this.#unsubscribers = [
      game.subscribe((state) => this.#handleStateChange(state)),
      game.on(GAME_EVENTS.ERROR, (error) => this.#handleGameError(error)),
      game.on(GAME_EVENTS.BID, (payload) => {
        this.#setBubble(payload.playerId, String(payload.amount));
        playSound('bid');
      }),
      game.on(GAME_EVENTS.PASS, (payload) => {
        this.#setBubble(payload.playerId, 'Пас');
        playSound('pass');
      }),
      game.on(GAME_EVENTS.DEAL_STARTED, () => {
        this.#handleDealStarted();
        playSound('deal');
      }),
      game.on(GAME_EVENTS.PRIKUP, (payload) => {
        this.#handlePrikup(payload);
        playSound('prikup');
      }),
      game.on(GAME_EVENTS.GIFT, () => playSound('gift')),
      game.on(GAME_EVENTS.MARRIAGE, () => playSound('marriage')),
      game.on(GAME_EVENTS.CARD_PLAYED, (payload) => {
        this.#lastPlayedCardId = payload.cardId;
        playSound('card');
      }),
      game.on(GAME_EVENTS.TRICK_WON, (payload) => this.#handleTrickWon(payload)),
      game.on(GAME_EVENTS.SCORED, () => playSound('score')),
      game.on(GAME_EVENTS.GAME_OVER, () => playSound('win')),
    ];

    this.#aiCache.clear();
  }

  /**
   * @returns {void}
   */
  #unsubscribeAll() {
    for (const unsubscribe of this.#unsubscribers) {
      unsubscribe();
    }

    this.#unsubscribers = [];
  }

  /**
   * @param {Error & { message?: string }} error
   * @returns {void}
   */
  #handleGameError(error) {
    console.error('[1000]', error);
    playSound('error');
    showToast(error?.message ?? 'Игровая ошибка.');
  }

  /**
   * @param {string} playerId
   * @param {string} text
   * @returns {void}
   */
  #setBubble(playerId, text) {
    const player = this.#players.find((entry) => entry.id === playerId);

    if (player && !player.isHuman) {
      this.#bubbles.set(playerId, text);
    }
  }

  /**
   * @returns {void}
   */
  #handleDealStarted() {
    this.#bubbles.clear();
    this.#marriageMenuOpen = false;
    this.#lastPlayedCardId = null;
    this.#clearTrickReveal();
    playDealAnimation(this.#elements.board);
  }

  /**
   * Announces an AI prikup with a short visible notice. The prikup contents
   * themselves are never rendered.
   *
   * @param {{ declarerId: string, cards: string[], handSize: number }} payload
   * @returns {void}
   */
  #handlePrikup(payload) {
    const declarer = this.#players.find((player) => player.id === payload.declarerId);

    if (declarer && !declarer.isHuman) {
      showToast(`${declarer.name} берёт прикуп — ${formatCards(payload.cards.length)}.`, 'info');
    }
  }

  /**
   * Holds the third card of a completed trick on the table for a short pause,
   * then re-renders the next state.
   *
   * @param {{ winnerId: string, points: number, cards: { playerId: string, cardId: string }[] }} payload
   * @returns {void}
   */
  #handleTrickWon(payload) {
    this.#clearTrickReveal();
    playSound('trick');

    if (!animationsAllowed()) {
      return;
    }

    this.#trickReveal = {
      winnerId: payload.winnerId,
      points: payload.points,
      cards: payload.cards,
    };

    this.#trickRevealTimer = window.setTimeout(() => {
      this.#trickRevealTimer = null;
      this.#trickReveal = null;

      const state = this.#game.getState();
      this.#render(state);
      this.#syncModals(state);
      this.#scheduleAI();
    }, TRICK_REVEAL_MS);
  }

  /**
   * @param {object} state
   * @returns {void}
   */
  #handleStateChange(state) {
    this.#marriageMenuOpen = false;

    if (!BUBBLE_PHASES.has(state.phase)) {
      this.#bubbles.clear();
    }

    this.#render(state);
    this.#syncModals(state);
    this.#scheduleAI();
  }

  /**
   * @param {object} state
   * @returns {void}
   */
  #render(state) {
    const reveal = this.#trickReveal;
    const displayState = reveal
      ? { ...state, currentTrick: reveal.cards, currentPlayerId: null }
      : state;
    const animatedCardId = this.#lastPlayedCardId;
    this.#lastPlayedCardId = null;

    renderTable(displayState, this.#elements, {
      animatedCardId,
      winnerId: reveal ? reveal.winnerId : null,
    });

    if (reveal) {
      const winnerSlot = this.#elements.tableCenter.querySelector('.trick-slot--winner');
      const trick = this.#elements.tableCenter.querySelector('.trick');
      const position = ['left', 'right', 'bottom', 'center']
        .find((seat) => winnerSlot?.classList.contains(`trick-slot--${seat}`)) ?? 'center';

      playTrickCollect(trick, position);
    }

    if (BUBBLE_PHASES.has(state.phase)) {
      applySpeechBubbles(this.#elements.opponents, this.#bubbles);
    }

    const legalCardIds = this.#getHumanLegalCardIds(state, Boolean(reveal));

    renderHand(state, {
      handEl: this.#elements.hand,
      playerId: this.#humanId,
      legalCardIds,
      onCardSelect: legalCardIds ? (card) => this.#humanPlayCard(card) : null,
    });
    renderLog(state, this.#elements.gameLog);
    this.#renderHeader(state);
    this.#renderActionBar(state, reveal);

    document.body.dataset.phase = state.phase;
  }

  /**
   * @param {object} state
   * @returns {void}
   */
  #renderHeader(state) {
    this.#elements.targetScore.textContent = String(state.targetScore);
    this.#elements.dealNumber.textContent = state.dealNumber > 0
      ? String(state.dealNumber)
      : '—';
  }

  /**
   * @param {object} state
   * @param {boolean} revealActive
   * @returns {void}
   */
  #renderActionBar(state, revealActive) {
    const bar = this.#elements.actionBar;

    clearElement(bar);

    if (revealActive && this.#trickReveal) {
      const winner = state.players.find((player) => player.id === this.#trickReveal.winnerId);

      bar.append(createElement('div', { className: 'action-bar__group' }, ...[
        createElement('span', {
          className: 'action-bar__status action-bar__status--result',
          text: `Взятка ${this.#trickReveal.points}: ${winner?.name ?? '—'}`,
          attrs: { role: 'status' },
        }),
      ]));
      return;
    }

    switch (state.phase) {
      case PHASES.BIDDING: {
        bar.append(createBiddingControls({
          state,
          humanId: this.#humanId,
          onBid: (amount) => this.#humanBid(amount),
          onPass: () => this.#humanBid(null),
        }));
        break;
      }
      case PHASES.GIVING: {
        const declarer = state.players.find((player) => player.id === state.declarerId);

        bar.append(createElement('div', { className: 'action-bar__group' }, ...[
          createElement('span', {
            className: 'action-bar__status',
            text: declarer?.isHuman
              ? 'Выберите по одной карте для Алисы и Бориса в окне прикупа.'
              : `${declarer?.name ?? 'Играющий'} забирает прикуп и отдаёт карты…`,
            attrs: { role: 'status' },
          }),
        ]));
        break;
      }
      case PHASES.PLAYING: {
        const group = createElement('div', { className: 'action-bar__group' });
        const actor = state.players.find((player) => player.id === state.currentPlayerId);
        const statusText = actor?.isHuman
          ? 'Ваш ход — выберите карту.'
          : (actor ? `Ход ${nameGenitive(actor.name)}…` : 'Розыгрыш…');

        group.append(createElement('span', {
          className: 'action-bar__status',
          text: statusText,
          attrs: { role: 'status' },
        }));

        const marriages = this.#getHumanMarriages(state);

        if (marriages.length > 0) {
          if (this.#marriageMenuOpen) {
            group.append(createMarriageMenu({
              available: marriages,
              onDeclare: (suit) => this.#humanDeclareMarriage(suit),
            }));
          } else {
            group.append(createMarriageButton({
              available: marriages,
              onOpen: () => {
                this.#marriageMenuOpen = true;
                this.#render(this.#game.getState());
              },
            }));
          }
        }

        bar.append(group);
        break;
      }
      case PHASES.DEAL_END:
        bar.append(createElement('span', {
          className: 'action-bar__status',
          text: 'Раздача завершена — итоги в окне результатов.',
          attrs: { role: 'status' },
        }));
        break;
      case PHASES.GAME_OVER:
        bar.append(createElement('span', {
          className: 'action-bar__status action-bar__status--result',
          text: 'Игра окончена. Итоговая таблица открыта.',
          attrs: { role: 'status' },
        }));
        break;
      default:
        break;
    }
  }

  /**
   * @param {object} state
   * @param {boolean} revealActive
   * @returns {string[] | null}
   */
  #getHumanLegalCardIds(state, revealActive) {
    if (revealActive) {
      return null;
    }

    if (state.phase !== PHASES.PLAYING || state.currentPlayerId !== this.#humanId) {
      return null;
    }

    const human = state.players.find((player) => player.id === this.#humanId);

    if (!human || human.hand.length === 0) {
      return null;
    }

    let leadSuit = null;

    if (state.currentTrick.length > 0) {
      leadSuit = getCardById(state.currentTrick[0].cardId).suit;
    }

    return getLegalCards(human.hand, leadSuit, state.trumpSuit)
      .map((card) => card.id);
  }

  /**
   * @param {object} state
   * @returns {{ suit: string, value: number }[]}
   */
  #getHumanMarriages(state) {
    if (state.phase !== PHASES.PLAYING) {
      return [];
    }

    if (state.currentPlayerId !== this.#humanId) {
      return [];
    }

    if (state.currentTrick.length > 0 || state.completedTricks.length < 1) {
      return [];
    }

    if (this.#hasDeclaredMarriageThisTrick(state)) {
      return [];
    }

    return state.availableMarriages;
  }

  /**
   * Checks the public log instead of relying on private engine state.
   *
   * @param {object} state
   * @returns {boolean}
   */
  #hasDeclaredMarriageThisTrick(state) {
    const log = Array.isArray(state.log) ? state.log : [];

    for (let index = log.length - 1; index >= 0; index -= 1) {
      const entry = log[index];

      if (entry.type === 'trickwon') {
        return false;
      }

      if (entry.type === 'marriage' && entry.playerId === this.#humanId) {
        return true;
      }
    }

    return false;
  }

  /**
   * @param {number | null} amount `null` means pass.
   * @returns {void}
   */
  #humanBid(amount) {
    if (this.#paused) {
      return;
    }

    try {
      this.#game.bid(this.#humanId, amount);
    } catch (error) {
      this.#reportUnexpected(error);
    }
  }

  /**
   * @param {Card} card
   * @returns {void}
   */
  #humanPlayCard(card) {
    if (this.#paused || this.#trickReveal) {
      return;
    }

    try {
      this.#game.playCard(this.#humanId, card.id);
    } catch (error) {
      this.#reportUnexpected(error);
    }
  }

  /**
   * @param {string} suit
   * @returns {void}
   */
  #humanDeclareMarriage(suit) {
    this.#marriageMenuOpen = false;

    try {
      this.#game.declareMarriage(this.#humanId, suit);
    } catch (error) {
      this.#reportUnexpected(error);
      this.#render(this.#game.getState());
    }
  }

  /**
   * Applies both human gifts. The engine reacts to each one, so the modal is
   * kept open until the second gift moves the game into PLAYING.
   *
   * @param {{ toPlayerId: string, cardId: string }[]} gifts
   * @returns {void}
   */
  #applyHumanGifts(gifts) {
    try {
      for (const gift of gifts) {
        this.#game.giveCard(gift.toPlayerId, gift.cardId);
      }
    } catch (error) {
      this.#reportUnexpected(error);
      this.#render(this.#game.getState());
    }
  }

  /**
   * GameErrors are already reported through the engine's `error` event.
   *
   * @param {unknown} error
   * @returns {void}
   */
  #reportUnexpected(error) {
    if (error && typeof error === 'object' && error.name === 'GameError') {
      return;
    }

    console.error('[1000]', error);
    showToast('Неожиданная ошибка интерфейса. Попробуйте начать новую игру.');
  }

  /**
   * @param {object} state
   * @returns {void}
   */
  #syncModals(state) {
    if (this.#trickReveal) {
      return;
    }

    const kind = getOpenModalKind();

    if (state.phase === PHASES.GIVING && state.declarerId === this.#humanId) {
      if (kind !== 'prikup') {
        closeModal({ silent: true });
        openPrikupModal({
          state,
          humanId: this.#humanId,
          onConfirm: (gifts) => this.#applyHumanGifts(gifts),
        });
      }

      return;
    }

    if (state.phase === PHASES.DEAL_END) {
      if (kind !== 'results') {
        closeModal({ silent: true });
        openDealResultsModal(state, {
          onNextDeal: () => {
            closeModal();
            this.#game.nextDeal();
          },
        });
      }

      return;
    }

    if (state.phase === PHASES.GAME_OVER) {
      if (kind !== 'gameover') {
        closeModal({ silent: true });
        openGameOverModal(state, {
          onNewGame: () => this.newGame(),
        });
      }

      return;
    }

    if (kind === 'prikup' || kind === 'results' || kind === 'gameover') {
      closeModal({ silent: true });
    }
  }

  /**
   * Schedules exactly one AI action. The timer is never stacked: if a timer is
   * already pending or a trick animation is running, the call is ignored.
   *
   * @returns {void}
   */
  #scheduleAI() {
    if (
      this.#paused
      || this.#aiBusy
      || this.#aiTimer !== null
      || this.#trickReveal
      || !this.#game
    ) {
      return;
    }

    const state = this.#game.getState();
    const actor = state.currentPlayerId
      ? state.players.find((player) => player.id === state.currentPlayerId)
      : null;
    const playablePhase = state.phase === PHASES.BIDDING
      || state.phase === PHASES.GIVING
      || state.phase === PHASES.PLAYING;

    if (!actor || actor.isHuman || !playablePhase) {
      return;
    }

    const delay = AI_MIN_DELAY + Math.floor(Math.random() * (AI_MAX_DELAY - AI_MIN_DELAY));

    this.#aiTimer = window.setTimeout(() => {
      this.#aiTimer = null;
      this.#runAI();
    }, delay);
  }

  /**
   * Executes one AI decision through the public engine API.
   *
   * @returns {void}
   */
  #runAI() {
    if (this.#paused || this.#aiBusy || this.#trickReveal || !this.#game) {
      return;
    }

    this.#aiBusy = true;

    try {
      const state = this.#game.getState();
      const actor = state.currentPlayerId
        ? state.players.find((player) => player.id === state.currentPlayerId)
        : null;

      if (!actor || actor.isHuman) {
        return;
      }

      const ai = this.#getAI(actor.id);

      switch (state.phase) {
        case PHASES.BIDDING: {
          const view = this.#game.getPlayerView(actor.id);
          const amount = ai.chooseBid(view, state.currentBid);

          this.#game.bid(actor.id, amount);
          break;
        }
        case PHASES.GIVING: {
          const view = this.#game.getPlayerView(actor.id);
          const gifts = ai.chooseCardsToGive(view);

          if (gifts.length === 0) {
            throw new Error('AI не выбрал карты для отдара.');
          }

          this.#game.giveCard(gifts[0].toPlayerId, gifts[0].cardId);
          break;
        }
        case PHASES.PLAYING: {
          const view = this.#game.getPlayerView(actor.id);

          if (state.currentTrick.length === 0 && state.completedTricks.length >= 1) {
            const suit = ai.chooseMarriage(view);

            if (suit) {
              this.#game.declareMarriage(actor.id, suit);
              break;
            }
          }

          const card = ai.chooseCard(view, null);

          this.#game.playCard(actor.id, card.id);
          break;
        }
        default:
          break;
      }
    } catch (error) {
      this.#reportUnexpected(error);
    } finally {
      this.#aiBusy = false;
      this.#scheduleAI();
    }
  }

  /**
   * Creates and caches a bound AI player for one game.
   *
   * @param {string} playerId
   * @returns {ReturnType<typeof createAI>}
   */
  #getAI(playerId) {
    const cached = this.#aiCache.get(playerId);

    if (cached) {
      return cached;
    }

    const rng = this.#seed === null
      ? Math.random
      : mulberry32((this.#seed + this.#gameIndex * 104729 + hashString(playerId)) >>> 0);
    const ai = createAI({ playerId, rng });

    this.#aiCache.set(playerId, ai);
    return ai;
  }

  /**
   * @returns {void}
   */
  #clearAITimer() {
    if (this.#aiTimer !== null) {
      window.clearTimeout(this.#aiTimer);
      this.#aiTimer = null;
    }
  }

  /**
   * @returns {void}
   */
  #clearTrickReveal() {
    if (this.#trickRevealTimer !== null) {
      window.clearTimeout(this.#trickRevealTimer);
      this.#trickRevealTimer = null;
    }

    this.#trickReveal = null;
  }

  /**
   * @returns {void}
   */
  #clearTimers() {
    this.#clearAITimer();
    this.#clearTrickReveal();
  }
}

/**
 * @param {string} value
 * @returns {number}
 */
function hashString(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}
