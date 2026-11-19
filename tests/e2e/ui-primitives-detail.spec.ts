import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// 真实 Lenso + 可控动态模块闸门；不依赖业务 JSX 或网络计时。
let dir = '';
let script = '';
let css = '';
test.beforeAll(async () => {
  dir = await mkdtemp(resolve('node_modules/.ui-detail-'));
  const entry = join(dir, 'probe.tsx');
  await writeFile(entry, `
import React from 'react';
import '@lenso/tokens/styles.css';
import '../../src/web/app/tokens.css';
import '../../src/web/app/ui-detail.css';
import '../../src/web/features/overlays/alert-dialog.css';
import '../../src/web/app/lenso-popover.css';
import '../../src/web/features/overlays/modal.css';
import { TASK_DOCK_STYLE } from '../../src/web/chat-task-dock-styles';
const legacy = document.createElement('style');
legacy.textContent = TASK_DOCK_STYLE;
document.head.append(legacy);
import { createRoot } from 'react-dom/client';
import { Button, Surface, Card, Badge, List, ListItem, LENSO_BADGE_FILL } from '../../src/web/app/lenso-controls';
import { useLenso, useBackendLease } from '../../src/web/app/lenso-runtime';
function Probe() {
  const module = useLenso();
  const [locked, setLocked] = React.useState(false);
  useBackendLease(locked);
  return <>
    <div id="ready">{module ? 'ready' : 'fallback'}</div>
    <div style={{ width: 320 }}>
      <Button id="row" data-button-role="row">多行内容<br/>第二行</Button>
      <Button id="normal" data-button-role="normal">普通</Button>
      <Button id="icon" data-button-role="icon" aria-label="图标">+</Button>
      <Button id="locked" onClick={() => setLocked(true)}>交互</Button>
      <List id="list"><ListItem id="item"><button id="list-focus">列表项</button></ListItem></List>
    </div>
    <div id="shell" data-ui-visual-owner="shell" style={{ border: '1px solid black', boxShadow: '0 2px 4px #888' }}>
      <Surface id="surface" data-ui-visual-owner="shell"><Card id="card" data-ui-visual-owner="shell"><Badge id="badge" style={LENSO_BADGE_FILL}>1</Badge></Card></Surface>
    </div>
    <div id="task-dock"><div className="task-dock-body"><Card data-task-surface="panel">Task</Card></div></div>
    <div id="popover" className="task-preview-popover" data-popover-backend="lenso"><div data-lenso-slot="popover-material"/></div>
    <div id="room-announcement-popover" data-popover-backend="lenso"/>
    <div id="edit" className="spa-dialog-content modal-card" role="dialog" data-modal-shell="fallback"/>
    <div id="confirm" className="spa-dialog-content" role="alertdialog" data-lenso-slot="alert-dialog-popup"/>
  </>;
}
createRoot(document.getElementById('root')).render(<Probe/>);
`);
  const config = join(dir, 'vite.config.ts');
  await writeFile(config, `
import config from '../../vite.config';
export default { ...config, base: '/', build: { ...config.build, outDir: ${JSON.stringify(join(dir, 'out'))}, manifest: true, rollupOptions: { input: ${JSON.stringify(entry)} } } };
`);
  execFileSync('bunx', ['vite', 'build', '--config', config]);
  const manifest = JSON.parse(await readFile(join(dir, 'out/.vite/manifest.json'), 'utf8'));
  const main = Object.values(manifest).find((chunk: any) => chunk.isEntry) as { file: string; css: string[] };
  script = main.file;
  expect(script).toBeTruthy();
  css = ':root{--wx-panel:white;--wx-text:black;--wx-line:#ddd;--wx-shadow:0 4px 16px #888}';
  for (const file of main.css) css += await readFile(join(dir, 'out', file), 'utf8');
});
test.afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

for (const interaction of ['none', 'button', 'list', 'lease']) {
  test(`共享原语 fallback/ready 与 ${interaction} 交互节点`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('http://ui-detail.test/**', async (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (!name) return route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script type="module" src="/${script}"></script>` });
      if (name.startsWith('assets/index-')) await gate;
      await route.fulfill({ contentType: 'text/javascript', body: await readFile(join(dir, 'out', name), 'utf8') });
    });
    await page.goto('http://ui-detail.test/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#ready')).toHaveText('fallback');
    await expect(page.locator('#row')).toHaveCSS('width', '320px');
    await expect(page.locator('#row')).toHaveCSS('border-radius', '8px');
    const geometry = () => page.locator('#row, #normal, #icon').evaluateAll((nodes) => nodes.map((node) => {
      const s = getComputedStyle(node);
      return [s.width, s.height, s.borderRadius, s.padding, s.display, s.fontSize, s.lineHeight];
    }));
    const before = await geometry();
    await expect(page.locator('#list')).toHaveJSProperty('tagName', 'UL');
    await expect(page.locator('#item')).toHaveJSProperty('tagName', 'LI');
    const focused = interaction === 'button' ? '#locked' : interaction === 'list' ? '#list-focus' : null;
    if (focused) { await page.locator(focused).focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); }
    if (interaction === 'lease') await page.locator('#locked').click();
    const saved = await page.locator(focused ?? '#surface').elementHandle();
    release();
    await expect.poll(async () => ({ ready: await page.locator('#ready').textContent(), errors })).toEqual({ ready: 'ready', errors: [] });
    if (focused || interaction === 'lease') {
      expect(await saved!.evaluate((node) => node.isConnected)).toBe(true);
      if (focused) await expect(page.locator(focused)).toBeFocused();
    }
    await expect.poll(geometry).toEqual(before);
    if (interaction === 'none') {
      await expect(page.locator('#list')).toHaveAttribute('data-lenso-slot', 'list-root');
      await expect(page.locator('#item')).toHaveAttribute('data-lenso-slot', 'list-item');
    }
    for (const selector of ['#surface', '#card', '#badge', '#task-dock [data-task-surface]']) {
      await expect(page.locator(selector)).toHaveCSS('border-top-width', '0px');
      await expect(page.locator(selector)).toHaveCSS('box-shadow', 'none');
      await expect(page.locator(selector)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
    await expect(page.locator('#shell')).toHaveCSS('border-top-width', '1px');
    await expect(page.locator('#popover')).toHaveCSS('border-radius', '12px');
    await expect(page.locator('#popover [data-lenso-slot]')).toHaveCSS('display', 'none');
    await expect(page.locator('#room-announcement-popover')).toHaveCSS('width', '320px');
    await expect(page.locator('#confirm')).toHaveCSS('width', '420px');
    await expect(page.locator('#edit')).toHaveCSS('width', '440px');
    await page.locator('#row').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#row')).toHaveCSS('outline-style', 'solid');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#edit')).toHaveCSS('box-shadow', 'none');
    await expect(page.locator('#edit')).toHaveCSS('border-radius', '0px');
    await expect(page.locator('#edit')).toHaveCSS('width', '390px');
    await expect(page.locator('#confirm')).toHaveCSS('width', '358px');
  });
}
