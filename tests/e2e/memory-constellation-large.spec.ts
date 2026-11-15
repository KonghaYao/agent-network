import { expect, test, type Page } from '@playwright/test';

import { createIdentity, login, row, type SuiteIdentity } from './fixtures/memory-constellation';
import {
  callsOf,
  installMemoryFenixStub,
  type FenixRow,
  type MemoryCall,
} from './fixtures/memory-fenix';

/**
 * 大图回归：120 个节点仍只取一次 graph，星座图渲染不抛错，
 * 切到表格后仍是同一份 `table_rows` 的本地窗口。
 */

async function openMemory(page: Page, directRoom: string): Promise<void> {
  await page.locator('#room-filter-agent').click();
  const listRow = row(page, directRoom);
  await expect(listRow).toBeVisible({ timeout: 15_000 });
  await listRow.click({ button: 'right' });
  await page.locator('#room-row-menu-memory').click();
  await expect(page.locator('#agent-memory-dialog')).toBeVisible({ timeout: 15_000 });
}

function largeRows(count: number): FenixRow[] {
  return Array.from({ length: count }, (_, index) => {
    const day = String((index % 28) + 1).padStart(2, '0');
    const month = String(((index + 3) % 12) + 1).padStart(2, '0');
    return {
      id: `large-${index}`,
      text: `Large graph memory ${index}`,
      fact_type: 'world',
      state: 'valid',
      occurred_at: `2026-${month}-${day}T09:00:00.000Z`,
      occurred_start: `2026-${month}-${day}T09:00:00.000Z`,
      occurred_end: null,
      mentioned_at: `2026-${month}-${day}T10:00:00.000Z`,
      entities: [`entity-${index % 40}`],
      proof_count: 1,
      tags: [],
    };
  });
}

test.describe('Fenix 星座图移植（大图）', () => {
  let identity: SuiteIdentity;

  test.beforeAll(async () => {
    identity = await createIdentity();
  });

  test('120 节点：一次 graph、canvas 可读标签、表格本地窗口无新请求', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorId: identity.agentId,
      actorName: identity.agentName,
      rows: largeRows(120),
      totalUnits: 120,
    });
    await login(page, identity.base, identity.token);
    await openMemory(page, identity.directRoom);

    const canvas = page.locator('.fenix-constellation-canvas');
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    await expect(canvas).toHaveAttribute('aria-label', /记忆星座图（120 个节点）/);
    const graphCalls = callsOf(calls, 'network_agent_memory_graph');
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]!.args.include_rows).toBe(true);

    await page.getByRole('button', { name: '表格' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(100);
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(20);
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);

    await page.getByRole('button', { name: '时间线' }).click();
    await expect(page.locator('[data-fenix-memory-content]')).toContainText('S:', { timeout: 15_000 });
    expect(callsOf(calls, 'network_agent_memory_graph')).toHaveLength(1);

    expect(pageErrors).toEqual([]);
  });
});
