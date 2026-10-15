// Route-B spike: can the native CLI keep its own `Read` tool (name, schema,
// description) while the call executes in this Node process? Encrypted-machine
// alternative: file I/O in the bundled node.exe, the agent loop in claude.exe.
// Usage: node tools/alias-spike.ts <gatewayUrl> <cwd> <prompt>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  type SDKUserMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { buildCliEnvironment, findGitBash } from '../cliEnvironment.ts';

const [gatewayUrl, cwd, prompt] = process.argv.slice(2);
const configDir = mkdtempSync(join(tmpdir(), 'pilab-cc-alias-'));
const env = buildCliEnvironment({
  inherited: process.env,
  configDir,
  baseUrl: gatewayUrl,
  apiKey: 'sk-fake-alias-spike',
  clientApp: 'pilab-alias-spike/0',
  gitBashPath: findGitBash(process.env),
});
let carrierCalls = 0;
const carrier = createSdkMcpServer({
  name: 'pilab',
  version: '0.0.0',
  tools: [
    tool(
      'Read',
      'PiLab carrier read (should not be what the model sees if aliasing keeps the built-in).',
      { file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() },
      async (args) => {
        carrierCalls += 1;
        return { content: [{ type: 'text', text: `PILAB-CARRIER-READ ${args.file_path}` }] };
      }
    ),
  ],
});
const mode = process.env.ALIAS_MODE ?? 'alias';
let done: () => void = () => {};
async function* input(): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null };
  await new Promise<void>((resolve) => {
    done = resolve;
  });
}
const q = query({
  prompt: input(),
  options: {
    cwd,
    env,
    model: 'claude-opus-5-5',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    settingSources: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    mcpServers: { pilab: carrier },
    ...(mode === 'alias' ? { toolAliases: { Read: 'mcp__pilab__Read' } } : {}),
    ...(mode === 'disallow' ? { disallowedTools: ['Read'] } : {}),
  },
});
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init')
    console.log('init tools:', m.tools.filter((t) => /Read|pilab/.test(t)).join(','));
  if (m.type === 'user' && m.parent_tool_use_id === null) {
    const content = (m.message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; content?: unknown }>) {
        if (b.type === 'tool_result')
          console.log('tool_result:', JSON.stringify(b.content).slice(0, 160));
      }
    }
  }
  if (m.type === 'result') {
    console.log('result:', m.subtype, (m as { result?: string }).result?.slice(0, 200));
    done();
  }
}
console.log('carrier calls:', carrierCalls);
