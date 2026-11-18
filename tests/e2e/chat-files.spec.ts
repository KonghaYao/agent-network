import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const file = resolve(process.cwd(), '.e2e/server.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { base?: unknown };
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

interface ToolEnvelope {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
}

async function callTool<T>(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'agent-network-e2e',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: ToolEnvelope;
  };
  if (payload.error) throw new Error(payload.error.message ?? 'MCP 调用失败');
  const result = payload.result;
  if (!result) throw new Error('MCP 响应缺少 result');
  if (result.isError === true) {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(text ?? '工具调用失败');
  }
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP 响应缺少正文');
  return JSON.parse(text) as T;
}

interface Registered {
  actor_id: string;
  name: string;
}

interface RoomList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface RoomDetail {
  room: { room_id: string };
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

interface HistoryPage {
  items: { preview: string; sender_id: string }[];
}

interface UploadedFile {
  fileId: string;
  publicUrl: string;
}

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PIXEL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==',
  'base64',
);

/** 真实 MCPP Files 上传；返回服务端 fileId 与公开地址。 */
async function uploadBinary(
  base: string,
  token: string,
  name: string,
  mimeType: string,
  body: Buffer,
): Promise<UploadedFile> {
  const response = await fetch(`${base}/mcp-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'MCPP-Files-Version': '1',
      'content-type': mimeType,
      'MCPP-File-Name': encodeURIComponent(name),
      'MCPP-File-Size': String(body.length),
    },
    body: body as unknown as BodyInit,
  });
  if (response.status !== 201) {
    throw new Error(`上传 ${name} 失败：HTTP ${response.status}`);
  }
  return (await response.json()) as UploadedFile;
}

async function bindRoomFile(
  base: string,
  token: string,
  roomId: string,
  fileId: string,
): Promise<void> {
  await callTool(base, token, 'network_room_file_bind', {
    request_id: requestId('e2e_file_bind'),
    room_id: roomId,
    file_id: fileId,
  });
}

async function publishRoomFile(
  base: string,
  token: string,
  roomId: string,
  fileId: string,
  isPublic: boolean,
): Promise<void> {
  await callTool(base, token, 'network_file_publish', {
    request_id: requestId('e2e_file_publish'),
    room_id: roomId,
    file_id: fileId,
    public: isPublic,
  });
}

async function sendFileMessage(
  base: string,
  token: string,
  roomId: string,
  body: string,
): Promise<void> {
  await callTool(base, token, 'network_message_send', {
    request_id: requestId('e2e_file_send'),
    client_message_id: requestId('e2e_file_cm'),
    room_id: roomId,
    body,
    invoke: [],
  });
}

/** 上传并绑定到房间；测试卡片只依赖消息正文里的公开/私有 URL。 */
async function seedRoomFile(
  base: string,
  token: string,
  roomId: string,
  spec: { name: string; mimeType: string; body: Buffer },
): Promise<UploadedFile> {
  const uploaded = await uploadBinary(base, token, spec.name, spec.mimeType, spec.body);
  await bindRoomFile(base, token, roomId, uploaded.fileId);
  return uploaded;
}

async function naturalWidth(locator: Locator): Promise<number> {
  return locator.evaluate((element) => (element as HTMLImageElement).naturalWidth);
}

test.describe('SPA Chat file cards', () => {
  let base = '';
  let humanToken = '';
  let agentToken = '';
  let directRoomId = '';
  let groupRoomId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    humanToken = crypto.randomUUID();
    agentToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
    const human = await callTool<Registered>(base, humanToken, 'network_register', {
      request_id: requestId('e2e_files_reg'),
      kind: 'human',
      name: `文件卡片人类 ${suffix}`,
      device_id: `e2e-files-${suffix}`,
    });
    const agent = await callTool<Registered>(base, agentToken, 'network_register', {
      request_id: requestId('e2e_files_reg'),
      kind: 'agent',
      name: `文件卡片 Agent ${suffix}`,
      agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const contact = await callTool<ContactRequestResult>(
      base,
      humanToken,
      'network_contact_request',
      {
        request_id: requestId('e2e_files_contact'),
        actor_id: agent.actor_id,
      },
    );
    const contactRequestId = contact.request?.contact_request_id;
    if (!contactRequestId) throw new Error('文件卡片测试好友申请未创建');
    await callTool(base, agentToken, 'network_contact_request_respond', {
      request_id: requestId('e2e_files_contact'),
      contact_request_id: contactRequestId,
      action: 'accept',
    });
    const direct = await callTool<RoomDetail>(base, humanToken, 'network_room_create', {
      request_id: requestId('e2e_files_room'),
      kind: 'direct',
      members: [agent.actor_id],
    });
    directRoomId = direct.room.room_id;
    const group = await callTool<RoomDetail>(base, humanToken, 'network_room_create', {
      request_id: requestId('e2e_files_group'),
      kind: 'group',
      title: `文件卡片群 ${suffix}`,
      members: [agent.actor_id],
    });
    groupRoomId = group.room.room_id;
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 浏览器禁用存储时由页面错误态兜底。
      }
    }, humanToken);
  });

  test('renders human and agent public image thumbnails', async ({ page }) => {
    const humanFile = await seedRoomFile(base, humanToken, directRoomId, {
      name: '人类图片.png',
      mimeType: 'image/png',
      body: PIXEL_PNG,
    });
    const agentFile = await seedRoomFile(base, agentToken, directRoomId, {
      name: 'Agent图片.png',
      mimeType: 'image/png',
      body: PIXEL_PNG,
    });
    const humanMarker = `FILE-HUMAN-${crypto.randomUUID().slice(0, 8)}`;
    const agentMarker = `FILE-AGENT-${crypto.randomUUID().slice(0, 8)}`;
    await sendFileMessage(
      base,
      humanToken,
      directRoomId,
      `${humanMarker}\n[人类图片.png](${humanFile.publicUrl})`,
    );
    await sendFileMessage(
      base,
      agentToken,
      directRoomId,
      `${agentMarker}\n[Agent图片.png](${agentFile.publicUrl})`,
    );

    await page.goto(`${base}/c/${directRoomId}`);
    const humanMessage = page.locator('#messages .msg').filter({ hasText: humanMarker });
    await humanMessage.scrollIntoViewIfNeeded();
    await expect(humanMessage.locator('.msg-file-name')).toHaveText('人类图片.png', {
      timeout: 10_000,
    });
    const humanThumb = humanMessage.locator('.msg-file-thumb img');
    await expect(humanThumb).toBeVisible();
    await expect.poll(() => naturalWidth(humanThumb), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await humanThumb.getAttribute('loading')).toBe('lazy');
    expect(await humanThumb.getAttribute('decoding')).toBe('async');
    expect(await humanThumb.getAttribute('referrerpolicy')).toBe('no-referrer');
    await humanMessage.locator('.msg-file-thumb').click();
    const dialogImage = page.locator('#file-preview-body img');
    await expect(dialogImage).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => naturalWidth(dialogImage), { timeout: 10_000 }).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#file-preview')).toHaveCount(0, { timeout: 10_000 });

    const agentMessage = page.locator('#messages .msg[data-sender-kind="agent"]').filter({
      hasText: agentMarker,
    });
    await agentMessage.scrollIntoViewIfNeeded();
    await expect(agentMessage.locator('.msg-file-name')).toHaveText('Agent图片.png', {
      timeout: 10_000,
    });
    const agentThumb = agentMessage.locator('.msg-file-thumb img');
    await expect(agentThumb).toBeVisible();
    await expect.poll(() => naturalWidth(agentThumb), { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('handles literal escaped newlines and rejects suffixed links', async ({ page }) => {
    const file = await seedRoomFile(base, humanToken, directRoomId, {
      name: '转义图片.png',
      mimeType: 'image/png',
      body: PIXEL_PNG,
    });
    const escapedMarker = `FILE-ESCAPED-${crypto.randomUUID().slice(0, 8)}`;
    // 正文中的字面量反斜杠 + n 应被提取器当作换行，不污染 Markdown 标签。
    await sendFileMessage(
      base,
      humanToken,
      directRoomId,
      `${escapedMarker}\\n[转义图片.png](${file.publicUrl})`,
    );
    const invalidMarker = `FILE-SUFFIX-${crypto.randomUUID().slice(0, 8)}`;
    await sendFileMessage(
      base,
      humanToken,
      directRoomId,
      `${invalidMarker}\n[坏后缀.png](${file.publicUrl}.png)`,
    );

    await page.goto(`${base}/c/${directRoomId}`);
    const escapedMessage = page.locator('#messages .msg').filter({ hasText: escapedMarker });
    await escapedMessage.scrollIntoViewIfNeeded();
    const thumb = escapedMessage.locator('.msg-file-thumb img');
    await expect(thumb).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => naturalWidth(thumb), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(escapedMessage.locator('.msg-file-name')).toHaveText('转义图片.png');
    const invalidMessage = page.locator('#messages .msg').filter({ hasText: invalidMarker });
    await expect(invalidMessage.locator('.msg-file')).toHaveCount(0);
  });

  test('loads private image thumbnails only through ticketed URLs', async ({ page }) => {
    const file = await seedRoomFile(base, humanToken, directRoomId, {
      name: '私有图片.png',
      mimeType: 'image/png',
      body: PIXEL_PNG,
    });
    await publishRoomFile(base, humanToken, directRoomId, file.fileId, false);
    const marker = `FILE-PRIVATE-${crypto.randomUUID().slice(0, 8)}`;
    await sendFileMessage(
      base,
      humanToken,
      directRoomId,
      `${marker}\n[私有图片.png](${file.publicUrl})`,
    );

    const bare = await fetch(file.publicUrl);
    expect(bare.status).toBe(404);
    const meta = await callTool<{ file: { preview_url: string; download_url: string } }>(
      base,
      humanToken,
      'network_room_file_get',
      { room_id: directRoomId, file_id: file.fileId },
    );
    expect(meta.file.preview_url).toContain('t=');
    expect(meta.file.download_url).toContain('t=');
    const ticketed = await fetch(meta.file.preview_url);
    expect(ticketed.status).toBe(200);

    await page.goto(`${base}/c/${directRoomId}`);
    const message = page.locator('#messages .msg').filter({ hasText: marker });
    await message.scrollIntoViewIfNeeded();
    const thumb = message.locator('.msg-file-thumb img');
    await expect(thumb).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => naturalWidth(thumb), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await thumb.getAttribute('src')).toContain('t=');
  });

  test('re-signs an expired ticket before opening the preview', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-11-13T12:00:00Z'));
    const file = await seedRoomFile(base, humanToken, directRoomId, {
      name: '过期票据.txt',
      mimeType: 'text/plain',
      body: Buffer.from('expired ticket preview'),
    });
    const marker = `FILE-EXPIRED-${crypto.randomUUID().slice(0, 8)}`;
    await sendFileMessage(
      base,
      humanToken,
      directRoomId,
      `${marker}\n[过期票据.txt](${file.publicUrl})`,
    );

    await page.goto(`${base}/c/${directRoomId}`);
    const message = page.locator('#messages .msg').filter({ hasText: marker });
    await message.scrollIntoViewIfNeeded();
    const download = message.locator('.msg-file-download');
    await expect(download).toBeVisible({ timeout: 10_000 });
    const initialHref = await download.getAttribute('href');
    expect(initialHref).toMatch(/\/f\/f_[A-Za-z0-9_-]{22}\?download=1&t=/u);

    // 关闭缓存 TTL 后点击预览：卡片必须先重签，再把新票据交给弹窗。
    await page.clock.setFixedTime(new Date('2026-11-13T13:00:00Z'));
    await message.locator('.msg-file-preview').click();
    await expect(page.locator('#file-preview')).toBeVisible({ timeout: 10_000 });
    const freshDownload = page.locator('#file-preview-download');
    await expect(freshDownload).toBeVisible();
    const freshHref = await freshDownload.getAttribute('href');
    expect(freshHref).toMatch(/\/f\/f_[A-Za-z0-9_-]{22}\?download=1&t=/u);
    expect(freshHref).not.toBe(initialHref);
    const ticketOf = (href: string | null): string | null =>
      href ? new URL(href, base).searchParams.get('t') : null;
    expect(ticketOf(freshHref)).not.toBe(ticketOf(initialHref));
    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview')).toHaveCount(0);
  });

  test('separates image MIME variants, non-images and active content', async ({ page }) => {
    const marker = `FILE-TYPES-${crypto.randomUUID().slice(0, 8)}`;
    const pdf = await seedRoomFile(base, humanToken, directRoomId, {
      name: '报告.pdf',
      mimeType: 'application/pdf',
      body: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'),
    });
    const txt = await seedRoomFile(base, humanToken, directRoomId, {
      name: '说明.txt',
      mimeType: 'text/plain',
      body: Buffer.from('file card text'),
    });
    const zip = await seedRoomFile(base, humanToken, directRoomId, {
      name: '归档.zip',
      mimeType: 'application/zip',
      body: Buffer.from('PK\x03\x04'),
    });
    const svg = await seedRoomFile(base, humanToken, directRoomId, {
      name: '伪装.svg',
      mimeType: 'image/svg+xml',
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
    });
    const html = await seedRoomFile(base, humanToken, directRoomId, {
      name: '伪装.html',
      mimeType: 'text/html',
      body: Buffer.from('<html><body>unsafe</body></html>'),
    });
    const jpg = await seedRoomFile(base, humanToken, directRoomId, {
      name: '兼容图片.jpg',
      mimeType: 'image/jpg',
      body: PIXEL_JPEG,
    });
    const octet = await seedRoomFile(base, humanToken, directRoomId, {
      name: '八位流图片.png',
      mimeType: 'application/octet-stream',
      body: PIXEL_PNG,
    });
    await sendFileMessage(
      base,
      humanToken,
      directRoomId,
      [
        marker,
        `[报告.pdf](${pdf.publicUrl})`,
        `[说明.txt](${txt.publicUrl})`,
        `[归档.zip](${zip.publicUrl})`,
        `[伪装.svg](${svg.publicUrl})`,
        `[伪装.html](${html.publicUrl})`,
        `[兼容图片.jpg](${jpg.publicUrl})`,
        `[八位流图片.png](${octet.publicUrl})`,
      ].join('\n'),
    );
    const externalMarker = `FILE-EXTERNAL-${crypto.randomUUID().slice(0, 8)}`;
    await sendFileMessage(
      base,
      humanToken,
      directRoomId,
      `${externalMarker}\nhttps://external.example/f/f_${'C'.repeat(22)}`,
    );

    await page.goto(`${base}/c/${directRoomId}`);
    const message = page.locator('#messages .msg').filter({ hasText: marker });
    await message.scrollIntoViewIfNeeded();
    await expect(message.locator('.msg-file')).toHaveCount(7, { timeout: 15_000 });

    for (const spec of [
      { name: '报告.pdf', card: 'pdf' },
      { name: '说明.txt', card: 'txt' },
      { name: '归档.zip', card: 'zip' },
    ]) {
      const card = message.locator('.msg-file').filter({ hasText: spec.name });
      await expect(card.locator('.msg-file-name')).toHaveText(spec.name);
      await expect(card.locator('.msg-file-thumb img')).toHaveCount(0);
      await expect(card.locator('.msg-file-download')).toHaveAttribute(
        'href',
        /\/f\/f_[A-Za-z0-9_-]{22}\?download=1&t=/u,
      );
    }
    for (const spec of [
      { name: '伪装.svg', fileId: svg.fileId },
      { name: '伪装.html', fileId: html.fileId },
    ]) {
      const card = message.locator('.msg-file').filter({ hasText: spec.name });
      await expect(card).toBeVisible();
      expect(await card.locator('img, iframe, video, audio, pre, object, embed').count()).toBe(0);
      await expect(card.locator('.msg-file-preview')).toHaveCount(0);
    }
    for (const spec of [
      { name: '兼容图片.jpg', fileId: jpg.fileId },
      { name: '八位流图片.png', fileId: octet.fileId },
    ]) {
      const card = message.locator(`.msg-file[data-file-id="${spec.fileId}"]`);
      const thumb = card.locator('.msg-file-thumb img');
      await expect(thumb).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => naturalWidth(thumb), { timeout: 10_000 }).toBeGreaterThan(0);
      await expect(card.locator('.msg-file-name')).toHaveText(spec.name);
    }
    const external = page.locator('#messages .msg').filter({ hasText: externalMarker });
    await expect(external.locator('.msg-file')).toHaveCount(0);
  });

  test('removes a broken thumbnail, keeps the card and retries', async ({ page }) => {
    const file = await seedRoomFile(base, humanToken, directRoomId, {
      name: '坏图.png',
      mimeType: 'image/png',
      body: PIXEL_PNG,
    });
    const marker = `FILE-BROKEN-${crypto.randomUUID().slice(0, 8)}`;
    await sendFileMessage(
      base,
      humanToken,
      directRoomId,
      `${marker}\n[坏图.png](${file.publicUrl})`,
    );
    const pattern = `**/f/${file.fileId}*`;
    await page.route(pattern, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 404, body: 'missing' });
        return;
      }
      await route.continue();
    });

    await page.goto(`${base}/c/${directRoomId}`);
    const message = page.locator('#messages .msg').filter({ hasText: marker });
    const card = message.locator('.msg-file');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('.msg-file-name')).toHaveText('坏图.png', { timeout: 10_000 });
    await expect(card.locator('.msg-file-thumb')).toHaveCount(0, { timeout: 15_000 });
    await expect(card.locator('.msg-file-retry')).toBeVisible();

    await page.unroute(pattern);
    await card.locator('.msg-file-retry').click();
    const thumb = card.locator('.msg-file-thumb img');
    await expect(thumb).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => naturalWidth(thumb), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(card.locator('.msg-file-retry')).toHaveCount(0);
  });

  test('supports group history, realtime cards and composer chip thumbnails', async ({ page }) => {
    const historyFile = await seedRoomFile(base, humanToken, groupRoomId, {
      name: '群历史图片.png',
      mimeType: 'image/png',
      body: PIXEL_PNG,
    });
    const historyMarker = `FILE-GROUP-HISTORY-${crypto.randomUUID().slice(0, 8)}`;
    await sendFileMessage(
      base,
      humanToken,
      groupRoomId,
      `${historyMarker}\n[群历史图片.png](${historyFile.publicUrl})`,
    );

    await page.goto(`${base}/c/${groupRoomId}`);
    const historyMessage = page.locator('#messages .msg').filter({ hasText: historyMarker });
    await historyMessage.scrollIntoViewIfNeeded();
    const historyThumb = historyMessage.locator('.msg-file-thumb img');
    await expect(historyThumb).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => naturalWidth(historyThumb), { timeout: 10_000 }).toBeGreaterThan(0);

    const liveFile = await seedRoomFile(base, humanToken, groupRoomId, {
      name: '群实时图片.png',
      mimeType: 'image/png',
      body: PIXEL_PNG,
    });
    const liveMarker = `FILE-GROUP-LIVE-${crypto.randomUUID().slice(0, 8)}`;
    // sender 不收到自己的 room.message；实时分支必须由另一成员发送。
    await sendFileMessage(
      base,
      agentToken,
      groupRoomId,
      `${liveMarker}\n[群实时图片.png](${liveFile.publicUrl})`,
    );
    const liveMessage = page.locator('#messages .msg').filter({ hasText: liveMarker });
    const liveThumb = liveMessage.locator('.msg-file-thumb img');
    await expect(liveThumb).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => naturalWidth(liveThumb), { timeout: 10_000 }).toBeGreaterThan(0);

    await page.locator('#composer-file-input').setInputFiles({
      name: 'chip.png',
      mimeType: 'image/png',
      buffer: PIXEL_PNG,
    });
    const chip = page.locator('#composer-files .composer-file').last();
    await expect(chip.locator('.composer-file-name')).toHaveText('chip.png');
    await expect(chip.locator('.composer-file-meta')).not.toContainText('上传中', {
      timeout: 15_000,
    });
    const chipThumb = chip.locator('.composer-file-thumb img');
    await expect(chipThumb).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => naturalWidth(chipThumb), { timeout: 10_000 }).toBeGreaterThan(0);
  });
});
