/**
 * Tests' stand-in for `electron-log/renderer.js` (aliased in vitest.config.ts).
 *
 * The real export is a Proxy that answers every property with a log function —
 * `then` included — so the test runner's module loader, which awaits what a
 * module exports, waits on it forever. Any test that imported the real
 * settings store (`@/stores/settings` → `@/utils/logging`) hung and held its
 * worker. Nothing under test depends on the logger itself.
 */
const noop = () => undefined;

const log = {
  transports: { ipc: { level: 'info' as string }, console: { level: 'info' as string } },
  error: noop,
  warn: noop,
  info: noop,
  verbose: noop,
  debug: noop,
  silly: noop,
  log: noop,
};

export default log;
