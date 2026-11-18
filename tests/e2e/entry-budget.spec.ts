import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Manifest = Record<string, { file: string; name?: string; imports?: string[]; dynamicImports?: string[] }>;
let base: string;
let manifest: Manifest;
let roomFile: string;
let roomId: string;
const token = crypto.randomUUID();

async function callTool<T>(credential: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name,
      authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call',
      params: { name, arguments: { request_id: crypto.randomUUID(), ...args }, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'entry-budget-test', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
  });
  const payload = await response.json() as {
    error?: { message: string };
    result?: { isError?: boolean; structuredContent?: T; content?: { text: string }[] };
  };
  if (payload.error || !payload.result || payload.result.isError) throw new Error('预算测试 fixture 工具失败');
  return payload.result.structuredContent ?? JSON.parse(payload.result.content?.[0]?.text ?? 'null') as T;
}

async function login(page: Page) {
  await page.addInitScript((credential) => {
    localStorage.setItem('agent-network-token', credential);
    localStorage.setItem('agent-network-room-filter', 'group');
  }, token);
}

test.beforeAll(async () => {
  base = process.env.E2E_BASE_URL ?? JSON.parse(await readFile(resolve('.e2e/server.json'), 'utf8')).base;
  manifest = JSON.parse(await readFile(resolve('dist/web/.vite/manifest.json'), 'utf8')) as Manifest;
  const room = Object.entries(manifest).find(([, chunk]) => chunk.name === 'ChatPage');
  if (!room) throw new Error('ChatPage 必须是独立动态 chunk');
  roomFile = room[1].file;
  expect(manifest['src/web/app/main.tsx']?.dynamicImports).toContain(room[0]);
  const peerToken = crypto.randomUUID();
  await callTool(token, 'network_register', { kind: 'human', name: '预算用户', device_id: crypto.randomUUID() });
  const peer = await callTool<{ actor_id: string }>(peerToken, 'network_register', {
    kind: 'human', name: '预算好友', device_id: crypto.randomUUID(),
  });
  const request = await callTool<{ request: { contact_request_id: string } }>(token,
    'network_contact_request', { actor_id: peer.actor_id });
  await callTool(peerToken, 'network_contact_request_respond', {
    contact_request_id: request.request.contact_request_id, action: 'accept',
  });
  const created = await callTool<{ room: { room_id: string } }>(token, 'network_room_create', {
    kind: 'group', title: '预算验收群', members: [peer.actor_id],
  });
  roomId = created.room.room_id;
});

test('冷首页不提前下载聊天路由，点击会话才请求', async ({ page }) => {
  await login(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(base);
  await expect(page.getByRole('complementary', { name: '会话列表' })).toBeVisible();
  await expect(page.locator('[data-lenso-slot="button"]').first()).toBeVisible();
  // inbox SSE 常驻；只观察静态资源安静期，不等待 networkidle。
  await page.waitForTimeout(750);
  expect(requests.some((url) => url.endsWith(roomFile))).toBe(false);
  const beforeClick = requests.length;
  await page.locator(`#room-list a[href="/c/${roomId}"]`).click();
  await expect(page.locator('#body')).toBeVisible();
  expect(requests.slice(beforeClick).some((url) => url.endsWith(roomFile))).toBe(true);
  console.log(JSON.stringify({ deferred: roomFile, requestedStaticAssets:
    requests.filter((url) => url.includes('/static/')).map((url) => new URL(url).pathname) }));
});

for (const width of [1280, 390]) {
  test(`慢 room chunk：${width} 几何、单栏、无业务占位重复与草稿焦点`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' });
    await login(page);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    await page.route(`**/${roomFile}`, async (route) => { await gate; await route.continue(); });
    await page.goto(`${base}/c/${roomId}`);
    const fallback = page.locator('[data-chat-route-fallback]');
    try {
      await expect(fallback).toBeVisible();
      await expect(page.locator('.sidebar:visible')).toHaveCount(width === 390 ? 0 : 1);
      await expect(page.locator('.chat-pane:visible')).toHaveCount(1);
      await expect(page.locator('#body, #title, #chat, #file-input')).toHaveCount(0);
      await expect(page.locator('form')).toHaveCount(0);
      const chat = await fallback.boundingBox();
      expect(chat).not.toBeNull();
      if (width === 390) {
        expect(chat!.x).toBe(0);
        expect(chat!.width).toBe(390);
      } else {
        const sidebar = await page.locator('.sidebar').boundingBox();
        expect(sidebar!.width).toBeGreaterThanOrEqual(280);
        expect(sidebar!.width).toBeLessThanOrEqual(320);
        expect(Math.abs(chat!.x - sidebar!.width)).toBeLessThan(2);
      }
      console.log(JSON.stringify({ width, fallbackChat: chat,
        sidebar: await page.locator('.sidebar').boundingBox() }));
    } finally { release(); }
    await expect(fallback).toHaveCount(0);
    await expect(page.locator('#title')).toHaveText('预算验收群');
    await expect(page.locator('.chat-pane:visible')).toHaveCount(1);
    await expect(page.locator('.sidebar:visible')).toHaveCount(width === 390 ? 0 : 1);
    await expect(page.locator('#body')).toHaveCount(1);
    await page.locator('#body').fill('未发送的草稿 @预算');
    await page.locator('#body').evaluate((node) => {
      (window as unknown as { budgetInput: Element }).budgetInput = node;
      (node as HTMLTextAreaElement).setSelectionRange(3, 3);
    });
    await page.waitForTimeout(750);
    await expect(page.locator('#body')).toBeFocused();
    await expect(page.locator('#body')).toHaveValue('未发送的草稿 @预算');
    expect(await page.locator('#body').evaluate((node) => ({
      same: node === (window as unknown as { budgetInput: Element }).budgetInput,
      selection: (node as HTMLTextAreaElement).selectionStart,
    }))).toEqual({ same: true, selection: 3 });
  });
}

test('room chunk 失败保留可操作错误页', async ({ page }) => {
  await login(page);
  await page.route(`**/${roomFile}`, (route) => route.abort('failed'));
  await page.goto(`${base}/c/${roomId}`);
  await expect(page.getByRole('heading', { name: '页面加载失败' })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新页面' })).toBeVisible();
  await expect(page.locator('#body')).toHaveCount(0);
});
