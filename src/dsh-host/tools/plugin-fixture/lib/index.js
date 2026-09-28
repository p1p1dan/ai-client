/**
 * @aiclient-test/dsh-fixture-plugin — the `fixture-ping` row (dsh-rebase
 * P1-10b, decision 108): registers one tool, `fixture_ping`, and says on
 * stderr where it was loaded from, so a driver can tell the host composed it
 * and from which directory. Test-only; never part of the app build.
 * @module @aiclient-test/dsh-fixture-plugin
 */

import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'fixture-ping';
export const inject = ['tools'];

/** The line a driver looks for; the package directory follows it. */
export const ACTIVE_MARKER = '[dsh-fixture-plugin] active from ';

export function apply(ctx) {
  process.stderr.write(`${ACTIVE_MARKER}${fileURLToPath(new URL('..', import.meta.url))}\n`);
  ctx.tools.register(
    defineTool({
      name: 'fixture_ping',
      description: 'Test-only tool of the P1-10b fixture plugin. Answers pong.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        return 'pong';
      },
    })
  );
}
