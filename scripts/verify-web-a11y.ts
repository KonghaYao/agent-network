/**
 * Web 可访问性基线（axe-core）。
 *
 * 只记录 `/`、`/c/:roomId` 与新建群聊弹窗的 critical/serious violation 数量并
 * 与 `scripts/web/a11y-baseline.json` 比较：Phase 2 不要求归零，但不得增加。
 * 首次或需要刷新基线时用 `A11Y_UPDATE_BASELINE=1 bun run test:web:a11y`。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { chromium, type Page } from 'playwright';

import { check, checkEqual, checksPassed, rawRpc } from './lib/harness';
import { reservePort, startTestServer } from './lib/test-server';

const ROOT = resolve(import.meta.dir, '..');
const BASELINE_PATH = resolve(ROOT, 'scripts/web/a11y-baseline.json');
const ROUTES = ['home', 'room', 'group-modal'] as const;
type RouteName = (typeof ROUTES)[number];

interface BaselineEntry {
  critical: number;
  serious: number;
  rules: string[];
}
type Baseline = Partial<Record<RouteName, BaselineEntry>>;

async function rawTool<T>(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await rawRpc('tools/call', { name, arguments: args }, {
    token,
    url: new URL(`${base}/mcp`),
  });
  const result = response.body.result as {
    isError?: boolean;
    structuredContent?: T;
    content?: { type: string; text?: string }[];
  };
  if (result.isError) {
    throw new Error(result.content?.map((item) => item.text).join('\n') ?? `${name} 失败`);
  }
  return (result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}')) as T;
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function initScript(token: string): string {
  return `(() => {
  try { localStorage.setItem('agent-network-token', ${JSON.stringify(token)}); } catch (error) {}
})()`;
}

async function scan(page: Page, route: RouteName): Promise<BaselineEntry> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const violations = results.violations.filter(
    (item) => item.impact === 'critical' || item.impact === 'serious',
  );
  return {
    critical: violations.filter((item) => item.impact === 'critical').length,
    serious: violations.filter((item) => item.impact === 'serious').length,
    rules: violations.map((item) => `${item.id}(${item.impact})`).sort(),
  };
}

async function main(): Promise<void> {
  const port = reservePort();
  const base = `http://127.0.0.1:${port}`;
  process.env.AGENTNET_URL = base;
  const server = await startTestServer({
    port,
    tag: 'a11y',
    env: {
      PUBLIC_ORIGIN: base,
      AGENT_PRESENCE_GRACE_MS: '1200',
      AGENT_PRESENCE_ACTIVITY_TTL_MS: '1200',
      AGENT_PRESENCE_TOUCH_THROTTLE_MS: '100',
      AGENT_PRESENCE_SWEEP_MS: '150',
    },
  });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  try {
    const humanToken = crypto.randomUUID();
    const human = await rawTool<{ actor_id: string }>(base, humanToken, 'network_register', {
      request_id: requestId('a11y_human'),
      kind: 'human',
      name: 'A11y 验收',
    });
    const agent = await rawTool<{ actor_id: string }>(base, humanToken, 'network_agent_create', {
      request_id: requestId('a11y_agent'),
      name: 'A11y Agent',
    });
    const room = await rawTool<{ room: { room_id: string } }>(base, humanToken, 'network_room_create', {
      request_id: requestId('a11y_room'),
      kind: 'group',
      title: 'A11y 群聊',
      members: [agent.actor_id],
    });
    check('创建可访问性房间', human.actor_id.length > 0 && room.room.room_id.length > 0);

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(initScript(humanToken));
    const page = await context.newPage();
    const current: Baseline = {};

    await page.goto(`${base}/`);
    await page.locator('#room-list-status').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    current.home = await scan(page, 'home');

    await page.goto(`${base}/c/${room.room.room_id}`);
    await page.locator('#messages').waitFor({ timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    current.room = await scan(page, 'room');

    await page.goto(`${base}/`);
    await page.locator('#new-group').click();
    await page.locator('#group-modal:not([hidden])').waitFor({ timeout: 10_000 });
    // 等好友候选加载完毕并把鼠标移开，避免扫描到 loading/hover 的瞬时配色。
    await page.waitForFunction(
      `(document.getElementById('group-contacts')?.textContent || '').includes('没有可选好友') ||
       !!document.querySelector('#group-contacts .spa-combobox-item')`,
      undefined,
      { timeout: 10_000 },
    ).catch(() => undefined);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(150);
    current['group-modal'] = await scan(page, 'group-modal');

    for (const route of ROUTES) {
      const entry = current[route];
      check(`${route} axe 扫描完成`, entry !== undefined);
      console.log(
        `axe ${route}: critical=${entry?.critical ?? 0} serious=${entry?.serious ?? 0}` +
          (entry?.rules.length ? ` rules=${entry.rules.join(',')}` : ''),
      );
    }

    let baseline: Baseline = {};
    try {
      baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
    } catch {
      // 首次运行没有基线。
    }
    if (process.env.A11Y_UPDATE_BASELINE === '1') {
      await writeFile(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
      console.log(`已更新基线: ${BASELINE_PATH}`);
    } else {
      check('a11y 基线文件存在', Object.keys(baseline).length > 0);
      for (const route of ROUTES) {
        const expected = baseline[route];
        const actual = current[route];
        if (!expected || !actual) continue;
        checkEqual(`${route} critical 不高于基线`, actual.critical <= expected.critical, true);
        checkEqual(`${route} serious 不高于基线`, actual.serious <= expected.serious, true);
      }
    }
    await context.close();
    console.log(`\n可访问性基线: ${checksPassed()} 项检查通过`);
  } finally {
    await browser.close().catch(() => undefined);
    await server.dispose();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
