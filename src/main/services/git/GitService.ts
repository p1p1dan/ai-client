import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import type {
  CloneProgress,
  CommitFileChange,
  FileChange,
  FileChangeStatus,
  FileChangesResult,
  FileDiff,
  GhCliStatus,
  GitBlameLineInfo,
  GitBranch,
  GitHeadSignature,
  GitLogEntry,
  GitStatus,
  GitSubmodule,
  PullRequest,
  SubmoduleStatus,
} from '@shared/types';
import type { SimpleGit, StatusResult } from 'simple-git';
import { parseBranchVerbose } from './branchVerboseParse';
import { decodeBuffer, detectBinaryFile, gitShow, readWorkingTreeFile } from './encoding';
import { GIT_LOG_PRETTY_FORMAT, parseGitLogOutput } from './gitLogFormat';
import {
  GitCommandError,
  isGitExitError,
  noteLostOutput,
  noteRunnerRead,
  noteRunnerRecovered,
  probeGitExitCode,
  readGit,
  runGitTextViaRunner,
  shouldRouteViaRunner,
} from './gitReadFallback';
import { GitOutputLostError, isGitOutputLostError } from './nodeGitRunner';
import {
  feedPorcelainV2Records,
  PorcelainV2FileChangesAccumulator,
  type PorcelainV2RecordSink,
  PorcelainV2StatusAccumulator,
} from './porcelainV2Status';
import {
  createGitEnv,
  createSimpleGit,
  isWslGitRepository,
  normalizeGitRelativePath,
  spawnGit,
  toGitPath,
} from './runtime';

const execAsync = promisify(exec);

const MAX_GIT_STATUS_ENTRIES = 5000;
const MAX_GIT_FILE_CHANGES = 5000;
const GIT_STATUS_STREAM_TIMEOUT_MS = 15000;

// The status command line. The node-runner fallback runs exactly this too, so
// both paths feed the same record parser.
const GIT_STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'];
// `git branch -a -v` is what simple-git runs for `this.git.branch(['-a', '-v'])`;
// `--no-color` keeps a `color.branch=always` config out of the fallback parse.
const GIT_BRANCH_FALLBACK_ARGS = ['branch', '--no-color', '-a', '-v'];

/**
 * `git status --porcelain=v2 --branch` always emits the `# branch.*` headers
 * before anything else, so a zero-exit run that produced none of them did not
 * report on a repository at all — its output was lost. Q7 on the encrypted
 * Windows host is exactly this shape, and every reader used to turn it into a
 * confident "clean repo" answer instead of an error.
 */
function noStatusOutputError(stderr: string): GitOutputLostError {
  // Typed regardless of the message: when git also wrote to stderr, the message
  // is that stderr, but the output is lost all the same (F3 keys on the type).
  return new GitOutputLostError(
    stderr.trim() || 'git status exited 0 without emitting branch headers; its output was lost'
  );
}

function statusTimedOutError(): Error {
  return new Error(`git status timed out after ${GIT_STATUS_STREAM_TIMEOUT_MS}ms`);
}

function branchListingLostError(via: string): GitOutputLostError {
  return new GitOutputLostError(
    `git branch -a -v${via} returned no branches for a repository that has commits; ` +
      'its output was lost'
  );
}

function toGitBranches(
  branches: Record<string, { current: boolean; commit: string; label: string }>
): GitBranch[] {
  return Object.entries(branches).map(([name, info]) => ({
    name,
    current: info.current,
    commit: info.commit,
    label: info.label,
  }));
}

export class GitService {
  private git: SimpleGit;
  private workdir: string;

  constructor(workdir: string) {
    this.git = createSimpleGit(workdir);
    this.workdir = workdir;
  }

  private getGitEnv(workdir = this.workdir): NodeJS.ProcessEnv {
    return createGitEnv(workdir);
  }

  private normalizePathsForGit(paths: string[]): string[] {
    if (!isWslGitRepository(this.workdir)) {
      return paths;
    }
    return paths.map((filePath) => normalizeGitRelativePath(toGitPath(this.workdir, filePath)));
  }

  /**
   * Stream `git status --porcelain=v2 --branch -z` into `sink`, stopping git
   * once the sink is full. Rejects with a typed `GitOutputLostError` when git
   * exited 0 without its branch headers (Q7 / F3).
   */
  private streamPorcelainV2(sink: PorcelainV2RecordSink): Promise<void> {
    // `truncated` used to mean both "hit the entry cap" and "timed out", and the
    // close handler skipped its reject when either was set — so a timeout came
    // back as a half-read status that looked successful. Keep them apart.
    let timedOut = false;
    let remainder = '';
    let stderr = '';
    // Decode across chunk boundaries: a multi-byte character split between two
    // chunks used to become U+FFFD in the middle of a path.
    const decoder = new StringDecoder('utf8');

    return new Promise((resolve, reject) => {
      // Use 'normal' mode for status - only need to know if there are untracked files,
      // not the full list. This significantly improves performance for large repos.
      const proc = spawnGit(this.workdir, GIT_STATUS_ARGS, {
        cwd: this.workdir,
        env: this.getGitEnv(),
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        if (!proc.killed) proc.kill('SIGKILL');
      }, GIT_STATUS_STREAM_TIMEOUT_MS);

      proc.stdout.on('data', (chunk: Buffer) => {
        if (sink.truncated || timedOut) return;
        remainder += decoder.write(chunk);
        const records = remainder.split('\0');
        remainder = records.pop() ?? '';
        for (const record of records) {
          sink.push(record);
          if (sink.truncated) {
            if (!proc.killed) proc.kill('SIGTERM');
            break;
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length > 8192) return;
        stderr += chunk.toString('utf8');
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(statusTimedOutError());
          return;
        }
        // Our own SIGTERM once the sink is full: the records read so far stand.
        if (sink.truncated) {
          resolve();
          return;
        }
        // Killed from outside (OOM killer, `pkill git`): a failure, never a lost
        // output — that would fall back and flip the process-wide runner switch
        // on an ordinary machine, or pass a half-read status off as complete.
        if (code === null) {
          reject(new Error(`git status terminated by ${signal ?? 'a signal'}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `git status failed (${code})`));
          return;
        }
        if (!sink.sawBranchHeader) {
          reject(noStatusOutputError(stderr));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * The status records, through `sink`, with the F3 fallback: when the
   * primary stream lost its output, run the same command line with the bundled
   * node as git's parent and feed the same parser. `getStatus` and
   * `getFileChanges` both read through here; only their sinks differ.
   */
  private async readPorcelainV2<T extends PorcelainV2RecordSink>(
    what: 'status' | 'file-changes',
    makeSink: () => T
  ): Promise<T> {
    if (shouldRouteViaRunner(this.workdir)) {
      return this.readPorcelainV2ViaNode(what, makeSink(), false);
    }
    const sink = makeSink();
    try {
      await this.streamPorcelainV2(sink);
      return sink;
    } catch (err) {
      // WSL repositories go through wsl.exe, which the runner does not route.
      if (!isGitOutputLostError(err) || isWslGitRepository(this.workdir)) throw err;
      noteLostOutput(what);
      // A fresh sink: the lost run may have pushed nothing, but never reuse it.
      return this.readPorcelainV2ViaNode(what, makeSink(), true);
    }
  }

  private async readPorcelainV2ViaNode<T extends PorcelainV2RecordSink>(
    what: 'status' | 'file-changes',
    sink: T,
    afterLoss: boolean
  ): Promise<T> {
    const stdout = await runGitTextViaRunner({
      what,
      workdir: this.workdir,
      args: GIT_STATUS_ARGS,
    });
    feedPorcelainV2Records(stdout, sink);
    if (!sink.truncated && !sink.sawBranchHeader) {
      console.warn(`[git-fallback] ${what} via node runner lost its output too`);
      throw new GitOutputLostError(
        'git status via the node runner exited 0 without emitting branch headers; ' +
          'its output was lost'
      );
    }
    if (afterLoss) noteRunnerRecovered(what);
    noteRunnerRead(what, `length=${stdout.length} truncated=${sink.truncated}`);
    return sink;
  }

  async getStatus(): Promise<GitStatus> {
    const limited = (
      await this.readPorcelainV2(
        'status',
        () => new PorcelainV2StatusAccumulator(MAX_GIT_STATUS_ENTRIES)
      )
    ).result();
    const totalListed =
      limited.staged.length +
      limited.modified.length +
      limited.deleted.length +
      limited.untracked.length +
      limited.conflicted.length;

    return {
      isClean: totalListed === 0 && !limited.truncated,
      current: limited.current,
      tracking: limited.tracking,
      ahead: limited.ahead,
      behind: limited.behind,
      staged: limited.staged,
      modified: limited.modified,
      deleted: limited.deleted,
      untracked: limited.untracked,
      conflicted: limited.conflicted,
      truncated: limited.truncated,
      truncatedLimit: limited.truncated ? MAX_GIT_STATUS_ENTRIES : undefined,
    };
  }

  /**
   * T100: the fingerprint the git panel polls to notice work done outside the
   * app. Two metadata-only git calls (no working-tree walk, no object reads),
   * both far cheaper than the `git status` poll they ride alongside:
   * - `rev-parse HEAD --symbolic-full-name HEAD` -> the commit HEAD resolves to
   *   plus the ref it points at, which together cover an external `git commit`,
   *   `git checkout <branch>` and `git checkout --detach`.
   * - `for-each-ref refs/heads refs/remotes` -> every branch tip, which covers
   *   branch creation/deletion/renaming and an external `git fetch`. Hashed
   *   because the caller only ever compares it, and a repo can have thousands
   *   of remote-tracking branches we should not ship over IPC every 5s.
   */
  async getHeadSignature(): Promise<GitHeadSignature> {
    let head: string | null = null;
    let ref: string | null = null;

    try {
      // Exit 0 always prints the two lines, so an empty answer was lost (F3).
      const { stdout } = await readGit({
        what: 'rev-parse',
        workdir: this.workdir,
        args: ['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'],
        lostWhen: 'empty',
      });
      const [headLine = '', refLine = ''] = stdout.split('\n').map((line) => line.trim());
      head = headLine || null;
      // `--symbolic-full-name HEAD` prints the literal string "HEAD" when no
      // branch is checked out; that is a detached head, not a ref name.
      ref = refLine && refLine !== 'HEAD' ? refLine : null;
    } catch (err) {
      // Unborn HEAD: a fresh repository with no commits is a normal state, not
      // a failure, and git says so with a non-zero exit. The branch-ref digest
      // below is still meaningful. Anything else (lost output, a runner that
      // could not start) is not "unborn" and must not pass for it.
      if (!isGitExitError(err)) throw err;
    }

    const { stdout: refLines } = await readGit({
      what: 'for-each-ref',
      workdir: this.workdir,
      args: ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes'],
      // No refs at all is a real answer, except when HEAD is on a branch: that
      // branch exists, so the listing cannot be empty.
      lostWhen: (out) => out.trim() === '' && ref?.startsWith('refs/heads/') === true,
    });

    // `for-each-ref` sorts by refname by default, so equal repositories hash
    // equal without sorting here.
    return { head, ref, refs: createHash('sha1').update(refLines).digest('hex') };
  }

  /**
   * Branches of this repository.
   *
   * ## `skipMerged`
   *
   * The PR-merged marking below shells out to `gh pr list` with a 5 s timeout,
   * unconditionally. That is affordable for the one caller that WANTS the mark
   * (the branch list App fetches for worktree creation), and unaffordable for a
   * branch PICKER that is permanently mounted: every mount would pay the call,
   * and on a machine with no authenticated `gh` it pays the whole timeout before
   * the catch swallows it.
   *
   * Callers that only need names to switch between pass `skipMerged: true` and
   * get `git branch -a -v` alone — no `gh`, no `merged` field. Absent means the
   * old behaviour, so every existing caller is untouched.
   */
  async getBranches(options?: { skipMerged?: boolean }): Promise<GitBranch[]> {
    const listing = await this.readBranchListing();
    // The fresh-repo answer (one synthetic entry, or none) is final: there is
    // nothing to mark as merged.
    if (listing.unborn) {
      return listing.branches;
    }
    const branches = listing.branches;

    // After the empty-listing judgement, not before: a picker needs the
    // synthetic unborn-HEAD entry and the lost-output error just as much.
    if (options?.skipMerged) {
      return branches;
    }

    // Determine base branch for merge detection
    let baseBranch: string | null = null;

    // 1. Try to get remote default branch (origin/HEAD)
    try {
      const originHead = await this.git.raw([
        'symbolic-ref',
        '--quiet',
        'refs/remotes/origin/HEAD',
      ]);
      // Example output: "refs/remotes/origin/main"
      const match = originHead.trim().match(/^refs\/remotes\/(.+)$/);
      if (match) {
        baseBranch = match[1]; // "origin/main"
      }
    } catch {
      // origin/HEAD not set, fall through to fallback
    }

    // 2. Fallback to common main branch names
    if (!baseBranch) {
      const localNames = ['main', 'master', 'develop'];
      const found = branches.find((b) => localNames.includes(b.name));
      if (found) {
        baseBranch = found.name;
      }
    }

    // 3. If still no base branch, skip merged detection
    if (!baseBranch) {
      return branches;
    }

    // Get merged PR information from GitHub CLI
    const mergedPRBranches = new Set<string>();
    try {
      const { stdout } = await execAsync(
        'gh pr list --state merged --json headRefName --limit 200',
        {
          cwd: this.workdir,
          env: this.getGitEnv(),
          timeout: 5000,
        }
      );
      const prs = JSON.parse(stdout) as Array<{ headRefName: string }>;
      for (const pr of prs) {
        mergedPRBranches.add(pr.headRefName);
      }
    } catch {
      // gh CLI not available or not authenticated, skip PR detection
    }

    // Mark branches as merged (only via PR detection)
    return branches.map((branch) => {
      const branchNameWithoutRemote = branch.name.replace(/^(remotes\/)?origin\//, '');
      return {
        ...branch,
        merged: mergedPRBranches.has(branchNameWithoutRemote),
      };
    });
  }

  /**
   * `git branch -a -v` as `GitBranch[]`, including the empty-listing judgement
   * (Q7) and the F3 recovery. `unborn` marks the synthetic fresh-repo answer.
   */
  private async readBranchListing(): Promise<{ branches: GitBranch[]; unborn: boolean }> {
    // Once the runner has recovered lost output in this process, skip the
    // primary run that would only lose it again (see `gitReadFallback`).
    const viaRunner = shouldRouteViaRunner(this.workdir);
    const listed = viaRunner
      ? await this.runBranchListingViaNode()
      : toGitBranches((await this.git.branch(['-a', '-v'])).branches);
    if (listed.length > 0) {
      if (viaRunner) noteRunnerRead('branch', `branches=${listed.length}`);
      return { branches: listed, unborn: false };
    }

    // An empty listing has two causes and they need opposite answers: a repo
    // with no commits yet, or a `git branch -a -v` whose output never made it
    // back. `symbolic-ref --short HEAD` cannot tell them apart — it succeeds
    // on any repo with a branch checked out — so using it as the test labelled
    // healthy repos "(no commits yet)" (Q7). `rev-parse --verify HEAD` fails
    // only when HEAD is genuinely unborn, which is the actual question, and it
    // answers by exit code, which survives where stdout is lost (F3).
    let headResolves = false;
    try {
      await this.git.raw(['rev-parse', '--verify', 'HEAD']);
      headResolves = true;
    } catch {
      // Unborn HEAD: this really is a fresh repo.
    }

    if (headResolves) {
      // Through the runner already: nothing left to fall back to.
      if (viaRunner) throw branchListingLostError(' via the node runner');
      return { branches: await this.readBranchesViaNode(), unborn: false };
    }

    try {
      // Empty repo: rev-parse cannot name the branch, symbolic-ref can. It
      // always prints the name on success, so an empty answer was lost.
      const { stdout } = await readGit({
        what: 'symbolic-ref',
        workdir: this.workdir,
        args: ['symbolic-ref', '--short', 'HEAD'],
        lostWhen: 'empty',
      });
      return {
        branches: [
          {
            name: stdout.trim(),
            current: true,
            commit: '',
            label: '(no commits yet)',
          },
        ],
        unborn: true,
      };
    } catch {
      return { branches: [], unborn: true };
    }
  }

  /**
   * F3 fallback for a lost branch listing: run `git branch -a -v` with the
   * bundled node as git's parent (see `nodeGitRunner`) and parse it the way
   * simple-git does, so the result is the `GitBranch[]` the primary path
   * would have produced.
   */
  private async readBranchesViaNode(): Promise<GitBranch[]> {
    // WSL repositories go through wsl.exe, which the runner does not route.
    if (isWslGitRepository(this.workdir)) throw branchListingLostError('');

    noteLostOutput('branch');
    const branches = await this.runBranchListingViaNode();
    if (branches.length === 0) {
      console.warn('[git-fallback] branch via node runner lost its output too');
      throw branchListingLostError(' via the node runner');
    }
    noteRunnerRecovered('branch');
    noteRunnerRead('branch', `branches=${branches.length}`);
    return branches;
  }

  private async runBranchListingViaNode(): Promise<GitBranch[]> {
    const stdout = await runGitTextViaRunner({
      what: 'branch',
      workdir: this.workdir,
      args: GIT_BRANCH_FALLBACK_ARGS,
    });
    return toGitBranches(parseBranchVerbose(stdout));
  }

  /**
   * One page of `git log`, newest first.
   *
   * F3: on success the first page always holds at least HEAD's commit (an
   * unborn HEAD makes `git log` exit non-zero instead), so an empty first page
   * means the output was lost. A later page is legitimately empty once the
   * history is exhausted; it can only be told apart from a lost one after a
   * recovery, when every read already goes through the runner.
   */
  async getLog(maxCount = 50, skip = 0, submodulePath?: string): Promise<GitLogEntry[]> {
    const workdir = this.repoDir(submodulePath);
    const args = ['log', `-n${maxCount}`, `--pretty=format:${GIT_LOG_PRETTY_FORMAT}`];
    if (skip > 0) {
      args.push(`--skip=${skip}`);
    }

    try {
      const { stdout } = await readGit({
        what: 'log',
        workdir,
        args,
        lostWhen: (out) => out.trim() === '' && skip === 0 && maxCount > 0,
      });
      return parseGitLogOutput(stdout);
    } catch (error) {
      // Empty repo (no commits yet) - return empty array. The message is
      // English only under the C locale (the runner's); a localized git says
      // the same thing in its own words, so ask HEAD directly by exit code.
      if (isGitExitError(error)) {
        if (error instanceof Error && error.message.includes('does not have any commits yet')) {
          return [];
        }
        if (await this.isHeadUnborn(workdir)) return [];
      }
      throw error;
    }
  }

  /**
   * `rev-parse --verify --quiet HEAD` exits 1 exactly when HEAD does not
   * resolve (128 is a broken or missing repository). Exit codes survive where
   * stdout is lost, so this needs no runner.
   */
  private async isHeadUnborn(workdir: string): Promise<boolean> {
    try {
      return (await probeGitExitCode(workdir, ['rev-parse', '--verify', '--quiet', 'HEAD'])) === 1;
    } catch {
      return false;
    }
  }

  async commit(message: string, files?: string[]): Promise<string> {
    if (files && files.length > 0) {
      const normalizedFiles = this.normalizePathsForGit(files);
      await this.git.add(normalizedFiles);
    }
    const result = await this.git.commit(message);
    return result.commit;
  }

  async fetch(remote = 'origin'): Promise<void> {
    await this.git.fetch(remote);
  }

  async checkout(branch: string): Promise<void> {
    let localBranch = branch;
    if (branch.startsWith('remotes/')) {
      localBranch = await this.checkoutRemoteBranch(this.git, branch);
    } else {
      await this.git.checkout(branch);
    }
    await this.confirmHeadOnBranch(localBranch, branch);
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    await this.git.checkoutBranch(name, startPoint || 'HEAD');
    await this.confirmHeadOnBranch(name, name);
  }

  /**
   * Read HEAD back after a checkout that git reported as successful, and fail
   * when it is not on `localBranch`.
   *
   * simple-git treats a non-zero exit with an EMPTY stderr as success, so a
   * checkout that failed without a word would otherwise come back as a switch
   * that never happened. The read goes through the F3 fallback, so it holds on
   * the encrypted host too. Only a positive mismatch fails the call: when HEAD
   * cannot be read back the checkout's own exit status stands, and a target
   * that is not a local branch (a commit, a tag, the detached-HEAD entry of the
   * branch list) has no symbolic HEAD to compare against.
   */
  private async confirmHeadOnBranch(localBranch: string, requested: string): Promise<void> {
    try {
      const isLocalBranch =
        (await probeGitExitCode(this.workdir, [
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${localBranch}`,
        ])) === 0;
      if (!isLocalBranch) return;
    } catch {
      return;
    }

    let head: string | null;
    try {
      const { stdout, exitCode } = await readGit({
        what: 'symbolic-ref',
        workdir: this.workdir,
        args: ['symbolic-ref', '--quiet', 'HEAD'],
        // Exit 1: HEAD is detached.
        okExitCodes: [1],
        lostWhen: 'empty',
      });
      head = exitCode === 0 ? stdout.trim() : null;
    } catch (err) {
      console.warn(
        `[git-fallback] checkout reported success but HEAD could not be read back: ${
          isGitOutputLostError(err) ? 'output lost' : err instanceof Error ? err.name : 'unknown'
        }`
      );
      return;
    }

    if (head === `refs/heads/${localBranch}`) return;
    const actual = head ? `on ${head.replace(/^refs\/heads\//, '')}` : 'detached';
    throw new Error(`git checkout ${requested} reported success, but HEAD is ${actual}`);
  }

  async init(): Promise<void> {
    await this.git.init();
  }

  async getFileChanges(): Promise<FileChangesResult> {
    const changes = await this.readPorcelainV2(
      'file-changes',
      () => new PorcelainV2FileChangesAccumulator(MAX_GIT_FILE_CHANGES)
    );
    return changes.result();
  }

  async getFileDiff(filePath: string, staged: boolean): Promise<FileDiff> {
    // 1. Check for symbolic links first (before resolving path)
    const initialPath = path.join(this.workdir, filePath);
    const stats = await fs.lstat(initialPath).catch(() => null);
    if (stats?.isSymbolicLink()) {
      throw new Error('Cannot read symbolic links');
    }

    // 2. Validate path to prevent path traversal attacks
    const absolutePath = path.resolve(this.workdir, filePath);
    const relativePath = path.relative(this.workdir, absolutePath);

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('Invalid file path: path traversal detected');
    }

    // 3. Detect binary files to avoid rendering garbage in Monaco
    if (await detectBinaryFile(absolutePath, this.workdir, `:${filePath}`)) {
      return { path: filePath, original: '', modified: '', isBinary: true };
    }

    let original = '';
    let modified = '';

    if (staged) {
      [original, modified] = await Promise.all([
        gitShow(this.workdir, `HEAD:${filePath}`),
        gitShow(this.workdir, `:${filePath}`),
      ]);
    } else {
      original = await gitShow(this.workdir, `:${filePath}`);
      if (!original) {
        original = await gitShow(this.workdir, `HEAD:${filePath}`);
      }
      modified = await readWorkingTreeFile(absolutePath)
        .then((buffer) => decodeBuffer(buffer))
        .catch(() => '');
    }

    return { path: filePath, original, modified };
  }

  async stage(paths: string[]): Promise<void> {
    const normalizedPaths = this.normalizePathsForGit(paths);
    await this.git.add(normalizedPaths);
  }

  async unstage(paths: string[]): Promise<void> {
    const normalizedPaths = this.normalizePathsForGit(paths);
    await this.git.raw(['reset', 'HEAD', '--', ...normalizedPaths]);
  }

  async discard(filePaths: string | string[]): Promise<void> {
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const trackedPaths: string[] = [];
    const untrackedPaths: string[] = [];

    const status = await this.git.status();

    for (const filePath of paths) {
      // 1. First check for symbolic links on the original path (before resolving)
      const initialPath = path.join(this.workdir, filePath);
      const initialStats = await fs.lstat(initialPath).catch(() => null);
      if (initialStats?.isSymbolicLink()) {
        throw new Error(`Cannot discard symbolic links: ${filePath}`);
      }

      // 2. Then validate path to prevent path traversal attacks
      const absolutePath = path.resolve(this.workdir, filePath);
      const relativePath = path.relative(this.workdir, absolutePath);

      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`Invalid file path: path traversal detected - ${filePath}`);
      }

      // 3. Categorize files
      if (status.not_added.includes(filePath)) {
        untrackedPaths.push(absolutePath);
      } else {
        trackedPaths.push(filePath);
      }
    }

    // Delete untracked files
    for (const absolutePath of untrackedPaths) {
      await fs.unlink(absolutePath);
    }

    // Restore tracked files in one git command
    if (trackedPaths.length > 0) {
      await this.git.checkout(['--', ...trackedPaths]);
    }
  }

  async showCommit(hash: string): Promise<string> {
    // The header always prints the hash, so an empty answer was lost (F3).
    const { stdout } = await readGit({
      what: 'show',
      workdir: this.workdir,
      args: ['show', hash, '--pretty=format:%H%n%an%n%ae%n%ad%n%s%n%b', '--stat'],
      lostWhen: 'empty',
    });
    return stdout;
  }

  async getCommitFiles(hash: string, submodulePath?: string): Promise<CommitFileChange[]> {
    const workdir = this.repoDir(submodulePath);
    // Use cat-file to reliably detect merge commits (check parent count). A
    // commit object always has a `tree` line, so an empty answer was lost.
    const { stdout: commitInfo } = await readGit({
      what: 'cat-file',
      workdir,
      args: ['cat-file', '-p', hash],
      lostWhen: 'empty',
    });
    const isMergeCommit = (commitInfo.match(/^parent /gm) ?? []).length >= 2;

    const files: CommitFileChange[] = [];

    if (isMergeCommit) {
      // Merge commit: use git diff to compare with first parent
      // An empty merge diff is a real answer (a merge that changed nothing).
      const { stdout: mergeDiff } = await readGit({
        what: 'diff',
        workdir,
        args: ['diff', `${hash}^1`, hash, '--name-status'],
        lostWhen: 'never',
      });
      const diffLines = mergeDiff.split('\n').filter((line) => line.trim());

      for (const line of diffLines) {
        // Match: status (with optional percentage for R/C) and file path(s)
        // Format: R100\told\tnew or M\tfile or A\tfile
        const match = line.match(/^([MADRCUX])(\d+)?\t(.+)$/);
        if (match) {
          const [, status, , filePath] = match;
          // For rename/copy with two paths, take the new path
          const finalPath = filePath.includes('\t') ? filePath.split('\t')[1] : filePath;
          files.push({
            path: finalPath,
            status: status as FileChangeStatus,
          });
        }
      }
    } else {
      // Regular commit: use show --name-status
      // A root commit with no files prints nothing: empty is a real answer.
      const { stdout: commitShow } = await readGit({
        what: 'show',
        workdir,
        args: ['show', hash, '--name-status', '--pretty=format:%P'],
        lostWhen: 'never',
      });
      const lines = commitShow.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        // Match: status (with optional percentage for R/C) and file path(s)
        const match = line.match(/^([MADRCUX])(\d+)?\t(.+)$/);
        if (match) {
          const [, status, , filePath] = match;
          // For rename/copy with two paths, take the new path
          const finalPath = filePath.includes('\t') ? filePath.split('\t')[1] : filePath;
          files.push({
            path: finalPath,
            status: status as FileChangeStatus,
          });
        }
      }
    }

    return files;
  }

  async checkIgnored(paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    try {
      // git check-ignore prints the ignored paths
      const result = await this.git.checkIgnore(paths);
      return new Set(result);
    } catch {
      // Exits 1 (and throws) when none of the paths is ignored
      return new Set();
    }
  }

  async getCommitDiff(
    hash: string,
    filePath: string,
    status?: FileChangeStatus,
    submodulePath?: string
  ): Promise<FileDiff> {
    const workdir = this.repoDir(submodulePath);
    // Every read here may legitimately be empty (an empty file, no numstat),
    // so none of them can detect a loss; after a recovery they all go through
    // the runner anyway (F3, see `gitReadFallback`).
    const read = async (args: string[]): Promise<string> =>
      (await readGit({ what: args[0] ?? 'git', workdir, args, lostWhen: 'never' })).stdout;
    const showOrEmpty = (spec: string): Promise<string> => read(['show', spec]).catch(() => '');

    // Detect binary using git diff --numstat (binary files show "-" for insertions/deletions)
    try {
      const numstat = await read(['diff', '--numstat', `${hash}^..${hash}`, '--', filePath]);
      if (numstat.startsWith('-\t-\t')) {
        return { path: filePath, original: '', modified: '', isBinary: true };
      }
    } catch {
      // If detection fails (e.g., root commit without parent), continue with text diff
    }

    let originalContent = '';
    let modifiedContent = '';

    // Handle different file statuses
    if (status === 'A') {
      // Added file: original is empty, get from current commit
      modifiedContent = await showOrEmpty(`${hash}:${filePath}`);
      originalContent = '';
    } else if (status === 'D') {
      // Deleted file: modified is empty, get from parent commit
      originalContent = await showOrEmpty(`${hash}^:${filePath}`);
      modifiedContent = '';
    } else {
      // Modified or other: get from both parent and current commit
      const parentHash = `${hash}^`;
      originalContent = await showOrEmpty(`${parentHash}:${filePath}`);
      modifiedContent = await showOrEmpty(`${hash}:${filePath}`);
    }

    return {
      path: filePath,
      original: originalContent,
      modified: modifiedContent,
    };
  }

  async getDiffStats(): Promise<{ insertions: number; deletions: number }> {
    try {
      // Get stats for both staged and unstaged changes. Empty means no
      // changes, a real answer (F3: routed through the runner after a recovery).
      const { stdout: output } = await readGit({
        what: 'diff',
        workdir: this.workdir,
        args: ['diff', '--shortstat', 'HEAD'],
        lostWhen: 'never',
      });
      // Output format: " 3 files changed, 10 insertions(+), 5 deletions(-)"
      // or empty if no changes
      if (!output.trim()) {
        return { insertions: 0, deletions: 0 };
      }
      const insertionsMatch = output.match(/(\d+)\s+insertion/);
      const deletionsMatch = output.match(/(\d+)\s+deletion/);
      return {
        insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0,
        deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0,
      };
    } catch {
      // Repository might not have HEAD (empty repo) or other issues
      return { insertions: 0, deletions: 0 };
    }
  }

  // GitHub CLI methods
  async getGhCliStatus(): Promise<GhCliStatus> {
    try {
      // Check if gh is installed
      await execAsync('gh --version', {
        cwd: this.workdir,
        env: this.getGitEnv(),
      });
    } catch {
      return { installed: false, authenticated: false, error: 'gh CLI not installed' };
    }

    try {
      // Check if gh is authenticated
      await execAsync('gh auth status', {
        cwd: this.workdir,
        env: this.getGitEnv(),
      });
      return { installed: true, authenticated: true };
    } catch {
      return { installed: true, authenticated: false, error: 'gh CLI not authenticated' };
    }
  }

  async listPullRequests(): Promise<PullRequest[]> {
    try {
      const { stdout } = await execAsync(
        'gh pr list --state open --json number,title,headRefName,state,author,updatedAt,isDraft --limit 50',
        {
          cwd: this.workdir,
          env: this.getGitEnv(),
        }
      );

      const prs = JSON.parse(stdout) as Array<{
        number: number;
        title: string;
        headRefName: string;
        state: string;
        author: { login: string };
        updatedAt: string;
        isDraft: boolean;
      }>;

      return prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        headRefName: pr.headRefName,
        state: pr.state as 'OPEN' | 'CLOSED' | 'MERGED',
        author: pr.author.login,
        updatedAt: pr.updatedAt,
        isDraft: pr.isDraft,
      }));
    } catch (error) {
      throw new Error(
        `Failed to list PRs: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async fetchPullRequest(prNumber: number, localBranch: string): Promise<void> {
    try {
      // Fetch PR head to local branch without checking out
      // This creates the branch locally pointing to the PR's head commit
      await this.git.fetch(['origin', `pull/${prNumber}/head:${localBranch}`]);
    } catch (error) {
      throw new Error(
        `Failed to fetch PR #${prNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Submodule methods

  /**
   * List all submodules in the repository
   */
  async listSubmodules(): Promise<GitSubmodule[]> {
    const submodules: GitSubmodule[] = [];

    try {
      // Get submodule status using git submodule status
      const statusOutput = await this.git.raw(['submodule', 'status', '--recursive']);

      if (!statusOutput.trim()) {
        return [];
      }

      // Parse status output
      // Format: [+-U ]<sha1> <path> (<describe>)
      // - = not initialized, + = different commit, U = merge conflict, space = clean
      const lines = statusOutput.trim().split('\n');

      for (const line of lines) {
        const match = line.match(/^([-+U ])?([a-f0-9]+)\s+(\S+)(?:\s+\((.+)\))?$/);
        if (!match) continue;

        const [, statusChar, head, subPath] = match;
        const initialized = statusChar !== '-';

        // Determine status
        let status: SubmoduleStatus;
        if (!initialized) {
          status = 'uninitialized';
        } else if (statusChar === '+') {
          status = 'outdated';
        } else if (statusChar === 'U') {
          status = 'modified';
        } else {
          status = 'clean';
        }

        // Get URL and branch from .gitmodules
        let url = '';
        let branch: string | undefined;

        try {
          url = await this.git.raw(['config', '-f', '.gitmodules', `submodule.${subPath}.url`]);
          url = url.trim();
        } catch {
          // URL not found in .gitmodules
        }

        try {
          branch = await this.git.raw([
            'config',
            '-f',
            '.gitmodules',
            `submodule.${subPath}.branch`,
          ]);
          branch = branch.trim() || undefined;
        } catch {
          // Branch not specified
        }

        submodules.push({
          name: subPath.split('/').pop() || subPath,
          path: subPath,
          url,
          branch,
          head,
          status,
          initialized,
          // Defaults, filled in below
          tracking: undefined,
          ahead: 0,
          behind: 0,
          hasChanges: false,
          stagedCount: 0,
          unstagedCount: 0,
        });
      }

      // Fetch detailed status for initialized submodules
      for (const submodule of submodules) {
        if (submodule.initialized) {
          try {
            const submoduleWorkdir = path.join(this.workdir, submodule.path);
            const subGit = createSimpleGit(submoduleWorkdir);
            const subStatus = await subGit.status();
            submodule.branch = subStatus.current || undefined;
            submodule.tracking = subStatus.tracking || undefined;
            submodule.ahead = subStatus.ahead;
            submodule.behind = subStatus.behind;
            submodule.hasChanges = !subStatus.isClean();
            submodule.stagedCount = subStatus.staged.length;
            submodule.unstagedCount =
              subStatus.modified.length + subStatus.deleted.length + subStatus.not_added.length;
          } catch (error) {
            console.debug(`Failed to get status for submodule ${submodule.path}:`, error);
            // Submodule status failed; keep the defaults
          }
        }
      }
    } catch (error) {
      // No submodules or error reading them
      console.debug('Failed to list submodules:', error);
    }

    return submodules;
  }

  /**
   * Initialize submodules
   */
  async initSubmodules(recursive = true): Promise<void> {
    await this.git.submoduleInit();
    if (recursive) {
      await this.git.submoduleUpdate(['--init', '--recursive']);
    }
  }

  /**
   * Update submodules to the commit recorded in the superproject
   */
  async updateSubmodules(recursive = true): Promise<void> {
    const args = recursive ? ['--recursive'] : [];
    await this.git.submoduleUpdate(args);
  }

  /**
   * Sync submodule URLs from .gitmodules to .git/config
   */
  async syncSubmodules(): Promise<void> {
    await this.git.raw(['submodule', 'sync', '--recursive']);
  }

  /**
   * The directory a read runs in: the repository itself, or a submodule's own
   * checkout (validated against path traversal).
   */
  private repoDir(submodulePath?: string): string {
    return submodulePath ? this.resolveSubmoduleDir(submodulePath) : this.workdir;
  }

  private resolveSubmoduleDir(submodulePath: string): string {
    // Validate path to prevent path traversal attacks
    const absolutePath = path.resolve(this.workdir, submodulePath);
    const relativePath = path.relative(this.workdir, absolutePath);

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('Invalid submodule path: path traversal detected');
    }

    return absolutePath;
  }

  /**
   * Get Git instance for a submodule
   */
  private getSubmoduleGit(submodulePath: string): SimpleGit {
    return createSimpleGit(this.resolveSubmoduleDir(submodulePath));
  }

  /**
   * Smart pull (shared logic)
   * 1. Try fast-forward only first
   * 2. Fall back to rebase
   * 3. On conflict, abort and throw
   */
  private async smartPull(git: SimpleGit): Promise<void> {
    try {
      await git.pull(['--ff-only']);
    } catch {
      try {
        await git.pull(['--rebase']);
      } catch (rebaseError) {
        try {
          await git.rebase(['--abort']);
        } catch {
          // ignore abort error
        }
        throw rebaseError;
      }
    }
  }

  /**
   * Smart push (shared logic)
   * On non-fast-forward, pull first and retry
   */
  private async smartPush(
    pushFn: () => Promise<unknown>,
    pullFn: () => Promise<void>
  ): Promise<void> {
    try {
      await pushFn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('non-fast-forward') || msg.includes('rejected')) {
        await pullFn();
        await pushFn();
      } else {
        throw error;
      }
    }
  }

  /**
   * Checkout a remote branch by extracting the local branch name and creating
   * a tracking branch if it does not exist locally.
   * @param git - SimpleGit instance (main repo or submodule)
   * @param branch - Remote branch name in format "remotes/origin/branch-name"
   */
  private async checkoutRemoteBranch(git: SimpleGit, branch: string): Promise<string> {
    // "remotes/origin/dev" → remoteBranch="origin/dev", localBranch="dev"
    const remoteBranch = branch.slice(8);
    const slashIdx = remoteBranch.indexOf('/');
    const localBranch = slashIdx >= 0 ? remoteBranch.slice(slashIdx + 1) : remoteBranch;

    try {
      // Prefer switching to existing local branch
      await git.checkout(localBranch);
    } catch (error) {
      // Check if error is due to branch not existing
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('did not match') ||
        msg.includes('pathspec') ||
        msg.includes('unknown revision')
      ) {
        // Local branch does not exist: create it and track the remote
        await git.checkout(['-b', localBranch, '--track', remoteBranch]);
      } else {
        // Re-throw other errors (e.g., uncommitted changes blocking checkout)
        throw error;
      }
    }
    return localBranch;
  }

  /**
   * Fetch a single submodule
   */
  async fetchSubmodule(submodulePath: string): Promise<void> {
    const subGit = this.getSubmoduleGit(submodulePath);
    await subGit.fetch();
  }

  /**
   * Pull a single submodule
   */
  async pullSubmodule(submodulePath: string): Promise<void> {
    const subGit = this.getSubmoduleGit(submodulePath);
    await this.smartPull(subGit);
  }

  /**
   * Push a single submodule
   */
  async pushSubmodule(submodulePath: string): Promise<void> {
    const subGit = this.getSubmoduleGit(submodulePath);
    await this.smartPush(
      () => subGit.push(),
      () => this.smartPull(subGit)
    );
  }

  /**
   * Commit changes in a submodule
   */
  async commitSubmodule(submodulePath: string, message: string): Promise<string> {
    const subGit = this.getSubmoduleGit(submodulePath);
    const result = await subGit.commit(message);
    return result.commit;
  }

  /**
   * Stage files in a submodule
   */
  async stageSubmodule(submodulePath: string, paths: string[]): Promise<void> {
    const subGit = this.getSubmoduleGit(submodulePath);
    await subGit.add(paths);
  }

  /**
   * Unstage files in a submodule
   */
  async unstageSubmodule(submodulePath: string, paths: string[]): Promise<void> {
    const subGit = this.getSubmoduleGit(submodulePath);
    await subGit.reset(['HEAD', '--', ...paths]);
  }

  /**
   * Discard file changes in a submodule
   */
  async discardSubmodule(submodulePath: string, paths: string[]): Promise<void> {
    const subGit = this.getSubmoduleGit(submodulePath);
    const submoduleDir = path.join(this.workdir, submodulePath);
    const status = await subGit.status();

    const trackedPaths: string[] = [];
    const untrackedPaths: string[] = [];

    for (const filePath of paths) {
      // Check for symlinks
      const initialPath = path.join(submoduleDir, filePath);
      const initialStats = await fs.lstat(initialPath).catch(() => null);
      if (initialStats?.isSymbolicLink()) {
        throw new Error(`Cannot discard symbolic links: ${filePath}`);
      }

      if (status.not_added.includes(filePath)) {
        untrackedPaths.push(initialPath);
      } else {
        trackedPaths.push(filePath);
      }
    }

    // Remove untracked files/directories
    for (const absolutePath of untrackedPaths) {
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (stat?.isDirectory()) {
        await fs.rm(absolutePath, { recursive: true });
      } else {
        await fs.unlink(absolutePath);
      }
    }

    // Restore tracked files
    if (trackedPaths.length > 0) {
      await subGit.checkout(['--', ...trackedPaths]);
    }
  }

  /**
   * Parse the file-change list from a git status result (shared logic)
   */
  private parseStatusToChanges(status: StatusResult): FileChange[] {
    const changes: FileChange[] = [];

    // Build a map of renamed files for quick lookup
    const renamedMap = new Map<string, string>();
    for (const rename of status.renamed) {
      renamedMap.set(rename.to, rename.from);
    }

    // Use status.files for precise file status detection
    for (const file of status.files) {
      const filePath = file.path;
      const indexStatus = file.index;
      const workingDirStatus = file.working_dir;

      // Check index status (staged changes)
      if (indexStatus && indexStatus !== ' ' && indexStatus !== '?') {
        let fileStatus: FileChangeStatus;
        if (indexStatus === 'A') fileStatus = 'A';
        else if (indexStatus === 'D') fileStatus = 'D';
        else if (indexStatus === 'R') fileStatus = 'R';
        else if (indexStatus === 'C') fileStatus = 'C';
        else if (indexStatus === 'U') fileStatus = 'X';
        else fileStatus = 'M';

        const change: FileChange = { path: filePath, status: fileStatus, staged: true };
        if (renamedMap.has(filePath)) {
          change.originalPath = renamedMap.get(filePath);
        }
        changes.push(change);
      }

      // Check working_dir status (unstaged changes)
      if (workingDirStatus && workingDirStatus !== ' ') {
        let fileStatus: FileChangeStatus;
        if (workingDirStatus === '?') fileStatus = 'U';
        else if (workingDirStatus === 'D') fileStatus = 'D';
        else if (workingDirStatus === 'U') fileStatus = 'X';
        else fileStatus = 'M';

        changes.push({ path: filePath, status: fileStatus, staged: false });
      }
    }

    return changes;
  }

  /**
   * Get file changes list for a submodule
   */
  async getSubmoduleChanges(submodulePath: string): Promise<FileChange[]> {
    const subGit = this.getSubmoduleGit(submodulePath);
    const status = await subGit.status();
    return this.parseStatusToChanges(status);
  }

  /**
   * Get file diff for a submodule
   */
  async getSubmoduleFileDiff(
    submodulePath: string,
    filePath: string,
    staged: boolean
  ): Promise<FileDiff> {
    // Validate submodule path
    const fullSubPath = path.resolve(this.workdir, submodulePath);
    const relativeSubPath = path.relative(this.workdir, fullSubPath);
    if (relativeSubPath.startsWith('..') || path.isAbsolute(relativeSubPath)) {
      throw new Error('Invalid submodule path: path traversal detected');
    }

    // Validate file path within submodule
    const fullFilePath = path.resolve(fullSubPath, filePath);
    const relativeFilePath = path.relative(fullSubPath, fullFilePath);
    if (relativeFilePath.startsWith('..') || path.isAbsolute(relativeFilePath)) {
      throw new Error('Invalid file path: path traversal detected');
    }

    // Detect binary files
    if (await detectBinaryFile(fullFilePath, fullSubPath, `:${filePath}`)) {
      return { path: filePath, original: '', modified: '', isBinary: true };
    }

    let original = '';
    let modified = '';

    try {
      // HEAD version
      original = await gitShow(fullSubPath, `HEAD:${filePath}`);
    } catch {
      // New file: no HEAD version
    }

    try {
      if (staged) {
        // Index (staged) version
        modified = await gitShow(fullSubPath, `:${filePath}`);
      } else {
        // Working-tree version
        modified = await readWorkingTreeFile(fullFilePath).then((buffer) => decodeBuffer(buffer));
      }
    } catch {
      // Deleted file
    }

    return { path: filePath, original, modified };
  }

  /**
   * Get branch list for a submodule
   */
  async getSubmoduleBranches(submodulePath: string): Promise<GitBranch[]> {
    const subGit = this.getSubmoduleGit(submodulePath);
    const result = await subGit.branch(['-a', '-v']);
    return Object.entries(result.branches).map(([name, info]) => ({
      name,
      current: info.current,
      commit: info.commit,
      label: info.label,
    }));
  }

  /**
   * Checkout a branch in a submodule.
   * Handles remote tracking refs (remotes/origin/dev) by extracting the local
   * branch name and creating a tracking branch when it does not exist locally.
   */
  async checkoutSubmoduleBranch(submodulePath: string, branch: string): Promise<void> {
    const subGit = this.getSubmoduleGit(submodulePath);
    if (branch.startsWith('remotes/')) {
      await this.checkoutRemoteBranch(subGit, branch);
    } else {
      await subGit.checkout(branch);
    }
  }

  // Static methods for clone operations

  /**
   * Validate if a URL is a valid Git URL (HTTPS or SSH)
   * Supports:
   * - HTTPS with optional port, username, and multi-level paths
   * - SSH with optional port and multi-level paths
   */
  static isValidGitUrl(url: string): boolean {
    // HTTPS: supports port, username, multi-level paths
    // e.g., https://github.com/user/repo.git
    //       https://git.example.com:8443/user/repo
    //       https://user@github.com/user/repo.git
    //       https://gitlab.com/group/subgroup/repo
    const httpsPattern = /^https?:\/\/(?:[\w-]+@)?[\w.-]+(?::\d+)?(?:\/[\w.-]+)+(?:\.git)?$/;
    // SSH: supports port, multi-level paths
    // e.g., git@github.com:user/repo.git
    //       ssh://git@github.com:22/user/repo.git
    //       git@gitlab.com:group/subgroup/repo.git
    const sshPattern =
      /^(?:ssh:\/\/)?(?:[\w-]+@)?[\w.-]+(?::\d+)?[:/](?:[\w.-]+\/)+[\w.-]+(?:\.git)?$/;

    return httpsPattern.test(url) || sshPattern.test(url);
  }

  /**
   * Extract repository name from Git URL
   */
  static extractRepoName(url: string): string {
    // Remove .git suffix and extract last path segment
    const cleaned = url.replace(/\.git$/, '');
    // Handle both SSH (git@...:user/repo) and HTTPS (https://.../user/repo)
    const parts = cleaned.split(/[/:]/).filter(Boolean);
    return parts[parts.length - 1] || 'repository';
  }

  /**
   * Clone a remote repository to local path
   */
  static async clone(
    remoteUrl: string,
    targetPath: string,
    onProgress?: (progress: CloneProgress) => void
  ): Promise<void> {
    // Validate URL format
    if (!GitService.isValidGitUrl(remoteUrl)) {
      throw new Error('Invalid Git URL format');
    }

    // Check if target directory already exists
    if (existsSync(targetPath)) {
      throw new Error('Target directory already exists');
    }

    const cloneBaseDir = path.dirname(targetPath);
    const cloneTarget = toGitPath(cloneBaseDir, targetPath);

    // Ensure parent directory exists
    if (!existsSync(cloneBaseDir)) {
      await fs.mkdir(cloneBaseDir, { recursive: true });
    }

    // Create simple-git instance with progress callback
    const git = createSimpleGit(cloneBaseDir, {
      timeout: { block: 300_000 }, // 5 minutes timeout for clone operations
      progress: ({ method, stage, progress }) => {
        if (method === 'clone' && onProgress) {
          onProgress({ stage, progress });
        }
      },
    });

    // Execute clone with progress flag
    await git.clone(remoteUrl, cloneTarget, ['--progress']);
  }

  /**
   * Find the submodule containing a file path.
   * Returns the submodule path if found, null otherwise.
   */
  private async findSubmoduleForFile(filePath: string): Promise<string | null> {
    try {
      const submodules = await this.listSubmodules();
      // Normalize path separators for comparison
      const normalizedFilePath = filePath.replace(/\\/g, '/');

      // Sort submodules by path length (descending) to match the longest path first
      // This handles nested submodules correctly
      const sortedSubmodules = [...submodules].sort((a, b) => b.path.length - a.path.length);

      for (const submodule of sortedSubmodules) {
        const subPath = submodule.path.replace(/\\/g, '/');
        // Check if the file is within this submodule
        if (normalizedFilePath.startsWith(`${subPath}/`) || normalizedFilePath === subPath) {
          return subPath;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get blame info for all lines of a file using `git blame --porcelain`.
   *
   * Security note: Path traversal is not a concern here because:
   * - Uses `--` separator to prevent command injection
   * - filePath comes from internal app logic, not user input
   * - spawnGit uses array arguments (not shell string), preventing injection
   */
  async blame(filePath: string): Promise<GitBlameLineInfo[]> {
    const BLAME_TIMEOUT_MS = 30000; // 30 second timeout for git blame

    // Check if the file is in a submodule
    const submodulePath = await this.findSubmoduleForFile(filePath);
    let workdir = this.workdir;
    let relativePath = filePath;

    if (submodulePath) {
      // File is in a submodule, use submodule's git directory
      workdir = path.join(this.workdir, submodulePath);
      // Calculate the relative path within the submodule
      const normalizedSubPath = submodulePath.replace(/\\/g, '/');
      const normalizedFilePath = filePath.replace(/\\/g, '/');
      relativePath = normalizedFilePath.slice(normalizedSubPath.length + 1);
    }

    try {
      // An empty file blames to nothing, so an empty answer cannot show a loss;
      // after a recovery this goes through the runner anyway (F3).
      const { stdout } = await readGit({
        what: 'blame',
        workdir,
        args: ['blame', '--porcelain', '--', relativePath],
        lostWhen: 'never',
        timeoutMs: BLAME_TIMEOUT_MS,
      });
      return this.parsePorcelainBlame(stdout);
    } catch (err) {
      if (err instanceof GitCommandError && err.exitCode !== null) {
        throw new Error(`git blame failed: ${err.stderr.trim()}`);
      }
      throw err;
    }
  }

  /**
   * Parse `git blame --porcelain` output into structured data.
   *
   * Porcelain format groups:
   *   <hash> <orig-line> <final-line> [<num-lines>]
   *   author <name>
   *   author-time <timestamp>
   *   summary <message>
   *   ...
   *   \t<content-line>
   */
  private parsePorcelainBlame(output: string): GitBlameLineInfo[] {
    const lines = output.split('\n');
    const results: GitBlameLineInfo[] = [];

    // Cache commit metadata keyed by hash
    const commitCache = new Map<string, { author: string; date: string; message: string }>();

    let i = 0;
    while (i < lines.length) {
      const headerMatch = lines[i].match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/);
      if (!headerMatch) {
        i++;
        continue;
      }

      const hash = headerMatch[1];
      const lineNumber = parseInt(headerMatch[3], 10);

      i++;

      // Parse header fields until we hit the content line (starts with \t)
      let author = '';
      let authorTime = 0;
      let summary = '';

      while (i < lines.length && !lines[i].startsWith('\t')) {
        const line = lines[i];
        if (line.startsWith('author ')) {
          author = line.slice(7);
        } else if (line.startsWith('author-time ')) {
          authorTime = parseInt(line.slice(12), 10);
        } else if (line.startsWith('summary ')) {
          summary = line.slice(8);
        }
        i++;
      }

      // Skip content line
      if (i < lines.length && lines[i].startsWith('\t')) {
        i++;
      }

      // Use cached metadata if available, otherwise store it
      if (!commitCache.has(hash)) {
        commitCache.set(hash, {
          author,
          date: authorTime ? new Date(authorTime * 1000).toISOString() : '',
          message: summary,
        });
      }

      const cached = commitCache.get(hash)!;
      results.push({
        hash,
        author: cached.author,
        date: cached.date,
        message: cached.message,
        lineNumber,
      });
    }

    return results;
  }

  /**
   * Revert a commit by creating a new commit that undoes the changes
   * @param commitHash - The commit hash to revert
   */
  async revert(commitHash: string): Promise<void> {
    await this.git.revert(commitHash, ['--no-edit']);
  }

  /**
   * Reset the current HEAD to the specified state
   * @param commitHash - The target commit hash
   * @param mode - Reset mode: 'soft', 'mixed', or 'hard'
   */
  async reset(commitHash: string, mode: 'soft' | 'mixed' | 'hard' = 'mixed'): Promise<void> {
    await this.git.reset([`--${mode}`, commitHash]);
  }
}
