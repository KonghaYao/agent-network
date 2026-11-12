/**
 * MF11 验收（三）：跨群 origin scope 与数值空洞。
 *
 * 覆盖 C19/C11：跨群输入只归来源房间，目的房间不产生 raw 经历；无 grant
 * 的受众不能读摘要/正文；frontier 枚举真实消息而非 MAX(created_seq)。
 *
 * 运行：bun run test:memory-experience
 */
import { check, checkEqual, checksPassed } from './lib/harness';
import { createMemoryEnv, privateTarget, rawRepresentation, seedRoom, targetRoom, unique } from './lib/memory-unit';
import { buildSubmittedInputManifest } from '../src/memory/input-manifest';
import { recordHostInputExposure } from '../src/memory/host-exposure';
import { createSourceSelections, experienceCoverage, listExperiences, sourceRawCoverage } from '../src/memory/experience';
import { coverageForSource } from '../src/memory/store-objects';
import {
  AT,
  addSource,
  bindHost,
  expectCode,
  insertMessage,
  instanceId,
  invocation,
  messageTarget,
  setupAgentRoom,
} from './lib/memory-mf11';

async function main(): Promise<void> {
  const env = createMemoryEnv();
  const third = await setupAgentRoom(env, 'coverage');
  const thirdBinding = await bindHost(env, { agentId: third.agent, space: third.space });

  // 跨群 origin scope 与数值空洞
  const roomX = unique('room_cross_x');
  const roomY = unique('room_cross_y');
  seedRoom(env, {
    roomId: roomX,
    kind: 'group',
    ownerId: third.manager,
    members: [
      { actorId: third.agent, role: 'member' },
      { actorId: third.manager, role: 'owner' },
    ],
    memberSeq: 2,
    headSeq: 1,
    now: AT,
  });
  seedRoom(env, {
    roomId: roomY,
    kind: 'group',
    ownerId: third.manager,
    members: [
      { actorId: third.agent, role: 'member' },
      { actorId: third.manager, role: 'owner' },
    ],
    memberSeq: 2,
    headSeq: 0,
    now: AT,
  });
  const crossMessageId = `msg_${roomX}_1`;
  insertMessage(env, {
    messageId: crossMessageId,
    roomId: roomX,
    senderId: third.manager,
    seq: 1,
    body: 'CROSS-ROOM-X-SECRET',
  });
  const crossSource = await addSource(env, {
    sourceKey: `message:${crossMessageId}`,
    roomId: roomX,
    seq: 1,
    text: 'CROSS-ROOM-X-SECRET',
  });
  const crossExact = await rawRepresentation({
    sourceId: crossSource.sourceId,
    sourceRevision: 1,
    text: crossSource.text,
  });
  const yScope = targetRoom({
    roomId: roomY,
    memberGeneration: 1,
    memberSeq: 2,
    policyRevision: 0,
  });
  const crossGrant = {
    grant_id: 'grant_cross_room',
    from_room_id: roomX,
    to_room_id: roomY,
  };
  await expectCode(
    '无 grant 的跨房选择被拒绝',
    createSourceSelections(env.d1, {
      instanceId,
      agentId: third.agent,
      space: third.space,
      targetScope: yScope,
      representations: [crossExact],
      now: AT + 5,
    }),
    'PERMISSION_DENIED',
  );
  const [crossSelection] = await createSourceSelections(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    targetScope: yScope,
    grant: crossGrant,
    representations: [crossExact],
    now: AT + 5,
  });
  const crossInv = invocation(thirdBinding.binding_id, thirdBinding.generation, 'cross_1');
  const crossTarget = await messageTarget(env, {
    agentId: third.agent,
    space: third.space,
    bindingId: thirdBinding.binding_id,
    generation: thirdBinding.generation,
    inv: crossInv,
    targetScope: yScope,
    roomId: roomY,
  });
  const crossManifest = await buildSubmittedInputManifest(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    hostBindingId: thirdBinding.binding_id,
    hostGeneration: thirdBinding.generation,
    invocation: crossInv,
    target: crossTarget,
    payload: crossSource.text,
    items: [
      {
        selection_id: crossSelection!.selection_id,
        representation_id: crossExact.representation.representation_id,
        text_sha256: crossExact.representation.text_sha256,
      },
    ],
    now: AT + 5,
  });
  await recordHostInputExposure(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    hostBindingId: thirdBinding.binding_id,
    hostGeneration: thirdBinding.generation,
    manifestId: crossManifest.manifest.manifest_id,
    requestId: 'req_cross_1',
    crossRoomGrant: crossGrant,
    now: AT + 5,
  });
  const crossXList = await listExperiences(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    targetScope: privateTarget(),
    roomId: roomX,
    now: AT + 6,
  });
  const crossYList = await listExperiences(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    targetScope: privateTarget(),
    roomId: roomY,
    now: AT + 6,
  });
  checkEqual('跨群输入归来源房间 X', crossXList.items.length, 1);
  checkEqual('目的房间 Y 不产生 raw 经历', crossYList.items.length, 0);
  const crossYTargetList = await listExperiences(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    targetScope: yScope,
    roomId: roomX,
    now: AT + 6,
  });
  checkEqual('无 grant 的 Y 受众不泄露 X 经历', crossYTargetList.items.length, 0);
  const crossCoverage = await coverageForSource(env.d1, {
    spaceId: third.space.space_id,
    ownershipEpoch: third.space.ownership_epoch,
    agentId: third.agent,
    sourceId: crossSource.sourceId,
    sourceRevision: 1,
    originRoomId: roomX,
    originMemberGeneration: 1,
  });
  check('跨群输入只推进来源 X 的原文范围', crossCoverage.full);

  const holesRoom = unique('room_holes');
  seedRoom(env, {
    roomId: holesRoom,
    kind: 'direct',
    ownerId: third.manager,
    members: [
      { actorId: third.agent, role: 'member' },
      { actorId: third.manager, role: 'owner' },
    ],
    memberSeq: 2,
    headSeq: 12,
    now: AT,
  });
  const holeA = `msg_${holesRoom}_1`;
  const holeB = `msg_${holesRoom}_12`;
  insertMessage(env, {
    messageId: holeA,
    roomId: holesRoom,
    senderId: third.manager,
    seq: 1,
    body: 'HOLE-1',
  });
  insertMessage(env, {
    messageId: holeB,
    roomId: holesRoom,
    senderId: third.manager,
    seq: 12,
    body: 'HOLE-12',
  });
  const holeSourceA = await addSource(env, {
    sourceKey: `message:${holeA}`,
    roomId: holesRoom,
    seq: 1,
    text: 'HOLE-1',
  });
  const holeSourceB = await addSource(env, {
    sourceKey: `message:${holeB}`,
    roomId: holesRoom,
    seq: 12,
    text: 'HOLE-12',
  });
  const holeExactA = await rawRepresentation({
    sourceId: holeSourceA.sourceId,
    sourceRevision: 1,
    text: holeSourceA.text,
  });
  const holeExactB = await rawRepresentation({
    sourceId: holeSourceB.sourceId,
    sourceRevision: 1,
    text: holeSourceB.text,
  });
  const holeSelections = await createSourceSelections(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    targetScope: privateTarget(),
    representations: [holeExactA, holeExactB],
    now: AT + 6,
  });
  const holeInv = invocation(thirdBinding.binding_id, thirdBinding.generation, 'holes_1');
  const holeTarget = await messageTarget(env, {
    agentId: third.agent,
    space: third.space,
    bindingId: thirdBinding.binding_id,
    generation: thirdBinding.generation,
    inv: holeInv,
    targetScope: privateTarget(),
    roomId: holesRoom,
  });
  const holeManifest = await buildSubmittedInputManifest(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    hostBindingId: thirdBinding.binding_id,
    hostGeneration: thirdBinding.generation,
    invocation: holeInv,
    target: holeTarget,
    payload: `${holeSourceA.text}|${holeSourceB.text}`,
    items: holeSelections.map((item) => ({
      selection_id: item.selection_id,
      representation_id: item.representation.representation_id,
      text_sha256: item.representation.text_sha256,
    })),
    now: AT + 6,
  });
  await recordHostInputExposure(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    hostBindingId: thirdBinding.binding_id,
    hostGeneration: thirdBinding.generation,
    manifestId: holeManifest.manifest.manifest_id,
    requestId: 'req_holes_1',
    now: AT + 6,
  });
  const holeFrontier = await experienceCoverage(env.d1, {
    instanceId,
    agentId: third.agent,
    space: third.space,
    roomId: holesRoom,
    memberGeneration: 1,
    now: AT + 7,
  });
  checkEqual('数值空洞不是缺口，frontier 前进到真实消息 12', holeFrontier.frontier_seq, 12);
  checkEqual('真实消息数只有 2 条', holeFrontier.actual_messages, 2);

  console.log(`\nMF11 coverage checks passed: ${checksPassed()} 项`);
}

await main();
