// New in dsh-rebase decision 191 (claude-sdk-engine README ruling 27, S-6 feedback 11c).

/**
 * The shell commands every gear but `bypass` stops to confirm, however well
 * their operands resolve: any delete (decision 191 §6, user 2026-10-17: "任何删除
 * 都是危险动作"; it was recursive deletes only), force pushes and the git commands
 * that throw away work, and disk formatting.
 *
 * Read off the command segments the shell analyses already produce
 * (`BashAnalysis.commands`: one entry per command, wrappers peeled, aliases
 * folded to their cmdlet for `pwsh`; an unreadable `pwsh` segment is its raw
 * text). Words are split on whitespace, so an argument with spaces in it reads
 * as several words: a false match costs one card, a missed one runs the
 * command, so every rule leans towards matching.
 *
 * Out of reach by design: a command whose name is itself a variable
 * (`$RM -rf build`) or a program the analysis cannot see into (`python x.py`).
 */

/** Words that run the rest of the line as a command; peeled before the verb is judged. */
const PREFIX_VERBS = new Set([
  'sudo',
  'doas',
  'env',
  'xargs',
  'command',
  'builtin',
  'exec',
  'eval',
  'nohup',
  'time',
  'nice',
  'timeout',
  'stdbuf',
  'setsid',
  'ionice',
  'chrt',
]);
/**
 * Prefix switches that may take the next word as their value (`sudo -u root`,
 * `xargs -n 1`, `nice -n 5`). Some of them take none in another prefix
 * (`sudo -n`), so the next word is skipped only when it is not a verb judged here.
 */
const PREFIX_VALUE_SWITCHES = new Set(['-u', '-g', '-n', '-I', '-L', '-P', '-d']);
/** How each shell or launcher is told to run its command-string argument. */
const STRING_SHELL_SWITCH: Readonly<Record<string, (word: string) => boolean>> = {
  bash: (word) => /^-[a-z]*c[a-z]*$/.test(word),
  sh: (word) => /^-[a-z]*c[a-z]*$/.test(word),
  zsh: (word) => /^-[a-z]*c[a-z]*$/.test(word),
  dash: (word) => /^-[a-z]*c[a-z]*$/.test(word),
  cmd: (word) => /^\/[ck]$/i.test(word),
  pwsh: (word) => word.length >= 2 && '-command'.startsWith(word.toLowerCase()),
  powershell: (word) => word.length >= 2 && '-command'.startsWith(word.toLowerCase()),
};

const SEPARATORS = new Set([';', '&&', '||', '|', '&']);

/** `Remove-Item` and the names `rm`, `del`, `rd` take in either shell, and `unlink`, `shred`. */
const REMOVE_VERBS = new Set([
  'rm',
  'del',
  'erase',
  'rd',
  'rmdir',
  'ri',
  'remove-item',
  'unlink',
  'shred',
]);
const FORMAT_VERBS = new Set([
  'format',
  'mkfs',
  'wipefs',
  'diskpart',
  'format-volume',
  'clear-disk',
]);

function unquote(word: string): string {
  return word.replace(/^["']+|["']+$/g, '');
}

/** The program's name as it is compared: no directory, no `.exe`, lower case. */
function verbOf(word: string): string {
  const name = word.split(/[\\/]/).pop() ?? word;
  return name.toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/, '');
}

/** A git option before the subcommand that takes the next word as its value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
/** A pathspec that covers the whole tree. */
const WHOLE_TREE = new Set(['.', './', ':/', '*', ':/*', ':(top)']);

function dangerousGit(args: readonly string[]): boolean {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    index += GIT_VALUE_OPTIONS.has(args[index]) ? 2 : 1;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  const flags = rest.filter((word) => word.startsWith('-'));
  const operands = rest.filter((word) => !word.startsWith('-'));
  const shortCluster = (letter: string) =>
    flags.some((flag) => /^-[a-zA-Z]+$/.test(flag) && flag.includes(letter));
  switch (subcommand) {
    case 'push':
      return (
        shortCluster('f') ||
        shortCluster('d') ||
        flags.some((flag) =>
          /^--(?:force|force-with-lease|force-if-includes|mirror|delete)(?:=|$)/.test(flag)
        ) ||
        operands.some((operand) => operand.startsWith('+') || operand.startsWith(':'))
      );
    case 'reset':
      return flags.includes('--hard');
    case 'clean':
      return shortCluster('f') || flags.includes('--force');
    case 'checkout':
      return (
        flags.includes('-f') ||
        flags.includes('--force') ||
        operands.some((operand) => WHOLE_TREE.has(operand))
      );
    case 'restore': {
      const stagedOnly =
        flags.some((flag) => flag === '--staged' || flag === '-S') &&
        !flags.some((flag) => flag === '--worktree' || flag === '-W');
      return !stagedOnly && operands.some((operand) => WHOLE_TREE.has(operand));
    }
    case 'branch':
      return (
        shortCluster('D') ||
        ((flags.includes('--delete') || shortCluster('d')) &&
          (flags.includes('--force') || shortCluster('f')))
      );
    case 'stash':
      return operands[0] === 'drop' || operands[0] === 'clear';
    case 'rm':
      // Deletes the files from the work tree, unless it only untracks them.
      return !flags.includes('--cached');
    default:
      return false;
  }
}

/** `find -delete`, and whatever `find -exec` runs. */
function dangerousFind(args: readonly string[], depth: number): boolean {
  if (args.some((word) => word === '-delete')) return true;
  for (let index = 0; index < args.length; index++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[index])) continue;
    const end = args.findIndex(
      (word, at) => at > index && (word === ';' || word === '\\;' || word === '+')
    );
    if (dangerousWords(args.slice(index + 1, end < 0 ? undefined : end), depth + 1)) return true;
  }
  return false;
}

function judgedVerb(word: string | undefined): boolean {
  if (word === undefined) return false;
  const verb = verbOf(word);
  return (
    REMOVE_VERBS.has(verb) ||
    FORMAT_VERBS.has(verb) ||
    verb === 'git' ||
    verb === 'find' ||
    verb.startsWith('mkfs.')
  );
}

function dangerousWords(input: readonly string[], depth: number): boolean {
  if (depth > 4) return false;
  let words = [...input];
  // Peel the words that only run what follows them.
  for (let rounds = 0; rounds < 8 && words.length > 0; rounds++) {
    const verb = verbOf(words[0]);
    const runsString = STRING_SHELL_SWITCH[verb];
    if (runsString) {
      // `bash -c '…'`, `cmd /c …`, `pwsh -Command …`: the rest is a command line.
      const switchAt = words.findIndex((word, at) => at > 0 && runsString(word));
      if (switchAt < 0) return false;
      return dangerousLine(words.slice(switchAt + 1).join(' '), depth + 1);
    }
    if (!PREFIX_VERBS.has(verb)) break;
    let index = 1;
    while (index < words.length) {
      const word = words[index];
      if (PREFIX_VALUE_SWITCHES.has(word) && !judgedVerb(words[index + 1])) index += 2;
      else if (word.startsWith('-') || /^[A-Za-z_]\w*=/.test(word) || /^\d+[smhd]?$/.test(word))
        index++;
      else break;
    }
    words = words.slice(index);
  }
  const [head, ...args] = words;
  if (!head) return false;
  const verb = verbOf(head);
  // Decision 191 §6: any delete, a single file as much as a tree.
  if (REMOVE_VERBS.has(verb)) return true;
  if (verb === 'git') return dangerousGit(args);
  if (verb === 'find') return dangerousFind(args, depth);
  return FORMAT_VERBS.has(verb) || verb.startsWith('mkfs.');
}

function dangerousLine(line: string, depth: number): boolean {
  // Separators glued to a word (`a; rm -rf b`) are split off first.
  const words = line
    .replace(/(&&|\|\||[;|&])/g, ' $1 ')
    .split(/\s+/)
    .map(unquote)
    .filter(Boolean);
  let current: string[] = [];
  for (const word of [...words, ';']) {
    if (SEPARATORS.has(word)) {
      if (dangerousWords(current, depth)) return true;
      current = [];
      continue;
    }
    current.push(word);
  }
  return false;
}

/** Whether full auto stops to confirm this command segment. */
export function isDangerousShellCommand(segment: string): boolean {
  return dangerousLine(segment, 0);
}
