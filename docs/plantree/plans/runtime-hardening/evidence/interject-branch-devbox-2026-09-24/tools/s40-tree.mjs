/**
 * A9 / D4 — the session tree must not grow nodes for the bookkeeping entries
 * (`aiclient.runStop`, `aiclient.loopGuard`). Reads the tree over the app's own
 * IPC (`chat.getSessionTree`) and the JSONL on disk, and cross-checks ids.
 * Usage: TAG=<label> node s40-tree.mjs <sid> [<sid> …]
 */
import fs from 'node:fs';
import { connect, STATE_ROOT, save, sleep, stamp } from './ij-lib.mjs';

const sids = process.argv.slice(2);
const { cdp, evalAsync } = await connect();
const out = { at: stamp(), sessions: [] };
try {
  let seq = 1;
  for (const sid of sids) {
    const file = `${STATE_ROOT}/pi-agent/sessions/${sid}.jsonl`;
    const entries = fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const customs = entries
      .filter((e) => e.type === 'custom')
      .map((e) => ({ id: e.id, customType: e.customType, data: e.data }));
    const typeHist = {};
    for (const e of entries) {
      const k =
        e.type === 'custom'
          ? `custom:${e.customType}`
          : e.type === 'message'
            ? `message:${e.message?.role}`
            : (e.type ?? e.kind);
      typeHist[k] = (typeHist[k] ?? 0) + 1;
    }
    let resumed = null;
    if (process.env.RESUME === '1') {
      // Bind a worker without sending anything: the same IPC the composer uses
      // before the first send into a history conversation.
      resumed = await evalAsync(
        `
        const chat = await import('/stores/chatSessions.ts');
        const st = chat.useChatSessionsStore.getState();
        const x = st.sessions.find((v) => v.id === ${JSON.stringify(sid)});
        const ws = st.workspaces.find((w) => w.id === x?.workspaceId);
        const r = await window.electronAPI.chat.resumeSession({ sessionId: ${JSON.stringify(sid)}, runtimeIdentity: x.runtimeIdentity, workspacePath: ws.path, model: 'probe-fake/fake-sonnet' });
        for (let i = 0; i < 40; i += 1) {
          await new Promise((res) => setTimeout(res, 250));
          if (chat.useChatSessionsStore.getState().hostBoundSessionIds.includes(${JSON.stringify(sid)})) return { ok: true, requestId: r?.requestId ?? null, waitedMs: i * 250 };
        }
        return { ok: false, requestId: r?.requestId ?? null };
      `,
        { label: `resume ${sid}`, timeoutMs: 30000 }
      ).catch((e) => ({ error: String(e.message ?? e).slice(0, 300) }));
      await sleep(1500);
    }
    let tree = null;
    try {
      tree = await evalAsync(
        `
        const r = await window.electronAPI.chat.getSessionTree({ sessionId: ${JSON.stringify(sid)}, requestSequence: ${seq++} });
        const nodes = r.snapshot.nodes;
        const hist = {};
        for (const n of nodes) { const k = n.entryType + (n.role ? ':' + n.role : ''); hist[k] = (hist[k] ?? 0) + 1; }
        return { totalNodes: r.snapshot.totalNodes, hist, ids: nodes.map((n) => n.id), previews: nodes.map((n) => n.entryType + (n.role ? ':' + n.role : '') + ' ' + String(n.preview ?? n.label ?? '').slice(0, 50)) };
      `,
        { label: `tree ${sid}`, timeoutMs: 60000 }
      );
    } catch (error) {
      tree = { error: String(error.message ?? error).slice(0, 300) };
    }
    const leaked = tree?.ids ? customs.filter((c) => tree.ids.includes(c.id)) : null;
    out.sessions.push({
      sid,
      resumed,
      fileEntries: entries.length,
      fileTypeHist: typeHist,
      customs,
      tree,
      customNodesInTree: tree?.hist ? Object.keys(tree.hist).filter((k) => /custom/.test(k)) : null,
      leakedCustomIds: leaked,
    });
    console.log(
      sid,
      JSON.stringify({
        fileTypeHist: typeHist,
        customs: customs.map((c) => `${c.customType}:${JSON.stringify(c.data).slice(0, 80)}`),
        treeHist: tree?.hist ?? tree,
        leaked,
      })
    );
    await sleep(300);
  }
} finally {
  save(`40-tree-${process.env.TAG ?? 'run'}.json`, out);
  cdp.close();
}
