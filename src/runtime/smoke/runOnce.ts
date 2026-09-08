/**
 * P0-6 - the non-UI run entry point (`docs/agent-project-engineering.md` §1).
 *
 * One command, no Electron, no renderer, scriptable in batch and callable by
 * another agent:
 *
 *   node --experimental-strip-types smoke/runOnce.ts --offline
 *   node --experimental-strip-types smoke/runOnce.ts --model <provider>/<id>
 *
 * ## The two lanes, and why both exist
 *
 * `--offline` swaps pi-ai's own `fauxProvider()` in for the network. It proves
 * the plugin graph comes up, that `Agent` drives a turn to completion, that the
 * event fold produces the text, and that the trace lands - deterministically,
 * with no credentials, so it can run in CI and on a developer box that has
 * never logged in. What it CANNOT prove is that a real endpoint answers.
 *
 * The live lane is the one that closes ARD risk R1. It needs `models.json` /
 * `auth.json` from a logged-in install, which is why it is not the default: a
 * smoke command whose normal outcome is "no credentials" trains people to
 * ignore it.
 *
 * Both lanes write the same trace shape and run the same assertions, so a live
 * failure can be diffed against the offline run that passed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRuntime } from '../bootstrap.ts';
import { RuntimeConfigError, type RuntimeModelRef } from '../contracts.ts';
import { standaloneHost } from '../host/config.ts';
import { evaluateCase, type SmokeCase } from './assertions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface CliOptions {
  offline: boolean;
  casePath: string;
  model?: RuntimeModelRef;
  agentDir?: string;
  traceDir?: string;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const offline = argv.includes('--offline');
  const options: CliOptions = {
    offline,
    casePath: join(HERE, 'cases', offline ? 'p0-single-turn-offline.json' : 'p0-single-turn.json'),
    json: argv.includes('--json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case '--case':
        if (value) options.casePath = resolve(value);
        break;
      case '--model':
        if (value) options.model = parseModelRef(value);
        break;
      case '--agent-dir':
        if (value) options.agentDir = resolve(value);
        break;
      case '--trace-dir':
        if (value) options.traceDir = resolve(value);
        break;
    }
  }
  return options;
}

/** `provider/model-id`; the id itself may contain slashes, so only the first splits. */
function parseModelRef(raw: string): RuntimeModelRef {
  const separator = raw.indexOf('/');
  if (separator <= 0 || separator === raw.length - 1) {
    throw new RuntimeConfigError(
      'bad_model_ref',
      `--model expects "<provider>/<id>", got "${raw}"`
    );
  }
  return { provider: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const smokeCase = JSON.parse(readFileSync(options.casePath, 'utf8')) as SmokeCase;

  const providers = options.offline ? [buildFauxProvider(smokeCase)] : undefined;
  const runtime = await createRuntime({
    host: standaloneHost({}),
    ...(providers ? { providers } : {}),
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    ...(options.traceDir ? { traceDir: options.traceDir } : {}),
  });

  // Tool calls are collected from the raw event stream rather than assumed
  // absent: "P0 registers no tools" is the claim under test, so the assertion
  // has to read what the loop actually did.
  const toolsCalled: string[] = [];
  try {
    const result = await runtime.run({
      prompt: smokeCase.input,
      systemPrompt: smokeCase.system_prompt,
      ...(options.model ? { model: options.model } : {}),
      onEvent: (event) => {
        if (event.type === 'tool_execution_start') toolsCalled.push(event.toolName);
      },
    });
    const report = evaluateCase(smokeCase, result, toolsCalled);
    if (options.json) {
      console.log(JSON.stringify({ report, result: { ...result, trace: result.trace } }, null, 2));
    } else {
      printHuman(smokeCase, result.text, report, result.latencyMs, runtime.trace.dir);
    }
    return report.passed ? 0 : 1;
  } finally {
    await runtime.dispose();
  }
}

function buildFauxProvider(smokeCase: SmokeCase) {
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-p0', name: 'Faux P0 probe', contextWindow: 128_000, maxTokens: 4_096 }],
    // Streamed in small pieces on purpose: a single-chunk reply would not
    // exercise the incremental path the live lane always takes.
    tokensPerSecond: 400,
  });
  faux.setResponses([fauxAssistantMessage(smokeCase.scripted_output ?? 'ready')]);
  return faux.provider;
}

function printHuman(
  smokeCase: SmokeCase,
  text: string,
  report: ReturnType<typeof evaluateCase>,
  latencyMs: number,
  traceDir: string | null
): void {
  console.log(`case      ${smokeCase.case_id} (${smokeCase.lane})`);
  console.log(`output    ${JSON.stringify(text)}`);
  console.log(`latency   ${latencyMs} ms`);
  console.log(`trace     ${traceDir ? join(traceDir, 'runs.jsonl') : '(memory only)'}`);
  for (const outcome of report.outcomes) {
    const mark = outcome.passed ? 'PASS' : 'FAIL';
    console.log(
      `  ${mark}  ${outcome.name}  expected=${JSON.stringify(outcome.expected)} actual=${JSON.stringify(outcome.actual)}`
    );
  }
  console.log(report.passed ? 'RESULT    pass' : 'RESULT    fail');
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof RuntimeConfigError) {
      // A setup problem, not a run outcome: no trace was produced, so say what
      // to fix rather than printing a stack the operator cannot act on.
      console.error(`setup error [${error.code}] ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(error);
    process.exitCode = 3;
  });
