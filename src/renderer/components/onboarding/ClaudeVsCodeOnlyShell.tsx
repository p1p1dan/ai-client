import type { ClaudeRuntimeStatus, VsCodeExtensionInfo } from '@shared/types';
import { ExternalLink, Loader2, ShieldAlert } from 'lucide-react';
import { DevToolsOverlay } from '@/components/DevToolsOverlay';
import { BackgroundLayer } from '@/components/layout/BackgroundLayer';
import { WindowTitleBar } from '@/components/layout/WindowTitleBar';
import { Button } from '@/components/ui/button';

const VSCODE_HELP_URL = 'https://docs.anthropic.com/en/docs/claude-code/vscode';

export interface ClaudeVsCodeOnlyShellProps {
  status: ClaudeRuntimeStatus;
  registered: boolean;
  /** True while a runtime recheck is in flight; disables the recheck button. */
  rechecking: boolean;
  /** Last recheck failed (IPC reject etc.). Surfaced inline so the user knows. */
  recheckError: string | null;
  onStartRegister: () => void;
  onStartInstall: () => void;
  onRecheck: () => void;
  onQuit: () => void;
}

/**
 * Shown on TEC-encrypted machines where the Claude Code CLI is not installed
 * but the VSCode extension is. AiClient itself depends on the CLI to drive
 * agent terminals, so the main app stays unmounted; the user finishes the
 * onboarding registration (which writes ANTHROPIC_BASE_URL/AUTH_TOKEN into
 * ~/.claude/settings.json) and then uses Claude directly inside VSCode.
 */
export function ClaudeVsCodeOnlyShell({
  status,
  registered,
  rechecking,
  recheckError,
  onStartRegister,
  onStartInstall,
  onRecheck,
  onQuit,
}: ClaudeVsCodeOnlyShellProps) {
  const extension: VsCodeExtensionInfo | undefined = status.vscodeExtension;

  return (
    <div className="relative z-0 flex h-screen flex-col overflow-hidden">
      <BackgroundLayer />
      <WindowTitleBar />
      <DevToolsOverlay />
      <div className="relative flex flex-1 items-center justify-center overflow-auto p-6">
        <div className="w-full max-w-xl rounded-lg border bg-background/95 p-6 shadow-lg backdrop-blur">
          <div className="mb-4 flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">检测到 VSCode Claude 扩展</h2>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            未发现 Claude Code 命令行版本，AiClient 主界面无法启动。检测到本机已安装 VSCode 的
            Claude 扩展，请直接在 VSCode 中使用 Claude。
          </p>
          {extension ? (
            <div className="mb-4 rounded-md bg-muted/40 p-3 text-xs">
              <div className="text-muted-foreground">扩展版本</div>
              <div className="mt-1 font-mono">v{extension.version}</div>
              <div className="mt-2 text-muted-foreground">扩展路径</div>
              <div className="mt-1 break-all font-mono text-[11px]">{extension.path}</div>
            </div>
          ) : null}
          <div className="mb-4 rounded-md border-l-2 border-primary/60 bg-primary/5 p-3 text-xs text-muted-foreground">
            {registered
              ? '账号已配置完成，URL 与 Token 已写入 ~/.claude/settings.json，VSCode 扩展将自动读取。'
              : '完成注册后，URL 与 Token 会自动写入 ~/.claude/settings.json，VSCode 扩展将直接读取。'}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!registered && <Button onClick={onStartRegister}>开始注册</Button>}
            <Button variant="outline" onClick={onStartInstall} disabled={rechecking}>
              一键安装 CLI
            </Button>
            <Button variant="outline" onClick={onRecheck} disabled={rechecking}>
              {rechecking ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              {rechecking ? '检测中…' : '重新检测'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => window.electronAPI.shell.openExternal(VSCODE_HELP_URL)}
            >
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              VSCode 使用文档
            </Button>
            <Button variant="ghost" onClick={onQuit}>
              退出应用
            </Button>
          </div>
          {recheckError ? (
            <p className="mt-3 text-xs text-destructive">检测失败:{recheckError}</p>
          ) : null}
          <p className="mt-4 text-xs text-muted-foreground">
            想在 AiClient 主界面中使用,点击「一键安装 CLI」即可安装 Claude Code 命令行版本(建议
            v2.1.112,Node 版);若已手动安装,点击「重新检测」即可。
          </p>
        </div>
      </div>
    </div>
  );
}
