// Decision 189 evidence harness: compares two run-record.sh outputs scenario
// by scenario — the normalized recordings each run kept under
// <dir>/<scenario>/recorded/ — and prints every JSON path that differs.
//   node compare-recordings.mjs <before-dir> <after-dir> [--json out.json]
import fs from 'node:fs';
import path from 'node:path';

const [before, after, ...rest] = process.argv.slice(2);
const jsonOut = rest[0] === '--json' ? rest[1] : undefined;

function short(value) {
  if (value === undefined) return '(absent)';
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function diff(a, b, at, out) {
  if (Object.is(a, b)) return;
  const bothObjects = a && b && typeof a === 'object' && typeof b === 'object';
  if (bothObjects && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const next = Array.isArray(a) ? `${at}[${key}]` : `${at}.${key}`;
      diff(a[key], b[key], next, out);
    }
    return;
  }
  out.push(`${at}: ${short(a)} -> ${short(b)}`);
}

function recordedFiles(dir) {
  const recorded = path.join(dir, 'recorded');
  if (!fs.existsSync(recorded)) return new Map();
  return new Map(
    fs
      .readdirSync(recorded)
      .filter((name) => name.endsWith('.json'))
      .map((name) => [name, path.join(recorded, name)])
  );
}

const scenarios = fs
  .readdirSync(after, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const report = {};
let total = 0;
for (const scenario of scenarios) {
  const left = recordedFiles(path.join(before, scenario));
  const right = recordedFiles(path.join(after, scenario));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const lines = [];
  for (const name of names) {
    if (!left.has(name) || !right.has(name)) {
      lines.push(`${name}: ${left.has(name) ? 'only before' : 'only after'}`);
      continue;
    }
    const out = [];
    diff(
      JSON.parse(fs.readFileSync(left.get(name), 'utf8')),
      JSON.parse(fs.readFileSync(right.get(name), 'utf8')),
      '$',
      out
    );
    for (const line of out) lines.push(`${name} ${line}`);
  }
  report[scenario] = lines;
  total += lines.length;
  console.log(`${scenario}: ${lines.length === 0 ? 'identical' : `${lines.length} difference(s)`}`);
  for (const line of lines.slice(0, 40)) console.log(`  ${line}`);
  if (lines.length > 40) console.log(`  ... ${lines.length - 40} more`);
}
console.log(`total differences: ${total}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
