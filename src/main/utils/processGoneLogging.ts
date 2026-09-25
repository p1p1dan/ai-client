import type { Details, RenderProcessGoneDetails, WebContents } from 'electron';

/**
 * T4 — leave a line in the log file when a renderer or helper process dies.
 *
 * Without these a renderer crash shows the user a white window and leaves
 * the log with nothing: `uncaughtException` / `unhandledRejection` only see
 * the MAIN process. Logging only — what happens after a crash (reload,
 * relaunch, exit) is a separate, undecided policy.
 */

interface ProcessGoneLogger {
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

interface ProcessGoneEmitter {
  on(
    event: 'render-process-gone',
    listener: (event: unknown, webContents: WebContents, details: RenderProcessGoneDetails) => void
  ): unknown;
  on(event: 'child-process-gone', listener: (event: unknown, details: Details) => void): unknown;
}

function describeWebContents(webContents: WebContents | undefined): string {
  if (!webContents) return 'unknown';
  try {
    return `#${webContents.id} ${webContents.getURL()}`;
  } catch {
    // A destroyed WebContents throws on access; the id alone still helps.
    return `#${webContents.id}`;
  }
}

export function registerProcessGoneLogging(app: ProcessGoneEmitter, log: ProcessGoneLogger): void {
  app.on('render-process-gone', (_event, webContents, details) => {
    log.error('[process] render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      webContents: describeWebContents(webContents),
    });
  });

  app.on('child-process-gone', (_event, details) => {
    // Utility processes exit cleanly all the time; only the rest is a fault.
    const write = details.reason === 'clean-exit' ? log.info : log.error;
    write('[process] child-process-gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      ...(details.serviceName ? { serviceName: details.serviceName } : {}),
      ...(details.name ? { name: details.name } : {}),
    });
  });
}
