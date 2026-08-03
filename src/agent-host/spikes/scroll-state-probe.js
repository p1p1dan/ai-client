// T-31 reply-anatomy spec §5.6-A feasibility probe: does Electron's Chromium support
// CSS scroll-state container queries? Run: ./node_modules/.bin/electron --no-sandbox src/agent-host/spikes/scroll-state-probe.js
// Result 2026-08-03 (Electron 39 / Chromium 142.0.7444.235): supportsProp=true,
// computedRoundtrip='scroll-state', ruleParsed=true -> option A confirmed, no line-clamp fallback needed.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<div id=x></div>');
  const result = await win.webContents.executeJavaScript(`(() => {
    const out = { chromium: navigator.userAgent.match(/Chrome\\/([\\d.]+)/)?.[1] };
    out.supportsProp = CSS.supports('container-type', 'scroll-state');
    const el = document.getElementById('x');
    el.style.containerType = 'scroll-state';
    out.computedRoundtrip = getComputedStyle(el).containerType;
    const style = document.createElement('style');
    style.textContent = '@container scroll-state(stuck: top) { #x { color: red; } }';
    document.head.appendChild(style);
    out.ruleParsed = style.sheet.cssRules.length > 0;
    return out;
  })()`);
  console.log(`PROBE_RESULT ${JSON.stringify(result)}`);
  app.exit(0);
});
