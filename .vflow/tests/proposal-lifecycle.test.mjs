// proposal-lifecycle.test.mjs — vflow3 invariant tests.
// Run with: node --test tests/proposal-lifecycle.test.mjs

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..', 'scripts');
const CLI = join(SCRIPTS_DIR, 'dist', 'proposal.js');
const VFLOW_ROOT = join(__dirname, '..');
const PROPOSALS_DIR = join(VFLOW_ROOT, 'proposals');
const REPO_INDEX = join(VFLOW_ROOT, 'repo.json');
const SESSIONS_DIR = join(VFLOW_ROOT, 'runtime', 'sessions');

// Combines stdout+stderr regardless of exit code, so gate warnings (which go to
// stderr via console.error, e.g. corrupt-JSON) are visible to assertions too.
function run(...args) {
  const lastArg = args[args.length - 1];
  let extraEnv = {};
  let stdinInput = undefined;
  if (lastArg && typeof lastArg === 'object' && !Array.isArray(lastArg)) {
    args.pop();
    if ('input' in lastArg || 'env' in lastArg) {
      stdinInput = lastArg.input;
      extraEnv = lastArg.env || {};
    } else {
      extraEnv = lastArg;
    }
  }
  const result = spawnSync('node', [CLI, ...args], {
    cwd: join(VFLOW_ROOT, '..'),
    encoding: 'utf-8',
    input: stdinInput,
    env: { ...process.env, CLAUDE_SESSION_ID: 'test-session-001', ...extraEnv },
  });
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

const TEST_ACCEPT_OPTS = { input: 'yes\n' };

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function findDir(id) {
  for (const name of readdirSync(PROPOSALS_DIR)) {
    if (name.startsWith(id)) return join(PROPOSALS_DIR, name);
  }
  return null;
}

function cleanState() {
  if (existsSync(PROPOSALS_DIR)) rmSync(PROPOSALS_DIR, { recursive: true, force: true });
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  mkdirSync(join(PROPOSALS_DIR, 'archive'), { recursive: true });
  if (existsSync(SESSIONS_DIR)) rmSync(SESSIONS_DIR, { recursive: true, force: true });
  writeJson(REPO_INDEX, { schema_version: 1, proposals: [] });
}

function createAndGetDir(slug, opts = {}) {
  const title = opts.title || slug;
  const type = opts.type || 'feature';
  const tier = opts.tier || 'T2';
  const out = run('create', slug, '--title', title, '--type', type, '--tier', tier);
  const id = out.match(/P-\d{8}-\d{3}/)?.[0];
  if (!id) throw new Error(`Failed to create proposal: ${out}`);
  return { id, dir: findDir(id) };
}

// Hand-writes a ledger.md transition entry the way the AI would, per the two-file
// model: the CLI only writes the initial header, every transition after that is
// authored via Write/Edit.
function appendLedger(dir, from, to, satisfied) {
  appendFileSync(
    join(dir, 'ledger.md'),
    `\n## [${new Date().toISOString()}] ${from} -> ${to}\n- Satisfied: ${satisfied}\n`,
    'utf-8',
  );
}

// Drives a freshly-created proposal from `understand` to `build`, hand-writing the
// ledger entries a real session would write along the way. For T3, also writes the
// decide -> decide self-loop reconfirmation (Hard Gate 1a).
function advanceToBuild(dir, opts = {}) {
  const tier = opts.tier || 'T2';
  run('move', '--to', 'decide');
  appendLedger(dir, 'understand', 'decide', 'moved to decide');
  if (tier === 'T3') {
    appendLedger(dir, 'decide', 'decide', 'design approved by user in conversation; confirmed_by_user:true');
  }
  run('spec-ref', 'none', '--reason', 'no relevant spec for this test');
  const out = run('move', '--to', 'build', '--scope', 'test scope statement');
  appendLedger(dir, 'decide', 'build', 'entered build');
  return out;
}

function advanceToDone(dir) {
  run('item', 'add', '--title', 'Do the thing');
  run('item', 'start', '--item', 'E-001');
  run('item', 'complete', '--item', 'E-001', '--note', 'done');
  run('move', '--to', 'check');
  appendLedger(dir, 'build', 'check', 'moved to check');
  run('accept', TEST_ACCEPT_OPTS);
  appendLedger(dir, 'check', 'done', 'accepted');
}

describe('vflow3 proposal lifecycle', () => {
  beforeEach(() => cleanState());

  test('1. T2 full lifecycle: understand -> decide -> build -> check -> done -> archived', () => {
    const { id, dir } = createAndGetDir('test-full', { title: 'Full lifecycle test' });

    let state = readJson(join(dir, 'state.json'));
    assert.equal(state.pointer, 'understand');
    assert.deepEqual(state.history_stack, ['understand']);

    assert.match(advanceToBuild(dir), /Moved: decide -> build/);
    state = readJson(join(dir, 'state.json'));
    assert.equal(state.pointer, 'build');
    assert.equal(state.scope, 'test scope statement');
    assert.deepEqual(state.spec_refs, [{ file: 'none', reason: 'no relevant spec for this test' }]);

    advanceToDone(dir);
    state = readJson(join(dir, 'state.json'));
    assert.equal(state.pointer, 'done');
    assert.equal(state.items[0].status, 'done');

    const proposal = readJson(join(dir, 'proposal.json'));
    assert.equal(proposal.lifecycle_status, 'done');

    run('knowledge', 'skip');
    const archiveOut = run('archive');
    assert.match(archiveOut, /Archived P-\d{8}-\d{3} to/);
    assert.equal(findDir(id), null); // moved out of proposals/

    const index = readJson(REPO_INDEX);
    const entry = index.proposals.find(p => p.id === id);
    assert.equal(entry.lifecycle_status, 'archived');
  });

  test('2. T3 requires a decide -> decide self-loop with confirmed_by_user:true before build', () => {
    const { dir } = createAndGetDir('test-t3-gate', { tier: 'T3' });
    run('move', '--to', 'decide');
    appendLedger(dir, 'understand', 'decide', 'moved to decide');
    run('spec-ref', 'none', '--reason', 'n/a');

    // No self-loop at all.
    let out = run('move', '--to', 'build', '--scope', 'x');
    assert.match(out, /Hard Gate 1a, T3 design reconfirmation/);
    assert.equal(readJson(join(dir, 'state.json')).pointer, 'decide');

    // Self-loop present but missing the literal marker.
    appendLedger(dir, 'decide', 'decide', 'user glanced at it');
    out = run('move', '--to', 'build', '--scope', 'x');
    assert.match(out, /Hard Gate 1a, T3 design reconfirmation/);

    // Correct self-loop with the marker.
    appendLedger(dir, 'decide', 'decide', 'approved in conversation; confirmed_by_user:true');
    out = run('move', '--to', 'build', '--scope', 'x');
    assert.match(out, /Moved: decide -> build/);
    assert.equal(readJson(join(dir, 'state.json')).pointer, 'build');
  });

  test('3. T2 does not require design reconfirmation before build', () => {
    const { dir } = createAndGetDir('test-t2-no-gate', { tier: 'T2' });
    run('move', '--to', 'decide');
    appendLedger(dir, 'understand', 'decide', 'moved to decide');
    run('spec-ref', 'none', '--reason', 'n/a');
    const out = run('move', '--to', 'build', '--scope', 'x');
    assert.match(out, /Moved: decide -> build/);
  });

  test('4. move rejects skipping ahead (understand -> build directly)', () => {
    createAndGetDir('test-skip-ahead');
    const out = run('move', '--to', 'build', '--scope', 'x');
    assert.match(out, /not the next node and not present in history_stack/);
  });

  test('5. move allows backward jump into history_stack; rejects a never-visited non-next node', () => {
    const { dir } = createAndGetDir('test-backward');
    advanceToBuild(dir);
    assert.equal(readJson(join(dir, 'state.json')).pointer, 'build');

    const backOut = run('move', '--to', 'understand');
    assert.match(backOut, /Moved: build -> understand/);
    assert.equal(readJson(join(dir, 'state.json')).pointer, 'understand');

    appendLedger(dir, 'build', 'understand', 'reopened understand');
    const rejectOut = run('move', '--to', 'check');
    assert.match(rejectOut, /not the next node and not present in history_stack/);
  });

  test('6. move --to done is rejected — must use accept', () => {
    createAndGetDir('test-move-done');
    const out = run('move', '--to', 'done');
    assert.match(out, /Cannot move to done via `move` — use `accept`/);
  });

  test('7. move to the current pointer is rejected — self-loop is hand-written, not moved', () => {
    createAndGetDir('test-self-loop');
    const out = run('move', '--to', 'understand');
    assert.match(out, /hand-written directly into ledger\.md, not via move/);
  });

  test('8. Hard Gate 1: build entry requires both --scope and spec_refs', () => {
    const { dir } = createAndGetDir('test-gate1');
    run('move', '--to', 'decide');
    appendLedger(dir, 'understand', 'decide', 'moved to decide');

    let out = run('move', '--to', 'build');
    assert.match(out, /Hard Gate 1/);
    assert.match(out, /scope is empty/);
    assert.match(out, /spec_refs is empty/);

    run('spec-ref', 'add', '--file', 'src/foo.ts', '--reason', 'relevant');
    out = run('move', '--to', 'build');
    assert.match(out, /Hard Gate 1/);
    assert.match(out, /scope is empty/);
    assert.doesNotMatch(out, /spec_refs is empty/);

    out = run('move', '--to', 'build', '--scope', 'the actual scope');
    assert.match(out, /Moved: decide -> build/);
  });

  test('9. ledger-catchup gate blocks move until the prior transition is hand-written', () => {
    const { dir } = createAndGetDir('test-catchup');
    run('move', '--to', 'decide'); // history_stack.length was 1 pre-move: no catchup check yet
    run('spec-ref', 'none', '--reason', 'n/a');

    // No ledger entry written yet for understand -> decide.
    let out = run('move', '--to', 'build', '--scope', 'x');
    assert.match(out, /ledger\.md is not caught up/);
    assert.match(out, /expected the last transition entry to end at 'decide'/);
    assert.match(out, /no transition entries/);
    assert.equal(readJson(join(dir, 'state.json')).pointer, 'decide');

    appendLedger(dir, 'understand', 'decide', 'moved to decide');
    out = run('move', '--to', 'build', '--scope', 'x');
    assert.match(out, /Moved: decide -> build/);
  });

  test('10. accept requires pointer == check', () => {
    const { dir } = createAndGetDir('test-accept-pointer');
    advanceToBuild(dir); // pointer is 'build', not 'check'
    const out = run('accept', TEST_ACCEPT_OPTS);
    assert.match(out, /Cannot accept: pointer is at 'build', expected 'check'/);
  });

  test('11. accept without confirmation (non-TTY, no stdin) is rejected', () => {
    const { dir } = createAndGetDir('test-accept-noconfirm');
    advanceToBuild(dir);
    advanceToDoneUpToCheck(dir);
    const out = run('accept');
    assert.match(out, /REJECTED: accept must be confirmed by user/);
    assert.equal(readJson(join(dir, 'proposal.json')).lifecycle_status, 'active');
  });

  test('12. accept confirmed via stdin yes succeeds; no rejects', () => {
    const { dir } = createAndGetDir('test-accept-stdin');
    advanceToBuild(dir);
    advanceToDoneUpToCheck(dir);

    let out = run('accept', { input: 'no\n' });
    assert.match(out, /REJECTED/);
    assert.equal(readJson(join(dir, 'proposal.json')).lifecycle_status, 'active');

    out = run('accept', TEST_ACCEPT_OPTS);
    assert.match(out, /Accepted\. Proposal .* is now done\./);
    assert.equal(readJson(join(dir, 'proposal.json')).lifecycle_status, 'done');
    assert.equal(readJson(join(dir, 'state.json')).pointer, 'done');
  });

  test('13. accept confirmation cannot be bypassed via arbitrary env vars', () => {
    const { dir } = createAndGetDir('test-accept-envbypass');
    advanceToBuild(dir);
    advanceToDoneUpToCheck(dir);
    const out = run('accept', { env: { VFLOW_AUTO_APPROVE: 'true', CI: 'true' } });
    assert.match(out, /REJECTED: accept must be confirmed by user/);
    assert.equal(readJson(join(dir, 'proposal.json')).lifecycle_status, 'active');
  });

  test('14. item lifecycle: serial one-doing-at-a-time, invalid transitions, not-found', () => {
    const { dir } = createAndGetDir('test-items');
    advanceToBuild(dir);

    run('item', 'add', '--title', 'First');
    run('item', 'add', '--title', 'Second');
    run('item', 'add', '--title', 'Third');

    assert.match(run('item', 'start', '--item', 'E-001'), /Started item E-001/);
    const blocked = run('item', 'start', '--item', 'E-002');
    assert.match(blocked, /Serial violation: item 'E-001' is already doing/);

    run('item', 'complete', '--item', 'E-001', '--note', 'done first');
    assert.equal(readJson(join(dir, 'state.json')).items[0].note, 'done first');

    assert.match(run('item', 'start', '--item', 'E-002'), /Started item E-002/);

    assert.match(run('item', 'complete', '--item', 'E-999'), /Item 'E-999' not found/);
    assert.match(run('item', 'complete', '--item', 'E-003'), /Cannot transition item from 'todo' to 'done'/);

    run('item', 'block', '--item', 'E-002', '--note', 'waiting on X');
    const state = readJson(join(dir, 'state.json'));
    assert.equal(state.items[1].status, 'blocked');
    assert.equal(state.items[1].note, 'waiting on X');

    assert.match(run('item', 'cancel', '--item', 'E-003'), /Cancelled item E-003/);
    assert.equal(readJson(join(dir, 'state.json')).items[2].status, 'cancelled');
  });

  test('15. T1 proposal has no state.json/ledger.md and skips all gates', () => {
    const { dir } = createAndGetDir('test-t1', { tier: 'T1' });
    assert.equal(existsSync(join(dir, 'state.json')), false);
    assert.equal(existsSync(join(dir, 'ledger.md')), false);

    assert.match(run('move', '--to', 'decide'), /T1 proposals have no state\.json\/pointer — nothing to move\./);
    assert.match(run('item', 'add', '--title', 'x'), /T1 proposals have no state\.json\/items\./);
    assert.match(run('spec-ref', 'none', '--reason', 'n/a'), /T1 proposals have no state\.json\/spec_refs\./);
    assert.match(run('checkpoint'), /T1 proposals have no ledger\.md — nothing to checkpoint\./);

    const acceptOut = run('accept', TEST_ACCEPT_OPTS);
    assert.match(acceptOut, /Accepted\. Proposal .* is now done\./);
    assert.equal(readJson(join(dir, 'proposal.json')).lifecycle_status, 'done');

    run('knowledge', 'skip');
    const archiveOut = run('archive');
    assert.match(archiveOut, /Archived P-\d{8}-\d{3} to/);
  });

  test('16. archive requires lifecycle_status=done, pointer=done, and knowledge_processed', () => {
    const { dir } = createAndGetDir('test-archive-gate');
    let out = run('archive');
    assert.match(out, /Cannot archive/);
    assert.match(out, /lifecycle_status is 'active', expected 'done'/);
    assert.match(out, /pointer is 'understand', expected 'done'/);
    assert.match(out, /Knowledge candidates not processed/);

    advanceToBuild(dir);
    advanceToDone(dir);

    out = run('archive');
    assert.match(out, /Cannot archive/);
    assert.doesNotMatch(out, /lifecycle_status is/);
    assert.doesNotMatch(out, /pointer is/);
    assert.match(out, /Knowledge candidates not processed/);

    run('knowledge', 'skip');
    out = run('archive');
    assert.match(out, /Archived P-\d{8}-\d{3} to/);
  });

  test('17. multiple proposals coexist independently in repo.json and on disk', () => {
    const a = createAndGetDir('test-multi-a', { title: 'Proposal A' });
    const b = createAndGetDir('test-multi-b', { title: 'Proposal B' }); // rebinds session to B

    run('move', '--to', 'decide', '--id', a.id);
    appendLedger(a.dir, 'understand', 'decide', 'A moves alone');

    const stateA = readJson(join(a.dir, 'state.json'));
    const stateB = readJson(join(b.dir, 'state.json'));
    assert.equal(stateA.pointer, 'decide');
    assert.equal(stateB.pointer, 'understand');

    const index = readJson(REPO_INDEX);
    assert.ok(index.proposals.find(p => p.id === a.id && p.title === 'Proposal A'));
    assert.ok(index.proposals.find(p => p.id === b.id && p.title === 'Proposal B'));

    const listOut = run('list');
    assert.match(listOut, new RegExp(`${a.id} \\[active\\] Proposal A`));
    assert.match(listOut, new RegExp(`${b.id} \\[active\\] Proposal B`));
  });

  test('18. session runtime is hint-only — corrupting it does not affect proposal truth', () => {
    const { dir } = createAndGetDir('test-session-hint');
    run('move', '--to', 'decide');
    appendLedger(dir, 'understand', 'decide', 'moved to decide');

    const sessionPath = join(SESSIONS_DIR, 'claude_test-session-001.json');
    const session = readJson(sessionPath);
    session.active_execution_item_id = 'E-999-does-not-exist';
    session.pending_user_confirmation = true;
    writeJson(sessionPath, session);

    const statusOut = run('status');
    assert.match(statusOut, /Pointer: decide/);
    assert.equal(readJson(join(dir, 'state.json')).pointer, 'decide');
  });

  test('19. corrupt proposal.json produces an explicit warning and a graceful error', () => {
    const { dir } = createAndGetDir('test-corrupt-json');
    writeFileSync(join(dir, 'proposal.json'), '{ this is not valid json', 'utf-8');
    const out = run('status');
    assert.match(out, /WARNING: corrupt JSON in .*proposal\.json/);
    assert.match(out, /Cannot read proposal\.json in/);
  });

  test('20. checkpoint prints a template block for the current pointer without mutating ledger.md', () => {
    const { dir } = createAndGetDir('test-checkpoint');
    run('move', '--to', 'decide');
    appendLedger(dir, 'understand', 'decide', 'moved to decide');
    const before = readFileSync(join(dir, 'ledger.md'), 'utf-8');

    const out = run('checkpoint');
    assert.match(out, /Checkpoint template/);
    assert.match(out, /CHECKPOINT @ decide/);
    assert.match(out, /已完成/);
    assert.match(out, /下一步/);

    const after = readFileSync(join(dir, 'ledger.md'), 'utf-8');
    assert.equal(before, after);
  });

  test('21. spec-ref add and none are mutually exclusive', () => {
    const { dir } = createAndGetDir('test-specref');
    run('move', '--to', 'decide');

    run('spec-ref', 'add', '--file', 'a.md', '--reason', 'r1');
    run('spec-ref', 'add', '--file', 'b.md', '--reason', 'r2');
    let state = readJson(join(dir, 'state.json'));
    assert.deepEqual(state.spec_refs, [{ file: 'a.md', reason: 'r1' }, { file: 'b.md', reason: 'r2' }]);

    run('spec-ref', 'none', '--reason', 'changed my mind');
    state = readJson(join(dir, 'state.json'));
    assert.deepEqual(state.spec_refs, [{ file: 'none', reason: 'changed my mind' }]);

    run('spec-ref', 'add', '--file', 'c.md', '--reason', 'r3');
    state = readJson(join(dir, 'state.json'));
    assert.deepEqual(state.spec_refs, [{ file: 'c.md', reason: 'r3' }]);
  });
});

// Drives a proposal already at `build` (with one completed item) up to `check`,
// hand-writing the matching ledger entry — shared by the accept-focused tests.
function advanceToDoneUpToCheck(dir) {
  run('item', 'add', '--title', 'Do the thing');
  run('item', 'start', '--item', 'E-001');
  run('item', 'complete', '--item', 'E-001', '--note', 'done');
  run('move', '--to', 'check');
  appendLedger(dir, 'build', 'check', 'moved to check');
}
