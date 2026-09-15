/**
 * P2-6 — the comparison report for two collections of the same suite.
 *
 * It refuses to compare archives that are not comparable rather than printing a
 * delta with a footnote, because a cache hit rate is mostly a property of the
 * gateway: a number from one gateway next to a number from another looks like a
 * runtime result and is not one. The rules themselves live in `archive.mjs`, so
 * they can be exercised without two real collections on disk.
 *
 *   node scripts/runtime-baseline/compare.mjs --baseline DIR --native DIR \
 *     [--archive DIR] [--gate 0.9501] [--out report.md]
 *
 * ## The legacy side, and what happens now that it cannot be collected
 *
 * `--legacy` still works and still means "this reference archive must be a
 * legacy collection" — the two that exist are re-readable forever. But the
 * collector that produced them (`run.mjs`) was deleted with the engine it drove
 * on 2026-09-13 (P6-5), so no new one can be made. `--baseline` is the form to
 * use from here: any archive of either backend as the reference, which in
 * practice means native-vs-native, a pinned earlier run against a fresh one.
 * Passing neither is an error that says this rather than a missing-argument
 * complaint (audit gap P2-5/P2-6, T028).
 *
 * `--archive` is the historical P2-0 baseline. It is reported for context and
 * explicitly NOT used as the pass/fail comparison when its gateway differs.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { archiveGeneration, comparabilityReport, readArchive } from './archive.mjs';

const { values } = parseArgs({
  options: {
    legacy: { type: 'string' },
    baseline: { type: 'string' },
    native: { type: 'string' },
    archive: { type: 'string' },
    gate: { type: 'string', default: '0.9501' },
    out: { type: 'string' },
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!values.native) fail('--native is required: the collection being judged');
if (values.legacy && values.baseline) fail('Pass either --legacy or --baseline, not both');
if (!values.legacy && !values.baseline) {
  fail(
    [
      'A reference archive is required: --baseline DIR (any backend) or --legacy DIR.',
      '',
      'There is no legacy collector any more — scripts/runtime-baseline/run.mjs was deleted',
      'with the engine it drove on 2026-09-13 (P6-5). The two legacy archives under',
      'docs/plantree/plans/runtime-evolution/evidence/{p2-0,p2-5} can still be read and passed',
      'to --legacy, but they cannot be re-measured. For a new comparison, pin an earlier native',
      'collection as --baseline and compare native against native.',
    ].join('\n')
  );
}
const gate = Number(values.gate);

const reference = readArchive(values.legacy ?? values.baseline);
const native = readArchive(values.native);
const archive = values.archive ? readArchive(values.archive) : null;
const referenceLabel = reference.manifest.backend === 'native' ? 'native（参考）' : 'legacy';

if (values.legacy && reference.manifest.backend !== 'legacy') {
  fail(
    `The --legacy archive is a ${String(reference.manifest.backend)} collection: ${reference.root}`
  );
}

const { failures, notes } = comparabilityReport(reference, native);
if (failures.length > 0) fail(failures.map((line) => `- ${line}`).join('\n'));

const percent = (value) =>
  value === null || value === undefined ? '不可测' : `${(value * 100).toFixed(2)}%`;
const points = (a, b) =>
  a === null || b === null
    ? '—'
    : `${((a - b) * 100 >= 0 ? '+' : '') + ((a - b) * 100).toFixed(2)}`;
const caseOf = (side, id) => side.summary.results.find((item) => item.caseId === id);

const rows = reference.manifest.caseOrder.map((id) => {
  const l = caseOf(reference, id);
  const n = caseOf(native, id);
  if (!l || !n) fail(`Case ${id} is missing from one side`);
  return { id, name: l.name, reference: l, native: n };
});

const lines = [];
lines.push('# P2-6 · 同套会话两份归档对比');
lines.push('');
lines.push(
  `套件 ${reference.manifest.suiteVersion}（SHA-256 一致）· 模型 ${reference.manifest.model.id} · 网关 ${reference.manifest.baseUrl} · 工作目录 ${reference.manifest.work}`
);
lines.push('');
lines.push(
  `参考归档：${referenceLabel} \`${reference.root}\`（分代 ${archiveGeneration(reference) ?? '未记录'}）；本次：native \`${native.root}\`（分代 ${archiveGeneration(native) ?? '未记录'}）`
);
lines.push('');
lines.push(
  `依赖版本：参考 ${JSON.stringify(reference.manifest.dependencies)}；本次 ${JSON.stringify(native.manifest.dependencies)}`
);
lines.push(
  `Node：参考 ${reference.manifest.nodeVersion}；本次 ${native.manifest.nodeVersion}。git HEAD：参考 ${reference.manifest.gitHead}；本次 ${native.manifest.gitHead}`
);
for (const note of notes) {
  lines.push('');
  lines.push(`> ${note}`);
}
lines.push('');
lines.push('## 逐场景命中率');
lines.push('');
lines.push(
  '| 场景 | 归档 | 模型调用 | 工具调用 | input | cacheRead | cacheWrite | 命中率 | 差（百分点） |'
);
lines.push('|---|---|---|---|---|---|---|---|---|');
for (const row of rows) {
  for (const [label, side] of [
    [referenceLabel, row.reference],
    ['native（本次）', row.native],
  ]) {
    lines.push(
      `| ${row.id} ${row.name} | ${label} | ${side.usage.calls} | ${side.toolCalls} | ${side.usage.input} | ${side.usage.cacheRead} | ${side.usage.cacheWrite} | ${percent(side.usage.cacheHitRate)} | ${
        side === row.native
          ? points(row.native.usage.cacheHitRate, row.reference.usage.cacheHitRate)
          : ''
      } |`
    );
  }
}
lines.push('');
lines.push('## 整套合计');
lines.push('');
lines.push('| 归档 | 模型调用 | input | cacheRead | cacheWrite | 命中率 |');
lines.push('|---|---|---|---|---|---|');
for (const [label, side] of [
  [`${referenceLabel}（同网关）`, reference],
  ['native（本次）', native],
]) {
  const u = side.summary.usage;
  lines.push(
    `| ${label} | ${u.calls} | ${u.input} | ${u.cacheRead} | ${u.cacheWrite} | ${percent(u.cacheHitRate)} |`
  );
}
if (archive) {
  const u = archive.summary.usage;
  lines.push(
    `| ${archive.manifest.backend}（历史归档，网关 ${archive.manifest.baseUrl}） | ${u.calls} | ${u.input} | ${u.cacheRead} | ${u.cacheWrite} | ${percent(u.cacheHitRate)} |`
  );
}
lines.push('');
const nativeRate = native.summary.usage.cacheHitRate;
const referenceRate = reference.summary.usage.cacheHitRate;
lines.push(
  `native 相对参考归档：${points(nativeRate, referenceRate)} 百分点。门禁阈值 ${percent(gate)}：本次 ${nativeRate >= gate ? '达标' : '未达标'}，参考 ${referenceRate >= gate ? '达标' : '未达标'}。`
);
if (archive && archive.manifest.baseUrl !== native.manifest.baseUrl) {
  lines.push('');
  lines.push(
    `历史归档使用的网关是 ${archive.manifest.baseUrl}，与本次不同，因此它的 ${percent(archive.summary.usage.cacheHitRate)} 只作参考，不作为本次对比的基准；本次的可比基准是同网关的参考归档。`
  );
}
lines.push('');
lines.push('## 压缩摘要调用（不计入门禁分母）');
lines.push('');
lines.push('| 归档 | 调用 | input | cacheRead | cacheWrite |');
lines.push('|---|---|---|---|---|');
for (const [label, side] of [
  [referenceLabel, reference],
  ['native（本次）', native],
]) {
  const u = side.summary.compactionUsage;
  lines.push(`| ${label} | ${u.calls} | ${u.input} | ${u.cacheRead} | ${u.cacheWrite} |`);
}
lines.push('');
lines.push('## native 侧无法对齐的设置（采集时声明）');
lines.push('');
for (const [key, reason] of Object.entries(native.manifest.settingDeviations)) {
  lines.push(`- \`${key}\`：${reason}`);
}

const report = `${lines.join('\n')}\n`;
if (values.out) writeFileSync(resolve(values.out), report);
console.log(report);
if (nativeRate < gate) process.exitCode = 1;
