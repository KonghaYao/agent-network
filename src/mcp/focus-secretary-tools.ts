/**
 * 任务秘书专用 MCP 工具（固定服务身份）。
 *
 * 四个工具只接受 `act_focus_service`：owner 从 `attempt_ref` 对应的作业推导，
 * 不接受 owner 参数。普通 Agent 或某位卡主的秘书 actor 持引用调用都会被
 * 拒绝。运行时未配置时统一返回 `FOCUS_RUNTIME_UNAVAILABLE`。
 */

import { BusinessError } from '../contracts/errors';
import {
  focusCommitSchema,
  focusEvidenceReadSchema,
  focusItemsFindSchema,
  focusJobGetSchema,
} from '../contracts/focus';
import { requireActor } from './auth';
import type { Env } from '../env';
import type { Principal } from '../domain/principal';
import { requireFocusService } from '../focus/service';
import {
  focusCommit,
  focusEvidenceRead,
  focusItemsFind,
  focusJobGet,
} from '../focus/secretary';
import {
  focusCommitReceiptSchema,
  focusEvidenceReadResultSchema,
  focusItemsFindResultSchema,
  focusJobGetResultSchema,
} from './outputs/focus';
import type { RegistrationServer } from './registration';
import type { register } from './tool-registration';

type RegisterFn = typeof register;

export interface FocusSecretaryToolDeps {
  env: Env;
  principal: Principal;
}

function requireRuntime(env: Env): void {
  if (!env.FOCUS) {
    throw new BusinessError('FOCUS_RUNTIME_UNAVAILABLE', '任务秘书运行时尚未配置');
  }
}

export function registerFocusSecretaryTools(
  server: RegistrationServer,
  deps: FocusSecretaryToolDeps,
  registerTool: RegisterFn,
): void {
  const { env, principal } = deps;
  const db = env.DB;
  const register = registerTool;

  register(
    server,
    'network_focus_job_get',
    '任务秘书运行时专用：按 attempt_ref 读取当前作业的候选事件、理由、事件区间与 owner 显示名，并返回 owner 看板计数。owner 由作业推导，不接受 owner 参数；只接受固定服务身份，普通 Agent 或另一位秘书持引用调用返回 PERMISSION_DENIED。作业代次/状态/租约失效返回 STALE_ATTEMPT；每次调用续租。只读，不写看板、事件或 outbox。运行时未配置返回 FOCUS_RUNTIME_UNAVAILABLE。',
    focusJobGetSchema,
    focusJobGetResultSchema,
    async (input) => {
      requireActor(principal);
      requireFocusService(principal);
      requireRuntime(env);
      return focusJobGet(db, input.attempt_ref);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_focus_evidence_read',
    '任务秘书运行时专用：按 attempt_ref 读取本作业 assigned 候选的来源。每个 source 必须属于当前作业，越界返回 PERMISSION_DENIED。返回前按 owner 当前成员资格、历史边界、撤回与 delivery 状态重新核定可读性；不可读只返回 readable=false 与 reason，不返回房间、消息或摘录。最多读取 20 条，每次调用续租。只读，不写看板、事件或 outbox。',
    focusEvidenceReadSchema,
    focusEvidenceReadResultSchema,
    async (input) => {
      requireActor(principal);
      requireFocusService(principal);
      requireRuntime(env);
      return focusEvidenceRead(
        db,
        input.attempt_ref,
        input.sources.map((source) => source.candidate_id),
        input.limit,
      );
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_focus_items_find',
    '任务秘书运行时专用：只在 owner 自己的事项中查重（包含已归档），可按标题/下一步/摘要搜索，或按本作业候选来源定位同一事项。只返回证据当前可读的紧凑卡片（id/title/column/version/archived/next_step），最多 20 条。owner 由 attempt_ref 推导，不接受 owner 参数；来源越界返回 PERMISSION_DENIED。只读，不写看板、事件或 outbox。',
    focusItemsFindSchema,
    focusItemsFindResultSchema,
    async (input) => {
      requireActor(principal);
      requireFocusService(principal);
      requireRuntime(env);
      return focusItemsFind(db, input.attempt_ref, {
        ...(input.query ? { query: input.query } : {}),
        ...(input.sources ? { sources: input.sources } : {}),
      });
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_focus_commit',
    '任务秘书运行时专用：提交 owner 看板决定（新建/更新/忽略/待判断）。owner 由 attempt_ref 推导，不接受 owner 参数。校验作业活跃、租约、启用代次、证据属于本作业且当前可读、卡版本与归档屏障；命中归档或版本冲突整批拒绝。complete=true 时必须覆盖全部 assigned 候选（evidence 与 ignore/pending 的合集）。同一 decision_id 幂等，重放返回同一回执；每次实际变更的卡只通知 owner（actor scope focus_updated），不写 inbox、不增加 pending_count、不产生 delivery。',
    focusCommitSchema,
    focusCommitReceiptSchema,
    async (input) => {
      requireActor(principal);
      requireFocusService(principal);
      requireRuntime(env);
      return focusCommit(db, input);
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  );
}
