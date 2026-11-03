// Compare golden vs recorded after masking id churn; report what remains per file.
import fs from 'node:fs';
import path from 'node:path';

const [gold, rec] = process.argv.slice(2);
const mask = (s) =>
  s
    .replace(/dsh-(user|command)-\d+/g, 'dsh-$1-N')
    .replace(/#\d+"/g, '#N"')
    .replace(/\bid-\d+\b/g, 'id-N')
    .replace(/toolu_id-\d+/g, 'toolu_id-N')
    .replace(/bash-[0-9a-f]{16}|bash-\d+/g, 'bash-X')
    .replace(/-\d+:tool-result/g, '-N:tool-result');
const flat = (v, p = '$', out = {}) => {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) flat(v[k], Array.isArray(v) ? `${p}[${k}]` : `${p}.${k}`, out);
    if (Object.keys(v).length === 0) out[p] = JSON.stringify(v);
  } else out[p] = JSON.stringify(v);
  return out;
};
for (const f of fs.readdirSync(rec).sort()) {
  if (!/^(stream|rpc)\./.test(f)) continue;
  const g = path.join(gold, f);
  if (!fs.existsSync(g)) {
    console.log(f, 'NEW FILE');
    continue;
  }
  const a = JSON.parse(mask(fs.readFileSync(g, 'utf8'))),
    b = JSON.parse(mask(fs.readFileSync(path.join(rec, f), 'utf8')));
  if (f.startsWith('stream.')) {
    const ta = a.map((e) => e.type),
      tb = b.map((e) => e.type);
    if (JSON.stringify(ta) !== JSON.stringify(tb)) {
      console.log(`${f}: event types differ\n  old: ${ta.join(' ')}\n  new: ${tb.join(' ')}`);
      continue;
    }
  }
  const fa = flat(a),
    fb = flat(b);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const d = [...keys].filter((k) => fa[k] !== fb[k]);
  if (d.length) {
    console.log(`${f}: ${d.length} value diffs`);
    for (const k of d.slice(0, 6))
      console.log(`  ${k}: ${String(fa[k]).slice(0, 140)} -> ${String(fb[k]).slice(0, 140)}`);
  }
}
