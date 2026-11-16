/**
 * Phase C：delivery 记忆参考包验收。
 *
 * 覆盖：工具注册/schema、只读自身 space、跨房间/跨 Agent/人类拒绝、
 * 无空间/无内容/关闭开关/超时空包、字节上限、控制字符与凭据掩码、
 * 不写 operations/events/outbox/memory_contexts。
 *
 * 运行：bun run test:memory-injection
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { buildServer } from '../src/mcp/server';
import type { Env } from '../src/env';
import type { ActorRow, CredentialRow } from '../src/storage/rows';
import type { Principal } from '../src/domain/principal';
import type { MemoryRuntime } from '../src/memory/runtime';
import { ensureAgentSpace } from '../src/memory/provision';
import {
  buildInjectionPackWithTimeout,
  type MemoryInjectionPack,
} from '../src/memory/injection';
import { getActor } from '../src/storage/queries';
import { sha256Hex, utf8Bytes } from '../src/storage/db';
import { check, checkEqual, checksPassed } from './lib/harness';
import {
  createMemoryEnv,
  seedActor,
  seedRoom,
  unique,
  type MemoryTestEnv,
} from './lib/memory-unit';

const AT = 1_700_000_000_000;
const INSTANCE = 'mni_injection_test';

function count(env: MemoryTestEnv, sql: string): number {
  return (env.db.prepare(sql).get() as { n: number } | null)?.n ?? 0;
}

function insertMessage(
  env: MemoryTestEnv,
  input: { messageId: string; roomId: string; senderId: string; seq: number; body: string },
): void {
  const bytes = utf8Bytes(input.body);
  env.db
    .prepare(
      `INSERT INTO messages
         (message_id, room_id, sender_id, client_message_id, created_seq, body,
          body_bytes, preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.messageId,
      input.roomId,
      input.senderId,
      `client_${input.messageId}`,
      input.seq,
      input.body,
      bytes,
      input.body.slice(0, 32),
      AT + input.seq,
    );
}

interface SeedMemoryInput {
  agentId: string;
  spaceId: string;
  epoch: number;
  roomId: string;
  messageId: string;
  senderId: string;
  sourceText: string;
  experienceText: string;
  order?: number;
}

async function seedMemory(env: MemoryTestEnv, input: SeedMemoryInput): Promise<void> {
  const suffix = unique('inj');
  const order = input.order ?? 1;
  const sourceId = `msrc_${suffix}`;
  const representationId = `mrep_${suffix}`;
  const experienceId = `mexp_${suffix}`;
  const sourceBytes = utf8Bytes(input.sourceText);
  const experienceBytes = utf8Bytes(input.experienceText);
  const sourceHash = await sha256Hex(input.sourceText);
  const experienceHash = await sha256Hex(input.experienceText);
  env.db
    .prepare(
      `INSERT INTO memory_sources
         (source_id, instance_id, source_key, source_kind, business_ref_kind, business_ref_json,
          origin_room_id, origin_member_generation, origin_policy_revision, origin_joined_seq,
          origin_joined_at, origin_archive_head_seq, origin_seq, origin_created_at,
          author_actor_id, state, revision, content_text, content_sha256, content_bytes,
          created_at, updated_at)
       VALUES (?, ?, ?, 'message', 'message', ?, ?, 1, 0, 0, 0, NULL, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      sourceId,
      INSTANCE,
      `message:${input.messageId}:${suffix}`,
      JSON.stringify({ message_id: input.messageId }),
      input.roomId,
      order,
      AT + order,
      input.senderId,
      input.sourceText,
      sourceHash,
      sourceBytes,
      AT + order,
      AT + order,
    );
  env.db
    .prepare(
      `INSERT INTO memory_representations
         (representation_id, instance_id, kind, source_id, source_revision, summary_id,
          summary_revision, source_context_id, producer_kind, lineage, partition_id,
          partition_generation, partition_policy_revision, range_start, range_end,
          text, text_bytes, text_sha256, verbatim, created_at)
       VALUES (?, ?, 'raw_full', ?, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
               0, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      representationId,
      INSTANCE,
      sourceId,
      experienceBytes,
      input.experienceText,
      experienceBytes,
      experienceHash,
      AT + order,
    );
  env.db
    .prepare(
      `INSERT INTO memory_experiences
         (experience_id, dedupe_key, space_id, ownership_epoch, agent_actor_id, origin_room_id,
          origin_member_generation, origin_kind, producer_kind, source_id, source_revision,
          representation_id, representation_kind, range_start, range_end, text_sha256,
          receipt_id, evidence, capture, available, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'experienced', 'server_template', ?, 1, ?, 'raw_full',
               0, ?, ?, NULL, 'experienced', 'extracted', 1, ?, ?)`,
    )
    .run(
      experienceId,
      `dedupe_${suffix}`,
      input.spaceId,
      input.epoch,
      input.agentId,
      input.roomId,
      sourceId,
      representationId,
      experienceBytes,
      experienceHash,
      AT + order,
      AT + order,
    );
}

async function principalOf(
  env: MemoryTestEnv,
  actorId: string,
  revoked = false,
): Promise<Principal> {
  const actor = await getActor(env.d1, actorId);
  if (!actor) throw new Error(`missing actor ${actorId}`);
  const credential: CredentialRow = {
    credential_id: `cred_${actorId}`,
    actor_id: actorId,
    device_id: `dev_${actorId}`,
    token_hash: 'test-hash',
    revoked_at: revoked ? AT : null,
    created_at: AT,
    last_used_at: null,
    revoked_by: null,
    label: null,
  };
  return { actor, credential, credentialHash: 'test-hash' };
}

function memoryEnv(env: MemoryTestEnv, overrides: Partial<Env> = {}): Env {
  return {
    DB: env.d1,
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: 'http://test.local',
    FILE_TICKET_SECRET: 'test-file-ticket-secret',
    MEMORY: {
      instanceId: INSTANCE,
      captureEnabled: true,
      capabilities: () => ({ reflect: false }),
    } as unknown as MemoryRuntime,
    MEMORY_INJECT: true,
    NOTIFICATION_HUB: {
      loginActor: () => ({ online: true, since: AT, connections: 0 }),
    },
    ...overrides,
  } as unknown as Env;
}

async function connectServer(env: Env, principal: Principal): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = buildServer(env, principal);
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return server.fetch(request);
    },
  });
  const client = new Client(
    { name: 'memory-injection-acceptance', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

interface ToolResult {
  isError?: boolean;
  content?: readonly { text?: string }[];
  structuredContent?: MemoryInjectionPack;
}

async function callPack(
  client: Client,
  args: Record<string, unknown>,
): Promise<MemoryInjectionPack> {
  const result = (await client.callTool({
    name: 'network_memory_context_pack',
    arguments: args,
  })) as ToolResult;
  if (result.isError === true || !result.structuredContent) {
    throw new Error(`pack failed: ${JSON.stringify(result.content)}`);
  }
  return result.structuredContent;
}

async function expectToolError(
  client: Client,
  args: Record<string, unknown>,
  code: string,
): Promise<void> {
  try {
    const result = (await client.callTool({
      name: 'network_memory_context_pack',
      arguments: args,
    })) as ToolResult;
    const text = JSON.stringify(result.content ?? []);
    check(`拒绝返回 ${code}`, result.isError === true && text.includes(code), text);
  } catch (error) {
    check(`拒绝返回 ${code}`, String(error).includes(code), error);
  }
}

async function main(): Promise<void> {
  const env = createMemoryEnv();
  const agentA = unique('agt_inj_a');
  const agentB = unique('agt_inj_b');
  const agentC = unique('agt_inj_c');
  const human = unique('usr_inj');
  for (const actorId of [agentA, agentB, agentC]) {
    seedActor(env, { actorId, kind: 'agent' });
  }
  seedActor(env, { actorId: human, kind: 'human' });

  const roomA = unique('rm_inj_a');
  const roomB = unique('rm_inj_b');
  const roomC = unique('rm_inj_c');
  seedRoom(env, {
    roomId: roomA,
    kind: 'group',
    ownerId: human,
    headSeq: 2,
    members: [
      { actorId: human, role: 'owner' },
      { actorId: agentA },
      { actorId: agentB },
      { actorId: agentC },
    ],
    now: AT,
  });
  seedRoom(env, {
    roomId: roomB,
    kind: 'group',
    ownerId: human,
    headSeq: 1,
    members: [{ actorId: human, role: 'owner' }, { actorId: agentA }],
    now: AT,
  });
  seedRoom(env, {
    roomId: roomC,
    kind: 'group',
    ownerId: human,
    headSeq: 1,
    members: [{ actorId: human, role: 'owner' }, { actorId: agentB }],
    now: AT,
  });
  const msgA1 = unique('msg_inj_a');
  const msgA2 = unique('msg_inj_a');
  const msgB = unique('msg_inj_b');
  insertMessage(env, { messageId: msgA1, roomId: roomA, senderId: human, seq: 1, body: 'room A one' });
  insertMessage(env, { messageId: msgA2, roomId: roomA, senderId: human, seq: 2, body: 'room A two' });
  insertMessage(env, { messageId: msgB, roomId: roomB, senderId: human, seq: 1, body: 'room B only' });

  const spaceA = await ensureAgentSpace(env.d1, { agentId: agentA, instanceId: INSTANCE, now: AT });
  const spaceB = await ensureAgentSpace(env.d1, { agentId: agentB, instanceId: INSTANCE, now: AT });
  if (spaceA.status !== 'created' && spaceA.status !== 'existing') throw new Error('space A');
  if (spaceB.status !== 'created' && spaceB.status !== 'existing') throw new Error('space B');

  const markerA = 'ROOM_A_MEMORY_MARKER';
  const markerB = 'ROOM_B_MEMORY_MARKER';
  const markerOtherAgent = 'AGENT_B_PRIVATE_MARKER';
  await seedMemory(env, {
    agentId: agentA,
    spaceId: spaceA.space.space_id,
    epoch: spaceA.space.ownership_epoch,
    roomId: roomA,
    messageId: msgA1,
    senderId: human,
    sourceText: `${markerA} 预算讨论 api_key=supersecret123456 Bearer abcdefghijklmnop`,
    experienceText: `${markerA} 已确认的摘要\u0000`,
    order: 1,
  });
  await seedMemory(env, {
    agentId: agentA,
    spaceId: spaceA.space.space_id,
    epoch: spaceA.space.ownership_epoch,
    roomId: roomB,
    messageId: msgB,
    senderId: human,
    sourceText: `${markerB} 另一个房间的内容`,
    experienceText: `${markerB} 另一个房间的经历`,
    order: 2,
  });
  await seedMemory(env, {
    agentId: agentB,
    spaceId: spaceB.space.space_id,
    epoch: spaceB.space.ownership_epoch,
    roomId: roomA,
    messageId: msgA2,
    senderId: human,
    sourceText: `${markerOtherAgent} B 自己的来源`,
    experienceText: `${markerOtherAgent} B 自己的经历`,
    order: 3,
  });

  const envA = memoryEnv(env);
  const principalA = await principalOf(env, agentA);
  const serverA = await connectServer(envA, principalA);
  try {
    const listed = await serverA.client.listTools();
    const tool = listed.tools.find((item) => item.name === 'network_memory_context_pack');
    check('工具已注册', tool !== undefined);
    check('工具声明只读', tool?.annotations?.readOnlyHint === true, tool?.annotations);
    check(
      '描述声明只读/不写账本',
      typeof tool?.description === 'string' &&
        tool.description.includes('只读') &&
        tool.description.includes('Hindsight') &&
        tool.description.includes('不写'),
      tool?.description,
    );

    const before = {
      operations: count(env, 'SELECT COUNT(*) AS n FROM operations'),
      events: count(env, 'SELECT COUNT(*) AS n FROM events'),
      outbox: count(env, 'SELECT COUNT(*) AS n FROM outbox'),
      contexts: count(env, 'SELECT COUNT(*) AS n FROM memory_contexts'),
    };

    const packA = await callPack(serverA.client, { room_id: roomA });
    checkEqual('room A 包可用', packA.available, true);
    checkEqual('room A reason=ready', packA.reason, 'ready');
    checkEqual('authority=reference_data', packA.authority, 'reference_data');
    checkEqual('不是注入许可', packA.injection.eligible, false);
    checkEqual('admit_required=true', packA.injection.admit_required, true);
    checkEqual('advisory_only', packA.injection.reason, 'advisory_only');
    checkEqual('semantic not_requested', packA.semantic.status, 'not_requested');
    const allTextA = packA.items.map((item) => item.text).join('\n');
    check('包含当前房间来源/经历', allTextA.includes(markerA));
    check('不包含其它房间内容', !allTextA.includes(markerB), allTextA);
    check('不包含其它 Agent 内容', !allTextA.includes(markerOtherAgent), allTextA);
    check(
      '每条 item 都硬过滤当前 room',
      packA.items.every((item) => item.origin_room_id === roomA),
      packA.items,
    );
    check('包内没有原文凭据', !allTextA.includes('supersecret123456'), allTextA);
    check('包内没有 Bearer 原值', !allTextA.includes('abcdefghijklmnop'), allTextA);
    check('凭据片段被掩码', allTextA.includes('[已隐藏]'), allTextA);
    check('控制字符被清理', !allTextA.includes('\u0000'), JSON.stringify(allTextA));
    check('来源标记包含 source_message_id', packA.items.every((item) => item.source_message_id !== null));

    const same = await callPack(serverA.client, { room_id: roomA });
    checkEqual('相同输入 pack_id 稳定', same.pack_id, packA.pack_id);
    checkEqual('读取不写 operations', count(env, 'SELECT COUNT(*) AS n FROM operations'), before.operations);
    checkEqual('读取不写 events', count(env, 'SELECT COUNT(*) AS n FROM events'), before.events);
    checkEqual('读取不写 outbox', count(env, 'SELECT COUNT(*) AS n FROM outbox'), before.outbox);
    checkEqual('读取不写 memory_contexts', count(env, 'SELECT COUNT(*) AS n FROM memory_contexts'), before.contexts);

    const roomBPack = await callPack(serverA.client, { room_id: roomB });
    const roomBText = roomBPack.items.map((item) => item.text).join('\n');
    check('room B 包包含 room B 内容', roomBText.includes(markerB));
    check('room B 包不包含 room A 内容', !roomBText.includes(markerA), roomBText);

    const filtered = await callPack(serverA.client, { room_id: roomA, query: markerA });
    check('query 命中相关条目', filtered.items.some((item) => item.text.includes(markerA)));
    const limited = await callPack(serverA.client, { room_id: roomA, limit: 1 });
    checkEqual('limit 有界', limited.item_count <= 1, true);
    checkEqual('limit 后 items 长度一致', limited.items.length, limited.item_count);
    const emptyQuery = await callPack(serverA.client, { room_id: roomA, query: 'NO_SUCH_MEMORY_QUERY' });
    checkEqual('query 无命中返回空包', emptyQuery.available, false);
    checkEqual('query 无命中 reason=empty', emptyQuery.reason, 'empty');

    const excludedCurrent = await callPack(serverA.client, { room_id: roomA, message_id: msgA1 });
    check(
      '当前 message 自身不重复注入',
      !excludedCurrent.items.some((item) => item.source_message_id === msgA1),
      excludedCurrent.items,
    );

    await expectToolError(
      serverA.client,
      { room_id: roomA, message_id: msgB },
      'NOT_FOUND',
    );
    await expectToolError(
      serverA.client,
      { room_id: roomC },
      'NOT_MEMBER',
    );
    await expectToolError(
      serverA.client,
      { room_id: roomA, agent_id: agentB },
      'agent_id',
    );

    const principalB = await principalOf(env, agentB);
    const serverB = await connectServer(envA, principalB);
    try {
      const packB = await callPack(serverB.client, { room_id: roomA });
      const textB = packB.items.map((item) => item.text).join('\n');
      check('Agent B 读到自己 room A 的记忆', textB.includes(markerOtherAgent));
      check('Agent B 读不到 Agent A 的记忆', !textB.includes(markerA), textB);
    } finally {
      await serverB.close();
    }

    const principalC = await principalOf(env, agentC);
    const serverC = await connectServer(envA, principalC);
    try {
      const noSpace = await callPack(serverC.client, { room_id: roomA });
      checkEqual('无空间 available=false', noSpace.available, false);
      checkEqual('无空间 reason=no_space', noSpace.reason, 'no_space');
    } finally {
      await serverC.close();
    }

    const principalRevoked = await principalOf(env, agentA, true);
    const serverRevoked = await connectServer(envA, principalRevoked);
    try {
      await expectToolError(serverRevoked.client, { room_id: roomA }, 'PERMISSION_DENIED');
    } finally {
      await serverRevoked.close();
    }

    const principalHuman = await principalOf(env, human);
    const serverHuman = await connectServer(envA, principalHuman);
    try {
      await expectToolError(serverHuman.client, { room_id: roomA }, 'PERMISSION_DENIED');
    } finally {
      await serverHuman.close();
    }

    const envOff = memoryEnv(env, { MEMORY_INJECT: false });
    const serverOff = await connectServer(envOff, principalA);
    try {
      const off = await callPack(serverOff.client, { room_id: roomA });
      checkEqual('MEMORY_INJECT=off 空包', off.available, false);
      checkEqual('MEMORY_INJECT=off reason', off.reason, 'injection_disabled');
      checkEqual('关闭时 items 为空', off.items.length, 0);
    } finally {
      await serverOff.close();
    }

    const envDisabled = memoryEnv(env, { MEMORY: undefined });
    const serverDisabled = await connectServer(envDisabled, principalA);
    try {
      await expectToolError(serverDisabled.client, { room_id: roomA }, 'MEMORY_DISABLED');
    } finally {
      await serverDisabled.close();
    }
  } finally {
    await serverA.close();
  }

  // 字节上限：6 条长中文经历必须裁剪，且结构化结果不超过 4 KiB 明确上限。
  const bigEnv = createMemoryEnv();
  const bigAgent = unique('agt_inj_big');
  seedActor(bigEnv, { actorId: bigAgent, kind: 'agent' });
  const bigRoom = unique('rm_inj_big');
  seedRoom(bigEnv, {
    roomId: bigRoom,
    kind: 'group',
    ownerId: bigAgent,
    headSeq: 1,
    members: [{ actorId: bigAgent, role: 'owner' }],
    now: AT,
  });
  const bigSpace = await ensureAgentSpace(bigEnv.d1, {
    agentId: bigAgent,
    instanceId: INSTANCE,
    now: AT,
  });
  if (bigSpace.status !== 'created' && bigSpace.status !== 'existing') throw new Error('space big');
  const longText = '记忆正文'.repeat(160);
  for (let index = 0; index < 6; index += 1) {
    const messageId = unique('msg_inj_big');
    insertMessage(bigEnv, {
      messageId,
      roomId: bigRoom,
      senderId: bigAgent,
      seq: index + 1,
      body: `big ${index}`,
    });
    await seedMemory(bigEnv, {
      agentId: bigAgent,
      spaceId: bigSpace.space.space_id,
      epoch: bigSpace.space.ownership_epoch,
      roomId: bigRoom,
      messageId,
      senderId: bigAgent,
      sourceText: `${longText}${index}`,
      experienceText: `${longText}${index}`,
      order: index + 1,
    });
  }
  const bigPrincipal = await principalOf(bigEnv, bigAgent);
  const bigServer = await connectServer(memoryEnv(bigEnv), bigPrincipal);
  try {
    const bigPack = await callPack(bigServer.client, { room_id: bigRoom });
    const bytes = Buffer.byteLength(JSON.stringify(bigPack), 'utf8');
    check('响应字节有界（<= 4 KiB）', bytes <= 4 * 1024, bytes);
    checkEqual('超预算标记 truncated', bigPack.truncated, true);
    check('超预算记录 omitted', bigPack.omitted > 0, bigPack.omitted);
    check('仍有可用条目', bigPack.items.length > 0, bigPack.items.length);
  } finally {
    await bigServer.close();
  }

  // 超时：候选查询故意不返回，外层必须降级为空包而不是错误。
  const slowDb = {
    prepare(sql: string) {
      if (sql.includes('FROM memory_experiences e') || sql.includes('FROM memory_sources s')) {
        return {
          bind: () => ({
            all: () => new Promise(() => {}),
            first: () => new Promise(() => {}),
          }),
        } as unknown as D1PreparedStatement;
      }
      return bigEnv.d1.prepare(sql);
    },
    batch: bigEnv.d1.batch.bind(bigEnv.d1),
  } as unknown as D1Database;
  const timedOut = await buildInjectionPackWithTimeout({
    db: slowDb,
    instanceId: INSTANCE,
    agentId: bigAgent,
    roomId: bigRoom,
    timeoutMs: 20,
  });
  checkEqual('超时 available=false', timedOut.available, false);
  checkEqual('超时 reason=timeout', timedOut.reason, 'timeout');
  checkEqual('超时 items 为空', timedOut.items.length, 0);

  console.log(`\n通过 ${checksPassed()} 项检查`);
}

await main();
