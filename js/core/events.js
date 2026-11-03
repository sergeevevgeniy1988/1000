/**
 * Minimal event emitter used by the game core and the UI controller.
 * Listeners are stored in insertion order; duplicate listeners are ignored.
 */
export class EventEmitter {
  #listeners = new Map();

  /**
   * Subscribes a listener to an event.
   *
   * @param {string} eventName
   * @param {(payload?: unknown) => void} listener
   * @returns {() => void} A function that removes the subscription.
   */
  on(eventName, listener) {
    if (typeof eventName !== 'string' || eventName.length === 0) {
      throw new TypeError('Event name must be a non-empty string.');
    }

    if (typeof listener !== 'function') {
      throw new TypeError('Event listener must be a function.');
    }

    let listeners = this.#listeners.get(eventName);

    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(eventName, listeners);
    }

    listeners.add(listener);

    return () => {
      this.off(eventName, listener);
    };
  }

  /**
   * Removes a previously registered listener.
   *
   * @param {string} eventName
   * @param {(payload?: unknown) => void} listener
   * @returns {boolean} True when the listener was registered and removed.
   */
  off(eventName, listener) {
    const listeners = this.#listeners.get(eventName);

    if (!listeners) {
      return false;
    }

    const removed = listeners.delete(listener);

    if (listeners.size === 0) {
      this.#listeners.delete(eventName);
    }

    return removed;
  }

  /**
   * Calls every listener registered for the event.
   * The current listener set is snapshotted, so subscribing or unsubscribing
   * during emission does not affect the current dispatch.
   *
   * @param {string} eventName
   * @param {unknown} [payload]
   * @returns {number} Number of listeners that were called.
   */
  emit(eventName, payload) {
    const listeners = this.#listeners.get(eventName);

    if (!listeners || listeners.size === 0) {
      return 0;
    }

    const snapshot = [...listeners];

    for (const listener of snapshot) {
      listener(payload);
    }

    return snapshot.length;
  }

  /**
   * Removes all listeners for one event, or all listeners when no event is given.
   *
   * @param {string} [eventName]
   */
  clear(eventName) {
    if (eventName === undefined) {
      this.#listeners.clear();
      return;
    }

    this.#listeners.delete(eventName);
  }

  /**
   * Returns the number of listeners registered for an event.
   *
   * @param {string} eventName
   * @returns {number}
   */
  listenerCount(eventName) {
    return this.#listeners.get(eventName)?.size ?? 0;
  }
}
