import { describe, expect, it } from 'vitest';
import { isDangerousShellCommand } from '../dangerousCommands.ts';

/**
 * claude-sdk-engine README ruling 27 (S-6 feedback 11c, dsh-rebase decision
 * 191): the commands full auto still stops to confirm. Segments are written
 * the way the analyses hand them over: one command each, a `pwsh` alias
 * already folded to its cmdlet, an unreadable `pwsh` segment as its raw text.
 */
describe('the commands full auto still confirms', () => {
  it.each([
    // Recursive deletes, in both shells and cmd.
    'rm -rf build',
    'rm -r src',
    'rm -R dist',
    'rm -fr node_modules',
    'rm --recursive x',
    '/bin/rm -rf x',
    'sudo rm -rf /var/x',
    'sudo -n rm -rf x',
    'xargs -0 rm -rf',
    'xargs -I {} rm -r {}',
    'env FOO=1 rm -rf x',
    'timeout 5 rm -rf x',
    'find . -name "*.log" -delete',
    'find . -type d -exec rm -rf {} ;',
    'Remove-Item -Recurse -Force build',
    'Remove-Item build -r',
    'Remove-Item -Path build -Recurse:True',
    'remove-item build -rec',
    'rm $dir -Recurse',
    'del /s /q build',
    'rd /s /q build',
    'rmdir /S build',
    'cmd /c "rd /s /q build"',
    'cmd.exe /c rmdir /s build',
    "bash -c 'rm -rf build'",
    'pwsh -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -Recurse x"',
    'echo ok; rm -rf build',
    'npm test && rm -rf coverage',
    // Force pushes and the git commands that throw work away.
    'git push --force',
    'git push -f origin main',
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc',
    'git push origin +main',
    'git push origin --delete old',
    'git push origin :old',
    'git push --mirror',
    'git -C ../repo push -f',
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git clean -f',
    'git clean -fdx',
    'git clean --force -d',
    'git checkout .',
    'git checkout -- .',
    'git checkout -f main',
    'git restore .',
    'git branch -D topic',
    'git branch --delete --force topic',
    'git stash drop',
    'git stash clear',
    // Disks.
    'format D:',
    'format.com D: /q',
    'mkfs /dev/sdb1',
    'mkfs.ext4 /dev/sdb1',
    'wipefs -a /dev/sdb',
    'diskpart',
    'Format-Volume -DriveLetter D',
    'Clear-Disk -Number 1',
  ])('confirms %s', (segment) => {
    expect(isDangerousShellCommand(segment)).toBe(true);
  });

  it.each([
    'rm file.txt',
    'rm -f stale.lock',
    'rmdir empty',
    'Remove-Item notes.txt',
    'Remove-Item notes.txt -Force',
    'Remove-Item -Path x -Filter *.tmp -ErrorAction SilentlyContinue',
    'del notes.txt',
    'echo $HOME',
    'npm test $FLAGS',
    'npm run format',
    'git status',
    'git push',
    'git push origin main',
    'git push -u origin topic',
    'git reset HEAD~1',
    'git reset --soft HEAD~1',
    'git clean -n',
    'git checkout main',
    'git checkout -b topic',
    'git checkout -- src/file.ts',
    'git restore src/file.ts',
    'git restore --staged .',
    'git branch -d merged',
    'git stash',
    'git stash pop',
    'find . -name "*.ts"',
    'Format-Table -AutoSize',
    'clang-format -i a.cc',
    'bash deploy.sh',
    'cmd /c dir',
    'sudo apt-get install jq',
  ])('lets %s through', (segment) => {
    expect(isDangerousShellCommand(segment)).toBe(false);
  });
});
