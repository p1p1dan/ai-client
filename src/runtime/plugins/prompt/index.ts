import { type Context, Service } from 'cordis';
import { HOST_IO_SERVICE, PROMPT_SERVICE, type RuntimePromptService } from '../../contracts.ts';
import { modeSegment, permissionGearSegment } from '../permissions/prompt.ts';
import { toolSegments } from '../tools/prompt.ts';
import { baseSegments } from './baseSegments.ts';
import { instructionSource } from './instructionSource.ts';
import {
  type InstructionChainOptions,
  loadInstructionChain,
  projectInstructionsSegment,
} from './projectInstructions.ts';
import { composeSystemPrompt } from './segments.ts';

export interface PromptConfig {
  /** Defaults to the tools workspace; no implicit process.cwd() fallback. */
  root?: string;
  /** Explicit borrowed files, appended after the managed agent-dir AGENTS.md. */
  globals?: InstructionChainOptions['globals'];
  maxBytes?: number;
}

export class PromptPlugin extends Service implements RuntimePromptService {
  static inject = [HOST_IO_SERVICE];
  private readonly config: PromptConfig;

  constructor(ctx: Context, config: PromptConfig = {}) {
    super(ctx, PROMPT_SERVICE);
    this.config = config;
  }

  async compose(request: { targetPath?: string } = {}) {
    const segments = [...baseSegments()];
    if (this.ctx.get('runtimeTools')) segments.push(...toolSegments());
    const entries = await loadInstructionChain(
      instructionSource(this.ctx.runtimeHostIo, this.config.maxBytes),
      { ...this.config, targetPath: request.targetPath }
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
