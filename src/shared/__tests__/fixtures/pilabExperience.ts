import type { RuntimeEvent, RuntimeEventType } from '../../types/runtimeEvents';

const T0 = 1_800_000_000_000;

type EventOf<T extends RuntimeEventType> = Extract<RuntimeEvent, { type: T }>;
type PayloadOf<T extends RuntimeEventType> = EventOf<T> extends { payload: infer P } ? P : never;

export interface PilabReplayScenario {
  id: `F0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
  title: string;
  source: 'constructed-sanitized';
  ac: readonly string[];
  createEvents: () => RuntimeEvent[];
}

function eventsFor(sessionId: string) {
  let seq = 0;
  const events: RuntimeEvent[] = [];
  const emit = <T extends RuntimeEventType>(
    type: T,
    payload: PayloadOf<T>,
    requestId?: string
  ): EventOf<T> => {
    seq += 1;
    const event = {
      type,
      sessionId,
      seq,
      timestamp: T0 + seq * 100,
      ...(requestId ? { requestId } : {}),
      payload,
    } as EventOf<T>;
    events.push(event);
    return event;
  };
  return { events, emit };
}

function basicStart(emit: ReturnType<typeof eventsFor>['emit'], prefix = 'msg') {
  emit('message.started', { messageId: `${prefix}-user`, role: 'user' });
  emit('message.delta', { messageId: `${prefix}-user`, blockId: `${prefix}-user-text`, text: '完成脱敏演示任务' });
  emit('message.started', { messageId: `${prefix}-assistant`, role: 'assistant' });
}

function createF01(): RuntimeEvent[] {
  const { events, emit } = eventsFor('pilab-replay-f01');
  basicStart(emit);
  emit('thinking.started', { messageId: 'msg-assistant', blockId: 'thought-1' });
  emit('thinking.delta', { messageId: 'msg-assistant', blockId: 'thought-1', text: '核对参数与结果。' });
  emit('thinking.completed', { messageId: 'msg-assistant', blockId: 'thought-1' });
  emit('message.delta', { messageId: 'msg-assistant', blockId: 'answer-a', text: '正文 A：已确认连接正常。' });
  emit('tool.started', {
    messageId: 'msg-assistant', toolCallId: 'call-a', name: 'Bash',
    input: { command: 'pnpm test:focused', description: '运行聚焦测试' },
  });
  emit('tool.updated', {
    messageId: 'msg-assistant', toolCallId: 'call-a',
    input: { command: 'pnpm test:focused', description: '运行聚焦测试' },
  });
  emit('message.delta', { messageId: 'msg-assistant', blockId: 'answer-b', text: '正文 B：离线对照一致。' });
  emit('tool.started', {
    messageId: 'msg-assistant', toolCallId: 'call-b', name: 'Read',
    input: { file_path: 'C:\\work\\demo\\src\\main.ts' },
  });
  emit('tool.completed', {
    messageId: 'msg-assistant', toolCallId: 'call-b', ok: true, output: 'export const demo = true;',
  });
  emit('tool.completed', {
    messageId: 'msg-assistant', toolCallId: 'call-a', ok: true, output: '2 passed',
  });
  emit('tool.completed', {
    messageId: 'msg-assistant', toolCallId: 'call-early', ok: true, output: '先到的结果',
  });
  emit('tool.started', {
    messageId: 'msg-assistant', toolCallId: 'call-early', name: 'Read',
    input: { file_path: 'C:\\work\\demo\\late.ts' },
  });
  emit('message.completed', { messageId: 'msg-assistant' });
  emit('session.completed', {});
  return events;
}

function createF02(): RuntimeEvent[] {
  const { events, emit } = eventsFor('pilab-replay-f02');
  basicStart(emit, 'long');
  let answer = 0;
  for (let tool = 1; tool <= 67; tool += 1) {
    if (tool <= 42) {
      emit('thinking.started', { messageId: 'long-assistant', blockId: `thought-${tool}` });
      emit('thinking.delta', {
        messageId: 'long-assistant', blockId: `thought-${tool}`, text: `第 ${tool} 段脱敏思考`,
      });
      emit('thinking.completed', { messageId: 'long-assistant', blockId: `thought-${tool}` });
    }
    emit('tool.started', {
      messageId: 'long-assistant', toolCallId: `long-call-${tool}`, name: 'Read',
      input: { file_path: `C:\\work\\demo\\file-${tool}.ts` },
    });
    emit('tool.completed', {
      messageId: 'long-assistant', toolCallId: `long-call-${tool}`, ok: true, output: `result-${tool}`,
    });
    if (answer < 8 && tool % 8 === 0) {
      answer += 1;
      emit('message.delta', {
        messageId: 'long-assistant', blockId: `long-answer-${answer}`, text: `阶段正文 ${answer}：保留真实发现。`,
      });
    }
  }
  emit('message.completed', { messageId: 'long-assistant' });
  emit('session.completed', {});
  return events;
}

function createF03(): RuntimeEvent[] {
  const { events, emit } = eventsFor('pilab-replay-f03');
  basicStart(emit, 'interaction');
  emit('tool.started', {
    messageId: 'interaction-assistant', toolCallId: 'deploy-call', name: 'Bash',
    input: { command: 'pnpm deploy:demo' },
  });
  emit('permission.requested', {
    permissionId: 'permission-1', toolName: 'Bash', action: 'run_command',
    input: { command: 'pnpm deploy:demo' }, decisions: ['allow', 'deny'],
    detail: { kind: 'exec', command: 'pnpm deploy:demo', cwd: 'C:\\work\\demo' },
  });
  emit('question.requested', {
    questionId: 'question-1',
    questions: [
      {
        id: 'environment', header: '环境', question: '选择脱敏验证环境', multiSelect: false,
        options: [{ label: '本地', description: '仅离线验证' }, { label: '暂不执行' }],
      },
      {
        id: 'checks', header: '检查', question: '选择要保留的检查', multiSelect: true,
        options: [{ label: '类型' }, { label: '测试' }],
      },
    ],
  });
  emit('permission.resolved', { permissionId: 'permission-1', allow: false, autoReason: 'timed_out' });
  emit('question.resolved', { questionId: 'question-1', outcome: 'cancelled', stopped: true });
  return events;
}

function createF04(): RuntimeEvent[] {
  const { events, emit } = eventsFor('pilab-replay-f04');
  basicStart(emit, 'recover');
  emit('message.delta', { messageId: 'recover-assistant', blockId: 'same-text', text: '好' });
  emit('message.delta', { messageId: 'recover-assistant', blockId: 'same-text', text: '好' });
  for (const callId of ['repeat-1', 'repeat-2']) {
    emit('tool.started', {
      messageId: 'recover-assistant', toolCallId: callId, name: 'Bash', input: { command: 'pnpm test' },
    });
    emit('tool.completed', {
      messageId: 'recover-assistant', toolCallId: callId, ok: true, output: `run:${callId}`,
    });
  }
  emit('message.started', { messageId: 'recover-assistant', role: 'assistant' });
  emit('session.resumed', { agent: 'dsh', runtimeIdentity: 'sanitized-runtime' }, 'recover-1');
  const historyPayload = {
    runtimeIdentity: 'sanitized-runtime', workspacePath: 'C:\\work\\demo', mode: 'refresh' as const,
    messages: [
      {
        id: 'h:recover-user' as const, entryId: 'recover-user', role: 'user' as const,
        blocks: [{ type: 'text' as const, id: 'h:recover-user-text', text: '完成脱敏演示任务' }],
      },
      {
        id: 'h:recover-assistant' as const, entryId: 'recover-assistant', role: 'assistant' as const,
        blocks: [
          { type: 'text' as const, id: 'h:same-text', text: '好好' },
          { type: 'tool_call' as const, id: 'h:repeat-1', toolCallId: 'repeat-1', name: 'Bash', input: { command: 'pnpm test' } },
          { type: 'tool_result' as const, id: 'h:repeat-1-result', toolCallId: 'repeat-1', ok: true, output: 'run:repeat-1' },
          { type: 'tool_call' as const, id: 'h:repeat-2', toolCallId: 'repeat-2', name: 'Bash', input: { command: 'pnpm test' } },
          { type: 'tool_result' as const, id: 'h:repeat-2-result', toolCallId: 'repeat-2', ok: true, output: 'run:repeat-2' },
        ],
      },
    ],
    truncated: false, omittedCount: 0,
  };
  emit('session.history', historyPayload, 'recover-1');
  emit('session.history', historyPayload, 'recover-1');
  emit('session.status', { status: 'idle' });
  return events;
}

function createF05(): RuntimeEvent[] {
  const { events, emit } = eventsFor('pilab-replay-f05');
  basicStart(emit, 'background');
  emit('tool.started', {
    messageId: 'background-assistant', toolCallId: 'task-parent', name: 'Task',
    input: { description: '脱敏后台核对', prompt: '检查演示输出' },
  });
  emit('subagent.activity', {
    parentToolCallId: 'task-parent', agentId: 'agent-same-name', kind: 'started', description: '同名代理',
  });
  emit('message.delta', { messageId: 'background-assistant', blockId: 'stage-reply', text: '本阶段回复已给出，后台仍在运行。' });
  emit('message.completed', { messageId: 'background-assistant' });
  emit('session.completed', {});
  emit('message.started', { messageId: 'next-user', role: 'user' });
  emit('message.delta', { messageId: 'next-user', blockId: 'next-user-text', text: '新的无关请求' });
  emit('message.started', { messageId: 'next-assistant', role: 'assistant' });
  emit('message.delta', { messageId: 'next-assistant', blockId: 'next-answer', text: '新任务正文。' });
  emit('subagent.activity', {
    parentToolCallId: 'task-parent', agentId: 'agent-same-name', kind: 'text', id: 'old-result',
    text: '旧后台任务的新发现，仍归原任务。',
  });
  emit('subagent.activity', {
    parentToolCallId: 'task-parent', agentId: 'agent-same-name', kind: 'status', status: 'completed', endedAt: T0 + 20_000,
  });
  return events;
}

function createF06(): RuntimeEvent[] {
  const { events, emit } = eventsFor('pilab-replay-f06');
  basicStart(emit, 'code');
  emit('message.delta', { messageId: 'code-assistant', blockId: 'code-answer', text: '前文保留。\n```ts\nconst answer = 42;\n' });
  emit('tool.started', {
    messageId: 'code-assistant', toolCallId: 'edit-demo', name: 'Edit',
    input: { file_path: 'C:\\work\\demo\\中文 空格\\demo.ts', old_string: 'const value = 1;\r\n', new_string: 'const value = 2;\r\n' },
  });
  emit('tool.completed', {
    messageId: 'code-assistant', toolCallId: 'edit-demo', ok: true,
    output: { content: 'updated', details: { review: { path: '中文 空格/demo.ts', diff: '@@ -1 +1 @@\r\n-const value = 1;\r\n+const value = 2;\r\n' } } },
  });
  emit('message.completed', { messageId: 'code-assistant' });
  return events;
}

function createF07(): RuntimeEvent[] {
  const { events, emit } = eventsFor('pilab-replay-f07');
  basicStart(emit, 'large');
  for (let tool = 1; tool <= 100; tool += 1) {
    emit('tool.started', {
      messageId: 'large-assistant', toolCallId: `large-call-${tool}`, name: 'Bash',
      input: { command: `demo-command ${tool}` },
    });
    emit('tool.completed', {
      messageId: 'large-assistant', toolCallId: `large-call-${tool}`, ok: true, output: 'x'.repeat(10_000),
    });
  }
  while (events.length < 9_998) {
    emit('message.delta', { messageId: 'large-assistant', blockId: 'large-answer', text: '好' });
  }
  emit('message.completed', { messageId: 'large-assistant' });
  emit('session.completed', {});
  return events;
}

export function createLegacyHistoryEvents(engine: 'dsh' | 'claude-sdk'): RuntimeEvent[] {
  const { events, emit } = eventsFor(`pilab-replay-f08-${engine}`);
  emit('session.resumed', {
    agent: 'dsh', runtimeIdentity: 'legacy-sanitized',
    ...(engine === 'claude-sdk' ? { engine, engineRoute: 'anthropic-messages' } : {}),
  }, 'legacy-initial');
  emit('session.history', {
    runtimeIdentity: 'legacy-sanitized', workspacePath: 'C:\\work\\legacy', mode: 'initial',
    messages: [
      {
        id: 'h:legacy-user' as const, role: 'user' as const,
        blocks: [{ type: 'text' as const, id: 'legacy-user-text', text: '旧历史请求' }],
      },
      {
        id: 'h:legacy-assistant' as const, role: 'assistant' as const, incomplete: true,
        blocks: [
          { type: 'text' as const, id: 'legacy-answer', text: '旧正文仍然可读。' },
          { type: 'tool_call' as const, id: 'legacy-call-block', toolCallId: 'legacy-call', name: 'Bash' },
          { type: 'tool_result' as const, id: 'legacy-result-block', toolCallId: 'legacy-call', ok: false, outcomeUnknown: true as const },
        ],
      },
    ],
    truncated: false, omittedCount: 0,
  }, 'legacy-initial');
  emit('session.status', { status: 'idle' });
  return events;
}

export const pilabReplayScenarios: readonly PilabReplayScenario[] = [
  { id: 'F01', title: '基础混合流与乱序结果', source: 'constructed-sanitized', ac: ['AC-01', 'AC-04', 'AC-07'], createEvents: createF01 },
  { id: 'F02', title: '42 思考 / 67 工具 / 8 正文长链', source: 'constructed-sanitized', ac: ['AC-02', 'AC-05'], createEvents: createF02 },
  { id: 'F03', title: '待答、审批与失效交互', source: 'constructed-sanitized', ac: ['AC-11', 'AC-12', 'AC-15', 'AC-16'], createEvents: createF03 },
  { id: 'F04', title: '合法重复、开始事件重发与恢复快照', source: 'constructed-sanitized', ac: ['AC-04', 'AC-08', 'AC-10', 'AC-14'], createEvents: createF04 },
  { id: 'F05', title: '阶段回复后旧后台结果返回', source: 'constructed-sanitized', ac: ['AC-17'], createEvents: createF05 },
  { id: 'F06', title: '流式代码、CRLF 差异与受限富内容', source: 'constructed-sanitized', ac: ['AC-28', 'AC-29', 'AC-30', 'AC-34'], createEvents: createF06 },
  { id: 'F07', title: '1 万事件 / 100 工具 / 1MB 输出', source: 'constructed-sanitized', ac: ['AC-21'], createEvents: createF07 },
  { id: 'F08', title: 'DSH / Claude SDK 旧历史与缺失字段', source: 'constructed-sanitized', ac: ['AC-22', 'AC-44'], createEvents: () => createLegacyHistoryEvents('dsh') },
];

export const pilabCodePreviewSamples = {
  windowsPath: 'C:\\work\\demo\\中文 空格\\demo.ts',
  incompleteFence: '前文保留。\n```ts\nconst answer = 42;\n',
  crlfDiff: '@@ -1,2 +1,2 @@\r\n-const value = 1;\r\n-const other = 2;\r\n+const value = 2;\r\n+const other = 2;\r\n',
  noEofDiff: '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n',
  htmlLog: '<script>globalThis.__pilabPreviewExecuted = true</script><img src=x onerror=alert(1)>',
  markdown: '# 脱敏预览\n\n[受控链接](https://example.invalid)\n',
  mermaid: 'flowchart TD\n  A[开始] --> B[完成]\n',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text x="0" y="15">demo</text></svg>',
} as const;
