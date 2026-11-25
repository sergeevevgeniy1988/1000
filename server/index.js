import { fileURLToPath } from 'node:url';

import { readConfig } from './config.js';
import { createRelay } from './relay.js';
import { createHttpServer } from './http.js';

/**
 * Relay entry point: reads the environment, wires the in-memory store and the
 * HTTP server, listens on HOST/PORT and shuts down cleanly on signals.
 */

const config = readConfig(process.env);
const relay = createRelay({
  roomTtlMs: config.roomTtlMs,
  maxRooms: config.maxRooms,
  presenceTimeoutMs: config.presenceTimeoutMs,
  closedRoomTtlMs: config.closedRoomTtlMs,
});
// The static root is the repository root, one level above `server/`.
const rootDir = fileURLToPath(new URL('..', import.meta.url));

const server = createHttpServer({
  config,
  relay,
  rootDir,
  logger: ({ method, path, status }) => {
    // Method, path and status only: headers, tokens and bodies never reach the log.
    console.log(`[relay] ${method} ${path} ${status}`);
  },
});

let closing = false;

/**
 * @param {string} signal
 * @returns {void}
 */
function shutdown(signal) {
  if (closing) {
    return;
  }

  closing = true;
  console.log(`[relay] ${signal}: shutting down`);
  relay.stop();

  server.close(() => {
    process.exit(0);
  });

  // Do not hang forever on keep-alive connections.
  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('error', (error) => {
  console.error(`[relay] server error: ${error instanceof Error ? error.message : 'unknown'}`);
  relay.stop();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`[relay] listening on http://${config.host}:${config.port}`);
  console.log(`[relay] origins: ${config.frontendOrigins.join(', ')}`);
});
