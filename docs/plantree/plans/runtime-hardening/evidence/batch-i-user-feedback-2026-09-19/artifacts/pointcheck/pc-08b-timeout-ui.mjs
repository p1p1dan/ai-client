/**
 * T093 — find 「模型请求超时」 in the real settings UI and photograph it.
 *
 * The first pass looked under 通用 / 模型 / AI 服务 and reported the section
 * missing; the tab list this build actually has is
 * 通用 / 外观 / 终端 / 编辑器 / Git / Pi / 扩展 / 数据迁移 / 快捷键 / 网络 / 高级,
 * and the section lives in `PiModelManagementSettings.tsx` — i.e. under 「Pi」.
 */
import { connect, save, shot, sleep } from './lib.mjs';

const { cdp } = await connect();
try {
  await cdp.evaluate(`(() => {
    const b = document.querySelector('nav[aria-label="主导航"] button[aria-label^="设置"]');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(2500);
  console.log('click Pi tab:', await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const b = [...document.querySelectorAll('button, [role="tab"], [role="menuitem"], a')]
      .filter(vis).find((n) => (n.textContent || '').trim() === 'Pi');
    if (!b) return 'not found';
    b.click();
    return 'clicked';
  })()`));
  await sleep(3000);
  let found = await cdp.evaluate(`(() => ({
    hasSection: /模型请求超时/.test(document.body.innerText),
    lines: document.body.innerText.split('\\n').filter((l) => /超时|空闲/.test(l)).slice(0, 10),
  }))()`);
  console.log('after Pi tab:', JSON.stringify(found));
  if (!found.hasSection) {
    // The section may be below the fold of the settings pane.
    await cdp.evaluate(`(() => {
      const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
        .filter((v) => v.offsetParent !== null);
      for (const v of vps) v.scrollTop = v.scrollHeight;
      return true;
    })()`);
    await sleep(1200);
    found = await cdp.evaluate(`(() => ({
      hasSection: /模型请求超时/.test(document.body.innerText),
      lines: document.body.innerText.split('\\n').filter((l) => /超时|空闲/.test(l)).slice(0, 10),
    }))()`);
    console.log('after scrolling to the bottom:', JSON.stringify(found));
  }
  const trigger = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const label = [...document.querySelectorAll('span,p,div')].filter(vis)
      .find((n) => (n.textContent || '').trim() === '空闲超时');
    if (!label) return null;
    const row = label.closest('div')?.parentElement ?? label.parentElement;
    const sel = row?.querySelector('[data-slot="select-trigger"], button');
    const r = (row ?? label).getBoundingClientRect();
    return { rowText: (row?.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
             selectText: (sel?.innerText || '').trim(),
             rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
  })()`);
  console.log('idle timeout row:', JSON.stringify(trigger, null, 1));
  save('08b-00-timeout-ui.json', { found, trigger });
  console.log('shot:', await shot(cdp, '08b-a-timeout-section.png'));
  if (trigger?.rect) {
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, trigger.rect.x - 20), y: Math.max(0, trigger.rect.y - 60),
              width: Math.min(900, trigger.rect.w + 60), height: Math.min(220, trigger.rect.h + 120), scale: 2 },
    });
    const fs = await import('node:fs');
    const p = await import('node:path');
    const file = p.join(p.dirname(new URL(import.meta.url).pathname), 'shots', '08b-b-timeout-row.png');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('shot (row 2x):', file);
  }
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (n) => /^(关闭|Close|完成|Done)$/.test((n.textContent || '').trim()) && n.offsetParent !== null);
    if (b) b.click();
    return !!b;
  })()`);
} finally {
  cdp.close();
}
