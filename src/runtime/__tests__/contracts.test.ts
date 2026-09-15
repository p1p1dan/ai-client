/**
 * The mechanical half of `docs/agent-project-engineering.md` A3.
 *
 * A3 requires that a module with nothing to contribute says so explicitly, and
 * that a GATE rejects the unexplained empty shell rather than leaving the check
 * to review discipline. This file is that gate: it runs in the existing
 * `pnpm test` chain, so a P1 author who deletes `runtimeTools` from
 * `DEFERRED_SERVICES` without registering a real service fails CI instead of
 * quietly leaving the graph with a name nobody provides.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFERRED_REASON_MARKER,
  DEFERRED_SERVICES,
  EVENTS_SERVICE,
  LOOP_SERVICE,
  MODEL_SERVICE,
  P0_SERVICES,
  PROMPT_SERVICE,
  RUNTIME_SERVICES,
  SESSION_SERVICE,
  TRACE_SERVICE,
} from '../contracts.ts';

describe('service contracts', () => {
  it('registers exactly the three services P0 implements', () => {
    expect([...P0_SERVICES]).toEqual([MODEL_SERVICE, TRACE_SERVICE, LOOP_SERVICE]);
  });

  it('never lists a service as both implemented and deferred', () => {
    const overlap = [
      ...RUNTIME_SERVICES,
      PROMPT_SERVICE,
      SESSION_SERVICE,
      EVENTS_SERVICE,
      'runtimeContext',
    ].filter((name) => name in DEFERRED_SERVICES);
    expect(overlap).toEqual([]);
  });

  it('explains and dates every deferred service, if there is one', () => {
    // Written as a loop rather than `it.each` because the table is empty today
    // and an empty `each` is a hard error, not a pass.
    for (const declaration of Object.values(DEFERRED_SERVICES)) {
      expect(declaration.reason.startsWith(DEFERRED_REASON_MARKER)).toBe(true);
      // A marker with nothing after it would satisfy `startsWith` and explain
      // nothing, which is the shell A3 rules out. The threshold is a sentence,
      // not a word.
      expect(declaration.reason.length).toBeGreaterThan(DEFERRED_REASON_MARKER.length + 40);
      expect(['P1', 'P2', 'P3', 'P5']).toContain(declaration.phase);
    }
  });

  /**
   * The other half of the A3 gate (audit core-host-01).
   *
   * Until T028 this table could only be wrong in one direction — a name both
   * registered and deferred — and even that check was a hand-written list of
   * constants. It missed the drift that actually happened: the entry named
   * `runtimeSubagent`, the live service is `runtimeSubagents`, so the plural
   * never collided with the singular and the table went on calling a shipped
   * capability "not implemented" for five batches.
   *
   * These two rules read the runtime's own source instead of a list kept by
   * hand, so both directions fail loudly:
   *
   *  - a deferred name that some plugin already registers (`X_SERVICE = '...'`);
   *  - a deferred name that no `declare module 'cordis'` block declares, which
   *    is what a typo looks like — the contract it promises does not exist.
   */
  const runtimeRoot = path.resolve(__dirname, '..');

  function runtimeSources(dir: string, found: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '__tests__'].includes(name)) continue;
      const entry = path.join(dir, name);
      if (statSync(entry).isDirectory()) runtimeSources(entry, found);
      else if (name.endsWith('.ts')) found.push(entry);
    }
    return found;
  }

  const sources = runtimeSources(runtimeRoot).map((file) => readFileSync(file, 'utf8'));
  const registeredNames = new Set<string>();
  const declaredNames = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/_SERVICE\s*=\s*'([^']+)'/g)) {
      registeredNames.add(match[1] as string);
    }
    for (const block of source.matchAll(/declare module 'cordis'\s*{([\s\S]*?)\n}/g)) {
      for (const property of (block[1] as string).matchAll(/^\s{4}(\w+)[?]?:/gm)) {
        declaredNames.add(property[1] as string);
      }
    }
  }

  it('reads the runtime source it is supposed to be checking against', () => {
    // Guards the gate: a walker that found nothing, or a pattern that matched
    // nothing, would wave every table entry through.
    expect(sources.length).toBeGreaterThan(50);
    expect([...registeredNames]).toContain('runtimeSubagents');
    expect([...declaredNames]).toContain('runtimeSubagents');
    expect([...declaredNames]).toContain('runtimeModel');
  });

  it('never defers a service some plugin already registers', () => {
    expect(Object.keys(DEFERRED_SERVICES).filter((name) => registeredNames.has(name))).toEqual([]);
  });

  it('never defers a name no cordis augmentation declares', () => {
    expect(Object.keys(DEFERRED_SERVICES).filter((name) => !declaredNames.has(name))).toEqual([]);
  });
});
