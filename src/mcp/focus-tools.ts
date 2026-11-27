/**
 * Task Focus（个人看板）卡主工具的注册切片。
 *
 * owner 从 Bearer 身份推导；Agent（含秘书）调用一律 PERMISSION_DENIED。
 * 列表 / 详情 / 搜索只读，不写 events、outbox、operations；开启 / 暂停 /
 * 归档都带唯一 request_id，并只写 actor scope 的 `focus_updated` 提示。
 */

import {
  focusArchiveSchema,
  focusDisableSchema,
  focusEnableSchema,
  focusGetSchema,
  focusListSchema,
  focusStatusSchema,
} from '../contracts/focus';
import { focusDisable, focusEnable, focusStatus } from '../domain/focus/bindings';
import { focusArchive, focusGet, focusList } from '../domain/focus/items';
import type { Principal } from '../domain/principal';
import type { Env } from '../env';
import {
  cancelFocusTurn,
  focusCancelTarget,
  provisionFocusBinding,
} from '../focus/jobs';
import { requireActor } from './auth';
import { registerFocusSecretaryTools } from './focus-secretary-tools';
import {
  focusArchiveResultSchema,
  focusGetResultSchema,
  focusListResultSchema,
  focusMutationResultSchema,
  focusStatusResultSchema,
} from './outputs/focus';
import type { RegistrationServer } from './registration';
import type { register } from './tool-registration';

type RegisterFn = typeof register;

export interface FocusToolDeps {
  db: D1Database;
  principal: Principal;
  /** 秘书运行时的 Swarm 配置；缺失时秘书工具返回 FOCUS_RUNTIME_UNAVAILABLE。 */
  env: Env;
}

export function registerFocusTools(
  server: RegistrationServer,
  deps: FocusToolDeps,
  registerTool: RegisterFn,
): void {
  const { db, principal, env } = deps;
  const register = registerTool;

  register(
    server,
    'network_focus_status',
    '查看本人任务秘书的开启状态与看板计数（needs_me / tracking / done / archived）。owner 由当前 Bearer 身份推导，不接受 owner 参数；Agent 身份调用返回 PERMISSION_DENIED。runtime_ready 仅在绑定 active 且远端 session_id 与 root_session_id 都已登记时为 true。只读：不写 events/outbox/operations，不推进已读、pending_count 或 head_seq。',
    focusStatusSchema,
    focusStatusResultSchema,
    async () => {
      requireActor(principal);
      return focusStatus(db, principal);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_focus_enable',
    '开启本人的任务秘书：首次调用在同一事务创建秘书 Agent、唯一绑定与幂等结果，status 为 provisioning；并发或重复开启返回同一秘书与同一绑定，不产生第二名秘书。已 paused 时再次开启会提升启用代次并重置事件水位。提交后异步幂等开通固定 Swarm 会话；失败保留 provisioning/failed，不会产生第二秘书。幂等键为 request_id；只写 actor scope 的 focus_updated 提示，不写 inbox、不增加 pending_count、不产生 delivery。',
    focusEnableSchema,
    focusMutationResultSchema,
    async (input) => {
      const actor = requireActor(principal);
      const result = await focusEnable(db, principal, input);
      // 远端开通在响应后异步进行；失败不会回滚本地唯一绑定。
      void provisionFocusBinding(env, actor.actor_id);
      return result;
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  );

  register(
    server,
    'network_focus_disable',
    '暂停本人的任务秘书：提升启用代次、记录暂停时间、取消该 owner 的活跃作业并释放候选，已有个人卡与归档记录全部保留。提交后异步取消当前远端 turn；旧 turn 的后续写入会被代次与租约拒绝。已暂停或从未开启时按幂等成功返回当前状态，不重复提升代次。只写 actor scope 的 focus_updated 提示，不写 inbox、不增加 pending_count、不产生 delivery。',
    focusDisableSchema,
    focusMutationResultSchema,
    async (input) => {
      const actor = requireActor(principal);
      const target = await focusCancelTarget(db, actor.actor_id);
      const result = await focusDisable(db, principal, input);
      void cancelFocusTurn(env, target);
      return result;
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  );

  register(
    server,
    'network_focus_list',
    '分页读取本人看板：默认只返回未归档卡，archived=true 只看已归档；column 按 needs_me / tracking / done 过滤；query 匹配标题、下一步与摘要（% 与 _ 按字面量处理）；按 updated_at DESC、item_id DESC keyset 分页，cursor 绑定 owner、归档维度与筛选条件。每张卡按当前权限重算证据：任一证据失权时标题、下一步、摘要与来源计数全部遮蔽并标记 restricted=true。只返回本人事项；只读，不写 events/outbox/operations。',
    focusListSchema,
    focusListResultSchema,
    async (input) => {
      requireActor(principal);
      return focusList(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_focus_get',
    '读取本人一个事项的卡面、证据与修订历史。证据逐条按当前成员身份、历史边界与撤回状态重算：不可读时只返回 readable=false 与 purpose，不返回 room_id、message_id 或摘录；只要有一条不可读，卡面正文与来源计数被遮蔽且 restricted=true；全部不可读返回 NOT_FOUND，不泄露事项是否存在。只读，不写 events/outbox/operations。',
    focusGetSchema,
    focusGetResultSchema,
    async (input) => {
      requireActor(principal);
      return focusGet(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_focus_archive',
    '归档本人的一个事项：校验 owner 与 expected_version，归档后卡从三列移出但证据与修订全部保留。重复归档（含已归档再请求）返回同一次归档并标记 idempotent=true；版本不一致返回 CONFLICT。归档会递增卡版本并写 actor scope 的 focus_updated 提示，不写 inbox、不增加 pending_count、不产生 delivery。幂等键为 request_id。',
    focusArchiveSchema,
    focusArchiveResultSchema,
    async (input) => {
      requireActor(principal);
      return focusArchive(db, principal, input);
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  );

  registerFocusSecretaryTools(server, { env, principal }, register);
}
