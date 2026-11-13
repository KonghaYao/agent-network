import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const file = resolve(process.cwd(), '.e2e/server.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { base?: unknown };
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

/**
 * 4B-6 壳冒烟：legacy 默认页已删除，`/` 与 `/c/*` 始终输出 React 壳。
 * Home 的列表/搜索/SSE 细节在 `home.spec.ts`。
 */
test('home always renders the React shell', async ({ request }) => {
  const base = await baseUrl();
  const response = await request.get(`${base}/`);
  expect(response.ok()).toBe(true);
  const html = await response.text();
  expect(html).toContain('data-spa-route="home"');
  expect(html).toContain('id="spa-bootstrap"');
  expect(html).not.toContain('initialRoomId');
  expect(html).not.toContain('/assets/chat-resizer.js');
});

test('room renders the React chat shell', async ({ request }) => {
  const base = await baseUrl();
  const response = await request.get(`${base}/c/room-placeholder`);
  expect(response.ok()).toBe(true);
  const html = await response.text();
  expect(html).toContain('data-spa-route="room"');
  expect(html).toContain('class="wide page-room"');
  expect(html).not.toContain('initialRoomId');
});

test('removed legacy assets return 410', async ({ request }) => {
  const base = await baseUrl();
  for (const name of ['chat-resizer.js', 'chat-icons.js']) {
    const response = await request.get(`${base}/assets/${name}`);
    expect(response.status()).toBe(410);
  }
});
