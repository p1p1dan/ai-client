// PiLab web (issue #25): served by pilab-relay. Login → machines → chats → one chat.
// No framework, no build step. Everything user- or model-written is set as text,
// never as HTML, except through `markdown()`, which escapes first.

const app = document.getElementById('app');
const BUSY = new Set(['starting', 'running', 'waiting_permission', 'waiting_question', 'stopping']);
const DECISION_LABELS = {
  allow: '允许',
  allow_session: '本次对话都允许',
  deny: '拒绝',
  cancel: '取消',
};
const PLAN_LABELS = {
  'goal:auto': '批准，设为目标（自动）',
  'goal:bypass': '批准，设为目标（完全放行）',
  'run:auto': '批准并执行（自动）',
  'run:ask': '批准并执行（每步询问）',
  'run:accept-edits': '批准并执行（自动接受改动）',
  'run:bypass': '批准并执行（完全放行）',
  'keep-planning': '继续规划',
};
const ICONS = {
  back: '<path d="m15 18-6-6 6-6"/>',
  send: '<path d="m5 12 7-7 7 7M12 19V5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
};

// ---------- tiny DOM helpers ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'html') el.innerHTML = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i');
  svg.innerHTML = ICONS[name];
  return svg;
};
let toastTimer;
function toast(text) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast' }, text);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3000);
}
function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
/** Small markdown: fences, inline code, bold, italics, links, headings, lists. Escapes first. */
function markdown(source) {
  const parts = String(source).split(/```/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        const body = part.replace(/^[^\n]*\n/, '');
        return `<pre><code>${escapeHtml(body)}</code></pre>`;
      }
      return escapeHtml(part)
        .split(/\n{2,}/)
        .map((block) => {
          let html = block
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
            .replace(
              /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
              '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
            );
          const heading = /^(#{1,3})\s+(.*)$/.exec(html);
          if (heading) return `<h3>${heading[2]}</h3>`;
          const lines = html.split('\n');
          if (lines.every((line) => /^\s*([-*]|\d+\.)\s+/.test(line))) {
            const ordered = /^\s*\d+\./.test(lines[0]);
            const items = lines
              .map((line) => `<li>${line.replace(/^\s*([-*]|\d+\.)\s+/, '')}</li>`)
              .join('');
            return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
          }
          html = lines.join('<br>');
          return html.trim() ? `<p>${html}</p>` : '';
        })
        .join('');
    })
    .join('');
}
function relativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ms).toLocaleDateString();
}
const baseName = (p) =>
  String(p || '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() ||
  p ||
  '未绑定文件夹';

// ---------- API ----------
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 401) throw Object.assign(new Error('login_required'), { status: 401 });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(new Error(body.error || response.statusText), { status: response.status });
  return body;
}

// ---------- machine connection ----------
class MachineLink {
  constructor(machine, onPush, onState) {
    this.machine = machine;
    this.onPush = onPush;
    this.onState = onState;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.connect();
  }
  connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${scheme}://${location.host}/ws/client?machine=${encodeURIComponent(this.machine.id)}`
    );
    this.ws = ws;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    ws.onmessage = (message) => {
      const frame = JSON.parse(message.data);
      if (frame.t === 'ready') {
        this.label = frame.label;
        this.resolveReady();
        this.onState('online');
      } else if (frame.t === 'res') {
        const waiting = this.pending.get(frame.id);
        if (!waiting) return;
        this.pending.delete(frame.id);
        if (frame.ok) waiting.resolve(frame.value);
        else
          waiting.reject(
            Object.assign(new Error(frame.error?.message || '失败'), { code: frame.error?.code })
          );
      } else if (frame.t === 'push') this.onPush(frame.event, frame.data);
      else if (frame.t === 'machine.offline') this.onState('offline');
      else if (frame.t === 'machine.online') this.onState('online');
    };
    ws.onclose = (event) => {
      for (const waiting of this.pending.values()) waiting.reject(new Error('连接断开了'));
      this.pending.clear();
      if (this.closed) return;
      this.onState(event.code === 4404 ? 'offline' : 'reconnecting');
      setTimeout(() => !this.closed && this.connect(), 2000);
    };
  }
  async call(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ t: 'rpc', id, method, params }));
    });
  }
  close() {
    this.closed = true;
    this.ws?.close();
  }
}

// ---------- state ----------
const state = {
  view: 'loading',
  machines: [],
  machine: null,
  link: null,
  sessions: [],
  chat: null,
  linkState: 'online',
};

function go(view) {
  state.view = view;
  render();
}

// ---------- chat model ----------
function newChat(session) {
  return {
    session,
    messages: [],
    status: 'idle',
    permissions: new Map(),
    questions: new Map(),
    control: { holder: 'desktop', label: '桌面' },
    hasMore: false,
    loaded: 0,
    needsResume: false,
  };
}
function historyToMessages(page) {
  const out = [];
  for (const message of page?.messages || []) {
    const blocks = [];
    for (const block of message.blocks || []) {
      if (block.type === 'text')
        blocks.push({ kind: 'text', id: block.id, text: block.text || '' });
      else if (block.type === 'thinking')
        blocks.push({ kind: 'thinking', id: block.id, text: block.text || '' });
      else if (block.type === 'tool_call')
        blocks.push({
          kind: 'tool',
          toolCallId: block.toolCallId,
          name: block.presentation?.title || block.name,
          input: block.input,
          state: 'ok',
        });
      else if (block.type === 'tool_result') {
        const tool = blocks.find((b) => b.kind === 'tool' && b.toolCallId === block.toolCallId);
        if (tool) tool.state = block.ok === false ? 'err' : 'ok';
      }
    }
    out.push({ key: message.id, liveId: message.liveMessageId, role: message.role, blocks });
  }
  return out;
}
function findMessage(chat, messageId) {
  return chat.messages.find((m) => m.liveId === messageId || m.key === messageId);
}
function applyEvent(chat, event) {
  const p = event.payload || {};
  switch (event.type) {
    case 'session.status':
      chat.status = p.status;
      if (!BUSY.has(p.status)) {
        chat.permissions.clear();
        chat.questions.clear();
        for (const m of chat.messages)
          for (const b of m.blocks) if (b.kind === 'tool' && b.state === 'run') b.state = 'ok';
      }
      break;
    case 'message.started': {
      const existing = findMessage(chat, p.messageId);
      if (existing) existing.blocks = [];
      else
        chat.messages.push({
          key: p.messageId,
          liveId: p.messageId,
          role: p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : 'system',
          blocks: [],
        });
      break;
    }
    case 'message.delta':
    case 'thinking.delta': {
      const message = findMessage(chat, p.messageId);
      if (!message) break;
      const kind = event.type === 'message.delta' ? 'text' : 'thinking';
      let block = message.blocks.find((b) => b.kind === kind && b.id === p.blockId);
      if (!block) {
        block = { kind, id: p.blockId, text: '' };
        message.blocks.push(block);
      }
      block.text += p.text || '';
      break;
    }
    case 'tool.started': {
      const message = findMessage(chat, p.messageId);
      if (
        !message ||
        message.blocks.some((b) => b.kind === 'tool' && b.toolCallId === p.toolCallId)
      )
        break;
      message.blocks.push({
        kind: 'tool',
        toolCallId: p.toolCallId,
        name: p.presentation?.title || p.name,
        input: p.input,
        state: 'run',
      });
      break;
    }
    case 'tool.completed': {
      for (const m of chat.messages)
        for (const b of m.blocks)
          if (b.kind === 'tool' && b.toolCallId === p.toolCallId)
            b.state = p.ok === false ? 'err' : 'ok';
      break;
    }
    case 'permission.requested':
      chat.permissions.set(p.permissionId, p);
      break;
    case 'permission.resolved':
      chat.permissions.delete(p.permissionId);
      break;
    case 'question.requested':
      chat.questions.set(p.questionId, p);
      break;
    case 'question.resolved':
      chat.questions.delete(p.questionId);
      break;
    case 'session.history':
      if (p.mode !== 'older') {
        chat.messages = historyToMessages(p);
        chat.hasMore = Boolean(p.hasMore);
        chat.loaded = (p.messages || []).length;
        chat.needsResume = false;
      }
      break;
    default:
      return false;
  }
  return true;
}

// ---------- views ----------
function top(title, sub, left, right) {
  return h(
    'div',
    { class: 'top' },
    left,
    h('h1', {}, title, sub ? h('span', { class: 'sub' }, `  ${sub}`) : null),
    right
  );
}

function viewLogin() {
  const input = h('input', {
    class: 'input',
    type: 'password',
    placeholder: '登录口令',
    autocomplete: 'current-password',
  });
  const error = h('div', { class: 'error' });
  const button = h('button', { class: 'btn primary', type: 'submit' }, '登录');
  const form = h(
    'form',
    {
      class: 'login',
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        error.textContent = '';
        try {
          await api('/api/login', {
            method: 'POST',
            body: JSON.stringify({ password: input.value }),
          });
          await loadMachines();
        } catch (err) {
          error.textContent = err.status === 429 ? '错误次数太多，10 分钟后再试' : '口令不对';
        } finally {
          button.disabled = false;
        }
      },
    },
    h('h2', {}, 'PiLab'),
    h('div', { style: 'color:var(--muted-foreground)' }, '输入中转服务器启动时显示的登录口令'),
    input,
    error,
    button
  );
  setTimeout(() => input.focus(), 0);
  return [form];
}

function viewMachines() {
  const logout = h(
    'button',
    {
      class: 'icon-btn',
      title: '退出登录',
      onclick: async () => {
        await api('/api/logout', { method: 'POST' }).catch(() => {});
        go('login');
      },
    },
    icon('logout')
  );
  const list = state.machines.length
    ? h(
        'div',
        { class: 'list' },
        state.machines.map((m) =>
          h(
            'button',
            { class: 'row', onclick: () => openMachine(m) },
            h('span', { class: 'dot' }),
            h('span', { class: 't' }, m.name),
            h('span', { class: 'meta' }, m.clients ? `${m.clients} 台设备在用` : '')
          )
        )
      )
    : h(
        'div',
        { class: 'empty' },
        '还没有机器连上来。',
        h('br'),
        '在 PiLab 的 设置 → 插件 里装上「手机远程」，填上这台中转的地址和接入口令。'
      );
  return [top('机器', '', null, logout), h('div', { class: 'scroll' }, list)];
}

function viewSessions() {
  const back = h(
    'button',
    {
      class: 'icon-btn',
      title: '返回',
      onclick: () => {
        state.link?.close();
        state.link = null;
        loadMachines();
      },
    },
    icon('back')
  );
  const add = h(
    'button',
    { class: 'icon-btn', title: '新对话', onclick: () => go('newChat') },
    icon('plus')
  );
  const groups = new Map();
  for (const s of [...state.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
    const key = s.workspacePath || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const list = h('div', { class: 'list' });
  for (const [path, sessions] of groups) {
    list.append(
      h('div', { class: 'group', title: path }, s0(sessions).unbound ? '临时对话' : baseName(path))
    );
    for (const s of sessions)
      list.append(
        h(
          'button',
          { class: 'row', onclick: () => openChat(s) },
          h('span', { class: 't' }, s.title || '新对话'),
          h('span', { class: 'meta' }, relativeTime(s.updatedAt))
        )
      );
  }
  const banner =
    state.linkState !== 'online'
      ? h(
          'div',
          { class: 'banner' },
          state.linkState === 'offline' ? '这台机器现在不在线' : '正在重新连接…'
        )
      : null;
  return [
    top(state.machine.name, '', back, add),
    banner,
    h(
      'div',
      { class: 'scroll' },
      state.sessions.length ? list : h('div', { class: 'empty' }, '这台机器上还没有对话')
    ),
  ];
}
const s0 = (list) => list[0] || {};

function viewNewChat() {
  const back = h(
    'button',
    { class: 'icon-btn', title: '返回', onclick: () => go('sessions') },
    icon('back')
  );
  const folders = [
    ...new Set(
      state.sessions.filter((s) => !s.unbound && s.workspacePath).map((s) => s.workspacePath)
    ),
  ];
  const list = h(
    'div',
    { class: 'list' },
    h('div', { class: 'group' }, '在哪个文件夹里开新对话'),
    folders.map((path) =>
      h(
        'button',
        {
          class: 'row',
          title: path,
          onclick: async () => {
            try {
              const { sessionId } = await state.link.call('createSession', { workspacePath: path });
              await refreshSessions();
              const session = state.sessions.find((s) => s.sessionId === sessionId) || {
                sessionId,
                title: '新对话',
                workspacePath: path,
              };
              await openChat(session);
            } catch (err) {
              toast(err.message);
            }
          },
        },
        h('span', { class: 't' }, baseName(path)),
        h('span', { class: 'meta' }, path)
      )
    )
  );
  return [
    top('新对话', '', back, null),
    h(
      'div',
      { class: 'scroll' },
      folders.length
        ? list
        : h('div', { class: 'empty' }, '这台机器上还没有绑定文件夹的对话，先在电脑上开一个')
    ),
  ];
}

function toolArg(input) {
  if (!input || typeof input !== 'object') return '';
  const value =
    input.command ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.url ??
    input.query ??
    Object.values(input)[0];
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function renderTimeline(chat) {
  const box = h('div', { class: 'timeline' });
  if (chat.hasMore)
    box.append(
      h('button', { class: 'btn ghost small older', onclick: () => loadOlder() }, '更早的消息')
    );
  for (const message of chat.messages) {
    if (message.role === 'user') {
      const text = message.blocks
        .filter((b) => b.kind === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text) box.append(h('div', { class: 'msg-user' }, text));
      continue;
    }
    if (message.role === 'system') {
      const text = message.blocks
        .filter((b) => b.kind === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text) box.append(h('div', { class: 'notice' }, text));
      continue;
    }
    let process = null;
    for (const block of message.blocks) {
      if (block.kind === 'thinking') {
        process = null;
        if (block.text.trim())
          box.append(
            h('details', { class: 'thinking' }, h('summary', {}, '思考'), h('div', {}, block.text))
          );
      } else if (block.kind === 'tool') {
        if (!process) {
          process = h('div', { class: 'process' });
          box.append(process);
        }
        const mark =
          block.state === 'run'
            ? h('span', { class: 'mark' }, h('span', { class: 'spin' }))
            : h('span', { class: `mark ${block.state}` }, block.state === 'err' ? '✕' : '✓');
        process.append(
          h(
            'div',
            { class: 'tool' },
            mark,
            h('span', { class: 'name' }, block.name),
            h('span', { class: 'arg' }, toolArg(block.input))
          )
        );
      } else if (block.kind === 'text' && block.text.trim()) {
        process = null;
        box.append(h('div', { class: 'msg-assistant', html: markdown(block.text) }));
      }
    }
  }
  if (BUSY.has(chat.status) && !chat.permissions.size && !chat.questions.size)
    box.append(
      h(
        'div',
        { class: 'working' },
        h('span', { class: 'spin' }),
        chat.status === 'stopping' ? '正在停止…' : '正在工作…'
      )
    );
  return box;
}

function permissionCard(chat, p, canAnswer) {
  const decisions = p.decisions?.length
    ? p.decisions.filter((d) => d !== 'cancel')
    : ['allow', 'allow_session', 'deny'];
  const detail = p.input ? JSON.stringify(p.input, null, 2).slice(0, 1500) : '';
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'h' }, `需要批准：${p.action?.title || p.toolName}`),
    h('div', { class: 'b' }, p.description || p.reason || '', detail ? h('pre', {}, detail) : null),
    h(
      'div',
      { class: 'f' },
      canAnswer
        ? decisions.map((decision, i) =>
            h(
              'button',
              {
                class: `btn small ${i === 0 ? 'primary' : ''}`,
                onclick: () => respondPermission(p.permissionId, decision),
              },
              DECISION_LABELS[decision] || decision
            )
          )
        : h(
            'span',
            { style: 'color:var(--muted-foreground);font-size:13px' },
            `在 ${chat.control.label} 上回答，或先接管`
          )
    )
  );
}

function questionCard(chat, q, canAnswer) {
  if (q.review) {
    const choices = q.review.choices?.length
      ? q.review.choices
      : ['goal:auto', 'goal:bypass', 'run:auto', 'keep-planning'];
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'h' }, `计划审阅${q.review.title ? `：${q.review.title}` : ''}`),
      h(
        'div',
        { class: 'b' },
        h(
          'details',
          {},
          h('summary', {}, '看计划'),
          h('div', {
            class: 'msg-assistant',
            html: markdown(q.review.plan || q.review.objective || ''),
          })
        )
      ),
      h(
        'div',
        { class: 'f' },
        canAnswer
          ? choices.map((choice, i) =>
              h(
                'button',
                {
                  class: `btn small ${i === 0 ? 'primary' : ''}`,
                  onclick: () =>
                    respondQuestion(q.questionId, { answers: { 'plan-review': choice } }),
                },
                PLAN_LABELS[choice] || choice
              )
            )
          : h(
              'span',
              { style: 'color:var(--muted-foreground);font-size:13px' },
              `在 ${chat.control.label} 上回答，或先接管`
            )
      )
    );
  }
  const picked = new Map();
  const other = new Map();
  const body = h('div', { class: 'b' });
  for (const item of q.questions || []) {
    const key = item.id ?? item.question;
    picked.set(key, new Set());
    body.append(h('div', { class: 'qtitle' }, item.question));
    for (const option of item.options || []) {
      const button = h(
        'button',
        {
          class: 'option',
          disabled: !canAnswer,
          onclick: () => {
            const set = picked.get(key);
            if (!item.multiSelect) {
              set.clear();
              for (const el of button.parentElement.querySelectorAll(
                `[data-q="${CSS.escape(key)}"]`
              ))
                el.classList.remove('sel');
            }
            if (set.has(option.label)) {
              set.delete(option.label);
              button.classList.remove('sel');
            } else {
              set.add(option.label);
              button.classList.add('sel');
            }
          },
          'data-q': key,
        },
        option.label,
        option.description ? h('small', {}, option.description) : null
      );
      body.append(button);
    }
    const input = h('input', {
      class: 'input',
      placeholder: '或者自己写',
      disabled: !canAnswer,
      style: 'margin-bottom:6px',
    });
    other.set(key, input);
    body.append(input);
  }
  const submit = () => {
    const answers = {};
    for (const [key, set] of picked) {
      const typed = other.get(key)?.value.trim();
      const value = typed || [...set].join(', ');
      if (value) answers[key] = value;
    }
    respondQuestion(q.questionId, { answers });
  };
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'h' }, '有问题要你回答'),
    body,
    h(
      'div',
      { class: 'f' },
      canAnswer
        ? [
            h('button', { class: 'btn small primary', onclick: submit }, '提交'),
            h(
              'button',
              {
                class: 'btn small ghost',
                onclick: () => respondQuestion(q.questionId, { cancel: true }),
              },
              '跳过'
            ),
          ]
        : h(
            'span',
            { style: 'color:var(--muted-foreground);font-size:13px' },
            `在 ${chat.control.label} 上回答，或先接管`
          )
    )
  );
}

function viewChat() {
  const chat = state.chat;
  const back = h(
    'button',
    {
      class: 'icon-btn',
      title: '返回',
      onclick: () => {
        state.chat = null;
        refreshSessions().then(() => go('sessions'));
      },
    },
    icon('back')
  );
  const scroller = h('div', { class: 'scroll' }, renderTimeline(chat));
  const mine = chat.control.holder === 'me';
  const busy = BUSY.has(chat.status);
  const bottom = h('div', { class: 'bottom' });
  for (const p of chat.permissions.values()) bottom.append(permissionCard(chat, p, mine));
  if (!chat.permissions.size)
    for (const q of chat.questions.values()) bottom.append(questionCard(chat, q, mine));
  if (chat.needsResume) {
    bottom.append(
      h(
        'div',
        { class: 'bar' },
        h('span', { class: 't' }, '这个对话还没打开'),
        h('button', { class: 'btn primary small', onclick: () => resumeChat() }, '打开')
      )
    );
  } else if (!mine) {
    bottom.append(
      h(
        'div',
        { class: 'bar' },
        h(
          'span',
          { class: 't' },
          '正在 ',
          h('b', {}, chat.control.label),
          ' 上使用，这里只能看进度'
        ),
        busy
          ? h(
              'button',
              { class: 'btn ghost small', onclick: () => stopChat() },
              icon('stop'),
              '停止'
            )
          : null,
        h('button', { class: 'btn primary small', onclick: () => takeOver() }, icon('hand'), '接管')
      )
    );
  } else if (!chat.permissions.size && !chat.questions.size) {
    const textarea = h('textarea', {
      rows: 1,
      placeholder: busy ? '补充说明，发给正在进行的这一轮…' : '回复…',
      oninput: () => {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
      },
    });
    textarea.value = chat.draft || '';
    textarea.addEventListener('input', () => {
      chat.draft = textarea.value;
    });
    const sendButton = h(
      'button',
      { class: 'round', title: '发送', onclick: () => sendMessage(textarea) },
      icon('send')
    );
    bottom.append(
      h(
        'div',
        { class: 'composer' },
        textarea,
        busy
          ? h(
              'button',
              { class: 'round stop', title: '停止', onclick: () => stopChat() },
              icon('stop')
            )
          : null,
        sendButton
      )
    );
  }
  const banner =
    state.linkState !== 'online'
      ? h(
          'div',
          { class: 'banner' },
          state.linkState === 'offline' ? '这台机器现在不在线' : '正在重新连接…'
        )
      : null;
  return [
    top(chat.session.title || '新对话', baseName(chat.session.workspacePath), back, null),
    banner,
    scroller,
    bottom,
  ];
}

let renderQueued = false;
function render() {
  const scroller = app.querySelector('.scroll');
  const nearBottom =
    !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const focused = document.activeElement?.tagName === 'TEXTAREA';
  const views = {
    login: viewLogin,
    machines: viewMachines,
    sessions: viewSessions,
    newChat: viewNewChat,
    chat: viewChat,
  };
  app.replaceChildren(...(views[state.view]?.() ?? [h('div', { class: 'empty' }, '正在加载…')]));
  if (state.view === 'chat') {
    const next = app.querySelector('.scroll');
    if (next && nearBottom) next.scrollTop = next.scrollHeight;
    if (focused) app.querySelector('textarea')?.focus();
  }
}
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// ---------- actions ----------
async function loadMachines() {
  try {
    state.machines = await api('/api/machines');
    go('machines');
  } catch (err) {
    go(err.status === 401 ? 'login' : 'machines');
  }
}

function onPush(event, data) {
  const chat = state.chat;
  if (event === 'chat' && chat && data?.event?.sessionId === chat.session.sessionId) {
    if (applyEvent(chat, data.event)) scheduleRender();
  } else if (event === 'control' && chat && data.sessionId === chat.session.sessionId) {
    chat.control = data;
    scheduleRender();
  }
}

async function openMachine(machine) {
  state.machine = machine;
  state.link?.close();
  state.link = new MachineLink(machine, onPush, (linkState) => {
    const wasOnline = state.linkState === 'online';
    state.linkState = linkState;
    if (linkState === 'online' && !wasOnline && state.chat) void openChat(state.chat.session, true);
    scheduleRender();
  });
  state.sessions = [];
  go('sessions');
  await refreshSessions();
}

async function refreshSessions() {
  try {
    state.sessions = await state.link.call('listSessions');
  } catch (err) {
    toast(err.message);
  }
  if (state.view === 'sessions') render();
}

async function openChat(session, keepDraft = false) {
  const draft = keepDraft ? state.chat?.draft : undefined;
  const chat = newChat(session);
  chat.draft = draft;
  state.chat = chat;
  go('chat');
  try {
    const opened = await state.link.call('openSession', { sessionId: session.sessionId });
    if (state.chat !== chat) return;
    chat.control = opened.control;
    chat.needsResume = opened.needsResume;
    if (opened.history) {
      chat.messages = historyToMessages(opened.history);
      chat.hasMore = opened.history.hasMore;
      chat.loaded = opened.history.messages.length;
    }
    const snap = opened.snapshot;
    if (snap.status) chat.status = snap.status;
    for (const entry of snap.turn) applyEvent(chat, entry.event);
    for (const p of snap.pendingPermissions)
      chat.permissions.set(p.payload.permissionId, p.payload);
    for (const q of snap.pendingQuestions) chat.questions.set(q.payload.questionId, q.payload);
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function loadOlder() {
  const chat = state.chat;
  try {
    const page = await state.link.call('olderHistory', {
      sessionId: chat.session.sessionId,
      offset: chat.loaded,
    });
    chat.messages = [...historyToMessages(page), ...chat.messages];
    chat.loaded += page.messages.length;
    chat.hasMore = page.hasMore;
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function resumeChat() {
  try {
    await state.link.call('resumeSession', { sessionId: state.chat.session.sessionId });
    await openChat(state.chat.session, true);
  } catch (err) {
    toast(err.message);
  }
}

async function takeOver() {
  try {
    state.chat.control = await state.link.call('takeOver', {
      sessionId: state.chat.session.sessionId,
    });
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function stopChat() {
  try {
    await state.link.call('stop', { sessionId: state.chat.session.sessionId });
  } catch (err) {
    toast(err.message);
  }
}

async function sendMessage(textarea) {
  const chat = state.chat;
  const text = textarea.value.trim();
  if (!text) return;
  textarea.value = '';
  chat.draft = '';
  try {
    await state.link.call(BUSY.has(chat.status) ? 'interject' : 'send', {
      sessionId: chat.session.sessionId,
      text,
    });
  } catch (err) {
    chat.draft = text;
    toast(err.code === 'session_controlled_elsewhere' ? '对话正在别处使用，先接管' : err.message);
    render();
  }
}

async function respondPermission(permissionId, decision) {
  try {
    await state.link.call('respondPermission', {
      sessionId: state.chat.session.sessionId,
      permissionId,
      decision,
    });
  } catch (err) {
    toast(err.message);
  }
}
async function respondQuestion(questionId, payload) {
  try {
    await state.link.call('respondQuestion', {
      sessionId: state.chat.session.sessionId,
      questionId,
      ...payload,
    });
  } catch (err) {
    toast(err.message);
  }
}

render();
loadMachines();
