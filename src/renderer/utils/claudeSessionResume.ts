/**
 * Shared logic for resuming a Claude session from `~/.claude/projects/` history.
 * Used by both the Home session browser (SessionManagerView) and the
 * per-worktree history list in AgentPanel's empty state.
 */

export interface ResolveClaudeConfigDirResult {
  /** The CLAUDE_CONFIG_DIR to use, or null if the session file wasn't found in any candidate. */
  configDir: string | null;
  /** Human-readable diagnostic text listing the paths that were checked. Only meaningful when configDir is null. */
  diagnostic: string;
}

/**
 * Locate which CLAUDE_CONFIG_DIR (dry-run `claude-null` vs the real `~/.claude`)
 * actually contains the given session's JSONL file. Dry-run test sessions are
 * written under a separate config dir (see TEST_LOGIN_DRY_RUN in
 * OnboardingService) so the same session id can exist in either place
 * depending on how it was created.
 */
export async function resolveClaudeConfigDirForSession(
  projectId: string,
  sessionId: string
): Promise<ResolveClaudeConfigDirResult> {
  const homeDir = window.electronAPI?.env.HOME || '';

  if (!homeDir) {
    return {
      configDir: null,
      diagnostic: '\n(诊断) 未能获取 HOME 目录，请确认系统环境变量 USERPROFILE/HOME 是否可用。',
    };
  }

  const isWindows = window.electronAPI?.env.platform === 'win32';
  const pathSep = isWindows ? '\\' : '/';

  const nullConfigDir = `${homeDir}${pathSep}.aiclient${pathSep}claude-null`;
  const userConfigDir = `${homeDir}${pathSep}.claude`;
  const candidates = [nullConfigDir, userConfigDir];

  const buildSessionPath = (configDir: string) =>
    `${configDir}${pathSep}projects${pathSep}${projectId}${pathSep}${sessionId}.jsonl`;

  const checks = await Promise.all(
    candidates.map(async (configDir) => {
      try {
        const exists = await window.electronAPI.file.exists(buildSessionPath(configDir));
        return { configDir, exists };
      } catch {
        return { configDir, exists: false };
      }
    })
  );

  const match = checks.find((c) => c.exists);
  if (match) {
    return { configDir: match.configDir, diagnostic: '' };
  }

  const diagnostic = `\n(诊断) 已检查以下路径是否存在：\n${candidates
    .map((configDir) => buildSessionPath(configDir))
    .join('\n')}`;
  return { configDir: null, diagnostic };
}
