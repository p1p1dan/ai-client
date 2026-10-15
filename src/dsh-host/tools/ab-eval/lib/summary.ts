/**
 * The comparison report (docs/agent-project-engineering.md §10, §13): per
 * case × arm, pass rates with their 95% interval, mean ± sample standard
 * deviation and the spread (median, min–max) of every counter over the runs,
 * paired differences against a baseline arm (per case and overall), check pass
 * rates, the cost columns next to the quality ones, the failing runs with
 * their tags, and the stamp of what ran. Several suite directories merge into
 * one report; arms are then prefixed with each suite's label.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VersionStamp } from './stamp.ts';
import { fmt, kilo, meanSd, meanSdKilo, spread } from './stats.ts';
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
  /** Every later continuation (`--resume`), with the harness version it ran. */
  resumes?: Array<{ at: string; runs: number; harness: VersionStamp['harness'] }>;
  /** Where the cases came from, so `--resume` can find them again (local paths). */
  casePaths?: string[];
  caseFilter?: string[];
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

/** Wilson score interval (95%) for `k` passes out of `n`, as fractions. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const z2 = z * z;
  const center = (k + z2 / 2) / (n + z2);
  const half = (z * Math.sqrt((k * (n - k)) / n + z2 / 4)) / (n + z2);
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** `2/3 · 67%（21–94%）`: passes, rate, and its 95% interval. */
export function passCell(records: readonly RunRecord[]): string {
  const n = records.length;
  if (n === 0) return '—';
  const k = records.filter((record) => record.passed).length;
  const [low, high] = wilson(k, n);
  return `${k}/${n} · ${fmt((100 * k) / n, 0)}%（${fmt(100 * low, 0)}–${fmt(100 * high, 0)}%）`;
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

const values = (records: readonly RunRecord[], pick: (record: RunRecord) => number | undefined) =>
  records.map(pick).filter((value): value is number => value !== undefined);

const failures = (record: RunRecord) => record.metrics.toolErrors + record.metrics.unknownToolCalls;
const seconds = (record: RunRecord) => record.metrics.durationMs / 1000;
const tokens = (record: RunRecord) => record.metrics.tokens.total;

function judged(records: readonly RunRecord[]): string {
  const scores = values(records, (record) => record.judge?.score);
  return scores.length > 0 ? meanSd(scores) : '—';
}

/** Cards the harness answered for PiLab (questions, plan reviews, ...); `—` when no record says. */
function cardsAnswered(records: readonly RunRecord[]): string {
  const tallies = records
    .map((record) => record.client.cardsAnswered as Record<string, number> | undefined)
    .filter((tally): tally is Record<string, number> => tally !== undefined);
  if (tallies.length === 0) return '—';
  const total = tallies.reduce(
    (sum, tally) => sum + Object.values(tally).reduce((a, b) => a + (Number(b) || 0), 0),
    0
  );
  const runs = tallies.filter((tally) =>
    Object.values(tally).some((count) => Number(count) > 0)
  ).length;
  return total === 0 ? '0' : `${total}（${runs} 次运行）`;
}

/** `median [min–max]`. */
function range(list: readonly number[], format: (value: number) => string = (v) => fmt(v)): string {
  const s = spread(list);
  if (!s) return '—';
  return s.n > 1 ? `${format(s.median)} [${format(s.min)}–${format(s.max)}]` : format(s.median);
}

function mean(
  records: readonly RunRecord[],
  pick: (record: RunRecord) => number
): number | undefined {
  return spread(records.map(pick))?.mean;
}

function passRate(records: readonly RunRecord[]): number | undefined {
  return records.length > 0
    ? (100 * records.filter((record) => record.passed).length) / records.length
    : undefined;
}

function signed(value: number | undefined, format: (v: number) => string = (v) => fmt(v)): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${format(value)}`;
}

/** Per case both arms ran: arm minus baseline (absolute), and arm / baseline − 1 (relative). */
function caseDeltas(
  rows: readonly Row[],
  arm: string,
  baseline: string,
  pick: (records: readonly RunRecord[]) => number | undefined
): Array<{ caseId: string; abs: number; rel?: number }> {
  const out: Array<{ caseId: string; abs: number; rel?: number }> = [];
  for (const row of rows.filter((item) => item.arm === arm)) {
    const base = rows.find((item) => item.arm === baseline && item.caseId === row.caseId);
    if (!base) continue;
    const a = pick(row.records);
    const b = pick(base.records);
    if (a === undefined || b === undefined) continue;
    out.push({ caseId: row.caseId, abs: a - b, ...(b > 0 ? { rel: a / b - 1 } : {}) });
  }
  return out;
}

function average(list: readonly number[]): number | undefined {
  return list.length > 0 ? list.reduce((sum, value) => sum + value, 0) / list.length : undefined;
}

const percent = (value: number) => `${fmt(100 * value, 0)}%`;

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
  const armRecords = (arm: string) =>
    sortedRows.filter((row) => row.arm === arm).flatMap((row) => row.records);
  const out: string[] = ['# A/B 评测报告', ''];

  for (const suite of suites) {
    const m = suite.manifest;
    const s = m.stamp;
    out.push(
      `## 运行 ${m.suiteRunId}${merged ? `（标签 ${m.label}）` : ''}`,
      '',
      `- 时间：${m.startedAt} → ${m.finishedAt ?? '未结束'}`,
      `- 模型 / 档位：\`${m.model}\` / \`${m.effort}\`；每组重复 ${m.runs} 次（已记录 ${suite.records.length} 次运行）`,
      `- 网关：${m.gateway.kind === 'fake' ? '本机假网关（plan ab-eval）' : '真实网关'}（${m.gateway.id}）`,
      `- 用例集：${m.cases.length} 个用例，版本 \`${m.suiteVersion}\``,
      `- 版本：harness \`${s.harness.commit.slice(0, 12)}\`${s.harness.dirty ? `（有未提交改动，diff ${s.harness.dirtyDiffSha256 ?? '?'}）` : ''}，应用 ${s.appVersion}，DSH ${s.dsh['dsh-base'] ?? '?'}，Claude Code ${s.claudeCode ?? '未用'}，Claude Agent SDK ${s.claudeSdk?.sdk ? `${s.claudeSdk.sdk}（内带 CLI ${s.claudeSdk.cli ?? '?'}）` : '未装'}，Node ${s.node}，${s.platform}`,
      `- 臂：${m.arms.map((arm) => (arm.variant ? `\`${arm.id}\`（变体 sha256 ${arm.variant.sha256.slice(0, 12)}）` : `\`${arm.id}\``)).join('；')}`,
      ...(m.resumes && m.resumes.length > 0
        ? [
            `- 续跑 ${m.resumes.length} 次：${m.resumes.map((r) => `${r.at}（harness \`${r.harness.commit.slice(0, 12)}\`${r.harness.dirty ? '，有未提交改动' : ''}）`).join('；')}`,
          ]
        : []),
      ...(m.judge ? [`- LLM 评分：\`${m.judge.model}\`，${m.judge.version}`] : []),
      ...(m.outcome
        ? [
            `- 密钥泄漏扫描：${m.outcome.leakScan.clean ? '干净' : `**发现 ${m.outcome.leakScan.files.length} 个文件含密钥**`}`,
          ]
        : []),
      ''
    );
  }

  out.push(
    '## 总览（每臂，全部用例）',
    '',
    '离散度里混着用例之间的差别；看重复运行的波动请看「按用例 × 臂」与「多次运行的分布」。',
    '',
    table(
      [
        '臂',
        '通过（95% 区间）',
        '步数',
        '工具调用',
        '工具失败',
        '未知工具',
        '非零退出',
        '计费 token',
        '耗时 s',
        '改动行数',
        '评分',
        '自动应答',
      ],
      arms.map((arm) => {
        const records = armRecords(arm);
        return [
          arm,
          passCell(records),
          meanSd(values(records, (r) => r.metrics.steps)),
          meanSd(values(records, (r) => r.metrics.toolCalls)),
          meanSd(values(records, failures)),
          meanSd(values(records, (r) => r.metrics.unknownToolCalls)),
          meanSd(values(records, (r) => r.metrics.nonZeroExits)),
          meanSdKilo(values(records, tokens)),
          meanSd(values(records, seconds)),
          meanSd(values(records, (r) => r.metrics.changes.lines)),
          judged(records),
          cardsAnswered(records),
        ];
      })
    ),
    ''
  );

  const baseline = options.baseline ?? arms[0];
  const others = arms.filter((arm) => arm !== baseline);
  if (others.length > 0 && baseline) {
    const metrics = [
      { name: '通过率差（百分点）', pick: passRate, rel: false, digits: 0 },
      {
        name: '步数差',
        pick: (r: readonly RunRecord[]) => mean(r, (x) => x.metrics.steps),
        rel: false,
        digits: 1,
      },
      {
        name: '工具失败差',
        pick: (r: readonly RunRecord[]) => mean(r, failures),
        rel: false,
        digits: 1,
      },
      {
        name: '计费 token 差',
        pick: (r: readonly RunRecord[]) => mean(r, tokens),
        rel: true,
        digits: 0,
      },
      {
        name: '耗时差 s',
        pick: (r: readonly RunRecord[]) => mean(r, seconds),
        rel: true,
        digits: 1,
      },
    ];
    const deltaCell = (
      deltas: Array<{ abs: number; rel?: number }>,
      metric: (typeof metrics)[number]
    ) => {
      const abs = average(deltas.map((d) => d.abs));
      const format = metric.name.startsWith('计费') ? kilo : (v: number) => fmt(v, metric.digits);
      if (!metric.rel) return signed(abs, format);
      const rel = average(deltas.flatMap((d) => (d.rel === undefined ? [] : [d.rel])));
      return rel === undefined
        ? signed(abs, format)
        : `${signed(abs, format)}（${signed(rel, percent)}）`;
    };
    out.push(
      `## 相对基线 \`${baseline}\``,
      '',
      '逐个用例算「该臂均值 − 基线均值」，括号里是相对变化；汇总行是各用例差值的平均。',
      '',
      table(
        ['用例', '臂', ...metrics.map((metric) => metric.name)],
        others.flatMap((arm) => [
          ...caseIds.flatMap((caseId) => {
            const per = metrics.map((metric) =>
              caseDeltas(sortedRows, arm, baseline, metric.pick).filter((d) => d.caseId === caseId)
            );
            if (per[0].length === 0) return [];
            return [[caseId, arm, ...per.map((deltas, i) => deltaCell(deltas, metrics[i]))]];
          }),
          [
            '**全部用例**',
            arm,
            ...metrics.map((metric) =>
              deltaCell(caseDeltas(sortedRows, arm, baseline, metric.pick), metric)
            ),
          ],
        ])
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
        '通过（95% 区间）',
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
          passCell(r),
          meanSd(values(r, (x) => x.metrics.steps)),
          meanSd(values(r, (x) => x.metrics.toolCalls)),
          meanSd(values(r, failures)),
          meanSd(values(r, (x) => x.metrics.unknownToolCalls)),
          meanSdKilo(values(r, (x) => x.metrics.tokens.input)),
          meanSdKilo(values(r, (x) => x.metrics.tokens.cacheRead)),
          meanSdKilo(values(r, (x) => x.metrics.tokens.cacheWrite)),
          meanSdKilo(values(r, (x) => x.metrics.tokens.output)),
          meanSd(values(r, seconds)),
          meanSd(values(r, (x) => x.metrics.changes.lines)),
          judged(r),
        ];
      })
    ),
    ''
  );

  out.push('## 多次运行的分布（中位数 [最小–最大]）', '');
  out.push(
    table(
      ['用例', '臂', 'n', '步数', '工具调用', '工具失败', '计费 token', '耗时 s', '改动行数'],
      sortedRows.map((row) => {
        const r = row.records;
        return [
          row.caseId,
          row.arm,
          String(r.length),
          range(values(r, (x) => x.metrics.steps)),
          range(values(r, (x) => x.metrics.toolCalls)),
          range(values(r, failures)),
          range(values(r, tokens), kilo),
          range(values(r, seconds)),
          range(values(r, (x) => x.metrics.changes.lines)),
        ];
      })
    ),
    ''
  );

  const all = rows.flatMap((row) => row.records);
  out.push('## 工具调用（每次运行的均值：调用 / 失败）', '');
  const used = CATEGORIES.filter((category) =>
    all.some((record) => (record.metrics.categories[category]?.calls ?? 0) > 0)
  );
  out.push(
    table(
      ['臂', ...used],
      arms.map((arm) => {
        const records = armRecords(arm);
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
    '- **通过**：客户端正常结束，且用例的全部确定性检查通过（命令退出码、必须 / 不得改动的路径、禁止 / 必须出现的模式）。括号里是 Wilson 95% 区间：重复次数少时区间很宽，两臂区间大幅重叠就不能说谁更好。',
    '- **步数**：主代理的模型调用次数（子代理另计）。PiLab 取 DSH 会话日志的 `assistant/message`，Claude Code 取不同的 assistant 消息 id。',
    '- **工具失败**：工具自己报错的次数加上调用了不存在的工具的次数；后者单列为 **未知工具**。',
    '- **非零退出**：shell 命令跑完了但退出码非零（例如修复前先跑一遍测试），不计入工具失败。',
    '- **计费 token**：客户端自己报告的用量之和（输入 + 缓存读 + 缓存写 + 输出）。PiLab 是 DSH 会话日志每一步 usage 之和（含子代理会话）；Claude Code 是 `result.modelUsage` 各模型之和（含辅助模型）。',
    '- **耗时**：从提交提示词到最终回复。PiLab 不含宿主启动（产品里宿主常驻）；Claude Code 取它自报的 `duration_ms`。',
    '- **改动行数**：相对基准提交（含用例 setup 的结果）的增删行数之和，含未提交与新建文件，不含忽略路径。',
    '- **自动应答**：无人值守时 PiLab 的模型发起的提问、计划审阅等卡片，由评测框架当场应答的次数（Claude Code 在 `-p` 模式下没有提问工具）。',
    '- 数值为均值 ± 样本标准差（n − 1）；n = 1 时只给均值。分布表给中位数与最小–最大值。',
    ''
  );
  return out.join('\n');
}
