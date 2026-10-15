/**
 * The comparison report (docs/agent-project-engineering.md §10, §13): per
 * case × arm, mean ± sample standard deviation of every counter, pass rates,
 * check pass rates, the cost columns next to the quality ones, the failing
 * runs with their tags, and the stamp of what ran. Several suite directories
 * merge into one report; arms are then prefixed with each suite's label.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VersionStamp } from './stamp.ts';
import { fmt, meanSd, meanSdKilo, spread } from './stats.ts';
import type { RunRecord, ToolCategory } from './types.ts';

export interface SuiteManifest {
  schema: 'ab-eval.suite/1';
  suiteRunId: string;
  label: string;
  startedAt: string;
  finishedAt?: string;
  model: string;
  effort: string;
  runs: number;
  gateway: { kind: 'fake' | 'real'; id: string };
  arms: Array<{
    id: string;
    client: string;
    variant?: { name: string; sha256: string; description?: string };
  }>;
  cases: Array<{ id: string; title?: string; tier?: string; sha256: string; repoSha256: string }>;
  suiteVersion: string;
  stamp: VersionStamp;
  judge?: { model: string; version: string; endpoint: 'gateway' | 'separate' };
  outcome?: { records: number; leakScan: { clean: boolean; files: string[] } };
}

export interface LoadedSuite {
  dir: string;
  manifest: SuiteManifest;
  records: RunRecord[];
}

export function loadSuite(dir: string): LoadedSuite {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as SuiteManifest;
  const file = join(dir, 'records.jsonl');
  const records = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunRecord)
    : [];
  return { dir, manifest, records };
}

const CATEGORIES: ToolCategory[] = [
  'read',
  'edit',
  'write',
  'shell',
  'search',
  'web',
  'subagent',
  'todo',
  'plan',
  'other',
];

interface Row {
  arm: string;
  caseId: string;
  records: RunRecord[];
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${fmt((100 * part) / whole, 0)}%` : '—';
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

const values = (records: RunRecord[], pick: (record: RunRecord) => number | undefined) =>
  records.map(pick).filter((value): value is number => value !== undefined);

function judged(records: RunRecord[]): string {
  const scores = values(records, (record) => record.judge?.score);
  return scores.length > 0 ? meanSd(scores) : '—';
}

/** Mean over cases of (arm mean − baseline mean), cases both arms ran only. */
function pairedDelta(
  rows: Row[],
  arm: string,
  baseline: string,
  pick: (records: RunRecord[]) => number | undefined
): number | undefined {
  const deltas: number[] = [];
  for (const row of rows.filter((item) => item.arm === arm)) {
    const base = rows.find((item) => item.arm === baseline && item.caseId === row.caseId);
    if (!base) continue;
    const a = pick(row.records);
    const b = pick(base.records);
    if (a !== undefined && b !== undefined) deltas.push(a - b);
  }
  return deltas.length > 0
    ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
    : undefined;
}

function mean(records: RunRecord[], pick: (record: RunRecord) => number): number | undefined {
  return spread(records.map(pick))?.mean;
}

export function renderReport(
  suites: readonly LoadedSuite[],
  options: { baseline?: string } = {}
): string {
  const merged = suites.length > 1;
  const armOf = (suite: LoadedSuite, record: RunRecord) =>
    merged ? `${suite.manifest.label}/${record.arm.id}` : record.arm.id;
  const arms: string[] = [];
  const caseIds: string[] = [];
  const rows: Row[] = [];
  for (const suite of suites) {
    for (const arm of suite.manifest.arms) {
      const id = merged ? `${suite.manifest.label}/${arm.id}` : arm.id;
      if (!arms.includes(id)) arms.push(id);
    }
    for (const c of suite.manifest.cases) if (!caseIds.includes(c.id)) caseIds.push(c.id);
    for (const record of suite.records) {
      const arm = armOf(suite, record);
      let row = rows.find((item) => item.arm === arm && item.caseId === record.case.id);
      if (!row) {
        row = { arm, caseId: record.case.id, records: [] };
        rows.push(row);
      }
      row.records.push(record);
    }
  }
  const sortedRows = caseIds.flatMap((caseId) =>
    arms.flatMap((arm) => rows.filter((row) => row.caseId === caseId && row.arm === arm))
  );
  const out: string[] = ['# A/B 评测报告', ''];

  for (const suite of suites) {
    const m = suite.manifest;
    const s = m.stamp;
    out.push(
      `## 运行 ${m.suiteRunId}${merged ? `（标签 ${m.label}）` : ''}`,
      '',
      `- 时间：${m.startedAt} → ${m.finishedAt ?? '未结束'}`,
      `- 模型 / 档位：\`${m.model}\` / \`${m.effort}\`；每组重复 ${m.runs} 次`,
      `- 网关：${m.gateway.kind === 'fake' ? '本机假网关（plan ab-eval）' : '真实网关'}（${m.gateway.id}）`,
      `- 用例集：${m.cases.length} 个用例，版本 \`${m.suiteVersion}\``,
      `- 版本：harness \`${s.harness.commit.slice(0, 12)}\`${s.harness.dirty ? `（有未提交改动，diff ${s.harness.dirtyDiffSha256 ?? '?'}）` : ''}，应用 ${s.appVersion}，DSH ${s.dsh['dsh-base'] ?? '?'}，Claude Code ${s.claudeCode ?? '未用'}，Node ${s.node}，${s.platform}`,
      `- 臂：${m.arms.map((arm) => (arm.variant ? `\`${arm.id}\`（变体 sha256 ${arm.variant.sha256.slice(0, 12)}）` : `\`${arm.id}\``)).join('；')}`,
      ...(m.judge ? [`- LLM 评分：\`${m.judge.model}\`，${m.judge.version}`] : []),
      ...(m.outcome
        ? [
            `- 密钥泄漏扫描：${m.outcome.leakScan.clean ? '干净' : `**发现 ${m.outcome.leakScan.files.length} 个文件含密钥**`}`,
          ]
        : []),
      ''
    );
  }

  const all = rows.flatMap((row) => row.records);
  out.push('## 总览（每臂，全部用例）', '');
  out.push(
    table(
      [
        '臂',
        '运行数',
        '通过率',
        '步数',
        '工具调用',
        '工具失败',
        '未知工具',
        '非零退出',
        '计费 token',
        '耗时 s',
        '改动行数',
        '评分',
      ],
      arms.map((arm) => {
        const records = rows.filter((row) => row.arm === arm).flatMap((row) => row.records);
        return [
          arm,
          String(records.length),
          pct(records.filter((record) => record.passed).length, records.length),
          meanSd(values(records, (r) => r.metrics.steps)),
          meanSd(values(records, (r) => r.metrics.toolCalls)),
          meanSd(values(records, (r) => r.metrics.toolErrors + r.metrics.unknownToolCalls)),
          meanSd(values(records, (r) => r.metrics.unknownToolCalls)),
          meanSd(values(records, (r) => r.metrics.nonZeroExits)),
          meanSdKilo(values(records, (r) => r.metrics.tokens.total)),
          meanSd(values(records, (r) => r.metrics.durationMs / 1000)),
          meanSd(values(records, (r) => r.metrics.changes.lines)),
          judged(records),
        ];
      })
    ),
    ''
  );

  const baseline = options.baseline ?? arms[0];
  if (arms.length > 1 && baseline) {
    out.push(`## 相对基线 \`${baseline}\`（按用例配对，取各用例差值的均值）`, '');
    out.push(
      table(
        ['臂', '通过率差（百分点）', '步数差', '工具调用差', '计费 token 差', '耗时差 s'],
        arms
          .filter((arm) => arm !== baseline)
          .map((arm) => {
            const d = (pick: (records: RunRecord[]) => number | undefined, digits = 1) => {
              const value = pairedDelta(sortedRows, arm, baseline, pick);
              return value === undefined ? '—' : `${value > 0 ? '+' : ''}${fmt(value, digits)}`;
            };
            return [
              arm,
              d((records) => (100 * records.filter((r) => r.passed).length) / records.length, 0),
              d((records) => mean(records, (r) => r.metrics.steps)),
              d((records) => mean(records, (r) => r.metrics.toolCalls)),
              d((records) => mean(records, (r) => r.metrics.tokens.total), 0),
              d((records) => mean(records, (r) => r.metrics.durationMs / 1000)),
            ];
          })
      ),
      ''
    );
  }

  out.push('## 按用例 × 臂（均值 ± 标准差）', '');
  out.push(
    table(
      [
        '用例',
        '臂',
        'n',
        '通过',
        '步数',
        '工具调用',
        '工具失败',
        '未知工具',
        '输入',
        '缓存读',
        '缓存写',
        '输出',
        '耗时 s',
        '改动行数',
        '评分',
      ],
      sortedRows.map((row) => {
        const r = row.records;
        return [
          row.caseId,
          row.arm,
          String(r.length),
          `${r.filter((x) => x.passed).length}/${r.length}`,
          meanSd(values(r, (x) => x.metrics.steps)),
          meanSd(values(r, (x) => x.metrics.toolCalls)),
          meanSd(values(r, (x) => x.metrics.toolErrors + x.metrics.unknownToolCalls)),
          meanSd(values(r, (x) => x.metrics.unknownToolCalls)),
          meanSdKilo(values(r, (x) => x.metrics.tokens.input)),
          meanSdKilo(values(r, (x) => x.metrics.tokens.cacheRead)),
          meanSdKilo(values(r, (x) => x.metrics.tokens.cacheWrite)),
          meanSdKilo(values(r, (x) => x.metrics.tokens.output)),
          meanSd(values(r, (x) => x.metrics.durationMs / 1000)),
          meanSd(values(r, (x) => x.metrics.changes.lines)),
          judged(r),
        ];
      })
    ),
    ''
  );

  out.push('## 工具调用（每次运行的均值：调用 / 失败）', '');
  const used = CATEGORIES.filter((category) =>
    all.some((record) => (record.metrics.categories[category]?.calls ?? 0) > 0)
  );
  out.push(
    table(
      ['臂', ...used],
      arms.map((arm) => {
        const records = sortedRows.filter((row) => row.arm === arm).flatMap((row) => row.records);
        return [
          arm,
          ...used.map((category) => {
            const calls = values(records, (r) => r.metrics.categories[category]?.calls ?? 0);
            const failed = values(records, (r) => {
              const tally = r.metrics.categories[category];
              return tally ? tally.errors + tally.unknown : 0;
            });
            return `${fmt(spread(calls)?.mean ?? 0)} / ${fmt(spread(failed)?.mean ?? 0)}`;
          }),
        ];
      })
    ),
    ''
  );

  const checkIds = (caseId: string) => [
    ...new Set(
      sortedRows
        .filter((row) => row.caseId === caseId)
        .flatMap((row) => row.records.flatMap((record) => record.checks.map((check) => check.id)))
    ),
  ];
  out.push('## 检查项通过次数', '');
  out.push(
    table(
      ['用例', '检查项', ...arms],
      caseIds.flatMap((caseId) =>
        checkIds(caseId).map((id) => [
          caseId,
          `\`${id}\``,
          ...arms.map((arm) => {
            const records =
              sortedRows.find((row) => row.caseId === caseId && row.arm === arm)?.records ?? [];
            const ran = records.filter((record) => record.checks.some((check) => check.id === id));
            const passed = ran.filter(
              (record) => record.checks.find((check) => check.id === id)?.passed
            );
            return ran.length > 0 ? `${passed.length}/${ran.length}` : '—';
          }),
        ])
      )
    ),
    ''
  );

  const failed = suites.flatMap((suite) =>
    suite.records.filter((record) => !record.passed).map((record) => ({ suite, record }))
  );
  out.push('## 未通过的运行', '');
  out.push(
    failed.length === 0
      ? '（无）'
      : table(
          ['用例', '臂', '第几次', '状态', '失败标签', '记录'],
          failed.map(({ suite, record }) => [
            record.case.id,
            armOf(suite, record),
            String(record.rep),
            record.status,
            record.failureTags.join(', '),
            `${merged ? `${suite.manifest.label}:` : ''}${record.artifacts.record ?? ''}`,
          ])
        ),
    ''
  );

  out.push(
    '## 口径',
    '',
    '- **通过**：客户端正常结束，且用例的全部确定性检查通过（命令退出码、必须改动 / 不得改动的路径、禁止 / 必须出现的模式）。',
    '- **步数**：主代理的模型调用次数（子代理另计）。PiLab 取 DSH 会话日志的 `assistant/message`，Claude Code 取不同的 assistant 消息 id。',
    '- **工具失败**：工具自己报错的次数加上调用了不存在的工具的次数；后者单列为 **未知工具**。',
    '- **非零退出**：shell 命令跑完了但退出码非零（例如修复前先跑一遍测试），不计入工具失败。',
    '- **计费 token**：客户端自己报告的用量之和（输入 + 缓存读 + 缓存写 + 输出）。PiLab 是 DSH 会话日志每一步 usage 之和（含子代理会话）；Claude Code 是 `result.modelUsage` 各模型之和（含辅助模型）。',
    '- **耗时**：从提交提示词到最终回复。PiLab 不含宿主启动（产品里宿主常驻）；Claude Code 取它自报的 `duration_ms`。',
    '- **改动行数**：相对基准提交的增删行数之和，含未提交与新建文件，不含忽略路径。',
    '- 数值为均值 ± 样本标准差（n − 1）；n = 1 时只给均值。',
    ''
  );
  return out.join('\n');
}
