const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, utilityProcess } = require('electron');

const workerPath = process.argv.at(-1);
if (!workerPath) throw new Error('usage: electron scripts/packaged-worker-smoke.cjs <worker.js>');

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
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: 'http://127.0.0.1:1/v1',
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
      AICLIENT_PI_TRUST_PROJECT_CONFIG: '0',
      AICLIENT_PI_WORKER_GENERATION: String(generation),
    });
    child = utilityProcess.fork(workerPath, [], {
      cwd,
      env: childEnv,
      stdio: 'pipe',
      serviceName: 'AiClient Packaged Pi Worker Smoke',
    });
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    const responses = new Map();
    child.on('message', (message) => {
      if (message?.kind === 'response' && typeof message.requestId === 'string') {
        responses.set(message.requestId, message);
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

    child.postMessage(
      request('bootstrap', 'worker.bootstrap', {
        logicalSessionId: 'packaged-probe',
        cwd,
        model: 'probe/probe-model',
        effort: 'low',
      })
    );
    const bootstrap = await waitFor('bootstrap');
    if (!bootstrap.ok || bootstrap.result?.bootstrapped !== true) {
      throw new Error(`bootstrap failed: ${JSON.stringify(bootstrap)}`);
    }
    const workerPid = child.pid;
    if (!workerPid) throw new Error('utility worker has no pid after bootstrap');

    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.postMessage(request('dispose', 'worker.dispose', { reason: 'app-shutdown' }));
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
    console.log(JSON.stringify({ ok: true, workerPid, sessionFile: bootstrap.result.sessionFile }));
  } finally {
    try {
      child?.kill();
    } catch {
      // Already exited.
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
