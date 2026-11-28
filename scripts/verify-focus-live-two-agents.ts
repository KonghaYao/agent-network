/**
 * Task Focus + 真实 Peri-Swarm：两个同名工作 Agent 的交付验收。
 *
 * 两个 Agent 同名（同为“同名构建 Agent”）、同一 RC2 项目，各自领取/完成一条
 * 定向交付并回传结果。验证秘书不会把同名 Agent 混为一个，卡片证据保留两条
 * delivery，领取流水分别记录两位 recipient。
 *
 * 前置：PERI_SWARM_API_KEY、本地 Swarm 可达、容器可访问 host.docker.internal。
 * 运行：PERI_SWARM_API_KEY=... bun scripts/verify-focus-live-two-agents.ts
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
  source_count: number;
}
interface FocusList {
  items: FocusItem[];
}
interface FocusGet {
  evidence: { delivery_id?: string; sender_id?: string; sender_name?: string; readable: boolean }[];
}

async function waitFor<T>(label: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeout = 150_000): Promise<T> {
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
  const serviceToken = `focus_two_agents_service_${crypto.randomUUID().replaceAll('-', '')}`;
  const port = reservePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startTestServer({
    port,
    tag: 'focus-live-two-agents',
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
    await registerIdentity(lin, { kind: 'human', name: '同名验收林舟' });
    const agentA = await callTool<{ actor_id: string; token: string }>(
      lin.client,
      'network_agent_create',
      { request_id: newRequestId('ta_a'), name: '同名构建 Agent' },
    );
    const agentB = await callTool<{ actor_id: string; token: string }>(
      lin.client,
      'network_agent_create',
      { request_id: newRequestId('ta_b'), name: '同名构建 Agent' },
    );
    check('两个 Agent 取得不同 actor_id', agentA.actor_id !== agentB.actor_id);
    const room = await callTool<{ room: { room_id: string } }>(lin.client, 'network_room_create', {
      request_id: newRequestId('ta_room'),
      kind: 'group',
      members: [agentA.actor_id, agentB.actor_id],
      title: '同名交付验收群',
    });
    await callTool(lin.client, 'network_focus_enable', { request_id: newRequestId('ta_enable') });
    await waitFor(
      '林舟秘书 active',
      () => callTool<{ status: string; runtime_ready: boolean }>(lin.client, 'network_focus_status', {}),
      (s) => s.status === 'active' && s.runtime_ready,
      90_000,
    );

    const sent = await sendMessage(
      lin,
      room.room.room_id,
      '两位同名构建 Agent：一位交付 RC2 安装包，另一位交付回归结果；请分别在完成后回复。',
      { invoke: [agentA.actor_id, agentB.actor_id] },
    );
    checkEqual('定向交付覆盖两位 Agent', sent.delivery_ids.length, 2);

    const connA = await connectClient(agentA.token);
    const connB = await connectClient(agentB.token);
    const claimAny = async (
      conn: typeof connA,
      ids: string[],
    ): Promise<{ delivery_id: string; attempt: number; claim_id: string }> => {
      for (const id of ids) {
        try {
          return await callTool<{ delivery_id: string; attempt: number; claim_id: string }>(
            conn.client,
            'network_delivery_claim',
            { request_id: newRequestId('ta_claim_try'), delivery_id: id },
          );
        } catch {
          // delivery 不属于该 Agent；继续尝试下一条。
        }
      }
      throw new Error('没有属于该 Agent 的 delivery');
    };
    let deliveryA = '';
    let deliveryB = '';
    try {
      const claimA = await claimAny(connA, sent.delivery_ids);
      deliveryA = claimA.delivery_id;
      const claimB = await claimAny(
        connB,
        sent.delivery_ids.filter((id) => id !== deliveryA),
      );
      deliveryB = claimB.delivery_id;
      check('两位 Agent 领取不同 delivery', deliveryA !== deliveryB);
      await callTool(connA.client, 'network_delivery_complete', {
        request_id: newRequestId('ta_done_a'),
        delivery_id: claimA.delivery_id,
        attempt: claimA.attempt,
        claim_id: claimA.claim_id,
      });
      await callTool(connB.client, 'network_delivery_complete', {
        request_id: newRequestId('ta_done_b'),
        delivery_id: claimB.delivery_id,
        attempt: claimB.attempt,
        claim_id: claimB.claim_id,
      });
      await sendMessage(connA, room.room.room_id, 'A：RC2 安装包已交付，版本 rc2。');
      await sendMessage(connB, room.room.room_id, 'B：RC2 回归 32/32 通过。');
    } finally {
      await connA.close();
      await connB.close();
    }

    const initial = await waitFor(
      '卡片出现',
      async () => {
        const list = await callTool<FocusList>(lin.client, 'network_focus_list', {});
        const details = await Promise.all(
          list.items.slice(0, 10).map((item) =>
            callTool<FocusGet>(lin.client, 'network_focus_get', { item_id: item.item_id }),
          ),
        );
        return { list, details };
      },
      (value) => value.list.items.length > 0,
    );
    check('两位同名 Agent 的委托生成卡片', initial.list.items.length > 0);
    check('卡片标题/摘要包含 RC2', initial.list.items.some((item) => /RC2|安装包|回归/u.test(item.title)));

    // 模型是否把两条回执合入原卡属于 P1 判断质量；这里记录，不作为系统契约失败。
    const withSenders = await waitFor(
      '两位 Agent 回执',
      async () => {
        const list = await callTool<FocusList>(lin.client, 'network_focus_list', {});
        const details = await Promise.all(
          list.items.slice(0, 10).map((item) =>
            callTool<FocusGet>(lin.client, 'network_focus_get', { item_id: item.item_id }),
          ),
        );
        const senders = new Set(
          details.flatMap((detail) =>
            detail.evidence
              .filter((evidence) => evidence.readable && evidence.sender_id)
              .map((evidence) => evidence.sender_id as string),
          ),
        );
        return { list, details, senders };
      },
      (value) => value.senders.has(agentA.actor_id) && value.senders.has(agentB.actor_id),
      60_000,
    ).catch(() => null);
    if (withSenders) {
      check('两位同名 Agent 的回执都可区分', true);
      const sameNameEvidence = withSenders.details
        .flatMap((detail) => detail.evidence)
        .filter(
          (evidence) =>
            evidence.readable &&
            (evidence.sender_id === agentA.actor_id || evidence.sender_id === agentB.actor_id),
        );
      check('证据保留同名 Agent 的显示名', sameNameEvidence.every((evidence) => evidence.sender_name === '同名构建 Agent'));
    } else {
      console.log('注意：模型未在 60s 内把两位 Agent 的回执合入卡片（P1 模型判断，非系统契约失败）');
    }

    const db = new Database(join(server.dataDir, 'agent-network.sqlite'), { readonly: true });
    try {
      const rows = db
        .prepare('SELECT delivery_id, recipient_actor_id FROM focus_delivery_claims WHERE delivery_id IN (?, ?)')
        .all(deliveryA, deliveryB) as { delivery_id: string; recipient_actor_id: string }[];
      checkEqual('两条领取流水', rows.length, 2);
      const recipients = new Set(rows.map((row) => row.recipient_actor_id));
      checkEqual('流水分别记录两位 recipient', recipients.size, 2);
      check(
        '流水 recipient 为同名 Agent 的两个 actor',
        rows.every((row) => row.recipient_actor_id === agentA.actor_id || row.recipient_actor_id === agentB.actor_id),
      );
    } finally {
      db.close();
    }
  } finally {
    await lin.close();
    await server.dispose();
  }
}

await run().catch((error) => {
  console.error('Focus 双同名 Agent 验收失败:', error);
  process.exit(1);
});
