import { BIDDING, MAX_CONTRACT, SUITS } from '../core/constants.js';

/**
 * Shared wire protocol for the LAN relay. The browser client and the tests use
 * the same validators so that a payload accepted by the UI is also accepted by
 * the fake relay and vice versa.
 */

/** Version of the room API contract implemented by `tools/relay.ps1`. */
export const API_VERSION = 1;

/** Room codes are six characters without visually ambiguous symbols. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

/** Display-name limits shared with the PowerShell relay. */
export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 24;

/** Action ids are opaque client-generated strings; the server deduplicates them. */
export const ACTION_ID_MIN_LENGTH = 1;
export const ACTION_ID_MAX_LENGTH = 64;

/** Polling cadence for the short-poll transport. */
export const POLL_INTERVAL_MS = 400;
export const LOBBY_POLL_INTERVAL_MS = 1200;
export const REQUEST_TIMEOUT_MS = 8000;
export const RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 300;

/**
 * Health check timing. A Render Free instance wakes up from sleep in about a
 * minute, so the health request waits much longer than a game request and is
 * attempted twice; game transports keep their own shorter timings.
 */
export const HEALTH_TIMEOUT_MS = 30000;
export const HEALTH_RETRY_ATTEMPTS = 2;

/**
 * Guest-side timing. Actions are queued over HTTP and the host confirms them
 * with the next state change; polls back off while the relay is unreachable.
 */
export const GUEST_ACTION_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
export const GUEST_ACTION_RETRY_ATTEMPTS = RETRY_ATTEMPTS;
export const GUEST_RECONNECT_BASE_DELAY_MS = RETRY_BASE_DELAY_MS;
export const GUEST_RECONNECT_MAX_DELAY_MS = 5000;

/**
 * Host-side limits. The host polls the action queue at the same cadence as a
 * guest polls the player endpoint; the relay itself also caps the queue at 100.
 */
export const HOST_ACTION_POLL_INTERVAL_MS = POLL_INTERVAL_MS;
export const HOST_ACTION_BATCH_LIMIT = 50;
export const HOST_ACTION_DEDUPE_LIMIT = 100;
export const HOST_EVENT_BUFFER_LIMIT = 500;
export const HOST_VIEW_MAX_BYTES = 16 * 1024;
export const HOST_PUBLISH_RETRY_ATTEMPTS = 3;
export const HOST_PUBLISH_RETRY_DELAY_MS = 1000;
export const HOST_PUBLISH_COALESCE_MS = 50;

/** Stable action type names understood by the host and the relay. */
export const ACTION_TYPES = Object.freeze({
  BID: 'bid',
  PASS: 'pass',
  TAKE_PRIKUP: 'takePrikup',
  RAISE_CONTRACT: 'raiseContract',
  DECLINE_RAISE: 'declineRaise',
  GIVE_CARD: 'giveCard',
  DECLARE_MARRIAGE: 'declareMarriage',
  CANCEL_MARRIAGE: 'cancelMarriage',
  PLAY_CARD: 'playCard',
  NEXT_DEAL: 'nextDeal',
});

export const ACTION_TYPE_LIST = Object.freeze(Object.values(ACTION_TYPES));

/** Player seats in clockwise seating order. */
export const SEAT_IDS = Object.freeze(['human', 'alice', 'boris']);

/** Fields a guest must never send in an action payload. */
export const FORBIDDEN_ACTION_FIELDS = Object.freeze([
  'playerId',
  'token',
  'actionId',
  'roomCode',
  'isHost',
  'host',
  '__proto__',
  'constructor',
  'prototype',
]);

const CARD_ID_PATTERN = /^[SCDH](?:9|J|Q|K|10|A)$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

const ACTION_ALLOWED_FIELDS = Object.freeze({
  [ACTION_TYPES.BID]: Object.freeze(['amount']),
  [ACTION_TYPES.PASS]: Object.freeze([]),
  [ACTION_TYPES.TAKE_PRIKUP]: Object.freeze([]),
  [ACTION_TYPES.RAISE_CONTRACT]: Object.freeze(['amount']),
  [ACTION_TYPES.DECLINE_RAISE]: Object.freeze([]),
  [ACTION_TYPES.GIVE_CARD]: Object.freeze(['toPlayerId', 'cardId']),
  [ACTION_TYPES.DECLARE_MARRIAGE]: Object.freeze(['suit']),
  [ACTION_TYPES.CANCEL_MARRIAGE]: Object.freeze([]),
  [ACTION_TYPES.PLAY_CARD]: Object.freeze(['cardId']),
  [ACTION_TYPES.NEXT_DEAL]: Object.freeze([]),
});

/**
 * @typedef {object} ValidationResult
 * @property {boolean} ok
 * @property {string} [code]
 * @property {string} [message]
 */

/**
 * @param {string} code
 * @param {string} message
 * @returns {ValidationResult}
 */
function invalid(code, message) {
  return { ok: false, code, message };
}

/**
 * Normalizes a room code typed by a person or read from `?room=`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeRoomCode(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toUpperCase();
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidRoomCode(value) {
  return typeof value === 'string' && ROOM_CODE_PATTERN.test(normalizeRoomCode(value));
}

/**
 * Normalizes a display name exactly like the relay: trim only.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasControlCharacters(value) {
  return typeof value === 'string' && CONTROL_CHARACTER_PATTERN.test(value);
}

/**
 * Checks a display name against the shared limits.
 *
 * @param {unknown} value
 * @returns {ValidationResult & { name?: string }}
 */
export function validateName(value) {
  const name = normalizeName(value);

  if (name.length < NAME_MIN_LENGTH) {
    return { ...invalid('name_required', 'Введите имя.'), name };
  }

  if (name.length > NAME_MAX_LENGTH) {
    return { ...invalid('name_too_long', `Имя должно быть не длиннее ${NAME_MAX_LENGTH} символов.`), name };
  }

  if (hasControlCharacters(name)) {
    return { ...invalid('name_control', 'Имя не должно содержать управляющих символов.'), name };
  }

  return { ok: true, name };
}

/**
 * Checks whether a lobby already contains the same name. The relay compares
 * names case-insensitively.
 *
 * @param {string} name
 * @param {ReadonlyArray<{ name?: string | null, playerId?: string, occupied?: boolean }>} seats
 * @param {string | null} [excludePlayerId]
 * @returns {boolean}
 */
export function isNameTaken(name, seats, excludePlayerId = null) {
  const normalized = normalizeName(name).toLocaleLowerCase('ru-RU');

  if (normalized.length === 0 || !Array.isArray(seats)) {
    return false;
  }

  return seats.some((seat) => {
    if (!seat || seat.occupied === false || seat.playerId === excludePlayerId) {
      return false;
    }

    return normalizeName(seat.name).toLocaleLowerCase('ru-RU') === normalized;
  });
}

/**
 * Validates a name against a lobby snapshot.
 *
 * @param {unknown} value
 * @param {object} [options]
 * @param {{ seats?: ReadonlyArray<object> } | null} [options.lobby]
 * @param {string | null} [options.excludePlayerId]
 * @returns {ValidationResult & { name?: string }}
 */
export function validateLobbyName(value, { lobby = null, excludePlayerId = null } = {}) {
  const result = validateName(value);

  if (!result.ok) {
    return result;
  }

  if (lobby && isNameTaken(result.name, lobby.seats ?? [], excludePlayerId)) {
    return { ...invalid('name_taken', 'Это имя уже занято в комнате.'), name: result.name };
  }

  return result;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidActionId(value) {
  return typeof value === 'string'
    && value.length >= ACTION_ID_MIN_LENGTH
    && value.length <= ACTION_ID_MAX_LENGTH
    && !hasControlCharacters(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidCardId(value) {
  return typeof value === 'string' && CARD_ID_PATTERN.test(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidSeatId(value) {
  return typeof value === 'string' && SEAT_IDS.includes(value);
}

/**
 * Bids are limited to the auction range. A contract raise may go higher: the
 * declarer adds the marriage bonuses of the hand after taking the prikup, up to
 * `MAX_CONTRACT`.
 *
 * @param {unknown} amount
 * @returns {boolean}
 */
function isValidBidAmount(amount) {
  return typeof amount === 'number'
    && Number.isInteger(amount)
    && amount >= BIDDING.MIN
    && amount <= BIDDING.MAX
    && amount % BIDDING.STEP === 0;
}

/**
 * @param {unknown} amount
 * @returns {boolean}
 */
function isValidRaiseAmount(amount) {
  return typeof amount === 'number'
    && Number.isInteger(amount)
    && amount >= BIDDING.MIN
    && amount <= MAX_CONTRACT
    && amount % BIDDING.STEP === 0;
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
function asPayloadObject(payload) {
  if (payload === null || payload === undefined) {
    return {};
  }

  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  return payload;
}

/**
 * Validates one action payload. The same function is used by the lobby UI,
 * sessions and the fake relay in tests.
 *
 * @param {unknown} type
 * @param {unknown} [payload]
 * @returns {ValidationResult & { type?: string, payload?: Record<string, unknown> }}
 */
export function validateAction(type, payload = {}) {
  if (typeof type !== 'string' || !ACTION_TYPE_LIST.includes(type)) {
    return invalid('unknown_action', 'Неизвестный тип действия.');
  }

  const payloadObject = asPayloadObject(payload);

  if (payloadObject === null) {
    return invalid('bad_payload', 'Тело действия должно быть объектом.');
  }

  for (const key of Object.keys(payloadObject)) {
    if (FORBIDDEN_ACTION_FIELDS.includes(key)) {
      return invalid('forbidden_field', `Поле «${key}» нельзя отправлять в действии.`);
    }
  }

  const allowed = ACTION_ALLOWED_FIELDS[type];

  for (const key of Object.keys(payloadObject)) {
    if (!allowed.includes(key)) {
      return invalid('unknown_field', `Неизвестное поле действия «${key}».`);
    }
  }

  switch (type) {
    case ACTION_TYPES.BID: {
      if (!isValidBidAmount(payloadObject.amount)) {
        return invalid(
          'bad_amount',
          `Ставка должна быть кратна ${BIDDING.STEP} и находиться в диапазоне ${BIDDING.MIN}–${BIDDING.MAX}.`,
        );
      }

      return { ok: true, type, payload: { amount: payloadObject.amount } };
    }

    case ACTION_TYPES.RAISE_CONTRACT: {
      if (!isValidRaiseAmount(payloadObject.amount)) {
        return invalid(
          'bad_amount',
          `Заказ можно повысить до числа от ${BIDDING.MIN} до ${MAX_CONTRACT} с шагом ${BIDDING.STEP}.`,
        );
      }

      return { ok: true, type, payload: { amount: payloadObject.amount } };
    }

    case ACTION_TYPES.GIVE_CARD: {
      if (!isValidSeatId(payloadObject.toPlayerId)) {
        return invalid('bad_target', 'Неизвестное место получателя карты.');
      }

      if (!isValidCardId(payloadObject.cardId)) {
        return invalid('bad_card', 'Неизвестная карта.');
      }

      return {
        ok: true,
        type,
        payload: {
          toPlayerId: payloadObject.toPlayerId,
          cardId: payloadObject.cardId,
        },
      };
    }

    case ACTION_TYPES.DECLARE_MARRIAGE: {
      if (typeof payloadObject.suit !== 'string' || !SUITS.includes(payloadObject.suit)) {
        return invalid('bad_suit', 'Неизвестная масть марьяжа.');
      }

      return { ok: true, type, payload: { suit: payloadObject.suit } };
    }

    case ACTION_TYPES.PLAY_CARD: {
      if (!isValidCardId(payloadObject.cardId)) {
        return invalid('bad_card', 'Неизвестная карта.');
      }

      return { ok: true, type, payload: { cardId: payloadObject.cardId } };
    }

    default:
      return { ok: true, type, payload: {} };
  }
}

/**
 * Validates the server wrapper around one queued action. The host trusts the
 * wrapper's `playerId` (the relay derives it from the token) and validates the
 * action payload with the same rules as the client.
 *
 * @param {unknown} action
 * @returns {ValidationResult & { playerId?: string, actionId?: string, type?: string, payload?: Record<string, unknown>, seq?: number }}
 */
export function validateActionEnvelope(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return invalid('bad_action', 'Некорректное действие.');
  }

  if (!isValidSeatId(action.playerId)) {
    return invalid('bad_player', 'Неизвестное место автора действия.');
  }

  if (!isValidActionId(action.actionId)) {
    return invalid('bad_action', 'Некорректный идентификатор действия.');
  }

  if (!Number.isInteger(action.seq) || action.seq < 1) {
    return invalid('bad_action', 'Некорректный номер действия в очереди.');
  }

  const validation = validateAction(action.type, action.payload ?? {});

  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    playerId: action.playerId,
    actionId: action.actionId,
    type: validation.type,
    payload: validation.payload,
    seq: action.seq,
  };
}

/**
 * User-facing text for a live seat that lost its connection.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function formatOfflineWait(name) {
  return `Ждём ${typeof name === 'string' && name.length > 0 ? name : 'игрока'} — нет связи.`;
}

/**
 * Exponential backoff used by the guest poll loop after a network failure.
 * The first failure waits one base delay, then the delay doubles up to a cap.
 *
 * @param {number} [attempt] Zero-based failure index.
 * @param {object} [options]
 * @param {number} [options.base]
 * @param {number} [options.max]
 * @returns {number}
 */
export function getReconnectDelay(attempt = 0, {
  base = GUEST_RECONNECT_BASE_DELAY_MS,
  max = GUEST_RECONNECT_MAX_DELAY_MS,
} = {}) {
  const index = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const delay = base * (2 ** index);

  return Math.min(Math.max(0, max), Math.max(0, delay));
}

/**
 * Creates a random opaque action id. `crypto.randomUUID` is used when the
 * runtime provides it; the fallback is sufficient for the relay deduplication
 * window and never leaves the browser.
 *
 * @param {string} [prefix]
 * @returns {string}
 */
export function createActionId(prefix = 'act') {
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  let randomPart = '';

  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    randomPart = cryptoApi.randomUUID();
  } else {
    randomPart = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  return `${prefix}-${randomPart}`.slice(0, ACTION_ID_MAX_LENGTH);
}

/**
 * Builds a validated action envelope ready for `POST /action`.
 *
 * @param {string} type
 * @param {object} [payload]
 * @returns {{ ok: true, action: { actionId: string, type: string, payload: object } } | ValidationResult}
 */
export function createAction(type, payload = {}) {
  const validation = validateAction(type, payload);

  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    action: {
      actionId: createActionId(type),
      type: validation.type,
      payload: validation.payload,
    },
  };
}

/**
 * @param {string} code
 * @param {string} action
 * @returns {string}
 */
export function buildRoomPath(code, action) {
  const normalized = normalizeRoomCode(code);
  return `/api/rooms/${encodeURIComponent(normalized)}/${action}`;
}

/**
 * Checks that `/api/health` reports the LAN relay.
 *
 * @param {unknown} health
 * @returns {boolean}
 */
export function isLanHealth(health) {
  return Boolean(
    health
    && typeof health === 'object'
    && health.ok === true
    && health.lan === true,
  );
}

/**
 * Builds a shareable invitation URL. Only the room code is placed in the URL;
 * tokens never leave the request headers.
 *
 * @param {string} code
 * @param {object} [options]
 * @param {string} [options.origin]
 * @param {string} [options.pathname]
 * @returns {string}
 */
export function formatInviteLink(code, { origin = '', pathname = '/' } = {}) {
  const normalized = normalizeRoomCode(code);

  if (!isValidRoomCode(normalized)) {
    return '';
  }

  const base = origin.replace(/\/$/, '');
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;

  return `${base}${path}?room=${encodeURIComponent(normalized)}`;
}
