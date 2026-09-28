/**
 * aiclient-attachment-experiment — the dsh-rebase P1-4c2 pre-work experiment
 * (rescope §8 item 2, decisions 096 and 097), driven by
 * tools/attachment-experiments.ts.
 *
 * Never part of the repo's probe bundle: the driver copies tools/probe-bundle
 * to a scratch directory, adds this file and one row for it, and installs that
 * copy into its own scratch DSH_HOME. The sessions it sends to are the product
 * bridge's own (opened through worker.bootstrap on a channel); this row only
 * reaches their agents through `ctx.agents.get`, the way a DSH plugin would,
 * because the bridge does not carry attachments yet. It talks over the Node
 * IPC channel:
 *
 *   parent -> host  { rx42: op, requestId, ... }
 *   host -> parent  { rx42Reply: op, requestId, ... }   (or `error`)
 *
 *   admit { parts }                 ctx.attachments.admitPromptContent(parts): the admitted
 *                                   parts, or (`refusal`) the error's name / code / message
 *                                   and how `isAttachmentError` reads it;
 *                                   with the count of stored image objects before and after
 *   save-file { name, text }        ctx.attachments.saveFile: the reference, its host path
 *                                   (`fileHostPath`), the path the filesystem maps it to
 *                                   for tools (`fs.processPathFromHostPath`), the handle
 *                                   line the model gets (dsh-llm `fileHandleText`) and the
 *                                   stored file's mode
 *   image-path { ref }              imageHostPath and its process path, for an admitted image
 *   send { sessionId, text, attachments }
 *                                   agent.followup(createUserMessage([text, ...attachment
 *                                   blocks], user)): the message id
 *   turns { sessionId, ends, timeoutMs }
 *                                   waits until the session logged `ends` turn/end events
 *                                   and the agent is idle; answers the counts
 *   observe { sessionId }           sessionQuery.observeSession: the events
 * @module @aiclient/dsh-probe/attachment-experiment
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage, fileHandleText } from '@deepseek-ai/dsh-llm';

export const name = 'aiclient-attachment-experiment';
export const inject = ['agents', 'sessionQuery', 'attachments'];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Regular files below `dir`, recursively; 0 when it does not exist. */
function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function errorShape(ctx, error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message,
    isAttachmentError: ctx.attachments.isAttachmentError(error),
    constructor: error?.constructor?.name,
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (typeof process.send !== 'function') return;
  const send = (message) => {
    if (process.connected) process.send(message);
  };
  const home = process.env.DSH_HOME ?? '';
  const objects = join(home, 'attachments', 'v1', 'objects');
  /** sessionId -> { starts, ends } counted from session/event. */
  const counts = new Map();

  const agentOf = (sessionId) => {
    const agent = ctx.agents.get(sessionId);
    if (!agent) throw new Error(`no live agent for ${sessionId}`);
    return agent;
  };
  const processPath = (hostPath) =>
    hostPath === undefined ? undefined : ctx.get('fs')?.processPathFromHostPath(hostPath);

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id;
    if (!sessionId) return;
    const count = counts.get(sessionId) ?? { starts: 0, ends: 0 };
    if (event?.type === 'turn/start') count.starts += 1;
    if (event?.type === 'turn/end') count.ends += 1;
    counts.set(sessionId, count);
  });

  const ops = {
    async admit(message) {
      const before = countFiles(objects);
      try {
        const parts = await ctx.attachments.admitPromptContent(message.parts);
        return { ok: true, parts, objectsBefore: before, objectsAfter: countFiles(objects) };
      } catch (error) {
        return {
          ok: false,
          refusal: errorShape(ctx, error),
          objectsBefore: before,
          objectsAfter: countFiles(objects),
        };
      }
    },
    async 'save-file'(message) {
      const ref = await ctx.attachments.saveFile({
        data: new Uint8Array(Buffer.from(message.text, 'utf8')),
        ...(message.name === undefined ? {} : { name: message.name }),
      });
      const hostPath = ctx.attachments.fileHostPath(ref);
      const mapped = processPath(hostPath);
      return {
        ref,
        hostPath,
        processPath: mapped,
        handle: fileHandleText(ref, mapped),
        mode: hostPath ? (statSync(hostPath).mode & 0o777).toString(8) : undefined,
      };
    },
    async 'image-path'(message) {
      const hostPath = ctx.attachments.imageHostPath(message.ref);
      return {
        hostPath,
        processPath: processPath(hostPath),
        mode: hostPath ? (statSync(hostPath).mode & 0o777).toString(8) : undefined,
      };
    },
    async send(message) {
      const created = createUserMessage({
        content: [{ type: 'text', text: message.text }, ...(message.attachments ?? [])],
        source: { kind: 'user' },
      });
      agentOf(message.sessionId).followup(created);
      return { id: created.id };
    },
    async turns(message) {
      const deadline = Date.now() + (message.timeoutMs ?? 60_000);
      for (;;) {
        const count = counts.get(message.sessionId) ?? { starts: 0, ends: 0 };
        const agent = ctx.agents.get(message.sessionId);
        if (count.ends >= message.ends && agent?.status === 'idle') {
          return { ...count, status: agent.status, timedOut: false };
        }
        if (Date.now() > deadline) return { ...count, status: agent?.status, timedOut: true };
        await sleep(50);
      }
    },
    async observe(message) {
      const observation = await ctx.sessionQuery.observeSession(message.sessionId, {
        projectionMode: 'none',
      });
      try {
        return { cursor: observation.cursor, events: [...observation.events] };
      } finally {
        observation[Symbol.dispose]?.();
      }
    },
  };

  const onMessage = (message) => {
    if (message === null || typeof message !== 'object' || typeof message.rx42 !== 'string') return;
    const op = ops[message.rx42];
    if (!op) {
      send({ rx42Reply: message.rx42, requestId: message.requestId, error: 'unknown op' });
      return;
    }
    Promise.resolve()
      .then(() => op(message))
      .then(
        (answer) => send({ rx42Reply: message.rx42, requestId: message.requestId, ...answer }),
        (error) =>
          send({
            rx42Reply: message.rx42,
            requestId: message.requestId,
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          })
      );
  };
  ctx.effect(() => {
    process.on('message', onMessage);
    return () => {
      process.off('message', onMessage);
    };
  }, 'aiclient-attachment-experiment.ipc');
}
