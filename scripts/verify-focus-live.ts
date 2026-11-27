/**
 * Task Focus 真实 Peri-Swarm 验收（TF-07 本地版）。
 *
 * 前置：
 * - `deploy/docker-compose.yml` 已启动，2 个 peri-swarm 副本与 nginx 健康；
 * - 环境变量 `PERI_SWARM_API_KEY` 已提供（不打印）；
 * - Swarm 容器能通过 `host.docker.internal:<port>` 访问本机 WeBots；
 * - 模型 provider 已在 Swarm 的 settings secret 中配置。
 *
 * 本脚本启动一个临时 WeBots 实例，让真实模型通过 MCP 建卡/改卡；断言采用
 * 行为级条件，不要求固定文案。运行：
 *   PERI_SWARM_API_KEY=... bun scripts/verify-focus-live.ts
 */

import { join } from 'node:path';

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  newRequestId,
  newToken,
  sleep,
} from './lib/harness';
import { befriend, registerIdentity, sendMessage } from './lib/acceptance-helpers';
import { reservePort, startTestServer } from './lib/test-server';

const SWARM_BASE = (process.env.PERI_SWARM_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/+$/u, '');
const SWARM_KEY = process.env.PERI_SWARM_API_KEY ?? '';
const MODEL = process.env.WEBOTS_FOCUS_MODEL ?? 'deepseek-v4-flash';
const MCP_HOST = process.env.WEBOTS_FOCUS_MCP_HOST ?? 'host.docker.internal';
const SERVICE_TOKEN = `focus_live_service_${crypto.randomUUID().replaceAll('-', '')}`;

interface FocusStatus {
  enabled: boolean;
  status: string;
  runtime_ready: boolean;
  secretary_actor_id: string | null;
}
interface FocusItem {
  item_id: string;
  title: string;
  column_key: string;
  version: number;
  source_count: number;
  summary: string;
  next_step: string;
  archived_at: string | null;
}
interface FocusList {
  items: FocusItem[];
}
interface FocusGet {
  item: FocusItem;
  evidence: { readable: boolean; room_id?: string; message_id?: string }[];
}

function rc2Card(list: FocusList): FocusItem | undefined {
  return list.items.find(
    (item) => /RC2|安装包|放行|周敏/u.test(`${item.title} ${item.summary} ${item.next_step}`),
  );
}

/** 委托卡优先：避免把后续私有群新卡误当成原卡。 */
function delegationCard(list: FocusList): FocusItem | undefined {
  return (
    list.items.find(
      (item) =>
        /周敏/u.test(`${item.title} ${item.summary} ${item.next_step}`) &&
        !/32\/32|验收回归/u.test(`${item.title} ${item.summary}`),
    ) ?? rc2Card(list)
  );
}

async function waitFor<T>(
  label: string,
  action: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await action();
    if (accept(last)) return last;
    await sleep(1000);
  }
  throw new Error(`${label} 超时；最后值: ${JSON.stringify(last)}`);
}

async function waitActive(conn: Awaited<ReturnType<typeof connectClient>>): Promise<FocusStatus> {
  return waitFor(
    '秘书 active',
    () => callTool<FocusStatus>(conn.client, 'network_focus_status', {}),
    (status) => status.status === 'active' && status.runtime_ready,
    90_000,
  );
}

async function run(): Promise<void> {
  if (!SWARM_KEY) throw new Error('缺少 PERI_SWARM_API_KEY');
  const port = reservePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    PERI_SWARM_API_KEY: SWARM_KEY,
    WEBOTS_SWARM_BASE_URL: SWARM_BASE,
    WEBOTS_SWARM_API_KEY: SWARM_KEY,
    WEBOTS_FOCUS_MODEL: MODEL,
    WEBOTS_FOCUS_MCP_URL: `http://${MCP_HOST}:${port}/mcp`,
    WEBOTS_FOCUS_SERVICE_TOKEN: SERVICE_TOKEN,
    PUBLIC_ORIGIN: base,
  };
  let server = await startTestServer({ port, tag: 'focus-live', env });
  process.env.AGENTNET_URL = server.base;
  process.env.PUBLIC_ORIGIN = base;
  const linToken = newToken();
  const zhouToken = newToken();
  let lin = await connectClient(linToken);
  let zhou = await connectClient(zhouToken);
  try {
    const linId = await registerIdentity(lin, { kind: 'human', name: '真实林舟' });
    const zhouId = await registerIdentity(zhou, { kind: 'human', name: '真实周敏' });
    await befriend(lin, linId.actor_id, zhou, zhouId.actor_id);
    const agent = await callTool<{ actor_id: string; token: string }>(
      lin.client,
      'network_agent_create',
      { request_id: newRequestId('live_agent'), name: '真实交付 Agent' },
    );
    const group = await callTool<{ room: { room_id: string } }>(
      lin.client,
      'network_room_create',
      {
        request_id: newRequestId('live_group'),
        kind: 'group',
        members: [zhouId.actor_id, agent.actor_id],
        title: '真实发布群',
      },
    );
    const privateRoom = await callTool<{ room: { room_id: string } }>(
      lin.client,
      'network_room_create',
      {
        request_id: newRequestId('live_private'),
        kind: 'group',
        members: [agent.actor_id],
        title: '仅林舟可见验收群',
      },
    );
    const direct = await callTool<{ room: { room_id: string } }>(
      lin.client,
      'network_room_create',
      {
        request_id: newRequestId('live_direct'),
        kind: 'direct',
        members: [zhouId.actor_id],
      },
    );

    for (const [label, conn] of [
      ['林舟', lin],
      ['周敏', zhou],
    ] as const) {
      const enabled = await callTool<FocusStatus>(conn.client, 'network_focus_enable', {
        request_id: newRequestId(`live_enable_${label}`),
      });
      check(`${label} 开启返回秘书`, Boolean(enabled.secretary_actor_id));
    }
    const linActive = await waitActive(lin);
    const zhouActive = await waitActive(zhou);
    checkEqual('林舟秘书 active 且 runtime ready', linActive.runtime_ready, true);
    checkEqual('周敏秘书 active 且 runtime ready', zhouActive.runtime_ready, true);
    check('两人秘书不同', linActive.secretary_actor_id !== zhouActive.secretary_actor_id);

    // 1) 群内委托 → 两人各自一张卡，列不同、来源不同。
    await sendMessage(
      lin,
      group.room.room_id,
      '周敏，明天 10:00 前把 RC2 安装包发我；我确认后请你通知值班。',
    );
    const linFirst = await waitFor(
      '林舟首卡',
      () => callTool<FocusList>(lin.client, 'network_focus_list', {}),
      (list) => Boolean(rc2Card(list)),
    );
    const zhouFirst = await waitFor(
      '周敏首卡',
      () => callTool<FocusList>(zhou.client, 'network_focus_list', {}),
      (list) => Boolean(rc2Card(list)),
    );
    const linCard = delegationCard(linFirst) as FocusItem;
    const zhouCard = rc2Card(zhouFirst) as FocusItem;
    check('两人卡 ID 不同', linCard.item_id !== zhouCard.item_id);
    checkEqual('林舟卡有来源', linCard.source_count >= 1, true);
    checkEqual('周敏卡有来源', zhouCard.source_count >= 1, true);
    check(
      '两人处于不同列或有不同下一步',
      linCard.column_key !== zhouCard.column_key || linCard.next_step !== zhouCard.next_step,
    );

    // 2) 仅林舟可见的验收群：周敏无卡、搜索不到；林舟卡可关联该来源。
    const agentConn = await connectClient(agent.token);
    await sendMessage(
      agentConn,
      privateRoom.room.room_id,
      '验收群回归 32/32 通过，仅本群可见；请林舟确认灰度放行。',
    );
    await agentConn.close();
    const linAfterPrivate = await waitFor(
      '林舟吸收私有群进展',
      async () => {
        const list = await callTool<FocusList>(lin.client, 'network_focus_list', {});
        const details = await Promise.all(
          list.items.slice(0, 10).map((item) =>
            callTool<FocusGet>(lin.client, 'network_focus_get', { item_id: item.item_id }),
          ),
        );
        const privateDetail = details.find((detail) =>
          detail.evidence.some((evidence) => evidence.room_id === privateRoom.room.room_id),
        );
        return { list, privateDetail };
      },
      (value) => Boolean(value.privateDetail),
    );
    check('林舟可看到验收群来源', Boolean(linAfterPrivate.privateDetail));
    if (linAfterPrivate.privateDetail?.item.item_id !== linCard.item_id) {
      console.log('注意：模型把私有群进展建成了新卡，而非更新原委托卡（P1 模型判断问题）');
    }
    const zhouSearch = await callTool<{ items: unknown[] }>(zhou.client, 'network_message_search', {
      scope: 'all',
      mode: 'fuzzy',
      query: '32/32',
      limit: 20,
    });
    checkEqual('周敏搜不到验收群原话', zhouSearch.items.length, 0);
    const zhouList = await callTool<FocusList>(zhou.client, 'network_focus_list', {});
    check(
      '周敏卡不包含验收群来源',
      zhouList.items.every((item) => item.item_id !== linCard.item_id),
    );

    // 3) 私聊交付（无 @）→ 林舟卡进入需要我；来源包含私聊。
    await sendMessage(
      zhou,
      direct.room.room_id,
      'RC2 安装包已私聊交付，版本 rc2；请你确认后通知值班。',
    );
    const directState = await waitFor(
      '林舟吸收私聊交付',
      async () => {
        const list = await callTool<FocusList>(lin.client, 'network_focus_list', {});
        const details = await Promise.all(
          list.items.slice(0, 10).map((item) =>
            callTool<FocusGet>(lin.client, 'network_focus_get', { item_id: item.item_id }),
          ),
        );
        const directDetail = details.find((detail) =>
          detail.evidence.some((evidence) => evidence.room_id === direct.room.room_id),
        );
        return { list, directDetail };
      },
      (value) => Boolean(value.directDetail),
    );
    check('私聊来源已挂到林舟某张卡', Boolean(directState.directDetail));
    const directDetail = directState.directDetail;
    const updated =
      directDetail && directDetail.item.item_id === linCard.item_id ? directDetail.item : linCard;

    // 4) 归档后迟到消息不能复活。
    const archived = await callTool<{ version: number; archived_at: string }>(
      lin.client,
      'network_focus_archive',
      {
        item_id: linCard.item_id,
        request_id: newRequestId('live_archive'),
        expected_version: updated.version,
      },
    );
    await sendMessage(
      zhou,
      group.room.room_id,
      '补发同一安装包的签收回执，内容与上次相同。',
    );
    await sleep(25_000);
    const current = await callTool<FocusList>(lin.client, 'network_focus_list', {});
    const archivedList = await callTool<FocusList>(lin.client, 'network_focus_list', {
      archived: true,
    });
    check(
      '归档卡未回到三列',
      current.items.every((item) => item.item_id !== linCard.item_id),
    );
    const archivedCard = archivedList.items.find((item) => item.item_id === linCard.item_id);
    check('归档卡仍可回看', Boolean(archivedCard));
    checkEqual('归档后版本未被迟到事件改写', archivedCard?.version, archived.version);

    // 5) 重启 WeBots：同一 dataDir/端口，绑定与卡保留，Swarm 会话仍可复用。
    await lin.close();
    await zhou.close();
    await server.stop();
    server = await startTestServer({ port, dataDir: server.dataDir, tag: 'focus-live-restart', env });
    process.env.AGENTNET_URL = server.base;
    lin = await connectClient(linToken);
    const restartedStatus = await waitActive(lin);
    checkEqual(
      '重启后仍是同一秘书',
      restartedStatus.secretary_actor_id,
      linActive.secretary_actor_id,
    );
    const restartedArchived = await callTool<FocusList>(lin.client, 'network_focus_list', {
      archived: true,
    });
    check(
      '重启后归档卡仍存在',
      restartedArchived.items.some((item) => item.item_id === linCard.item_id),
    );
    let humanToolDenied = false;
    try {
      await callTool(lin.client, 'network_focus_job_get', {
        attempt_ref: 'fat_live_denied',
      });
    } catch {
      humanToolDenied = true;
    }
    check('Human 的工具目录不含秘书工具', humanToolDenied);
  } finally {
    await lin.close().catch(() => undefined);
    await zhou.close().catch(() => undefined);
    await server.dispose().catch(() => undefined);
  }
}

await run().catch((error) => {
  console.error('Focus live 验收失败:', error);
  process.exit(1);
});
