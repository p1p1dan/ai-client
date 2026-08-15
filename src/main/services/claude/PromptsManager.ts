import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * D47 S2a §1: follows `CLAUDE_CONFIG_DIR` when set (managed redirect).
 * Note: CLAUDE.md is plain text (not JSON), so it is NOT routed through
 * `managedFileWriter` — that pipeline is JSON-shaped and also chmods 0600,
 * which would wrongly lock down CLAUDE.md (intentionally 0644/world-readable,
 * unlike settings.json/.claude.json which carry credentials). Only the
 * CLAUDE_CONFIG_DIR-aware path resolution applies here.
 */
function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function getClaudeMdPath(): string {
  return path.join(getClaudeConfigDir(), 'CLAUDE.md');
}

/**
 * 读取 ~/.claude/CLAUDE.md 内容
 */
export function readClaudeMd(): string | null {
  try {
    const mdPath = getClaudeMdPath();
    if (!fs.existsSync(mdPath)) {
      return null;
    }
    return fs.readFileSync(mdPath, 'utf-8');
  } catch (error) {
    console.error('[PromptsManager] Failed to read CLAUDE.md:', error);
    return null;
  }
}

/**
 * 写入内容到 ~/.claude/CLAUDE.md
 */
export function writeClaudeMd(content: string): boolean {
  try {
    const mdPath = getClaudeMdPath();
    const dir = path.dirname(mdPath);

    // 确保目录存在
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }

    fs.writeFileSync(mdPath, content, { mode: 0o644 });
    console.log('[PromptsManager] Wrote CLAUDE.md');
    return true;
  } catch (error) {
    console.error('[PromptsManager] Failed to write CLAUDE.md:', error);
    return false;
  }
}

/**
 * 备份当前 CLAUDE.md
 * 返回备份文件路径
 */
export function backupClaudeMd(): string | null {
  try {
    const mdPath = getClaudeMdPath();
    if (!fs.existsSync(mdPath)) {
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(getClaudeConfigDir(), 'backups', `CLAUDE.md.${timestamp}.bak`);
    const backupDir = path.dirname(backupPath);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o755 });
    }

    fs.copyFileSync(mdPath, backupPath);
    console.log(`[PromptsManager] Backed up CLAUDE.md to ${backupPath}`);
    return backupPath;
  } catch (error) {
    console.error('[PromptsManager] Failed to backup CLAUDE.md:', error);
    return null;
  }
}
