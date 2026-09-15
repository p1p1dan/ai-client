import { resolve } from 'node:path';
import { type Context, Service } from 'cordis';
import { HOST_IO_SERVICE, PROMPT_SERVICE, type RuntimePromptService } from '../../contracts.ts';
import { resolveSettingSources, type SettingSourceOptions } from '../../settingSources.ts';
import { modeSegment, permissionGearSegment } from '../permissions/prompt.ts';
import { toolSegments } from '../tools/prompt.ts';
import { baseSegments } from './baseSegments.ts';
import { instructionSource } from './instructionSource.ts';
import { InstructionTracker } from './instructionTracker.ts';
import {
  type InstructionChainOptions,
  loadInstructionChain,
  type ProjectInstruction,
  projectInstructionsSegment,
} from './projectInstructions.ts';
import { composeSystemPrompt } from './segments.ts';

export interface PromptConfig extends SettingSourceOptions {
  /** Defaults to the tools workspace; no implicit process.cwd() fallback. */
  root?: string;
  /** Explicit borrowed files, appended after the managed agent-dir AGENTS.md. */
  globals?: InstructionChainOptions['globals'];
  maxBytes?: number;
}

export class PromptPlugin extends Service implements RuntimePromptService {
  static inject = [HOST_IO_SERVICE];
  private readonly config: PromptConfig;
  /**
   * decision 007 — session state, so it lives on the plugin rather than being
   * rebuilt per `compose()`. Absent when there is no workspace to walk into.
   */
  private readonly tracker?: InstructionTracker;

  constructor(ctx: Context, config: PromptConfig = {}) {
    super(ctx, PROMPT_SERVICE);
    this.config = config;
    if (config.root) {
      const sources = resolveSettingSources(config);
      this.tracker = new InstructionTracker({
        source: instructionSource(ctx.runtimeHostIo, config.maxBytes),
        root: resolve(config.root),
        enabled: sources.project,
        local: sources.local,
        ...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes }),
      });
    }
  }

  /**
   * decision 007 — told by the tools plugin which files a call actually
   * touched, so a subdirectory's instruction file can come into scope.
   */
  async noteFilesTouched(paths: readonly string[]): Promise<void> {
    await this.tracker?.note(paths);
  }

  /** Entries discovered since the last call; the loop injects them as a message. */
  takePendingInstructions(): readonly ProjectInstruction[] {
    return this.tracker?.take() ?? [];
  }

  async compose() {
    const segments = [...baseSegments()];
    if (this.ctx.get('runtimeTools')) segments.push(...toolSegments());
    // P5-1. Read through `ctx.get` like the other optional contributors: a
    // graph built without tools has no `skill` tool either, and a catalog
    // advertised without it would name capabilities the model cannot reach.
    const skills = this.ctx.get('runtimeSkills')?.segment();
    if (skills) segments.push(skills);
    const entries = await loadInstructionChain(
      instructionSource(this.ctx.runtimeHostIo, this.config.maxBytes),
      this.config
    );
    const instructions = projectInstructionsSegment(entries);
    if (instructions) segments.push(instructions);
    const permissions = this.ctx.get('runtimePermissions');
    if (permissions) {
      segments.push(modeSegment(permissions.mode), permissionGearSegment(permissions.gear));
    }
    return composeSystemPrompt(segments);
  }
}
