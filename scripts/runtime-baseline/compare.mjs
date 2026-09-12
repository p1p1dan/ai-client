/**
 * P2-6 — the old/new comparison report.
 *
 * Takes two collections of the SAME suite and prints what actually differs.
 * It refuses to compare archives that are not comparable rather than printing a
 * delta with a footnote, because a cache hit rate is mostly a property of the
 * gateway: a legacy number from one gateway next to a native number from
 * another looks like a runtime result and is not one.
 *
 *   node scripts/runtime-baseline/compare.mjs --legacy DIR --native DIR \
 *     [--archive DIR] [--gate 0.9501] [--out report.md]
 *
 * `--archive` is the historical P2-0 baseline. It is reported for context and
 * explicitly NOT used as the pass/fail comparison when its gateway differs.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    legacy: { type: 'string' },
    native: { type: 'string' },
    archive: { type: 'string' },
    gate: { type: 'string', default: '0.9501' },
    out: { type: 'string' },
  },
});
assert(values.legacy && values.native, '--legacy and --native are required');
const gate = Number(values.gate);

const read = (dir) => {
  const root = resolve(dir);
  const load = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));
  return { root, manifest: load('manifest.json'), summary: load('summary.json') };
};
const legacy = read(values.legacy);
const native = read(values.native);
const archive = values.archive ? read(values.archive) : null;

for (const side of [legacy, native]) {
  assert(side.summary.validBaseline, `${side.root} is not a complete valid collection`);
}
assert.equal(legacy.manifest.backend, 'legacy', 'The --legacy archive is not a legacy collection');
assert.equal(native.manifest.backend, 'native', 'The --native archive is not a native collection');

// Comparability, checked rather than assumed. Every field here would silently
// change the number being compared.
const mustMatch = ['suiteVersion', 'suiteSha256', 'baseUrl', 'work'];
for (const field of mustMatch) {
  assert.equal(
    legacy.manifest[field],
    native.manifest[field],
    `Not comparable: ${field} differs (${legacy.manifest[field]} vs ${native.manifest[field]})`
  );
}
assert.deepEqual(legacy.manifest.model, native.manifest.model, 'Not comparable: model row differs');
assert.deepEqual(
  legacy.manifest.settings,
  native.manifest.settings,
  'Not comparable: suite settings differ'
);
// The native side must have DECLARED where it cannot honour a baseline setting.
assert(
  native.manifest.settingDeviations && Object.keys(native.manifest.settingDeviations).length > 0,
  'The native manifest declares no setting deviations; refusing to imply exact parity'
);

const percent = (value) =>
  value === null || value === undefined ? '不可测' : `${(value * 100).toFixed(2)}%`;
const points = (a, b) =>
  a === null || b === null
    ? '—'
    : `${((a - b) * 100 >= 0 ? '+' : '') + ((a - b) * 100).toFixed(2)}`;
const caseOf = (side, id) => side.summary.results.find((item) => item.caseId === id);

const rows = legacy.manifest.caseOrder.map((id) => {
  const l = caseOf(legacy, id);
  const n = caseOf(native, id);
  assert(l && n, `Case ${id} missing from one side`);
  return { id, name: l.name, legacy: l, native: n };
});

const lines = [];
lines.push('# P2-6 · 同套会话新旧后端对比');
lines.push('');
lines.push(
  `套件 ${legacy.manifest.suiteVersion}（SHA-256 一致）· 模型 ${legacy.manifest.model.id} · 网关 ${legacy.manifest.baseUrl} · 工作目录 ${legacy.manifest.work}`
);
lines.push('');
lines.push(
  `依赖版本：legacy ${JSON.stringify(legacy.manifest.dependencies)}；native ${JSON.stringify(native.manifest.dependencies)}`
);
lines.push(
  `Node：legacy ${legacy.manifest.nodeVersion}；native ${native.manifest.nodeVersion}。git HEAD：legacy ${legacy.manifest.gitHead}；native ${native.manifest.gitHead}`
);
lines.push('');
lines.push('## 逐场景命中率');
lines.push('');
lines.push(
  '| 场景 | 后端 | 模型调用 | 工具调用 | input | cacheRead | cacheWrite | 命中率 | 差（百分点） |'
);
lines.push('|---|---|---|---|---|---|---|---|---|');
for (const row of rows) {
  for (const [label, side] of [
    ['legacy', row.legacy],
    ['native', row.native],
  ]) {
    lines.push(
      `| ${row.id} ${row.name} | ${label} | ${side.usage.calls} | ${side.toolCalls} | ${side.usage.input} | ${side.usage.cacheRead} | ${side.usage.cacheWrite} | ${percent(side.usage.cacheHitRate)} | ${
        label === 'native'
          ? points(row.native.usage.cacheHitRate, row.legacy.usage.cacheHitRate)
          : ''
      } |`
    );
  }
}
lines.push('');
lines.push('## 整套合计');
lines.push('');
lines.push('| 后端 | 模型调用 | input | cacheRead | cacheWrite | 命中率 |');
lines.push('|---|---|---|---|---|---|');
for (const [label, side] of [
  ['legacy（同网关重采）', legacy],
  ['native', native],
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
const legacyRate = legacy.summary.usage.cacheHitRate;
lines.push(
  `native 相对同网关 legacy：${points(nativeRate, legacyRate)} 百分点。门禁阈值 ${percent(gate)}：native ${nativeRate >= gate ? '达标' : '未达标'}，legacy ${legacyRate >= gate ? '达标' : '未达标'}。`
);
if (archive && archive.manifest.baseUrl !== native.manifest.baseUrl) {
  lines.push('');
  lines.push(
    `历史归档使用的网关是 ${archive.manifest.baseUrl}，与本次不同，因此它的 ${percent(archive.summary.usage.cacheHitRate)} 只作参考，不作为本次对比的基准；本次的可比基准是同网关重采的 legacy 结果。`
  );
}
lines.push('');
lines.push('## 压缩摘要调用（不计入门禁分母）');
lines.push('');
lines.push('| 后端 | 调用 | input | cacheRead | cacheWrite |');
lines.push('|---|---|---|---|---|');
for (const [label, side] of [
  ['legacy', legacy],
  ['native', native],
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
