/**
 * Lenso 展示/布局原语探针（P0）。
 *
 * 用 Bun.build 把 `lenso-controls.ts` 和一个 `@lenso/ui` stub 打进浏览器
 * harness，再用 Playwright 验证每个适配器：
 * - 懒加载未完成时渲染原生 fallback，并带 `data-lenso-slot="<slot>-fallback"`；
 * - 懒加载完成后渲染对应 Lenso 组件（stub 标记 `data-stub`），并带
 *   `data-lenso-slot="<slot>"`；
 * - className、style 与 ref 两条路径都透传。
 *
 * 只做探针，不改动页面上任何现有 UI。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { chromium } from 'playwright';

import { check, checkEqual, checksPassed } from './lib/harness';

const ROOT = resolve(import.meta.dir, '..');
const ADAPTERS = [
  ['Avatar', 'div', 'avatar'],
  ['AvatarGroup', 'div', 'avatar-group'],
  ['Badge', 'span', 'badge'],
  ['Chip', 'span', 'chip'],
  ['Tag', 'span', 'tag'],
  ['TagGroup', 'div', 'tag-group'],
  ['Card', 'div', 'card'],
  ['Surface', 'div', 'surface'],
  ['Separator', 'hr', 'separator'],
  ['Skeleton', 'div', 'skeleton'],
  ['EmptyState', 'div', 'empty-state'],
  ['ProgressBar', 'progress', 'progress-bar'],
  ['ProgressCircle', 'div', 'progress-circle'],
  ['Pagination', 'nav', 'pagination'],
  ['Toolbar', 'div', 'toolbar'],
  ['NavigationBar', 'nav', 'navigation-bar'],
  ['Kbd', 'kbd', 'kbd'],
  ['Spinner', 'span', 'spinner'],
  ['Link', 'a', 'link'],
  ['ScrollShadow', 'div', 'scroll-shadow'],
  ['ScrollEdge', 'div', 'scroll-edge'],
] as const;

const STUB_SOURCE = `
import { createElement } from 'react';
const make = (name) => function Stub(props) {
  return createElement('div', { ...props, 'data-stub': name });
};
${ADAPTERS.filter(([name]) => name !== 'ProgressBar' && name !== 'ProgressCircle')
  .map(([name]) => `export const ${name} = make('${name}');`)
  .join('\n')}
export const ProgressBar = Object.assign(make('ProgressBar'), {
  Track: make('ProgressBar.Track'),
  Fill: make('ProgressBar.Fill'),
});
export const ProgressCircle = Object.assign(make('ProgressCircle'), {
  Track: make('ProgressCircle.Track'),
  TrackCircle: make('ProgressCircle.TrackCircle'),
  FillCircle: make('ProgressCircle.FillCircle'),
});
`;

const HARNESS_SOURCE = `
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as controls from ${JSON.stringify(join(ROOT, 'src/web/app/lenso-controls.ts'))};

const cases = ${JSON.stringify(ADAPTERS)};
const results = [];
for (const [name, expectedTag, expectedSlot] of cases) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let refNode = null;
  const props = {
    className: 'probe-class',
    style: { display: 'block' },
    'data-probe': name,
    ref: (node) => { refNode = node; },
  };
  flushSync(() => root.render(createElement(controls[name], props)));
  const fallback = host.firstElementChild;
  results.push({
    name,
    expectedTag,
    expectedSlot,
    fallbackTag: fallback?.tagName.toLowerCase(),
    fallbackSlot: fallback?.getAttribute('data-lenso-slot'),
    fallbackClass: fallback?.classList.contains('probe-class'),
    fallbackStyle: fallback?.style.display,
    fallbackRef: refNode === fallback,
    root,
    host,
  });
}
await new Promise((done) => setTimeout(done, 50));
for (const item of results) {
  let refNode = null;
  flushSync(() => item.root.render(createElement(controls[item.name], {
    className: 'probe-class',
    style: { display: 'block' },
    'data-probe': item.name,
    ref: (node) => { refNode = node; },
  })));
  const loaded = item.host.firstElementChild;
  item.loadedTag = loaded?.tagName.toLowerCase();
  item.loadedSlot = loaded?.getAttribute('data-lenso-slot');
  item.loadedStub = loaded?.getAttribute('data-stub');
  item.loadedClass = loaded?.classList.contains('probe-class');
  item.loadedStyle = loaded?.style.display;
  item.loadedRef = refNode === loaded;
  delete item.root;
  delete item.host;
}
window.__lensoPrimitiveProbe = results;
`;

interface ProbeResult {
  name: string;
  expectedTag: string;
  expectedSlot: string;
  fallbackTag: string | null;
  fallbackSlot: string | null;
  fallbackClass: boolean;
  fallbackStyle: string;
  fallbackRef: boolean;
  loadedTag: string | null;
  loadedSlot: string | null;
  loadedStub: string | null;
  loadedClass: boolean;
  loadedStyle: string;
  loadedRef: boolean;
}

const dir = await mkdtemp(join(ROOT, 'node_modules', '.lenso-primitives-'));
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
try {
  const harnessPath = join(dir, 'harness.ts');
  await writeFile(harnessPath, HARNESS_SOURCE);
  const build = await Bun.build({
    entrypoints: [harnessPath],
    target: 'browser',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'lenso-primitives-stub',
        setup(builder) {
          builder.onResolve({ filter: /^@lenso\/ui$/ }, () => ({
            path: 'lenso-stub',
            namespace: 'lenso-stub',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'lenso-stub' }, () => ({
            contents: STUB_SOURCE,
            loader: 'js',
          }));
        },
      },
    ],
  });
  if (!build.success) {
    throw new Error(`harness 构建失败: ${build.logs.map((log) => log.message).join('; ')}`);
  }
  const entry = build.outputs.find((output) => output.kind === 'entry-point');
  if (!entry) throw new Error('harness 缺少 entry-point 产物');

  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ type: 'module', content: await entry.text() });
  const handle = await page.waitForFunction(
    () =>
      (window as unknown as { __lensoPrimitiveProbe?: unknown }).__lensoPrimitiveProbe,
    null,
    { timeout: 10_000 },
  );
  const results = (await handle.jsonValue()) as ProbeResult[];
  checkEqual('探针覆盖全部适配器', results.length, ADAPTERS.length);

  for (const result of results) {
    const label = `${result.name} fallback`;
    checkEqual(`${label} 标签`, result.fallbackTag, result.expectedTag);
    checkEqual(`${label} slot`, result.fallbackSlot, `${result.expectedSlot}-fallback`);
    check(`${label} className`, result.fallbackClass);
    checkEqual(`${label} style`, result.fallbackStyle, 'block');
    check(`${label} ref`, result.fallbackRef);

    const loaded = `${result.name} loaded`;
    checkEqual(`${loaded} slot`, result.loadedSlot, result.expectedSlot);
    checkEqual(`${loaded} 组件`, result.loadedStub, result.name);
    check(`${loaded} className`, result.loadedClass);
    checkEqual(`${loaded} style`, result.loadedStyle, 'block');
    check(`${loaded} ref`, result.loadedRef);
  }
} finally {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
}

console.log(`Lenso 展示原语探针通过：${checksPassed()} 项检查`);
