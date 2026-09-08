const prompt = (text, contains, tools = []) => ({ action: 'prompt', text, contains, tools });
const read = (path, rest = {}) => ({ name: 'read', args: { path, ...rest } });
const facts = 'Project: ORCHID\nPort: 4317\nRetention: 9 days\nOwner: LANTERN\n';
const reference = Array.from(
  { length: 320 },
  (_, i) =>
    `Record ${String(i + 1).padStart(4, '0')}: ORCHID keeps immutable audit entries; retention is 9 days, port is 4317, owner is LANTERN.`
).join('\n');
const longFile = `${Array.from({ length: 2300 }, (_, i) =>
  i === 0
    ? 'HEAD_MARKER=JADE'
    : i === 2100
      ? 'TAIL_MARKER=AMBER'
      : `Record ${String(i + 1).padStart(4, '0')}: static archival text for the ORCHID file-reading scenario.`
).join('\n')}\n`;

export const suite = {
  version: 'p2-0-v3',
  settings: {
    defaultThinkingLevel: 'off',
    compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 1024 },
    retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 90000 } },
    enableAnalytics: false,
    enableInstallTelemetry: false,
  },
  model: {
    id: 'claude-sonnet-5',
    api: 'anthropic-messages',
    reasoning: false,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 2048,
  },
  cases: [
    {
      id: 'B01',
      name: '纯对话',
      files: {},
      steps: [
        prompt(
          `Remember these facts for this conversation. Do not use tools. Reply only ORCHID_READY.\n${facts}\n${reference}`,
          ['ORCHID_READY']
        ),
        prompt(
          'Without tools, state the project name, port and retention from memory in one sentence.',
          ['ORCHID', '4317', '9']
        ),
        prompt(
          'Without tools, which owner is responsible for the project? Reply only the owner name.',
          ['LANTERN']
        ),
      ],
    },
    {
      id: 'B02',
      name: '多轮文件工具',
      files: { 'config.txt': 'project=ORCHID\nport=4317\n' },
      finalFiles: { 'config.txt': 'project=ORCHID\nport=4318\n' },
      steps: [
        prompt(
          'Call read exactly once with path="config.txt". Then state the configured port. Do not call any other tools.',
          ['4317'],
          [read('config.txt')]
        ),
        prompt(
          'Call edit exactly once with path="config.txt" and edits=[{"oldText":"port=4317","newText":"port=4318"}]. Then reply UPDATED. Do not call any other tools.',
          ['UPDATED'],
          [
            {
              name: 'edit',
              args: { path: 'config.txt', edits: [{ oldText: 'port=4317', newText: 'port=4318' }] },
            },
          ]
        ),
        prompt(
          'Call read exactly once with path="config.txt". Then state the new port. Do not call any other tools.',
          ['4318'],
          [read('config.txt')]
        ),
      ],
    },
    {
      id: 'B03',
      name: '搜索与读取',
      files: { 'notes.txt': 'SEARCH_MARKER=IRIS\n', 'other.txt': 'unrelated text\n' },
      steps: [
        prompt(
          'Call bash exactly once with command="grep -n \'SEARCH_MARKER\' notes.txt". Then state the marker. Do not call any other tools.',
          ['IRIS'],
          [{ name: 'bash', args: { command: "grep -n 'SEARCH_MARKER' notes.txt" } }]
        ),
        prompt(
          'Call read exactly once with path="notes.txt". Then repeat the complete marker line. Do not call any other tools.',
          ['SEARCH_MARKER=IRIS'],
          [read('notes.txt')]
        ),
        prompt('Without tools, repeat the marker value from the search.', ['IRIS']),
      ],
    },
    {
      id: 'B04',
      name: '长文件截断与分页',
      files: { 'archive.txt': longFile },
      steps: [
        prompt(
          'Call read exactly once with path="archive.txt" without offset or limit. Then state HEAD_MARKER. Do not call any other tools.',
          ['JADE'],
          [read('archive.txt')]
        ),
        prompt(
          'Call read exactly once with path="archive.txt", offset=2101, limit=3. Then state TAIL_MARKER. Do not call any other tools.',
          ['AMBER'],
          [read('archive.txt', { offset: 2101, limit: 3 })]
        ),
        prompt('Without tools, state both HEAD_MARKER and TAIL_MARKER values from memory.', [
          'JADE',
          'AMBER',
        ]),
      ],
    },
    {
      id: 'B05',
      name: '压缩后续聊',
      files: {},
      steps: [
        prompt(
          `Memorize the project facts. Reply only FACTS_READY and do not use tools.\n${facts}\n${reference}`,
          ['FACTS_READY']
        ),
        prompt(
          `Without tools, state the port and retention from memory. The following fixed reference material is repeated to establish a separate recent turn for compaction.\n${reference.slice(0, 14000)}`,
          ['4317', '9']
        ),
        prompt('Without tools, state the project name and owner from memory.', [
          'ORCHID',
          'LANTERN',
        ]),
        {
          action: 'compact',
          instructions:
            'Preserve the project name, port, retention and owner. Keep the summary under 400 words.',
        },
        prompt(
          'Without tools, state the project name, port, retention and owner from the earlier discussion.',
          ['ORCHID', '4317', '9', 'LANTERN']
        ),
        prompt('Without tools, state the port again. Reply with only the number.', ['4317']),
      ],
    },
    {
      id: 'B06',
      name: 'resume 续聊',
      files: {},
      steps: [
        prompt(`Remember these facts without tools. Reply only RESUME_READY.\n${facts}`, [
          'RESUME_READY',
        ]),
        prompt('Without tools, state the owner and port from memory.', ['LANTERN', '4317']),
        { action: 'resume' },
        prompt(
          'Without tools, state the project name, port and retention from our earlier conversation.',
          ['ORCHID', '4317', '9']
        ),
        prompt('Without tools, state the owner name again.', ['LANTERN']),
      ],
    },
  ],
};
