/**
 * Rebuilds the comparison report from one or more suite directories
 * (tools/ab-eval/README.md). One directory: its report.md is rewritten. Several
 * (e.g. the same suite before and after a gateway change, or a variant run
 * apart): one merged report, arms prefixed with each suite's label.
 *
 *   node src/dsh-host/tools/ab-eval/report.ts <suite dir>... [--out <file>] [--baseline <arm>]
 */

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadSuite, renderReport } from './lib/summary.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    baseline: { type: 'string' },
  },
});

if (positionals.length === 0) {
  process.stderr.write('usage: node report.ts <suite dir>... [--out <file>] [--baseline <arm>]\n');
  process.exit(2);
}
const suites = positionals.map((dir) => loadSuite(resolve(dir)));
const text = renderReport(suites, values.baseline ? { baseline: values.baseline } : {});
const out = values.out
  ? resolve(values.out)
  : suites.length === 1
    ? join(suites[0].dir, 'report.md')
    : undefined;
if (out) {
  writeFileSync(out, text);
  process.stdout.write(`report: ${out}\n`);
} else {
  process.stdout.write(text);
}
