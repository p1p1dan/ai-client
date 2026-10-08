import { readGit } from './gitReadFallback';
import { normalizeGitRelativePath } from './runtime';

/**
 * The subset of `paths` (relative to `workdir`) that git ignores, for the file
 * tree's ignored marks.
 *
 * `git check-ignore` exits 1 when none of the paths is ignored, a real answer.
 * Exit 0 means at least one is and always prints it, so an empty answer there
 * was lost (F3: the encrypted Windows host loses the stdout of a git Main
 * spawns, and simple-git turned that into "nothing is ignored").
 *
 * `core.quotePath=false`: without `-z` (which needs `--stdin`, and the runner
 * gives git no stdin) git C-quotes non-ASCII paths, which then never matched
 * the plain path they were asked about.
 *
 * Rejects when git failed or the output was lost on both paths.
 */
export async function readIgnoredPaths(workdir: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const { stdout, exitCode } = await readGit({
    what: 'check-ignore',
    workdir,
    args: ['-c', 'core.quotePath=false', 'check-ignore', '--', ...paths],
    okExitCodes: [1],
    lostWhen: 'empty',
  });
  if (exitCode !== 0) return new Set();
  return new Set(
    stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.length > 0)
      .map((line) => normalizeGitRelativePath(line))
  );
}
