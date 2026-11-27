/**
 * Task Focus HTTP 端到端验收。
 *
 * 启动真实 Bun 服务 + 假 Peri-Swarm：两位 Human 启用秘书、共享群发消息、
 * Watch 组批、服务身份通过 HTTP MCP 调度四个秘书工具建卡；验证 owner 隔离、
 * 归档屏障、停服重启后的绑定/卡恢复与普通 Human 越权拒绝。
 *
 * 本脚本不运行真实模型：测试脚本扮演确定性秘书，验证 WeBots 的业务链路与
 * 远端契约；模型判断质量属于外部联调项。
 *
 * 运行：bun scripts/verify-focus-e2e.ts
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  sleep,
  ToolError,
} from './lib/harness';
import { befriend, registerIdentity, sendMessage } from './lib/acceptance-helpers';
import { startFocusFakeSwarm } from './lib/focus-fake-swarm';
import { reservePort, startTestServer } from './lib/test-server';

const SERVICE_TOKEN = `focus_e2e_service_${crypto.randomUUID().replaceAll('-', '')}`;

interface FocusStatus {
  enabled: boolean;
  status: string;
  counts: { needs_me: number; tracking: number; done: number; archived: number };
  secretary_actor_id: string | null;
  runtime_ready: boolean;
}

interface FocusList {
  items: {
    item_id: string;
    title: string;
    column_key: string;
    version: number;
    archived_at: string | null;
  }[];
}

interface FocusJob {
  job_id: string;
  attempt_ref: string;
  owner_name: string;
  candidates: { candidate_id: string; message_id: string | null; delivery_id: string | null }[];
}

interface FocusReceipt {
  items: { item_id: string; version: number }[];
}

interface PendingSubmit {
  index: number;
  attemptRef: string;
}

function focusEnv(fakeUrl: string, base: string): Record<string, string> {
  return {
    DRIVE_DISABLED: '1',
    WEBOTS_SWARM_BASE_URL: fakeUrl,
    WEBOTS_SWARM_API_KEY: 'focus-e2e-swarm-key',
    WEBOTS_FOCUS_MODEL: 'focus-e2e-model',
    WEBOTS_FOCUS_MCP_URL: `${base}/mcp`,
    WEBOTS_FOCUS_SERVICE_TOKEN: SERVICE_TOKEN,
  };
}

function submitText(request: { body: unknown }): string {
  const body = request.body as
    | { events?: { input?: { content?: { text?: string }[] }[] }[] }
    | null;
  return body?.events?.[0]?.input?.[0]?.content?.[0]?.text ?? '';
}

async function waitForSubmit(
  fake: ReturnType<typeof startFocusFakeSwarm>,
  fromIndex: number,
): Promise<PendingSubmit> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    for (let index = fromIndex; index < fake.requests.length; index += 1) {
      const request = fake.requests[index];
      if (!request) continue;
      if (request.method !== 'POST' || !request.path.endsWith('/events')) continue;
      const text = submitText(request);
      const match = /attempt_ref: (\S+)/u.exec(text);
      if (match && match[1]) return { index: index + 1, attemptRef: match[1] };
    }
    await sleep(50);
  }
  throw new Error('等待秘书作业超时');
}

async function collectJobs(
  fake: ReturnType<typeof startFocusFakeSwarm>,
  fromIndex: number,
  service: Awaited<ReturnType<typeof connectClient>>,
  expected: number,
): Promise<{ entries: { attemptRef: string; job: FocusJob }[]; cursor: number }> {
  const entries: { attemptRef: string; job: FocusJob }[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + 15_000;
  while (entries.length < expected && Date.now() < deadline) {
    for (let index = fromIndex; index < fake.requests.length && entries.length < expected; index += 1) {
      const request = fake.requests[index];
      if (!request) continue;
      if (request.method !== 'POST' || !request.path.endsWith('/events')) continue;
      const match = /attempt_ref: (\S+)/u.exec(submitText(request));
      const attemptRef = match?.[1];
      if (!attemptRef || seen.has(attemptRef)) continue;
      seen.add(attemptRef);
      entries.push({ attemptRef, job: await getJob(service, attemptRef) });
    }
    if (entries.length < expected) await sleep(50);
  }
  if (entries.length < expected) throw new Error(`等待 ${expected} 个秘书作业超时`);
  return { entries, cursor: fake.requests.length };
}

async function waitActive(
  connection: Awaited<ReturnType<typeof connectClient>>,
): Promise<FocusStatus> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await callTool<FocusStatus>(connection.client, 'network_focus_status', {});
    if (status.status === 'active') return status;
    if (status.status === 'failed') throw new Error('秘书开通失败');
    await sleep(100);
  }
  throw new Error('等待秘书 active 超时');
}

async function getJob(
  service: Awaited<ReturnType<typeof connectClient>>,
  attemptRef: string,
): Promise<FocusJob> {
  return callTool<FocusJob>(service.client, 'network_focus_job_get', {
    attempt_ref: attemptRef,
  });
}

async function commit(
  service: Awaited<ReturnType<typeof connectClient>>,
  attemptRef: string,
  decisions: unknown[],
  complete = true,
): Promise<FocusReceipt> {
  return callTool<FocusReceipt>(service.client, 'network_focus_commit', {
    attempt_ref: attemptRef,
    decision_id: newRequestId('e2e_decision'),
    complete,
    decisions,
  });
}

async function run(): Promise<void> {
  const fake = startFocusFakeSwarm();
  const port = reservePort();
  const base = `http://127.0.0.1:${port}`;
  let server = await startTestServer({ port, tag: 'focus-e2e', env: focusEnv(fake.url, base) });
  process.env.AGENTNET_URL = server.base;
  const tokenA = newToken();
  const tokenB = newToken();
  let lin = await connectClient(tokenA);
  let zhou = await connectClient(tokenB);
  const service = await connectClient(SERVICE_TOKEN);
  try {
    const linId = await registerIdentity(lin, { kind: 'human', name: '林舟' });
    const zhouId = await registerIdentity(zhou, { kind: 'human', name: '周敏' });
    await befriend(lin, linId.actor_id, zhou, zhouId.actor_id);

    const room = await callTool<{ room: { room_id: string } }>(
      lin.client,
      'network_room_create',
      {
        request_id: newRequestId('e2e_room'),
        kind: 'group',
        members: [zhouId.actor_id],
        title: '版本发布群',
      },
    );
    const roomId = room.room.room_id;

    const linEnable = await callTool<FocusStatus>(lin.client, 'network_focus_enable', {
      request_id: newRequestId('e2e_enable_lin'),
    });
    const zhouEnable = await callTool<FocusStatus>(zhou.client, 'network_focus_enable', {
      request_id: newRequestId('e2e_enable_zhou'),
    });
    check('林舟开启得到秘书', Boolean(linEnable.secretary_actor_id));
    check('周敏得到不同秘书', linEnable.secretary_actor_id !== zhouEnable.secretary_actor_id);
    await waitActive(lin);
    await waitActive(zhou);

    // 1) 同一条群消息 → 两位 owner 各自一张卡、不同列。
    const first = await sendMessage(
      lin,
      roomId,
      '回归和安装包齐了，由我拍板。周敏交包，我确认后请你通知值班。',
    );
    const firstMessageId = first.message.message_id;

    let cursor = 0;
    const firstBatch = await collectJobs(fake, cursor, service, 2);
    cursor = firstBatch.cursor;
    const linJobRef = firstBatch.entries.find((entry) => entry.job.owner_name === '林舟');
    const zhouJobRef = firstBatch.entries.find((entry) => entry.job.owner_name === '周敏');
    check('两位 owner 各自得到一个作业', Boolean(linJobRef && zhouJobRef));
    const firstJob = linJobRef!.job;
    const linCandidate = firstJob.candidates.find((item) => item.message_id === firstMessageId);
    check('作业包含原消息候选', Boolean(linCandidate));
    const otherCandidates = firstJob.candidates.filter((item) => item !== linCandidate);
    const linReceipt = await commit(service, linJobRef!.attemptRef, [
      {
        type: 'create',
        title: '确认 RC2 灰度放行',
        column_key: 'tracking',
        next_step: '等回归结果和周敏交包',
        summary: '由我拍板放行',
        evidence: [{ candidate_id: linCandidate!.candidate_id, purpose: 'request' }],
      },
      ...otherCandidates.map((item) => ({
        type: 'ignore' as const,
        candidate_ids: [item.candidate_id],
        reason: '本轮只处理放行卡',
      })),
    ]);

    const zhouJob = zhouJobRef!.job;
    const zhouCandidate = zhouJob.candidates.find((item) => item.message_id === firstMessageId);
    const zhouOther = zhouJob.candidates.filter((item) => item !== zhouCandidate);
    const zhouReceipt = await commit(service, zhouJobRef!.attemptRef, [
      {
        type: 'create',
        title: '交付 RC2 并通知值班',
        column_key: 'needs_me',
        next_step: '先交包',
        evidence: [{ candidate_id: zhouCandidate!.candidate_id, purpose: 'request' }],
      },
      ...zhouOther.map((item) => ({
        type: 'ignore' as const,
        candidate_ids: [item.candidate_id],
        reason: '本轮只处理交付卡',
      })),
    ]);

    const linItemId = linReceipt.items[0]?.item_id as string;
    const zhouItemId = zhouReceipt.items[0]?.item_id as string;
    const linList = await callTool<FocusList>(lin.client, 'network_focus_list', {});
    const zhouList = await callTool<FocusList>(zhou.client, 'network_focus_list', {});
    checkEqual('林舟看到自己的卡', linList.items[0]?.item_id, linItemId);
    checkEqual('周敏看到自己的卡', zhouList.items[0]?.item_id, zhouItemId);
    checkEqual('林舟卡在跟进中', linList.items[0]?.column_key, 'tracking');
    checkEqual('周敏卡在需要我', zhouList.items[0]?.column_key, 'needs_me');

    // 2) owner 隔离：周敏读不到林舟的卡；Human 不能用秘书工具。
    const cross = await expectToolError(
      '跨 owner 读卡被拒',
      callTool(zhou.client, 'network_focus_get', { item_id: linItemId }),
      'NOT_FOUND',
    );
    check('跨 owner 读卡不泄露存在性', cross.code === 'NOT_FOUND');
    await expectToolError(
      'Human 不能调用秘书工具',
      callTool(lin.client, 'network_focus_job_get', { attempt_ref: linJobRef!.attemptRef }),
      'PERMISSION_DENIED',
    );

    // 3) 归档屏障：林舟归档后，迟到消息不能复活；秘书尝试更新整批 CONFLICT。
    const archived = await callTool<{ version: number; item_id: string }>(
      lin.client,
      'network_focus_archive',
      {
        item_id: linItemId,
        request_id: newRequestId('e2e_archive'),
        expected_version: linReceipt.items[0]?.version ?? 1,
      },
    );
    checkEqual('归档返回同一事项', archived.item_id, linItemId);

    const lateMessage = await sendMessage(zhou, roomId, '补发同一安装包的签收回执。');
    const lateBatch = await collectJobs(fake, cursor, service, 2);
    cursor = lateBatch.cursor;
    const lateLin = lateBatch.entries.find((entry) => entry.job.owner_name === '林舟');
    const lateZhou = lateBatch.entries.find((entry) => entry.job.owner_name === '周敏');
    check('迟到消息为两位 owner 各建一个作业', Boolean(lateLin && lateZhou));
    const lateJob = lateLin!.job;
    const lateCandidate = lateJob.candidates.find(
      (item) => item.message_id === lateMessage.message.message_id,
    );
    check('迟到消息进入林舟候选', Boolean(lateCandidate));
    try {
      await commit(service, lateLin!.attemptRef, [
        {
          type: 'update',
          item_id: linItemId,
          expected_version: archived.version,
          changes: { summary: '迟到的签收回执' },
          evidence: [{ candidate_id: lateCandidate!.candidate_id, purpose: 'progress' }],
        },
      ]);
      throw new Error('归档后更新未被拒绝');
    } catch (error) {
      check('归档后秘书更新被拒', error instanceof ToolError && error.code === 'CONFLICT');
    }
    await commit(
      service,
      lateLin!.attemptRef,
      lateJob.candidates.map((item) => ({
        type: 'ignore' as const,
        candidate_ids: [item.candidate_id],
        reason: '归档后不再跟进',
      })),
    );
    if (lateZhou) {
      await commit(
        service,
        lateZhou.attemptRef,
        lateZhou.job.candidates.map((item) => ({
          type: 'ignore' as const,
          candidate_ids: [item.candidate_id],
          reason: '本轮无新卡变化',
        })),
      );
    }
    const afterLate = await callTool<FocusList>(lin.client, 'network_focus_list', {});
    check('归档卡不再出现在三列', afterLate.items.every((item) => item.item_id !== linItemId));
    const archivedList = await callTool<FocusList>(lin.client, 'network_focus_list', {
      archived: true,
    });
    check('归档卡仍可在归档列表回看', archivedList.items.some((item) => item.item_id === linItemId));

    // 4) 重启：同一 dataDir 下绑定、同一秘书、卡与归档都保留。
    const dataDir = server.dataDir;
    const db = new Database(join(dataDir, 'agent-network.sqlite'), { readonly: true });
    const before = db
      .prepare(
        'SELECT secretary_actor_id, session_id, root_session_id FROM focus_bindings WHERE owner_actor_id = ?',
      )
      .get(linId.actor_id) as
      | { secretary_actor_id: string; session_id: string | null; root_session_id: string | null }
      | undefined;
    db.close();
    check('重启前已有远端会话', Boolean(before?.session_id && before.root_session_id));

    await lin.close();
    await zhou.close();
    await service.close();
    await server.stop();
    const restartPort = reservePort();
    const restartBase = `http://127.0.0.1:${restartPort}`;
    server = await startTestServer({
      port: restartPort,
      dataDir,
      tag: 'focus-e2e-restart',
      env: focusEnv(fake.url, restartBase),
    });
    process.env.AGENTNET_URL = server.base;
    lin = await connectClient(tokenA);
    const restarted = await waitActive(lin);
    checkEqual('重启后仍是同一秘书', restarted.secretary_actor_id, before?.secretary_actor_id);
    const restartedList = await callTool<FocusList>(lin.client, 'network_focus_list', {
      archived: true,
    });
    check(
      '重启后归档卡仍在',
      restartedList.items.some((item) => item.item_id === linItemId),
    );
    const restartedCurrent = await callTool<FocusList>(lin.client, 'network_focus_list', {});
    checkEqual('重启后归档卡不在三列', restartedCurrent.items.length, 0);
    await lin.close();
  } finally {
    await lin.close().catch(() => undefined);
    await zhou.close().catch(() => undefined);
    await service.close().catch(() => undefined);
    await server.dispose().catch(() => undefined);
    await fake.close();
  }
}

await run().catch((error) => {
  console.error('Focus HTTP 端到端验收失败:', error);
  process.exit(1);
});
