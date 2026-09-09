const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, utilityProcess } = require('electron');

const { checkBundledExtensionsLoaded } = require('./bundled-extension-check.cjs');

const backendIndex = process.argv.indexOf('--backend');
const backend = backendIndex === -1 ? 'legacy' : process.argv[backendIndex + 1];
if (!['legacy', 'native'].includes(backend)) throw new Error(`unknown backend: ${backend}`);
const workerPath = process.argv.at(-1);
if (!workerPath) throw new Error('usage: electron scripts/packaged-worker-smoke.cjs <worker.js>');

/**
 * R03 — kept as a literal rather than imported from `bundledPlugins.mjs`.
 *
 * This script is CommonJS and runs under Electron against the BUILT artifact;
 * importing the source table would make the probe agree with the repo it was
 * built from instead of checking the thing on disk.
 */
const BUNDLED_FEATURE_PLUGIN_PACKAGES = [
  '@juicesharp/rpiv-ask-user-question',
  '@gotgenes/pi-subagents',
];

/**
 * Opt-in feature ids this probe switches ON before bootstrapping.
 *
 * `@gotgenes/pi-subagents` became opt-in and default-OFF in `2f0dd179`, and
 * this probe went red on the next packaged build: it was still requiring the
 * extension to be LOADED while the worker, correctly, was not injecting it.
 *
 * The fix is to enable it here rather than to drop it from the list, because
 * the two questions belong to different gates and only one of them is this
 * script's:
 *
 *  - "is it off by default?" is a product decision about
 *    `resolveManagedPiWorkerEnv`, already truth-tabled in
 *    `piModelConfig/__tests__/piWorkerEnv.test.ts` under a plain node vitest.
 *  - "did a working copy survive packaging?" can only be answered by pi, in
 *    the artifact, and dropping the package from the list would stop asking it
 *    — an opt-in plugin that shipped broken would then show no symptom until a
 *    user turned the switch on and found nothing there. The manifest says as
 *    much: off by default must not become "not shipped".
 */
const OPT_IN_FEATURE_IDS = ['subagents'];

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const generation = 1;
  const protocolVersion = 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-packaged-worker-'));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'workspace');
  const traceDir = path.join(root, 'trace');
  const modelRequests = [];
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'worker-read-probe.md'), '# packaged-worker-read-ok\n');
  // A local model stub asks the REAL session to run read/bash. No cloud credentials.
  let completionCount = 0;
  const modelServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    modelRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const first = completionCount++ === 0;
    const delta = first
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'probe_read',
              type: 'function',
              function: {
                name: 'read',
                arguments: JSON.stringify({ path: 'worker-read-probe.md' }),
              },
            },
            {
              index: 1,
              id: 'probe_bash',
              type: 'function',
              function: {
                name: 'bash',
                arguments: JSON.stringify({
                  command: 'printf packaged-worker-bash-ok',
                  ...(backend === 'native' ? { timeoutMs: 10_000 } : { timeout: 10 }),
                }),
              },
            },
          ],
        }
      : { role: 'assistant', content: 'tool probe complete' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [chunk, finish] of [
      [delta, null],
      [{}, first ? 'tool_calls' : 'stop'],
    ]) {
      response.write(
        `data: ${JSON.stringify({
          id: 'packaged-tool-probe',
          object: 'chat.completion.chunk',
          model: 'probe-model',
          created: 1,
          choices: [{ index: 0, delta: chunk, finish_reason: finish }],
        })}\n\n`
      );
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
          api: 'openai-completions',
          authHeader: true,
          models: [{ id: 'probe-model', name: 'Packaged Worker Probe' }],
        },
      },
    })
  );
  fs.writeFileSync(
    path.join(agentDir, 'auth.json'),
    JSON.stringify({ probe: { type: 'api_key', key: 'packaging-probe-not-a-real-secret' } })
  );

  await app.whenReady();
  let child;
  try {
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    Object.assign(childEnv, {
      PI_CODING_AGENT_DIR: agentDir,
      AICLIENT_RUNTIME_BACKEND: backend,
      AICLIENT_RUNTIME_AGENT_DIR: agentDir,
      AICLIENT_RUNTIME_TRACE_DIR: traceDir,
      AICLIENT_PI_TRUST_PROJECT_CONFIG: '0',
      AICLIENT_PI_WORKER_GENERATION: String(generation),
      // Same variable Main sends (`PI_OPT_IN_EXTENSIONS_ENV`). Set here so the
      // probe exercises every bundled plugin, opt-in ones included.
      AICLIENT_PI_OPT_IN_EXTENSIONS: OPT_IN_FEATURE_IDS.join(','),
    });
    // Allows validating Node IPC on a development host without a Windows package.
    const smokeNodePath = process.env.AICLIENT_WORKER_SMOKE_NODE_PATH;
    const usesNode = process.platform === 'win32' || Boolean(smokeNodePath);
    let postMessage;
    if (usesNode) {
      const nodePath =
        smokeNodePath || path.join(path.dirname(workerPath), '..', 'node-runtime', 'node.exe');
      childEnv.PATH = `${path.dirname(nodePath)}${path.delimiter}${childEnv.PATH || childEnv.Path || ''}`;
      childEnv.Path = childEnv.PATH;
      child = spawn(nodePath, [workerPath], {
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
      postMessage = (message) => child.send(message);
    } else {
      child = utilityProcess.fork(workerPath, [], {
        cwd,
        env: childEnv,
        stdio: 'pipe',
        serviceName: 'AiClient Packaged Pi Worker Smoke',
      });
      postMessage = (message) => child.postMessage(message);
    }
    child.stdout?.resume();
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    const responses = new Map();
    const toolResults = new Map();
    const permissionActivity = [];
    let idle = false;
    child.on('message', (message) => {
      if (message?.kind === 'event' && message.payload?.type === 'permission.activity') {
        permissionActivity.push(message.payload.payload);
      }
      if (
        message?.kind === 'event' &&
        message.payload?.type === 'session.status' &&
        message.payload.payload.status === 'idle'
      )
        idle = true;
      if (message?.kind === 'response' && typeof message.requestId === 'string') {
        responses.set(message.requestId, message);
      }
      if (message?.kind === 'event' && message.payload?.type === 'tool.completed') {
        toolResults.set(message.payload.payload.toolCallId, message.payload.payload);
      }
    });
    const waitFor = async (requestId, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const response = responses.get(requestId);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for ${requestId}`);
    };
    const request = (requestId, type, payload) => ({
      protocolVersion,
      kind: 'request',
      generation,
      requestId,
      type,
      payload,
    });

    postMessage(
      request('bootstrap', 'worker.bootstrap', {
        logicalSessionId: 'packaged-probe',
        cwd,
        model: 'probe/probe-model',
        effort: 'low',
        tier: 'fullopen',
      })
    );
    const bootstrap = await waitFor('bootstrap');
    if (!bootstrap.ok || bootstrap.result?.bootstrapped !== true) {
      throw new Error(`bootstrap failed: ${JSON.stringify(bootstrap)}`);
    }

    // R03 — the bundled feature extensions must be loaded, not merely copied.
    // Opt-in ones are switched on above, so this list stays complete: the probe
    // asks whether the ARTIFACT works, not whether a feature is on by default.
    // The artifact check upstream proves the FILES survived packaging; only pi
    // itself can say it resolved and ran them, and that is the difference
    // between "we shipped a plugin" and "the user has the feature". A packaged
    // build that quietly loses one shows no symptom until a model asks a
    // question and no dialog appears.
    if (backend === 'legacy') {
      const problems = checkBundledExtensionsLoaded(
        bootstrap.result.extensions,
        BUNDLED_FEATURE_PLUGIN_PACKAGES
      );
      if (problems.length > 0) throw new Error(problems.join('\n'));
    } else if (bootstrap.result.permissionGate !== 'bundled') {
      throw new Error('native permission gate is missing');
    }
    postMessage(
      request('send', 'worker.send', {
        logicalSessionId: 'packaged-probe',
        requestId: 'tool-probe',
        attemptId: 'tool-probe-attempt',
        text: 'Run the tool probe.',
      })
    );
    const send = await waitFor('send');
    if (!send.ok) throw new Error(`tool probe send failed: ${JSON.stringify(send)}`);
    const toolDeadline = Date.now() + 15_000;
    while ((!idle || toolResults.size < 2) && Date.now() < toolDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const [id, text] of [
      ['probe_read', 'packaged-worker-read-ok'],
      ['probe_bash', 'packaged-worker-bash-ok'],
    ]) {
      const result = toolResults.get(id);
      if (!result?.ok || !result.output.includes(text)) {
        throw new Error(`tool probe ${id} failed: ${JSON.stringify(result)}`);
      }
    }
    if (!idle) throw new Error('tool turn did not return to idle');
    const toolReplies = modelRequests
      .flatMap((request) => request.messages ?? [])
      .filter((message) => message.role === 'tool');
    for (const id of ['probe_read', 'probe_bash']) {
      if (!toolReplies.some((message) => message.tool_call_id === id))
        throw new Error(`model did not receive tool result ${id}`);
    }
    const workerPid = child.pid;
    if (!workerPid) throw new Error('worker has no pid after bootstrap');

    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    postMessage(request('dispose', 'worker.dispose', { reason: 'app-shutdown' }));
    const dispose = await waitFor('dispose');
    if (!dispose.ok || dispose.result?.disposed !== true) {
      throw new Error(`dispose failed: ${JSON.stringify(dispose)}`);
    }
    const exitCode = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('worker did not exit')), 5000)),
    ]);
    if (exitCode !== 0) throw new Error(`worker exited with code ${exitCode}`);
    const deadline = Date.now() + 2000;
    while (pidExists(workerPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (pidExists(workerPid)) throw new Error(`worker pid ${workerPid} still exists after exit`);
    let stamp;
    if (backend === 'native') {
      const traces = fs
        .readFileSync(path.join(traceDir, 'runs.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const trace = traces.at(-1);
      stamp = trace?.version_stamp;
      if (
        !trace?.success ||
        stamp?.backend !== 'native' ||
        stamp.carrier !== (usesNode ? 'bundled-node' : 'electron-utility')
      )
        throw new Error(`unexpected native trace: ${JSON.stringify(trace)}`);
      if (usesNode && path.resolve(stamp.node_exec_path) !== path.resolve(child.spawnfile))
        throw new Error('native trace does not identify the launched Node');
      if (permissionActivity.length < 2) throw new Error('native permission activity is missing');
    }
    console.log(
      JSON.stringify({
        ok: true,
        backend,
        workerPath,
        workerExecutable: usesNode ? child.spawnfile : process.execPath,
        stamp,
        permissionActivity,
        exitCode,
        workerPid,
        sessionFile: bootstrap.result.sessionFile,
        bundledExtensions: backend === 'legacy' ? BUNDLED_FEATURE_PLUGIN_PACKAGES.length : 0,
        transport: usesNode ? 'node-ipc' : 'electron-message-port',
        tools: ['read', 'bash'],
      })
    );
  } finally {
    try {
      child?.kill();
    } catch {
      // Already exited.
    }
    fs.rmSync(root, { recursive: true, force: true });
    modelServer.closeAllConnections();
    modelServer.close();
  }
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
