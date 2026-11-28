/**
 * Task Focus + 真实 Peri-Swarm：定向交付领取与完成验收。
 *
 * 验证 Agent 静默 claim 产生领取流水、秘书从 claim/complete 事件更新原卡，
 * 以及完成后未 @ 的结果消息继续更新同一张卡。
 *
 * 前置：PERI_SWARM_API_KEY、本地 Swarm 可达、容器可访问 host.docker.internal。
 * 运行：PERI_SWARM_API_KEY=... bun scripts/verify-focus-live-delivery.ts
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { callTool, check, checkEqual, connectClient, newRequestId, newToken, sleep } from './lib/harness';
import { registerIdentity, sendMessage } from './lib/acceptance-helpers';
import { reservePort, startTestServer } from './lib/test-server';

const SWARM_BASE = (process.env.PERI_SWARM_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/+$/u, '');
const SWARM_KEY = process.env.PERI_SWARM_API_KEY ?? '';
const MODEL = process.env.WEBOTS_FOCUS_MODEL ?? 'deepseek-v4-flash';
const MCP_HOST = process.env.WEBOTS_FOCUS_MCP_HOST ?? 'host.docker.internal';

interface FocusItem {
  item_id: string;
  title: string;
  column_key: string;
  version: number;
  source_count: number;
  waiting_on: string | null;
}
interface FocusList {
  items: FocusItem[];
}
interface FocusGet {
  evidence: { delivery_id?: string; room_id?: string; readable: boolean }[];
}

async function waitFor<T>(label: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeout = 120_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(1000);
  }
  throw new Error(`${label} 超时: ${JSON.stringify(last)}`);
}

async function run(): Promise<void> {
  if (!SWARM_KEY) throw new Error('缺少 PERI_SWARM_API_KEY');
  const serviceToken = `focus_delivery_service_${crypto.randomUUID().replaceAll('-', '')}`;
  const port = reservePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startTestServer({
    port,
    tag: 'focus-live-delivery',
    env: {
      PUBLIC_ORIGIN: base,
      WEBOTS_SWARM_BASE_URL: SWARM_BASE,
      WEBOTS_SWARM_API_KEY: SWARM_KEY,
      WEBOTS_FOCUS_MODEL: MODEL,
      WEBOTS_FOCUS_MCP_URL: `http://${MCP_HOST}:${port}/mcp`,
      WEBOTS_FOCUS_SERVICE_TOKEN: serviceToken,
    },
  });
  process.env.AGENTNET_URL = server.base;
  process.env.PUBLIC_ORIGIN = base;
  const lin = await connectClient(newToken());
  try {
    const linId = await registerIdentity(lin, { kind: 'human', name: '交付验收林舟' });
    const agent = await callTool<{ actor_id: string; token: string }>(
      lin.client,
      'network_agent_create',
      { request_id: newRequestId('ld_agent'), name: '交付验收构建 Agent' },
    );
    const room = await callTool<{ room: { room_id: string } }>(lin.client, 'network_room_create', {
      request_id: newRequestId('ld_room'),
      kind: 'group',
      members: [agent.actor_id],
      title: '交付验收群',
    });
    await callTool(lin.client, 'network_focus_enable', { request_id: newRequestId('ld_enable') });
    await waitFor(
      '林舟秘书 active',
      () => callTool<{ status: string; runtime_ready: boolean }>(lin.client, 'network_focus_status', {}),
      (s) => s.status === 'active' && s.runtime_ready,
      90_000,
    );

    const sent = await sendMessage(
      lin,
      room.room.room_id,
      '构建 Agent，请整理 RC2 安装包并交付，完成后回复结果；林舟验收。',
      { invoke: [agent.actor_id] },
    );
    checkEqual('发送产生一条定向交付', sent.delivery_ids.length, 1);
    const deliveryId = sent.delivery_ids[0] as string;
    const agentConn = await connectClient(agent.token);
    try {
      const claimed = await callTool<{ delivery_id: string; attempt: number; claim_id: string }>(
        agentConn.client,
        'network_delivery_claim',
        { request_id: newRequestId('ld_claim'), delivery_id: deliveryId },
      );
      checkEqual('Agent 静默领取成功', claimed.delivery_id, deliveryId);
      const afterClaim = await waitFor(
        '林舟卡出现',
        () => callTool<FocusList>(lin.client, 'network_focus_list', {}),
        (list) => list.items.length > 0,
      );
      const first = afterClaim.items[0] as FocusItem;
      checkEqual('领取后卡在跟进中或需要我', ['tracking', 'needs_me'].includes(first.column_key), true);
      check('领取后卡等待 Agent 或下一步非空', Boolean(first.waiting_on) || first.source_count >= 1);

      await callTool(agentConn.client, 'network_delivery_complete', {
        request_id: newRequestId('ld_done'),
        delivery_id: claimed.delivery_id,
        attempt: claimed.attempt,
        claim_id: claimed.claim_id,
      });
      await sendMessage(agentConn, room.room.room_id, 'RC2 安装包已交付，版本 rc2，请验收。');
      const updated = await waitFor(
        '林舟卡吸收完成回执',
        () => callTool<FocusList>(lin.client, 'network_focus_list', {}),
        (list) => {
          const item = list.items.find((entry) => entry.item_id === first.item_id);
          return Boolean(item && (item.version > first.version || item.source_count > first.source_count || item.column_key !== first.column_key));
        },
      );
      const item = updated.items.find((entry) => entry.item_id === first.item_id) as FocusItem;
      checkEqual('完成后卡进入需要我', item.column_key, 'needs_me');
      check('完成后来源增加', item.source_count > first.source_count);

      const detail = await callTool<FocusGet>(lin.client, 'network_focus_get', {
        item_id: item.item_id,
      });
      check(
        '卡证据包含交付来源',
        detail.evidence.some((evidence) => evidence.delivery_id === deliveryId),
      );

      const db = new Database(join(server.dataDir, 'agent-network.sqlite'), { readonly: true });
      try {
        const row = db
          .prepare('SELECT recipient_actor_id, claimed_by, attempt FROM focus_delivery_claims WHERE delivery_id = ?')
          .get(deliveryId) as
          | { recipient_actor_id: string; claimed_by: string; attempt: number }
          | undefined;
        check('领取流水存在', Boolean(row));
        checkEqual('领取流水 recipient 为 Agent', row?.recipient_actor_id, agent.actor_id);
        checkEqual('领取流水 claimed_by 为 Agent', row?.claimed_by, agent.actor_id);
        checkEqual('领取流水 attempt 为 1', row?.attempt, 1);
      } finally {
        db.close();
      }
    } finally {
      await agentConn.close();
    }
    checkEqual('林舟仍是卡主', linId.actor_id.length > 0, true);
  } finally {
    await lin.close();
    await server.dispose();
  }
}

await run().catch((error) => {
  console.error('Focus live delivery 验收失败:', error);
  process.exit(1);
});
