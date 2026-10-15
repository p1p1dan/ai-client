/**
 * Shapes shared by the A/B harness: case files, variant files, the per-run
 * record (docs/agent-project-engineering.md §2, §4, §15) and the normalized
 * trace both clients are folded into.
 */

// ---- case files (cases/*.json) ----------------------------------------------

export type RepoSource = { fixture: string } | { git: string; commit: string };

/** A command run in the workspace after the agent finished (and after `overlay`). */
export interface CommandCheck {
  id?: string;
  /** Executed directly, no shell: the portable form. */
  argv?: string[];
  /** Executed through the platform shell (cmd.exe on Windows, /bin/sh elsewhere). */
  shell?: string;
  expectExit?: number;
  timeoutMs?: number;
}

/**
 * A regular expression that must (`required`) or must not (`forbidden`)
 * match. `in`: `added` = lines the agent added (git diff), `content` = the
 * final content of changed files (or of `paths` when given), `answer` = the
 * agent's final reply.
 */
export interface PatternCheck {
  id?: string;
  pattern: string;
  flags?: string;
  in?: 'added' | 'content' | 'answer';
  /** Globs relative to the repository root; default every changed file. */
  paths?: string[];
}

export interface CaseChecks {
  commands?: CommandCheck[];
  /** Every glob must match at least one changed file. */
  mustChange?: string[];
  /** No changed file may match any of these globs. */
  mustNotChange?: string[];
  forbidden?: PatternCheck[];
  required?: PatternCheck[];
  /** Changed paths left out of every check and of the line counts. */
  ignore?: string[];
  /** A directory (relative to the case file) copied over the workspace before `commands`. */
  overlay?: string;
}

export interface CaseBudget {
  timeMs?: number;
  /** Model calls of the main agent. */
  maxSteps?: number;
}

export interface CaseJudge {
  rubric: string;
  dimensions?: string[];
}

/** One step of the scripted model the fake gateway's `ab-eval` plan plays. */
export type FakeStep =
  | { op: 'cwd' }
  | { op: 'shell'; command: string; description?: string }
  | { op: 'read'; path: string }
  | { op: 'edit'; path: string; old: string; new: string }
  | { op: 'write'; path: string; content: string }
  | { op: 'grep'; pattern: string; path?: string }
  | { op: 'glob'; pattern: string; path?: string }
  | { op: 'call'; tool: string; input?: Record<string, unknown> }
  /** The client's question tool; skipped where none is offered (Claude Code under -p). */
  | { op: 'ask'; question: string; options?: string[] }
  | { op: 'answer'; text: string };

/** What the self-test expects of every client's record when the fake model plays `steps`. */
export interface FakeExpectation {
  /** Default `completed`. */
  status?: RunStatus;
  passed?: boolean;
  steps?: number;
  toolCalls?: number;
  toolErrors?: number;
  unknownToolCalls?: number;
  nonZeroExits?: number;
  changedFiles?: number;
  /** Tags the record must carry (a subset). */
  failureTags?: string[];
}

export interface FakeExpect extends FakeExpectation {
  /** Overrides for one client, where the script plays differently (an `ask` step). */
  byClient?: Partial<Record<ClientName, FakeExpectation>>;
}

export interface CaseFile {
  id: string;
  title?: string;
  /** smoke | main | incident | field (§7). */
  tier?: string;
  tags?: string[];
  repo: RepoSource;
  /** The task, inline; or `promptFile`, a text file relative to the case file. */
  prompt?: string;
  promptFile?: string;
  /**
   * Commands run in the workspace before the agent starts (installing
   * dependencies, say). What they change is committed into the base, so it is
   * never counted as the agent's work; a failing one ends the run as
   * `setup_error`.
   */
  setup?: CommandCheck[];
  checks?: CaseChecks;
  budget?: CaseBudget;
  judge?: CaseJudge;
  /** The happy path as a scripted model, for the fake gateway (§3). */
  fakeModel?: {
    steps: FakeStep[];
    expect?: FakeExpect;
    /** The clients play it differently (an `ask` step), so their totals may differ. */
    asymmetric?: boolean;
  };
}

export interface LoadedCase extends CaseFile {
  file: string;
  dir: string;
  /** The task text, from `prompt` or `promptFile`. */
  prompt: string;
  /** sha256 of the case file's bytes (and of its prompt file). */
  sha256: string;
  /** sha256 over the fixture tree (fixture sources) or the commit (git sources). */
  repoSha256: string;
  /** The overlay directory, resolved, when `checks.overlay` is set. */
  overlayDir?: string;
  budgetResolved: Required<CaseBudget>;
}

// ---- variants (variants/*.json) and arms -----------------------------------

/**
 * `pilab`: the DSH host; `pilab-sdk`: route B, the Claude Agent SDK host
 * (src/claude-sdk-host); `claude-code`: the Claude Code CLI under `-p`.
 */
export type ClientName = 'pilab' | 'pilab-sdk' | 'claude-code';

/** File contents: inline text, or a file relative to the variant file. */
export type FileSource = string | { file: string };

export interface VariantFile {
  name: string;
  client: ClientName;
  description?: string;
  /** Environment overrides for the host (pilab, pilab-sdk) or the CLI (claude-code). */
  env?: Record<string, string>;
  // pilab
  /** Package name -> on/off, as Main sends it (`AICLIENT_DSH_PLUGINS`). */
  plugins?: Record<string, boolean>;
  /** Written into $DSH_HOME before the host starts, e.g. `cordis.patch.yml`. */
  dshHomeFiles?: Record<string, FileSource>;
  /** Written into the app's agent directory (`AICLIENT_PERMISSION_AGENT_DIR`), e.g. `AGENTS.md`. */
  agentDirFiles?: Record<string, FileSource>;
  /** The user's request settings in the model plan (`DshRouteSettingsInput`). */
  planSettings?: Record<string, unknown>;
  /** Merged into the route's model row. */
  modelRow?: Record<string, unknown>;
  /** Merged into the route's compat. */
  compat?: Record<string, unknown>;
  // claude-code
  /** Extra CLI arguments. */
  args?: string[];
  /** Written into the throwaway CLAUDE_CONFIG_DIR (claude-code, pilab-sdk), e.g. `settings.json`. */
  configFiles?: Record<string, FileSource>;
}

export interface LoadedVariant extends VariantFile {
  file: string;
  sha256: string;
  /** Every FileSource resolved to text. */
  resolvedFiles: {
    dshHome: Record<string, string>;
    agentDir: Record<string, string>;
    config: Record<string, string>;
  };
}

/** One column of the comparison: a client, optionally under a variant. */
export interface Arm {
  /** `pilab`, `pilab-sdk`, `claude-code`, or `<client>+<variant>`. */
  id: string;
  client: ClientName;
  variant?: LoadedVariant;
}

// ---- normalized trace -------------------------------------------------------

export type ToolCategory =
  | 'read'
  | 'edit'
  | 'write'
  | 'shell'
  | 'search'
  | 'web'
  | 'subagent'
  | 'todo'
  | 'plan'
  | 'other';

export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** One model call. */
export interface LlmEvent {
  kind: 'llm';
  /** Milliseconds since the run started, when the client says. */
  t?: number;
  step: number;
  subagent: boolean;
  usage?: TokenUsage;
  text: string;
  toolCalls: string[];
}

/** One tool call and its result. */
export interface ToolEvent {
  kind: 'tool';
  t?: number;
  step: number;
  subagent: boolean;
  id: string;
  name: string;
  category: ToolCategory;
  input: unknown;
  /** The call never got a result (cut off by a stop or a crash). */
  pending: boolean;
  /** The tool reported an error (an unknown tool's refusal included). */
  error: boolean;
  /** The tool does not exist in this session. */
  unknown: boolean;
  /** A shell call's exit code, when the result carries one. */
  exitCode: number | null;
  output: string;
}

export type TraceEvent = LlmEvent | ToolEvent;

/** What a client runner hands back; the suite adds checks, changes and the judge. */
export interface ClientRun {
  status: RunStatus;
  error?: string;
  /** Prompt submitted to final reply (or to the cut). */
  durationMs: number;
  /** Including process or host start. */
  wallMs: number;
  answer: string;
  events: TraceEvent[];
  /** Tool names the client offered the model. */
  offeredTools: string[];
  tokens: TokenUsage;
  /** Where `tokens` came from: the client's own totals, or a partial sum. */
  tokensSource: string;
  info: Record<string, unknown>;
}

// ---- records ----------------------------------------------------------------

export type RunStatus = 'completed' | 'timeout' | 'step_budget' | 'client_error' | 'setup_error';

export interface CheckResult {
  id: string;
  kind: 'setup' | 'command' | 'mustChange' | 'mustNotChange' | 'forbidden' | 'required';
  passed: boolean;
  detail: Record<string, unknown>;
}

export interface ChangedFile {
  path: string;
  status: string;
  added: number;
  deleted: number;
  binary: boolean;
}

export interface ToolTally {
  calls: number;
  errors: number;
  unknown: number;
  nonZeroExits: number;
}

export interface RunMetrics {
  durationMs: number;
  wallMs: number;
  /** Model calls of the main agent. */
  steps: number;
  toolCalls: number;
  /** Results the tool reported as errors, unknown tools excluded. */
  toolErrors: number;
  unknownToolCalls: number;
  /** Shell calls that ran and exited non-zero (not counted as errors). */
  nonZeroExits: number;
  /** Calls cut off before a result. */
  pendingToolCalls: number;
  subagentToolCalls: number;
  tools: Record<string, ToolTally & { category: ToolCategory }>;
  categories: Partial<Record<ToolCategory, ToolTally>>;
  tokens: TokenUsage & { total: number };
  tokensSource: string;
  changes: { files: number; added: number; deleted: number; lines: number };
}

export interface JudgeResult {
  model: string;
  version: string;
  score?: number;
  dimensions?: Record<string, number>;
  issues?: string[];
  error?: string;
}

export interface RunRecord {
  schema: 'ab-eval.run/1';
  runId: string;
  suiteRunId: string;
  timestamp: string;
  case: { id: string; title?: string; tier?: string; sha256: string; repoSha256: string };
  arm: { id: string; client: ClientName; variant?: { name: string; sha256: string } };
  rep: number;
  order: number;
  model: string;
  effort: string;
  gateway: { kind: 'fake' | 'real'; id: string };
  status: RunStatus;
  /** Completed and every deterministic check passed. */
  passed: boolean;
  /** The case's setup commands, before the agent started (not in `metrics`). */
  setup?: { ms: number; results: CheckResult[] };
  checks: CheckResult[];
  failureTags: string[];
  metrics: RunMetrics;
  answer: { chars: number; text: string };
  judge?: JudgeResult;
  client: Record<string, unknown>;
  baseCommit: string;
  /** Relative to the suite's output directory. */
  artifacts: Record<string, string>;
  errors: string[];
}
