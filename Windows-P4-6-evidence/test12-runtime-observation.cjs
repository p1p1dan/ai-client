// Field observation harness. Uses the installed worker and isolated synthetic sessions.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const node = 'D:\\Program Files\\AiClient\\resources\\node-runtime\\node.exe';
const renamed = path.join(path.dirname(node), 'bash-probe.exe');
const worker = 'D:\\Program Files\\AiClient\\resources\\agent-host\\worker.js';
const workspace = 'C:\\Users\\JC\\Desktop\\AiClient-test12-probe';
const target = path.join(workspace, 'probe-a.txt');
const evidence = __dirname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test12-carrier-observation-'));
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const reader = "const fs=require('node:fs'),c=require('node:crypto');const b=fs.readFileSync(process.argv[1]);console.log(JSON.stringify({exe:process.execPath,pid:process.pid,ppid:process.ppid,bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex'),tsdHeader:b.subarray(0,32).toString('ascii').includes('TSD-Header')}))";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function observe(label, command, noShell = false) {
  const agent = path.join(root, label);
  const trace = path.join(evidence, 'test12-isolated-traces', label);
  fs.mkdirSync(agent, { recursive: true });
  let requestCount = 0;
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) { /* Drain local stub request. */ }
    const first = requestCount++ === 0;
    const delta = first ? {
      role: 'assistant',
      tool_calls: [{ index: 0, id: label, type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({ command, timeoutMs: 15000 }),
      } }],
    } : { role: 'assistant', content: 'Observation recorded.' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: label, object: 'chat.completion.chunk', created: 1,
      model: 'probe', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: label, object: 'chat.completion.chunk', created: 1,
      model: 'probe', choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { probe: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions',
    models: [{ id: 'probe', name: 'Offline field probe' }],
  } } }));
  fs.writeFileSync(path.join(agent, 'auth.json'), JSON.stringify({ probe: { type: 'api_key', key: 'local-probe-placeholder' } }));
  const env = { ...process.env, AICLIENT_RUNTIME_BACKEND: 'native',
    AICLIENT_RUNTIME_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
    AICLIENT_RUNTIME_TRACE_DIR: trace, AICLIENT_PI_WORKER_GENERATION: '1',
    AICLIENT_PI_TRUST_PROJECT_CONFIG: '0', AICLIENT_PI_OPT_IN_EXTENSIONS: '',
    NODE_OPTIONS: '--max-old-space-size=1536' };
  delete env.ELECTRON_RUN_AS_NODE;
  if (noShell) {
    for (const key of Object.keys(env)) {
      if (['path', 'programfiles', 'programfiles(x86)', 'localappdata'].includes(key.toLowerCase())) delete env[key];
    }
    env.PATH = path.dirname(node);
    env.ProgramFiles = root;
    env['ProgramFiles(x86)'] = root;
    env.LOCALAPPDATA = root;
  }
  const child = spawn(node, ['--max-old-space-size=1536', worker], {
    cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const responses = new Map();
  const toolResults = [];
  let idle = false;
  let exited = false;
  let exitCode;
  child.once('exit', (code) => { exited = true; exitCode = code; });
  child.stdout.resume();
  child.stderr.on('data', (s) => process.stderr.write(s));
  child.on('message', (m) => {
    if (m.kind === 'response') responses.set(m.requestId, m);
    if (m.kind === 'event' && m.payload.type === 'tool.completed') toolResults.push(m.payload.payload);
    if (m.kind === 'event' && m.payload.type === 'session.status' && m.payload.payload.status === 'idle') idle = true;
  });
  const rpc = async (id, type, payload) => {
    child.send({ protocolVersion: 1, generation: 1, kind: 'request', requestId: id, type, payload });
    const deadline = Date.now() + 15000;
    while (!responses.has(id) && !exited && Date.now() < deadline) await pause(20);
    const response = responses.get(id);
    if (!response?.ok) throw new Error(`${label} ${id}: ${JSON.stringify(response ?? { exited, exitCode })}`);
    return response.result;
  };
  try {
    await rpc('bootstrap', 'worker.bootstrap', { logicalSessionId: label, cwd: workspace,
      model: 'probe/probe', tier: 'fullopen' });
    await rpc('send', 'worker.send', { logicalSessionId: label, requestId: label, attemptId: label,
      text: 'Execute the local field observation command.' });
    const deadline = Date.now() + 25000;
    while ((!idle || toolResults.length === 0) && !exited && Date.now() < deadline) await pause(20);
    console.log(JSON.stringify({ label, parentExecutable: process.execPath, workerExecutable: node,
      workerPid: child.pid, idle, toolResults, isolatedNoShell: noShell }));
    if (!idle || toolResults.length === 0) throw new Error(`${label}: missing tool result or idle`);
    await rpc('dispose', 'worker.dispose', { reason: 'app-shutdown' });
    const exitDeadline = Date.now() + 5000;
    while (!exited && Date.now() < exitDeadline) await pause(20);
    console.log(JSON.stringify({ label, disposed: exited, exitCode }));
    if (!exited || exitCode !== 0) throw new Error(`${label}: worker did not exit cleanly`);
  } finally {
    if (!exited) child.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  await app.whenReady();
  if (fs.existsSync(renamed)) throw new Error('bash-probe.exe already exists; will not overwrite');
  console.log(JSON.stringify({ input: target, initialSha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') }));
  try {
    await observe('R2', `printf 'BASH_WINDOWS_PATH='; cygpath -aw "$BASH"; ${quote(node.replaceAll('\\', '/'))} -e ${quote(reader)} ${quote(target.replaceAll('\\', '/'))}`);
    fs.copyFileSync(node, renamed, fs.constants.COPYFILE_EXCL);
    try {
      await observe('R3', `${quote(renamed.replaceAll('\\', '/'))} -e ${quote(reader)} ${quote(target.replaceAll('\\', '/'))}`);
    } finally {
      fs.unlinkSync(renamed);
    }
    await observe('R4', 'printf no-shell-should-not-execute', true);
    console.log(JSON.stringify({ inputUnmodifiedSha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), renamedRemoved: !fs.existsSync(renamed) }));
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('unexpected temporary root');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
