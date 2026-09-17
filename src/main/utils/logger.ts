import fsp from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main.js';

// Guard to ensure initialization happens only once
let initialized = false;

/**
 * Clean up old log files (async, non-blocking)
 * Removes log files older than the specified number of days
 */
async function cleanupOldLogs(daysToKeep: number = 30): Promise<void> {
  try {
    const logDir = app.getPath('logs');
    const files = await fsp.readdir(logDir);
    const now = Date.now();
    const maxAge = daysToKeep * 24 * 60 * 60 * 1000; // Convert days to milliseconds

    for (const file of files) {
      // Only process aiclient log files (including .old.log from size rotation)
      if (file.startsWith('aiclient-') && file.endsWith('.log')) {
        const filePath = path.join(logDir, file);
        const stats = await fsp.stat(filePath);
        const age = now - stats.mtime.getTime();

        if (age > maxAge) {
          await fsp.unlink(filePath);
          log.info(`Cleaned up old log file: ${file}`);
        }
      }
    }
  } catch (error) {
    // Silently fail - don't break app if log cleanup fails
    log.error('Failed to clean up old logs:', error);
  }
}

/**
 * Floors that apply while the user's "diagnostic logging" switch is OFF —
 * which is the configuration nearly every machine runs (see `init()` in
 * main/index.ts: the setting defaults to false).
 *
 * T066 (D4/D10/D14, 2026-09-17 field pass). Both floors used to be `error`, and
 * because `initLogger` hijacks `console` into electron-log, that one line
 * silently deleted EVERY `console.warn` / `console.log` diagnostic the main
 * process writes — 80 warn call sites and 22 info ones at the time of writing.
 * The field pass read it as "electron-log swallows anything below error"; the
 * wiring is fine, the floor was ours. A repaired session index, a legacy-import
 * batch and an archived temp chat deleting its scratch directory all ran with
 * literally zero lines on disk, so "it worked" and "it never ran" looked the
 * same to anyone reading the log afterwards.
 *
 * Two different floors on purpose:
 *
 * - The FILE is the operator's record, so it keeps `info`: the lifecycle
 *   milestones (a batch import ran, a scratch directory was released) are the
 *   half of the story that failure-only logging cannot tell. Cost measured
 *   before changing it: 22 existing info call sites in the whole main process,
 *   20 of which fire at most once per app lifecycle, against a 10 MB rotation
 *   and a 7-day retention.
 * - The CONSOLE stays at `warn`, so a developer terminal (and the dev.js
 *   capture) still only shows things that want attention.
 *
 * The alternative — leaving the floor at `warn` and logging successful
 * operations AS warnings to get them past it — was rejected: it buys the same
 * lines by lying about severity, and a warn channel full of routine success is
 * a channel nobody reads.
 */
export const DISABLED_FILE_LEVEL = 'info' as const;
export const DISABLED_CONSOLE_LEVEL = 'warn' as const;

/**
 * Initialize logger with configuration
 * @param enabled - Whether logging is enabled (defaults to false; see the floors above)
 * @param level - Log level to use when enabled
 * @param retentionDays - Number of days to keep log files (optional, only used on first init)
 */
export function initLogger(
  enabled: boolean = false,
  level: 'error' | 'warn' | 'info' | 'debug' = 'info',
  retentionDays?: number
): void {
  // One-time initialization: setup log file path, format, and hijack console
  if (!initialized) {
    // Set log file path with daily rotation (YYYY-MM-DD format)
    log.transports.file.resolvePathFn = () => {
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const fileName = `aiclient-${year}-${month}-${day}.log`;
      return path.join(app.getPath('logs'), fileName);
    };

    // Configure log file rotation (backup mechanism if daily log exceeds 10MB)
    log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB

    // Configure log format
    log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
    log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {text}';

    // Initialize and hijack console methods - all console.log/warn/error become log
    log.initialize({ preload: true });
    Object.assign(console, log.functions);

    // Clean up old log files asynchronously (non-blocking)
    // Use void to explicitly ignore the promise (fire-and-forget)
    void cleanupOldLogs(retentionDays ?? 7);

    initialized = true;
  }

  // Configure log levels based on settings (can be called multiple times)
  if (enabled) {
    log.transports.file.level = level;
    log.transports.console.level = level;
  } else {
    // Switch off: keep the operator's baseline, not silence. See the floors above.
    log.transports.file.level = DISABLED_FILE_LEVEL;
    log.transports.console.level = DISABLED_CONSOLE_LEVEL;
  }
}

export default log;
