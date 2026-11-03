/**
 * An error raised by the game core for invalid actions or data.
 * The code is stable and intended for programmatic handling; the message is
 * human-readable and may be shown to the player.
 */
export class GameError extends Error {
  /**
   * @param {string} code Stable machine-readable error code.
   * @param {string} message Human-readable description.
   * @param {Record<string, unknown>} [details] Optional diagnostic context.
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'GameError';
    this.code = code;

    if (details !== undefined) {
      this.details = details;
    }
  }
}
