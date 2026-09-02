import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

const workspacePath = path.join(process.cwd(), 'src/renderer/components/chat/ChatWorkspace.tsx');
const surfacesPath = path.join(
  process.cwd(),
  'src/renderer/components/chat/ExtensionUiSurfaces.tsx'
);
const workspace = stripComments(readFileSync(workspacePath, 'utf8'), workspacePath);
const surfaces = stripComments(readFileSync(surfacesPath, 'utf8'), surfacesPath);

describe('T09 Extension UI surfaces', () => {
  it('initializes display state at app lifetime rather than from a leaf chip', () => {
    expect(workspace).toContain('return useExtensionUiDisplayStore.getState().init();');
  });

  it('mounts status plus both widget placements around the composer', () => {
    expect(workspace).toContain('<ExtensionUiStatusChips sessionId={activeSessionId} />');
    // T36 gave the notice its TUI escape hatch — the handoff is the point of
    // the notice, so the prop is pinned rather than dropped from the match.
    expect(workspace).toContain(
      '<ExtensionUiUnsupportedNotice sessionId={activeSessionId} onOpenTui={openTui} />'
    );
    expect(workspace).toContain(
      '<ExtensionUiWidgets sessionId={activeSessionId} placement="aboveEditor" />'
    );
    expect(workspace).toContain(
      '<ExtensionUiWidgets sessionId={activeSessionId} placement="belowEditor" />'
    );
  });

  it('renders TUI-only degradation as a non-modal, session-filtered notice', () => {
    expect(surfaces).toContain('.filter((entry) => entry.sessionId === sessionId)');
    expect(surfaces).toContain("t('This extension needs the Pi TUI')");
    expect(surfaces).not.toContain('<AlertDialog');
  });

  it('renders widget content as React text rather than injecting markup', () => {
    expect(surfaces).toContain("{entry.lines.join('\\n')}");
    expect(surfaces).not.toContain('dangerouslySetInnerHTML');
  });

  it('claims notifications before choosing toast or OS delivery', () => {
    expect(surfaces).toContain('store.removeNotification(current.id);');
    expect(surfaces).toContain('addToast({');
    expect(surfaces).toContain('window.electronAPI.notification.show({');
    expect(surfaces).toContain('window.electronAPI.notification.onClick');
  });
});
