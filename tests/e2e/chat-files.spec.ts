import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { filePreviewKind, isHtmlPreview } from '../../src/web/lib/files-ui';

test('HTML preview requires an explicit MIME and preserves other classifications', () => {
  expect(isHtmlPreview({ file_id: 'html', mime_type: ' Text/HTML; charset=utf-8 ' })).toBe(true);
  expect(filePreviewKind({ file_id: 'html', mime_type: 'text/html', preview_kind: 'other' })).toBe('html');
  for (const mime_type of [undefined, '', 'application/octet-stream', 'text/plain']) {
    expect(isHtmlPreview({ file_id: 'html', name: 'page.html', mime_type })).toBe(false);
    expect(filePreviewKind({ file_id: 'html', name: 'page.html', mime_type, preview_kind: 'html' })).not.toBe('html');
  }
  expect(filePreviewKind({ file_id: 'svg', mime_type: 'image/svg+xml' })).toBe('other');
  expect(filePreviewKind({ file_id: 'md', name: 'note.md', mime_type: 'text/plain' })).toBe('markdown');
  expect(filePreviewKind({ file_id: 'png', name: 'photo.png', mime_type: 'application/octet-stream' })).toBe('image');
  expect(filePreviewKind({ file_id: 'pdf', mime_type: 'application/pdf' })).toBe('pdf');
});

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

  test('re-signs an expired ticket and downloads without surfacing an error', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-11-13T12:00:00Z'));
    const file = await seedRoomFile(base, humanToken, directRoomId, {
      name: '过期下载.txt',
      mimeType: 'text/plain',
      body: Buffer.from('expired ticket download'),
    });
    const marker = `FILE-EXPIRED-DL-${crypto.randomUUID().slice(0, 8)}`;
    await sendFileMessage(
      base,
      humanToken,
      directRoomId,
      `${marker}\n[过期下载.txt](${file.publicUrl})`,
    );

    await page.goto(`${base}/c/${directRoomId}`);
    const message = page.locator('#messages .msg').filter({ hasText: marker });
    await message.scrollIntoViewIfNeeded();
    const download = message.locator('.msg-file-download');
    await expect(download).toBeVisible({ timeout: 10_000 });
    const initialHref = await download.getAttribute('href');
    expect(initialHref).toMatch(/\/f\/f_[A-Za-z0-9_-]{22}\?download=1&t=/u);

    // 关闭缓存 TTL 后点击下载：卡片先重签，再把新票据交给下载触发。
    await page.clock.setFixedTime(new Date('2026-11-13T13:00:00Z'));
    const [saved] = await Promise.all([
      page.waitForEvent('download'),
      download.click(),
    ]);
    expect(saved.suggestedFilename()).toBe('过期下载.txt');
    const savedUrl = new URL(saved.url());
    expect(savedUrl.origin).toBe(new URL(base).origin);
    expect(savedUrl.pathname).toMatch(/^\/f\/f_[A-Za-z0-9_-]{22}$/u);
    expect(savedUrl.searchParams.get('download')).toBe('1');
    expect(savedUrl.searchParams.get('t')).toBeTruthy();
    expect(savedUrl.searchParams.get('t')).not.toBe(new URL(initialHref!).searchParams.get('t'));
    await expect(message.locator('.msg-file-note[role="alert"]')).toHaveCount(0);
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
    const svgCard = message.locator(`.msg-file[data-file-id="${svg.fileId}"]`);
    await expect(svgCard).toBeVisible();
    await expect(svgCard.locator('img, iframe, video, audio, pre, object, embed')).toHaveCount(0);
    await expect(svgCard.locator('.msg-file-preview')).toHaveCount(0);

    const htmlCard = message.locator(`.msg-file[data-file-id="${html.fileId}"]`);
    await expect(htmlCard.locator('.msg-file-preview')).toBeVisible();
    await expect(htmlCard.locator('img, iframe')).toHaveCount(0);
    await htmlCard.locator('.msg-file-preview').click();
    await expect(page.locator('#file-preview-body iframe[sandbox=""]')).toHaveAttribute(
      'srcdoc', /<html><body>unsafe<\/body><\/html>/u,
    );
    await page.locator('#file-preview-close').click();
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

  for (const mobileDark of [false, true]) {
    test(`HTML sandbox blocks scripts and requests, toggles source and restores focus (${mobileDark ? '390 dark' : 'desktop'})`, async ({ page }) => {
      await page.setViewportSize(mobileDark ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme: mobileDark ? 'dark' : 'light' });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const html = [
        '<!doctype html><html><head><style>',
        'body { margin: 0; background: rgb(12, 34, 56); color: white; }',
        'main { min-height: 2400px; background-image: url("/mcp?html-preview-css"); }',
        '</style></head><body><main>安全 HTML 预览</main>',
        '<script>parent.__xss=1; fetch("/mcp?html-preview-script");</script>',
        '<img src="/mcp?html-preview-img" onerror="parent.__xss=2">',
        '<iframe src="/mcp?html-preview-frame"></iframe>',
        '</body></html>',
      ].join('');
      const file = await seedRoomFile(base, humanToken, directRoomId, {
        name: `sandbox-${mobileDark}.html`, mimeType: 'text/html', body: Buffer.from(html),
      });
      await sendFileMessage(base, humanToken, directRoomId, `[HTML sandbox](${file.publicUrl})`);
      await page.goto(`${base}/c/${directRoomId}`);
      const card = page.locator(`.msg-file[data-file-id="${file.fileId}"]`);
      await card.scrollIntoViewIfNeeded();
      const opener = card.locator('.msg-file-preview');
      await expect(opener).toBeVisible();
      const childRequests: string[] = [];
      // request 事件也会报告被 CSP 阻止的资源；route 只记录实际进入网络层的访问。
      await page.route('**/mcp?html-preview-*', async (route) => {
        childRequests.push(route.request().url());
        await route.abort();
      });
      const reads: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === `/f/${file.fileId}`) reads.push(request.headers()['range'] ?? '');
      });
      await opener.click();
      if (mobileDark) {
        await expect(page.locator('#file-preview[role="dialog"]')).toBeVisible();
        await expect(page.locator('#file-preview-pane')).toHaveCount(0);
      } else {
        await expect(page.locator('#files-pane #file-preview-pane')).toBeVisible();
        await expect(page.locator('#file-preview, #file-preview-dialog, [role="dialog"]')).toHaveCount(0);
      }
      const iframe = page.locator('#file-preview-body iframe');
      await expect(iframe).toHaveAttribute('sandbox', '');
      await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
      await expect(iframe).toHaveAttribute('title', `sandbox-${mobileDark}.html`);
      await expect(iframe).toHaveAttribute('srcdoc', new RegExp('parent.__xss=1'));
      await expect(iframe).not.toHaveAttribute('src');
      const frame = page.frameLocator('#file-preview-body iframe');
      await expect(frame.locator('main')).toHaveText('安全 HTML 预览');
      await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(12, 34, 56)');
      await frame.locator('body').evaluate(() => window.scrollTo(0, 400));
      await expect.poll(() => frame.locator('body').evaluate(() => window.scrollY)).toBeGreaterThan(0);
      expect(await page.evaluate(() => Reflect.get(window, '__xss'))).toBeUndefined();
      expect(await iframe.evaluate((node) => (node as HTMLIFrameElement).contentDocument)).toBeNull();
      const geometry = await iframe.boundingBox();
      expect(geometry!.width).toBeLessThanOrEqual(mobileDark ? 390 : 900);
      expect(geometry!.height).toBeGreaterThan(400);
      await expect(page.locator('#file-preview-close')).toBeVisible();
      await expect(page.locator('#file-preview-download')).toBeVisible();
      await page.getByRole('button', { name: '查看原文', exact: true }).click();
      await expect(iframe).toHaveCount(0);
      await expect(page.locator('#file-preview-body > pre')).toHaveText(html);
      await page.getByRole('button', { name: '渲染', exact: true }).click();
      await expect(frame.locator('main')).toHaveText('安全 HTML 预览');
      expect(childRequests).toEqual([]);
      expect(reads).toEqual(['bytes=0-262143']);
      expect(errors).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.locator('#file-preview, #file-preview-pane')).toHaveCount(0);
      await expect(opener).toBeFocused();
      await opener.click();
      await expect(frame.locator('main')).toHaveText('安全 HTML 预览');
      await page.locator('#file-preview-close').click();
      await expect(opener).toBeFocused();
    });
  }

  for (const width of [1280, 390]) {
    test(`Agent HTML/MD use the right pane or modal at ${width}, reusing metadata`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: 'dark' });
      for (const kind of ['html', 'md']) {
        const file = await seedRoomFile(base, agentToken, directRoomId, {
          name: `agent-preview.${kind}`,
          mimeType: kind === 'html' ? 'text/html' : 'text/markdown',
          body: Buffer.from(kind === 'html' ? '<h1>Agent 文档</h1>' : '# Agent 文档\n\n' + '长内容 '.repeat(2000)),
        });
        await sendFileMessage(base, agentToken, directRoomId, `[Agent 文档](${file.publicUrl})`);
        await page.goto(`${base}/c/${directRoomId}`);
        const card = page.locator(`.msg-file[data-file-id="${file.fileId}"]`);
        await card.scrollIntoViewIfNeeded();
        await expect(card.locator('.msg-file-preview')).toBeVisible();
        const metaReads: string[] = [];
        const trackMeta = (request: import('@playwright/test').Request) => {
          if (request.headers()['mcp-name'] === 'network_room_file_get' &&
            request.postDataJSON()?.params?.arguments?.file_id === file.fileId) metaReads.push(request.url());
        };
        page.on('request', trackMeta);
        if (width === 1280 && await page.locator('#files-pane').isVisible()) await page.locator('#files-close').click();
        await card.locator('.msg-file-preview').click();
        const expectRendered = async () => {
          if (kind === 'html') await expect(page.frameLocator('#file-preview-body iframe').locator('h1')).toHaveText('Agent 文档');
          else await expect(page.locator('#file-preview-body h1')).toHaveText('Agent 文档');
          if (width === 1280) {
            await expect(page.locator('#files-pane #file-preview-pane')).toBeVisible();
            await expect(page.locator('#file-preview, #file-preview-dialog, [role="dialog"]')).toHaveCount(0);
          } else {
            await expect(page.locator('#file-preview[role="dialog"]')).toBeVisible();
            await expect(page.locator('#file-preview-pane')).toHaveCount(0);
            await expect(page.locator('.sidebar')).toBeHidden();
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
          expect(await page.locator('#file-preview-body').evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
        };
        await expectRendered();
        await page.screenshot({ path: test.info().outputPath(`agent-${kind}-${width}.png`) });
        await page.locator('#file-preview-close').click();
        if (width === 390) await page.locator('#files-toggle').click();
        const row = page.locator(`#files-list .file-item[data-file-id="${file.fileId}"]`);
        const preview = row.getByRole('button', { name: `预览 agent-preview.${kind}`, exact: true });
        await expect(preview).toHaveJSProperty('tagName', 'BUTTON');
        if (width === 1280) await preview.press(kind === 'html' ? 'Enter' : 'Space');
        else await preview.click();
        await expectRendered();
        await expect(page.locator('#file-preview-download')).toHaveAttribute('download', `agent-preview.${kind}`);
        await page.locator('#file-preview-close').click();
        await expect(page.locator('#files-list')).toBeVisible();
        expect(metaReads).toEqual([]);
        page.off('request', trackMeta);
        if (width === 390) await page.locator('#files-close').click();
      }
    });
  }

  test('hiding files clears the inline preview and never leaks it into the modal', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const file = await seedRoomFile(base, humanToken, directRoomId, {
      name: `toggle-preview-${Date.now()}.md`,
      mimeType: 'text/markdown',
      body: Buffer.from('# 切换预览\n\n预览正文'),
    });
    await page.goto(`${base}/c/${directRoomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();
    const item = page.locator(`#files-list .file-item[data-file-id="${file.fileId}"]`);
    await expect(item).toBeVisible({ timeout: 15_000 });
    const openPreview = async () => {
      await item.locator('.file-row').click();
      await expect(page.locator('#files-pane #file-preview-pane')).toBeVisible();
    };

    // 文件 toggle 关闭再打开：必须回到列表，不保留内联预览。
    await openPreview();
    await page.locator('#files-toggle').click();
    await expect(page.locator('#file-preview-pane')).toHaveCount(0);
    await page.locator('#files-toggle').click();
    await expect(page.locator('#files-list')).toBeVisible();
    await expect(page.locator('#file-preview-pane')).toHaveCount(0);

    // 隐藏文件栏后缩窄到 390：残留预览不得弹出 modal。
    await openPreview();
    await page.locator('#files-toggle').click();
    await page.setViewportSize({ width: 390, height: 844 });
    // 先等移动布局生效，避免 dialog 尚未挂载时 0 计数误判。
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await expect(page.locator('#file-preview[role="dialog"]')).toHaveCount(0);

    // 监控 toggle 关闭文件栏同样清除预览。
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('#files-toggle').click();
    await expect(item).toBeVisible();
    await openPreview();
    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toBeVisible();
    await expect(page.locator('#file-preview-pane')).toHaveCount(0);
    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toHaveCount(0);
    await page.locator('#files-toggle').click();
    await expect(page.locator('#files-list')).toBeVisible();
    await expect(page.locator('#file-preview-pane')).toHaveCount(0);
  });

  test('narrowing hands an open pane preview to the modal', async ({ page }) => {
    const stamp = Date.now();
    const docs = [];
    for (const doc of [
      {
        name: `narrow-preview-${stamp}.md`,
        mimeType: 'text/markdown',
        body: Buffer.from('# 缩窄预览\n\n保留正文'),
      },
      {
        name: `narrow-preview-${stamp}.html`,
        mimeType: 'text/html',
        body: Buffer.from('<h1>缩窄预览</h1>'),
      },
    ]) {
      docs.push({ ...doc, file: await seedRoomFile(base, humanToken, directRoomId, doc) });
    }

    for (const width of [900, 390]) {
      for (const doc of docs) {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(`${base}/c/${directRoomId}`);
        await expect(page.locator('#files-pane')).toBeVisible();
        const item = page.locator(`#files-list .file-item[data-file-id="${doc.file.fileId}"]`);
        await expect(item).toBeVisible({ timeout: 15_000 });
        await item.locator('.file-row').click();
        await expect(page.locator('#files-pane #file-preview-pane')).toBeVisible();

        // Files 仍处于打开意图，断点只改变承载方式：预览必须移交弹窗。
        await page.setViewportSize({ width, height: 844 });
        if (width === 390) {
          // 先等移动布局生效，再断言 dialog，避免即时空转。
          await expect(page.locator('.sidebar')).toHaveCount(0);
        } else {
          await expect(page.locator('#files-pane')).toHaveCount(0);
        }
        const dialog = page.locator('#file-preview[role="dialog"]');
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('#file-preview-title')).toHaveText(doc.name);
        await expect(page.locator('#file-preview-pane')).toHaveCount(0);
        if (doc.mimeType === 'text/html') {
          await expect(page.frameLocator('#file-preview-body iframe').locator('h1')).toHaveText('缩窄预览');
        } else {
          await expect(page.locator('#file-preview-body h1')).toHaveText('缩窄预览');
        }

        // 关闭 modal 后回到聊天；重开 Files 是列表，不会重新弹出预览。
        await page.locator('#file-preview-close').click();
        await expect(page.locator('#file-preview')).toHaveCount(0);
        await page.locator('#files-toggle').click();
        await expect(page.locator('#files-list')).toBeVisible();
        await expect(page.locator('#file-preview-pane')).toHaveCount(0);
      }
    }
  });

  test('HTML preview truncates at the existing 256 KB Range limit', async ({ page }) => {
    const html = '<h1>截断预览</h1>' + '<p>预览正文</p>\n'.repeat(30_000) + 'HTML-END-SENTINEL';
    const file = await seedRoomFile(base, humanToken, directRoomId, {
      name: 'large.html', mimeType: 'text/html', body: Buffer.from(html),
    });
    await sendFileMessage(base, humanToken, directRoomId, `[截断 HTML](${file.publicUrl})`);
    await page.goto(`${base}/c/${directRoomId}`);
    const card = page.locator(`.msg-file[data-file-id="${file.fileId}"]`);
    await card.scrollIntoViewIfNeeded();
    await card.locator('.msg-file-preview').click();
    await expect(page.locator('#file-preview-body')).toContainText('预览已截断，仅显示前 256 KB');
    await expect(page.frameLocator('#file-preview-body iframe').locator('h1')).toHaveText('截断预览');
    await page.getByRole('button', { name: '查看原文', exact: true }).click();
    const source = page.locator('#file-preview-body > pre');
    await expect(source).not.toContainText('HTML-END-SENTINEL');
    const rendered = await source.textContent();
    expect(rendered).toBe(Buffer.from(html).subarray(0, 262_144).toString('utf8'));
    await page.locator('#file-preview-close').click();

    // 兼容忽略 Range 的文件响应：仍按字节截断，而非按 Unicode 字符数。
    await page.route(`**/f/${file.fileId}*`, (route) => route.fulfill({
      status: 200, contentType: 'text/html', body: html,
    }));
    await card.locator('.msg-file-preview').click();
    await expect(page.locator('#file-preview-body')).toContainText('预览已截断，仅显示前 256 KB');
    await page.getByRole('button', { name: '查看原文', exact: true }).click();
    await expect(source).toHaveText(Buffer.from(html).subarray(0, 262_144).toString('utf8'));
    await page.locator('#file-preview-close').click();
  });

  test('HTML read failures never create a preview frame', async ({ page }) => {
    const file = await seedRoomFile(base, humanToken, directRoomId, {
      name: 'unavailable.html', mimeType: 'text/html', body: Buffer.from('<h1>HTML</h1>'),
    });
    await sendFileMessage(base, humanToken, directRoomId, `[读取失败](${file.publicUrl})`);
    await page.goto(`${base}/c/${directRoomId}`);
    const card = page.locator(`.msg-file[data-file-id="${file.fileId}"]`);
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('.msg-file-preview')).toBeVisible();
    await page.route(`**/f/${file.fileId}*`, (route) => route.fulfill({ status: 404, body: 'missing' }));
    await card.locator('.msg-file-preview').click();
    await expect(page.locator('#file-preview-body')).toContainText('读取文本预览失败：HTTP 404');
    await expect(page.locator('#file-preview-body iframe')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看原文', exact: true })).toHaveCount(0);
    await expect(page.locator('#file-preview-download')).toBeVisible();
    await page.locator('#file-preview-close').click();
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

  test('filters room files by name and kind without reading contents', async ({ page }) => {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const imageName = `搜索图片-${suffix}.png`;
    const documentName = `搜索报告-${suffix}.pdf`;
    const textName = `搜索笔记-${suffix}.txt`;
    await seedRoomFile(base, humanToken, directRoomId, {
      name: imageName,
      mimeType: 'image/png',
      body: PIXEL_PNG,
    });
    await seedRoomFile(base, humanToken, directRoomId, {
      name: documentName,
      mimeType: 'application/pdf',
      body: Buffer.from('%PDF-1.4\n搜索文件\n'),
    });
    await seedRoomFile(base, humanToken, directRoomId, {
      name: textName,
      mimeType: 'text/plain',
      body: Buffer.from('文件筛选测试\n'),
    });

    await page.goto(`${base}/c/${directRoomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    const toggle = page.locator('#files-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    const pane = page.locator('#files-pane');
    await expect(pane).toBeVisible();

    const list = page.locator('#files-list');
    await expect(list).toContainText(imageName);

    // 文件名子串（大小写不敏感）：只保留 PDF，不误伤同批图片/文本。
    await page.locator('#files-search-input').fill('搜索报告');
    await expect(list).toContainText(documentName);
    await expect(list).not.toContainText(imageName);
    await expect(list).not.toContainText(textName);

    // 清空查询后按类型筛选；图片与文档互斥，文本归入文档。
    await page.locator('#files-search-input').fill('');
    await pane.getByRole('radio', { name: '图片' }).click();
    await expect(list).toContainText(imageName);
    await expect(list).not.toContainText(documentName);
    await expect(list).not.toContainText(textName);

    await pane.getByRole('radio', { name: '文档' }).click();
    await expect(list).toContainText(documentName);
    await expect(list).toContainText(textName);
    await expect(list).not.toContainText(imageName);

    // 组合条件为空结果时给出筛选空态，而不是“房间还没有文件”。
    await page.locator('#files-search-input').fill('不存在的文件');
    await expect(list).not.toContainText(documentName);
    await expect(page.locator('#files-empty')).toContainText('没有匹配的文件');
  });
});
