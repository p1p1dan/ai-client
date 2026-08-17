import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * Build spec 2026-08-14 (partial messages), 施工纪律: mechanical gate for the
 * "stays importable under vitest's node environment" rule that slice 0 and
 * slice 2/3 modules (`turnStatus.ts`, `historyError.ts`, `eventRing.ts`,
 * `contextSurfaceModel.ts`) depend on for their own test suites to run at
 * all.
 *
 * These modules are asserted elsewhere to be pure (no DOM, no store
 * subscription) precisely so their truth tables can be driven directly from
 * `node`-env vitest without mounting React. That property is easy to lose
 * silently: a single stray `import { useX } from '@/stores/...'` (a VALUE
 * import — it runs at module load) is enough to pull React and/or zustand's
 * runtime into the graph, which is exactly the shape that has hung this
 * repo's node-env vitest run before (see the spike note this batch's docs
 * reference). A source scan catches the reintroduction immediately, instead
 * of as an opaque test-runner hang days later.
 *
 * `import type ...` lines are exempt: TypeScript erases them at compile time,
 * so they never execute and can never pull in a runtime dependency, no matter
 * what module they name. `contextSurfaceModel.ts` legitimately reaches
 * `@/stores/chatSessions` today for exactly one type (`ChatMessage`) — the
 * forbidden-specifier list below is scoped to VALUE imports so that stays
 * green without widening the gate to something that would also pass a real
 * store import next to it.
 */

/** Readable, not clever: each entry is the exact text a forbidden import contains. */
const FORBIDDEN_VALUE_IMPORT_SPECIFIERS = [
  "from 'react'",
  "from '@/stores",
  "from '@/components/settings",
];

const TARGET_FILES = [
  '../turnStatus.ts',
  '../historyError.ts',
  // Ships in build-spec slice 2 (diagnostic event ring). Not built yet in
  // slice 0 — skipped below rather than failing, per the spec's own note.
  '../eventRing.ts',
  '../../workspace-shell/surfaces/contextSurfaceModel.ts',
  // D48 S1: the agent picker's whole decision surface lives in these two, and
  // their truth tables are the only automated coverage the picker gets (no
  // `.tsx` renders under this config). A stray store import here would take
  // both suites out at once, as an opaque runner hang rather than a red test.
  '../sessionBinding.ts',
  '../composerAgentPickerModel.ts',
  // D48 S2: the family whitelist and the seed table are read by Main (the
  // catalog service), by the renderer's menu model and by tests. A store or
  // React import in either would take the Main-side suite down as well as this
  // one — and would be an import edge from `src/shared` into `src/renderer`,
  // which nothing else in the tree has.
  '../../../../shared/models/familyWhitelist.ts',
  '../../../../shared/models/seedCatalog.ts',
  // D48 S2 renderer half: the model SELECTION rules, the catalog's product
  // copy, the (session, agent) storage layer and the app-settings template
  // shape. Every branch the Composer's model trigger takes lives in one of
  // these four — the `.tsx` itself is wiring — so a React or store import here
  // would silently move a decision out of reach of every truth table in the
  // slice, and take the suites with it.
  '../models.ts',
  '../agentModelCatalog.ts',
  '../sessionPreferenceStore.ts',
  '../../../../shared/models/chatAgentDefaults.ts',
] as const;

/** Import statement lines only, `import type ...` lines excluded. */
function valueImportLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('import '))
    .filter((line) => !line.startsWith('import type '));
}

describe('pure module import gate (build spec 施工纪律)', () => {
  for (const relativePath of TARGET_FILES) {
    const absolutePath = fileURLToPath(new URL(relativePath, import.meta.url));

    if (!existsSync(absolutePath)) {
      it.skip(`${relativePath}: file does not exist yet (later slice)`, () => {});
      continue;
    }

    it(`${relativePath} carries no react / store / settings value import`, () => {
      const source = stripComments(readFileSync(absolutePath, 'utf8'), absolutePath);
      const lines = valueImportLines(source);
      for (const forbidden of FORBIDDEN_VALUE_IMPORT_SPECIFIERS) {
        const offender = lines.find((line) => line.includes(forbidden));
        expect(offender, `${relativePath}: found "${forbidden}" in "${offender}"`).toBeUndefined();
      }
    });
  }
});
