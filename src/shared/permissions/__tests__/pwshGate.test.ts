import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../types/runtimeEvents.ts';
import { permissionActivityEvent } from '../activity.ts';
import { createPermissionPrompt } from '../cardEmitter.ts';
import {
  type PermissionActivityRecord,
  type PermissionAskContext,
  PermissionGate,
  type ToolPermissionRequest,
} from '../gate.ts';
import { describeGrantScope, type PersistedGrants } from '../grants.ts';
import { loadPermissionPolicy } from '../policy.ts';
import { analyzePwsh } from '../pwshAnalysis.ts';

/**
 * dsh-rebase P1-6d — pwsh through the shared gate: grants keyed by the
 * normalized prefix (an alias and its cmdlet are one grant), the `bash`
 * policy surface both shells share, the ask reason a card carries when only
 * the unreadable part of a command made the gate ask, and what the card and
 * the audit row say about it.
 *
 * Requests are built the way the DSH host builds them (`analyzePwsh` feeding
 * `ToolPermissionRequest`), read here on the POSIX spelling so the gate's own
 * path algebra (the host's) agrees with them on any box.
 */

const ROOT = path.resolve('/ws');
let ids = 0;

function pwsh(command: string, workdir = ROOT): ToolPermissionRequest {
  const analysis = analyzePwsh(command, workdir, { HOME: '/home/me' }, { platform: 'linux' });
  return {
    tool: 'pwsh',
    toolCallId: `call-${++ids}`,
    path: workdir,
    command,
    paths: analysis.paths,
    commands: analysis.commands,
    unresolvedPaths: analysis.unresolvedPaths,
    exploration: analysis.exploration,
    ...(analysis.ungrantable ? { ungrantable: true } : {}),
  };
}

/** A gate whose every card is answered `answer`, recording what was asked. */
function gate(
  options: {
    gear?: 'ask' | 'accept-edits' | 'auto' | 'bypass';
    answer?: 'allow-once' | 'allow-session' | 'deny';
  } = {}
) {
  const asked: string[] = [];
  const contexts: Array<PermissionAskContext | undefined> = [];
  const persisted: PersistedGrants[] = [];
  const instance = new PermissionGate(
    {
      cwd: ROOT,
      gear: options.gear ?? 'ask',
      approve: async (request, _signal, _queue, context) => {
        asked.push(request.command ?? request.tool);
        contexts.push(context);
        return options.answer ?? 'allow-session';
      },
    },
    { persistGrants: (record) => persisted.push(record) }
  );
  return { gate: instance, asked, contexts, persisted };
}

describe('pwsh session grants (P1-6d)', () => {
  it('an alias and its cmdlet are one grant; another cmdlet is not covered', async () => {
    const { gate: g, asked, persisted } = gate();
    await g.authorize(pwsh('ls src'));
    await g.authorize(pwsh('dir src/sub'));
    await g.authorize(pwsh('Get-ChildItem -Recurse'));
    await g.authorize(pwsh('GCI'));
    await g.authorize(pwsh('Remove-Item x'));
    await g.authorize(pwsh('ls; rm x'));
    expect(asked).toEqual(['ls src', 'Remove-Item x']);
    expect(persisted.at(-1)?.grants).toEqual([
      { kind: 'command', prefix: 'Get-ChildItem', root: ROOT },
      { kind: 'command', prefix: 'Remove-Item', root: ROOT },
    ]);
  });

  it('works the other way round: the cmdlet granted covers its aliases', async () => {
    const { gate: g, asked } = gate();
    await g.authorize(pwsh('Get-Content a.txt'));
    await g.authorize(pwsh('cat b.txt'));
    await g.authorize(pwsh('type c.txt'));
    await g.authorize(pwsh('gc d.txt | Select-Object -First 3'));
    expect(asked).toEqual(['Get-Content a.txt', 'gc d.txt | Select-Object -First 3']);
  });

  it('matches program names without regard to case, and keeps a program extension apart', async () => {
    const { gate: g, asked } = gate();
    await g.authorize(pwsh('git status'));
    await g.authorize(pwsh('GIT status -s'));
    await g.authorize(pwsh('git push'));
    await g.authorize(pwsh('sc x.txt hello'));
    await g.authorize(pwsh('sc.exe stop svc'));
    expect(asked).toEqual(['git status', 'git push', 'sc x.txt hello', 'sc.exe stop svc']);
  });

  it('remembers nothing for a command with code it could not read', async () => {
    for (const command of [
      'Get-ChildItem | Where-Object { $_.Length -gt 1 }',
      'Get-Content $p',
      'iex x',
      'pwsh -Command ls',
      '& npm test',
    ]) {
      const { gate: g, asked, persisted } = gate();
      await g.authorize(pwsh(command));
      await g.authorize(pwsh(command));
      expect(asked, command).toEqual([command, command]);
      expect(persisted, command).toEqual([]);
    }
  });

  it('keeps a grant inside the workspace it was given in', async () => {
    const { gate: g, asked } = gate();
    await g.authorize(pwsh('Remove-Item a.txt'));
    await g.authorize(pwsh('Remove-Item /etc/passwd'));
    expect(asked).toEqual(['Remove-Item a.txt', 'Remove-Item /etc/passwd']);
  });

  it('describes the reach of "Allow for session" by the normalized prefix', () => {
    expect(describeGrantScope(pwsh('ls src'), ROOT)).toEqual({
      kind: 'command',
      value: 'Get-ChildItem',
    });
    expect(describeGrantScope(pwsh('npm test; dir'), ROOT)).toEqual({
      kind: 'command',
      value: 'npm test, Get-ChildItem',
    });
    expect(describeGrantScope(pwsh('Get-Content $p'), ROOT)).toBeUndefined();
  });
});

describe('the bash policy surface, shared by pwsh (P1-6d)', () => {
  it('holds a user rule written for bash on a pwsh call, with no surface on the request', async () => {
    const policy = await loadPermissionPolicy(
      {
        readFile: async (file: string) => {
          if (file !== path.join('/agent', 'pi-permissions.jsonc'))
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return {
            bytes: new TextEncoder().encode(
              '{ "permission": { "bash": { "*": "ask", "git push*": "deny" } } }'
            ),
          };
        },
      },
      { cwd: ROOT, agentDir: '/agent', sources: { user: true, project: false, local: false } }
    );
    const g = new PermissionGate({ cwd: ROOT, gear: 'bypass', policy });
    const push = pwsh('git push origin main');
    expect(push).not.toHaveProperty('policySurface');
    // A deny outranks every gear, bypass included; the rest of the table does not refuse.
    expect(g.evaluate(push)).toBe('deny');
    expect(g.evaluate(pwsh('GIT push'))).toBe('deny');
    expect(g.evaluate(pwsh('git status'))).toBe('allow');
    expect(g.evaluate({ ...push, tool: 'bash' })).toBe('deny');
  });
});

describe('why the card is up (askReason, P1-6d)', () => {
  it('is `unresolved` under auto when only the unreadable part made the gate ask', async () => {
    const { gate: g, contexts, asked } = gate({ gear: 'auto', answer: 'allow-once' });
    await g.authorize(pwsh('Write-Output a > out.txt'));
    await g.authorize(pwsh('Write-Output $X > out.txt'));
    expect(asked).toEqual(['Write-Output $X > out.txt']);
    expect(contexts).toEqual([{ askReason: 'unresolved' }]);
  });

  it('is `unresolved` under accept-edits for a workspace command, and absent once the path is outside', async () => {
    const { gate: g, contexts } = gate({ gear: 'accept-edits', answer: 'allow-once' });
    await g.authorize(pwsh('Remove-Item $x'));
    await g.authorize(pwsh('Remove-Item /etc/x $y'));
    expect(contexts).toEqual([{ askReason: 'unresolved' }, undefined]);
  });

  it('is absent under ask, where every command asks anyway, and for a host ask', async () => {
    const { gate: g, contexts } = gate({ gear: 'ask', answer: 'allow-once' });
    await g.authorize(pwsh('Write-Output $X'));
    await g.authorize({
      tool: 'pwsh',
      toolCallId: 'host-1',
      path: ROOT,
      unresolvedPaths: true,
      hostAsk: { sandbox: true },
    });
    expect(contexts).toEqual([undefined, undefined]);
  });

  it('covers a program the gate cannot see into, too', async () => {
    const { gate: g, contexts } = gate({ gear: 'auto', answer: 'allow-once' });
    await g.authorize({
      tool: 'run_code',
      toolCallId: 'p-1',
      path: ROOT,
      policySurface: 'run_code',
      policyValue: 'run_code',
      unresolvedPaths: true,
    });
    await g.authorize(pwsh('python build.py'));
    expect(contexts).toEqual([{ askReason: 'unresolved' }, { askReason: 'unresolved' }]);
  });

  it('reaches the card: the payload carries it, and only when given', async () => {
    const events: RuntimeEventDraft[] = [];
    const prompt = createPermissionPrompt({
      sessionId: 's',
      cwd: ROOT,
      emit: (e) => events.push(e),
    });
    const stop = new AbortController();
    const first = prompt.approve(pwsh('Write-Output $X'), stop.signal, undefined, {
      askReason: 'unresolved',
    });
    const second = prompt.approve(pwsh('ls'), stop.signal);
    stop.abort();
    await Promise.all([first, second]);
    const requested = events.filter((event) => event.type === 'permission.requested');
    expect(requested[0]?.payload).toMatchObject({
      toolName: 'pwsh',
      kind: 'exec',
      action: 'run_command',
      askReason: 'unresolved',
    });
    expect(requested[0]?.payload).not.toHaveProperty('sessionGrantScope');
    expect(requested[1]?.payload).not.toHaveProperty('askReason');
    expect(requested[1]?.payload).toMatchObject({
      sessionGrantScope: { kind: 'command', value: 'Get-ChildItem' },
    });
  });
});

describe('the audit row of a pwsh call (P1-6d)', () => {
  it('names the tool `pwsh`, not the `bash` policy surface it is judged under', async () => {
    const records: PermissionActivityRecord[] = [];
    const g = new PermissionGate({ cwd: ROOT, gear: 'bypass' });
    g.onActivity((record) => records.push(record));
    await g.authorize(pwsh('Get-ChildItem'));
    const event = permissionActivityEvent('s', records[0] as PermissionActivityRecord);
    expect(event.payload).toMatchObject({
      phase: 'decision',
      surface: 'pwsh',
      value: 'Get-ChildItem',
      result: 'allow',
      resolution: 'policy_allow',
    });
  });
});
