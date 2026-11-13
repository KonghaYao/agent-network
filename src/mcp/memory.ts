/**
 * MF06/MF07：Memory MCP 工具入口。
 *
 * 只暴露上层接口：空间、来源、受众、宿主等级与 provider 路由全部由服务端
 * 解析。工具结果中的 experience/context 都是参考数据，不是系统指令；
 * lookup 不携带注入许可，exposure receipt 才可能产生个人经历与 retain。
 */
import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { BusinessError } from '../contracts/errors';
import { nowMs, sha256Hex } from '../storage/db';
import type { Env } from '../env';
import { requireCurrentMemorySpace } from '../memory/access';
import { DEFAULT_MEMORY_HOST_POLICY, MemoryHostBridge, type MemoryHostPolicy } from '../memory/host-bridge';
import { MEMORY_HOST_PROTOCOL_VERSION } from '../memory/host-protocol';
import { memoryCapabilityCatalog } from '../memory/capability-catalog';
import { recallMemory } from '../memory/recall-service';
import {
  listMemoryContexts,
  readMemoryContextView,
} from '../memory/context';
import {
  forgetMemory,
  getMemoryCurated,
  getMemoryOperation,
  getMemorySourceDetail,
  listMemoryCurated,
  listMemorySources,
  memoryStatusSnapshot,
  putMemoryCurated,
} from '../memory/governance';
import {
  getCatchupPage,
  planCatchup,
  prepareCatchupSelections,
} from '../memory/catchup';
import { listExperiences, getExperience } from '../memory/experience-read';
import { recordContextDeliveryReceipt } from '../memory/store';
import { requireHostBinding } from '../memory/input-manifest';
import {
  memoryContextGetInputSchema,
  memoryContextListInputSchema,
  memoryCorrectInputSchema,
  memoryCatchupGetInputSchema,
  memoryCatchupPrepareInputSchema,
  memoryEmptyInputSchema,
  memoryExperienceGetInputSchema,
  memoryExperienceListInputSchema,
  memoryForgetInputSchema,
  memoryGetInputSchema,
  memoryHostCloseInputSchema,
  memoryInputStatusInputSchema,
  memoryListInputSchema,
  memoryOperationGetInputSchema,
  memoryPutInputSchema,
} from '../memory/tool-schemas';
import {
  memoryStatusOutputSchema,
  memoryRecallOutputSchema,
  memoryContextListOutputSchema,
  memoryContextGetOutputSchema,
  memoryListOutputSchema,
  memoryGetOutputSchema,
  memoryPutOutputSchema,
  memoryForgetOutputSchema,
  memoryOperationOutputSchema,
  memoryHostBindOutputSchema,
  memoryHostCloseOutputSchema,
  memoryInputPrepareOutputSchema,
  memoryInputStatusOutputSchema,
  memoryAdmitOutputSchema,
  memoryCatchupPrepareOutputSchema,
  memoryCatchupGetOutputSchema,
  memoryExperienceListOutputSchema,
  memoryExperienceGetOutputSchema,
} from '../mcp/outputs';
import {
  memoryExposureReceiptInputSchema,
  memoryHostBindInputSchema,
  memoryInputPrepareInputSchema,
  memoryRecallInputSchema,
} from '../memory/schema-contracts';
import type { MemoryHostCapability, MemorySpaceRef, MemoryTargetScope } from '../memory/contracts';
import { resolveRoomTargetScope } from '../memory/target';
import type { Principal } from '../domain/principal';
import type { MemoryRuntime } from '../memory/runtime';
import { register } from './tools';

const PRIVATE_SCOPE: MemoryTargetScope = {
  audience: 'agent_private',
  room_id: null,
  member_generation: null,
  member_seq: null,
  policy_revision: null,
};

interface MemoryToolContext {
  runtime: MemoryRuntime;
  instanceId: string;
  agentId: string;
  credentialId: string;
  space: MemorySpaceRef;
  policy: MemoryHostPolicy;
}

function memoryDisabled(): never {
  throw new BusinessError('MEMORY_DISABLED', 'Memory 未启用', {
    reason: 'memory_disabled',
    remediation: 'deployment_enable_memory',
  });
}

async function memoryContext(env: Env, principal: Principal): Promise<MemoryToolContext> {
  const runtime = env.MEMORY;
  if (!runtime || !runtime.instanceId) memoryDisabled();
  if (!principal.actor || principal.actor.kind !== 'agent') {
    throw new BusinessError('PERMISSION_DENIED', 'Memory 内容工具只接受 Agent 自身凭据', {
      reason: 'agent_credential_required',
    });
  }
  if (!principal.credential || principal.credential.revoked_at !== null) {
    throw new BusinessError('PERMISSION_DENIED', '凭据已撤销，不能访问 Memory', {
      reason: 'credential_revoked',
    });
  }
  const context = await requireCurrentMemorySpace(env.DB, {
    agentId: principal.actor.actor_id,
    instanceId: runtime.instanceId,
    at: nowMs(),
  });
  return {
    runtime,
    instanceId: runtime.instanceId,
    agentId: principal.actor.actor_id,
    credentialId: principal.credential.credential_id,
    space: {
      space_id: context.space.space_id,
      ownership_epoch: context.space.ownership_epoch,
      backend_binding_epoch: context.space.backend_binding_epoch,
    },
    policy: env.MEMORY_HOST ?? DEFAULT_MEMORY_HOST_POLICY,
  };
}

function bridgeFor(context: MemoryToolContext, env: Env): MemoryHostBridge {
  return new MemoryHostBridge({
    db: env.DB,
    instanceId: context.instanceId,
    agentId: context.agentId,
    credentialId: context.credentialId,
    space: context.space,
    policy: context.policy,
  });
}

function statusCatalog(env: Env): ReturnType<typeof memoryCapabilityCatalog> {
  const runtime = env.MEMORY;
  return memoryCapabilityCatalog({
    enabled: runtime?.instanceId != null,
    capture: runtime?.captureEnabled ?? false,
    policy: env.MEMORY_HOST ?? DEFAULT_MEMORY_HOST_POLICY,
    tools: [],
    engine: env.MEMORY_ENGINE ?? null,
    reflect: runtime?.capabilities().reflect ?? false,
  });
}

/**
 * Memory 服务返回领域对象（含 readonly 数组），与 Zod 输出投影的精确类型
 * 不同；这里只做一次边界投射，运行时仍由 outputSchema 校验结构。
 */
function registerMemoryTool<I extends StandardSchemaWithJSON, O extends StandardSchemaWithJSON>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: I,
  outputSchema: O,
  handler: (input: StandardSchemaWithJSON.InferInput<I>) => Promise<unknown>,
  annotations?: Record<string, unknown>,
): void {
  register(server, name, description, inputSchema, outputSchema, async (input) =>
    (await handler(input)) as StandardSchemaWithJSON.InferOutput<O>,
  annotations);
}

export function registerMemoryTools(
  server: McpServer,
  env: Env,
  principal: Principal,
): void {
  const policy = env.MEMORY_HOST ?? DEFAULT_MEMORY_HOST_POLICY;

  registerMemoryTool(
    server,
    'network_memory_status',
    '读取当前 Agent 的 Memory 能力与空间状态：是否启用、capture、宿主等级、可用召回模式、待处理作业/retain 计数与明确不支持项。Memory 关闭时返回 enabled=false，不伪造空库；不返回 provider/bank/密钥。',
    memoryEmptyInputSchema,
    memoryStatusOutputSchema,
    async () => {
      const catalog = statusCatalog({ ...env, MEMORY_HOST: policy });
      const runtime = env.MEMORY;
      if (!runtime?.instanceId) {
        return {
          enabled: false,
          capture: false,
          engine_status: 'unavailable',
          space_id: '',
          ownership_epoch: 0,
          backend_binding_epoch: 0,
          host_level: policy.trust_level,
          supported_host_modes: catalog.host_modes,
          modes: catalog.recall_modes,
          counts: { jobs_pending: 0, jobs_unknown: 0, jobs_failed: 0, retain_pending: 0, contexts_ready: 0 },
          unsupported: catalog.unsupported,
        };
      }
      const context = await memoryContext(env, principal);
      const snapshot = await memoryStatusSnapshot(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        captureEnabled: runtime.captureEnabled,
        runtimeAvailable: true,
        hostLevel: policy.trust_level,
        supportedHostModes: catalog.host_modes,
        now: nowMs(),
      });
      return {
        ...snapshot,
        engine_status: catalog.engine_status,
        unsupported: catalog.unsupported,
      };
    },
    { readOnlyHint: true },
  );

  registerMemoryTool(
    server,
    'network_memory_recall',
    '显式召回当前 Agent 已有记忆或按目标预热。lookup/reflect 返回参考数据与 lookup Context，永不携带注入许可；auto 必须绑定有效 HostBinding 与准确消息目标，且仍只是预热。status=pending/unavailable/unsupported/disabled 如实返回；结果不改变聊天、delivery 或 pending_count。',
    memoryRecallInputSchema,
    memoryRecallOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      const result = await recallMemory(env.DB, context.runtime, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        input,
        now: nowMs(),
      });
      return { ...result.recall, context_ref: result.context_ref, injection: result.injection };
    },
    { readOnlyHint: true },
  );

  registerMemoryTool(
    server,
    'network_memory_context_list',
    '分页列出当前 Agent 的 MemoryContext 元数据（不含正文）。lookup 包没有注入许可；bound 包是否仍可注入以 network_memory_context_get 当前重验为准。',
    memoryContextListInputSchema,
    memoryContextListOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      return listMemoryContexts(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        input,
        now: nowMs(),
      });
    },
    { readOnlyHint: true },
  );

  registerMemoryTool(
    server,
    'network_memory_context_get',
    '按当前权限读取 MemoryContext 正文与证据。任一依赖被撤回、遗忘、受众变化或成员代次失配时返回 available=false，不返回部分正文；lookup 结果仍不能直接注入。',
    memoryContextGetInputSchema,
    memoryContextGetOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      const result = await readMemoryContextView(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        contextId: input.context_id,
        now: nowMs(),
      });
      if (!result.available) {
        return {
          available: false,
          reason: result.reason,
          context_id: input.context_id,
        };
      }
      return {
        available: true,
        context_id: result.contextView.context_id,
        kind: result.contextView.kind,
        body: result.contextView.body,
        body_sha256: result.contextView.body_sha256,
        items: result.contextView.items,
        validity: result.contextView.context.validity,
        injection: result.contextView.context.injection,
      };
    },
    { readOnlyHint: true },
  );

  registerMemoryTool(
    server,
    'network_memory_list',
    '分页列出当前 Agent 有权访问的 Memory 来源或人工记忆。来源列表只包含本 Agent 实际获得过的来源；curated 是人工保存，不是群消息阅读证明。不返回其它 Agent 的私有正文。',
    memoryListInputSchema,
    memoryListOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      if (input.object_kind === 'curated') {
        const items = await listMemoryCurated(env.DB, {
          instanceId: context.instanceId,
          agentId: context.agentId,
          space: context.space,
          limit: input.limit,
          now: nowMs(),
        });
        return { object_kind: 'curated', items, next_cursor: null, has_more: false };
      }
      const page = await listMemorySources(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        limit: input.limit,
        cursor: input.cursor,
        now: nowMs(),
      });
      return { object_kind: 'source', ...page };
    },
    { readOnlyHint: true },
  );

  registerMemoryTool(
    server,
    'network_memory_get',
    '读取单个 Memory 来源或人工记忆。来源读取重验当前成员代次、历史边界、策略与遗忘屏障；curated 只允许 Agent 自身凭据读取。无法读取时 found=true 但正文为 null，并给出原因。',
    memoryGetInputSchema,
    memoryGetOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      if (input.object_kind === 'curated') {
        const item = await getMemoryCurated(env.DB, {
          instanceId: context.instanceId,
          agentId: context.agentId,
          space: context.space,
          curatedId: input.id,
          revision: input.revision,
          now: nowMs(),
        });
        return { object_kind: 'curated', found: item !== null, item, reason: item ? null : 'not_found' };
      }
      const detail = await getMemorySourceDetail(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        sourceId: input.id,
        revision: input.revision,
        now: nowMs(),
      });
      return {
        object_kind: 'source',
        found: true,
        item: detail,
        reason: detail.reason,
      };
    },
    { readOnlyHint: true },
  );

  registerMemoryTool(
    server,
    'network_memory_put',
    '人工保存一条当前 Agent 的记忆（curated），不是验证事实、不是群消息阅读。request_id 幂等；同一 request_id 不同内容返回 IDEMPOTENCY_CONFLICT。客户端不能自报 verified/provenance。',
    memoryPutInputSchema,
    memoryPutOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      const result = await putMemoryCurated(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        request_id: input.request_id,
        title: input.title,
        content: input.content,
        expected_revision: input.expected_revision,
        now: nowMs(),
      });
      return {
        request_id: input.request_id,
        curated_id: result.curated.curated_id,
        revision: result.curated.revision,
        operation_id: result.operation_id,
        status: result.status,
        duplicate: result.duplicate,
      };
    },
  );

  registerMemoryTool(
    server,
    'network_memory_correct',
    '以 expected_revision 修订当前 Agent 的人工记忆。修订变化返回 VERSION_CONFLICT；旧修订不原地覆盖。客户端不能借修订提升来源或证据等级。',
    memoryCorrectInputSchema,
    memoryPutOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      const result = await putMemoryCurated(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        request_id: input.request_id,
        curated_id: input.curated_id,
        expected_revision: input.expected_revision,
        title: input.title,
        content: input.content,
        now: nowMs(),
      });
      return {
        request_id: input.request_id,
        curated_id: result.curated.curated_id,
        revision: result.curated.revision,
        operation_id: result.operation_id,
        status: result.status,
        duplicate: result.duplicate,
      };
    },
  );

  registerMemoryTool(
    server,
    'network_memory_forget',
    '对精确目标发起遗忘/排除：source、curated 或 experience。先本地逻辑排除，再异步清理后端；无法精确解析到可重放目标时返回 MEMORY_UNSUPPORTED_GRANULARITY，不偷偷扩大删除范围。purge 保持 unknown/pending，不提前声称已清除。',
    memoryForgetInputSchema,
    memoryForgetOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      return forgetMemory(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        request_id: input.request_id,
        target: input.target,
        now: nowMs(),
      });
    },
  );

  registerMemoryTool(
    server,
    'network_memory_operation_get',
    '读取 Memory 治理/后端操作的分阶段状态与 purge 状态。阶段分为 accepted/source_applied/derived_ready/unknown；unknown 只表示无法确认，不自动重跑。',
    memoryOperationGetInputSchema,
    memoryOperationOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      const operation = await getMemoryOperation(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        operationId: input.operation_id,
        now: nowMs(),
      });
      return { found: operation !== null, operation };
    },
    { readOnlyHint: true },
  );

  registerMemoryTool(
    server,
    'network_memory_host_bind',
    '为当前 Agent 创建 HostBinding。信任等级只由部署方配置签发；客户端 declared_capabilities 只协商能力，不能自报 trusted/verified 或提高等级。省略 session_incarnation 时按 request_id 幂等复用；显式 session 重新 bind 会递增 generation 并关闭旧绑定，旧 run 不能继续准备/提交。tool-only 不能上报最终清单或提交证据。',
    memoryHostBindInputSchema,
    memoryHostBindOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      const bridge = new MemoryHostBridge({
        db: env.DB,
        instanceId: context.instanceId,
        agentId: context.agentId,
        credentialId: context.credentialId,
        space: context.space,
        policy,
      });
      return bridge.bind({
        request_id: input.request_id,
        session_incarnation: input.session_incarnation,
        declared_capabilities: input.declared_capabilities as readonly MemoryHostCapability[] | undefined,
        lease_ms: input.lease_ms,
      });
    },
  );

  registerMemoryTool(
    server,
    'network_memory_host_close',
    '关闭当前 Agent 的 HostBinding。关闭后旧 generation 不能继续准备/提交输入；其他会话不受影响。重复关闭幂等返回 closed=false。',
    memoryHostCloseInputSchema,
    memoryHostCloseOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      const bridge = bridgeFor(context, env);
      const result = await bridge.close({
        binding_id: input.host_binding_id,
        host_generation: input.host_generation,
        reason: input.reason,
      });
      return { ...result, reason: input.reason };
    },
  );

  registerMemoryTool(
    server,
    'network_memory_input_prepare',
    '在 claim 后把服务端签发的 selection 绑定到准确 run/input，返回 PreparedInput。prepared 不产生经历、没有 retain 资格；宿主裁剪/摘要后必须用实际 payload 重建 SubmittedInputManifest，不能用准备清单冒充提交。宿主断线/租约过期返回 skipped_no_boundary。',
    memoryInputPrepareInputSchema,
    memoryInputPrepareOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      const bridge = bridgeFor(context, env);
      const prepared = await bridge.prepareInput({
        request_id: input.request_id,
        target: input.target,
        selection_ids: input.selection_ids,
        budget: { ...input.budget, deadline_at: input.budget.deadline_at ?? null },
      });
      if (prepared.status === 'skipped_no_boundary') {
        return {
          status: 'skipped_no_boundary',
          retain_eligible: false,
          reason: prepared.reason,
        };
      }
      return {
        status: 'prepared',
        prepared_input_id: prepared.prepared_input_id,
        target: prepared.target,
        items: prepared.items,
        snapshot_upper_bound: prepared.snapshot_upper_bound,
        budget: prepared.budget,
        created_at: prepared.created_at,
        expires_at: prepared.expires_at,
        retain_eligible: false,
      };
    },
  );

  registerMemoryTool(
    server,
    'network_memory_input_status',
    '读取 manifest 当前的提交状态：prepared、host_queued（仅宿主本进程声明，不是证据）、host_reported_submitted、gateway_observed_submitted。准备/排队/受理都不等于模型已提交；retain_eligible 只在合格 receipt 落库后为 true。',
    memoryInputStatusInputSchema,
    memoryInputStatusOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      return bridgeFor(context, env).inputState(input.manifest_id);
    },
    { readOnlyHint: true },
  );

  registerMemoryTool(
    server,
    'network_memory_admit',
    '提交宿主回执。kind=input_exposure 必须绑定准确 manifest/payload；kind=context_delivery 必须绑定当前有效的 bound Context。evidence 由服务端按 HostBinding 派生，客户端不能自报；迟到/失效只返回 rejected 或 history_only，不复活正文、不写新 owner 经历。',
    memoryExposureReceiptInputSchema,
    memoryAdmitOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      const bridge = bridgeFor(context, env);
      if (input.kind === 'input_exposure') {
        const manifest = await env.DB.prepare(
          'SELECT host_binding_id, host_generation FROM memory_manifests WHERE manifest_id = ?',
        )
          .bind(input.manifest_id)
          .first<{ host_binding_id: string | null; host_generation: number | null }>();
        if (!manifest?.host_binding_id || manifest.host_generation === null) {
          throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest 没有有效宿主绑定', {
            reason: 'manifest_host_binding_missing',
          });
        }
        const ack = await bridge.submitExposure({
          protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
          host_binding_id: manifest.host_binding_id,
          host_generation: manifest.host_generation,
          manifest_id: input.manifest_id!,
          manifest_sha256: input.manifest_sha256!,
          payload_sha256: input.payload_sha256!,
          request_id: input.request_id,
          submitted_at: input.submitted_at,
        });
        return {
          kind: 'input_exposure',
          disposition: ack.disposition,
          reason: ack.reason,
          evidence: ack.evidence,
          experience_ids: ack.experience_ids,
          retain_ids: ack.retain_ids,
        };
      }
      const contextRow = await env.DB.prepare('SELECT * FROM memory_contexts WHERE context_id = ?')
        .bind(input.context_id)
        .first<{
          context_id: string;
          space_id: string;
          ownership_epoch: number;
          agent_actor_id: string;
          kind: 'lookup' | 'bound';
          body_sha256: string;
          target_json: string | null;
        }>();
      if (
        !contextRow ||
        contextRow.space_id !== context.space.space_id ||
        contextRow.ownership_epoch !== context.space.ownership_epoch ||
        contextRow.agent_actor_id !== context.agentId
      ) {
        throw new BusinessError('MEMORY_TARGET_INVALID', 'Context 不存在或空间不匹配', {
          reason: 'context_missing',
        });
      }
      if (contextRow.kind !== 'bound' || !contextRow.target_json) {
        throw new BusinessError('MEMORY_TARGET_INVALID', 'lookup Context 不接收交付回执', {
          reason: 'lookup_not_delivered',
        });
      }
      if (contextRow.body_sha256 !== input.context_sha256) {
        throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', 'Context hash 不一致', {
          reason: 'context_hash_mismatch',
        });
      }
      const target = JSON.parse(contextRow.target_json) as {
        host_binding_id: string;
        host_generation: number;
        session_incarnation: string;
        run_id: string;
        input_id: string;
        input_revision: number;
      };
      let binding: { trust_level: string };
      try {
        binding = await requireHostBinding(env.DB, {
          bindingId: target.host_binding_id,
          generation: target.host_generation,
          space: context.space,
          agentId: context.agentId,
          at: nowMs(),
        });
      } catch {
        return {
          kind: 'context_delivery',
          disposition: 'rejected',
          reason: 'host_binding_inactive',
          receipt_id: null,
          evidence: null,
          experience_ids: [],
          retain_ids: [],
        };
      }
      const evidence =
        binding.trust_level === 'api_tool_only'
          ? 'served'
          : 'host_reported_delivered';
      const receiptId = `mrc_${(await sha256Hex(`context_delivery|${input.request_id}`)).slice(0, 32)}`;
      const disposition = await recordContextDeliveryReceipt(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        receipt: {
          receipt_id: receiptId,
          kind: 'context_delivery',
          context_id: contextRow.context_id,
          context_sha256: contextRow.body_sha256,
          invocation: {
            host_binding_id: target.host_binding_id,
            host_generation: target.host_generation,
            session_incarnation: target.session_incarnation,
            run_id: target.run_id,
            input_id: target.input_id,
            input_revision: target.input_revision,
            invocation_id: input.invocation_id,
          },
          space: context.space,
          agent_actor_id: context.agentId,
          evidence,
          proof_id: input.proof_id,
          delivered_at: input.submitted_at,
          idempotency_key: `context_delivery:${target.host_binding_id}:${input.request_id}`,
        },
        now: nowMs(),
      });
      return {
        kind: 'context_delivery',
        disposition: disposition.disposition,
        reason: disposition.reason,
        receipt_id: disposition.receipt_id,
        evidence,
        experience_ids: [],
        retain_ids: [],
      };
    },
  );

  registerMemoryTool(
    server,
    'network_memory_catchup_prepare',
    '为指定房间生成固定快照的补读计划并准备 selection。scan cursor 只记录扫描位置，不推进已读/经历/未读；selected 不是已消费。预算耗尽或必要消息缺失会明确标注。',
    memoryCatchupPrepareInputSchema,
    memoryCatchupPrepareOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      const plan = await planCatchup(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        roomId: input.room_id,
        query: input.query,
        requiredMessageIds: input.required_message_ids,
        currentMessageId: input.current_message_id,
        budget: input.budget,
        requestKey: input.request_id,
        now: nowMs(),
      });
      const targetScope = await resolveRoomTargetScope(env.DB, input.room_id, context.agentId);
      const prepared = await prepareCatchupSelections(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        targetScope,
        planId: plan.plan_id,
        now: nowMs(),
      });
      return {
        plan_id: plan.plan_id,
        room_id: plan.room_id,
        status: plan.status,
        snapshot: plan.snapshot,
        items: plan.items,
        selections: prepared.selections,
        missing: prepared.missing,
        retain_eligible: false,
      };
    },
  );

  registerMemoryTool(
    server,
    'network_memory_catchup_get',
    '分页读取补读计划项。新消息不会进入旧计划；成员代次/策略/受众变化或过期时返回 expired 且不返回条目。',
    memoryCatchupGetInputSchema,
    memoryCatchupGetOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      return getCatchupPage(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        planId: input.plan_id,
        limit: input.limit,
        cursor: input.cursor,
        now: nowMs(),
      });
    },
    { readOnlyHint: true },
  );

  registerMemoryTool(
    server,
    'network_memory_experience_list',
    '分页列出当前 Agent 按 origin room/member generation 隔离的稀疏经历。summary-only 不冒充原文；未选择/未消费不是待办；min_evidence 过滤不会把低等级来源整体升级。',
    memoryExperienceListInputSchema,
    memoryExperienceListOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      return listExperiences(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        targetScope: PRIVATE_SCOPE,
        roomId: input.room_id,
        memberGeneration: input.member_generation,
        originKinds: input.origin_kinds,
        minimumEvidence: input.minimum_evidence ?? null,
        limit: input.limit,
        cursor: input.cursor,
        callerActorId: principal.actor!.actor_id,
        now: nowMs(),
      });
    },
    { readOnlyHint: true },
  );

  registerMemoryTool(
    server,
    'network_memory_experience_get',
    '读取一条经历的正文与证据等级。当前授权/遗忘/来源排除不通过时 available=false 且不返回正文；摘要经历不会显示为全文阅读。',
    memoryExperienceGetInputSchema,
    memoryExperienceGetOutputSchema,
    async (input) => {
      const context = await memoryContext(env, principal);
      const result = await getExperience(env.DB, {
        instanceId: context.instanceId,
        agentId: context.agentId,
        space: context.space,
        targetScope: PRIVATE_SCOPE,
        experienceId: input.experience_id,
        callerActorId: principal.actor!.actor_id,
        now: nowMs(),
      });
      if (!result.available) {
        return { available: false, reason: result.reason, experience_id: input.experience_id };
      }
      return {
        available: true,
        experience_id: input.experience_id,
        item: result.detail.item,
        text: result.detail.text,
      };
    },
    { readOnlyHint: true },
  );
}
