import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * D10 explicit degradation, the half that lives in `.tsx` and so cannot be
 * rendered by this suite (node env, `.ts` only).
 *
 * `permissionGate.test.ts` covers the decision. What it cannot see is whether
 * the control actually consults it — and this is a security-facing control, so
 * a refactor that quietly drops the check restores the exact failure the feature
 * exists to remove: four tiers offered, none honoured, nothing on screen saying
 * so. Pins the three things that would break silently.
 *
 * Scans read CODE, not prose (shared parser-backed strip).
 */

const TRIGGER_FILE = join(
  process.cwd(),
  'src/renderer/components/chat/ComposerPermissionTrigger.tsx'
);
const CODE = stripComments(readFileSync(TRIGGER_FILE, 'utf8'), TRIGGER_FILE);

describe('permission tier control under a user-configured gate', () => {
  it('asks the gate store rather than assuming the tiers apply', () => {
    expect(CODE).toContain('isTierControlDegraded');
    expect(CODE).toContain('usePermissionGateStore');
  });

  it('replaces the tier list with the notice instead of rendering both', () => {
    // A ternary, not `&&`: showing the radio group underneath the notice would
    // still let the user pick a tier that does nothing.
    expect(CODE).toMatch(/degraded\s*\?\s*\(?\s*<DegradedGateNotice\s*\/>/);
  });

  it('never labels the degraded state with a tier name', () => {
    // The trigger label is the one piece of this control visible without
    // opening the menu. Naming a tier there is the precise claim that is false.
    const labelLine = CODE.split('\n').find((line) => line.includes('const label ='));
    expect(labelLine).toBeDefined();
    expect(labelLine).toContain('Your own policy');
    for (const tier of ['Read-only', 'Pragmatic', 'Hands-off', 'Full access']) {
      expect(labelLine).not.toContain(tier);
    }
  });

  it('says the tiers are off without naming a tier as the effective policy', () => {
    // The panel is deliberately two lines (the user asked for exactly that), so
    // what it must not do is describe the live policy as one of the four —
    // a `yoloMode: true` config is laxer than every tier listed here.
    expect(CODE).toContain('Permission tiers are off for this chat');
    const noticeBody = CODE.slice(CODE.indexOf('function DegradedGateNotice'));
    for (const tier of ['Read-only', 'Pragmatic', 'Hands-off', 'Full access']) {
      expect(noticeBody).not.toContain(tier);
    }
  });
});
