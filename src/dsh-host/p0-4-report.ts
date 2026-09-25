/**
 * P0-4 report merger: node-side probe report + PowerShell-side facts -> one
 * JSON report and a short Chinese summary.
 *
 *   node.exe p0-4-report.ts --node <node-report.json> --ps <ps-side.json>
 *            --out <p0-4-report.json> --summary <p0-4-summary.txt>
 *
 * The PowerShell side (run-p0-4.ps1) is the non-whitelisted observer: it wrote
 * the marker files, read their first 16 bytes before the run (the premise),
 * head-checked every file the probe listed in `inspect[]`, and cleaned up.
 * Its JSON may carry a UTF-8 BOM (Windows PowerShell 5.1 writes one).
 */

import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const option = (name: string): string => {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined) {
    process.stderr.write(`[p0-4-report] --${name} is required\n`);
    process.exit(2);
  }
  return value;
};

const readJson = (file: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  } catch (error) {
    return { unreadable: `${file}: ${String(error)}` };
  }
};

interface Check {
  id: string;
  group: string;
  title: string;
  status: string;
  observed: string;
}
interface Head {
  path: string;
  role?: string;
  exists: boolean;
  isTsd: boolean;
  bytes?: number;
  ascii?: string;
}

const node = readJson(option('node'));
const ps = readJson(option('ps'));
const checks = (Array.isArray(node.checks) ? node.checks : []) as Check[];
const heads = (Array.isArray(ps.heads) ? ps.heads : []) as Head[];
const premise = (ps.premise ?? {}) as { allTsd?: boolean; psRead?: string; files?: Head[] };
const machine = (ps.machine ?? {}) as Record<string, unknown>;
const cleanupResult = (ps.cleanup ?? {}) as { failed?: unknown[]; kept?: boolean };

const LABEL: Record<string, string> = {
  pass: '通过',
  fail: '失败',
  skip: '跳过',
  info: '记录',
  error: '出错',
};
const GROUPS: Array<[string, string]> = [
  ['premise', '前提'],
  ['boot', '宿主启动与 NARB 原生缓存'],
  ['fs-sandbox-on', 'DSH 工具，沙箱开（workspace-write）'],
  ['fs-sandbox-off', 'DSH 工具，沙箱关（danger-full-access）'],
  ['fs-control', '官方 DSH Desktop 对照组（同一套 P0-FS 工具序列）'],
  ['session', '会话写入、写锁、恢复'],
  ['pty', 'node-pty / conpty'],
  ['spill', '%TEMP% spill'],
  ['plugin', 'pnpm 装插件'],
  ['subprocess', 'node.exe 直接起的 shell'],
  ['native', '原生模块'],
  ['probe', '探针自身'],
];

const counts: Record<string, number> = {};
for (const item of checks) counts[item.status] = (counts[item.status] ?? 0) + 1;
const premiseOk = premise.allTsd === true;

const lines: string[] = [];
lines.push(`P0-4 加密机上机结果  ${String(node.finishedAt ?? new Date().toISOString())}`);
lines.push('');
lines.push(
  `机器：${String(machine.os ?? '?')}；PowerShell ${String(machine.psVersion ?? '?')}；node.exe ${String(node.node ?? '?')}（${String(node.execPath ?? '?')}）`
);
lines.push(
  `应用目录：${String(machine.appDir ?? '?')}；加密目录：${String(machine.encDir ?? '?')}`
);
lines.push(
  premiseOk
    ? '前提：成立。PowerShell 写的标记文件在盘上是 TSD 容器，下面「明文」的结论有效。'
    : '前提：不成立！PowerShell 写的标记文件在盘上不是 TSD 容器（目录没被策略覆盖，或 PowerShell 也在白名单里）。下面所有「明文」结论都不能签收。'
);
if (premise.psRead !== undefined) {
  lines.push(`PowerShell 自己读标记文件看到：${premise.psRead}`);
}
lines.push(
  `合计：${Object.entries(LABEL)
    .map(([status, label]) => `${label} ${counts[status] ?? 0}`)
    .join('，')}`
);
lines.push('');

for (const [group, title] of GROUPS) {
  const rows = checks.filter((item) => item.group === group);
  if (rows.length === 0) continue;
  lines.push(`== ${title}`);
  for (const item of rows) {
    lines.push(
      `[${LABEL[item.status] ?? item.status}] ${item.id}  ${item.title} —— ${item.observed.slice(0, 140)}`
    );
  }
  lines.push('');
}
const other = checks.filter((item) => !GROUPS.some(([group]) => group === item.group));
for (const item of other) {
  lines.push(
    `[${LABEL[item.status] ?? item.status}] ${item.id}  ${item.title} —— ${item.observed.slice(0, 140)}`
  );
}

lines.push('== 盘上形态（PowerShell 读文件头 16 字节）');
for (const head of heads) {
  const state = !head.exists
    ? '已不存在'
    : head.isTsd
      ? 'TSD 容器'
      : `非 TSD（${head.ascii ?? ''}）`;
  lines.push(`${state}  ${head.role ?? ''}  ${head.path}`);
}
lines.push('');
const failed = cleanupResult.failed ?? [];
lines.push(
  cleanupResult.kept
    ? '清理：按 -KeepWork 保留了工作目录。'
    : failed.length === 0
      ? '清理：工作目录与临时目录已删除。'
      : `清理：有 ${failed.length} 项没删掉，见报告 powershell.cleanup.failed。`
);
lines.push('请把整个 report-* 目录发回（p0-4-report.json、p0-4-summary.txt、p0-4-probe.log）。');

const merged = {
  ...node,
  powershell: ps,
  summary: { counts, premiseOk },
};
writeFileSync(option('out'), `${JSON.stringify(merged, null, 2)}\n`);
writeFileSync(option('summary'), `\uFEFF${lines.join('\r\n')}\r\n`);
process.stdout.write(`${lines.join('\n')}\n`);
