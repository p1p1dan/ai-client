import { translate } from '@shared/i18n';
import type { SessionTreeNode } from '@shared/types/sessionHistory';
import { describe, expect, it } from 'vitest';
import {
  type SidebarSessionRow,
  sidebarFolderNameForDisplay,
  sidebarRowForDisplay,
} from '@/components/workspace-shell/sidebarTree';
import { composerModelLabelParts, composerModelMenuModel } from '../composerModel';
import { localizeContextSummaryTitle } from '../dshTimelineRowModel';
import { CHAT_EFFORTS } from '../efforts';
import { describeHostStatus, type HostStatus } from '../hostStatus';
import { AUTOMATIC_MODEL_LABEL } from '../models';
import {
  BUNDLED_CATALOG_NOTICE,
  EMPTY_CATALOG_NOTICE,
  HOST_NOT_READY_CATALOG_NOTICE,
  MANAGED_EMPTY_CATALOG_NOTICE,
  REFRESHING_CATALOG_NOTICE,
  STALE_CATALOG_NOTICE,
  UNAVAILABLE_CATALOG_NOTICE,
} from '../piModelCatalog';
import { deriveRetryBanner, retryErrorLabel } from '../retryBanner';
import {
  displaySessionTitle,
  fallbackSessionTitle,
  isPlaceholderTitle,
  LEGACY_SEED_TITLE,
  NEW_CHAT_TITLE,
} from '../sessionIndex/sessionTitle';
import { sessionTreeNodeTag, sessionTreeNodeTitle } from '../sessionTree';
import { slashRowsForDisplay, slashSourceLabel } from '../slashCommands';

/**
 * dsh-rebase P1-7e group e4 (decision 144): the P1-7d point-check's English
 * and 1.0.x (pi) leftovers. Most of the new copy reaches `t()` through a TABLE
 * (effort levels, catalog notices, slash sources, retry classes, tree labels;
 * the sidebar's kind chips until decision 167 retired them), which
 * `i18nCoverage.test.ts` cannot see — it only reads literal
 * `t('…')` calls. This holds each table to a Chinese entry, and pins the
 * identifier-in, words-out behaviour of the pure helpers.
 */
const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
const CJK = /[一-鿿]/;

function expectChinese(text: string, what: string) {
  expect(CJK.test(text), `${what} → ${text}`).toBe(true);
}

describe('model menu (point-check problem 9: Automatic / Default / Low…)', () => {
  it('has Chinese for every reasoning level and its hint', () => {
    for (const effort of CHAT_EFFORTS) {
      expectChinese(zh(effort.label), effort.label);
      expectChinese(zh(effort.hint), effort.hint);
      expect(effort.hint).not.toMatch(/\bPi\b/);
    }
    expectChinese(zh(AUTOMATIC_MODEL_LABEL), AUTOMATIC_MODEL_LABEL);
  });

  it('builds the menu and the trigger suffix through the translator it is given', () => {
    const menu = composerModelMenuModel({
      options: [{ id: 'p/model-a', label: 'Model A' }],
      selectedModel: 'p/model-a',
      selectedEffort: 'high',
      t: zh,
    });
    const [models, efforts] = menu.sections;
    expect(models?.label).toBe('模型');
    expect(efforts?.label).toBe('推理强度');
    // A model's own name is never translated.
    expect(models?.items.map((item) => item.label)).toEqual(['Model A']);
    expect(efforts?.items[0]?.label).toBe('默认');
    for (const item of efforts?.items ?? []) expectChinese(item.label, item.id);
    expect(composerModelLabelParts({ modelLabel: 'Model A', effort: 'high' }, zh)).toEqual({
      base: 'Model A',
      suffix: '高',
    });
    // The English default is unchanged.
    expect(composerModelLabelParts({ modelLabel: 'Model A', effort: 'high' }).suffix).toBe('High');
  });

  it('has Chinese for every catalog notice the menu can show', () => {
    for (const notice of [
      UNAVAILABLE_CATALOG_NOTICE,
      STALE_CATALOG_NOTICE,
      BUNDLED_CATALOG_NOTICE,
      HOST_NOT_READY_CATALOG_NOTICE,
      EMPTY_CATALOG_NOTICE,
      MANAGED_EMPTY_CATALOG_NOTICE,
      REFRESHING_CATALOG_NOTICE,
    ]) {
      expectChinese(zh(notice), notice);
    }
  });
});

describe('slash menu source tags (problem 9: builtin / command)', () => {
  it('words every known source, and shows an unknown one as it came', () => {
    for (const source of ['builtin', 'command', 'skill', 'prompt', 'extension']) {
      expectChinese(slashSourceLabel(source, zh), source);
    }
    expect(slashSourceLabel('builtin', zh)).toBe('内置');
    expect(slashSourceLabel('command', zh)).toBe('命令');
    expect(slashSourceLabel('builtin')).toBe('Built in');
    expect(slashSourceLabel('mystery', zh)).toBe('mystery');
  });

  it('paints rows with the worded source and leaves the catalog item alone', () => {
    const catalog = [{ name: 'goal', description: 'Set a goal', source: 'command' }];
    expect(slashRowsForDisplay(catalog, zh)).toEqual([
      { name: 'goal', description: 'Set a goal', source: '命令' },
    ]);
    expect(catalog[0]?.source).toBe('command');
  });
});

describe('retry banner failure classes (problem 9: SERVER / TRANSPORT)', () => {
  it('words DSH’s retryable classes and the bridge’s `unknown`', () => {
    for (const code of ['SERVER', 'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT', 'EMPTY_RESPONSE']) {
      expectChinese(retryErrorLabel(code, zh), code);
      // English reads as words too, not as the upper-case class.
      expect(retryErrorLabel(code)).toMatch(/^[a-z ]+$/);
    }
    expectChinese(retryErrorLabel('unknown', zh), 'unknown');
    // English keeps the sentinel's own spelling (`retryBanner.test.ts` pins it).
    expect(retryErrorLabel('unknown')).toBe('unknown');
    expect(retryErrorLabel('SOMETHING_NEW', zh)).toBe('SOMETHING_NEW');
  });

  it('prints the class in words next to the status', () => {
    const view = deriveRetryBanner(
      {
        retry: { attempt: 2, maxRetries: 3, delayMs: 0, errorStatus: '500', error: 'SERVER' },
        inFlight: true,
        outputSinceRetry: false,
      },
      zh
    );
    expect(view?.detail).toBe('服务端错误 500');
    expect(view?.detail).not.toContain('SERVER');
  });
});

describe('session branches dialog (problem 9: user / assistant / assistant message)', () => {
  function node(overrides: Partial<SessionTreeNode>): SessionTreeNode {
    return {
      id: 'n1',
      parentId: null,
      depth: 0,
      entryType: 'message',
      childCount: 0,
      forkable: true,
      active: false,
      leaf: false,
      ...overrides,
    };
  }

  it('words the role tag and a message node with no preview', () => {
    expect(sessionTreeNodeTag(node({ role: 'user' }), zh)).toBe('用户');
    expect(sessionTreeNodeTag(node({ role: 'assistant' }), zh)).toBe('助手');
    expect(sessionTreeNodeTag(node({ role: 'system', entryType: 'notice' }), zh)).toBe('系统');
    expect(sessionTreeNodeTitle(node({ role: 'assistant' }), zh)).toBe('助手消息');
    expect(sessionTreeNodeTitle(node({ role: 'user' }), zh)).toBe('用户消息');
    expect(sessionTreeNodeTitle(node({ role: 'system', entryType: 'notice' }), zh)).toBe('通知');
    // English keeps the old wording.
    expect(sessionTreeNodeTitle(node({ role: 'assistant' }))).toBe('assistant message');
  });

  it('keeps previews and labels verbatim, except a context summary’s title', () => {
    expect(sessionTreeNodeTitle(node({ role: 'user', preview: 'fix the build' }), zh)).toBe(
      'fix the build'
    );
    expect(
      sessionTreeNodeTitle(
        node({ role: 'system', entryType: 'compaction', preview: 'Context summary all of it' }),
        zh
      )
    ).toBe('上下文摘要 all of it');
    expect(sessionTreeNodeTitle(node({ entryType: 'model_change' }), zh)).toBe('model change');
  });
});

describe('context summary title (decision 140 rule 16)', () => {
  it('translates the leading title only, as a whole word', () => {
    expect(localizeContextSummaryTitle('Context summary\n\n## Goal\n- x', zh)).toBe(
      '上下文摘要\n\n## Goal\n- x'
    );
    expect(localizeContextSummaryTitle('Context summary', zh)).toBe('上下文摘要');
    expect(localizeContextSummaryTitle('Context summaryX', zh)).toBe('Context summaryX');
    expect(localizeContextSummaryTitle('A Context summary', zh)).toBe('A Context summary');
  });
});

describe('chat titles and the start-up chat (decision 138 rule 21)', () => {
  it('shows the placeholder titles in the UI language and anything else verbatim', () => {
    expect(NEW_CHAT_TITLE).toBe('New chat');
    expect(displaySessionTitle(NEW_CHAT_TITLE, zh)).toBe('新建对话');
    expect(displaySessionTitle(LEGACY_SEED_TITLE, zh)).toBe('新建对话');
    expect(displaySessionTitle('Fix the build', zh)).toBe('Fix the build');
    expect(displaySessionTitle(NEW_CHAT_TITLE)).toBe('New chat');
    // Both stay placeholders, so the first message still names the chat.
    expect(isPlaceholderTitle(NEW_CHAT_TITLE)).toBe(true);
    expect(isPlaceholderTitle(LEGACY_SEED_TITLE)).toBe(true);
  });

  // Decision 149 §11 / 156: the last-resort fallback title too.
  it('E156-9: shows `Session xxxxxx` as 「会话 xxxxxx」 and stores it as it was', () => {
    const stored = fallbackSessionTitle('a1b2c3-srd2ne');
    expect(stored).toBe('Session srd2ne');
    expect(displaySessionTitle(stored, zh)).toBe('会话 srd2ne');
    expect(displaySessionTitle('Session ab-c1', zh)).toBe('会话 ab-c1');
    // English reads as before, and so does anything that only looks similar.
    expect(displaySessionTitle(stored)).toBe('Session srd2ne');
    expect(displaySessionTitle('Session abcdefg', zh)).toBe('Session abcdefg');
    expect(displaySessionTitle('Session planning', zh)).toBe('Session planning');
    // The recognizer reads the stored value, not the shown one.
    expect(isPlaceholderTitle(stored)).toBe(true);
    expect(isPlaceholderTitle('会话 srd2ne')).toBe(false);
  });

  // Decision 174 (issue #6, second wave): the start-up chat is gone (the app
  // opens on the home page), and so is the predicate that recognised it.
  it('no longer exports a start-up chat recognizer', async () => {
    const titles = await import('../sessionIndex/sessionTitle');
    expect('isStartupSeedSession' in titles).toBe(false);
    expect('STARTUP_SEED_ID_PREFIX' in titles).toBe(false);
  });
});

/**
 * Problem 9 (decision 144 §2–3) put the 「临时」「远程」 kind chips on every
 * row in the UI language. Decision 167 retired those chips — a temporary chat
 * is told by its section, a remote repository by its folder row — so what is
 * left to word at display time is the placeholder title and the Temp Session
 * project's name.
 */
describe('sidebar display words (problem 9, decision 167)', () => {
  it('gives the row component the title as shown, and the same row when nothing changes', () => {
    const row: SidebarSessionRow = {
      sessionId: 's1',
      workspaceId: '',
      title: NEW_CHAT_TITLE,
      chip: null,
      unbound: true,
      updatedAt: 0,
      busy: false,
      failed: false,
      status: 'idle',
    };
    expect(sidebarRowForDisplay(row, zh)).toEqual({ ...row, title: '新建对话' });
    const named: SidebarSessionRow = {
      ...row,
      title: 'Fix the build',
      chip: { variant: 'branch', label: 'main' },
    };
    expect(sidebarRowForDisplay(named, zh)).toBe(named);
  });

  it('words the Temp Session project and leaves a repository name alone', () => {
    expect(sidebarFolderNameForDisplay('project-temp', 'Temp', zh)).toBe('临时工作区');
    expect(sidebarFolderNameForDisplay('project-temp', 'Temp')).toBe('Temporary workspaces');
    expect(sidebarFolderNameForDisplay('project:/repo/temp', 'Temp', zh)).toBe('Temp');
  });
});

describe('engine status ribbon (problem 9: pi leftovers)', () => {
  it('names the chat engine, not the Pi session service', () => {
    for (const state of ['error', 'stopped', 'starting'] as const) {
      const model = describeHostStatus({ state, lastFatalError: null } as HostStatus);
      expect(model, state).not.toBeNull();
      for (const key of [model?.title ?? '', model?.guidance ?? ''].filter(Boolean)) {
        expect(key).not.toMatch(/\bPi\b/);
        expectChinese(zh(key), key);
      }
    }
  });
});
