/**
 * MF02 验收：Agent 空间、归属代次、来源/受众权限。
 *
 * 覆盖 M02–M07、M19、I02、I03、I10 中可由服务层直接证明的判定：
 * - 私聊秘密不因同 Agent 进入群而披露；manager 不能绕过第三方来源 ACL；
 * - from_join/归档上界/成员代次对来源与派生物同时生效；
 * - 管理转让切换 space/ownership_epoch 但保留 binding_id；
 * - 首次启用按当前管理关系初始化，认领同样切代次；
 * - 权限扩张不填充历史消费，退群重加不复制旧游标。
 *
 * 运行：bun run test:memory-access
 */
import { BusinessError } from '../src/contracts/errors';
import {
  authorizeRepresentationRead,
  authorizeSourceRead,
  ensureMemoryInstance,
  requireCurrentMemorySpace,
} from '../src/memory/access';
import {
  applyMemoryForget,
  admitExposureReceipt,
  ensureSpaceForAgent,
  getSource,
  initialSpaceStatements,
  ownershipTransferStatements,
  sourceMutationStatements,
} from '../src/memory/store';
import {
  coverageForSource,
  readMemoryExperience,
  registerRepresentation,
} from '../src/memory/store-objects';
import { check, checkEqual } from './lib/harness';
import {
  createMemoryEnv,
  experienceEntry,
  experienceKey,
  exposureReceipt,
  leaveAndRejoin,
  privateTarget,
  rawRepresentation,
  seedActor,
  seedManagement,
  seedRoom,
  spaceRef,
  summaryRepresentation,
  targetRoom,
  unique,
  updateRoomPolicy,
  type MemoryTestEnv,
} from './lib/memory-unit';

const AT = 1_700_000_000_000;

async function expectBusiness(
  label: string,
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    check(label, false, 'expected BusinessError');
  } catch (error) {
    checkEqual(label, error instanceof BusinessError ? error.code : 'UNKNOWN', code);
  }
}

async function addSource(
  env: MemoryTestEnv,
  input: {
    sourceId?: string;
    sourceKey: string;
    sourceKind?: 'message' | 'manual';
    roomId: string | null;
    memberGeneration: number;
    policyRevision: number;
    seq: number;
    text: string;
    author?: string | null;
    revision?: number;
    retracted?: boolean;
  },
): Promise<{ sourceId: string; row: NonNullable<Awaited<ReturnType<typeof getSource>>> }> {
  const sourceId = input.sourceId ?? unique('msrc');
  const textBytes = new TextEncoder().encode(input.text).length;
  const hash = new Bun.CryptoHasher('sha256').update(input.text).digest('hex');
  const statements = sourceMutationStatements(env.d1, {
    instanceId: 'mni_test',
    sourceId,
    sourceKey: input.sourceKey,
    sourceKind: input.sourceKind ?? 'message',
    businessRefKind: 'message',
    businessRefJson: JSON.stringify({ message_id: input.sourceKey }),
    originRoomId: input.roomId,
    originMemberGeneration: input.memberGeneration,
    originPolicyRevision: input.policyRevision,
    originJoinedSeq: 0,
    originJoinedAt: 0,
    originArchiveHeadSeq: null,
    originSeq: input.seq,
    originCreatedAt: AT + input.seq,
    authorActorId: input.author ?? null,
    revision: input.revision ?? 1,
    contentText: input.text,
    contentSha256: hash,
    contentBytes: textBytes,
    now: AT,
    retracted: input.retracted,
    retractionReason: input.retracted ? 'recall' : undefined,
  });
  await env.d1.batch(statements);
  const row = await getSource(env.d1, sourceId, input.revision ?? 1);
  if (!row) throw new Error('source seed failed');
  return { sourceId, row };
}

async function main(): Promise<void> {
  const env = createMemoryEnv();
  const instanceId = await ensureMemoryInstance(env.d1, { configuredId: 'mni_test', now: AT });
  checkEqual('稳定 instance id', instanceId, 'mni_test');

  const h1 = unique('usr_h1');
  const h2 = unique('usr_h2');
  const agent = unique('agt_a');
  const peer = unique('agt_b');
  seedActor(env, { actorId: h1, kind: 'human', name: '同名' });
  seedActor(env, { actorId: h2, kind: 'human', name: '同名' });
  seedActor(env, { actorId: agent, kind: 'agent', name: '同名 Agent' });
  seedActor(env, { actorId: peer, kind: 'agent', name: '同名 Agent' });
  const bindingId = seedManagement(env, { agentId: agent, managerId: h1 });
  seedManagement(env, { agentId: peer, managerId: h2, bindingId: 'amb_peer_fixed' });

  const direct = unique('rm_direct');
  seedRoom(env, {
    roomId: direct,
    kind: 'direct',
    ownerId: h1,
    members: [
      { actorId: agent, memberGeneration: 1 },
      { actorId: h2, memberGeneration: 1 },
    ],
    policyRevision: 0,
  });
  const group = unique('rm_group');
  seedRoom(env, {
    roomId: group,
    kind: 'group',
    ownerId: h1,
    members: [
      { actorId: h1, role: 'owner', memberGeneration: 1 },
      { actorId: h2, memberGeneration: 1 },
      { actorId: agent, memberGeneration: 1, joinedSeq: 0 },
      { actorId: peer, memberGeneration: 1 },
    ],
    policyRevision: 0,
    memberSeq: 4,
  });

  const space = await ensureSpaceForAgent(env.d1, { instanceId, agentId: agent, now: AT });
  checkEqual('首次启用 owner = 当前 manager', space.owner_actor_id, h1);
  checkEqual('首次启用 managed', space.ownership_kind, 'managed');
  checkEqual('首次启用 epoch', space.ownership_epoch, 1);

  const privateSource = await addSource(env, {
    sourceKey: `msg_${direct}_secret`,
    roomId: direct,
    memberGeneration: 1,
    policyRevision: 0,
    seq: 1,
    text: 'SECRET-PRIVATE-ALPHA',
    author: h2,
  });
  const groupSource = await addSource(env, {
    sourceKey: `msg_${group}_public`,
    roomId: group,
    memberGeneration: 1,
    policyRevision: 0,
    seq: 2,
    text: 'GROUP-PUBLIC-BETA',
    author: h1,
  });

  // M02：私聊秘密不能因同一 Agent 进入群而披露。
  const privateToGroup = await authorizeSourceRead(env.d1, {
    space,
    source: privateSource.row,
    agentId: agent,
    target_scope: targetRoom({
      roomId: group,
      memberGeneration: 1,
      memberSeq: 4,
      policyRevision: 0,
    }),
  });
  check('M02 私聊来源拒绝群受众', !privateToGroup.allowed, privateToGroup);
  checkEqual('M02 拒绝原因是跨房', privateToGroup.reason, 'different_room');
  const privateToSelf = await authorizeSourceRead(env.d1, {
    space,
    source: privateSource.row,
    agentId: agent,
    target_scope: privateTarget(),
  });
  check('M02 私聊仍可进入自身上下文', privateToSelf.allowed);
  const groupToGroup = await authorizeSourceRead(env.d1, {
    space,
    source: groupSource.row,
    agentId: agent,
    target_scope: targetRoom({
      roomId: group,
      memberGeneration: 1,
      memberSeq: 4,
      policyRevision: 0,
    }),
  });
  check('M02 群来源可向同群披露', groupToGroup.allowed);

  // I10：manager 只拿到管理元数据，不能借用管理权读正文。
  const privateRep = await rawRepresentation({
    sourceId: privateSource.sourceId,
    sourceRevision: 1,
    text: 'SECRET-PRIVATE-ALPHA',
  });
  await registerRepresentation(env.d1, { instanceId, exact: privateRep, now: AT });
  const admitted = await admitExposureReceipt(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    receipt: exposureReceipt({
      space: spaceRef(space),
      agentId: agent,
      targetScope: privateTarget(),
      originScopes: [
        {
          room_id: direct,
          member_generation: 1,
          policy_revision: 0,
          joined_seq: 0,
          joined_at: 0,
          archive_head_seq: null,
        },
      ],
    }),
    representations: [privateRep],
    experiences: [
      experienceEntry({
        key: experienceKey({
          space: spaceRef(space),
          agentId: agent,
          originRoomId: direct,
          originMemberGeneration: 1,
          sourceId: privateSource.sourceId,
          sourceRevision: 1,
          representation: privateRep,
        }),
        originRoomId: direct,
      }),
    ],
    minimumEvidence: 'host_reported_submitted',
    now: AT,
  });
  checkEqual('I10 合格回执接纳经历', admitted.disposition.disposition, 'applied');
  const experienceId = admitted.experience_ids[0]!;
  await expectBusiness(
    'I10 manager 读取经历正文被拒绝',
    readMemoryExperience(env.d1, {
      instanceId,
      agentId: agent,
      space: spaceRef(space),
      experienceId,
      targetScope: privateTarget(),
      callerActorId: h1,
      now: AT,
    }),
    'PERMISSION_DENIED',
  );
  const privateExperienceRead = await readMemoryExperience(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    experienceId,
    targetScope: privateTarget(),
    callerActorId: agent,
    now: AT,
  });
  check('I10 Agent 自身可读取私聊经历', privateExperienceRead.available);

  // M03/M06：混合私聊+群来源的派生物不能进入群。
  const mixedSummary = await summaryRepresentation({
    summaryId: 'sum_mixed',
    revision: 1,
    text: 'SUMMARY-MIXED',
    dependencies: [
      { source_id: privateSource.sourceId, source_revision: 1 },
      { source_id: groupSource.sourceId, source_revision: 1 },
    ],
  });
  await registerRepresentation(env.d1, {
    instanceId,
    exact: mixedSummary,
    dependencies: mixedSummary.representation.depends_on,
    now: AT,
  });
  const mixedToGroup = await authorizeRepresentationRead(env.d1, {
    space,
    representationId: mixedSummary.representation.representation_id,
    agentId: agent,
    target_scope: targetRoom({
      roomId: group,
      memberGeneration: 1,
      memberSeq: 4,
      policyRevision: 0,
    }),
  });
  check('M03/M06 混合派生物拒绝群披露', !mixedToGroup.allowed, mixedToGroup);
  const mixedToSelf = await authorizeRepresentationRead(env.d1, {
    space,
    representationId: mixedSummary.representation.representation_id,
    agentId: agent,
    target_scope: privateTarget(),
  });
  check('M03/M06 混合派生物仍可用于自身', mixedToSelf.allowed);

  // M07：同域来源策略收紧后，旧派生物不能继续按旧证明披露。
  updateRoomPolicy(env, group, { policy: 'full', revision: 1 });
  const staleGroup = await authorizeSourceRead(env.d1, {
    space,
    source: groupSource.row,
    agentId: agent,
    target_scope: targetRoom({
      roomId: group,
      memberGeneration: 1,
      memberSeq: 4,
      policyRevision: 1,
    }),
  });
  check('M07 策略版本变化使旧来源证明失效', !staleGroup.allowed, staleGroup);
  checkEqual('M07 原因是 policy_changed', staleGroup.reason, 'policy_changed');

  // M04：两个同名 Agent 的空间互不共享；猜 space id 不越权。
  const peerSpace = await ensureSpaceForAgent(env.d1, { instanceId, agentId: peer, now: AT });
  check('M04 同名 Agent space 独立', space.space_id !== peerSpace.space_id);
  await expectBusiness(
    'M04 猜测 space/epoch 被拒绝',
    requireCurrentMemorySpace(env.d1, {
      agentId: agent,
      instanceId,
      expected: { space_id: peerSpace.space_id, ownership_epoch: 1, backend_binding_epoch: 1 },
      at: AT,
    }),
    'MEMORY_TARGET_INVALID',
  );

  // I02/M05：管理转让切换 space/epoch，但 agent_managements.binding_id 原地保留。
  const previousSpace = space;
  const transferStatements = await ownershipTransferStatements(env.d1, {
    instanceId,
    agentId: agent,
    ownerActorId: h2,
    ownershipKind: 'managed',
    managementBindingId: bindingId,
    kind: 'management_transfer',
    now: AT + 10,
  });
  await env.d1.batch([
    ...transferStatements,
    env.d1
      .prepare(
        `UPDATE agent_managements
            SET manager_id = ?, permission_version = permission_version + 1, updated_at = ?
          WHERE agent_id = ? AND status = 'active'`,
      )
      .bind(h2, AT + 10, agent),
  ]);
  const afterTransfer = await env.d1
    .prepare('SELECT * FROM memory_spaces WHERE agent_actor_id = ? AND active = 1')
    .bind(agent)
    .first<{ space_id: string; ownership_epoch: number; owner_actor_id: string; backend_binding_epoch: number }>();
  check('M05 转让后活动 space 变化', afterTransfer !== null && afterTransfer.space_id !== previousSpace.space_id);
  checkEqual('M05 转让后 ownership_epoch 递增', afterTransfer?.ownership_epoch, 2);
  checkEqual('M05 转让后 owner 切换', afterTransfer?.owner_actor_id, h2);
  const managementAfter = await env.d1
    .prepare('SELECT binding_id, manager_id FROM agent_managements WHERE agent_id = ? AND status = ?')
    .bind(agent, 'active')
    .first<{ binding_id: string; manager_id: string }>();
  checkEqual('I02 binding_id 原地保留', managementAfter?.binding_id, bindingId);
  checkEqual('I02 manager 已切换', managementAfter?.manager_id, h2);

  await expectBusiness(
    'M05 旧 space/epoch 不能继续读取',
    requireCurrentMemorySpace(env.d1, {
      agentId: agent,
      instanceId,
      expected: spaceRef(previousSpace),
      at: AT + 11,
    }),
    'MEMORY_TARGET_INVALID',
  );
  const oldExperience = await readMemoryExperience(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(afterTransfer!),
    experienceId,
    targetScope: privateTarget(),
    callerActorId: agent,
    now: AT + 11,
  });
  check('M05 新 owner 不自动获得旧私密正文', !oldExperience.available, oldExperience);

  const lateReceipt = await admitExposureReceipt(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(previousSpace),
    receipt: exposureReceipt({
      space: spaceRef(previousSpace),
      agentId: agent,
      targetScope: privateTarget(),
      originScopes: [
        {
          room_id: direct,
          member_generation: 1,
          policy_revision: 0,
          joined_seq: 0,
          joined_at: 0,
          archive_head_seq: null,
        },
      ],
    }),
    representations: [privateRep],
    experiences: [
      experienceEntry({
        key: experienceKey({
          space: spaceRef(previousSpace),
          agentId: agent,
          originRoomId: direct,
          originMemberGeneration: 1,
          sourceId: privateSource.sourceId,
          sourceRevision: 1,
          representation: privateRep,
        }),
        originRoomId: direct,
      }),
    ],
    minimumEvidence: 'host_reported_submitted',
    now: AT + 12,
  });
  checkEqual('M05 迟到回执只补历史', lateReceipt.disposition.disposition, 'history_only');
  checkEqual('M05 迟到回执原因是归属变化', lateReceipt.disposition.reason, 'ownership_changed');
  checkEqual('M05 迟到回执不产生新 owner 经历', lateReceipt.experience_ids.length, 0);

  // I02：自注册 Agent 首次认领切代次。
  const selfAgent = unique('agt_self');
  seedActor(env, { actorId: selfAgent, kind: 'agent' });
  await env.d1.batch(
    initialSpaceStatements(env.d1, {
      instanceId,
      agentId: selfAgent,
      ownerActorId: selfAgent,
      ownershipKind: 'self_owned',
      managementBindingId: null,
      now: AT,
    }),
  );
  const selfSpace = await env.d1
    .prepare('SELECT * FROM memory_spaces WHERE agent_actor_id = ? AND active = 1')
    .bind(selfAgent)
    .first<{ space_id: string; ownership_epoch: number; owner_actor_id: string; backend_binding_epoch: number }>();
  checkEqual('I02 自注册初始 self_owned', selfSpace?.owner_actor_id, selfAgent);
  const claimBinding = 'amb_claim_fixed';
  const claimStatements = await ownershipTransferStatements(env.d1, {
    instanceId,
    agentId: selfAgent,
    ownerActorId: h1,
    ownershipKind: 'managed',
    managementBindingId: claimBinding,
    kind: 'initial_claim',
    now: AT + 20,
  });
  await env.d1.batch([
    ...claimStatements,
    env.d1
      .prepare(
        `INSERT INTO agent_managements
           (binding_id, agent_id, manager_id, status, grant_source, scopes_json,
            permission_version, initiated_by, confirmed_by, created_at, confirmed_at,
            expires_at, revoked_at, revoked_by, updated_at)
         VALUES (?, ?, ?, 'active', 'claim', '[]', 1, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      )
      .bind(claimBinding, selfAgent, h1, selfAgent, h1, AT + 20, AT + 20, AT + 20),
  ]);
  const claimedSpace = await env.d1
    .prepare('SELECT * FROM memory_spaces WHERE agent_actor_id = ? AND active = 1')
    .bind(selfAgent)
    .first<{ space_id: string; ownership_epoch: number; owner_actor_id: string }>();
  checkEqual('I02 认领后 owner 切换', claimedSpace?.owner_actor_id, h1);
  checkEqual('I02 认领后 epoch 递增', claimedSpace?.ownership_epoch, 2);

  // M19：撤权/遗忘后迟到回执不产生可读正文或 retain。
  await applyMemoryForget(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(afterTransfer!),
    sourceId: groupSource.sourceId,
    sourceKey: groupSource.row.source_key,
    reason: 'forget',
    now: AT + 30,
  });
  const groupRep = await rawRepresentation({
    sourceId: groupSource.sourceId,
    sourceRevision: 1,
    text: 'GROUP-PUBLIC-BETA',
  });
  const lateAfterForget = await admitExposureReceipt(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(afterTransfer!),
    receipt: exposureReceipt({
      space: spaceRef(afterTransfer!),
      agentId: agent,
      targetScope: targetRoom({
        roomId: group,
        memberGeneration: 1,
        memberSeq: 4,
        policyRevision: 1,
      }),
      originScopes: [
        {
          room_id: group,
          member_generation: 1,
          policy_revision: 0,
          joined_seq: 0,
          joined_at: 0,
          archive_head_seq: null,
        },
      ],
    }),
    representations: [groupRep],
    experiences: [
      experienceEntry({
        key: experienceKey({
          space: spaceRef(afterTransfer!),
          agentId: agent,
          originRoomId: group,
          originMemberGeneration: 1,
          sourceId: groupSource.sourceId,
          sourceRevision: 1,
          representation: groupRep,
        }),
        originRoomId: group,
      }),
    ],
    minimumEvidence: 'host_reported_submitted',
    now: AT + 31,
  });
  checkEqual('M19 遗忘后迟到回执只补历史', lateAfterForget.disposition.disposition, 'history_only');
  checkEqual('M19 不产生新的可读经历', lateAfterForget.experience_ids.length, 0);
  const forgottenSource = await authorizeSourceRead(env.d1, {
    space: afterTransfer!,
    source: groupSource.row,
    agentId: agent,
    target_scope: privateTarget(),
  });
  check('M19 tombstone 阻止旧正文再次读取', !forgottenSource.allowed, forgottenSource);

  // I03：from_join、退群重加、策略扩张与归档上界。
  const fromJoinRoom = unique('rm_from_join');
  seedRoom(env, {
    roomId: fromJoinRoom,
    kind: 'group',
    ownerId: h1,
    policy: 'from_join',
    policyRevision: 0,
    memberSeq: 2,
    members: [
      { actorId: h1, role: 'owner', memberGeneration: 1 },
      { actorId: agent, memberGeneration: 1, joinedSeq: 100 },
    ],
  });
  const beforeJoin = await addSource(env, {
    sourceKey: `msg_${fromJoinRoom}_50`,
    roomId: fromJoinRoom,
    memberGeneration: 1,
    policyRevision: 0,
    seq: 50,
    text: 'BEFORE-JOIN',
  });
  const afterJoin = await addSource(env, {
    sourceKey: `msg_${fromJoinRoom}_120`,
    roomId: fromJoinRoom,
    memberGeneration: 1,
    policyRevision: 0,
    seq: 120,
    text: 'AFTER-JOIN',
  });
  const beforeDecision = await authorizeSourceRead(env.d1, {
    space: afterTransfer!,
    source: beforeJoin.row,
    agentId: agent,
    target_scope: privateTarget(),
  });
  check('I03 from_join 阻止加入前来源', !beforeDecision.allowed, beforeDecision);
  checkEqual('I03 原因是历史边界', beforeDecision.reason, 'history_bound');
  const afterDecision = await authorizeSourceRead(env.d1, {
    space: afterTransfer!,
    source: afterJoin.row,
    agentId: agent,
    target_scope: privateTarget(),
  });
  check('I03 加入后来源可读', afterDecision.allowed);

  // 旧 generation 的消费不复制到退群重加后的新 generation。
  const coveredRep = await rawRepresentation({
    sourceId: afterJoin.sourceId,
    sourceRevision: 1,
    text: 'AFTER-JOIN',
  });
  await registerRepresentation(env.d1, { instanceId, exact: coveredRep, now: AT });
  const coveredReceipt = exposureReceipt({
    space: spaceRef(afterTransfer!),
    agentId: agent,
    targetScope: privateTarget(),
    originScopes: [
      {
        room_id: fromJoinRoom,
        member_generation: 1,
        policy_revision: 0,
        joined_seq: 100,
        joined_at: AT,
        archive_head_seq: null,
      },
    ],
  });
  const covered = await admitExposureReceipt(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(afterTransfer!),
    receipt: coveredReceipt,
    representations: [coveredRep],
    experiences: [
      experienceEntry({
        key: experienceKey({
          space: spaceRef(afterTransfer!),
          agentId: agent,
          originRoomId: fromJoinRoom,
          originMemberGeneration: 1,
          sourceId: afterJoin.sourceId,
          sourceRevision: 1,
          representation: coveredRep,
        }),
        originRoomId: fromJoinRoom,
      }),
    ],
    minimumEvidence: 'host_reported_submitted',
    now: AT + 40,
  });
  checkEqual('I03 合格回执建立原文覆盖', covered.disposition.disposition, 'applied');
  const coverageGen1 = await coverageForSource(env.d1, {
    spaceId: afterTransfer!.space_id,
    ownershipEpoch: afterTransfer!.ownership_epoch,
    agentId: agent,
    sourceId: afterJoin.sourceId,
    sourceRevision: 1,
    originRoomId: fromJoinRoom,
    originMemberGeneration: 1,
  });
  check('I03 旧 generation 有覆盖', coverageGen1.full);
  leaveAndRejoin(env, fromJoinRoom, agent, { joinedSeq: 130, memberGeneration: 2, at: AT + 50 });
  const coverageGen2 = await coverageForSource(env.d1, {
    spaceId: afterTransfer!.space_id,
    ownershipEpoch: afterTransfer!.ownership_epoch,
    agentId: agent,
    sourceId: afterJoin.sourceId,
    sourceRevision: 1,
    originRoomId: fromJoinRoom,
    originMemberGeneration: 2,
  });
  checkEqual('I03 退群重加不复制旧消费游标', coverageGen2.ranges.length, 0);
  const oldGenSource = await authorizeSourceRead(env.d1, {
    space: afterTransfer!,
    source: afterJoin.row,
    agentId: agent,
    target_scope: privateTarget(),
  });
  check('I03 旧 generation 来源不再可读', !oldGenSource.allowed, oldGenSource);
  checkEqual('I03 原因是成员代次', oldGenSource.reason, 'membership_stale');

  // 策略扩张不填充历史消费：旧来源仍按旧 policy revision 失效。
  updateRoomPolicy(env, fromJoinRoom, { policy: 'full', revision: 1 });
  const afterExpansion = await authorizeSourceRead(env.d1, {
    space: afterTransfer!,
    source: afterJoin.row,
    agentId: agent,
    target_scope: privateTarget(),
  });
  check(
    'I03 策略扩张不自动恢复旧来源证明',
    !afterExpansion.allowed,
    afterExpansion,
  );

  // 归档上界：解散群不能读到 archive_head_seq 之后。
  const archiveRoom = unique('rm_archive');
  seedRoom(env, {
    roomId: archiveRoom,
    kind: 'group',
    ownerId: h1,
    policy: 'full',
    policyRevision: 0,
    memberSeq: 2,
    dissolved: true,
    archiveHeadSeq: 120,
    members: [
      { actorId: h1, role: 'owner', memberGeneration: 1 },
      { actorId: agent, memberGeneration: 1 },
    ],
  });
  const archivedSource = await addSource(env, {
    sourceKey: `msg_${archiveRoom}_130`,
    roomId: archiveRoom,
    memberGeneration: 1,
    policyRevision: 0,
    seq: 130,
    text: 'AFTER-ARCHIVE',
  });
  const archiveDecision = await authorizeSourceRead(env.d1, {
    space: afterTransfer!,
    source: archivedSource.row,
    agentId: agent,
    target_scope: privateTarget(),
  });
  check('I03 归档上界阻止新来源', !archiveDecision.allowed, archiveDecision);

  // 管理转让后旧 owner 查询当前空间失败（服务端按当前管理关系解析）。
  await expectBusiness(
    'I02 旧 owner 不能继续使用旧空间',
    requireCurrentMemorySpace(env.d1, {
      agentId: agent,
      instanceId,
      expected: spaceRef(previousSpace),
      at: AT + 60,
    }),
    'MEMORY_TARGET_INVALID',
  );
  const current = await requireCurrentMemorySpace(env.d1, {
    agentId: agent,
    instanceId,
    at: AT + 61,
  });
  checkEqual('I02 当前空间归属新 owner', current.space.owner_actor_id, h2);

  env.db.close();
}

main()
  .then(() => {
    console.log('memory access checks passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
