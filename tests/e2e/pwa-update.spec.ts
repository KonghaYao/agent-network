import { expect, test, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { callTool, createComponentRoom, login, requestId } from './fixtures/components';

/**
 * PWA 阶段 3：安全更新、忙碌保护、草稿快照与资源错误恢复。
 *
 * 该套件会真实构建两套发布并启动隔离的 release-mode 实例，因此默认不随
 * `test:e2e` 运行；使用 `E2E_PWA_UPDATE=1 bun run test:pwa:e2e`。真机
 * iOS/Safari 的 IME 与安装容器不在自动覆盖范围内。
 */

const ENABLED = process.env.E2E_PWA_UPDATE === '1';
test.skip(!ENABLED, '设置 E2E_PWA_UPDATE=1 运行 A/B 发布套件');

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const REPO_ROOT = resolve(process.cwd());
const FAKE_BUILD = `sha256:${'f'.repeat(64)}`;

let releaseRoot = '';
let dataDir = '';
let base = '';
let port = 0;
let server: ChildProcess | undefined;
let serverLog = '';
let releaseA = '';
let releaseB = '';
let fixture: Awaited<ReturnType<typeof createComponentRoom>>;

function runBun(args: string[]): string {
  const result = spawnSync('bun', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  if (result.status !== 0) {
    throw new Error(
      `bun ${args.join(' ')} 失败（status=${String(result.status)}）\n` +
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-8000),
    );
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function buildIdFrom(output: string): string {
  const match = /"buildId": "(sha256:[0-9a-f]{64})"/u.exec(output);
  if (!match?.[1]) throw new Error(`构建输出缺少 buildId:\n${output.slice(-2000)}`);
  return match[1];
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const value = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (value > 0 ? resolvePort(value) : reject(new Error('无法预留端口'))));
    });
  });
}

async function waitForHealth(target: string, deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(`${target}/health`);
      if (response.ok) return;
    } catch {
      // 尚未监听。
    }
    if (Date.now() > deadline) throw new Error(`服务未就绪：${target}\n${serverLog.slice(-4000)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

async function startServer(): Promise<void> {
  serverLog = '';
  const child = spawn('bun', [resolve(REPO_ROOT, 'src/bun/main.ts')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      PUBLIC_ORIGIN: base,
      ENVIRONMENT: 'test',
      WEB_RELEASES_ROOT: releaseRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    serverLog = `${serverLog}${chunk.toString()}`.slice(-20000);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    serverLog = `${serverLog}${chunk.toString()}`.slice(-20000);
  });
  server = child;
  await waitForHealth(base);
}

async function stopServer(): Promise<void> {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit').then(() => true);
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    exited,
    new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (!stopped) {
    child.kill('SIGKILL');
    await once(child, 'exit').catch(() => undefined);
  }
}

async function switchRelease(buildId: string): Promise<void> {
  await stopServer();
  runBun(['scripts/rollback-web-release.ts', '--root', releaseRoot, '--to', buildId]);
  await startServer();
  const version = (await (await fetch(`${base}/web-version.json`)).json()) as {
    buildId?: string;
  };
  if (version.buildId !== buildId) {
    throw new Error(`切换后版本不符：${String(version.buildId)} != ${buildId}`);
  }
}

function fakeVersion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deploymentId: 'r900001',
    buildId: FAKE_BUILD,
    minWebContract: 1,
    maxWebContract: 1,
    ...overrides,
  };
}

async function routeVersion(page: Page, version: Record<string, unknown>): Promise<void> {
  await page.unroute('**/web-version.json').catch(() => undefined);
  await page.route('**/web-version.json', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(version),
    }),
  );
}

async function forceCheck(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('webots:check-update'));
  });
}

async function openRoom(page: Page): Promise<void> {
  await login(page, base, fixture.tokenA);
  await page.goto(`${base}/c/${fixture.roomId}`);
  await expect(page.locator('#title')).toContainText(fixture.roomTitle);
  await expect(page.locator('#body')).toBeEnabled();
}

async function pageBuildId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.getElementById('web-release');
    const value = element ? JSON.parse(element.textContent ?? 'null') : null;
    return typeof value?.buildId === 'string' ? value.buildId : '';
  });
}

async function snapshotKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(sessionStorage).filter((key) =>
      key.startsWith('agent-network-update-snapshot-v1:'),
    ),
  );
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  releaseRoot = await mkdtemp(join(tmpdir(), 'agentnet-pwa-update-release-'));
  dataDir = await mkdtemp(join(tmpdir(), 'agentnet-pwa-update-data-'));

  const a = runBun([
    'scripts/build-web-release.ts',
    '--root',
    releaseRoot,
    '--nonce',
    'pwa-update-a',
    '--freeze-legacy',
    '--keep-candidate',
  ]);
  releaseA = buildIdFrom(a);
  const b = runBun([
    'scripts/build-web-release.ts',
    '--root',
    releaseRoot,
    '--nonce',
    'pwa-update-b',
    '--no-activate',
    '--keep-candidate',
  ]);
  releaseB = buildIdFrom(b);
  if (releaseA === releaseB) throw new Error('A/B buildId 相同');

  port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  await startServer();
  fixture = await createComponentRoom(base);
});

test.afterAll(async () => {
  await stopServer();
  if (releaseRoot) await rm(releaseRoot, { recursive: true, force: true });
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('同一 build 不提示，也不自动刷新', async ({ page }) => {
  await openRoom(page);
  const build = await pageBuildId(page);
  expect(build).toBe(releaseA);
  await routeVersion(page, fakeVersion({ buildId: build }));
  await forceCheck(page);
  await page.waitForTimeout(600);
  await expect(page.locator('#pwa-update-notice')).toHaveCount(0);
  expect(await pageBuildId(page)).toBe(build);
});

test('兼容新版本显示提示且不自动刷新', async ({ page }) => {
  await openRoom(page);
  await routeVersion(page, fakeVersion());
  await forceCheck(page);
  const notice = page.locator('#pwa-update-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('有新版本');
  await expect(page.locator('#pwa-update-apply')).toHaveText('更新');
  await expect(page.locator('#pwa-update-later')).toHaveText('稍后');
  expect(await pageBuildId(page)).toBe(releaseA);
  await page.locator('#pwa-update-later').click();
  await expect(notice).toHaveCount(0);
});

test('契约不兼容进入需要更新状态并限制新写入', async ({ page }) => {
  await openRoom(page);
  await routeVersion(page, fakeVersion({ minWebContract: 2, maxWebContract: 2 }));
  await forceCheck(page);
  const notice = page.locator('#pwa-update-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('需要更新');
  await page.locator('#body').fill('这条消息不应发送');
  await expect(page.locator('#send')).toBeDisabled();
  await expect(page.locator('#attach-file')).toBeDisabled();
  await expect(page.locator('.composer-update-block')).toContainText('不兼容');
});

test('390 暗色更新提示不遮挡输入且按钮键盘可达', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await openRoom(page);
  await routeVersion(page, fakeVersion());
  await forceCheck(page);
  const notice = page.locator('#pwa-update-notice');
  await expect(notice).toBeVisible();
  const box = await notice.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);

  // 提示位于顶部，不拦截底部输入区；按钮保持可见焦点。
  await page.locator('#body').click();
  await page.locator('#body').fill('仍可输入');
  await expect(page.locator('#body')).toHaveValue('仍可输入');
  const apply = page.locator('#pwa-update-apply');
  await apply.focus();
  expect(await apply.evaluate((node) => document.activeElement === node)).toBe(true);
  const height = await apply.evaluate((node) => node.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(44);
});

test('IME、@ 与上传在途分别阻止刷新并给出原因', async ({ page }) => {
  await openRoom(page);
  await routeVersion(page, fakeVersion());
  await forceCheck(page);
  const notice = page.locator('#pwa-update-notice');
  await expect(notice).toBeVisible();

  await page.locator('#body').dispatchEvent('compositionstart');
  await page.locator('#pwa-update-apply').click();
  await expect(notice).toContainText('请先完成中文输入');
  expect(await pageBuildId(page)).toBe(releaseA);
  await page.locator('#body').dispatchEvent('compositionend');

  await page.locator('#body').click();
  await page.keyboard.type('@');
  const picker = page.locator('#mention-picker');
  await expect(picker).toBeVisible();
  await picker.locator('.mention-item').filter({ hasText: fixture.nameB }).click();
  await page.locator('#pwa-update-apply').click();
  await expect(notice).toContainText('已选择的 @');
  expect(await pageBuildId(page)).toBe(releaseA);
  await page.locator('#body').fill('');

  await page.route('**/mcp-upload', async (route) => {
    await new Promise((resolveWait) => setTimeout(resolveWait, 4_000));
    await route.abort();
  });
  await page.locator('#composer-file-input').setInputFiles({
    name: 'busy.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('busy upload'),
  });
  await expect(page.locator('#composer-files')).toContainText('busy.txt');
  await page.locator('#pwa-update-apply').click();
  await expect(notice).toContainText('请等待附件上传完成');
  await expect(page.locator('#composer-files')).toContainText('上传失败', { timeout: 8_000 });
  await page.locator('#pwa-update-apply').click();
  await expect(notice).toContainText('请先移除上传失败的附件');
  await page.getByRole('button', { name: '移除 busy.txt' }).click();
  await expect(page.locator('#composer-files')).not.toContainText('busy.txt');
  await page.locator('#pwa-update-later').click();
});

test('文字快照恢复、选择保持，同目标只重载一次', async ({ page }) => {
  await openRoom(page);
  await routeVersion(page, fakeVersion());
  await forceCheck(page);
  await expect(page.locator('#pwa-update-notice')).toBeVisible();

  const text = '更新前的草稿，需要完整恢复';
  await page.locator('#body').fill(text);
  await page.locator('#body').click();
  await page.keyboard.press('Home');
  for (let index = 0; index < 3; index += 1) await page.keyboard.press('ArrowRight');
  for (let index = 0; index < 5; index += 1) await page.keyboard.press('Shift+ArrowRight');

  const loaded = page.waitForEvent('load');
  await page.locator('#pwa-update-apply').click();
  await loaded;
  await expect(page.locator('#body')).toHaveValue(text);
  const selection = await page.locator('#body').evaluate((node) => {
    const area = node as HTMLTextAreaElement;
    return { start: area.selectionStart, end: area.selectionEnd };
  });
  expect(selection).toEqual({ start: 3, end: 8 });
  expect(await snapshotKeys(page)).toEqual([]);
  expect(await pageBuildId(page)).toBe(releaseA);

  await routeVersion(page, fakeVersion());
  await forceCheck(page);
  const notice = page.locator('#pwa-update-notice');
  await expect(notice).toBeVisible();
  let navigations = 0;
  page.on('framenavigated', () => {
    navigations += 1;
  });
  await page.locator('#pwa-update-apply').click();
  await expect(notice).toContainText('已经尝试过一次更新');
  await page.waitForTimeout(800);
  expect(navigations).toBe(0);
  expect(await pageBuildId(page)).toBe(releaseA);
});

test('配对等待确认时阻止刷新', async ({ page }) => {
  const pairing = await callTool<{ pairing_id: string; challenge: string }>(
    base,
    fixture.tokenA,
    'network_device_pairing_create',
    { request_id: requestId('pwa_update_pair'), device_label: 'PWA 更新测试设备' },
  );
  await routeVersion(page, fakeVersion());
  await login(page, base, fixture.tokenA);
  await page.goto(`${base}/pair#c=${pairing.challenge}`);
  await expect(page.locator('[data-pair-phase="idle"]')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '开始配对' }).click();
  await expect(page.locator('[data-pair-phase="awaiting"]')).toBeVisible({ timeout: 20_000 });
  await forceCheck(page);
  const notice = page.locator('#pwa-update-notice');
  await expect(notice).toBeVisible();
  await page.locator('#pwa-update-apply').click();
  await expect(notice).toContainText('等待已登录设备确认配对');
  expect(await pageBuildId(page)).toBe(releaseA);

  await callTool(base, fixture.tokenA, 'network_device_pairing_cancel', {
    request_id: requestId('pwa_update_pair_cancel'),
    pairing_id: pairing.pairing_id,
    reason: 'e2e cleanup',
  }).catch(() => undefined);
});

test('真实 A/B：旧页提示、点击后加载 B 并恢复草稿', async ({ page }) => {
  await openRoom(page);
  expect(await pageBuildId(page)).toBe(releaseA);
  const text = 'A/B 切换前写入的草稿';
  await page.locator('#body').fill(text);

  await switchRelease(releaseB);
  await forceCheck(page);
  const notice = page.locator('#pwa-update-notice');
  await expect(notice).toContainText('有新版本', { timeout: 20_000 });
  expect(await pageBuildId(page)).toBe(releaseA);

  const loaded = page.waitForEvent('load');
  await page.locator('#pwa-update-apply').click();
  await loaded;
  await expect(page.locator('#body')).toHaveValue(text);
  expect(await pageBuildId(page)).toBe(releaseB);
  expect(await snapshotKeys(page)).toEqual([]);
});
