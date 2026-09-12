/**
 * P5-2-3 — `browser_preview`, the host preview facade.
 *
 * Provenance: PI-Desktop exposes `BrowserPreview` as an assignable subagent
 * tool (its ADR 0170 moved the implementation into a bundled plugin but kept
 * the tool name reachable). The P5-2 contract names it as a host capability
 * this batch must land, not an optional extra: a definition may declare it, and
 * `fixer`-style work on a web page is the case it exists for.
 *
 * What is ours, and deliberately small:
 *
 * - **It is a facade, not a browser.** This module opens nothing. It validates
 *   the target, takes it through the same permission gate every other tool
 *   uses, and hands it to a host callback. No CDP, no plugin platform, no
 *   second window system inside the runtime — the contract rules all three out.
 * - **No host callback means no tool.** Registered only when the host supplies
 *   one, exactly like `ask`. A tool that is always advertised and always
 *   answers "previewing is not available here" trains the model to keep calling
 *   it; a tool that is absent is a capability the model can see it lacks.
 * - **Workspace files only.** The target is resolved and gated like any other
 *   path, so a delegate cannot preview `~/.ssh/config` by calling it a page.
 */

import { extname } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { type Static, type TSchema, Type } from 'typebox';
import { RuntimeHostError } from '../../host/errors.ts';

/** File types a preview surface is expected to render. */
const PREVIEWABLE = new Set(['.html', '.htm', '.svg', '.md', '.markdown']);

export interface PreviewRequest {
  /** Absolute, canonical path inside the workspace. */
  path: string;
  /** True to bring an already-open preview to the front. */
  focus: boolean;
}

/**
 * The host's preview surface.
 *
 * Resolves once the target is showing. Rejecting is how a host says "I have a
 * preview surface but it could not open this", which reaches the model as a
 * tool error rather than as a success with nothing on screen.
 */
export type PreviewHost = (request: PreviewRequest, signal?: AbortSignal) => Promise<void>;

const PREVIEW_PARAMETERS = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 4096,
      description: 'Workspace file to preview (.html, .htm, .svg or .md).',
    }),
    focus: Type.Optional(
      Type.Boolean({
        description:
          'Bring the preview to the front. Leave false while working in the background so you do not steal focus from the user.',
      })
    ),
  },
  { additionalProperties: false }
);

/**
 * @param resolvePath gate + canonicalise, supplied by the tools plugin so this
 * tool takes the identical permission path as `read`.
 */
export function browserPreviewTool(
  preview: PreviewHost,
  resolvePath: (toolCallId: string, input: string, signal?: AbortSignal) => Promise<string>
): AgentTool<TSchema, unknown> {
  return {
    name: 'browser_preview',
    label: 'Browser Preview',
    description:
      'Show a workspace HTML, SVG or Markdown file in the app preview. The preview reloads by itself when you edit the file, so call this once per file rather than after every change. Does not take focus unless you ask it to.',
    parameters: PREVIEW_PARAMETERS,
    execute: async (id, params, signal): Promise<AgentToolResult<unknown>> => {
      const args = params as Static<typeof PREVIEW_PARAMETERS>;
      const target = await resolvePath(id, args.path, signal);
      const extension = extname(target).toLowerCase();
      if (!PREVIEWABLE.has(extension)) {
        // Refused here rather than handed to the host, so the message names the
        // real reason instead of whatever a viewer says about a binary.
        throw new RuntimeHostError(
          'invalid_tool_arguments',
          `browser_preview cannot show ${extension || 'a file with no extension'}; it renders ${[...PREVIEWABLE].join(', ')}`
        );
      }
      await preview({ path: target, focus: args.focus === true }, signal);
      return {
        content: [
          {
            type: 'text',
            text: `Previewing ${target}${args.focus ? ' (brought to the front)' : ''}. It reloads on its own when the file changes.`,
          },
        ],
        details: { path: target, focus: args.focus === true },
      };
    },
  };
}
