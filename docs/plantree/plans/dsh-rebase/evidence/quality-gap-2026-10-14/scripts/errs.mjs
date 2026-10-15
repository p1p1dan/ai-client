// Content-free classification of tool failures in local DSH session logs.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readLog } from './readlog.mjs';

const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.jsonl.zstd')) files.push(p);
  }
};
walk(process.argv[2]);
const cls = [
  [
    'ps-not-recognized',
    /is not recognized as (the name of )?a cmdlet|is not recognized as an internal or external command/i,
  ],
  ['ps-&&-token', /The token '&&' is not a valid|'&&'.*not a valid statement separator/i],
  [
    'ps-parser',
    /ParserError|Unexpected token|Missing (closing|expression|argument)|The string is missing the terminator/i,
  ],
  [
    'ps-param',
    /A parameter cannot be found|Cannot bind parameter|positional parameter cannot be found/i,
  ],
  ['edit-no-match', /not found in|did not match|no match|could not find|old_string/i],
  ['read-before', /read .*before|must read|has not been read|changed since/i],
  ['timeout', /timed out|timeout/i],
  ['denied', /denied|not permitted|EPERM|EACCES/i],
  ['not-exist', /does not exist|cannot find path|ENOENT|No such file/i],
];
const out = {};
let mojibake = 0,
  shellResults = 0,
  nonZero = 0;
for (const f of files) {
  const ev = readLog(f);
  const callName = new Map();
  for (const e of ev) {
    if (e.type === 'tool/call') callName.set(e.data.callId, e.data.name);
    if (e.type !== 'tool/result') continue;
    const name = callName.get(e.data.message?.toolCallId) ?? '?';
    const text = (e.data.message?.content ?? []).map((c) => c.text ?? '').join('');
    if (name === 'pwsh' || name === 'bash') {
      shellResults++;
      if (text.includes('�')) mojibake++;
      const m = text.match(/\[exit code: (\d+)\]/);
      if (m && m[1] !== '0') nonZero++;
    }
    const failed = e.data.message?.isError || /\[exit code: [1-9]\d*\]/.test(text);
    if (!failed) continue;
    const hit = cls.find(([, re]) => re.test(text));
    const k = `${name}:${hit ? hit[0] : 'other'}`;
    out[k] = (out[k] ?? 0) + 1;
  }
}
console.log(JSON.stringify({ shellResults, nonZero, mojibake, failures: out }, null, 1));
