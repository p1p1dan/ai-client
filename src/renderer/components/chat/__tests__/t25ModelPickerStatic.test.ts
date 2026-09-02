import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

const triggerPath = path.join(
  process.cwd(),
  'src/renderer/components/chat/ComposerModelTrigger.tsx'
);
const trigger = stripComments(readFileSync(triggerPath, 'utf8'), triggerPath);

describe('T25 grouped model picker wiring', () => {
  it('renders configured model groups as Base UI submenus', () => {
    expect(trigger).toContain(
      'const grouped = groupChatModels([...direct, ...matches], fallbackGroupLabel);'
    );
    expect(trigger).toContain('<MenuSub key={group.id}>');
    expect(trigger).toContain('<MenuSubTrigger');
    expect(trigger).toContain('<MenuSubPopup');
  });

  it('searches label, id and secondary tags without changing primary grouping', () => {
    expect(trigger).toContain('filterChatModels(');
    expect(trigger).toContain("placeholder={t('Search models')}");
    expect(trigger).toContain("fallbackGroupLabel={t('Other models')}");
  });

  it('derives visible effort rows from the selected model metadata', () => {
    expect(trigger).toContain('const availableEfforts = effortsForModel(selectedCatalogModel);');
    expect(trigger).toContain('efforts: availableEfforts');
  });

  it('updates session and template together when a model invalidates the old effort', () => {
    expect(trigger).toContain('const nextEffort = reconcileEffortForModel(effort, nextModel);');
    // Pi-only: the effort store is no longer keyed by agent.
    expect(trigger).toContain('setSessionEffort(sessionId, nextEffort);');
    expect(trigger).toContain('...(nextEffort !== effort ? { effort: nextEffort } : {})');
  });
});
