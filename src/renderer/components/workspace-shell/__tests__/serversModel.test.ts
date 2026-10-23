import { describe, expect, it } from 'vitest';
import { deriveServerRows, detectLocalServerUrls } from '../sessionRail/serversModel';

/** The session rail's Servers card (user, 2026-10-22): addresses read from job output. */
describe('detectLocalServerUrls', () => {
  it('reads a coloured Vite banner, one address per port', () => {
    const banner =
      '\u001b[32m  VITE v5.4.0\u001b[39m  ready in 312 ms\n\n' +
      '  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n' +
      '  ➜  Network: http://192.168.1.20:5173/\n';
    expect(detectLocalServerUrls(banner)).toEqual([{ url: 'http://localhost:5173/', port: 5173 }]);
  });

  it('reads 0.0.0.0 and [::] as localhost, and drops sentence punctuation', () => {
    expect(
      detectLocalServerUrls(
        'Server listening on http://0.0.0.0:3000. API at https://[::]:8443/api, docs http://127.0.0.1:8000/docs;'
      )
    ).toEqual([
      { url: 'http://localhost:3000', port: 3000 },
      { url: 'https://localhost:8443/api', port: 8443 },
      { url: 'http://127.0.0.1:8000/docs', port: 8000 },
    ]);
  });

  it('the last address printed for a port wins; no port, no address', () => {
    expect(
      detectLocalServerUrls(
        'http://localhost:4000/ then http://localhost:4000/app see http://localhost/'
      )
    ).toEqual([{ url: 'http://localhost:4000/app', port: 4000 }]);
    expect(detectLocalServerUrls('https://example.com:8080/ and http://10.0.0.2:80/')).toEqual([]);
  });
});

describe('deriveServerRows', () => {
  it('lists the addresses of running jobs only, in job order', () => {
    const found = new Map([
      ['bash-1', [{ url: 'http://localhost:5173/', port: 5173 }]],
      ['bash-2', [{ url: 'http://localhost:3000', port: 3000 }]],
    ]);
    expect(
      deriveServerRows(
        [
          { id: 'bash-2', label: 'node server.js', status: 'running' },
          { id: 'bash-1', label: 'pnpm dev', status: 'completed' },
        ],
        found
      )
    ).toEqual([
      {
        key: 'bash-2:3000',
        jobId: 'bash-2',
        url: 'http://localhost:3000',
        port: 3000,
        label: 'node server.js',
      },
    ]);
  });
});
