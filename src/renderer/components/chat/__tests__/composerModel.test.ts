import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composerModelLabelParts, composerModelMenuModel } from '../composerModel';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Merged model+effort control view-model (round-4 addendum §3.2.2).
 * Suite ids follow the addendum's F-A numbering.
 */

const THREE_MODELS = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'opus', label: 'Opus' },
];

describe('F-A17 (precondition half) · D25 ① must land before the suffix polarity means anything', () => {
  // `composerModelSuffixClass()` relies on font-medium being a REAL weight.
  // Under the D18 all-mono stack 500 rounds to 400 on most platforms, so the
  // "heavier suffix" half of the dual polarity silently dies. This assertion
  // fails if the proportional UI stack is ever reverted (also D25 A3).
  it('globals.css --font-sans no longer leads with ui-monospace', () => {
    const css = readFileSync(path.resolve(__dirname, '../../../styles/globals.css'), 'utf8');
    const sans = css.match(/--font-sans:\s*([^;]+);/)?.[1] ?? '';
    expect(sans.trim().startsWith('ui-monospace')).toBe(false);
    const mono = css.match(/--font-mono:\s*([^;]+);/)?.[1] ?? '';
    expect(mono.trim().startsWith('ui-monospace')).toBe(true);
  });
});

describe('F-A9 / F-A19 · composerModelLabelParts', () => {
  it('drops the suffix entirely for the Default sentinel (wire semantics: no effort field sent)', () => {
    expect(composerModelLabelParts({ modelLabel: 'Sonnet', effort: 'default' })).toEqual({
      base: 'Sonnet',
      suffix: null,
    });
  });

  it('renders known efforts through effortLabel (no second label table)', () => {
    expect(composerModelLabelParts({ modelLabel: 'Sonnet', effort: 'high' })).toEqual({
      base: 'Sonnet',
      suffix: 'High',
    });
    expect(composerModelLabelParts({ modelLabel: 'Opus', effort: 'xhigh' })).toEqual({
      base: 'Opus',
      suffix: 'X-High',
    });
  });

  it('F-A19: an unknown effort string neither throws nor collapses to "Default" — it falls back to the raw value', () => {
    expect(composerModelLabelParts({ modelLabel: 'Sonnet', effort: 'turbo' })).toEqual({
      base: 'Sonnet',
      suffix: 'turbo',
    });
  });

  it('leaves a host-catalog-foreign model label untouched', () => {
    expect(composerModelLabelParts({ modelLabel: 'claude-fable-5', effort: 'max' })).toEqual({
      base: 'claude-fable-5',
      suffix: 'Max',
    });
  });
});

describe('F-A16 · composerModelMenuModel section contract', () => {
  const model = composerModelMenuModel({
    options: THREE_MODELS,
    selectedModel: 'sonnet',
    selectedEffort: 'default',
  });

  it('has exactly two sections, model before effort, fixed order', () => {
    expect(model.sections.length).toBe(2);
    expect(model.sections[0]?.id).toBe('model');
    expect(model.sections[1]?.id).toBe('effort');
  });

  it('the model section carries the 3 catalog rows; the effort section always carries 6 (Default + 5 levels)', () => {
    expect(model.sections[0]?.items.length).toBe(3);
    expect(model.sections[1]?.items.length).toBe(6);
    expect(model.sections[1]?.items[0]?.id).toBe('default');
  });

  it('exactly one item is selected in each section', () => {
    for (const section of model.sections) {
      expect(section.items.filter((item) => item.selected).length).toBe(1);
    }
  });

  it('model rows carry ONLY the model name — no per-row effort suffix (Cursor has per-model memory; we do not)', () => {
    for (const item of model.sections[0]?.items ?? []) {
      expect(item.label).not.toMatch(/\s(Low|Medium|High|X-High|Max)$/);
    }
  });

  it('effort hints pass through for tooltips', () => {
    const high = model.sections[1]?.items.find((item) => item.id === 'high');
    expect(high?.hint).toMatch(/model default/);
  });
});

describe('F-A16b · host-foreign default model is prepended, not swallowed', () => {
  it('a 4th option coming from ensureModelOptions leads the model section', () => {
    const model = composerModelMenuModel({
      options: [{ id: 'claude-fable-5', label: 'claude-fable-5' }, ...THREE_MODELS],
      selectedModel: 'claude-fable-5',
      selectedEffort: 'high',
    });
    expect(model.sections[0]?.items.length).toBe(4);
    expect(model.sections[0]?.items[0]?.id).toBe('claude-fable-5');
    expect(model.sections[0]?.items[0]?.selected).toBe(true);
  });
});

describe('F-A16c · the Cursor popup extras stay cut (§2.2 pruning verdicts)', () => {
  it('the returned shape carries no search / auto / subPanel keys at any depth', () => {
    const model = composerModelMenuModel({
      options: THREE_MODELS,
      selectedModel: 'sonnet',
      selectedEffort: 'high',
    });
    const forbidden = new Set(['search', 'auto', 'subPanel', 'subpanel']);
    const scan = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) scan(entry);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
          expect(forbidden.has(key)).toBe(false);
          scan(entry);
        }
      }
    };
    scan(model);
  });
});

describe('selection resilience', () => {
  it('a garbage stored effort marks Default selected instead of leaving the section unchecked', () => {
    const model = composerModelMenuModel({
      options: THREE_MODELS,
      selectedModel: 'sonnet',
      selectedEffort: 'not-a-level',
    });
    const effortSection = model.sections[1];
    expect(effortSection?.items.filter((item) => item.selected).length).toBe(1);
    expect(effortSection?.items[0]?.id).toBe('default');
    expect(effortSection?.items[0]?.selected).toBe(true);
  });
});
