import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { heatColor } from '../../src/web/features/memory/constellation-scene';

/**
 * Fenix 星座图移植验收：真实 Chromium、真实 MCP 身份/房间；
 * 只替换记忆只读工具的响应。断言读取画布 data-* 与像素，
 * 不依赖恒真的 DOM 文本。
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
            name: 'agent-network-e2e-fenix-constellation',
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

async function login(page: Page, base: string, token: string): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('agent-network-token', value);
      localStorage.removeItem('agent-network-logged-out');
    } catch {
      // 浏览器禁用存储时由页面错误态兜底。
    }
  }, token);
  await page.goto(base);
}

function row(page: Page, roomId: string) {
  return page.locator(`#room-list a[data-room-id="${roomId}"]`);
}

interface MemoryCall {
  name: string;
  args: Record<string, unknown>;
}

interface RpcBody {
  id?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

interface FixtureNode {
  id: string;
  label: string;
  text: string;
  fact_type: 'world' | 'experience' | 'observation';
  date: string;
  entities: string[];
  mention_count: number;
}

interface FixtureEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
}

interface Fixture {
  nodes: FixtureNode[];
  edges: FixtureEdge[];
}

interface NodePoint {
  id: string;
  x: number;
  y: number;
  radius: number;
}

let fixture: Fixture = { nodes: [], edges: [] };

const XSS_ENTITY = '<img src=x onerror="window.__xss=1">';
const SECRET_ENTITY = 'sk-testonly-constellation-secret';

function smallFixture(): Fixture {
  return {
    nodes: [
      {
        id: 'mem-a',
        label: 'Deploy window',
        text: 'Deploy window moved to Thursday.',
        fact_type: 'experience',
        date: '2026-10-01T08:00:00.000Z',
        entities: ['alpha', XSS_ENTITY, SECRET_ENTITY],
        mention_count: 4,
      },
      {
        id: 'mem-b',
        label: 'Rollback completed',
        text: 'Rollback completed after the beta migration.',
        fact_type: 'experience',
        date: '2026-10-02T08:00:00.000Z',
        entities: ['beta'],
        mention_count: 2,
      },
      {
        id: 'mem-d',
        label: 'Dashboard slow',
        text: 'The dashboard was slow twice during the deploy.',
        fact_type: 'observation',
        date: '2026-10-03T08:00:00.000Z',
        entities: ['alpha'],
        mention_count: 1,
      },
    ],
    edges: [
      { id: 'edge-1', source: 'mem-a', target: 'mem-b', type: 'semantic', weight: 2 },
      { id: 'edge-2', source: 'mem-a', target: 'mem-d', type: 'entity', weight: 1 },
    ],
  };
}

/** 120 节点 / 600 边；40 个 hub + 80 个叶子，保证热度覆盖蓝/紫/橙三段。 */
function largeFixture(): Fixture {
  const nodeCount = 120;
  const hubCount = 40;
  const nodes: FixtureNode[] = Array.from({ length: nodeCount }, (_, index) => ({
    id: `n${index}`,
    label: `Memory node ${index.toString().padStart(3, '0')}`,
    text: `Memory body ${index}`,
    fact_type: (['world', 'experience', 'observation'] as const)[index % 3]!,
    date: new Date(Date.UTC(2026, 8, 1 + (index % 28))).toISOString(),
    entities: [`entity-${index % 12}`],
    mention_count: index + 1,
  }));
  const edges: FixtureEdge[] = [];
  const push = (source: string, target: string) => {
    const index = edges.length;
    edges.push({
      id: `e${index}`,
      source,
      target,
      type: (['semantic', 'temporal', 'entity', 'causal'] as const)[index % 4]!,
      weight: 1 + (index % 3),
    });
  };

  // 80 leaf links: each leaf starts with degree 1; each hub gets 2.
  for (let index = 0; index < 80; index += 1) {
    push(`n${hubCount + index}`, `n${index % hubCount}`);
  }

  // 520 hub-hub links with an explicit degree sequence (sum = 1040 stubs):
  // hub 0 = 39 (max), hubs 1..5 = 9 (mid), four hubs = 29, the rest 28.
  const hubHubTargets = [
    39,
    9,
    9,
    9,
    9,
    9,
    29,
    29,
    29,
    29,
    ...Array.from({ length: 30 }, () => 28),
  ];
  const stubs: number[] = [];
  for (let hub = 0; hub < hubCount; hub += 1) {
    for (let count = 0; count < hubHubTargets[hub]!; count += 1) stubs.push(hub);
  }
  let seed = 0x9e3779b9;
  const nextRandom = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let index = stubs.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(nextRandom() * (index + 1));
    [stubs[index], stubs[swap]] = [stubs[swap]!, stubs[index]!];
  }
  while (stubs.length > 0) {
    const left = stubs.pop()!;
    let partnerIndex = stubs.length - 1;
    while (partnerIndex >= 0 && stubs[partnerIndex] === left) partnerIndex -= 1;
    if (partnerIndex < 0) partnerIndex = stubs.length - 1;
    const partner = stubs.splice(partnerIndex, 1)[0]!;
    push(`n${left}`, `n${partner}`);
  }

  return { nodes, edges };
}

async function installStub(
  page: Page,
  calls: MemoryCall[],
  options: { actorName: string; actorId: string },
): Promise<void> {
  const actor = {
    actor_id: options.actorId,
    name: options.actorName,
    kind: 'agent' as const,
    archived: false,
    disabled: false,
  };

  await page.route('**/mcp', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.continue();
      return;
    }
    let body: RpcBody | null = null;
    try {
      body = JSON.parse(request.postData() ?? 'null') as RpcBody;
    } catch {
      body = null;
    }
    const name = typeof body?.params?.name === 'string' ? body.params.name : null;
    if (!name || !name.startsWith('network_agent_memory_')) {
      await route.continue();
      return;
    }
    const args =
      body?.params?.arguments && typeof body.params.arguments === 'object'
        ? (body.params.arguments as Record<string, unknown>)
        : {};
    calls.push({ name, args });

    let structuredContent: unknown;
    if (name === 'network_agent_memory_overview') {
      structuredContent = {
        available: true,
        reason: 'ok',
        actor,
        fetched_at: Date.now(),
        stats: {
          total_nodes: fixture.nodes.length,
          total_links: fixture.edges.length,
          total_documents: 1,
          by_fact_type: { world: 40, experience: 40, observation: 40 },
          links_by_type: { semantic: 150, temporal: 150, entity: 150, causal: 150 },
          pending_operations: 0,
          failed_operations: 0,
          last_write_at: null,
          last_consolidated_at: null,
        },
      };
    } else if (name === 'network_agent_memory_graph') {
      const type = typeof args.type === 'string' ? args.type : '';
      const limit = typeof args.limit === 'number' ? args.limit : 120;
      const nodes = fixture.nodes
        .filter((node) => !type || node.fact_type === type)
        .slice(0, limit);
      const ids = new Set(nodes.map((node) => node.id));
      const edges = fixture.edges.filter(
        (edge) => ids.has(edge.source) && ids.has(edge.target),
      );
      structuredContent = {
        available: true,
        reason: 'ok',
        actor,
        fetched_at: Date.now(),
        nodes,
        edges,
        total_units: fixture.nodes.length,
        total_edges: fixture.edges.length,
        raw_node_count: fixture.nodes.length,
        raw_edge_count: fixture.edges.length,
        limit,
        truncated: false,
      };
    } else if (name === 'network_agent_memory_get') {
      const memoryId = typeof args.memory_id === 'string' ? args.memory_id : '';
      const node = fixture.nodes.find((item) => item.id === memoryId) ?? fixture.nodes[0]!;
      structuredContent = {
        available: true,
        reason: 'ok',
        actor,
        fetched_at: Date.now(),
        memory: {
          id: node.id,
          text: node.text,
          fact_type: node.fact_type,
          state: 'valid',
          mentioned_at: node.date,
          occurred_start: null,
          occurred_end: null,
          entities: node.entities,
          proof_count: 2,
          tags: [],
          context: null,
          source_memories: [],
          history_count: 1,
          text_truncated: false,
        },
      };
    } else {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body?.id ?? crypto.randomUUID(),
        result: { structuredContent, content: [{ type: 'text', text: 'ok' }] },
      }),
    });
  });
}

async function openRowMemory(page: Page, roomId: string): Promise<void> {
  await page.locator('#room-filter-agent').click();
  const listRow = row(page, roomId);
  await expect(listRow).toBeVisible({ timeout: 15_000 });
  await listRow.click({ button: 'right' });
  await expect(page.locator('#room-row-menu')).toBeVisible();
  await page.locator('#room-row-menu-memory').click();
  await expect(page.locator('#agent-memory-dialog')).toBeVisible({ timeout: 15_000 });
}

async function openConstellation(page: Page, roomId: string): Promise<Locator> {
  await openRowMemory(page, roomId);
  await page.locator('#memory-tab-constellation').click();
  const canvas = page.locator('#memory-graph-canvas');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => Number((await canvas.getAttribute('data-paint-count')) ?? '0'))
    .toBeGreaterThan(0);
  await expect(canvas).toHaveAttribute('data-node-points', /.+/u);
  return canvas;
}

async function readPoints(canvas: Locator): Promise<NodePoint[]> {
  const raw = await canvas.getAttribute('data-node-points');
  return JSON.parse(raw ?? '[]') as NodePoint[];
}

async function hoverPoint(page: Page, canvas: Locator, point: NodePoint): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('画布没有边界');
  await page.mouse.move(box.x + point.x, box.y + point.y);
}

function degrees(fixtureData: Fixture): { map: Map<string, number>; max: number } {
  const map = new Map<string, number>();
  for (const edge of fixtureData.edges) {
    map.set(edge.source, (map.get(edge.source) ?? 0) + 1);
    map.set(edge.target, (map.get(edge.target) ?? 0) + 1);
  }
  let max = 1;
  for (const value of map.values()) max = Math.max(max, value);
  return { map, max };
}

function parseRgb(value: string): [number, number, number] {
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/u.exec(value);
  if (!match) throw new Error(`无法解析颜色：${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * 画布中心像素 = 节点热度色先按 `baseAlpha` 覆盖背景，再叠加同色光晕。
 * 与 `constellation-paint.ts` 的绘制顺序一致。
 */
function expectedCenterColor(heat: string, degree: number, dark = false): [number, number, number] {
  const [red, green, blue] = parseRgb(heat);
  const background = dark ? [9, 9, 11] : [255, 255, 255];
  const fillAlpha = 0.45 + Math.min(degree * 0.03, 0.5);
  const haloAlpha = degree > 3 ? 0.06 + Math.min(degree * 0.005, 0.08) : 0;
  const afterFill = [red, green, blue].map(
    (value, index) => value * fillAlpha + background[index]! * (1 - fillAlpha),
  );
  const afterHalo = [red, green, blue].map(
    (value, index) => value * haloAlpha + afterFill[index]! * (1 - haloAlpha),
  );
  return afterHalo.map((value) => Math.round(value)) as [number, number, number];
}

interface SampleResult {
  width: number;
  height: number;
  mismatches: { id: string; got: number[]; expected: number[]; distance: number }[];
  buckets: string[];
  histogram: { blue: number; purple: number; warm: number };
}

async function sampleCenterColors(
  page: Page,
  points: NodePoint[],
  expected: { id: string; rgb: [number, number, number] }[],
  compare: 'exact' | 'hue' = 'exact',
): Promise<SampleResult> {
  return page.evaluate(
    ({ points: inputPoints, expected: inputExpected, compare: compareMode }) => {
      const canvas = document.getElementById('memory-graph-canvas') as HTMLCanvasElement | null;
      if (!canvas) {
        return {
          width: 0,
          height: 0,
          mismatches: [],
          buckets: [],
          histogram: { blue: 0, purple: 0, warm: 0 },
        };
      }
      const context = canvas.getContext('2d');
      if (!context) {
        return {
          width: canvas.width,
          height: canvas.height,
          mismatches: [],
          buckets: [],
          histogram: { blue: 0, purple: 0, warm: 0 },
        };
      }
      const rect = canvas.getBoundingClientRect();
      const paintWidth = Number(canvas.dataset.width) || rect.width;
      const paintHeight = Number(canvas.dataset.height) || rect.height;
      const ratioX = canvas.width / paintWidth;
      const ratioY = canvas.height / paintHeight;
      const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const pointById = new Map(inputPoints.map((point) => [point.id, point]));
      const mismatches: { id: string; got: number[]; expected: number[]; distance: number }[] = [];
      const buckets = new Set<string>();

      const bucketOf = (color: readonly number[]): string | null => {
        const [red = 0, green = 0, blue = 0] = color;
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const delta = maximum - minimum;
        if (delta <= 8) return null;
        let hue = 0;
        if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
        else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
        else hue = 60 * ((red - green) / delta + 4);
        if (hue < 0) hue += 360;
        if (hue >= 190 && hue < 250) return 'blue';
        if (hue >= 250 && hue < 330) return 'purple';
        if (hue < 45 || hue >= 330) return 'warm';
        return null;
      };

      for (const item of inputExpected) {
        const point = pointById.get(item.id);
        if (!point) {
          mismatches.push({ id: item.id, got: [], expected: item.rgb, distance: 999 });
          continue;
        }
        const centerX = Math.round(point.x * ratioX);
        const centerY = Math.round(point.y * ratioY);
        // 节点是半透明填充，中心像素可能被下方的连线污染；取 5×5
        // 邻域里出现次数最多的非背景色作为该节点的实际填充色。
        const counts = new Map<string, { count: number; color: [number, number, number] }>();
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const x = Math.max(0, Math.min(canvas.width - 1, centerX + dx));
            const y = Math.max(0, Math.min(canvas.height - 1, centerY + dy));
            const offset = (y * canvas.width + x) * 4;
            const red = image[offset] ?? 0;
            const green = image[offset + 1] ?? 0;
            const blue = image[offset + 2] ?? 0;
            if (red >= 250 && green >= 250 && blue >= 250) continue;
            const key = `${red},${green},${blue}`;
            const entry = counts.get(key);
            if (entry) entry.count += 1;
            else counts.set(key, { count: 1, color: [red, green, blue] });
          }
        }
        let mode: [number, number, number] | null = null;
        let bestCount = 0;
        for (const entry of counts.values()) {
          if (entry.count > bestCount) {
            bestCount = entry.count;
            mode = entry.color;
          }
        }
        if (!mode) {
          mismatches.push({ id: item.id, got: [], expected: item.rgb, distance: 999 });
          continue;
        }
        const got = mode;
        const distance = Math.max(
          Math.abs(got[0] - item.rgb[0]),
          Math.abs(got[1] - item.rgb[1]),
          Math.abs(got[2] - item.rgb[2]),
        );
        if (compareMode === 'exact' && distance > 8) {
          mismatches.push({ id: item.id, got, expected: item.rgb, distance });
        } else if (compareMode === 'hue') {
          const expectedBucket = bucketOf(item.rgb);
          const gotBucket = bucketOf(got);
          if (expectedBucket !== gotBucket) {
            mismatches.push({ id: item.id, got, expected: item.rgb, distance });
          }
        }

        const bucket = bucketOf(got);
        if (bucket) buckets.add(bucket);
      }

      const histogram = { blue: 0, purple: 0, warm: 0 };
      for (let offset = 0; offset < image.length; offset += 4) {
        const red = image[offset] ?? 0;
        const green = image[offset + 1] ?? 0;
        const blue = image[offset + 2] ?? 0;
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const delta = maximum - minimum;
        if (delta <= 20) continue;
        let hue = 0;
        if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
        else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
        else hue = 60 * ((red - green) / delta + 4);
        if (hue < 0) hue += 360;
        if (hue >= 190 && hue < 250) histogram.blue += 1;
        else if (hue >= 250 && hue < 330) histogram.purple += 1;
        else if (hue < 45 || hue >= 330) histogram.warm += 1;
      }

      return {
        width: canvas.width,
        height: canvas.height,
        mismatches,
        buckets: [...buckets],
        histogram,
      };
    }, { points, expected, compare });
}

interface PaletteResult {
  sampled: number;
  buckets: string[];
}

/**
 * 采样所有节点中心附近的众数颜色，只验证它们确实落在热度色带上。
 * 120 节点布局很密，中心可能被上层节点/光晕覆盖；具体度数→颜色映射
 * 已由 3 节点逐像素断言与 `heatColor` 三段值覆盖。
 */
async function sampleNodePalette(page: Page, points: NodePoint[]): Promise<PaletteResult> {
  return page.evaluate(({ points: inputPoints }) => {
    const canvas = document.getElementById('memory-graph-canvas') as HTMLCanvasElement | null;
    if (!canvas) return { sampled: 0, buckets: [] };
    const context = canvas.getContext('2d');
    if (!context) return { sampled: 0, buckets: [] };
    const rect = canvas.getBoundingClientRect();
    const paintWidth = Number(canvas.dataset.width) || rect.width;
    const paintHeight = Number(canvas.dataset.height) || rect.height;
    const ratioX = canvas.width / paintWidth;
    const ratioY = canvas.height / paintHeight;
    const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const bucketOf = (color: readonly number[]): string | null => {
      const [red = 0, green = 0, blue = 0] = color;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const delta = maximum - minimum;
      if (delta <= 8) return null;
      let hue = 0;
      if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
      else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
      else hue = 60 * ((red - green) / delta + 4);
      if (hue < 0) hue += 360;
      if (hue >= 190 && hue < 250) return 'blue';
      if (hue >= 250 && hue < 330) return 'purple';
      if (hue < 45 || hue >= 330) return 'warm';
      return null;
    };

    const buckets = new Set<string>();
    let sampled = 0;
    for (const point of inputPoints) {
      const centerX = Math.round(point.x * ratioX);
      const centerY = Math.round(point.y * ratioY);
      const counts = new Map<string, { count: number; color: [number, number, number] }>();
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const x = Math.max(0, Math.min(canvas.width - 1, centerX + dx));
          const y = Math.max(0, Math.min(canvas.height - 1, centerY + dy));
          const offset = (y * canvas.width + x) * 4;
          const red = image[offset] ?? 0;
          const green = image[offset + 1] ?? 0;
          const blue = image[offset + 2] ?? 0;
          if (red >= 250 && green >= 250 && blue >= 250) continue;
          const key = `${red},${green},${blue}`;
          const entry = counts.get(key);
          if (entry) entry.count += 1;
          else counts.set(key, { count: 1, color: [red, green, blue] });
        }
      }
      let mode: [number, number, number] | null = null;
      let bestCount = 0;
      for (const entry of counts.values()) {
        if (entry.count > bestCount) {
          bestCount = entry.count;
          mode = entry.color;
        }
      }
      if (!mode) continue;
      sampled += 1;
      const bucket = bucketOf(mode);
      if (bucket) buckets.add(bucket);
    }
    return { sampled, buckets: [...buckets] };
  }, { points });
}

async function shot(page: Page, name: string): Promise<void> {  if (!process.env.CONSTELLATION_SHOTS) return;
  const directory = '/tmp/fenix-constellation-shots';
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`) });
}

test.describe('Fenix 星座图移植', () => {
  let base = '';
  let tokenA = '';
  let agentName = '';
  let agentId = '';
  let directRoom = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    agentName = `Fenix Graph Agent ${suffix}`;

    await callTool(base, tokenA, 'network_register', {
      request_id: requestId('e2e_fenix_reg'),
      kind: 'human',
      name: `Fenix Graph Human ${suffix}`,
      device_id: `e2e-fenix-${suffix}`,
    });
    const agent = await callTool<{ actor_id: string }>(base, tokenA, 'network_agent_create', {
      request_id: requestId('e2e_fenix_agent'),
      name: agentName,
    });
    agentId = agent.actor_id;
    const direct = await callTool<{ room: { room_id: string } }>(
      base,
      tokenA,
      'network_room_create',
      {
        request_id: requestId('e2e_fenix_direct'),
        kind: 'direct',
        members: [agentId],
      },
    );
    directRoom = direct.room.room_id;
  });

  test('3 节点/2 边：绘制、热度、hover 隔离、标签、tooltip 防 XSS、缩放拖拽全屏', async ({
    page,
  }) => {
    fixture = smallFixture();
    const calls: MemoryCall[] = [];
    await installStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    const canvas = await openConstellation(page, directRoom);

    await expect(canvas).toHaveAttribute('data-node-count', '3');
    await expect(canvas).toHaveAttribute('data-edge-count', '2');
    await expect(canvas).toHaveAttribute('data-dpr', /^(1|2)\.00$/u);
    await expect(canvas).toHaveAttribute('data-visible-count', '3');
    await expect(page.locator('#memory-graph-canvas-hud')).toContainText('节点 3');
    await expect(page.locator('#memory-graph-canvas-hud')).toContainText('边 2');

    const heatStyle = await page.locator('#memory-graph-canvas-heat .memory-graph-heat-bar').getAttribute('style');
    expect(heatStyle).toContain('rgb(56, 130, 220)');
    expect(heatStyle).toContain('rgb(170, 130, 200)');
    expect(heatStyle).toContain('rgb(240, 100, 60)');

    const legendText = (await page.locator('.memory-graph-legend').textContent()) ?? '';
    expect(legendText).toContain('semantic');
    expect(legendText).toContain('entity');
    const semanticSwatch = await page
      .locator('.memory-graph-legend li', { hasText: 'semantic' })
      .locator('.memory-graph-swatch')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(semanticSwatch).toBe('rgb(0, 116, 217)');

    // 实际画布像素：每个节点中心应是热度色按节点透明度覆盖背景后的颜色。
    const points = await readPoints(canvas);
    const { map: degreeMap, max: maxDegree } = degrees(fixture);
    const expected = fixture.nodes.map((node) => {
      const degree = degreeMap.get(node.id) ?? 0;
      return {
        id: node.id,
        rgb: expectedCenterColor(heatColor(Math.sqrt(degree / maxDegree)), degree),
      };
    });
    const sampled = await sampleCenterColors(page, points, expected);
    expect(sampled.mismatches).toEqual([]);
    expect(sampled.buckets).toContain('warm');

    await expect(canvas).toHaveAttribute('data-label-count', /^[1-9]\d*$/u);
    await expect(canvas).toHaveAttribute('data-label-mode', 'inline');
    await shot(page, '3-nodes-light');

    // hover 中间节点：只画它的 2 条邻边，tooltip 只显示类型/日期/实体/连接数。
    const pointA = points.find((point) => point.id === 'mem-a')!;
    await hoverPoint(page, canvas, pointA);
    await expect(canvas).toHaveAttribute('data-hover-id', 'mem-a');
    await expect(canvas).toHaveAttribute('data-links-drawn', '2');
    await expect(canvas).toHaveAttribute('data-label-mode', 'card');
    const tooltip = page.locator('.memory-graph-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('经历');
    await expect(tooltip).toContainText('2 条连接');
    await expect(tooltip).toContainText('2026-10-01');
    await expect(tooltip).toContainText('alpha');
    await expect(tooltip).toContainText(XSS_ENTITY);
    await expect(tooltip).toContainText('[已隐藏]');
    await expect(tooltip.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();

    // hover 叶子节点：只画 1 条邻边。
    const pointB = points.find((point) => point.id === 'mem-b')!;
    await hoverPoint(page, canvas, pointB);
    await expect(canvas).toHaveAttribute('data-hover-id', 'mem-b');
    await expect(canvas).toHaveAttribute('data-links-drawn', '1');
    await expect(tooltip).toContainText('1 条连接');
    await shot(page, '3-nodes-hover');

    // 移出画布后 tooltip 与 hover 都清空。
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
    await expect(canvas).toHaveAttribute('data-hover-id', '');

    // 缩放：按钮精确到 125%，两次到 156% 后进入卡片标签；滚轮改变倍数；重置回 100%。
    await expect(page.locator('.memory-graph-zoom')).toHaveText('100%');
    await page.locator('#memory-graph-canvas-zoom-in').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('125%');
    await expect(canvas).toHaveAttribute('data-zoom', '1.25');
    await page.locator('#memory-graph-canvas-zoom-in').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('156%');
    await expect(canvas).toHaveAttribute('data-label-mode', 'card');
    await page.locator('#memory-graph-canvas-reset').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('100%');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const wheelOffsetX = 40;
    const wheelOffsetY = 20;
    await page.mouse.move(
      box!.x + box!.width / 2 + wheelOffsetX,
      box!.y + box!.height / 2 + wheelOffsetY,
    );
    await page.mouse.wheel(0, -200);
    await expect(page.locator('.memory-graph-zoom')).not.toHaveText('100%');
    // 光标锚定：缩放后光标下的世界点保持不动，pan = offset × (1 - ratio)。
    const wheelZoom = Number(await canvas.getAttribute('data-zoom'));
    expect(
      Math.abs(
        Number(await canvas.getAttribute('data-pan-x')) - wheelOffsetX * (1 - wheelZoom),
      ),
    ).toBeLessThan(1.5);
    expect(
      Math.abs(
        Number(await canvas.getAttribute('data-pan-y')) - wheelOffsetY * (1 - wheelZoom),
      ),
    ).toBeLessThan(1.5);
    await page.locator('#memory-graph-canvas-reset').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('100%');

    // 拖拽平移：data-pan-x 真正变化，且不误开详情。
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2 + 20);
    await page.mouse.up();
    expect(Number(await canvas.getAttribute('data-pan-x'))).toBeGreaterThan(30);
    await expect(page.locator('#memory-detail-text')).toHaveCount(0);

    // 全屏：覆盖视口，Esc 退出且不关闭记忆弹窗。
    await page.locator('#memory-graph-canvas-fullscreen').click();
    const fullscreenButton = page.locator('#memory-graph-canvas-fullscreen');
    await expect(fullscreenButton).toHaveAttribute('aria-pressed', 'true');
    const fullscreen = page.locator('.memory-graph.is-fullscreen');
    await expect(fullscreen).toBeVisible();
    await expect(fullscreen.locator('.memory-graph-legend-overlay')).toContainText('semantic');
    await expect(fullscreen.locator('.memory-graph-legend-overlay')).toContainText('entity');
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.closest('.memory-graph') !== null),
    ).toBe(true);
    const fullscreenBox = await fullscreen.boundingBox();
    expect(fullscreenBox).not.toBeNull();
    expect(fullscreenBox!.x).toBeLessThanOrEqual(1);
    expect(fullscreenBox!.y).toBeLessThanOrEqual(1);
    expect(fullscreenBox!.width).toBeGreaterThanOrEqual(1279);
    await shot(page, '3-nodes-fullscreen');
    await page.keyboard.press('Escape');
    await expect(page.locator('.memory-graph.is-fullscreen')).toHaveCount(0);
    await expect(page.locator('#agent-memory-dialog')).toBeVisible();
    await expect(page.locator('#memory-graph-canvas-fullscreen')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // 点击节点中心打开既有 MemoryDetail。
    await page.locator('#memory-graph-canvas-reset').click();
    await expect(canvas).toHaveAttribute('data-zoom', '1.00');
    const freshPoints = await readPoints(canvas);
    const freshA = freshPoints.find((point) => point.id === 'mem-a')!;
    await hoverPoint(page, canvas, freshA);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#memory-detail-text')).toBeVisible({ timeout: 15_000 });
    await page.locator('#memory-detail-close').click();
    await expect(page.locator('#memory-tab-constellation')).toBeFocused();

    await page.mouse.move(0, 0);
    const serious = (
      await new AxeBuilder({ page })
        .include('#agent-memory-dialog')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
    expect(serious.map((item) => `${item.id}(${item.impact})`)).toEqual([]);
  });

  test('390 暗色：无横向溢出、tooltip 深色、全屏、表格 Enter 与 axe', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    fixture = smallFixture();
    const calls: MemoryCall[] = [];
    await installStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    const canvas = await openConstellation(page, directRoom);

    await expect(page.locator('.memory-graph')).toHaveAttribute('data-theme', 'dark');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    const corner = await page.evaluate(() => {
      const element = document.getElementById('memory-graph-canvas') as HTMLCanvasElement;
      const context = element.getContext('2d')!;
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
    });
    expect(corner[0]).toBeLessThan(30);
    expect(corner[1]).toBeLessThan(30);
    expect(corner[2]).toBeLessThan(30);

    for (const selector of [
      '#memory-graph-canvas-hud',
      '#memory-graph-canvas-heat',
      '.memory-graph-controls',
    ]) {
      const box = await page.locator(selector).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(391);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(845);
    }

    const points = await readPoints(canvas);
    await hoverPoint(page, canvas, points.find((point) => point.id === 'mem-a')!);
    const tooltip = page.locator('.memory-graph-tooltip');
    await expect(tooltip).toBeVisible();
    expect(
      await tooltip.evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe('rgb(43, 43, 43)');
    await shot(page, '390-dark-hover');
    await page.mouse.move(0, 0);

    await page.locator('#memory-graph-canvas-fullscreen').click();
    await expect(page.locator('.memory-graph.is-fullscreen')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.memory-graph.is-fullscreen')).toHaveCount(0);

    await page.locator('#memory-graph-list tbody tr').first().locator('button').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#memory-detail-text')).toBeVisible({ timeout: 15_000 });
    const detail = await page.locator('.memory-detail-column').boundingBox();
    expect(detail).not.toBeNull();
    expect(detail!.width).toBeGreaterThanOrEqual(389);
    expect(detail!.y + detail!.height).toBeLessThanOrEqual(845);
    await page.locator('#memory-detail-close').click();

    const serious = (
      await new AxeBuilder({ page })
        .include('#agent-memory-dialog')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
    expect(serious.map((item) => `${item.id}(${item.impact})`)).toEqual([]);
  });

  test('120 节点/600 边：热度像素、HUD、按需绘制与卡片标签', async ({ page }) => {
    fixture = largeFixture();
    expect(fixture.nodes).toHaveLength(120);
    expect(fixture.edges).toHaveLength(600);
    const calls: MemoryCall[] = [];
    await installStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    const canvas = await openConstellation(page, directRoom);

    await expect(canvas).toHaveAttribute('data-node-count', '120');
    await expect(canvas).toHaveAttribute('data-edge-count', '600');
    await expect(canvas).toHaveAttribute('data-visible-count', '120');
    await expect(canvas).toHaveAttribute('data-links-drawn', '600');
    await expect(page.locator('#memory-graph-canvas-hud')).toContainText('节点 120');
    await expect(page.locator('#memory-graph-canvas-hud')).toContainText('边 600');
    const labelCount = Number(await canvas.getAttribute('data-label-count'));
    expect(labelCount).toBeGreaterThan(0);
    expect(labelCount).toBeLessThanOrEqual(120);
    expect(Number(await canvas.getAttribute('data-dpr'))).toBeLessThanOrEqual(2);

    // 120 节点一帧的实际绘制耗时（首次绘制后的稳定帧）。
    await page.waitForTimeout(150);
    const paintMs = Number(await canvas.getAttribute('data-paint-ms'));
    expect(paintMs).toBeGreaterThan(0);
    expect(paintMs).toBeLessThan(500);

    // 120 节点布局很密，中心可能被上层节点/光晕覆盖；这里验证所有节点
    // 中心附近确实出现热度色带的三段颜色，并单独校验色带端点值。
    const points = await readPoints(canvas);
    const palette = await sampleNodePalette(page, points);
    expect(palette.sampled).toBeGreaterThan(100);
    expect(palette.buckets).toEqual(expect.arrayContaining(['blue', 'purple', 'warm']));
    const sampled = await sampleCenterColors(page, points, [], 'hue');
    expect(sampled.width).toBeGreaterThan(0);
    expect(sampled.histogram.blue).toBeGreaterThan(50);
    expect(sampled.histogram.purple).toBeGreaterThan(50);
    expect(sampled.histogram.warm).toBeGreaterThan(50);
    expect(heatColor(0)).toBe('rgb(56,130,220)');
    expect(heatColor(0.5)).toBe('rgb(170,130,200)');
    expect(heatColor(1)).toBe('rgb(240,100,60)');
    await shot(page, '120-nodes-light');

    const { map: degreeMap } = degrees(fixture);

    // hover 只画该节点邻边：links-drawn 等于它的度数，而不是全图 600。
    const hub = points.find((point) => point.id === 'n1')!;
    await hoverPoint(page, canvas, hub);
    await expect(canvas).toHaveAttribute('data-hover-id', 'n1');
    await expect(canvas).toHaveAttribute('data-links-drawn', String(degreeMap.get('n1')));
    await expect(page.locator('.memory-graph-tooltip')).toContainText(
      `${degreeMap.get('n1')} 条连接`,
    );
    await shot(page, '120-nodes-hover');
    await page.mouse.move(0, 0);

    // 没有持续 RAF：稳定后等待 400ms，绘制计数不增长。
    await page.waitForTimeout(200);
    const paintCount = Number(await canvas.getAttribute('data-paint-count'));
    await page.waitForTimeout(400);
    expect(Number(await canvas.getAttribute('data-paint-count'))).toBe(paintCount);

    // 放大到 >150% 后进入卡片标签。
    for (let step = 0; step < 4; step += 1) {
      await page.locator('#memory-graph-canvas-zoom-in').click();
    }
    await expect(page.locator('.memory-graph-zoom')).toHaveText('244%');
    await expect(canvas).toHaveAttribute('data-label-mode', 'card');
    expect(Number(await canvas.getAttribute('data-label-count'))).toBeGreaterThan(0);
    await page.locator('#memory-graph-canvas-reset').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('100%');
  });
});
