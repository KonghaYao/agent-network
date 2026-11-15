/**
 * 只读 Agent 记忆 insight 的单元/集成验收。
 *
 * 使用真实 migrations + 内存 SQLite + 受控 Hindsight HTTP 假服务，覆盖：
 * 授权矩阵、space→bank 映射、图裁剪/字节预算、列表/详情截断、实体视图、
 * 错误映射、缓存/single-flight、只读断言与敏感字段泄漏。
 *
 * 运行：bun run test:memory-insight
 */
import { BusinessError } from '../src/contracts/errors';
import { LIMITS } from '../src/contracts/limits';
import { bankIdFor } from '../src/memory/adapters/hindsight-tags';
import type { InsightViewer } from '../src/memory/insight/contracts';
import { HindsightInsightReader } from '../src/memory/insight/hindsight-read';
import { MemoryInsightService } from '../src/memory/insight/service';
import { sortedPairKey, utf8Bytes } from '../src/storage/db';
import { check, checkEqual, checksPassed } from './lib/harness';
import { FakeHindsightInsight } from './lib/memory-insight-fake';
import { createMemoryEnv, seedActor, seedManagement, seedRoom, unique } from './lib/memory-unit';

const AT = 1_700_000_000_000;
const TOKEN = `test_insight_${crypto.randomUUID().replaceAll('-', '')}`;
const INTERNAL_TAG = 'agentnet:o:authored';
const DOCUMENT_SECRET = 'document-secret-id';
const CHUNK_SECRET = 'chunk-secret-id';
const METADATA_SECRET = 'metadata-secret-value';
const UPSTREAM_SECRET = 'upstream-secret-body';

function viewer(kind: 'human' | 'agent', actorId: string): InsightViewer {
  return { kind, actor_id: actorId };
}

async function expectBusiness(
  label: string,
  promise: Promise<unknown>,
  code: string,
  insightCode?: string,
): Promise<void> {
  try {
    await promise;
    check(label, false, 'expected BusinessError');
  } catch (error) {
    check(`${label} 抛出 BusinessError`, error instanceof BusinessError);
    const business = error as BusinessError;
    checkEqual(`${label} 错误码`, business.code, code);
    if (insightCode) {
      checkEqual(`${label} insight_code`, business.details?.insight_code, insightCode);
    }
  }
}

function seedFriend(
  db: D1Database,
  left: string,
  right: string,
  status: 'active' | 'ended',
): void {
  const pairKey = sortedPairKey(left, right);
  const [actorA, actorB] = left < right ? [left, right] : [right, left];
  db.prepare(
    `INSERT INTO contact_relations
       (pair_key, actor_a, actor_b, status, source, request_id, created_at, updated_at, ended_at, ended_by)
     VALUES (?, ?, ?, ?, 'request', NULL, ?, ?, ?, NULL)`,
  )
    .bind(pairKey, actorA, actorB, status, AT, AT, status === 'ended' ? AT : null)
    .run();
}

function seedBlock(
  db: D1Database,
  blocker: string,
  blocked: string,
): void {
  db.prepare(
    `INSERT INTO contact_blocks
       (block_id, blocker_actor_id, blocked_actor_id, reason, mute_mentions, created_at, released_at, released_by)
     VALUES (?, ?, ?, '', 1, ?, NULL, NULL)`,
  )
    .bind(unique('blk'), blocker, blocked, AT)
    .run();
}

function releaseBlock(db: D1Database, blocker: string, blocked: string): void {
  db.prepare(
    `UPDATE contact_blocks
        SET released_at = ?, released_by = ?
      WHERE blocker_actor_id = ? AND blocked_actor_id = ? AND released_at IS NULL`,
  )
    .bind(AT + 1, blocker, blocker, blocked)
    .run();
}

function seedSpace(
  db: D1Database,
  input: {
    spaceId: string;
    agentId: string;
    ownershipEpoch: number;
    backendBindingEpoch: number;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_instances (instance_id, capture_default, created_at, updated_at)
     VALUES ('mni_insight', 'enabled', ?, ?)`,
  )
    .bind(AT, AT)
    .run();
  db.prepare(
    `INSERT INTO memory_spaces
       (space_id, instance_id, agent_actor_id, owner_actor_id, ownership_kind,
        ownership_epoch, backend_binding_epoch, management_binding_id, capture, active,
        created_at, updated_at)
     VALUES (?, 'mni_insight', ?, ?, 'self_owned', ?, ?, NULL, 'excluded', 1, ?, ?)`,
  )
    .bind(
      input.spaceId,
      input.agentId,
      input.agentId,
      input.ownershipEpoch,
      input.backendBindingEpoch,
      AT,
      AT,
    )
    .run();
}

async function countRows(db: D1Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

function assertNoSensitive(label: string, value: unknown, bank: string): void {
  const text = JSON.stringify(value);
  check(`${label} 不含 bank`, !text.includes(bank), text.slice(0, 200));
  check(`${label} 不含 space`, !text.includes('msp_insight'), text.slice(0, 200));
  check(`${label} 不含 provider`, !text.includes('hindsight'), text.slice(0, 200));
  check(`${label} 不含凭据`, !text.includes(TOKEN), text.slice(0, 200));
  check(`${label} 不含上游地址`, !text.includes('127.0.0.1'), text.slice(0, 200));
  check(`${label} 不含 document_id`, !text.includes(DOCUMENT_SECRET), text.slice(0, 200));
  check(`${label} 不含 chunk_id`, !text.includes(CHUNK_SECRET), text.slice(0, 200));
  check(`${label} 不含 metadata`, !text.includes(METADATA_SECRET), text.slice(0, 200));
  check(`${label} 不含内部 tags`, !text.includes(INTERNAL_TAG), text.slice(0, 200));
}

function graphFixture(): Record<string, unknown> {
  const nodes = Array.from({ length: 150 }, (_, index) => ({
    data: {
      id: `n${index}`,
      label: `Node ${index}`,
      text: `记忆正文-${index}-`.repeat(400),
      date: '2026-11-01T00:00:00Z',
      entities: ['Alice', 'Bob'],
      document_id: DOCUMENT_SECRET,
      chunk_id: CHUNK_SECRET,
    },
  }));
  const edges: Record<string, unknown>[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    edges.push({
      data: {
        id: `edge-${index}`,
        source: `n${index % 150}`,
        target: `n${(index + 1) % 150}`,
        linkType: index % 2 === 0 ? 'semantic' : 'entity',
        weight: 1,
        entityName: 'Alice',
      },
    });
  }
  edges.push(
    { data: { id: 'self-loop', source: 'n0', target: 'n0', linkType: 'semantic', weight: 9 } },
    { data: { id: 'dangling', source: 'n0', target: 'missing', linkType: 'semantic', weight: 9 } },
    { data: { id: 'dup-1', source: 'n1', target: 'n2', linkType: 'semantic', weight: 5 } },
    { data: { id: 'dup-2', source: 'n1', target: 'n2', linkType: 'semantic', weight: 7 } },
  );
  return {
    nodes,
    edges,
    table_rows: [
      { id: 'n0', fact_type: 'world', proof_count: 2, document_id: DOCUMENT_SECRET },
      { id: 'n1', fact_type: 'observation', proof_count: 1, tags: [INTERNAL_TAG] },
    ],
    total_units: 1_451,
    total_edges: edges.length,
  };
}

function entityGraphFixture(): Record<string, unknown> {
  const nodes = Array.from({ length: 250 }, (_, index) => ({
    data: {
      id: `e${index}`,
      label: `Entity ${index}`,
      mentionCount: index + 1,
      metadata: { secret: METADATA_SECRET },
    },
  }));
  const edges: Record<string, unknown>[] = Array.from({ length: 250 }, (_, index) => ({
    data: {
      id: `ee-${index}`,
      source: `e${index % 250}`,
      target: `e${(index + 1) % 250}`,
      linkType: 'cooccurrence',
      weight: index + 1,
      lastCooccurred: '2026-11-01T00:00:00Z',
    },
  }));
  edges.push(
    { data: { id: 'ee-self', source: 'e0', target: 'e0', linkType: 'cooccurrence', weight: 99 } },
    {
      data: {
        id: 'ee-dangling',
        source: 'e0',
        target: 'missing',
        linkType: 'cooccurrence',
        weight: 99,
      },
    },
    { data: { id: 'ee-dup-a', source: 'e1', target: 'e2', linkType: 'cooccurrence', weight: 1 } },
    { data: { id: 'ee-dup-b', source: 'e1', target: 'e2', linkType: 'cooccurrence', weight: 2 } },
  );
  return {
    nodes,
    edges,
    // 真实上游的 total 是本次返回子图的计数，不是全库总数。
    total_entities: nodes.length,
    total_edges: edges.length,
  };
}

/** 生成恰好 edgeCount 条有效边/节点的实体子图，用于验证达到上限时的截断标记。 */
function limitedEntityGraphFixture(edgeCount: number): Record<string, unknown> {
  const nodes = Array.from({ length: edgeCount }, (_, index) => ({
    data: { id: `l${index}`, label: `Limit ${index}`, mentionCount: index + 1 },
  }));
  const edges = Array.from({ length: edgeCount }, (_, index) => ({
    data: {
      id: `le-${index}`,
      source: `l${index}`,
      target: `l${(index + 1) % edgeCount}`,
      linkType: 'cooccurrence',
      weight: 1,
    },
  }));
  return { nodes, edges, total_entities: nodes.length, total_edges: edges.length };
}

async function main(): Promise<void> {
  const env = createMemoryEnv();
  const fake = new FakeHindsightInsight(TOKEN);

  const friend = unique('usr_friend');
  const roomViewer = unique('usr_room');
  const stranger = unique('usr_stranger');
  const endedFriend = unique('usr_ended');
  const leftViewer = unique('usr_left');
  const blockedRoomViewer = unique('usr_blocked_room');
  const blockedFriend = unique('usr_blocked_friend');
  const doubleBlocked = unique('usr_double_blocked');
  const target = unique('agt_target');
  const otherAgent = unique('agt_other');
  const noSpaceAgent = unique('agt_nospace');
  const missingBankAgent = unique('agt_missingbank');
  const entityLimitAgent = unique('agt_entity_limit');
  const humanTarget = unique('usr_human_target');

  seedActor(env, { actorId: friend, kind: 'human', name: '好友' });
  seedActor(env, { actorId: roomViewer, kind: 'human', name: '同房' });
  seedActor(env, { actorId: stranger, kind: 'human', name: '陌生人' });
  seedActor(env, { actorId: endedFriend, kind: 'human', name: '旧好友' });
  seedActor(env, { actorId: leftViewer, kind: 'human', name: '已退群' });
  seedActor(env, { actorId: blockedRoomViewer, kind: 'human', name: '被拉黑同房' });
  seedActor(env, { actorId: blockedFriend, kind: 'human', name: '拉黑好友' });
  seedActor(env, { actorId: doubleBlocked, kind: 'human', name: '双向拉黑好友' });
  seedActor(env, { actorId: target, kind: 'agent', name: '目标 Agent' });
  seedActor(env, { actorId: otherAgent, kind: 'agent', name: '另一个 Agent' });
  seedActor(env, { actorId: noSpaceAgent, kind: 'agent', name: '无空间 Agent' });
  seedActor(env, { actorId: missingBankAgent, kind: 'agent', name: '缺 bank Agent' });
  seedActor(env, { actorId: entityLimitAgent, kind: 'agent', name: '实体上限 Agent' });
  seedActor(env, { actorId: humanTarget, kind: 'human', name: '人类目标' });

  seedFriend(env.d1, friend, target, 'active');
  seedFriend(env.d1, endedFriend, target, 'ended');
  seedFriend(env.d1, friend, noSpaceAgent, 'active');
  seedFriend(env.d1, friend, missingBankAgent, 'active');
  seedFriend(env.d1, friend, entityLimitAgent, 'active');
  seedFriend(env.d1, blockedFriend, target, 'active');
  seedFriend(env.d1, doubleBlocked, target, 'active');
  // 陌生人只是目标 Agent 的 manager；新策略明确不允许仅凭管理关系读取正文。
  seedManagement(env, { agentId: target, managerId: stranger, bindingId: unique('amb') });

  // 拉黑排除：目标被 Agent 拉黑但仍在同一 active direct room；human 拉黑 Agent
  // 但仍是好友；以及双向拉黑。拉黑优先于好友/共享房间关系。
  seedBlock(env.d1, target, blockedRoomViewer);
  seedBlock(env.d1, blockedFriend, target);
  seedBlock(env.d1, target, doubleBlocked);
  seedBlock(env.d1, doubleBlocked, target);

  seedRoom(env, {
    roomId: unique('rm_shared'),
    kind: 'direct',
    ownerId: roomViewer,
    members: [{ actorId: roomViewer }, { actorId: target }],
  });
  seedRoom(env, {
    roomId: unique('rm_blocked'),
    kind: 'direct',
    ownerId: blockedRoomViewer,
    members: [{ actorId: blockedRoomViewer }, { actorId: target }],
  });
  seedRoom(env, {
    roomId: unique('rm_agent_shared'),
    kind: 'group',
    ownerId: otherAgent,
    members: [{ actorId: otherAgent }, { actorId: target }],
  });
  seedRoom(env, {
    roomId: unique('rm_dissolved'),
    kind: 'group',
    ownerId: stranger,
    dissolved: true,
    members: [{ actorId: stranger }, { actorId: target }],
  });
  seedRoom(env, {
    roomId: unique('rm_left'),
    kind: 'group',
    ownerId: leftViewer,
    members: [{ actorId: leftViewer, status: 'left' }, { actorId: target }],
  });

  const targetSpace = {
    space_id: 'msp_insight_target',
    ownership_epoch: 2,
    backend_binding_epoch: 3,
  };
  seedSpace(env.d1, {
    spaceId: targetSpace.space_id,
    agentId: target,
    ownershipEpoch: targetSpace.ownership_epoch,
    backendBindingEpoch: targetSpace.backend_binding_epoch,
  });
  const missingBankSpace = {
    space_id: 'msp_insight_missing',
    ownership_epoch: 1,
    backend_binding_epoch: 1,
  };
  seedSpace(env.d1, {
    spaceId: missingBankSpace.space_id,
    agentId: missingBankAgent,
    ownershipEpoch: missingBankSpace.ownership_epoch,
    backendBindingEpoch: missingBankSpace.backend_binding_epoch,
  });
  const entityLimitSpace = {
    space_id: 'msp_insight_entity_limit',
    ownership_epoch: 1,
    backend_binding_epoch: 1,
  };
  seedSpace(env.d1, {
    spaceId: entityLimitSpace.space_id,
    agentId: entityLimitAgent,
    ownershipEpoch: entityLimitSpace.ownership_epoch,
    backendBindingEpoch: entityLimitSpace.backend_binding_epoch,
  });

  const targetBank = await bankIdFor('agentnet', targetSpace);
  const missingBank = await bankIdFor('agentnet', missingBankSpace);
  const entityLimitBank = await bankIdFor('agentnet', entityLimitSpace);
  check('bank 由 space + epochs 派生', targetBank.startsWith('agentnet-') && targetBank.length === 49);
  check('不同 space 派生不同 bank', targetBank !== missingBank);

  const longMemoryText = '事实正文'.repeat(1_000);
  const memories = [
    {
      id: 'm1',
      text: longMemoryText,
      fact_type: 'world',
      state: 'valid',
      mentioned_at: '2026-11-01T00:00:00Z',
      occurred_start: '2026-10-01T00:00:00Z',
      occurred_end: '2026-10-02T00:00:00Z',
      entities: 'Alice, Bob, Alice',
      entity_ids: ['e0'],
      proof_count: 2,
      tags: [INTERNAL_TAG, 'public'],
      document_id: DOCUMENT_SECRET,
      chunk_id: CHUNK_SECRET,
      metadata: { secret: METADATA_SECRET },
    },
    {
      id: 'm2',
      text: '第二条事实',
      fact_type: 'observation',
      state: 'invalidated',
      mentioned_at: '2026-11-02T00:00:00Z',
      entities: ['Alice'],
      proof_count: 1,
      tags: ['agentnet:s:internal', 'public'],
    },
    {
      id: 'm3',
      text: '第三条事实',
      fact_type: 'experience',
      state: 'valid',
      mentioned_at: '2026-11-03T00:00:00Z',
      entities: ['Bob'],
      proof_count: 0,
      tags: [],
    },
  ];
  const detailText = 'a'.repeat(40_000);
  const memoryDetails: Record<string, Record<string, unknown>> = {
    m1: {
      id: 'm1',
      text: detailText,
      context: 'agentnet message room=rm_secret seq=3',
      type: 'world',
      state: 'valid',
      mentioned_at: '2026-11-01T00:00:00Z',
      occurred_start: null,
      occurred_end: null,
      entities: ['Alice'],
      proof_count: 2,
      tags: [INTERNAL_TAG, 'public'],
      document_id: DOCUMENT_SECRET,
      chunk_id: CHUNK_SECRET,
      metadata: { secret: METADATA_SECRET },
      history: [{ revision: 1 }, { revision: 2 }],
      source_memories: Array.from({ length: 12 }, (_, index) => ({
        id: `sm${index}`,
        text: '来源'.repeat(300),
        type: 'world',
        mentioned_at: '2026-10-01T00:00:00Z',
      })),
    },
  };
  const entities = Array.from({ length: 120 }, (_, index) => ({
    id: `e${index}`,
    canonical_name: `Entity ${index}`,
    mention_count: index + 1,
    first_seen: '2026-01-01T00:00:00Z',
    last_seen: '2026-11-01T00:00:00Z',
    metadata: { secret: METADATA_SECRET },
  }));
  const entityDetails: Record<string, Record<string, unknown>> = {
    e0: {
      id: 'e0',
      canonical_name: 'Alice',
      mention_count: 9,
      first_seen: '2026-01-01T00:00:00Z',
      last_seen: '2026-11-01T00:00:00Z',
      observations: [
        {
          id: 'o1',
          text: '观察正文',
          proof_count: 1,
          metadata: { secret: METADATA_SECRET },
        },
      ],
      metadata: { secret: METADATA_SECRET },
    },
  };

  fake.seedBank(targetBank, {
    stats: {
      total_nodes: 42,
      total_links: 84,
      total_documents: 7,
      nodes_by_fact_type: { world: 10, experience: 12, observation: 20 },
      links_by_link_type: { semantic: 30, temporal: 54 },
      pending_operations: 1,
      failed_operations: 2,
      last_memory_write_at: '2026-11-01T00:00:00Z',
      last_consolidated_at: '2026-10-31T00:00:00Z',
    },
    graph: graphFixture(),
    entityGraph: entityGraphFixture(),
    memories,
    memoryDetails,
    entities,
    entityDetails,
  });
  fake.seedBank(entityLimitBank, { entityGraph: limitedEntityGraphFixture(5) });

  let clock = AT;
  const reader = new HindsightInsightReader({
    baseUrl: fake.baseUrl,
    apiKey: TOKEN,
    bankPrefix: 'agentnet',
    requestTimeoutMs: 1_000,
    maxRetries: 0,
  });
  const service = new MemoryInsightService({
    db: env.d1,
    reader,
    memoryEnabled: true,
    now: () => clock,
  });

  console.log('--- 授权矩阵 ---');
  await expectBusiness(
    '陌生人（仅 manager）不能查看',
    service.overview(viewer('human', stranger), { actor_id: target }),
    'PERMISSION_DENIED',
    'FORBIDDEN',
  );
  await expectBusiness(
    '已结束好友不能查看',
    service.overview(viewer('human', endedFriend), { actor_id: target }),
    'PERMISSION_DENIED',
    'FORBIDDEN',
  );
  await expectBusiness(
    '仅共享已解散房间不能查看',
    service.overview(viewer('human', stranger), { actor_id: target, refresh: true }),
    'PERMISSION_DENIED',
    'FORBIDDEN',
  );
  await expectBusiness(
    '仅 left 成员关系不能查看',
    service.overview(viewer('human', leftViewer), { actor_id: target }),
    'PERMISSION_DENIED',
    'FORBIDDEN',
  );
  await expectBusiness(
    '被 Agent 拉黑但仍在同一 active direct room 不能查看',
    service.overview(viewer('human', blockedRoomViewer), { actor_id: target }),
    'PERMISSION_DENIED',
    'FORBIDDEN',
  );
  await expectBusiness(
    '拉黑 Agent 但仍是 active 好友不能查看',
    service.overview(viewer('human', blockedFriend), { actor_id: target }),
    'PERMISSION_DENIED',
    'FORBIDDEN',
  );
  await expectBusiness(
    '双向拉黑且仍是 active 好友不能查看',
    service.overview(viewer('human', doubleBlocked), { actor_id: target }),
    'PERMISSION_DENIED',
    'FORBIDDEN',
  );
  await expectBusiness(
    'Agent 不能查看其他 Agent（即使共享房间）',
    service.overview(viewer('agent', otherAgent), { actor_id: target }),
    'PERMISSION_DENIED',
    'FORBIDDEN',
  );
  await expectBusiness(
    '人类目标不是 Agent',
    service.overview(viewer('human', friend), { actor_id: humanTarget }),
    'MEMORY_TARGET_INVALID',
  );
  await expectBusiness(
    '未知目标',
    service.overview(viewer('human', friend), { actor_id: 'agt_missing' }),
    'NOT_FOUND',
  );


  console.log('--- overview / bank 映射 ---');
  fake.resetRequests();
  const friendOverview = await service.overview(viewer('human', friend), { actor_id: target });
  checkEqual('好友可查看 overview', friendOverview.available, true);
  checkEqual('overview stats 节点数', friendOverview.stats?.total_nodes, 42);
  checkEqual('overview 按类型', friendOverview.stats?.by_fact_type.observation, 20);
  checkEqual('overview pending', friendOverview.stats?.pending_operations, 1);
  checkEqual('overview failed', friendOverview.stats?.failed_operations, 2);
  checkEqual('overview last_write_at', friendOverview.stats?.last_write_at, '2026-11-01T00:00:00Z');
  checkEqual('请求使用派生 bank', fake.requests[0]?.path.includes(`/banks/${targetBank}/stats`), true);
  assertNoSensitive('overview 输出', friendOverview, targetBank);

  const roomViewerOverview = await service.overview(viewer('human', roomViewer), {
    actor_id: target,
    refresh: true,
  });
  checkEqual('共享有效房间可查看', roomViewerOverview.available, true);
  const selfOverview = await service.overview(viewer('agent', target), { actor_id: target });
  checkEqual('Agent 本人可查看', selfOverview.available, true);

  releaseBlock(env.d1, target, blockedRoomViewer);
  const unblockedRoomOverview = await service.overview(viewer('human', blockedRoomViewer), {
    actor_id: target,
    refresh: true,
  });
  checkEqual('解除拉黑后同房恢复可查看', unblockedRoomOverview.available, true);
  releaseBlock(env.d1, blockedFriend, target);
  const unblockedFriendOverview = await service.overview(viewer('human', blockedFriend), {
    actor_id: target,
    refresh: true,
  });
  checkEqual('解除拉黑后好友恢复可查看', unblockedFriendOverview.available, true);

  const noSpace = await service.overview(viewer('human', friend), { actor_id: noSpaceAgent });
  checkEqual('无 active space 返回 no_space', noSpace.reason, 'no_space');
  checkEqual('no_space 不伪造 stats', noSpace.stats, null);

  console.log('--- graph 裁剪 ---');
  fake.resetRequests();
  const graph = await service.graph(viewer('human', friend), { actor_id: target });
  check('graph 节点不超过 120', graph.nodes.length <= LIMITS.memoryPanelGraphNodesMax, graph.nodes.length);
  check('graph 边不超过 600', graph.edges.length <= LIMITS.memoryPanelGraphEdgesMax, graph.edges.length);
  check(
    'graph JSON 不超过 200KB',
    utf8Bytes(JSON.stringify(graph)) <= LIMITS.memoryPanelGraphBytes,
    utf8Bytes(JSON.stringify(graph)),
  );
  check('graph 标记 truncated', graph.truncated);
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  check(
    'graph 无自环/悬空边',
    graph.edges.every((edge) => edge.source !== edge.target && nodeIds.has(edge.source) && nodeIds.has(edge.target)),
  );
  const edgeKeys = graph.edges.map((edge) => `${edge.source}|${edge.target}|${edge.type}`);
  check('graph 无重复边', new Set(edgeKeys).size === edgeKeys.length);
  checkEqual('graph merge fact_type', graph.nodes.find((node) => node.id === 'n0')?.fact_type, 'world');
  checkEqual('graph request limit', fake.requests.find((item) => item.path.endsWith('/graph'))?.query.get('limit'), '120');
  assertNoSensitive('graph 输出', graph, targetBank);

  const largeLimitGraph = await service.graph(viewer('human', friend), {
    actor_id: target,
    limit: 240,
    q: 'limit-clamp',
    refresh: true,
  });
  checkEqual('graph 输入 240 被夹到 120', largeLimitGraph.limit, 120);
  check('graph 夹取后节点仍不超过 120', largeLimitGraph.nodes.length <= 120, largeLimitGraph.nodes.length);

  console.log('--- list / get ---');
  const listed = await service.list(viewer('human', friend), { actor_id: target });
  checkEqual('list total', listed.total, 3);
  checkEqual('list limit 默认', listed.limit, LIMITS.memoryPanelFactsPageDefault);
  checkEqual('list 正文截断 1200 字符', listed.items[0]?.text.length, LIMITS.memoryPanelFactsTextChars);
  checkEqual('list 状态归一化', listed.items[1]?.state, 'invalidated');
  checkEqual('list entities 逗号拆分去重', JSON.stringify(listed.items[0]?.entities), '["Alice","Bob"]');
  checkEqual('list 过滤内部 tags', JSON.stringify(listed.items[0]?.tags), '["public"]');
  assertNoSensitive('list 输出', listed, targetBank);

  fake.resetRequests();
  const filtered = await service.list(viewer('human', friend), {
    actor_id: target,
    q: '事实',
    type: 'world',
    entity_id: 'Alice',
    time_field: 'mentioned_at',
    start_date: '2026-01-01',
    end_date: '2026-02-01',
    refresh: true,
  });
  checkEqual('list q 过滤仍返回', filtered.total, 1);
  const listRequest = fake.requests.filter((item) => item.path.endsWith('/memories/list')).at(-1);
  checkEqual('list 转发 q', listRequest?.query.get('q'), '事实');
  checkEqual('list 转发 type', listRequest?.query.get('type'), 'world');
  checkEqual('list 转发 entity_id', listRequest?.query.get('entity_id'), 'Alice');
  checkEqual('list 转发 time_field', listRequest?.query.get('time_field'), 'mentioned_at');
  checkEqual('list 转发 start_date', listRequest?.query.get('start_date'), '2026-01-01');
  checkEqual('list 转发 end_date', listRequest?.query.get('end_date'), '2026-02-01');
  const page = await service.list(viewer('human', friend), {
    actor_id: target,
    limit: 1,
    offset: 1,
    refresh: true,
  });
  checkEqual('list 分页条数', page.items.length, 1);
  checkEqual('list 分页 offset', page.offset, 1);
  checkEqual('list 分页 has_more', page.has_more, true);
  checkEqual('list 分页 next_offset', page.next_offset, 2);
  await expectBusiness(
    '非法日期范围',
    service.list(viewer('human', friend), {
      actor_id: target,
      start_date: '2026-02-01',
      end_date: '2026-01-01',
    }),
    'INVALID_ARGUMENT',
  );
  await expectBusiness(
    '非 ISO 日期',
    service.list(viewer('human', friend), {
      actor_id: target,
      start_date: 'March 1 2026',
    }),
    'INVALID_ARGUMENT',
  );

  const detail = await service.get(viewer('human', friend), { actor_id: target, memory_id: 'm1' });
  checkEqual('get 返回详情', detail.memory?.id, 'm1');
  checkEqual(
    'get 正文按 32KB 截断',
    utf8Bytes(detail.memory?.text ?? ''),
    LIMITS.memoryPanelDetailTextBytes,
  );
  checkEqual('get 标记正文截断', detail.memory?.text_truncated, true);
  checkEqual('get context 归一化', detail.memory?.context, '来自会话消息');
  checkEqual('get source_memories 上限 10', detail.memory?.source_memories.length, 10);
  checkEqual('get history_count', detail.memory?.history_count, 2);
  assertNoSensitive('get 输出', detail, targetBank);
  await expectBusiness(
    '未知 memory_id返回 NOT_FOUND',
    service.get(viewer('human', friend), { actor_id: target, memory_id: 'missing' }),
    'NOT_FOUND',
    'NOT_FOUND',
  );

  console.log('--- entities ---');
  const entityList = await service.entities(viewer('human', friend), {
    actor_id: target,
    view: 'list',
    limit: 100,
  });
  checkEqual('实体列表 view', entityList.view, 'list');
  checkEqual('实体列表 total', entityList.total, 120);
  checkEqual('实体列表页大小', entityList.items.length, 100);
  checkEqual('实体列表 has_more', entityList.has_more, true);
  checkEqual('实体列表 next_offset', entityList.next_offset, 100);
  assertNoSensitive('entities list 输出', entityList, targetBank);

  fake.resetRequests();
  const entityGraph = await service.entities(viewer('human', friend), {
    actor_id: target,
    view: 'graph',
    refresh: true,
  });
  checkEqual('实体图 view', entityGraph.view, 'graph');
  check('实体图边不超过 200', (entityGraph.graph?.edges.length ?? 0) <= 200, entityGraph.graph?.edges.length);
  const graphRequest = fake.requests.find((item) => item.path.endsWith('/entities/graph'));
  checkEqual('实体图 min_count=2', graphRequest?.query.get('min_count'), '2');
  checkEqual('实体图 limit=200', graphRequest?.query.get('limit'), '200');
  const entityNodeIds = new Set((entityGraph.graph?.nodes ?? []).map((node) => node.id));
  check(
    '实体图无自环/悬空',
    (entityGraph.graph?.edges ?? []).every(
      (edge) =>
        edge.source !== edge.target && entityNodeIds.has(edge.source) && entityNodeIds.has(edge.target),
    ),
  );
  assertNoSensitive('entities graph 输出', entityGraph, targetBank);

  const largeEntityGraph = await service.entities(viewer('human', friend), {
    actor_id: target,
    view: 'graph',
    limit: 400,
    refresh: true,
  });
  checkEqual('实体图输入 400 被夹到 200', largeEntityGraph.limit, 200);
  check(
    '实体图夹取后边仍不超过 200',
    (largeEntityGraph.graph?.edges.length ?? 0) <= 200,
    largeEntityGraph.graph?.edges.length,
  );
  checkEqual('实体图 total_entities 为子图节点计数', entityGraph.graph?.total_entities, 250);
  checkEqual('实体图达到裁剪上限 truncated=true', entityGraph.graph?.truncated, true);

  console.log('--- 实体图 truncated 边界 ---');
  const belowLimitGraph = await service.entities(viewer('human', friend), {
    actor_id: entityLimitAgent,
    view: 'graph',
    limit: 10,
    refresh: true,
  });
  checkEqual('实体图低于上限 truncated=false', belowLimitGraph.graph?.truncated, false);
  checkEqual('实体图低于上限返回边数', belowLimitGraph.graph?.edges.length, 5);
  checkEqual('实体图保留 raw 边数', belowLimitGraph.graph?.raw_edge_count, 5);
  checkEqual('实体图 total_edges 为子图计数', belowLimitGraph.graph?.total_edges, 5);

  for (const limit of [10, 50, 200] as const) {
    fake.seedBank(entityLimitBank, { entityGraph: limitedEntityGraphFixture(limit) });
    const reached = await service.entities(viewer('human', friend), {
      actor_id: entityLimitAgent,
      view: 'graph',
      limit,
      refresh: true,
    });
    checkEqual(`实体图 limit=${limit} 返回边数达到上限`, reached.graph?.edges.length, limit);
    checkEqual(`实体图 limit=${limit} truncated=true`, reached.graph?.truncated, true);
    checkEqual(`实体图 limit=${limit} raw 边数保留`, reached.graph?.raw_edge_count, limit);
    checkEqual(`实体图 limit=${limit} total_edges 为子图计数`, reached.graph?.total_edges, limit);
  }

  const entityDetail = await service.entities(viewer('human', friend), {
    actor_id: target,
    entity_id: 'e0',
    refresh: true,
  });
  checkEqual('实体详情 view', entityDetail.view, 'detail');
  checkEqual('实体详情名称', entityDetail.entity?.name, 'Alice');
  checkEqual('实体详情 observations', entityDetail.entity?.observations.length, 1);
  check('实体详情附带相关记忆', (entityDetail.entity?.memories.length ?? 0) > 0);
  checkEqual('实体详情 partial', entityDetail.partial, false);
  assertNoSensitive('entities detail 输出', entityDetail, targetBank);

  fake.fail('/memories/list', 500, 1);
  const partialDetail = await service.entities(viewer('human', friend), {
    actor_id: target,
    entity_id: 'e0',
    refresh: true,
  });
  checkEqual('实体详情相关记忆失败仍返回实体', partialDetail.available, true);
  checkEqual('实体详情相关记忆失败标记 partial', partialDetail.partial, true);
  checkEqual('实体详情相关记忆失败为空', partialDetail.entity?.memories.length, 0);

  console.log('--- 缓存 / single-flight ---');
  fake.resetRequests();
  clock = AT + LIMITS.memoryPanelCacheTtlMs + 1_000;
  await service.overview(viewer('human', friend), { actor_id: target });
  await service.overview(viewer('human', friend), { actor_id: target });
  checkEqual('TTL 内重复 overview 只请求一次', fake.requestCount('GET', '/stats'), 1);
  clock += LIMITS.memoryPanelCacheTtlMs + 1;
  await service.overview(viewer('human', friend), { actor_id: target });
  checkEqual('TTL 过期后重新请求', fake.requestCount('GET', '/stats'), 2);
  await service.overview(viewer('human', friend), { actor_id: target, refresh: true });
  checkEqual('refresh 绕过缓存', fake.requestCount('GET', '/stats'), 3);

  fake.resetRequests();
  fake.delay('/graph', 120);
  await Promise.all([
    service.graph(viewer('human', friend), { actor_id: target, q: 'single-flight' }),
    service.graph(viewer('human', friend), { actor_id: target, q: 'single-flight' }),
  ]);
  checkEqual('并发 graph 合并为一次上游请求', fake.requestCount('GET', '/graph'), 1);

  fake.resetRequests();
  await service.overview(viewer('human', friend), { actor_id: target });
  await service.overview(viewer('human', roomViewer), { actor_id: target });
  checkEqual('授权后不同 viewer 复用同一缓存', fake.requestCount('GET', '/stats'), 0);

  console.log('--- 错误映射 ---');
  const failingReader = new HindsightInsightReader({
    baseUrl: fake.baseUrl,
    apiKey: TOKEN,
    bankPrefix: 'agentnet',
    requestTimeoutMs: 1_000,
    maxRetries: 0,
  });
  const failingService = new MemoryInsightService({
    db: env.d1,
    reader: failingReader,
    memoryEnabled: true,
    now: () => clock,
  });
  fake.fail('/stats', 500, 2);
  await expectBusiness(
    '上游 500 映射为不可用',
    failingService.overview(viewer('human', friend), { actor_id: target, refresh: true }),
    'MEMORY_UNAVAILABLE',
    'UPSTREAM_UNAVAILABLE',
  );
  try {
    await failingService.overview(viewer('human', friend), { actor_id: target, refresh: true });
  } catch (error) {
    const body = JSON.stringify({
      message: (error as BusinessError).message,
      details: (error as BusinessError).details,
    });
    check('错误不包含上游响应体', !body.includes(UPSTREAM_SECRET), body);
  }
  fake.fail('/stats', 401, 1);
  await expectBusiness(
    '上游 401 映射为不可用',
    failingService.overview(viewer('human', friend), { actor_id: target, refresh: true }),
    'MEMORY_UNAVAILABLE',
    'UPSTREAM_UNAVAILABLE',
  );
  fake.fail('/stats', 405, 1);
  const unsupported = await failingService.overview(viewer('human', friend), {
    actor_id: target,
    refresh: true,
  });
  checkEqual('上游 405 返回 backend_unsupported', unsupported.reason, 'backend_unsupported');

  const missingBankOverview = await failingService.overview(viewer('human', friend), {
    actor_id: missingBankAgent,
    refresh: true,
  });
  checkEqual('bank 404 返回 bank_missing', missingBankOverview.reason, 'bank_missing');

  const timeoutReader = new HindsightInsightReader({
    baseUrl: fake.baseUrl,
    apiKey: TOKEN,
    bankPrefix: 'agentnet',
    requestTimeoutMs: 80,
    maxRetries: 0,
  });
  const timeoutService = new MemoryInsightService({
    db: env.d1,
    reader: timeoutReader,
    memoryEnabled: true,
    now: () => clock,
  });
  fake.delay('/stats', 300);
  await expectBusiness(
    '上游超时映射为 UPSTREAM_TIMEOUT',
    timeoutService.overview(viewer('human', friend), { actor_id: target }),
    'MEMORY_UNAVAILABLE',
    'UPSTREAM_TIMEOUT',
  );

  fake.malformed('/stats');
  const parseService = new MemoryInsightService({
    db: env.d1,
    reader: new HindsightInsightReader({
      baseUrl: fake.baseUrl,
      apiKey: TOKEN,
      bankPrefix: 'agentnet',
      requestTimeoutMs: 2_000,
      maxRetries: 0,
    }),
    memoryEnabled: true,
    now: () => clock,
  });
  await expectBusiness(
    '上游 parse 失败映射为不可用',
    parseService.overview(viewer('human', friend), { actor_id: target }),
    'MEMORY_UNAVAILABLE',
    'UPSTREAM_UNAVAILABLE',
  );

  console.log('--- 降级状态与只读断言 ---');
  const disabledService = new MemoryInsightService({
    db: env.d1,
    reader: null,
    memoryEnabled: false,
  });
  await expectBusiness(
    'Memory 关闭时仍先授权',
    disabledService.overview(viewer('human', stranger), { actor_id: target }),
    'PERMISSION_DENIED',
    'FORBIDDEN',
  );
  const disabledOverview = await disabledService.overview(viewer('human', friend), {
    actor_id: target,
  });
  checkEqual('Memory 关闭返回 panel_disabled', disabledOverview.reason, 'panel_disabled');
  const unconfiguredService = new MemoryInsightService({
    db: env.d1,
    reader: null,
    memoryEnabled: true,
  });
  const unconfigured = await unconfiguredService.overview(viewer('human', friend), {
    actor_id: target,
  });
  checkEqual('无 Hindsight reader 返回 backend_not_configured', unconfigured.reason, 'backend_not_configured');

  const operationsBefore = await countRows(env.d1, 'operations');
  const eventsBefore = await countRows(env.d1, 'events');
  const outboxBefore = await countRows(env.d1, 'outbox');
  const spacesBefore = await countRows(env.d1, 'memory_spaces');
  await service.list(viewer('human', friend), { actor_id: target, refresh: true });
  await service.graph(viewer('human', friend), { actor_id: target, refresh: true });
  await service.entities(viewer('human', friend), { actor_id: target, view: 'graph', refresh: true });
  checkEqual('只读不写 operations', await countRows(env.d1, 'operations'), operationsBefore);
  checkEqual('只读不写 events', await countRows(env.d1, 'events'), eventsBefore);
  checkEqual('只读不写 outbox', await countRows(env.d1, 'outbox'), outboxBefore);
  checkEqual('只读不创建 memory space', await countRows(env.d1, 'memory_spaces'), spacesBefore);
  check(
    '所有上游请求都是 GET',
    fake.requests.every((request) => request.method === 'GET'),
    fake.requests.map((request) => request.method),
  );

  await fake.stop();
  console.log(`memory insight checks passed (${checksPassed()} assertions)`);
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
