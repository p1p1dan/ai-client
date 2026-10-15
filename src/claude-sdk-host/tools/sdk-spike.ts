// Route-B spike: one streaming-input query() against the local fake gateway.
// Usage: node tools/sdk-spike.ts <gatewayUrl> <cwd> <prompt>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const [gatewayUrl, cwd, prompt] = process.argv.slice(2);
if (!gatewayUrl || !cwd || !prompt)
  throw new Error('usage: sdk-spike.ts <gatewayUrl> <cwd> <prompt>');

const configDir = mkdtempSync(join(tmpdir(), 'pilab-cc-config-'));
const KEEP = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'PROGRAMFILES',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'SystemDrive',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'TERM',
];
const env: Record<string, string> = {};
const keep = new Set(KEEP.map((k) => k.toUpperCase()));
for (const [k, v] of Object.entries(process.env))
  if (v !== undefined && keep.has(k.toUpperCase())) env[k] = v;
if (process.env.SPIKE_GIT_BASH) env.CLAUDE_CODE_GIT_BASH_PATH = process.env.SPIKE_GIT_BASH;
Object.assign(env, {
  CLAUDE_CONFIG_DIR: configDir,
  ANTHROPIC_BASE_URL: gatewayUrl,
  ANTHROPIC_API_KEY: process.env.SPIKE_API_KEY ?? 'sk-fake-proto-key',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_AGENT_SDK_CLIENT_APP: 'pilab-proto/0.0.0',
});

let push: (m: SDKUserMessage) => void = () => {};
let end: () => void = () => {};
const queue: SDKUserMessage[] = [];
let ended = false;
let wake: (() => void) | null = null;
push = (m) => {
  queue.push(m);
  wake?.();
};
end = () => {
  ended = true;
  wake?.();
};
async function* input(): AsyncGenerator<SDKUserMessage> {
  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (ended) return;
    await new Promise<void>((r) => {
      wake = r;
    });
    wake = null;
  }
}

const t0 = Date.now();
const q = query({
  prompt: input(),
  options: {
    cwd,
    env,
    model: 'claude-opus-5-5',
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: 'You are running inside PiLab (prototype).',
    },
    tools: { type: 'preset', preset: 'claude_code' },
    settingSources: [],
    permissionMode: 'default',
    includePartialMessages: true,
    canUseTool: async (toolName, toolInput, opts) => {
      console.log(
        `[canUseTool] ${toolName} ${JSON.stringify(toolInput).slice(0, 200)} id=${opts.toolUseID}`
      );
      return { behavior: 'allow', updatedInput: toolInput };
    },
    stderr: (line) => console.log(`[stderr] ${line.trimEnd()}`),
  },
});
push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
for await (const m of q) {
  const dt = Date.now() - t0;
  if (m.type === 'stream_event') {
    const e = m.event as {
      type: string;
      delta?: { type: string };
      content_block?: { type: string };
    };
    console.log(`${dt}ms stream_event ${e.type} ${e.delta?.type ?? e.content_block?.type ?? ''}`);
  } else if (m.type === 'system') {
    const s = m as {
      subtype: string;
      tools?: string[];
      model?: string;
      apiKeySource?: string;
      claude_code_version?: string;
      permissionMode?: string;
      capabilities?: string[];
    };
    console.log(
      `${dt}ms system/${s.subtype}`,
      s.subtype === 'init'
        ? JSON.stringify({
            tools: s.tools,
            model: s.model,
            apiKeySource: s.apiKeySource,
            v: s.claude_code_version,
            pm: s.permissionMode,
            caps: s.capabilities,
          })
        : ''
    );
  } else if (m.type === 'result') {
    console.log(
      `${dt}ms result`,
      JSON.stringify({
        subtype: m.subtype,
        is_error: m.is_error,
        usage: m.usage,
        modelUsage: m.modelUsage,
        cost: m.total_cost_usd,
      }).slice(0, 1500)
    );
    end();
  } else {
    console.log(`${dt}ms ${m.type}`, JSON.stringify(m).slice(0, 600));
  }
}
console.log('done; configDir', configDir);
