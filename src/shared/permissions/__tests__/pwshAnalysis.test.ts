import { describe, expect, it } from 'vitest';
import { PermissionError } from '../errors.ts';
import { pwshCommandPrefix } from '../grants.ts';
import {
  analyzePwsh,
  isPwshCommandName,
  normalizePwshCommandName,
  pwshProgramStem,
} from '../pwshAnalysis.ts';

/**
 * dsh-rebase P1-6d — the conservative pwsh reading (decision 046, design shard
 * 03 §11), table-driven: aliases, operands, redirections, every construct read
 * as unresolved, exploration, and the grant prefix each segment yields.
 *
 * Read as Windows (`platform: 'win32'`), the only place DSH mounts `pwsh`,
 * whatever box runs the suite; a few rows at the end pin the POSIX spelling.
 */

const WS = 'C:\\repo';
const HOME = 'C:\\Users\\me';
const ENV = {
  USERPROFILE: HOME,
  TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp',
  NODE_ENV: 'test',
  Empty: '',
};
const read = (command: string, cwd = WS) =>
  analyzePwsh(command, cwd, ENV, { platform: 'win32', home: HOME });
const at = (...segments: string[]) => [WS, ...segments].join('\\');

interface Expected {
  commands?: string[];
  paths?: string[];
  /** Operands that must be registered, among others. */
  has?: string[];
  /** Operands that must not be registered. */
  lacks?: string[];
  unresolved?: boolean;
  exploration?: boolean;
  ungrantable?: boolean;
}

function check(command: string, expected: Expected) {
  const analysis = read(command);
  if (expected.commands) expect(analysis.commands, 'commands').toEqual(expected.commands);
  if (expected.paths)
    expect([...analysis.paths].sort(), 'paths').toEqual([...expected.paths].sort());
  for (const path of expected.has ?? []) expect(analysis.paths, `has ${path}`).toContain(path);
  for (const path of expected.lacks ?? [])
    expect(analysis.paths, `lacks ${path}`).not.toContain(path);
  if (expected.unresolved !== undefined)
    expect(analysis.unresolvedPaths, 'unresolvedPaths').toBe(expected.unresolved);
  if (expected.exploration !== undefined)
    expect(analysis.exploration, 'exploration').toBe(expected.exploration);
  if (expected.ungrantable !== undefined)
    expect(analysis.ungrantable === true, 'ungrantable').toBe(expected.ungrantable);
}

describe('pwsh aliases fold onto their cmdlet (one name, one grant)', () => {
  it.each([
    ['ls', 'Get-ChildItem'],
    ['dir', 'Get-ChildItem'],
    ['gci', 'Get-ChildItem'],
    ['LS', 'Get-ChildItem'],
    ['get-childitem', 'Get-ChildItem'],
    ['cat', 'Get-Content'],
    ['gc', 'Get-Content'],
    ['type', 'Get-Content'],
    ['rm', 'Remove-Item'],
    ['del', 'Remove-Item'],
    ['erase', 'Remove-Item'],
    ['rd', 'Remove-Item'],
    ['rmdir', 'Remove-Item'],
    ['ri', 'Remove-Item'],
    ['cp', 'Copy-Item'],
    ['copy', 'Copy-Item'],
    ['mv', 'Move-Item'],
    ['move', 'Move-Item'],
    ['ren', 'Rename-Item'],
    ['ni', 'New-Item'],
    ['gi', 'Get-Item'],
    ['ac', 'Add-Content'],
    ['sls', 'Select-String'],
    ['select', 'Select-Object'],
    ['sort', 'Sort-Object'],
    ['where', 'Where-Object'],
    ['?', 'Where-Object'],
    ['%', 'ForEach-Object'],
    ['echo', 'Write-Output'],
    ['write', 'Write-Output'],
    ['tee', 'Tee-Object'],
    ['gcm', 'Get-Command'],
    ['pwd', 'Get-Location'],
    ['cd', 'Set-Location'],
    ['pushd', 'Push-Location'],
    ['iex', 'Invoke-Expression'],
    ['saps', 'Start-Process'],
    ['iwr', 'Invoke-WebRequest'],
    ['md', 'mkdir'],
    ['set-content', 'Set-Content'],
    ['TEST-PATH', 'Test-Path'],
  ])('%s -> %s', (alias, cmdlet) => {
    expect(normalizePwshCommandName(alias)).toBe(cmdlet);
  });

  it.each([
    // Version-dependent: Set-Content / Invoke-WebRequest in 5.1, native programs in 7.
    ['sc', 'sc'],
    ['curl', 'curl'],
    ['wget', 'wget'],
    // A program keeps its extension: `sc.exe` is the service controller, `where.exe` is not Where-Object.
    ['sc.exe', 'sc.exe'],
    ['where.exe', 'where.exe'],
    ['GIT', 'git'],
    ['Npm.CMD', 'npm.cmd'],
    ['Get-FileHash', 'Get-FileHash'],
    ['Get-Unlisted', 'get-unlisted'],
    ['constructor', 'constructor'],
    ['C:\\Tools\\Git.exe', 'c:\\tools\\git.exe'],
  ])('%s stays %s', (word, name) => {
    expect(normalizePwshCommandName(word)).toBe(name);
  });

  it('names a program by its stem for the subcommand list', () => {
    expect(['C:\\Tools\\Git.EXE', 'npm.cmd', 'py', './x.bat'].map(pwshProgramStem)).toEqual([
      'git',
      'npm',
      'py',
      'x',
    ]);
  });

  it('refuses words that cannot name a command', () => {
    expect(
      ['$x', '&', '.', '..', '-x', '(a)', "'a'", '5', '0x1F', '1..3', 'if', 'Function'].map(
        isPwshCommandName
      )
    ).toEqual(new Array(12).fill(false));
    expect(
      ['ls', 'Get-ChildItem', '.\\build.ps1', 'C:\\x\\y.exe', '7z', '%', '?'].map(isPwshCommandName)
    ).toEqual(new Array(7).fill(true));
  });

  it.each([
    ['ls src', ['Get-ChildItem src']],
    ['dir -Recurse', ['Get-ChildItem -Recurse']],
    ['gci; cat a.txt', ['Get-ChildItem', 'Get-Content a.txt']],
    ['GIT Status', ['git Status']],
    ['echo hi | sort', ['Write-Output hi', 'Sort-Object']],
  ])('writes %s down as %j', (command, commands) => {
    check(command, { commands });
  });
});

describe('the grant prefix of a pwsh segment', () => {
  it.each([
    ['ls src', 'Get-ChildItem'],
    ['gci', 'Get-ChildItem'],
    ['GET-CHILDITEM -Recurse', 'Get-ChildItem'],
    ['Remove-Item -Recurse dist', 'Remove-Item'],
    ['git status -s', 'git status'],
    ['GIT status', 'git status'],
    ['git.exe status', 'git.exe status'],
    ['git -C x status', 'git'],
    ['npm test', 'npm test'],
    ['npm.cmd test', 'npm.cmd test'],
    ['winget install foo', 'winget install'],
    ['py -m pip', 'py'],
    ['python build.py', 'python build.py'],
    ['sc stop svc', 'sc'],
    ['sc.exe stop svc', 'sc.exe'],
    ['.\\build.ps1 -Release', '.\\build.ps1'],
  ])('%s -> %s', (segment, prefix) => {
    expect(pwshCommandPrefix(segment)).toBe(prefix);
  });

  it.each([
    'Invoke-Expression x',
    'iex x',
    'Start-Process notepad',
    'pwsh -Command x',
    'powershell.exe -c x',
    'cmd /c del x',
    'bash -c x',
    'ForEach-Object Delete',
    '& x',
    '$x = 1',
    '-Recurse',
    '',
  ])('%j has none', (segment) => {
    expect(pwshCommandPrefix(segment)).toBeUndefined();
  });
});

describe('pwsh operands', () => {
  it.each<[string, Expected]>([
    ['Get-Content notes.txt', { paths: [at('notes.txt')], unresolved: false }],
    ['Get-Content -Path src\\a.ts', { paths: [at('src\\a.ts')] }],
    ['Get-Content -LiteralPath \x27a b.txt\x27', { paths: [at('a b.txt')] }],
    ['Get-Content -Path:src\\x.txt', { paths: [at('src\\x.txt')] }],
    ['Get-Content "quoted name.txt"', { paths: [at('quoted name.txt')] }],
    ['Get-Content a.txt, b.txt', { paths: [at('a.txt'), at('b.txt')] }],
    ['Copy-Item a.txt -Destination C:\\out\\b.txt', { has: [at('a.txt'), 'C:\\out\\b.txt'] }],
    ['Out-File -FilePath log.txt -InputObject x', { has: [at('log.txt')] }],
    [
      'Invoke-WebRequest https://example.invalid/x.zip -OutFile dl.zip',
      { has: [at('dl.zip')], lacks: ['https://example.invalid/x.zip'] },
    ],
    [
      'New-Item -ItemType SymbolicLink -Path link -Target C:\\Windows',
      { has: [at('link'), 'C:\\Windows'] },
    ],
    ['Get-Content ~\\notes.txt', { paths: [`${HOME}\\notes.txt`] }],
    ['Get-Content ~', { paths: [HOME] }],
    ['Get-Content $HOME\\.ssh\\id_rsa', { paths: [`${HOME}\\.ssh\\id_rsa`], unresolved: false }],
    ['Get-Content $env:USERPROFILE\\x.txt', { paths: [`${HOME}\\x.txt`], unresolved: false }],
    ['Get-Content $Env:userprofile\\x.txt', { paths: [`${HOME}\\x.txt`] }],
    ['Get-Content "$env:TEMP\\x.log"', { paths: ['C:\\Users\\me\\AppData\\Local\\Temp\\x.log'] }],
    // PowerShell's braced variable, `${env:TEMP}`, spelled with `\x24` so it is not read as a template.
    [
      'Get-Content \x24{env:TEMP}\\y.log',
      { paths: ['C:\\Users\\me\\AppData\\Local\\Temp\\y.log'] },
    ],
    ['Get-Content $PWD\\z.txt', { paths: [at('z.txt')] }],
    ['Get-Content /x.txt', { paths: ['C:\\x.txt'] }],
    ['Get-Content ..\\up.txt', { paths: [at('..\\up.txt')] }],
    ['Get-Content C:/Windows/win.ini', { paths: ['C:\\Windows\\win.ini'] }],
    ['Get-Content c:\\lower.txt', { paths: ['C:\\lower.txt'] }],
    ['Remove-Item \\\\?\\C:\\x', { paths: ['C:\\x'] }],
    ['Get-ChildItem *.ts', { paths: [at('*.ts')] }],
    ['Get-ChildItem -Recurse -Filter *.key', { has: [at('*.key')] }],
    ['Get-ChildItem src\\file[0-9].txt', { paths: [at('src\\file[0-9].txt')] }],
    ['Write-Output a#b', { commands: ['Write-Output a#b'] }],
    ['Get-Content x.txt # read it', { paths: [at('x.txt')], commands: ['Get-Content x.txt'] }],
    ['Write-Output $true $null', { paths: [at('True')] }],
    ['.\\build.ps1 -Release', { has: [at('.\\build.ps1')], unresolved: false }],
    ['C:\\Tools\\tool.exe run', { has: ['C:\\Tools\\tool.exe', at('run')] }],
    ['git -C C:\\other status', { has: ['C:\\other'] }],
    ['robocopy src C:\\bak /MIR', { paths: [at('src'), 'C:\\bak'] }],
    ['ipconfig /all', { paths: [] }],
    ['gcc -oout.exe main.c', { has: [at('out.exe'), at('main.c')] }],
    ['npm test -- --coverage=cov', { has: [at('cov')] }],
    ['Select-String -Pattern .env -Path *.txt', { has: [at('*.txt')], lacks: [at('.env')] }],
    ['sls .env src\\*.ts', { paths: [at('src\\*.ts')] }],
    // `-Path` takes the next word; the positional after it is the pattern.
    ['Select-String -Path a.txt secret', { paths: [at('a.txt')] }],
    ['rg -e .env -f pats.txt src', { paths: [at('pats.txt'), at('src')] }],
    ['rg .env src', { paths: [at('src')] }],
    ['findstr /s /i needle *.txt', { paths: [at('*.txt')] }],
    ['cd src; Get-Content a.txt', { paths: [at('src'), at('src\\a.txt')] }],
    ['Set-Location -Path src; Get-Content b.txt', { has: [at('src\\b.txt')] }],
    ['Set-Location -LiteralPath:src; cat c.txt', { has: [at('src\\c.txt')] }],
    ['Push-Location sub; Remove-Item x', { has: [at('sub\\x')], unresolved: false }],
    ['cd C:\\other; ls', { paths: ['C:\\other'] }],
  ])('%s', (command, expected) => {
    check(command, expected);
  });
});

describe('pwsh redirections', () => {
  it.each<[string, Expected]>([
    [
      'Write-Output a > out.txt',
      { paths: [at('a'), at('out.txt')], exploration: false, unresolved: false },
    ],
    ['Write-Output a >> log.txt', { paths: [at('a'), at('log.txt')], exploration: false }],
    [
      'Write-Output a>glued.txt',
      { paths: [at('a'), at('glued.txt')], commands: ['Write-Output a'] },
    ],
    ['npm test 2> err.txt', { has: [at('err.txt')] }],
    ['npm test *> all.txt', { has: [at('all.txt')] }],
    ['npm test 3>> warn.txt', { has: [at('warn.txt')] }],
    ['Get-ChildItem 2>&1', { paths: [], exploration: true, unresolved: false }],
    ['Get-ChildItem 2>$null', { paths: [], exploration: true, unresolved: false }],
    ['Get-ChildItem *>&1 | Select-Object -First 3', { exploration: true }],
    ['Get-Content a.txt > C:\\out.txt', { has: ['C:\\out.txt'], exploration: false }],
    ['Write-Output a > $f', { unresolved: true, ungrantable: true }],
    ['Write-Output a >', { unresolved: true, ungrantable: true }],
    ['Get-Content < in.txt', { unresolved: true }],
  ])('%s', (command, expected) => {
    check(command, expected);
  });
});

describe('pwsh constructs read as unresolved and ungrantable', () => {
  it.each<[string, Expected?]>([
    ['$x = 1; Remove-Item y'],
    ['Get-Content $p'],
    ['Get-Content $env:MISSING'],
    ['Get-Content $env:Empty'],
    ['Get-Content $PSHOME\\x'],
    ['Get-Content $global:x'],
    ['Get-Content $HOME.Length'],
    ['Get-Content $args[0]'],
    ['Get-Content $_'],
    ['Get-Content $?'],
    ['Get-Content (Join-Path . x)'],
    ['Get-Content "$(whoami).txt"'],
    ['Get-Content "a`tb.txt"'],
    ['Get-Content a`b.txt'],
    ['Get-ChildItem | Where-Object { $_.Length -gt 1 }'],
    ['Get-ChildItem | % { $_.Name }'],
    ['Get-ChildItem | ForEach-Object -MemberName Delete'],
    ['Get-ChildItem | % Delete'],
    ['& $tool'],
    ['& \x27C:\\x y\\z.exe\x27 run'],
    ['& git status'],
    ['. .\\profile.ps1'],
    ['iex \x27Remove-Item x\x27'],
    ['Invoke-Expression $s'],
    ['Invoke-Command -ScriptBlock { rm x }'],
    ['Start-Process notepad'],
    ['saps cmd'],
    ['pwsh -Command \x27Remove-Item x\x27'],
    ['powershell -EncodedCommand AAAA'],
    ['cmd /c del x'],
    ['bash -c \x27rm x\x27'],
    ['wsl rm x'],
    ['Set-Alias ls Remove-Item; ls x'],
    ['Add-Type -TypeDefinition x'],
    ['Get-Content @args'],
    ['Get-Content @(\x27a\x27, \x27b\x27)'],
    ['Get-Content @{a=1}'],
    ['@\x27\nRemove-Item x\n\x27@ | Out-File y.ps1'],
    ['[IO.File]::ReadAllText(\x27x\x27)'],
    ['Get-ChildItem Env:'],
    ['Get-Content HKCU:\\Software\\x'],
    ['Get-Content Function:\\prompt'],
    ['Set-Content -Path Variable:\\x -Value 1'],
    ['Get-Content \\\\server\\share\\x.txt'],
    ['Copy-Item a //server/share/b'],
    ['Get-Content \\\\?\\UNC\\server\\share\\x'],
    ['Get-Content C:x.txt'],
    ['Set-Location D:'],
    ['Get-Content ~user\\x'],
    ['cd -; Remove-Item x'],
    ['popd; Remove-Item x'],
    ['cd $x; Remove-Item y'],
    ['Push-Location -StackName s src'],
    ['if ($true) { rm x }'],
    ['function f { rm x }; f'],
    ['foreach ($f in 1..2) { $f }'],
    ['try { rm x } catch {}'],
    ['exit 1'],
    ['5 > five.txt'],
    ['0x10'],
    ['\x27abc\x27 | Out-File x.txt'],
    ['"abc" > x.txt'],
    ['!x'],
    ['-not (Test-Path x)'],
    ['Get-Content \u2018x\u2019'],
    ['Remove-Item \u2013Recurse x'],
    ['Get-Content x <# note #>'],
    ['icacls x --% /grant Everyone:F'],
    ['Get-ChildItem &'],
    ['Get-Content \x27unterminated'],
    ['Get-Content "unterminated'],
    ['Get-Content x)'],
    ['Get-Content x }'],
    ['Get-Content a.txt; $y'],
    ['Write-Output (1 + 2) > x.txt'],
  ])('%s', (command, expected) => {
    check(command, { unresolved: true, exploration: false, ungrantable: true, ...expected });
  });

  it('keeps the deny floor: literal words inside unreadable regions are still operands', () => {
    expect(read('Get-Content (Join-Path $HOME \x27.ssh\\id_rsa\x27)').paths).toContain(
      at('.ssh\\id_rsa')
    );
    expect(read('Get-ChildItem | Where-Object { $_.Name -like \x27*.key\x27 }').paths).toContain(
      at('*.key')
    );
    // A string something is about to run: every word of it, not the string as one name.
    expect(read('iex "Get-Content .env"').paths).toContain(at('.env'));
    expect(read('Invoke-Expression \x27Get-Content id_rsa -Raw\x27').paths).toContain(at('id_rsa'));
    expect(read('cmd /c type server.key').paths).toContain(at('server.key'));
    expect(read('@\x27\nGet-Content server.key\n\x27@ | iex').paths).toContain(at('server.key'));
  });

  it('registers a UNC operand only when the deny list refuses its name as written', () => {
    expect(read('Get-Content \\\\srv\\share\\ok.txt').paths).toEqual([]);
    expect(read('Get-Content \\\\srv\\share\\.env').paths).toEqual(['\\\\srv\\share\\.env']);
  });

  it('refuses a command too large to read', () => {
    const huge = Array.from({ length: 20_001 }, () => 'a').join(' ; ');
    expect(() => read(huge)).toThrow(PermissionError);
    expect(() => read(huge)).toThrow('pwsh command exceeds analysis limit');
  });
});

describe('pwsh programs whose own body is opaque: unresolved, still grantable', () => {
  it.each([
    'python x.py',
    'python3 -m pytest',
    'py build.py',
    'node build.js',
    'Import-Module .\\x.psm1',
    'ii report.docx',
    'perl x.pl',
  ])('%s', (command) => {
    check(command, { unresolved: true, exploration: false, ungrantable: false });
  });
});

describe('pwsh exploration (plan mode may run it)', () => {
  it.each([
    'Get-ChildItem',
    'ls src',
    'dir -Recurse -Filter *.ts',
    'Get-Content a.txt | Select-Object -First 5',
    'cat a.txt | measure -Line',
    'sls foo *.ts',
    'Select-String -Path *.md -Pattern TODO',
    'git status',
    'git log --oneline -5',
    'git diff HEAD~1',
    'Test-Path x',
    'Resolve-Path .\\x',
    'gcm node',
    'echo hi',
    'Get-Location',
    'Get-Item a.txt',
    'Get-ChildItem | Sort-Object Length | Select-Object -Last 3',
    'Get-ChildItem | Where-Object Length -gt 100',
    'Get-ChildItem 2>$null',
  ])('%s explores', (command) => {
    check(command, { exploration: true, unresolved: false, ungrantable: false });
  });

  it.each([
    'Remove-Item x',
    'Set-Content x y',
    'New-Item -ItemType Directory d',
    'npm test',
    'git push',
    'git diff --ext-diff',
    'git log --output=x',
    'Get-Content a > b',
    'cd src; ls',
    'Get-ChildItem | Remove-Item',
    'Copy-Item a b',
    'Invoke-WebRequest https://example.invalid',
    'sc stop svc',
  ])('%s does not', (command) => {
    expect(read(command).exploration).toBe(false);
  });

  it('an empty command neither explores nor touches anything', () => {
    expect(read('')).toEqual({
      paths: [],
      commands: [],
      unresolvedPaths: false,
      exploration: false,
    });
    expect(read('# only a comment').commands).toEqual([]);
  });
});

describe('pwsh read on a POSIX host', () => {
  const posix = (command: string) =>
    analyzePwsh(command, '/ws', { HOME: '/home/me', TMPDIR: '/tmp/me' }, { platform: 'linux' });

  it('joins with / and expands $HOME, $env: and ~ from the POSIX environment', () => {
    expect(posix('Get-Content a.txt, /etc/hosts, ~/x, $env:TMPDIR/y').paths).toEqual([
      '/ws/a.txt',
      '/etc/hosts',
      '/home/me/x',
      '/tmp/me/y',
    ]);
    expect(posix('Get-Content $HOME/z').paths).toEqual(['/home/me/z']);
  });

  it('still refuses provider drives and reads case-sensitive environment names', () => {
    expect(posix('Get-ChildItem Env:').unresolvedPaths).toBe(true);
    expect(posix('Get-Content $env:home/x').unresolvedPaths).toBe(true);
  });
});
