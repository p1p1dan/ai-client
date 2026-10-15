// Prints the shape of captured model requests (fake-gateway --capture files):
// request parameters, beta headers, system / tool / message sizes, and each
// tool's description length and parameter names. Never prints prompt text, so
// the output can be kept as evidence; the capture files themselves hold full
// request content and stay in the scratch directory.
//
//   node compare-captures.mjs <capture-file.json> [<capture-file.json> ...]

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const textOf = (content) =>
  Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : String(content ?? '');

for (const file of process.argv.slice(2)) {
  const capture = JSON.parse(readFileSync(file, 'utf8'));
  const body = JSON.parse(capture.body);
  const { messages = [], system, tools = [], ...params } = body;
  const systemBlocks = Array.isArray(system) ? system : system ? [{ text: system }] : [];
  const systemMessages = messages.filter((m) => m.role === 'system' || m.role === 'developer');
  console.log(`\n## ${basename(file)}  ${capture.path}`);
  console.log('user-agent:', capture.headers?.['user-agent'] ?? null);
  console.log('anthropic-beta:', capture.headers?.['anthropic-beta'] ?? null);
  // `safeguards` carries local paths and rule lists; only its presence is reported.
  const shownParams = { ...params };
  if (shownParams.safeguards) shownParams.safeguards = `(${shownParams.safeguards.length} entries)`;
  if (shownParams.metadata) shownParams.metadata = '(present)';
  console.log('params:', JSON.stringify(shownParams));
  console.log(
    'system field:',
    systemBlocks.length,
    'blocks,',
    systemBlocks.reduce((n, b) => n + (b.text ?? '').length, 0),
    'chars',
    JSON.stringify(systemBlocks.map((b) => (b.text ?? '').length))
  );
  console.log(
    'system-role messages:',
    systemMessages.length,
    'chars',
    systemMessages.reduce((n, m) => n + textOf(m.content).length, 0)
  );
  let descChars = 0;
  for (const tool of tools) {
    const fn = tool.function ?? tool;
    const description = fn.description ?? '';
    const schema = fn.input_schema ?? fn.parameters ?? {};
    descChars += description.length;
    console.log(
      `  ${String(fn.name ?? tool.type).padEnd(22)} ${String(description.length).padStart(6)}  ${Object.keys(schema.properties ?? {}).join(',')}`
    );
  }
  console.log(
    'tools:',
    tools.length,
    '| description chars:',
    descChars,
    '| tools JSON chars:',
    JSON.stringify(tools).length
  );
  console.log(
    'messages:',
    messages
      .map((m) => {
        const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
        return `${m.role}[${parts.map((p) => `${p.type}:${(p.text ?? '').length}`).join('+')}]`;
      })
      .join(' ')
  );
}
