import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../components/chat/__tests__/stripComments';

const renderer = join(process.cwd(), 'src/renderer');

describe('S05 legacy shell removal', () => {
  it('keeps the workspace shell and the shared settings dialog as the only app surfaces', () => {
    const file = join(renderer, 'App.tsx');
    const source = stripComments(readFileSync(file, 'utf8'), file);
    expect(source).toContain('<WorkspaceShell');
    expect(source).toContain('<SettingsDialog');
    expect(source).not.toMatch(
      /MainContent|useOpenChamberShell|DraggableSettingsWindow|ActionPanel/
    );
  });

  it('does not restore legacy entrypoints or their switch', () => {
    for (const file of [
      'components/layout/MainContent.tsx',
      'components/layout/TreeSidebar.tsx',
      'components/layout/RepositorySidebar.tsx',
      'components/layout/ActionPanel.tsx',
      'components/chat/AgentPanel.tsx',
      'components/chat/EnhancedInput.tsx',
      'components/chat/QuickTerminalModal.tsx',
      'components/app/OpenInMenu.tsx',
      'components/files/FilePanel.tsx',
      'components/files/CurrentFilePanel.tsx',
      'components/files/FileSidebar.tsx',
      'components/source-control/SourceControlPanel.tsx',
      'components/settings/DraggableSettingsWindow.tsx',
      'stores/settings/shellPreferenceMirror.ts',
    ])
      expect(existsSync(join(renderer, file)), file).toBe(false);

    for (const file of readdirSync(renderer, { recursive: true, encoding: 'utf8' })) {
      if (
        !/\.tsx?$/.test(file) ||
        file.includes('__tests__') ||
        file === 'stores/settings/migration.ts'
      )
        continue;
      const full = join(renderer, file);
      expect(stripComments(readFileSync(full, 'utf8'), full), file).not.toMatch(
        /\buseOpenChamberShell\b|\bMainContent\b/
      );
    }
  });

  it('preserves terminal and file components shared with the workspace shell', () => {
    for (const file of [
      'terminal/TerminalPanel.tsx',
      'terminal/ShellTerminal.tsx',
      'files/FileTree.tsx',
      'files/EditorArea.tsx',
      'source-control/BranchSwitcher.tsx',
      'source-control/DiffViewer.tsx',
    ]) {
      expect(existsSync(join(renderer, 'components', file)), file).toBe(true);
    }
  });
});
