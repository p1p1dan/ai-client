import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import { subagentHeaderLiveness } from '../subagentActivityModel';

/**
 * Decision 202: a delegation whose call has settled while its delegate keeps
 * working reads 「后台运行中」, not the foreground running state that made an
 * idle session look like the delegate still held the conversation.
 */
describe('subagentHeaderLiveness', () => {
  it('a running lane under a running call is foreground', () => {
    expect(subagentHeaderLiveness('running', true)).toBe('running');
  });

  it('a running lane after the call settled is background', () => {
    expect(subagentHeaderLiveness('running', false)).toBe('background');
  });

  it('a lane with no status yet follows the call', () => {
    expect(subagentHeaderLiveness(null, true)).toBe('running');
    expect(subagentHeaderLiveness(null, false)).toBe('settled');
    expect(subagentHeaderLiveness(undefined, true)).toBe('settled');
  });

  it('a terminal lane is settled whatever the call says', () => {
    for (const status of ['completed', 'failed', 'stopped', 'cancelled', 'truncated'] as const) {
      expect(subagentHeaderLiveness(status, true)).toBe('settled');
      expect(subagentHeaderLiveness(status, false)).toBe('settled');
    }
  });
});

describe('the delegation row wiring', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../ToolRows.tsx'),
    'utf8'
  );

  it('derives running and background from the one liveness value', () => {
    expect(source).toContain('subagentHeaderLiveness(lane?.status, parentRunning)');
    expect(source).toContain("running: liveness === 'running'");
    expect(source).toContain("backgroundRunning: liveness === 'background'");
    expect(source).not.toContain('lane?.status === null && parentRunning');
  });

  it('paints the background word in the outcome slot, translated', () => {
    expect(source).toContain('data-slot="tool-row-background"');
    expect(source).toContain("t('Running in background')");
    expect(translate('zh', 'Running in background')).toBe('后台运行中');
  });
});
