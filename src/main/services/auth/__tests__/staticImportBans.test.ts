import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * D47 S1 §1 "不做" / §3 test group 6 — renderer and preload must not import
 * the full onboarding response type or `AuthStateService`. S1 wires nothing
 * into IPC or the renderer (legacy stays the sole read path); a static scan
 * is what makes that promise self-enforcing rather than a comment. Same
 * paradigm as `renderer/App/__tests__/shellSwitchStatic.test.ts`.
 */

const ROOT = join(process.cwd(), 'src');
const RENDERER_DIR = join(ROOT, 'renderer');
const PRELOAD_DIR = join(ROOT, 'preload');

function listSources(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map(String)
    .filter((p) => (p.endsWith('.ts') || p.endsWith('.tsx')) && !p.includes('__tests__'))
    .map((p) => join(dir, p));
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function code(path: string): string {
  return stripComments(readFileSync(path, 'utf8'));
}

function rel(path: string): string {
  return path.slice(ROOT.length + 1);
}

describe('renderer/preload never reach into the main-only auth surface (D47 S1)', () => {
  it('nobody imports the full server-shape OnboardingRegisterResponse', () => {
    const offenders = [...listSources(RENDERER_DIR), ...listSources(PRELOAD_DIR)]
      .filter((path) => {
        const source = code(path);
        // The trimmed OnboardingRegisterClientResponse is fine — only the
        // full-response import path (from main/services/onboarding/types) is banned.
        return (
          /onboarding\/types['"]/.test(source) || /\bOnboardingRegisterResponse\b/.test(source)
        );
      })
      .map(rel);

    expect(
      offenders,
      'The full verify-and-register response carries real secrets and must ' +
        'stay in Main. Renderer/preload may only use OnboardingRegisterClientResponse.'
    ).toEqual([]);
  });

  it('nobody imports AuthStateService (S1 wires it into nothing yet — legacy stays the sole read path)', () => {
    const offenders = [...listSources(RENDERER_DIR), ...listSources(PRELOAD_DIR)]
      .filter((path) => /AuthStateService/.test(code(path)))
      .map(rel);

    expect(
      offenders,
      'AuthStateService is unwired in S1 — no renderer/preload import yet.'
    ).toEqual([]);
  });

  it('nobody imports CredentialVault directly', () => {
    const offenders = [...listSources(RENDERER_DIR), ...listSources(PRELOAD_DIR)]
      .filter((path) => /CredentialVault/.test(code(path)))
      .map(rel);

    expect(offenders, 'CredentialVault is a main-only module.').toEqual([]);
  });
});
