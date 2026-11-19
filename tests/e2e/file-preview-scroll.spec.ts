import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 文件预览弹窗滚动：消息文件卡与右栏/移动端文件面板共用
 * `FilePreviewDialog`。正文区必须是唯一滚动容器，头部与底部固定；
 * 长 Markdown、查看原文与纯文本都依赖这一约束，图片/PDF 保持适配居中。
 */

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
}

interface RoomDetail {
  room: { room_id: string };
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

interface UploadedFile {
  fileId: string;
  publicUrl: string;
}

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const MINIMAL_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
    '',
  ].join('\n'),
);

async function login(page: Page, base: string, token: string): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('agent-network-token', value);
      localStorage.removeItem('agent-network-logged-out');
    } catch {
      // 存储被禁用时由页面错误态兜底。
    }
  }, token);
  await page.goto(base);
}

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
  if (response.status !== 201) throw new Error(`上传 ${name} 失败：HTTP ${response.status}`);
  return (await response.json()) as UploadedFile;
}

async function sendFileMessage(
  base: string,
  token: string,
  roomId: string,
  body: string,
): Promise<void> {
  await callTool(base, token, 'network_message_send', {
    request_id: requestId('e2e_preview_send'),
    client_message_id: requestId('e2e_preview_cm'),
    room_id: roomId,
    body,
    invoke: [],
  });
}

/** 超过一屏的 Markdown：标题、段落与代码块一起撑高正文。 */
function longMarkdown(title: string): string {
  return [
    `# ${title}`,
    '',
    ...Array.from(
      { length: 120 },
      (_, index) =>
        `## 第 ${index + 1} 节\n\n这是第 ${index + 1} 节正文，用于撑高预览内容并验证正文区滚动。\n`,
    ),
    '```ts',
    ...Array.from({ length: 80 }, (_, index) => `const row${index} = ${index};`),
    '```',
    '',
  ].join('\n');
}

interface PreviewGeometry {
  scrollHeight: number;
  clientHeight: number;
  overflowY: string;
  overscrollBehaviorY: string;
  headBottom: number;
  bodyTop: number;
  bodyBottom: number;
  footTop: number;
  footBottom: number;
  cardBottom: number;
  viewportHeight: number;
}

async function previewGeometry(page: Page): Promise<PreviewGeometry> {
  return page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('#file-preview-body');
    const head = document.querySelector<HTMLElement>('.file-preview-head');
    const foot = document.querySelector<HTMLElement>('.file-preview-foot');
    const card = document.querySelector<HTMLElement>('.file-preview-card');
    if (!body || !head || !foot || !card) throw new Error('文件预览结构缺失');
    const style = getComputedStyle(body);
    const headRect = head.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const footRect = foot.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      overflowY: style.overflowY,
      overscrollBehaviorY: style.overscrollBehaviorY,
      headBottom: headRect.bottom,
      bodyTop: bodyRect.top,
      bodyBottom: bodyRect.bottom,
      footTop: footRect.top,
      footBottom: footRect.bottom,
      cardBottom: cardRect.bottom,
      viewportHeight: window.innerHeight,
    };
  });
}

/** 正文区必须独立滚动，且头部/底部固定在卡片内不随内容移动。 */
async function expectPreviewBodyScrolls(page: Page): Promise<void> {
  const body = page.locator('#file-preview-body');
  const geometry = await previewGeometry(page);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight + 100);
  expect(geometry.overflowY).toBe('auto');
  expect(geometry.overscrollBehaviorY).toBe('contain');
  expect(geometry.headBottom).toBeLessThanOrEqual(geometry.bodyTop + 1);
  expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.footTop + 1);
  expect(geometry.footBottom).toBeLessThanOrEqual(geometry.cardBottom + 1);
  expect(geometry.cardBottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);

  await body.evaluate((element) => {
    element.scrollTop = 320;
  });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator('#file-preview-title')).toBeVisible();
  await expect(page.locator('#file-preview-close')).toBeVisible();
  await expect(page.locator('#file-preview-download')).toBeVisible();
}

test.describe('file preview scroll', () => {
  let base = '';
  let humanToken = '';
  let roomId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    humanToken = crypto.randomUUID();
    const agentToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
    const human = await callTool<Registered>(base, humanToken, 'network_register', {
      request_id: requestId('e2e_preview_reg'),
      kind: 'human',
      name: `预览滚动人类 ${suffix}`,
      device_id: `e2e-preview-${suffix}`,
    });
    const agent = await callTool<Registered>(base, agentToken, 'network_register', {
      request_id: requestId('e2e_preview_reg'),
      kind: 'agent',
      name: `预览滚动 Agent ${suffix}`,
      agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const contact = await callTool<ContactRequestResult>(
      base,
      humanToken,
      'network_contact_request',
      {
        request_id: requestId('e2e_preview_contact'),
        actor_id: agent.actor_id,
      },
    );
    const contactRequestId = contact.request?.contact_request_id;
    if (!contactRequestId) throw new Error('预览滚动测试好友申请未创建');
    await callTool(base, agentToken, 'network_contact_request_respond', {
      request_id: requestId('e2e_preview_contact'),
      contact_request_id: contactRequestId,
      action: 'accept',
    });
    const direct = await callTool<RoomDetail>(base, humanToken, 'network_room_create', {
      request_id: requestId('e2e_preview_room'),
      kind: 'direct',
      members: [agent.actor_id],
    });
    roomId = direct.room.room_id;
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 存储被禁用时由页面错误态兜底。
      }
    }, humanToken);
  });

  test('files pane keeps long markdown and source views scrollable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, base, humanToken);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();

    const fileName = `long-scroll-${Date.now()}.md`;
    await page.locator('#files-input').setInputFiles({
      name: fileName,
      mimeType: 'text/markdown',
      buffer: Buffer.from(longMarkdown('长文档滚动')),
    });
    const item = page.locator('#files-list .file-item').filter({ hasText: fileName });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByRole('button', { name: '预览', exact: true }).click();

    const viewer = page.locator('#file-preview-body .file-preview-md-viewer');
    await expect(viewer.locator('h1')).toHaveText('长文档滚动', { timeout: 15_000 });
    await expect(viewer).toContainText('第 120 节', { timeout: 15_000 });
    await expectPreviewBodyScrolls(page);

    // 「查看原文」由同一正文区承接滚动，不再嵌套受 max-height 限制的 pre。
    const toggle = page.locator('#file-preview-body .file-preview-md-toggle');
    await toggle.click();
    const source = page.locator('#file-preview-body .file-preview-md-source');
    await expect(source).toBeVisible();
    await expect(source).toContainText('# 长文档滚动');
    const preOverflow = await source.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(preOverflow.scrollHeight).toBeLessThanOrEqual(preOverflow.clientHeight + 1);
    await expectPreviewBodyScrolls(page);
    await expect(page.locator('#file-preview-pane')).toBeVisible();
    await expect(page.locator('#file-preview, #file-preview-dialog, [role="dialog"]')).toHaveCount(0);
    await page.locator('#file-preview-back').click();
    await expect(page.locator('#files-list')).toBeVisible();
    await expect(item).toHaveAttribute('data-selected', 'true');
    await item.locator('.file-row').click();
    await expect(viewer.locator('h1')).toHaveText('长文档滚动');
    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview-pane')).toHaveCount(0);
    await expect(page.locator('#files-list')).toBeVisible();
  });

  test('files pane scrolls long plain text in the body', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, base, humanToken);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();

    const fileName = `long-text-${Date.now()}.txt`;
    const text = Array.from(
      { length: 400 },
      (_, index) => `纯文本第 ${index + 1} 行：验证长文本预览由正文区滚动。`,
    ).join('\n');
    await page.locator('#files-input').setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from(text),
    });
    const item = page.locator('#files-list .file-item').filter({ hasText: fileName });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#file-preview-body pre')).toContainText('纯文本第 400 行', {
      timeout: 15_000,
    });
    await expectPreviewBodyScrolls(page);

    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview')).toBeHidden();
  });

  test('message file card opens the same scrollable markdown preview', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const marker = `FILE-LONG-MD-${crypto.randomUUID().slice(0, 8)}`;
    const fileName = `long-report-${Date.now()}.md`;
    const uploaded = await uploadBinary(
      base,
      humanToken,
      fileName,
      'text/markdown',
      Buffer.from(longMarkdown('消息文件卡长文档')),
    );
    await callTool(base, humanToken, 'network_room_file_bind', {
      request_id: requestId('e2e_preview_bind'),
      room_id: roomId,
      file_id: uploaded.fileId,
    });
    await sendFileMessage(base, humanToken, roomId, `${marker}\n[${fileName}](${uploaded.publicUrl})`);

    await page.goto(`${base}/c/${roomId}`);
    const message = page.locator('#messages .msg').filter({ hasText: marker });
    await message.scrollIntoViewIfNeeded();
    await message.locator('.msg-file-preview').click();

    const viewer = page.locator('#file-preview-body .file-preview-md-viewer');
    await expect(viewer.locator('h1')).toHaveText('消息文件卡长文档', { timeout: 15_000 });
    await expect(viewer).toContainText('第 120 节', { timeout: 15_000 });
    await expect(page.locator('#file-preview-title')).toHaveText(fileName);
    await expectPreviewBodyScrolls(page);
    await expect(page.locator('#files-pane #file-preview-pane')).toBeVisible();
    await expect(page.locator('#file-preview, #file-preview-dialog, [role="dialog"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#file-preview, #file-preview-pane')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('#files-list')).toBeVisible();
  });

  test('image and PDF previews keep their fitted layout', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, base, humanToken);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();

    const imageName = `fit-${Date.now()}.png`;
    await page.locator('#files-input').setInputFiles({
      name: imageName,
      mimeType: 'image/png',
      buffer: PIXEL_PNG,
    });
    const imageItem = page.locator('#files-list .file-item').filter({ hasText: imageName });
    await expect(imageItem).toBeVisible({ timeout: 15_000 });
    await imageItem.getByRole('button', { name: '预览', exact: true }).click();
    const image = page.locator('#file-preview-body img');
    await expect(image).toBeVisible({ timeout: 10_000 });
    const imageBox = await image.boundingBox();
    const imageBodyBox = await page.locator('#file-preview-body').boundingBox();
    expect(imageBox).not.toBeNull();
    expect(imageBodyBox).not.toBeNull();
    // 图片仍在正文区居中，不因滚动容器改动而贴边或溢出。
    expect(
      Math.abs(imageBox!.x + imageBox!.width / 2 - (imageBodyBox!.x + imageBodyBox!.width / 2)),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(imageBox!.y + imageBox!.height / 2 - (imageBodyBox!.y + imageBodyBox!.height / 2)),
    ).toBeLessThanOrEqual(2);
    const imageGeometry = await previewGeometry(page);
    expect(imageGeometry.scrollHeight).toBeLessThanOrEqual(imageGeometry.clientHeight + 1);
    await expect(page.locator('#file-preview-download')).toBeVisible();
    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview')).toBeHidden();

    const pdfName = `fit-${Date.now()}.pdf`;
    await page.locator('#files-input').setInputFiles({
      name: pdfName,
      mimeType: 'application/pdf',
      buffer: MINIMAL_PDF,
    });
    const pdfItem = page.locator('#files-list .file-item').filter({ hasText: pdfName });
    await expect(pdfItem).toBeVisible({ timeout: 15_000 });
    await pdfItem.getByRole('button', { name: '预览', exact: true }).click();
    const frame = page.locator('#file-preview-body iframe');
    await expect(frame).toBeVisible({ timeout: 10_000 });
    const frameBox = await frame.boundingBox();
    expect(frameBox?.height ?? 0).toBeGreaterThan(200);
    const pdfGeometry = await previewGeometry(page);
    expect(pdfGeometry.scrollHeight).toBeLessThanOrEqual(pdfGeometry.clientHeight + 1);
    await expect(page.locator('#file-preview-title')).toHaveText(pdfName);
    await expect(page.locator('#file-preview-download')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#file-preview')).toHaveCount(0, { timeout: 10_000 });
  });

  test.describe('mobile', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('long markdown scrolls with touch and without horizontal overflow', async ({ page }) => {
      await login(page, base, humanToken);
      await page.goto(`${base}/c/${roomId}`);
      await page.locator('#files-toggle').click();
      await expect(page.locator('#files-pane')).toBeVisible();

      const fileName = `mobile-long-${Date.now()}.md`;
      await page.locator('#files-input').setInputFiles({
        name: fileName,
        mimeType: 'text/markdown',
        buffer: Buffer.from(longMarkdown('移动端长文档')),
      });
      const item = page.locator('#files-list .file-item').filter({ hasText: fileName });
      await expect(item).toBeVisible({ timeout: 15_000 });
      await item.getByRole('button', { name: '预览', exact: true }).click();
      const viewer = page.locator('#file-preview-body .file-preview-md-viewer');
      await expect(viewer.locator('h1')).toHaveText('移动端长文档', { timeout: 15_000 });
      await expect(viewer).toContainText('第 120 节', { timeout: 15_000 });

      await expect(page.locator('#file-preview[role="dialog"]')).toBeVisible();
      await expect(page.locator('#file-preview-pane')).toHaveCount(0);
      const body = page.locator('#file-preview-body');
      const geometry = await previewGeometry(page);
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight + 100);
      expect(geometry.overflowY).toBe('auto');
      expect(geometry.overscrollBehaviorY).toBe('contain');
      expect(geometry.headBottom).toBeLessThanOrEqual(geometry.bodyTop + 1);
      expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.footTop + 1);
      expect(geometry.footBottom).toBeLessThanOrEqual(geometry.cardBottom + 1);

      const horizontal = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('#file-preview-body');
        if (!panel) throw new Error('文件预览正文缺失');
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          body: panel.scrollWidth - panel.clientWidth,
        };
      });
      expect(horizontal.page).toBeLessThanOrEqual(1);
      expect(horizontal.body).toBeLessThanOrEqual(1);

      // CDP 合成触摸滚动，覆盖移动端 touch 路径而不只是设置 scrollTop。
      const session = await page.context().newCDPSession(page);
      const bodyBox = await body.boundingBox();
      if (!bodyBox) throw new Error('文件预览正文不可见');
      await session.send('Input.synthesizeScrollGesture', {
        x: Math.round(bodyBox.x + bodyBox.width / 2),
        y: Math.round(bodyBox.y + Math.min(bodyBox.height - 24, 300)),
        yDistance: -320,
        gestureSourceType: 'touch',
        speed: 800,
      });
      await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await session.detach();

      await expect(page.locator('#file-preview-title')).toBeVisible();
      await expect(page.locator('#file-preview-close')).toBeVisible();
      await expect(page.locator('#file-preview-download')).toBeVisible();

      await page.locator('#file-preview-close').click();
      await expect(page.locator('#file-preview')).toBeHidden();
    });
  });
});
