import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 独立浏览器实验使用真实依赖，不以 stub 推断 SDK 的 top layer / 焦点行为。
const ROOT = resolve(import.meta.dirname, '../..');
let dir: string;
let bundle: string;
test.beforeAll(() => {
  dir = mkdtempSync(join(ROOT, 'node_modules/.context-probe-'));
  writeFileSync(join(dir, 'probe.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ContextMenu } from '@lenso/ui';
import * as Dialog from '@radix-ui/react-dialog';
function Menu() {
  const [container, setContainer] = React.useState(null);
  React.useLayoutEffect(() => setContainer(document.getElementById('parent')), []);
  return <ContextMenu container={container}>
  <ContextMenu.Trigger render={<button id="trigger" />}>菜单</ContextMenu.Trigger>
  <ContextMenu.Content id="menu" dim={false}>
    <ContextMenu.Item id="first">第一项</ContextMenu.Item>
    <ContextMenu.Item id="disabled" disabled>禁用项</ContextMenu.Item>
    <ContextMenu.Item id="last" variant="danger">危险项</ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu>; }
createRoot(document.getElementById('root')).render(location.search ? <Menu /> : <Dialog.Root defaultOpen>
  <Dialog.Content id="parent"><Dialog.Title>父层</Dialog.Title><Menu /></Dialog.Content>
</Dialog.Root>);
`);
  writeFileSync(join(dir, 'vite.config.ts'), `
    import config from ${JSON.stringify(join(ROOT, 'vite.config.ts'))};
    export default { ...config, build: { ...config.build,
      outDir: ${JSON.stringify(join(dir, 'out'))},
      rollupOptions: { input: ${JSON.stringify(join(dir, 'probe.tsx'))}, output: { entryFileNames: 'probe.js' } },
    } };
  `);
  execFileSync('bunx', ['vite', 'build', '--config', join(dir, 'vite.config.ts')], { cwd: ROOT, stdio: 'pipe' });
  bundle = readFileSync(join(dir, 'out/probe.js'), 'utf8');
});
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('真实 SDK：native popover、body、焦点与 Radix 内嵌', async ({ page }) => {
  await page.route('http://context.test/**', (route) => route.fulfill({
    contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().endsWith('.js') ? bundle : '<div id="root"></div><script type="module" src="/probe.js"></script>',
  }));
  await page.goto('http://context.test');
  await page.locator('#trigger').click({ button: 'right' });
  await expect(page.locator('#menu')).toBeVisible();
  const evidence = await page.evaluate(() => ({
    popovers: [...document.querySelectorAll(':popover-open')].map((node) => ({ tag: node.tagName, role: node.getAttribute('role'), id: node.id })),
    pointerEvents: getComputedStyle(document.body).pointerEvents,
    focus: document.activeElement?.id,
    inParent: Boolean(document.querySelector('#parent #menu')),
  }));
  console.log('真实 ContextMenu 实验', evidence);
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu')).toBeHidden();
  // 已确认的跨库缺陷：container 不能隔离原生 Escape 与 Radix dismiss 层。
  // 产品头像菜单因此继续用 Radix，此实验防止未来把不兼容分支硬换进去。
  await expect(page.locator('#parent')).toBeHidden();

  await page.goto('http://context.test/?standalone');
  await page.locator('#trigger').click({ button: 'right' });
  await expect(page.locator('#menu')).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).toBe('auto');
  await page.keyboard.press('Escape');
  await expect(page.locator('#trigger')).toBeFocused();
  await page.locator('#trigger').dispatchEvent('pointerdown', {
    pointerType: 'touch', clientX: 30, clientY: 30, button: 0, pointerId: 1,
  });
  await expect(page.locator('#menu')).toBeVisible();
  await page.mouse.click(700, 500);
  await expect(page.locator('#menu')).toBeHidden();
});
