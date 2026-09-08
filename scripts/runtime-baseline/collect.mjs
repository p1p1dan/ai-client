import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { summarizeUsage } from './metrics.mjs';
import { suite } from './suite.mjs';

assert(process.argv[2] && process.argv[3], 'Usage: node collect.mjs EVIDENCE_DIR NEW_OUTPUT_DIR');
const root = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
assert(!existsSync(out), 'Use a new output directory');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const comparable = (manifest) => ({
  backend: manifest.backend,
  entry: manifest.entry,
  dependencies: manifest.dependencies,
  baseUrl: manifest.baseUrl,
  provider: manifest.provider,
  model: manifest.model,
  settings: manifest.settings,
  work: manifest.work,
  files: Object.fromEntries(
    Object.entries(manifest.files).filter(([file]) => file !== 'scripts/runtime-baseline/suite.mjs')
  ),
});
const runs = readdirSync(root)
  .filter((name) => existsSync(join(root, name, 'manifest.json')))
  .map((name) => ({
    name,
    path: join(root, name),
    manifest: json(join(root, name, 'manifest.json')),
    suite: json(join(root, name, 'suite.json')),
  }))
  .filter((run) => !run.manifest.sourceRuns)
  .sort((a, b) => a.manifest.startedAt.localeCompare(b.manifest.startedAt));
const reference = runs.find((run) => run.manifest.suiteVersion === suite.version)?.manifest;
assert(reference, 'No run for the current suite');
const eligibleRuns = runs.filter((run) =>
  isDeepStrictEqual(comparable(run.manifest), comparable(reference))
);
for (const run of runs) {
  assert.equal(hash(readFileSync(join(run.path, 'suite.json'))), run.manifest.suiteSha256);
}
const selections = suite.cases.map((testCase) => {
  const run = eligibleRuns.find((candidate) => {
    const result = join(candidate.path, testCase.id, 'result.json');
    const sourceCase = candidate.suite.cases.find((item) => item.id === testCase.id);
    return isDeepStrictEqual(sourceCase, testCase) && existsSync(result) && json(result).passed;
  });
  assert(run, `No complete successful ${testCase.id}; run this case before collecting`);
  return { caseId: testCase.id, run };
});
mkdirSync(out, { recursive: true });
const sourceRuns = selections.map(({ caseId, run }) => ({
  caseId,
  run: run.name,
  startedAt: run.manifest.startedAt,
  suiteVersion: run.manifest.suiteVersion,
  caseSha256: hash(JSON.stringify(suite.cases.find((item) => item.id === caseId))),
}));
save('manifest.json', {
  ...reference,
  suiteVersion: suite.version,
  suiteSha256: hash(`${JSON.stringify(suite, null, 2)}\n`),
  caseOrder: suite.cases.map((item) => item.id),
  sourceRuns,
  selection:
    'First complete success per case, ordered by run startedAt; failures retained separately',
  collectedAt: new Date().toISOString(),
});
save('suite.json', suite);
const results = [];
const usage = [];
for (const { caseId, run } of selections) {
  const sourceDir = join(out, 'sources', run.name);
  mkdirSync(sourceDir, { recursive: true });
  cpSync(join(run.path, 'manifest.json'), join(sourceDir, 'manifest.json'));
  cpSync(join(run.path, 'suite.json'), join(sourceDir, 'suite.json'));
  cpSync(join(run.path, caseId), join(out, caseId), { recursive: true });
  results.push(json(join(out, caseId, 'result.json')));
  usage.push(
    ...readFileSync(join(out, caseId, 'usage.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  );
}
const attempts = runs.flatMap((run) =>
  suite.cases.flatMap((testCase) => {
    const file = join(run.path, testCase.id, 'result.json');
    if (!existsSync(file)) return [];
    const result = json(file);
    return [
      {
        caseId: testCase.id,
        run: run.name,
        passed: result.passed,
        error: result.error,
        compatible:
          eligibleRuns.includes(run) &&
          isDeepStrictEqual(
            run.suite.cases.find((item) => item.id === testCase.id),
            testCase
          ),
        selected: sourceRuns.some((item) => item.caseId === testCase.id && item.run === run.name),
      },
    ];
  })
);
const summary = {
  schemaVersion: 1,
  validBaseline: true,
  suiteVersion: suite.version,
  completedAt: new Date().toISOString(),
  results,
  attempts,
  pricing: null,
  usage: summarizeUsage(usage),
  compactionUsage: summarizeUsage(usage, 'compaction'),
};
save('summary.json', summary);
try {
  const verification = execFileSync(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'verify.mjs'), out],
    { encoding: 'utf8' }
  );
  save('verification.json', JSON.parse(verification));
} catch (error) {
  save('summary.json', { ...summary, validBaseline: false });
  throw error;
}
const rate = (value) => `${(value * 100).toFixed(2)}%`;
writeFileSync(
  join(out, 'report.md'),
  `# P2-0 旧后端正式基线\n\n六个独立固定会话已通过原始 JSONL 和 trace 复核。模型：${suite.model.id}；suite：${suite.version}。\n\n` +
    `整体 token 加权命中率：**${rate(summary.usage.cacheHitRate)}**。费用未知。\n\n` +
    '| 场景 | 模型调用 | input | cacheRead | cacheWrite | 命中率 | 首次成功来源 |\n|---|---|---|---|---|---|---|\n' +
    results
      .map(
        (result) =>
          `| ${result.caseId} ${result.name} | ${result.usage.calls} | ${result.usage.input} | ${result.usage.cacheRead} | ${result.usage.cacheWrite} | ${rate(result.usage.cacheHitRate)} | ${sourceRuns.find((source) => source.caseId === result.caseId).run} |`
      )
      .join('\n') +
    `\n\n压缩摘要：${summary.compactionUsage.calls} 次调用，input=${summary.compactionUsage.input}，cacheRead=${summary.compactionUsage.cacheRead}，cacheWrite=${summary.compactionUsage.cacheWrite}，单独统计，不混入门禁。\n\n` +
    `本基线按逐场景输入字节与运行配置一致性筛选后，选取各场景首次完整成功记录，未按命中率筛选。已记录场景尝试 ${attempts.length} 次，其中失败 ${attempts.filter((item) => !item.passed).length} 次；包括修订前样本失败，详见 summary.json 的 attempts/compatible。来源 suite 版本及逐场景哈希见 manifest.json；未变场景可复用旧 suite，变更场景必须重采。\n\n` +
    'provider 缓存由网关管理，首次轮全部计入，不保证冷缓存。手工压缩使用固定测试参数，不覆盖自动阈值；本结果仅为指定模型和套件的一组基线。P2-6 还需处理新旧 Pi 协议依赖版本差异。\n'
);
console.log(
  JSON.stringify({ output: out, verified: true, usage: summary.usage, sourceRuns }, null, 2)
);
