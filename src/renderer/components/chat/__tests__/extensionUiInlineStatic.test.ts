import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

const dialogPath = path.join(process.cwd(), 'src/renderer/components/chat/ExtensionUiDialog.tsx');
const workspacePath = path.join(process.cwd(), 'src/renderer/components/chat/ChatWorkspace.tsx');
const navPath = path.join(process.cwd(), 'src/renderer/components/workspace-shell/LeftNav.tsx');
const dialog = stripComments(readFileSync(dialogPath, 'utf8'), dialogPath);
const workspace = stripComments(readFileSync(workspacePath, 'utf8'), workspacePath);
const nav = stripComments(readFileSync(navPath, 'utf8'), navPath);

describe('T08-b inline Extension UI wiring', () => {
  it('mounts the session dock beside the active conversation', () => {
    expect(workspace).toContain('<ExtensionUiInlineDock sessionId={activeSessionId} />');
  });

  it('reserves the modal fallback for requests with no session surface', () => {
    expect(dialog).toContain('currentUnscopedExtensionUiDialog({ pending })');
    expect(dialog).toContain('currentExtensionUiDialogForSession({ pending }, sessionId)');
    expect(dialog).not.toContain('currentExtensionUiDialog({ pending })');
  });

  it('uses one non-modal dock for scoped and session-less requests', () => {
    expect(dialog.split('<ExtensionUiDock').length - 1).toBe(2);
    expect(dialog.split('<ExtensionUiRequestContent').length - 1).toBe(1);
    expect(dialog).not.toContain('AlertDialog');
    expect(dialog).not.toContain('focus trap');
  });

  it('shows pending approval badges on both Recent and repository session rows', () => {
    expect(nav.split('pendingApprovalCount={').length - 1).toBe(2);
    expect(nav).toContain('{{count}} pending approval requests');
    expect(nav).toContain('<ShieldQuestion className="size-3" />');
  });
});
