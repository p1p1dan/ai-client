// New in dsh-rebase P1-6d: PowerShell command names, for the pwsh analysis and its grants.

/**
 * The name tables `pwshAnalysis` reads a command by, and `grants` keys a pwsh
 * grant by: aliases folded onto their cmdlet, case folded, and the commands
 * no session grant may cover.
 *
 * Its own module, importing nothing, because `grants.ts` needs it and
 * `grants.ts` is reached by libraries that must stay free of Node's OS
 * modules and the bundled policy table (the pi session migration,
 * `legacyPiSession`); the analysis itself needs both.
 */

/** The DSH tool name this analysis serves. */
export const PWSH_TOOL = 'pwsh';

/**
 * Built-in aliases, by the cmdlet (or function) they name.
 *
 * Only aliases that mean the same thing in Windows PowerShell 5.1 and in
 * PowerShell 7 on Windows — DSH mounts `pwsh` on Windows only, and runs 7 when
 * it is installed, 5.1 otherwise. Three well-known spellings are left out on
 * purpose, because they name a different program depending on the version:
 * `sc` (`Set-Content` in 5.1, `sc.exe` — the service controller — where the
 * alias is gone), `curl` and `wget` (`Invoke-WebRequest` in 5.1, the native
 * programs in 7). They keep their own prefix, so a grant for one never covers
 * the other.
 */
const ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Get-ChildItem', ['ls', 'dir', 'gci']],
  ['Get-Content', ['cat', 'gc', 'type']],
  ['Set-Location', ['cd', 'chdir', 'sl']],
  ['Get-Location', ['pwd', 'gl']],
  ['Push-Location', ['pushd']],
  ['Pop-Location', ['popd']],
  ['Remove-Item', ['rm', 'del', 'erase', 'rd', 'rmdir', 'ri']],
  ['Copy-Item', ['cp', 'copy', 'cpi']],
  ['Move-Item', ['mv', 'move', 'mi']],
  ['Rename-Item', ['ren', 'rni']],
  ['New-Item', ['ni']],
  ['Get-Item', ['gi']],
  ['Add-Content', ['ac']],
  ['Clear-Content', ['clc']],
  ['Clear-Item', ['cli']],
  ['Select-String', ['sls']],
  ['Select-Object', ['select']],
  ['Sort-Object', ['sort']],
  ['Where-Object', ['where', '?']],
  ['ForEach-Object', ['foreach', '%']],
  ['Measure-Object', ['measure']],
  ['Write-Output', ['echo', 'write']],
  ['Tee-Object', ['tee']],
  ['Get-Command', ['gcm']],
  ['Resolve-Path', ['rvpa']],
  ['Get-ItemProperty', ['gp']],
  ['Set-ItemProperty', ['sp']],
  ['Get-Process', ['ps', 'gps']],
  ['Stop-Process', ['kill', 'spps']],
  ['Start-Process', ['start', 'saps']],
  ['Invoke-Expression', ['iex']],
  ['Invoke-Command', ['icm']],
  ['Invoke-Item', ['ii']],
  ['Invoke-History', ['r', 'ihy']],
  ['Invoke-WebRequest', ['iwr']],
  ['Invoke-RestMethod', ['irm']],
  ['Start-Job', ['sajb']],
  ['Import-Module', ['ipmo']],
  ['Set-Alias', ['sal']],
  ['New-Alias', ['nal']],
  ['Set-Variable', ['set', 'sv']],
  ['Start-Sleep', ['sleep']],
  ['Compare-Object', ['compare', 'diff']],
  ['Format-Table', ['ft']],
  ['Format-List', ['fl']],
  ['Get-Member', ['gm']],
  ['Clear-Host', ['cls', 'clear']],
  // `md` is an alias of the `mkdir` function, which wraps New-Item.
  ['mkdir', ['md']],
];

/** Cmdlets with no alias above, listed only so a prefix reads in the usual casing. */
const MORE_CMDLETS = [
  'Test-Path',
  'Join-Path',
  'Split-Path',
  'Out-File',
  'Set-Content',
  'Out-Null',
  'Out-String',
  'Write-Host',
  'Write-Error',
  'Get-Date',
  'Get-FileHash',
  'Expand-Archive',
  'Compress-Archive',
  'ConvertTo-Json',
  'ConvertFrom-Json',
  'New-ItemProperty',
  'Remove-ItemProperty',
  'Start-ThreadJob',
  'Add-Type',
  'Get-Help',
];

/** lower-case spelling -> canonical name, for aliases and cmdlets alike. Never a plain object: `constructor` is a word. */
const CANONICAL = new Map<string, string>();
for (const [name, aliases] of ALIASES) {
  CANONICAL.set(name.toLowerCase(), name);
  for (const alias of aliases) CANONICAL.set(alias, name);
}
for (const name of MORE_CMDLETS) CANONICAL.set(name.toLowerCase(), name);

/**
 * The name a command segment is remembered and matched by: an alias as its
 * cmdlet (`gci` -> `Get-ChildItem`), a known cmdlet in its usual casing, and
 * anything else lower-cased — PowerShell resolves command names without regard
 * to case, and so does Windows for programs. A program's extension is kept
 * (`sc.exe` is not `sc`), and so is its path.
 */
export function normalizePwshCommandName(word: string): string {
  const lower = word.toLowerCase();
  return CANONICAL.get(lower) ?? lower;
}

/** A word that can stand at command position as a name (not an expression, not an operator). */
const COMMAND_NAME = /^[\p{L}\p{N}_.~\\/:+%?-]+$/u;
/** A number literal: at command position PowerShell evaluates it as an expression. */
const NUMBER_LITERAL =
  /^[+-]?(?:0x[\da-f]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?|\d+\.\.\d+)(?:[dlu]|ul|kb|mb|gb|tb|pb)?$/i;
/** Language keywords: at command position they start a statement this lexer does not read. */
const KEYWORDS = new Set(
  (
    'begin break catch class clean continue data define do dynamicparam else elseif end enum ' +
    'exit filter finally for foreach from function hidden if in inlinescript parallel param ' +
    'process return sequence static switch throw trap try until using var while workflow configuration'
  ).split(' ')
);

export function isPwshCommandName(word: string): boolean {
  return (
    COMMAND_NAME.test(word) &&
    !word.startsWith('-') &&
    !/^\.+$/.test(word) &&
    !NUMBER_LITERAL.test(word) &&
    !KEYWORDS.has(word.toLowerCase())
  );
}

/** `C:\Tools\Git.EXE` -> `git`: what a program is called, for the lists below. */
export function pwshProgramStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

/**
 * Commands that run a string, a script block or another shell. Their segment
 * is unresolved AND can never be covered by a session grant: approving
 * `Invoke-Expression` once must not approve every string after it.
 */
const RUNS_CODE_CMDLETS = new Set([
  'Invoke-Expression',
  'Invoke-Command',
  'Invoke-History',
  'Start-Process',
  'Start-Job',
  'Start-ThreadJob',
  'Add-Type',
  'Set-Alias',
  'New-Alias',
  // `% Delete` calls a method on every object in the pipe, no script block needed.
  'ForEach-Object',
]);
const RUNS_CODE_PROGRAMS = new Set([
  'pwsh',
  'powershell',
  'powershell_ise',
  'cmd',
  'bash',
  'sh',
  'zsh',
  'wsl',
  'sudo',
  'runas',
  'wscript',
  'cscript',
  'mshta',
  'rundll32',
  'regsvr32',
]);
/** Whether a (normalized) command may never be remembered for the session. */
export function isUngrantablePwshCommand(name: string): boolean {
  return RUNS_CODE_CMDLETS.has(name) || RUNS_CODE_PROGRAMS.has(pwshProgramStem(name));
}

/** Whether a (normalized) name is a cmdlet, alias or function this table knows. */
export function isKnownPwshCommand(name: string): boolean {
  return CANONICAL.has(name.toLowerCase());
}
