// Logging reverse proxy for Anthropic API traffic (BUG-2026-07-29-prompt-cache-rewrite).
//
// cli.js is re-spawned by the Agent SDK on every turn, so interception must sit on the
// HTTP hop: point ANTHROPIC_BASE_URL / AICLIENT_TEST_BASE_URL at this proxy and
// diff the dumped request bodies (tools/system/messages prefix must be byte-stable
// across turns for prompt caching to ever hit).
//
// Usage:
//   UPSTREAM=<real base url> node spikes/capture-proxy.mjs [port=8791]
//   then e.g.:  AICLIENT_TEST_BASE_URL=http://127.0.0.1:8791 \
//               node --experimental-strip-types <probe-script>.ts
// Dumps req-NNN.json / res-NNN.txt into $LOGDIR (default ./captures). Auth headers redacted.

import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8791);
const upstreamRaw = process.env.UPSTREAM || process.env.ANTHROPIC_BASE_URL;
if (!upstreamRaw) {
  console.error('Set UPSTREAM (or ANTHROPIC_BASE_URL) to the real gateway base URL');
  process.exit(1);
}
const UPSTREAM = new URL(upstreamRaw);
const LOGDIR = process.env.LOGDIR || join(process.cwd(), 'captures');
mkdirSync(LOGDIR, { recursive: true });

let seq = 0;
const redact = (headers) => {
  const out = { ...headers };
  for (const k of Object.keys(out)) {
    if (/authorization|x-api-key|cookie/i.test(k)) out[k] = '<redacted>';
  }
  return out;
};

http
  .createServer((req, res) => {
    const id = String(++seq).padStart(3, '0');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let parsed = null;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {}
      writeFileSync(
        join(LOGDIR, `req-${id}.json`),
        JSON.stringify(
          {
            ts: new Date().toISOString(),
            method: req.method,
            url: req.url,
            headers: redact(req.headers),
            body: parsed ?? body.toString('utf8'),
          },
          null,
          2
        )
      );

      const upstreamHeaders = {
        ...req.headers,
        host: UPSTREAM.host,
        'content-length': String(body.length),
      };
      const up = https.request(
        {
          host: UPSTREAM.host,
          port: UPSTREAM.port || 443,
          path: req.url,
          method: req.method,
          headers: upstreamHeaders,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          const resChunks = [];
          upRes.on('data', (c) => {
            resChunks.push(c);
            res.write(c);
          });
          upRes.on('end', () => {
            res.end();
            const resBody = Buffer.concat(resChunks);
            const enc = upRes.headers['content-encoding'];
            writeFileSync(
              join(LOGDIR, `res-${id}.txt`),
              `HTTP ${upRes.statusCode}\n${JSON.stringify(redact(upRes.headers), null, 2)}\n\n` +
                (enc ? `<${enc}-compressed ${resBody.length} bytes>` : resBody.toString('utf8'))
            );
            console.log(
              `[${id}] ${req.method} ${req.url} -> ${upRes.statusCode} (req ${body.length}B, res ${resBody.length}B)`
            );
          });
        }
      );
      up.on('error', (e) => {
        console.error(`[${id}] upstream error:`, e.message);
        if (!res.headersSent) res.writeHead(502);
        res.end('proxy upstream error');
      });
      up.end(body);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(
      `capture proxy on http://127.0.0.1:${PORT} -> ${UPSTREAM.origin}, logs in ${LOGDIR}`
    );
  });
