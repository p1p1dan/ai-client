/**
 * P6-2 口径 A（用户 2026-09-13 决定）——pi-coding-agent 是**随包的一个可执行文件**，
 * 不是我们的库。
 *
 * 背景：ARD 成功标准第 3 条要求把它从 `package.json` 移除，而那条写下来的时候它只是
 * 一个库。后来 H/18～H/20 让它又成了两个用户可见功能的执行体——内嵌 Pi 终端跑它的
 * `dist/bundle/cli.js`，插件的装/卸/列跑同一个文件。按字面删掉等于下线这两项功能，
 * 还会让 P6-4 的回退开关没有回退对象。用户选择保留它的**可执行文件**角色，放弃它的
 * **库**角色。
 *
 * 所以这条规则不是「哪里都不许出现这个名字」，而是：
 *
 *   - 只有 `src/agent-host/` 的旧引擎路径可以 import 它（它就是那个引擎，在回退窗口
 *     里还要能跑）；
 *   - 应用的其它任何地方——runtime、main、renderer、shared——都不许把它当库；
 *   - 终端与插件管理只能通过**进程**用它，也就是解析出 `cli.js` 的路径去 spawn。
 *
 * 周期结束、旧引擎退役（P6-5）之后，这条规则收紧成「一处都不许 import」，那时这个
 * 测试只需要把允许名单清空。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const srcRoot = path.join(repoRoot, 'src');
const PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * Nobody. P6-5 retired the legacy engine on 2026-09-13, so the allow-list that
 * carried it through the rollback window is empty — the package is a bundled
 * executable and nothing more.
 */
const LIBRARY_ALLOWED: readonly string[] = [];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const entry = path.join(dir, name);
    if (statSync(entry).isDirectory()) sourceFiles(entry, found);
    else if (/\.(ts|tsx|mjs)$/.test(name)) found.push(entry);
  }
  return found;
}

/**
 * Import specifiers only.
 *
 * A comment naming the package, or a test that loads the shipped file by path
 * (which is what `sessionInterop.test.ts` does — the CLI there is the subject
 * under test, not a dependency), is not a library import and must not trip this.
 */
function importsPackageAsLibrary(source: string): boolean {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const escaped = PACKAGE.replace(/[/-]/g, '\\$&');
  return (
    new RegExp(`from\\s*['"]${escaped}['"]`).test(withoutComments) ||
    new RegExp(`import\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`).test(withoutComments) ||
    new RegExp(`require\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`).test(withoutComments)
  );
}

describe('P6-2 · pi-coding-agent is a bundled tool, not our library', () => {
  const importers = sourceFiles(srcRoot)
    .filter((file) => importsPackageAsLibrary(readFileSync(file, 'utf8')))
    .map((file) => path.relative(repoRoot, file))
    .sort();

  it('walks a real source tree and recognises an import when there is one', () => {
    // Guards the gate itself. With the allow-list empty, "no importers" is the
    // expected answer — so a walker that visited nothing, or a matcher that
    // recognises nothing, would pass the rule below for the wrong reason.
    expect(sourceFiles(srcRoot).length).toBeGreaterThan(200);
    expect(importsPackageAsLibrary(`import { x } from '${PACKAGE}';`)).toBe(true);
    expect(importsPackageAsLibrary(`await import('${PACKAGE}')`)).toBe(true);
    // A path to the shipped file is how the terminal uses it, and is not an
    // import of the package; `sessionInterop.test.ts` loads it exactly so.
    expect(importsPackageAsLibrary(`resolve('node_modules/${PACKAGE}/dist/x.js')`)).toBe(false);
  });

  it('is imported nowhere in the app', () => {
    expect(importers.filter((file) => !LIBRARY_ALLOWED.includes(file))).toEqual([]);
  });

  it('still reaches the terminal and the plugin manager as a process', () => {
    // The other half of decision A: keeping the package is only justified while
    // these two features run its CLI. If this stops being true, the package has
    // no reason to stay and P6-2 can complete literally.
    const pty = readFileSync(path.join(repoRoot, 'src/main/services/terminal/PiTuiPty.ts'), 'utf8');
    expect(pty).toContain("'pi-coding-agent'");
    expect(pty).toContain("'cli.js'");
    const plugins = readFileSync(
      path.join(repoRoot, 'src/main/services/piPlugins/index.ts'),
      'utf8'
    );
    expect(plugins).toContain('resolvePiCliLaunchPlan');
  });
});
