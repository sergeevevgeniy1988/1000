import { BIDDING, GAME_EVENTS, PHASES } from '../core/constants.js';
import { getCardById } from '../core/deck.js';
import { getLegalCards, getMarriageConfirmationCards, getMaxContract } from '../core/rules.js';
import { createAI } from '../ai/ai.js';
import { getConnectionBanner } from '../net/lobby.js';
import { clearElement, createElement } from './dom.js';
import {
  formatGenitiveNames,
  getPhaseName,
  nameGenitive,
  resolveViewerId,
} from './format.js';
import { createAnnouncer, getPhaseAnnouncement } from './announcements.js';
import { getActionErrorMessage } from './errors.js';
import { captureFocus, focusFirstLegalCard, restoreFocus } from './focus.js';
import { renderHand } from './hand.js';
import { renderLog, resetLog } from './log.js';
import { renderTable } from './table.js';
import { applySpeechBubbles, createBiddingControls } from './bidding.js';
import {
  createMarriageButton,
  createMarriageMenu,
  createPendingMarriageStatus,
} from './marriage.js';
import { openGiftModal, openPrikupRevealModal } from './prikup.js';
import { createRaiseControls } from './raise-panel.js';
import { isLegalRaiseAmount } from './raise.js';
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
 * Connects a game session to the browser. The controller owns the only AI
 * timer, renders every state change and validates every viewer action through
 * the session API. It never creates `Game` instances itself.
 */
export class Controller {
  #session = null;
  #elements;
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
  #announcer = null;
  #renderToken = 0;
  #sessionClosed = false;
  #onSessionClosed = null;
  #onExitNetwork = null;

  /**
   * @param {object} options
   * @param {object} options.session Session owning the game state.
   * @param {(payload?: object) => void} [options.onSessionClosed]
   * @param {() => void} [options.onExitNetwork]
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
   * @param {HTMLElement | null} [options.elements.announcer]
   * @param {{ close: (options?: { restoreFocus?: boolean }) => void } | null} [options.elements.logDrawer]
   */
  constructor({
    session,
    elements,
    onSessionClosed = null,
    onExitNetwork = null,
  }) {
    if (!session || typeof session.getState !== 'function') {
      throw new TypeError('Controller requires a game session.');
    }

    this.#session = session;
    this.#elements = elements;
    this.#announcer = createAnnouncer(elements.announcer ?? null);
    this.#onSessionClosed = typeof onSessionClosed === 'function' ? onSessionClosed : null;
    this.#onExitNetwork = typeof onExitNetwork === 'function' ? onExitNetwork : null;

    this.#newGameHandler = () => this.requestNewGame();

    if (elements.newGameButton) {
      elements.newGameButton.addEventListener('click', this.#newGameHandler);
    }
  }

  /**
   * Binds to the session and starts the first deal.
   *
   * @returns {void}
   */
  start() {
    if (this.#started || !this.#session) {
      return;
    }

    this.#started = true;
    this.#bindSession(this.#session);
    this.#session.start();
  }

  /**
   * Switches the controller to another session. All timers, modals and
   * per-deal UI state are cleared before the new session starts.
   *
   * @param {object} session
   * @returns {void}
   */
  replaceSession(session) {
    this.#resetUiState();
    this.#unsubscribeAll();
    this.#session = session ?? null;
    this.#sessionClosed = false;
    this.#aiCache.clear();

    if (this.#session && this.#started) {
      this.#bindSession(this.#session);
      this.#session.start();

      // A local session returns its current snapshot synchronously, and a
      // network session may already hold its first view. Render it so a switch
      // never leaves an empty table behind.
      const state = this.#session.getState?.();

      if (state) {
        this.#handleStateChange(state);
      }
    }
  }

  /**
   * Starts a fresh game after the user confirms it. All timers, modals and
   * per-deal UI state are cleared before the new game starts.
   *
   * @returns {void}
   */
  newGame() {
    if (!this.#session) {
      return;
    }

    if (this.#session.capabilities?.canRestart === false) {
      showToast('Новую игру может начать только хост.', 'info');
      return;
    }

    this.#resetUiState();
    this.#aiCache.clear();
    this.#session.restart();
  }

  /**
   * Asks for confirmation and starts a new game when appropriate.
   *
   * @returns {void}
   */
  requestNewGame() {
    if (!this.#session) {
      return;
    }

    if (this.#session.capabilities?.canRestart === false) {
      showToast('Новую игру может начать только хост.', 'info');
      return;
    }

    const state = this.#session.getState();

    if (!state || state.phase === PHASES.IDLE || state.dealNumber === 0) {
      this.newGame();
      return;
    }

    this.#paused = true;
    this.#clearAITimer();
    this.#clearTrickReveal();
    this.#render(state);

    openConfirmNewGameModal({
      onConfirm: () => this.newGame(),
      onCancel: () => {
        this.#paused = false;
        this.#syncModals(this.#session.getState());
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
    if (!this.#session) {
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
    if (!this.#session) {
      return;
    }

    this.#paused = false;
    this.#syncModals(this.#session.getState());
    this.#scheduleAI();
  }

  /**
   * Detaches listeners and stops timers. Intended for tests and hot reloads.
   *
   * @returns {void}
   */
  dispose() {
    this.#clearTimers();
    this.#renderToken += 1;
    this.#unsubscribeAll();
    closeModal({ silent: true });

    if (this.#elements.newGameButton && this.#newGameHandler) {
      this.#elements.newGameButton.removeEventListener('click', this.#newGameHandler);
    }
  }

  /**
   * Clears transient UI state shared by `newGame()` and `replaceSession()`.
   *
   * @returns {void}
   */
  #resetUiState() {
    this.#clearTimers();
    this.#renderToken += 1;
    this.#paused = false;
    this.#aiBusy = false;
    this.#trickReveal = null;
    this.#bubbles.clear();
    this.#marriageMenuOpen = false;
    this.#lastPlayedCardId = null;
    closeModal({ silent: true });
    cancelAnimations(this.#elements.board, this.#elements.tableCenter);
    this.#elements.logDrawer?.close({ restoreFocus: false });
    this.#announcer?.reset();
    resetLog(this.#elements.gameLog);
    resetToasts();
  }

  /**
   * Subscribes to every session event needed by the interface.
   *
   * @param {object} session
   * @returns {void}
   */
  #bindSession(session) {
    this.#unsubscribers = [
      session.subscribe((state) => this.#handleStateChange(state)),
      session.on(GAME_EVENTS.ERROR, (error) => this.#handleGameError(error)),
      session.on(GAME_EVENTS.BID, (payload) => {
        this.#setBubble(payload.playerId, String(payload.amount));
        playSound('bid');
      }),
      session.on(GAME_EVENTS.PASS, (payload) => {
        this.#setBubble(payload.playerId, 'Пас');
        playSound('pass');
      }),
      session.on(GAME_EVENTS.DEAL_STARTED, () => {
        this.#handleDealStarted();
        playSound('deal');
      }),
      session.on(GAME_EVENTS.PRIKUP, (payload) => {
        this.#handlePrikup(payload);
        playSound('prikup');
      }),
      session.on(GAME_EVENTS.GIFT, () => playSound('gift')),
      session.on(GAME_EVENTS.MARRIAGE, () => playSound('marriage')),
      session.on(GAME_EVENTS.CARD_PLAYED, (payload) => {
        this.#lastPlayedCardId = payload.cardId;
        playSound('card');
      }),
      session.on(GAME_EVENTS.TRICK_WON, (payload) => this.#handleTrickWon(payload)),
      session.on(GAME_EVENTS.SCORED, () => playSound('score')),
      session.on(GAME_EVENTS.GAME_OVER, () => playSound('win')),
      session.on('offline', (payload) => this.#handleConnectionChange(false, payload)),
      session.on('online', (payload) => this.#handleConnectionChange(true, payload)),
      session.on('sessionclosed', (payload) => this.#handleSessionClosed(payload)),
    ];

    this.#aiCache.clear();

    if (this.#elements.newGameButton) {
      this.#elements.newGameButton.disabled = session.capabilities?.canRestart === false;
    }
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
    playSound('error');

    if (error && typeof error === 'object' && error.name === 'GameError') {
      showToast(getActionErrorMessage(error));
      return;
    }

    console.error('[1000]', error);
    showToast('Не удалось выполнить действие. Попробуйте ещё раз.');
  }

  /**
   * Shows a network status change and re-renders the action bar so the
   * offline/online banner reflects the session state immediately.
   *
   * @param {boolean} connected
   * @param {{ message?: string } | undefined} payload
   * @returns {void}
   */
  #handleConnectionChange(connected, payload) {
    if (!this.#session || this.#sessionClosed) {
      return;
    }

    const message = typeof payload?.message === 'string' && payload.message.length > 0
      ? payload.message
      : (connected ? 'Связь восстановлена.' : 'Нет связи с комнатой.');

    showToast(message, 'info');

    const state = this.#session.getState?.();

    if (state) {
      this.#render(state);
    }
  }

  /**
   * Ends the controller view of a network session. The owner (main.js) decides
   * whether to return to the local game.
   *
   * @param {({ code?: string, message?: string } | undefined)} payload
   * @returns {void}
   */
  #handleSessionClosed(payload) {
    if (this.#sessionClosed) {
      return;
    }

    this.#sessionClosed = true;
    this.#clearTimers();
    closeModal({ silent: true });

    showToast(
      typeof payload?.message === 'string' && payload.message.length > 0
        ? payload.message
        : 'Сетевая сессия завершена.',
      'info',
    );

    this.#onSessionClosed?.(payload);
  }

  /**
   * @param {string} playerId
   * @param {string} text
   * @returns {void}
   */
  #setBubble(playerId, text) {
    if (typeof playerId !== 'string' || playerId === this.#session?.humanId) {
      return;
    }

    this.#bubbles.set(playerId, text);
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
   * Announces that an AI declarer took the already revealed prikup.
   *
   * @param {{ declarerId: string, cards: string[], handSize: number }} payload
   * @returns {void}
   */
  #handlePrikup(payload) {
    const state = this.#session?.getState();

    if (!state || payload.declarerId === this.#session.humanId) {
      return;
    }

    const declarer = state.players.find((player) => player.id === payload.declarerId);

    if (declarer) {
      showToast(`${declarer.name} забирает прикуп.`, 'info');
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

      const state = this.#session.getState();
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
   * @param {object | null} state
   * @returns {string | null}
   */
  #getViewerId(state) {
    return resolveViewerId(state, this.#session?.humanId ?? null);
  }

  /**
   * Returns the waiting text when the acting seat is a live player whose
   * connection dropped. AI seats never produce this text because the host
   * never substitutes AI for a disconnected person.
   *
   * @param {string | null} playerId
   * @returns {string | null}
   */
  #getOfflineWaitText(playerId) {
    if (!this.#session || typeof playerId !== 'string') {
      return null;
    }

    if (typeof this.#session.getSeatStatus !== 'function') {
      return null;
    }

    if (this.#session.getSeatStatus(playerId) !== 'нет связи') {
      return null;
    }

    const player = this.#session.getState()?.players.find((entry) => entry.id === playerId);

    return `Ждём ${player?.name ?? 'игрока'} — нет связи.`;
  }

  /**
   * Shows host- and guest-side presence during the game. The lobby modal covers
   * the pre-game presence; this indicator keeps offline seats and a lost local
   * connection visible at the table without changing the game state.
   *
   * @returns {void}
   */
  #renderPresence() {
    const session = this.#session;

    if (!session) {
      return;
    }

    const localOffline = session.connected === false;
    const seats = typeof session.getPresence === 'function'
      ? session.getPresence()
      : [];
    const offline = seats.filter(
      (seat) => seat.occupied === true && seat.connected !== true,
    );

    if (!localOffline && offline.length === 0) {
      return;
    }

    const items = [];

    if (localOffline) {
      const banner = getConnectionBanner({ connected: false });

      items.push(createElement('span', {
        className: ['action-bar__status', 'action-bar__status--offline', banner.className],
        text: banner.text,
      }));
    }

    if (offline.length > 0) {
      items.push(createElement('span', {
        className: 'action-bar__status action-bar__status--offline',
        text: `Нет связи: ${offline.map((seat) => seat.name).join(', ')}.`,
      }));
    }

    this.#elements.actionBar.append(
      createElement('div', { className: 'action-bar__group' }, ...items),
    );
  }

  /**
   * Shows the pending-action status while the relay/host confirms a guest
   * action. The status also blocks duplicate controls through `isPending`.
   *
   * @returns {void}
   */
  #renderPendingStatus() {
    if (this.#session?.isPending !== true) {
      return;
    }

    this.#elements.actionBar.append(createElement('div', { className: 'action-bar__group' }, ...[
      createElement('span', {
        className: 'action-bar__status action-bar__status--pending',
        text: 'Отправляем…',
        attrs: { role: 'status' },
      }),
    ]));
  }

  /**
   * Guest views intentionally omit the public log; the session keeps the merged
   * deltas. Local and host views already carry their own log.
   *
   * @param {object} state
   * @returns {object}
   */
  #withSessionLog(state) {
    if (!state || Array.isArray(state.log)) {
      return state;
    }

    const log = Array.isArray(this.#session?.log) ? this.#session.log : null;

    return log ? { ...state, log } : state;
  }

  /**
   * @param {object} state
   * @returns {void}
   */
  #render(state) {
    state = this.#withSessionLog(state);

    const reveal = this.#trickReveal;
    const displayState = reveal
      ? { ...state, currentTrick: reveal.cards, currentPlayerId: null }
      : state;
    const viewerId = this.#getViewerId(state);
    const animatedCardId = this.#lastPlayedCardId;
    const focusSnapshot = captureFocus(this.#elements.board);
    const renderToken = ++this.#renderToken;
    this.#lastPlayedCardId = null;

    renderTable(displayState, this.#elements, {
      animatedCardId,
      winnerId: reveal ? reveal.winnerId : null,
      viewerId,
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

    const legalCardIds = this.#getViewerLegalCardIds(state, viewerId, Boolean(reveal));

    renderHand(state, {
      handEl: this.#elements.hand,
      viewerId,
      playerId: viewerId,
      legalCardIds,
      onCardSelect: legalCardIds ? (card) => this.#humanPlayCard(card) : null,
      onIllegalCard: legalCardIds
        ? () => showToast(getActionErrorMessage({ code: 'ILLEGAL_CARD' }), 'info')
        : null,
    });
    renderLog(state, this.#elements.gameLog);
    this.#renderHeader(state);
    this.#renderActionBar(state, reveal);
    this.#renderPendingStatus();
    this.#renderPresence();

    if (focusSnapshot && !restoreFocus(this.#elements.board, focusSnapshot)) {
      this.#applyFocusFallback();
    }

    if (focusSnapshot) {
      // A click on a control that is replaced during the same event can move
      // focus to <body> after the handler returns. Repair that on the next task,
      // unless a modal legitimately took focus in the meantime.
      window.setTimeout(() => {
        if (
          renderToken !== this.#renderToken
          || getOpenModalKind() !== null
          || !this.#elements.board.isConnected
        ) {
          return;
        }

        const active = document.activeElement;

        if (active === document.body || !document.body.contains(active)) {
          if (!restoreFocus(this.#elements.board, focusSnapshot)) {
            this.#applyFocusFallback();
          }
        }
      }, 0);
    }

    this.#announcer?.announce(getPhaseAnnouncement(state, {
      humanId: viewerId,
      reveal: reveal ? { winnerId: reveal.winnerId, points: reveal.points } : null,
    }));

    document.body.dataset.phase = state.phase;
  }

  /**
   * Moves focus to the marriage menu, the first legal card, or the action bar
   * when the previous control disappeared after a re-render.
   *
   * @returns {void}
   */
  #applyFocusFallback() {
    const menuOption = this.#elements.actionBar.querySelector('.marriage-option');

    if (menuOption instanceof HTMLElement) {
      menuOption.focus();
      return;
    }

    if (!focusFirstLegalCard(this.#elements.board)) {
      this.#elements.actionBar.focus({ preventScroll: true });
    }
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
    const viewerId = this.#getViewerId(state);

    clearElement(bar);

    if (revealActive && this.#trickReveal) {
      const winner = state.players.find((player) => player.id === this.#trickReveal.winnerId);

      bar.append(createElement('div', { className: 'action-bar__group' }, ...[
        createElement('span', {
          className: 'action-bar__status action-bar__status--result',
          text: `Взятка ${this.#trickReveal.points}: ${winner?.name ?? '—'}`,
        }),
      ]));
      return;
    }

    switch (state.phase) {
      case PHASES.BIDDING: {
        bar.append(createBiddingControls({
          state,
          humanId: viewerId,
          onBid: (amount) => this.#humanBid(amount),
          onPass: () => this.#humanBid(null),
        }));

        const bidder = state.players.find((player) => player.id === state.currentBidderId);
        const offlineText = bidder && bidder.id !== viewerId
          ? this.#getOfflineWaitText(bidder.id)
          : null;

        if (offlineText) {
          bar.append(createElement('div', { className: 'action-bar__group' }, ...[
            createElement('span', {
              className: 'action-bar__status action-bar__status--offline',
              text: offlineText,
            }),
          ]));
        }

        break;
      }
      case PHASES.PRIKUP: {
        const declarer = state.players.find((player) => player.id === state.declarerId);
        let statusText = declarer && declarer.id === viewerId
          ? 'Прикуп раскрыт — заберите три карты.'
          : `Прикуп раскрыт. ${declarer?.name ?? 'Играющий'} забирает карты.`;

        if (declarer && declarer.id !== viewerId) {
          const offlineText = this.#getOfflineWaitText(declarer.id);

          if (offlineText) {
            statusText = offlineText;
          }
        }

        bar.append(createElement('div', { className: 'action-bar__group' }, ...[
          createElement('span', {
            className: 'action-bar__status',
            text: statusText,
          }),
        ]));
        break;
      }
      case PHASES.GIVING: {
        const declarer = state.players.find((player) => player.id === state.declarerId);
        const declarerIsSelf = Boolean(declarer && declarer.id === viewerId);
        const raiseWindowOpen = !state.raiseDecided && state.givenCards.length === 0;
        let statusText;

        if (declarerIsSelf && raiseWindowOpen) {
          // The raise decision lives in the action bar so the table and the
          // declarer's ten-card hand stay visible while choosing an amount.
          bar.append(createRaiseControls({
            state,
            viewerId,
            onRaise: (amount) => this.#humanRaise(amount),
            onDecline: () => this.#humanDeclineRaise(),
          }));
          break;
        }

        if (!state.raiseDecided) {
          statusText = `${declarer?.name ?? 'Играющий'} решает, повышать ли заказ…`;
        } else if (declarerIsSelf) {
          const opponents = state.players.filter((player) => player.id !== viewerId);
          const names = formatGenitiveNames(opponents.map((player) => player.name));

          statusText = `Заказ ${state.contract}. Выберите по одной карте для `
            + `${names || 'соперников'} в окне отдара.`;
        } else {
          statusText = `Заказ ${state.contract}. ${declarer?.name ?? 'Играющий'} отдаёт карты соперникам…`;
        }

        if (!declarerIsSelf) {
          const offlineText = this.#getOfflineWaitText(declarer?.id ?? null);

          if (offlineText) {
            statusText = offlineText;
          }
        }

        bar.append(createElement('div', { className: 'action-bar__group' }, ...[
          createElement('span', {
            className: 'action-bar__status',
            text: statusText,
          }),
        ]));
        break;
      }
      case PHASES.PLAYING: {
        const group = createElement('div', { className: 'action-bar__group' });
        const pending = state.pendingMarriage;

        if (pending) {
          const owner = state.players.find((player) => player.id === pending.playerId);
          const isSelf = pending.playerId === viewerId;

          group.append(createPendingMarriageStatus({
            suit: pending.suit,
            playerName: owner?.name ?? 'Игрок',
            isSelf,
            onCancel: isSelf ? () => this.#humanCancelMarriage() : null,
          }));

          bar.append(group);
          break;
        }

        const actor = state.players.find((player) => player.id === state.currentPlayerId);
        let statusText = actor && actor.id === viewerId
          ? 'Ваш ход — выберите карту.'
          : (actor ? `Ход ${nameGenitive(actor.name)}…` : 'Розыгрыш…');

        if (actor && actor.id !== viewerId) {
          const offlineText = this.#getOfflineWaitText(actor.id);

          if (offlineText) {
            statusText = offlineText;
          }
        }

        group.append(createElement('span', {
          className: 'action-bar__status',
          text: statusText,
        }));

        const marriages = this.#getViewerMarriages(state, viewerId);

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
                this.#render(this.#session.getState());
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
        }));
        break;
      case PHASES.GAME_OVER: {
        const canRestart = this.#session.capabilities?.canRestart !== false;

        bar.append(createElement('span', {
          className: 'action-bar__status action-bar__status--result',
          text: canRestart
            ? 'Игра окончена. Итоговая таблица открыта.'
            : 'Игра окончена. Ждём, пока хост начнёт новую игру.',
        }));
        break;
      }
      default:
        bar.append(createElement('span', {
          className: 'action-bar__status',
          text: `${getPhaseName(state.phase)}…`,
        }));
        break;
    }
  }

  /**
   * @param {object} state
   * @param {boolean} revealActive
   * @returns {string[] | null}
   */
  #getViewerLegalCardIds(state, viewerId, revealActive) {
    if (revealActive || viewerId === null || this.#session?.isPending === true) {
      return null;
    }

    if (state.phase !== PHASES.PLAYING || state.currentPlayerId !== viewerId) {
      return null;
    }

    const viewer = state.players.find((player) => player.id === viewerId);

    if (!viewer || viewer.hand.length === 0) {
      return null;
    }

    const pending = state.pendingMarriage;

    if (pending && pending.playerId === viewerId) {
      return getMarriageConfirmationCards(viewer.hand, pending.suit)
        .map((card) => card.id);
    }

    let leadSuit = null;

    if (state.currentTrick.length > 0) {
      leadSuit = getCardById(state.currentTrick[0].cardId).suit;
    }

    return getLegalCards(viewer.hand, leadSuit, state.trumpSuit)
      .map((card) => card.id);
  }

  /**
   * @param {object} state
   * @returns {{ suit: string, value: number }[]}
   */
  #getViewerMarriages(state, viewerId) {
    if (viewerId === null || state.phase !== PHASES.PLAYING) {
      return [];
    }

    if (state.currentPlayerId !== viewerId) {
      return [];
    }

    if (state.pendingMarriage) {
      return [];
    }

    if (state.currentTrick.length > 0 || state.completedTricks.length < 1) {
      return [];
    }

    if (this.#hasDeclaredMarriageThisTrick(state, viewerId)) {
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
  #hasDeclaredMarriageThisTrick(state, viewerId) {
    const log = Array.isArray(state.log) ? state.log : [];

    for (let index = log.length - 1; index >= 0; index -= 1) {
      const entry = log[index];

      if (entry.type === 'trickwon') {
        return false;
      }

      if (entry.type === 'marriage' && entry.playerId === viewerId) {
        return true;
      }
    }

    return false;
  }

  /**
   * Blocks duplicate guest actions while the previous one is in flight.
   *
   * @returns {boolean}
   */
  #isActionBlocked() {
    return this.#paused || !this.#session || this.#session.isPending === true;
  }

  /**
   * @param {number | null} amount `null` means pass.
   * @returns {void}
   */
  #humanBid(amount) {
    if (this.#isActionBlocked()) {
      return;
    }

    try {
      this.#session.bid(this.#session.humanId, amount);
    } catch (error) {
      this.#reportUnexpected(error);
    }
  }

  /**
   * @param {Card} card
   * @returns {void}
   */
  #humanPlayCard(card) {
    if (this.#trickReveal || this.#isActionBlocked()) {
      return;
    }

    try {
      this.#session.playCard(this.#session.humanId, card.id);
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

    if (this.#isActionBlocked()) {
      return;
    }

    try {
      this.#session.declareMarriage(this.#session.humanId, suit);
    } catch (error) {
      this.#reportUnexpected(error);
      this.#render(this.#session.getState());
    }
  }

  /**
   * Cancels the human declarer's pending marriage before the confirmation card.
   *
   * @returns {void}
   */
  #humanCancelMarriage() {
    if (this.#isActionBlocked()) {
      return;
    }

    try {
      this.#session.cancelMarriage(this.#session.humanId);
    } catch (error) {
      this.#reportUnexpected(error);
      this.#render(this.#session.getState());
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
    if (this.#isActionBlocked()) {
      return;
    }

    try {
      // A guest queues both gifts in one click; the session posts them with
      // separate action ids while the controller blocks further clicks.
      for (const gift of gifts) {
        this.#session.giveCard(gift.toPlayerId, gift.cardId);
      }
    } catch (error) {
      this.#reportUnexpected(error);
      this.#render(this.#session.getState());
    }
  }

  /**
   * Applies the human declarer's single contract-raise decision.
   *
   * @param {number | null} amountOrNull New contract or null to decline.
   * @returns {void}
   */
  #resolveHumanRaise(amountOrNull) {
    if (this.#isActionBlocked()) {
      return;
    }

    try {
      this.#session.raiseContract(this.#session.humanId, amountOrNull);
    } catch (error) {
      this.#reportUnexpected(error);
      this.#render(this.#session.getState());
    }
  }

  /**
   * @param {number} amount
   * @returns {void}
   */
  #humanRaise(amount) {
    this.#resolveHumanRaise(amount);
  }

  /**
   * @returns {void}
   */
  #humanDeclineRaise() {
    this.#resolveHumanRaise(null);
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

    const viewerId = this.#getViewerId(state);
    const isHost = this.#session?.capabilities?.isHost === true;
    const kind = getOpenModalKind();
    const giftModalOpen = state.phase === PHASES.GIVING
      && state.declarerId === viewerId
      && (state.raiseDecided === true || state.givenCards.length > 0);
    const mandatoryModal = state.phase === PHASES.PRIKUP
      || giftModalOpen
      || state.phase === PHASES.DEAL_END
      || state.phase === PHASES.GAME_OVER;

    if (mandatoryModal) {
      this.#elements.logDrawer?.close({ restoreFocus: false });
    }

    if (state.phase === PHASES.PRIKUP) {
      if (kind !== 'prikup-reveal') {
        closeModal({ silent: true });
        openPrikupRevealModal({
          state,
          viewerId,
          isHost,
          onTakePrikup: () => this.#takePrikup(state.declarerId),
        });
      }

      return;
    }

    if (state.phase === PHASES.GIVING && state.declarerId === viewerId) {
      if (!giftModalOpen) {
        // The raise window is inline in the action bar, so the reveal modal
        // must not cover the declarer's hand while choosing an amount.
        if (kind === 'prikup-reveal') {
          closeModal({ silent: true });
        }

        return;
      }

      if (kind !== 'prikup') {
        closeModal({ silent: true });
        openGiftModal({
          state,
          viewerId,
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
            this.#session.nextDeal();
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
          isHost,
          onLeave: () => this.#onExitNetwork?.(),
        });
      }

      return;
    }

    if (
      kind === 'prikup'
      || kind === 'prikup-reveal'
      || kind === 'results'
      || kind === 'gameover'
    ) {
      closeModal({ silent: true });
    }
  }

  /**
   * Takes the revealed prikup for the declarer. The controller drives this for
   * both human and AI declarers because the reveal modal is mandatory.
   *
   * @param {string | null} declarerId
   * @returns {void}
   */
  #takePrikup(declarerId) {
    if (this.#isActionBlocked() || typeof declarerId !== 'string') {
      return;
    }

    try {
      this.#session.takePrikup(declarerId);
    } catch (error) {
      this.#reportUnexpected(error);
      this.#render(this.#session.getState());
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
      || !this.#session
      || this.#session.capabilities?.controlsAI === false
    ) {
      return;
    }

    const state = this.#session.getState();

    if (!state) {
      return;
    }

    const actor = state.currentPlayerId
      ? state.players.find((player) => player.id === state.currentPlayerId)
      : null;
    // PRIKUP is intentionally excluded: the mandatory reveal modal lets the
    // controller take the prikup for both human and AI declarers.
    const playablePhase = state.phase === PHASES.BIDDING
      || state.phase === PHASES.GIVING
      || state.phase === PHASES.PLAYING;

    if (!actor || !actor.isAI || !playablePhase) {
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
    if (
      this.#paused
      || this.#aiBusy
      || this.#trickReveal
      || !this.#session
      || this.#session.capabilities?.controlsAI === false
    ) {
      return;
    }

    this.#aiBusy = true;

    try {
      const state = this.#session.getState();
      const actor = state?.currentPlayerId
        ? state.players.find((player) => player.id === state.currentPlayerId)
        : null;

      if (!state || !actor || !actor.isAI) {
        return;
      }

      const ai = this.#getAI(actor.id);

      switch (state.phase) {
        case PHASES.BIDDING: {
          if (actor.score < 0 && state.currentBid > 0) {
            // Negative-score players are passed by the engine before their turn.
            // Never let the UI send a bid or a voluntary pass for them.
            break;
          }

          const view = this.#session.getPlayerView(actor.id);
          let amount = null;

          try {
            amount = ai.chooseBid(view, state.currentBid);
          } catch (error) {
            console.error('[1000] AI не смог выбрать ставку:', error);
          }

          if (!isLegalBid(state, amount)) {
            amount = getFallbackBid(state);
          }

          this.#session.bid(actor.id, amount);
          break;
        }
        case PHASES.PRIKUP:
          // The controller takes the revealed prikup from the mandatory modal.
          break;
        case PHASES.GIVING: {
          const view = this.#session.getPlayerView(actor.id);

          if (!state.raiseDecided && state.givenCards.length === 0) {
            let amount = null;

            if (actor.score >= 0) {
              try {
                amount = ai.chooseContractRaise(view);
              } catch (error) {
                console.error('[1000] AI не смог выбрать повышение заказа:', error);
              }
            }

            // The ceiling depends on the acting AI's own ten-card hand, so a
            // raise above BIDDING.MAX is legal when marriages are available.
            if (!isLegalRaise(state, amount, getMaxContract(getViewHand(view, actor.id))) || actor.score < 0) {
              amount = null;
            }

            this.#session.raiseContract(actor.id, amount);
            break;
          }

          let gift = null;

          try {
            const gifts = ai.chooseCardsToGive(view);
            gift = Array.isArray(gifts) ? gifts[0] : null;
          } catch (error) {
            console.error('[1000] AI не смог выбрать отдар:', error);
          }

          if (!isGiftFromView(view, actor.id, gift)) {
            gift = getFallbackGift(view, actor.id);
          }

          if (!gift) {
            throw new Error('Нет карты для отдара.');
          }

          this.#session.giveCard(gift.toPlayerId, gift.cardId);
          break;
        }
        case PHASES.PLAYING: {
          const view = this.#session.getPlayerView(actor.id);

          if (
            !state.pendingMarriage
            && state.currentTrick.length === 0
            && state.completedTricks.length >= 1
          ) {
            let suit = null;

            try {
              suit = ai.chooseMarriage(view);
            } catch (error) {
              console.error('[1000] AI не смог выбрать марьяж:', error);
            }

            if (suit) {
              this.#session.declareMarriage(actor.id, suit);
              break;
            }
          }

          const legalCards = this.#getLegalCardList(view, actor.id);
          let card = null;

          try {
            card = ai.chooseCard(view, legalCards);
          } catch (error) {
            console.error('[1000] AI не смог выбрать карту:', error);
          }

          if (!card || !legalCards.some((legalCard) => legalCard.id === card.id)) {
            card = legalCards[0] ?? null;
          }

          if (!card) {
            throw new Error('Нет легальной карты для хода.');
          }

          this.#session.playCard(actor.id, card.id);
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
   * Returns the cards that the acting AI may legally play. The list is always
   * derived from that AI's own player view, never from the viewer snapshot.
   *
   * @param {object} view AI player view with its own hand.
   * @param {string} playerId
   * @returns {import('../core/deck.js').Card[]}
   */
  #getLegalCardList(view, playerId) {
    const player = view.players.find((entry) => entry.id === playerId);

    if (!player || player.hand.length === 0) {
      return [];
    }

    const leadSuit = view.currentTrick.length > 0
      ? getCardById(view.currentTrick[0].cardId).suit
      : null;
    const legal = getLegalCards(player.hand, leadSuit, view.trumpSuit);
    const pending = view.pendingMarriage;

    if (pending && pending.playerId === playerId) {
      const confirmationIds = new Set(
        getMarriageConfirmationCards(player.hand, pending.suit)
          .map((card) => card.id),
      );

      return legal.filter((card) => confirmationIds.has(card.id));
    }

    return legal;
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

    const rng = this.#session.createAIRng(playerId);
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
 * @param {object} state
 * @param {number | null} amount
 * @returns {boolean}
 */
function isLegalBid(state, amount) {
  if (amount === null) {
    return state.currentBid > 0;
  }

  if (
    typeof amount !== 'number'
    || !Number.isInteger(amount)
    || amount < BIDDING.MIN
    || amount > BIDDING.MAX
    || amount % BIDDING.STEP !== 0
  ) {
    return false;
  }

  if (state.currentBid === 0) {
    return amount === BIDDING.MIN;
  }

  return amount >= state.currentBid + BIDDING.STEP;
}

/**
 * @param {object} state
 * @param {number | null} amount
 * @returns {boolean}
 */
function isLegalRaise(state, amount, max) {
  if (amount === null) {
    return true;
  }

  return isLegalRaiseAmount(amount, {
    contract: Number.isFinite(state.contract) ? state.contract : 0,
    max,
  });
}

/**
 * Reads the acting player's own hand from their player view.
 *
 * @param {object} view Player view carrying the acting AI's hand.
 * @param {string} playerId
 * @returns {string[]}
 */
function getViewHand(view, playerId) {
  const self = Array.isArray(view?.players)
    ? view.players.find((player) => player && player.id === playerId)
    : null;

  return Array.isArray(self?.hand) ? self.hand : [];
}

/**
 * @param {object} state
 * @returns {number | null}
 */
function getFallbackBid(state) {
  if (state.currentBid === 0) {
    return BIDDING.MIN;
  }

  const next = state.currentBid + BIDDING.STEP;

  return next <= BIDDING.MAX ? next : null;
}

/**
 * @param {object} view
 * @param {string} playerId
 * @param {unknown} gift
 * @returns {boolean}
 */
function isGiftFromView(view, playerId, gift) {
  if (!gift || typeof gift !== 'object') {
    return false;
  }

  const cardId = gift.cardId;
  const toPlayerId = gift.toPlayerId;
  const self = view.players.find((player) => player.id === playerId);
  const target = view.players.find((player) => player.id === toPlayerId);

  return Boolean(
    self
    && target
    && target.id !== playerId
    && self.hand.includes(cardId)
    && !view.givenCards.some((entry) => entry.toId === toPlayerId),
  );
}

/**
 * Picks the first remaining opponent and the first unused card when the AI
 * fails to return a legal gift.
 *
 * @param {object} view
 * @param {string} playerId
 * @returns {{ toPlayerId: string, cardId: string } | null}
 */
function getFallbackGift(view, playerId) {
  const givenTo = new Set(view.givenCards.map((entry) => entry.toId));
  const target = view.players.find((player) => player.id !== playerId && !givenTo.has(player.id));
  const self = view.players.find((player) => player.id === playerId);

  if (!target || !self) {
    return null;
  }

  const givenCards = new Set(view.givenCards.map((entry) => entry.cardId));
  const cardId = self.hand.find((id) => !givenCards.has(id));

  return cardId ? { toPlayerId: target.id, cardId } : null;
}
