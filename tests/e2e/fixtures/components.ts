import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const parsed = JSON.parse(await readFile(resolve(process.cwd(), '.e2e/server.json'), 'utf8'));
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

export const requestId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

export async function callTool<T>(base: string, token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: {
      name, arguments: args, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'agent-network-e2e-components', version: '0.1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    } }),
  });
  const payload = await response.json() as {
    error?: { message?: string };
    result?: { isError?: boolean; structuredContent?: T; content?: { text?: string }[] };
  };
  if (payload.error || payload.result?.isError) throw new Error(`工具调用失败：${name}`);
  if (!payload.result) throw new Error('MCP 响应缺少 result');
  return payload.result.structuredContent ?? JSON.parse(payload.result.content?.[0]?.text ?? 'null') as T;
}

export async function login(page: Page, base: string, token: string) {
  await page.addInitScript(({ token, base }) => {
    localStorage.setItem('agent-network-token', token);
    localStorage.removeItem('agent-network-logged-out');
    localStorage.setItem('agent-network-room-filter', 'group');
    sessionStorage.setItem('__origin', base);
  }, { token, base });
}

export async function createComponentRoom(base: string) {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const tokenA = crypto.randomUUID();
  const tokenB = crypto.randomUUID();
  const nameB = `组件 B ${suffix}`;
  const roomTitle = `组件群 ${suffix}`;
  const { actor_id: actorA } = await callTool<{ actor_id: string }>(base, tokenA, 'network_register', {
    request_id: requestId('e2e_reg'), kind: 'human', name: `组件 A ${suffix}`, device_id: `e2e-components-${suffix}-a`,
  });
  const { actor_id: actorB } = await callTool<{ actor_id: string }>(base, tokenB, 'network_register', {
    request_id: requestId('e2e_reg'), kind: 'human', name: nameB, device_id: `e2e-components-${suffix}-b`,
  });
  const requested = await callTool<{ request: { contact_request_id: string } }>(base, tokenA, 'network_contact_request', {
    request_id: requestId('e2e_contact'), actor_id: actorB,
  });
  await callTool(base, tokenB, 'network_contact_request_respond', {
    request_id: requestId('e2e_contact'), contact_request_id: requested.request.contact_request_id, action: 'accept',
  });
  const created = await callTool<{ room: { room_id: string } }>(base, tokenA, 'network_room_create', {
    request_id: requestId('e2e_group'), kind: 'group', title: roomTitle, members: [actorB],
  });
  const roomId = created.room.room_id;
  await callTool(base, tokenB, 'network_message_send', {
    request_id: requestId('e2e_send'), client_message_id: requestId('e2e_cm'), room_id: roomId,
    body: '组件验收初始消息', invoke: [],
  });
  return { tokenA, tokenB, actorA, actorB, nameB, roomId, roomTitle };
}

export async function dragFile(page: Page, selector: string, type: 'dragenter' | 'dragover' | 'drop', name: string): Promise<boolean> {
  return page.evaluate(({ selector, type, name }) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`拖拽目标不存在: ${selector}`);
    const transfer = new DataTransfer();
    transfer.items.add(new File([`dropzone ${name}`], name, { type: 'text/plain' }));
    return !target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { selector, type, name });
}

/** 检查菜单退场过程中没有遮盖刚打开的对话框。 */
export async function expectAccountMenuClearOfDialog(page: Page, dialogId: string) {
  await expect(page.locator(`#${dialogId}`)).toBeVisible();
  const samples = await page.evaluate(async (id) => {
    const read = () => {
      const menu = document.querySelector('#account-menu');
      const dialog = document.getElementById(id);
      const style = menu ? getComputedStyle(menu) : null;
      const rect = menu?.getBoundingClientRect();
      const target = dialog?.getBoundingClientRect();
      const menuVisible = Boolean(rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden' && Number(style?.opacity) > 0);
      const overlap = rect && target && Math.min(rect.right, target.right) > Math.max(rect.left, target.left) && Math.min(rect.bottom, target.bottom) > Math.max(rect.top, target.top);
      const hit = target ? document.elementFromPoint(target.left + target.width / 2, target.top + Math.min(12, target.height / 2)) : null;
      return { menuVisible, overlap: Boolean(overlap), hitInMenu: Boolean(hit?.closest('#account-menu')) };
    };
    const frames = [read()];
    for (let index = 0; index < 6; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push(read());
    }
    return frames;
  }, dialogId);
  for (const sample of samples) {
    expect(sample.menuVisible, JSON.stringify(sample)).toBe(false);
    expect(sample.overlap, JSON.stringify(sample)).toBe(false);
    expect(sample.hitInMenu, JSON.stringify(sample)).toBe(false);
  }
  await expect.poll(() => page.evaluate((id) => {
    const dialog = document.getElementById(id);
    if (!dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return Boolean(document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(12, rect.height / 2))?.closest(`#${id}`));
  }, dialogId), { timeout: 2000 }).toBe(true);
}
