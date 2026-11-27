/**
 * Task Focus 秘书运行时验收（临时 SQLite + 真迁移）。
 *
 * 覆盖：服务身份与凭据轮换、Watch 候选（provisioning 入队/active 组批）、
 * 作业派发与租约、四个秘书工具的授权与幂等、owner 隔离、归档/版本/代次
 * 拒绝、暂停重开候选重排、领取流水、focus_updated 只通知 owner。
 */

import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { BusinessError } from '../src/contracts/errors';
import { LIMITS } from '../src/contracts/limits';
import type { FocusCommitReceipt } from '../src/contracts/focus';
import { focusDisable, focusEnable, focusStatus } from '../src/domain/focus/bindings';
import { focusArchive, focusGet } from '../src/domain/focus/items';
import type { FocusBindingRow, FocusJobRow, FocusCandidateRow } from '../src/domain/focus/types';
import type { Principal } from '../src/domain/principal';
import type { Env, FocusRuntimeConfig } from '../src/env';
import { resolveFocusConfig } from '../src/focus/config';
import { dispatchFocusJob, ensureJobs, provisionFocusBinding, recoverFocusJobs } from '../src/focus/jobs';
import {
  focusCommit,
  focusEvidenceRead,
  focusItemsFind,
  focusJobGet,
} from '../src/focus/secretary';
import {
  FOCUS_SERVICE_ACTOR_ID,
  ensureFocusServiceActor,
  requireFocusService,
} from '../src/focus/service';
import { createFocusSwarmClient } from '../src/focus/swarm-client';
import { scanFocusEvents } from '../src/focus/watch';
import { deliveryClaim } from '../src/domain/deliveries';
import { register } from '../src/mcp/tool-registration';
import { registerFocusSecretaryTools } from '../src/mcp/focus-secretary-tools';
import type { RegistrationServer } from '../src/mcp/registration';
import { getActor } from '../src/storage/queries';
import { check, checkEqual, CheckFailure, checksPassed } from './lib/harness';
import { startFocusFakeSwarm, type FakeSwarm } from './lib/focus-fake-swarm';

const AT = 1_760_000_000_000;

const H1 = 'usr_focus_h1';
const H2 = 'usr_focus_h2';
const A1 = 'agt_focus_worker';
const G1 = 'rm_focus_shared';
const G2 = 'rm_focus_acceptance';
const DM = 'rm_focus_dm';

const SERVICE_TOKEN_1 = 'focus-service-token-one';
const SERVICE_TOKEN_2 = 'focus-service-token-two';

let db: Database;
let d1: D1Database;
let fake: FakeSwarm;
let runtimeConfig: FocusRuntimeConfig;

function scalar<T>(sql: string, ...binds: Array<string | number>): T {
  return db.prepare(sql).get(...binds) as T;
}

function count(sql: string, ...binds: Array<string | number>): number {
  return scalar<{ n: number }>(sql, ...binds).n;
}

async function principalFor(actor: string): Promise<Principal> {
  const row = await getActor(d1, actor);
  if (!row) throw new CheckFailure('seed', `缺少 actor: ${actor}`);
  return { credentialHash: `hash_${actor}`, actor: row, credential: null };
}

async function expectCode(label: string, promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof BusinessError)) throw error;
    checkEqual(label, error.code, code);
    return;
  }
  throw new CheckFailure(label, `期望 ${code}，但调用成功`);
}

function expectCodeSync(label: string, action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    if (!(error instanceof BusinessError)) throw error;
    checkEqual(label, error.code, code);
    return;
  }
  throw new CheckFailure(label, `期望 ${code}，但调用成功`);
}

function seedBase(): void {
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('${H1}', 'human', NULL, '林舟', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${H2}', 'human', NULL, '周敏', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${A1}', 'agent', 'sess_worker', '回归 Agent', '{}', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, head_seq, events_min_seq, member_seq,
       member_history_policy, created_at, updated_at)
    VALUES
      ('${G1}', 'group', '${H1}', '版本发布群', 0, 0, 0, 'full', ${AT}, ${AT}),
      ('${G2}', 'group', '${H1}', '灰度验收群', 0, 0, 0, 'full', ${AT}, ${AT}),
      ('${DM}', 'direct', NULL, '', 0, 0, 0, 'full', ${AT}, ${AT});

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
    VALUES
      ('${G1}', '${H1}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${G1}', '${H2}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${G1}', '${A1}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${G2}', '${H1}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${G2}', '${A1}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${DM}', '${H1}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${DM}', '${H2}', 'member', 'active', 0, 0, ${AT}, 1, ${AT});
  `);
}

interface SeededMessage {
  messageId: string;
  seq: number;
}

let messageCounter = 0;

function seedMessage(roomId: string, sender: string, body: string, messageId?: string): SeededMessage {
  messageCounter += 1;
  const id = messageId ?? `msg_focus_rt_${messageCounter}`;
  const eventKey = `message:${id}`;
  db.prepare(
    `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
     VALUES ('room', ?, 'message_created', ?, ?, ?, ?)`,
  ).run(
    roomId,
    id,
    JSON.stringify({ sender_id: sender, sender_name: null, sender_kind: null, deliveries: 0 }),
    eventKey,
    AT + messageCounter,
  );
  const seq = scalar<{ n: number }>(
    'SELECT event_seq AS n FROM events WHERE event_key = ?',
    eventKey,
  ).n;
  db.prepare(
    `INSERT INTO messages
       (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes, preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    roomId,
    sender,
    `cm_${id}`,
    seq,
    body,
    new TextEncoder().encode(body).length,
    body.slice(0, 120),
    AT + messageCounter,
  );
  db.prepare('UPDATE rooms SET head_seq = ? WHERE room_id = ?').run(seq, roomId);
  return { messageId: id, seq };
}

function seedDeliveryClaimEvent(
  roomId: string,
  message: SeededMessage,
  recipient: string,
  claimedBy: string,
): string {
  const deliveryId = `dlv_focus_rt_${message.messageId}`;
  db.prepare(
    `INSERT INTO deliveries
       (delivery_id, recipient_id, message_id, room_id, state, attempt, claim_id, claimed_at,
        progress_at, result_message_id, error, created_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(deliveryId, recipient, message.messageId, roomId, message.seq, AT, AT);
  const eventKey = `room_delivery:claim:${deliveryId}:req_seed_claim`;
  db.prepare(
    `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
     VALUES ('room', ?, 'delivery_claimed', ?, ?, ?, ?)`,
  ).run(
    roomId,
    deliveryId,
    JSON.stringify({
      delivery_id: deliveryId,
      message_id: message.messageId,
      state: 'claimed',
      actor_id: claimedBy,
      recipient_id: recipient,
    }),
    eventKey,
    AT + 500,
  );
  return deliveryId;
}

function bindingOf(owner: string): FocusBindingRow {
  return scalar<FocusBindingRow>(
    'SELECT * FROM focus_bindings WHERE owner_actor_id = ?',
    owner,
  );
}

function jobOf(owner: string): FocusJobRow {
  return scalar<FocusJobRow>(
    `SELECT * FROM focus_jobs WHERE owner_actor_id = ?
      ORDER BY created_at DESC, job_id DESC LIMIT 1`,
    owner,
  );
}

function candidatesOf(owner: string): FocusCandidateRow[] {
  return db
    .prepare(
      `SELECT * FROM focus_candidates WHERE owner_actor_id = ?
        ORDER BY event_seq, candidate_id`,
    )
    .all(owner) as FocusCandidateRow[];
}

function candidateByKey(owner: string, sourceKey: string): FocusCandidateRow {
  return scalar<FocusCandidateRow>(
    'SELECT * FROM focus_candidates WHERE owner_actor_id = ? AND source_key = ?',
    owner,
    sourceKey,
  );
}

function baseEnv(): Env {
  return { DB: d1 } as unknown as Env;
}

function runtimeEnv(): Env {
  return { DB: d1, FOCUS: runtimeConfig } as unknown as Env;
}

async function waitForJob(jobId: string, statuses: string[]): Promise<FocusJobRow> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = scalar<FocusJobRow>('SELECT * FROM focus_jobs WHERE job_id = ?', jobId);
    if (statuses.includes(row.status)) return row;
    await Bun.sleep(10);
  }
  throw new CheckFailure('dispatch', `作业未进入 ${statuses.join('/')}`);
}

async function run(): Promise<void> {
  console.log('  · 配置与服务身份');
  checkEqual('五项全空返回 null', resolveFocusConfig({}), null);
  try {
    resolveFocusConfig({
      WEBOTS_SWARM_BASE_URL: 'https://swarm.invalid/v1',
      WEBOTS_FOCUS_MODEL: 'model-secret-value',
    });
    throw new CheckFailure('部分配置', '期望启动失败');
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    check('部分配置报缺失变量名', text.includes('WEBOTS_SWARM_API_KEY') && text.includes('WEBOTS_FOCUS_MCP_URL'));
    check('错误信息不含配置值', !text.includes('model-secret-value'));
  }
  checkEqual(
    '完整配置解析',
    resolveFocusConfig({
      WEBOTS_SWARM_BASE_URL: 'https://swarm.invalid/v1',
      WEBOTS_SWARM_API_KEY: 'k',
      WEBOTS_FOCUS_MODEL: 'm',
      WEBOTS_FOCUS_MCP_URL: 'https://webots.invalid/mcp',
      WEBOTS_FOCUS_SERVICE_TOKEN: 't',
    })?.model,
    'm',
  );

  const firstActor = await ensureFocusServiceActor(d1, SERVICE_TOKEN_1);
  checkEqual('服务 actor 固定 ID', firstActor.actorId, FOCUS_SERVICE_ACTOR_ID);
  checkEqual('首次登记写入凭据', firstActor.rotated, true);
  const serviceRow = scalar<{ kind: string; agent_session_id: string | null; name: string; metadata: string }>(
    'SELECT kind, agent_session_id, name, metadata FROM actors WHERE actor_id = ?',
    FOCUS_SERVICE_ACTOR_ID,
  );
  checkEqual('服务身份是 agent', serviceRow.kind, 'agent');
  checkEqual('服务身份无 agent_session_id', serviceRow.agent_session_id, null);
  checkEqual('服务身份标记 system', JSON.parse(serviceRow.metadata).system, true);
  checkEqual('只保存摘要，不存明文', count(
    'SELECT COUNT(*) AS n FROM credentials WHERE token_hash = ?',
    SERVICE_TOKEN_1,
  ), 0);
  const same = await ensureFocusServiceActor(d1, SERVICE_TOKEN_1);
  checkEqual('同 token 不轮换', same.rotated, false);
  checkEqual('同 token 只保留一个有效凭据', count(
    'SELECT COUNT(*) AS n FROM credentials WHERE actor_id = ? AND revoked_at IS NULL',
    FOCUS_SERVICE_ACTOR_ID,
  ), 1);
  const rotated = await ensureFocusServiceActor(d1, SERVICE_TOKEN_2);
  checkEqual('token 变化触发轮换', rotated.rotated, true);
  checkEqual('轮换后只有一个有效凭据', count(
    'SELECT COUNT(*) AS n FROM credentials WHERE actor_id = ? AND revoked_at IS NULL',
    FOCUS_SERVICE_ACTOR_ID,
  ), 1);
  checkEqual('旧凭据被撤销', count(
    'SELECT COUNT(*) AS n FROM credentials WHERE actor_id = ? AND revoked_at IS NOT NULL',
    FOCUS_SERVICE_ACTOR_ID,
  ), 1);

  const h1 = await principalFor(H1);
  const h2 = await principalFor(H2);
  const worker = await principalFor(A1);
  const servicePrincipal = await principalFor(FOCUS_SERVICE_ACTOR_ID);
  expectCodeSync('普通 Agent 调秘书工具被拒', () => requireFocusService(worker), 'PERMISSION_DENIED');
  requireFocusService(servicePrincipal);
  check('服务身份通过秘书工具门禁', true);

  console.log('  · 开启、Watch 候选与 provisioning 组批');
  const preEnable = seedMessage(G1, A1, '开启秘书前的历史消息');
  const preScan = await scanFocusEvents(baseEnv());
  checkEqual('无开启绑定时游标推进到最大事件', preScan.cursor, preEnable.seq);
  checkEqual('无开启绑定时不建候选', count('SELECT COUNT(*) AS n FROM focus_candidates'), 0);
  const h1Enable = await focusEnable(d1, h1, { request_id: 'req_rt_h1_enable' });
  const h2Enable = await focusEnable(d1, h2, { request_id: 'req_rt_h2_enable' });
  checkEqual('H1 初始 provisioning', h1Enable.status, 'provisioning');
  db.prepare(
    `UPDATE focus_bindings SET status = 'active', session_id = NULL, root_session_id = NULL,
            updated_at = ? WHERE owner_actor_id = ?`,
  ).run(AT, H2);

  const mG1 = seedMessage(G1, A1, '回归和安装包齐了，由林舟拍板。周敏交包。');
  const deliveryId = seedDeliveryClaimEvent(G1, mG1, A1, A1);
  const mG2 = seedMessage(G2, A1, '回归 32/32 通过');
  const mDM = seedMessage(DM, H2, 'RC2 包已交付');
  const h2Secretary = h2Enable.secretary_actor_id as string;

  const scan1 = await scanFocusEvents(baseEnv());
  check('Watch 扫描推进游标', scan1.cursor > 0);
  const h1Candidates = candidatesOf(H1);
  const h2Candidates = candidatesOf(H2);
  checkEqual('H1 provisioning 也建候选', h1Candidates.length, 4);
  checkEqual('H2 只看到有权房间的候选', h2Candidates.length, 3);
  check(
    'H1 有验收群候选',
    h1Candidates.some((row) => row.source_key === `message:${mG2.messageId}`),
  );
  check(
    'H2 没有验收群候选',
    !h2Candidates.some((row) => row.source_key === `message:${mG2.messageId}`),
  );
  checkEqual(
    'H2 有交付领取候选',
    h2Candidates.filter((row) => row.source_kind === 'delivery').length,
    1,
  );
  checkEqual('provisioning 不派模型（H1 无作业）', count(
    'SELECT COUNT(*) AS n FROM focus_jobs WHERE owner_actor_id = ?',
    H1,
  ), 0);
  checkEqual('active H2 已组批', count('SELECT COUNT(*) AS n FROM focus_jobs WHERE owner_actor_id = ?', H2), 1);
  const h2Job = jobOf(H2);
  checkEqual('组批状态 queued', h2Job.status, 'queued');
  const h2QueuedAgain = await ensureJobs(baseEnv(), { dispatch: false });
  checkEqual('已存在 queued 作业时不再新建', h2QueuedAgain.created.length, 0);
  checkEqual('H2 作业仍只有一条', count('SELECT COUNT(*) AS n FROM focus_jobs WHERE owner_actor_id = ?', H2), 1);

  console.log('  · provisioning → active 后候选仍可组批');
  db.prepare(
    `UPDATE focus_bindings SET status = 'active', updated_at = ?
      WHERE owner_actor_id = ?`,
  ).run(AT, H1);
  const h1Jobs = await ensureJobs(baseEnv(), { dispatch: false });
  checkEqual('H1 激活后创建作业', h1Jobs.created.length, 1);
  const h1Job = jobOf(H1);
  checkEqual(
    'H1 作业覆盖激活前的候选',
    count('SELECT COUNT(*) AS n FROM focus_candidates WHERE job_id = ?', h1Job.job_id),
    4,
  );

  console.log('  · 开通与派发');
  await provisionFocusBinding(runtimeEnv(), H2);
  const h2AfterProvision = bindingOf(H2);
  checkEqual('provision 后 H2 active', h2AfterProvision.status, 'active');
  check('provision 写入 session', (h2AfterProvision.session_id ?? '').length > 0);
  check('provision 写入 root', (h2AfterProvision.root_session_id ?? '').length > 0);

  const client = createFocusSwarmClient(runtimeConfig);
  await dispatchFocusJob(runtimeEnv(), h2Job.job_id, client);
  await dispatchFocusJob(runtimeEnv(), h1Job.job_id, client);
  await waitForJob(h2Job.job_id, ['submitted', 'running', 'waiting']);
  await waitForJob(h1Job.job_id, ['submitted', 'running', 'waiting']);
  const h1AfterDispatch = bindingOf(H1);
  checkEqual('派发后 H1 active', h1AfterDispatch.status, 'active');
  check('派发后 H1 有 session', (h1AfterDispatch.session_id ?? '').length > 0);
  const h1JobAfter = jobOf(H1);
  check('作业保存 input_id', (h1JobAfter.input_id ?? '').length > 0);
  check('作业持有租约', (h1JobAfter.lease_until ?? 0) > Date.now());
  const submitText = JSON.stringify(
    fake.requests.filter((request) => request.idempotencyKey === h1JobAfter.submission_key),
  );
  check('输入正文含 job_id', submitText.includes(`job_id: ${h1Job.job_id}`));
  check('输入正文含 attempt_ref', submitText.includes(`attempt_ref: ${h1JobAfter.attempt_ref}`));
  check(
    '输入正文不含消息原文',
    !submitText.includes('回归和安装包齐了'),
  );
  const statusAfterDispatch = await focusStatus(d1, h1);
  checkEqual('runtime_ready 在有 session/root 后为 true', statusAfterDispatch.runtime_ready, true);

  const h1Attempt = h1JobAfter.attempt_ref;
  const h2Attempt = jobOf(H2).attempt_ref;

  console.log('  · 秘书工具授权与读取');
  const leaseBeforeRenew = Date.now() + 1_000;
  db.prepare('UPDATE focus_jobs SET lease_until = ? WHERE job_id = ?').run(
    leaseBeforeRenew,
    h1Job.job_id,
  );
  const jobView = await focusJobGet(d1, h1Attempt);
  checkEqual('job_get owner 名称', jobView.owner_name, '林舟');
  checkEqual('job_get 候选数', jobView.candidates.length, 4);
  checkEqual('job_get generation', jobView.generation, bindingOf(H1).generation);
  const leaseAfterRenew = scalar<{ lease: number }>(
    'SELECT lease_until AS lease FROM focus_jobs WHERE job_id = ?',
    h1Job.job_id,
  ).lease;
  check('job_get 续租', leaseAfterRenew > leaseBeforeRenew);

  const g2Candidate = candidateByKey(H1, `message:${mG2.messageId}`);
  const dmCandidate = candidateByKey(H1, `message:${mDM.messageId}`);
  const g1Candidate = candidateByKey(H1, `message:${mG1.messageId}`);
  const deliveryCandidate = candidateByKey(H1, `delivery:${deliveryId}`);
  const evidence = await focusEvidenceRead(d1, h1Attempt, [
    g2Candidate.candidate_id,
    deliveryCandidate.candidate_id,
  ]);
  const g2Read = evidence.items.find((item) => item.candidate_id === g2Candidate.candidate_id);
  checkEqual('验收群证据可读', g2Read?.readable, true);
  checkEqual('证据带房间名', g2Read?.room_name, '灰度验收群');
  checkEqual('证据带发送者名称', g2Read?.sender_name, '回归 Agent');
  checkEqual('证据带摘录', g2Read?.excerpt?.includes('32/32'), true);
  const deliveryRead = evidence.items.find(
    (item) => item.candidate_id === deliveryCandidate.candidate_id,
  );
  checkEqual('交付证据带 state', deliveryRead?.delivery_state, 'pending');
  checkEqual('交付证据带 attempt', deliveryRead?.delivery_attempt, 0);
  await expectCode(
    '跨 owner 候选被拒',
    focusEvidenceRead(d1, h2Attempt, [g2Candidate.candidate_id]),
    'PERMISSION_DENIED',
  );
  await expectCode(
    '跨作业候选被拒',
    focusEvidenceRead(d1, h1Attempt, ['fcand_missing']),
    'PERMISSION_DENIED',
  );

  const findEmpty = await focusItemsFind(d1, h1Attempt, {});
  checkEqual('初始查重为空', findEmpty.items.length, 0);

  console.log('  · 新建卡、完成作业与 owner 通知');
  const h1InboxBefore = scalar<{ pending_count: number; inbox_head_seq: number }>(
    'SELECT pending_count, inbox_head_seq FROM actors WHERE actor_id = ?',
    H1,
  );
  const createReceipt = await focusCommit(d1, {
    attempt_ref: h1Attempt,
    decision_id: 'dec_rt_h1_create',
    complete: true,
    decisions: [
      {
        type: 'create',
        title: '确认 RC2 灰度放行',
        column_key: 'needs_me',
        next_step: '确认后通知值班',
        summary: '等周敏交包与回归结果',
        evidence: [
          { candidate_id: g1Candidate.candidate_id, purpose: 'request' },
          { candidate_id: g2Candidate.candidate_id, purpose: 'progress' },
          { candidate_id: dmCandidate.candidate_id, purpose: 'delivery' },
        ],
      },
      {
        type: 'ignore',
        candidate_ids: [deliveryCandidate.candidate_id],
        reason: '交付由消息正文承载，不重复建卡',
      },
    ],
  });
  checkEqual('receipt 作业完成', createReceipt.job_status, 'completed');
  checkEqual('receipt 覆盖全部候选', createReceipt.covered, 4);
  checkEqual('receipt 新建一张卡', createReceipt.items.length, 1);
  checkEqual('receipt 忽略一条候选', createReceipt.ignored.length, 1);
  const h1ItemId = createReceipt.items[0]?.item_id as string;
  check('新建卡 ID 前缀 fit_', h1ItemId.startsWith('fit_'));
  checkEqual('新建卡 version=1', createReceipt.items[0]?.version, 1);
  checkEqual('作业完成后清空租约', scalar<{ lease: number | null }>(
    'SELECT lease_until AS lease FROM focus_jobs WHERE job_id = ?',
    h1Job.job_id,
  ).lease, null);
  checkEqual('卡写入 owner', scalar<{ owner: string }>(
    'SELECT owner_actor_id AS owner FROM focus_items WHERE item_id = ?',
    h1ItemId,
  ).owner, H1);
  checkEqual('证据只增 3 条', count(
    'SELECT COUNT(*) AS n FROM focus_evidence WHERE item_id = ?',
    h1ItemId,
  ), 3);
  checkEqual('修订 1 条', count(
    'SELECT COUNT(*) AS n FROM focus_revisions WHERE item_id = ?',
    h1ItemId,
  ), 1);
  checkEqual('候选 3 条 consumed', count(
    "SELECT COUNT(*) AS n FROM focus_candidates WHERE job_id = ? AND state = 'consumed'",
    h1Job.job_id,
  ), 3);
  checkEqual('候选 1 条 skipped', count(
    "SELECT COUNT(*) AS n FROM focus_candidates WHERE job_id = ? AND state = 'skipped'",
    h1Job.job_id,
  ), 1);
  checkEqual('focus_updated 只写 owner actor scope', count(
    `SELECT COUNT(*) AS n FROM events
      WHERE event_type = 'focus_updated' AND scope_kind = 'actor' AND ref_id = ?`,
    h1ItemId,
  ), 1);
  checkEqual('owner 通知事件属于 H1', scalar<{ scope: string }>(
    `SELECT scope_id AS scope FROM events WHERE event_type = 'focus_updated' AND ref_id = ?`,
    h1ItemId,
  ).scope, H1);
  checkEqual('H2 没有该卡通知', count(
    `SELECT COUNT(*) AS n FROM events
      WHERE event_type = 'focus_updated' AND scope_kind = 'actor' AND scope_id = ? AND ref_id = ?`,
    H2,
    h1ItemId,
  ), 0);
  checkEqual('outbox 只投 owner topic', scalar<{ topic: string }>(
    `SELECT o.topic AS topic FROM outbox o JOIN events e ON e.event_seq = o.event_seq
      WHERE e.event_type = 'focus_updated' AND e.ref_id = ?`,
    h1ItemId,
  ).topic, `actor:${H1}`);
  const h1InboxAfter = scalar<{ pending_count: number; inbox_head_seq: number }>(
    'SELECT pending_count, inbox_head_seq FROM actors WHERE actor_id = ?',
    H1,
  );
  checkEqual('提交不增加 pending_count', h1InboxAfter.pending_count, h1InboxBefore.pending_count);
  checkEqual('提交不推进 inbox head', h1InboxAfter.inbox_head_seq, h1InboxBefore.inbox_head_seq);

  const replay = await focusCommit(d1, {
    attempt_ref: h1Attempt,
    decision_id: 'dec_rt_h1_create',
    complete: true,
    decisions: [
      {
        type: 'create',
        title: '确认 RC2 灰度放行',
        column_key: 'needs_me',
        next_step: '确认后通知值班',
        summary: '等周敏交包与回归结果',
        evidence: [
          { candidate_id: g1Candidate.candidate_id, purpose: 'request' },
          { candidate_id: g2Candidate.candidate_id, purpose: 'progress' },
          { candidate_id: dmCandidate.candidate_id, purpose: 'delivery' },
        ],
      },
      {
        type: 'ignore',
        candidate_ids: [deliveryCandidate.candidate_id],
        reason: '交付由消息正文承载，不重复建卡',
      },
    ],
  });
  checkEqual('decision_id 重放返回同一回执', JSON.stringify(replay), JSON.stringify(createReceipt));
  checkEqual('重放不重复建卡', count('SELECT COUNT(*) AS n FROM focus_items WHERE owner_actor_id = ?', H1), 1);
  checkEqual('重放不重复修订', count(
    'SELECT COUNT(*) AS n FROM focus_revisions WHERE item_id = ?',
    h1ItemId,
  ), 1);

  const ownerGet = await focusGet(d1, h1, { item_id: h1ItemId });
  checkEqual('owner 可读新建卡', ownerGet.item.title, '确认 RC2 灰度放行');
  checkEqual('owner 看到 3 条来源', ownerGet.item.source_count, 3);
  await expectCode(
    '已完成作业拒绝后续秘书调用',
    focusItemsFind(d1, h1Attempt, { query: 'RC2' }),
    'STALE_ATTEMPT',
  );
  const h2Find = await focusItemsFind(d1, h2Attempt, { query: 'RC2' });
  checkEqual('其他 owner 查不到该卡', h2Find.items.length, 0);
  await expectCode(
    'items_find 跨作业来源被拒',
    focusItemsFind(d1, h2Attempt, { sources: [`message:${mG2.messageId}`] }),
    'PERMISSION_DENIED',
  );

  console.log('  · owner 隔离、租约与归档屏障');
  const h2JobRow = jobOf(H2);
  db.prepare('UPDATE focus_jobs SET lease_until = ? WHERE job_id = ?').run(
    Date.now() - 1,
    h2JobRow.job_id,
  );
  await expectCode('租约过期拒绝', focusJobGet(d1, h2Attempt), 'STALE_ATTEMPT');
  db.prepare('UPDATE focus_jobs SET lease_until = ? WHERE job_id = ?').run(
    Date.now() + LIMITS.focusJobLeaseMs,
    h2JobRow.job_id,
  );

  const h2G1Candidate = candidateByKey(H2, `message:${mG1.messageId}`);
  const h2DMCandidate = candidateByKey(H2, `message:${mDM.messageId}`);
  const h2DeliveryCandidate = candidateByKey(H2, `delivery:${deliveryId}`);
  const h2Create = await focusCommit(d1, {
    attempt_ref: h2Attempt,
    decision_id: 'dec_rt_h2_create',
    complete: false,
    decisions: [
      {
        type: 'create',
        title: '交付 RC2 并通知值班',
        column_key: 'needs_me',
        next_step: '先交包',
        evidence: [{ candidate_id: h2G1Candidate.candidate_id }],
      },
      {
        type: 'create',
        title: '跟进 RC2 交付结果',
        column_key: 'tracking',
        next_step: '等待林舟确认',
        evidence: [{ candidate_id: h2G1Candidate.candidate_id }],
      },
    ],
  });
  checkEqual('complete=false 保持 running', h2Create.job_status, 'running');
  checkEqual('complete=false 仍有租约', (scalar<{ lease: number | null }>(
    'SELECT lease_until AS lease FROM focus_jobs WHERE job_id = ?',
    h2JobRow.job_id,
  ).lease ?? 0) > Date.now(), true);
  checkEqual('一次提交可新建多张卡', h2Create.items.length, 2);
  const h2KeptItemId = h2Create.items[1]?.item_id as string;
  await expectCode(
    '版本不符整批拒绝',
    focusCommit(d1, {
      attempt_ref: h2Attempt,
      decision_id: 'dec_rt_h2_stale_version_same_owner',
      complete: false,
      decisions: [
        {
          type: 'update',
          item_id: h2KeptItemId,
          expected_version: 99,
          changes: { next_step: '不应写入' },
        },
      ],
    }),
    'CONFLICT',
  );
  await expectCode(
    '同 decision_id 异参数返回 IDEMPOTENCY_CONFLICT',
    focusCommit(d1, {
      attempt_ref: h2Attempt,
      decision_id: 'dec_rt_h2_create',
      complete: false,
      decisions: [
        {
          type: 'ignore',
          candidate_ids: [h2DeliveryCandidate.candidate_id],
          reason: '参数不同不得重放',
        },
      ],
    }),
    'IDEMPOTENCY_CONFLICT',
  );
  const h2ItemId = h2Create.items[0]?.item_id as string;

  await focusArchive(d1, h2, {
    item_id: h2ItemId,
    request_id: 'req_rt_h2_archive',
    expected_version: 1,
  });
  const archivedFind = await focusItemsFind(d1, h2Attempt, { query: '交付 RC2 并通知值班' });
  checkEqual('查重包含已归档卡', archivedFind.items[0]?.item_id, h2ItemId);
  checkEqual('归档卡在查重结果标记 archived', archivedFind.items[0]?.archived, true);
  const evidenceBefore = count('SELECT COUNT(*) AS n FROM focus_evidence');
  const revisionsBefore = count('SELECT COUNT(*) AS n FROM focus_revisions');
  await expectCode(
    '归档卡更新整批拒绝',
    focusCommit(d1, {
      attempt_ref: h2Attempt,
      decision_id: 'dec_rt_h2_archived_update',
      complete: false,
      decisions: [
        {
          type: 'update',
          item_id: h2ItemId,
          expected_version: 2,
          changes: { next_step: '不应写入' },
          evidence: [{ candidate_id: h2DMCandidate.candidate_id }],
        },
        {
          type: 'ignore',
          candidate_ids: [h2DeliveryCandidate.candidate_id],
          reason: '同一批中的其它决定也不能提交',
        },
      ],
    }),
    'CONFLICT',
  );
  checkEqual('归档拒绝不写证据', count('SELECT COUNT(*) AS n FROM focus_evidence'), evidenceBefore);
  checkEqual('归档拒绝不写修订', count('SELECT COUNT(*) AS n FROM focus_revisions'), revisionsBefore);
  checkEqual('归档拒绝不改作业', jobOf(H2).status, 'running');

  await expectCode(
    '版本不符拒绝',
    focusCommit(d1, {
      attempt_ref: h2Attempt,
      decision_id: 'dec_rt_h2_stale_version',
      complete: false,
      decisions: [
        {
          type: 'update',
          item_id: h1ItemId,
          expected_version: 99,
          changes: { next_step: '越权不得命中' },
        },
      ],
    }),
    'NOT_FOUND',
  );

  await expectCode(
    '无证据不可提交',
    focusCommit(d1, {
      attempt_ref: h2Attempt,
      decision_id: 'dec_rt_h2_empty',
      complete: false,
      decisions: [
        {
          type: 'create',
          title: '无证据卡',
          column_key: 'needs_me',
          evidence: [],
        },
      ],
    }),
    'INVALID_ARGUMENT',
  );

  db.prepare('UPDATE messages SET body_bytes = 0, body = ? WHERE message_id = ?').run(
    '',
    mDM.messageId,
  );
  const revokedRead = await focusEvidenceRead(d1, h2Attempt, [h2DMCandidate.candidate_id]);
  checkEqual('撤回来源不可读', revokedRead.items[0]?.readable, false);
  checkEqual('不可读只返回固定 reason', revokedRead.items[0]?.reason, 'source_unavailable');
  checkEqual('不可读不带房间定位', revokedRead.items[0]?.room_id, undefined);
  await expectCode(
    '全失权证据不可提交',
    focusCommit(d1, {
      attempt_ref: h2Attempt,
      decision_id: 'dec_rt_h2_revoked',
      complete: false,
      decisions: [
        {
          type: 'create',
          title: '依赖失权来源的卡',
          column_key: 'needs_me',
          evidence: [{ candidate_id: h2DMCandidate.candidate_id }],
        },
      ],
    }),
    'PERMISSION_DENIED',
  );

  const h2Finish = await focusCommit(d1, {
    attempt_ref: h2Attempt,
    decision_id: 'dec_rt_h2_finish',
    complete: true,
    decisions: [
      {
        type: 'ignore',
        candidate_ids: [h2DeliveryCandidate.candidate_id],
        reason: '领取状态不构成新的个人事项',
      },
      {
        type: 'pending',
        candidate_ids: [h2DMCandidate.candidate_id],
        reason: '来源已撤回，等待新消息澄清',
      },
    ],
  });
  checkEqual('完成作业只要求覆盖剩余 assigned 候选', h2Finish.covered, 2);
  checkEqual('complete=true 置 completed', h2Finish.job_status, 'completed');
  checkEqual('pending 候选保留为 skipped', count(
    "SELECT COUNT(*) AS n FROM focus_candidates WHERE candidate_id = ? AND state = 'skipped' AND decision = 'pending'",
    h2DMCandidate.candidate_id,
  ), 1);

  console.log('  · 暂停、重开与候选重排');
  const mG1b = seedMessage(G1, A1, '新的交付目标：明早交灰度复盘');
  await scanFocusEvents(baseEnv());
  await ensureJobs(baseEnv(), { dispatch: false });
  const h2BeforePauseCandidates = candidatesOf(H2).filter(
    (row) => row.job_id !== null && row.state === 'assigned',
  );
  check('暂停前存在 assigned 候选', h2BeforePauseCandidates.length > 0);
  const h2Disable = await focusDisable(d1, h2, { request_id: 'req_rt_h2_disable' });
  checkEqual('暂停提升代次', h2Disable.status, 'paused');
  const h2BindingPaused = bindingOf(H2);
  const pausedJobs = count(
    "SELECT COUNT(*) AS n FROM focus_jobs WHERE owner_actor_id = ? AND status = 'cancelled'",
    H2,
  );
  check('暂停取消活跃作业', pausedJobs > 0);
  for (const candidate of h2BeforePauseCandidates) {
    const current = scalar<FocusCandidateRow>(
      'SELECT * FROM focus_candidates WHERE candidate_id = ?',
      candidate.candidate_id,
    );
    checkEqual('暂停释放候选', current.state, 'pending');
    checkEqual('暂停清空候选作业', current.job_id, null);
  }

  // 暂停期间新事件不补建（产品规则）。
  const mPaused = seedMessage(G1, A1, '暂停期间的新委托');
  await scanFocusEvents(baseEnv());
  checkEqual('暂停期间新事件不建候选', count(
    'SELECT COUNT(*) AS n FROM focus_candidates WHERE owner_actor_id = ? AND source_key = ?',
    H2,
    `message:${mPaused.messageId}`,
  ), 0);
  check(
    '暂停期间事件仍进入 H1 候选',
    count(
      'SELECT COUNT(*) AS n FROM focus_candidates WHERE owner_actor_id = ? AND source_key = ?',
      H1,
      `message:${mPaused.messageId}`,
    ) === 1,
  );

  const h2EnableAgain = await focusEnable(d1, h2, { request_id: 'req_rt_h2_reenable' });
  checkEqual('重开进入 provisioning', h2EnableAgain.status, 'provisioning');
  checkEqual('重开复用同一秘书', h2EnableAgain.secretary_actor_id, h2Secretary);
  const h2Generation = bindingOf(H2).generation;
  check('重开提升代次', h2Generation > h2BindingPaused.generation);
  const noJobWhileProvisioning = await ensureJobs(baseEnv(), { dispatch: false });
  checkEqual('provisioning 不组批', noJobWhileProvisioning.created.length, 0);
  db.prepare(
    `UPDATE focus_bindings SET status = 'active', session_id = NULL, root_session_id = NULL,
            updated_at = ? WHERE owner_actor_id = ?`,
  ).run(AT, H2);
  await ensureJobs(baseEnv(), { dispatch: false });
  const h2ReopenedJob = jobOf(H2);
  checkEqual('重开后作业使用新代次', h2ReopenedJob.generation, h2Generation);
  check('重开后候选重新分配', count(
    'SELECT COUNT(*) AS n FROM focus_candidates WHERE job_id = ?',
    h2ReopenedJob.job_id,
  ) > 0);

  console.log('  · 派发失败分类与恢复');
  fake.behavior.submitStatus = 500;
  await dispatchFocusJob(runtimeEnv(), h2ReopenedJob.job_id, client);
  fake.behavior.submitStatus = null;
  const failedDispatch = scalar<FocusJobRow>(
    'SELECT * FROM focus_jobs WHERE job_id = ?',
    h2ReopenedJob.job_id,
  );
  checkEqual('提交 5xx 进入 waiting', failedDispatch.status, 'waiting');
  checkEqual('失败只记固定分类', failedDispatch.last_error, 'focus_swarm_unavailable');
  check(
    'last_error 不含 token/正文',
    !(failedDispatch.last_error ?? '').includes('runtime-api-key') &&
      !(failedDispatch.last_error ?? '').includes('回归'),
  );

  const h1ReopenedJob = jobOf(H1);
  checkEqual('H1 新作业等待派发', h1ReopenedJob.status, 'queued');
  db.prepare('UPDATE focus_jobs SET status = ?, lease_until = ?, updated_at = ? WHERE job_id = ?').run(
    'submitted',
    Date.now() - 1,
    Date.now(),
    h1ReopenedJob.job_id,
  );
  db.prepare('UPDATE focus_jobs SET attempt_ref = ? WHERE job_id = ?').run(
    'fat_recover_before_1',
    h1ReopenedJob.job_id,
  );
  db.prepare(
    'UPDATE focus_jobs SET status = ?, lease_until = ?, attempt_count = ? WHERE job_id = ?',
  ).run(
    'waiting',
    Date.now() - 1,
    LIMITS.focusJobAttemptMax - 1,
    h2ReopenedJob.job_id,
  );
  const recovered = await recoverFocusJobs(runtimeEnv());
  check('恢复轮换过期尝试', recovered.retried >= 1);
  check('恢复超过上限置 failed', recovered.failed >= 1);
  const h1Recovered = scalar<FocusJobRow>(
    'SELECT * FROM focus_jobs WHERE job_id = ?',
    h1ReopenedJob.job_id,
  );
  check('恢复轮换 attempt_ref', h1Recovered.attempt_ref !== 'fat_recover_before_1');
  checkEqual('恢复递增 attempt_count', h1Recovered.attempt_count, 1);
  const h2Failed = scalar<FocusJobRow>(
    'SELECT * FROM focus_jobs WHERE job_id = ?',
    h2ReopenedJob.job_id,
  );
  checkEqual('超过上限作业 failed', h2Failed.status, 'failed');
  checkEqual('超限错误分类', h2Failed.last_error, 'focus_attempts_exhausted');
  checkEqual('超限释放候选', count(
    "SELECT COUNT(*) AS n FROM focus_candidates WHERE job_id = ? AND state = 'assigned'",
    h2ReopenedJob.job_id,
  ), 0);
  check('释放后的候选回到 pending', count(
    "SELECT COUNT(*) AS n FROM focus_candidates WHERE owner_actor_id = ? AND state = 'pending'",
    H2,
  ) > 0);
  // 恢复后的派发是异步的；等它落库并让观察流结束，避免脚本关闭数据库后仍有后台写入。
  await waitForJob(h1ReopenedJob.job_id, ['submitted', 'running', 'waiting', 'failed']);
  await Bun.sleep(50);

  console.log('  · 代次/旧尝试拒绝与 runtime gate');
  const oldH2Attempt = h2Attempt;
  await expectCode(
    '旧代次 attempt_ref 写卡被拒',
    focusCommit(d1, {
      attempt_ref: oldH2Attempt,
      decision_id: 'dec_rt_h2_old_generation',
      complete: true,
      decisions: [
        {
          type: 'ignore',
          candidate_ids: [h2G1Candidate.candidate_id],
          reason: '旧代次不得写入',
        },
      ],
    }),
    'STALE_ATTEMPT',
  );
  const secretaryRow = await getActor(d1, h2Secretary);
  if (!secretaryRow) throw new CheckFailure('seed', '缺少秘书 actor');
  expectCodeSync(
    '卡主秘书 actor 调工具被拒',
    () => requireFocusService({ credentialHash: 'x', actor: secretaryRow, credential: null }),
    'PERMISSION_DENIED',
  );

  const toolCalls = new Map<string, (args: unknown) => Promise<{
    isError?: boolean;
    content: { type: string; text: string }[];
  }>>();
  const fakeServer = {
    registerTool(name: string, _config: unknown, callback: (args: unknown) => Promise<unknown>) {
      toolCalls.set(name, callback as never);
    },
  } as unknown as RegistrationServer;
  registerFocusSecretaryTools(
    fakeServer,
    { env: baseEnv(), principal: servicePrincipal },
    register,
  );
  const unavailable = await toolCalls.get('network_focus_job_get')?.({ attempt_ref: h1Attempt });
  checkEqual(
    '未配置运行时返回 FOCUS_RUNTIME_UNAVAILABLE',
    JSON.parse(unavailable?.content[0]?.text ?? '{}').code,
    'FOCUS_RUNTIME_UNAVAILABLE',
  );
  const deniedTools = new Map<string, (args: unknown) => Promise<{
    isError?: boolean;
    content: { type: string; text: string }[];
  }>>();
  const deniedServer = {
    registerTool(
      name: string,
      _config: unknown,
      callback: (args: unknown) => Promise<unknown>,
    ) {
      deniedTools.set(name, callback as never);
    },
  } as unknown as RegistrationServer;
  registerFocusSecretaryTools(
    deniedServer,
    { env: runtimeEnv(), principal: worker },
    register,
  );
  const denied = await deniedTools.get('network_focus_job_get')?.({ attempt_ref: h1Attempt });
  checkEqual(
    '普通 Agent 工具调用返回 PERMISSION_DENIED',
    JSON.parse(denied?.content[0]?.text ?? '{}').code,
    'PERMISSION_DENIED',
  );

  console.log('  · 领取流水');
  const mClaim = seedMessage(G1, H1, '请领取这份工作');
  const claimDelivery = `dlv_rt_claim_1`;
  db.prepare(
    `INSERT INTO deliveries
       (delivery_id, recipient_id, message_id, room_id, state, attempt, claim_id, claimed_at,
        progress_at, result_message_id, error, created_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(claimDelivery, A1, mClaim.messageId, G1, mClaim.seq, AT, AT);
  db.prepare('UPDATE actors SET pending_count = pending_count + 1 WHERE actor_id = ?').run(A1);
  await deliveryClaim(d1, worker, {
    delivery_id: claimDelivery,
    request_id: 'req_rt_claim_1',
  });
  checkEqual('领取流水恰一条', count(
    'SELECT COUNT(*) AS n FROM focus_delivery_claims WHERE delivery_id = ?',
    claimDelivery,
  ), 1);
  const ledger = scalar<{ recipient: string; claimed_by: string; attempt: number; event_seq: number }>(
    `SELECT recipient_actor_id AS recipient, claimed_by, attempt, event_seq
       FROM focus_delivery_claims WHERE delivery_id = ?`,
    claimDelivery,
  );
  checkEqual('流水记录 recipient', ledger.recipient, A1);
  checkEqual('流水记录领取者', ledger.claimed_by, A1);
  checkEqual('流水记录 attempt', ledger.attempt, 1);
  checkEqual(
    '流水 event_seq 来自同次房间事件',
    ledger.event_seq,
    scalar<{ seq: number }>(
      'SELECT event_seq AS seq FROM events WHERE event_key = ?',
      `room_delivery:claim:${claimDelivery}:req_rt_claim_1`,
    ).seq,
  );
  await deliveryClaim(d1, worker, {
    delivery_id: claimDelivery,
    request_id: 'req_rt_claim_1',
  });
  checkEqual('领取重放仍只有一条流水', count(
    'SELECT COUNT(*) AS n FROM focus_delivery_claims WHERE delivery_id = ?',
    claimDelivery,
  ), 1);

  // 未使用的导入用于提醒：新消息仍会继续被 Watch 处理。
  check('新事件游标继续推进', (await scanFocusEvents(baseEnv())).cursor >= mG1b.seq);
}

const dir = await mkdtemp(join(tmpdir(), 'webots-focus-runtime-'));
const databasePath = join(dir, 'focus-runtime.sqlite');
db = new Database(databasePath, { create: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
migrate(db, join(import.meta.dir, '../migrations'));
d1 = createD1(db);
seedBase();
fake = startFocusFakeSwarm({ rootSessionId: 'root_rt_fixed' });
runtimeConfig = {
  baseUrl: fake.url,
  apiKey: 'runtime-api-key',
  model: 'runtime-model',
  mcpUrl: 'https://webots.invalid/mcp',
  serviceToken: SERVICE_TOKEN_2,
};
try {
  await run();
  console.log(`Focus 运行时验收通过：${checksPassed()} 项检查`);
} finally {
  await fake.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
}
