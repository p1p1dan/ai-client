import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRuntime } from '../../../../../../../src/runtime/index.ts';
import { fauxAssistantMessage, fauxProvider } from '../../../../../../../src/runtime/node_modules/@earendil-works/pi-ai/dist/providers/faux.js';
const [mode, directory] = process.argv.slice(2);
const file = `${directory}/session.jsonl`;
const faux = fauxProvider({ provider: 'process-test', models: [{ id: 'test', name: 'Test' }] });
const runtime = await createRuntime({ env: {}, providers: [faux.provider], tools: { cwd: directory },
  session: { file, cwd: directory, mode }, traceDir: null });
try {
  if (mode === 'create') {
    faux.setResponses([fauxAssistantMessage('FIRST_REPLY')]);
    assert.equal((await runtime.run({ prompt: 'FIRST_TASK', systemPrompt: 'probe' })).success, true);
    await runtime.session.appendCompaction({ summary: 'PROCESS_CHECKPOINT', retainedTail: [], tokensBefore: 100 });
    await runtime.session.rename('process roundtrip');
  } else {
    assert.equal(runtime.session.snapshot().checkpoint.summary, 'PROCESS_CHECKPOINT');
    assert.equal(runtime.session.metadata().title, 'process roundtrip');
    faux.setResponses([(context) => {
      assert.match(JSON.stringify(context.messages), /PROCESS_CHECKPOINT/);
      return fauxAssistantMessage('RESUMED_REPLY');
    }]);
    assert.equal((await runtime.run({ prompt: 'CONTINUE', systemPrompt: 'probe' })).success, true);
    assert.match(await readFile(file, 'utf8'), /FIRST_REPLY/);
    assert.match(await readFile(file, 'utf8'), /RESUMED_REPLY/);
  }
  console.log(JSON.stringify({ mode, success: true, node: process.version, pid: process.pid,
    entries: runtime.session.snapshot().entries.length, checkpointPersisted: true, title: runtime.session.metadata().title }));
} finally { await runtime.dispose(); }
