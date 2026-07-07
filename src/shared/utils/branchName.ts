import { translate } from '../i18n';

export type BranchNameCheck = { valid: true } | { valid: false; error: string };

/**
 * Normalize user input for a new branch name: trim whitespace and
 * convert backslashes (habitual on Windows) to forward slashes.
 */
export function normalizeBranchName(name: string): string {
  return name.trim().replace(/\\/g, '/');
}

function hasControlChar(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a branch name against the practical subset of
 * `git check-ref-format --branch` rules.
 * The returned error is an English message that doubles as an i18n key.
 */
export function validateBranchName(name: string): BranchNameCheck {
  if (!name) {
    return { valid: false, error: 'Branch name cannot be empty' };
  }
  if (name === '@') {
    return { valid: false, error: 'Branch name cannot be "@"' };
  }
  if (name.startsWith('-')) {
    return { valid: false, error: 'Branch name cannot start with "-"' };
  }
  if (hasControlChar(name) || /[\s~^:?*[\\]/.test(name)) {
    return {
      valid: false,
      error: 'Branch name cannot contain spaces or the characters ~ ^ : ? * [ \\',
    };
  }
  if (name.includes('..')) {
    return { valid: false, error: 'Branch name cannot contain ".."' };
  }
  if (name.includes('@{')) {
    return { valid: false, error: 'Branch name cannot contain "@{"' };
  }
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return { valid: false, error: 'Branch name cannot start or end with "/" or contain "//"' };
  }
  if (name.endsWith('.')) {
    return { valid: false, error: 'Branch name cannot end with "."' };
  }
  for (const segment of name.split('/')) {
    if (segment.startsWith('.')) {
      return { valid: false, error: 'Branch name segments cannot start with "."' };
    }
    if (segment.endsWith('.lock')) {
      return { valid: false, error: 'Branch name segments cannot end with ".lock"' };
    }
  }
  return { valid: true };
}

/**
 * Normalize and validate a new branch name at the main-process boundary.
 * Returns the normalized name, or throws a Chinese error when invalid.
 */
export function ensureValidBranchName(name: string): string {
  const normalized = normalizeBranchName(name);
  const check = validateBranchName(normalized);
  if (!check.valid) {
    throw new Error(`无效的分支名 "${name}"：${translate('zh', check.error)}`);
  }
  return normalized;
}
