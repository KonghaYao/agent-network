/**
 * MF06/MF10：Memory 能力目录。
 *
 * 只声明客户端可依赖的能力与明确不支持项；不包含 provider、bank、密钥或
 * 内部路由。MF10 起能力目录跟随实际适配器：弱后端不能再被描述成“召回可用”，
 * 时间硬过滤、原生 reflect/export 也按适配器声明如实展示。
 */
import { MEMORY_CONTRACT_VERSION } from './contracts-core';
import { MEMORY_RECALL_MODES } from './recall-contracts';
import { hostSupports, type MemoryHostIntegrationLevel } from './recall-contracts';
import type { MemoryHostPolicy } from './host-bridge';
import type { MemoryAdapter } from './adapters/types';

/** 引擎是否可用；与 Memory 账本是否启用分开。 */
export type MemoryEngineStatus = 'ready' | 'unavailable' | 'unsupported';

export interface MemoryEngineInfo {
  status: MemoryEngineStatus;
  reflect: boolean;
  native_export: boolean;
  time_window: 'hard_filter' | 'ranking_hint_only' | 'unsupported';
}

export interface MemoryCatalogInput {
  enabled: boolean;
  capture: boolean;
  policy: MemoryHostPolicy;
  tools: readonly string[];
  /** 适配器能力；缺省时保持旧行为（只声明 reflect）。 */
  engine?: MemoryEngineInfo | null;
  /** 旧调用兼容；engine 未提供时使用。 */
  reflect?: boolean;
}

/** 只复制能力摘要，不暴露 provider、bank 或凭据。 */
export function memoryEngineInfo(
  adapter: MemoryAdapter,
  status: MemoryEngineStatus,
): MemoryEngineInfo {
  const capabilities = adapter.capabilities();
  return {
    status,
    reflect: capabilities.reflect,
    native_export: capabilities.native_export,
    time_window: capabilities.time_window,
  };
}

export interface MemoryCapabilityCatalog {
  enabled: boolean;
  contract_version: typeof MEMORY_CONTRACT_VERSION;
  capture: boolean;
  engine_status: MemoryEngineStatus;
  host_modes: readonly MemoryHostIntegrationLevel[];
  recall_modes: readonly string[];
  tools: readonly string[];
  supported: readonly string[];
  unsupported: readonly string[];
  reason: string | null;
}

export function memoryCapabilityCatalog(input: MemoryCatalogInput): MemoryCapabilityCatalog {  const level = input.policy.trust_level;
  const hostModes: MemoryHostIntegrationLevel[] =
    level === 'controlled_gateway'
      ? ['tool_only', 'adapted_host', 'controlled_gateway']
      : level === 'adapted_host'
        ? ['tool_only', 'adapted_host']
        : ['tool_only'];
  const engine = input.engine ?? null;
  const engineStatus: MemoryEngineStatus = engine?.status ?? 'ready';
  const reflect = engine ? engine.reflect : input.reflect === true;
  const supported: string[] = [];
  const unsupported: string[] = [];
  if (input.enabled) {
    // 本地账本能力不依赖外部引擎：读取已准备的 Context、来源/人工记忆与经历。
    supported.push(
      'context_read',
      'source_list_get',
      'curated_put_correct',
      'forget_source_curated_experience',
      'experience_list_get',
      'catchup_plan',
      'host_bind_close',
    );
    if (engineStatus === 'ready') {
      supported.push('explicit_lookup', 'lookup_context');
    } else {
      // 引擎不可用/不支持时，召回必须显式降级，不能返回伪造空库。
      unsupported.push('engine_recall');
    }
    if (hostSupports(level, 'run_binding')) {
      supported.push('run_binding', 'input_prepare', 'context_delivery_receipt');
    }
    if (hostSupports(level, 'final_manifest_report')) supported.push('submitted_input_manifest');
    if (hostSupports(level, 'submission_evidence')) supported.push('input_exposure_receipt');
    if (hostSupports(level, 'gateway_observation')) supported.push('gateway_observation');
    if (reflect) supported.push('native_reflect');
    else unsupported.push('native_reflect');
    if (engine?.native_export) supported.push('native_export');
    else unsupported.push('native_export');
    if (engine?.time_window === 'hard_filter') supported.push('hard_time_filter');
    else unsupported.push('hard_time_filter');
    unsupported.push(
      // 当前部署没有任务实体；消息式任务使用 message 目标。
      'task_target',
      // 自动注入需要 claim 后的 bound Context 与宿主运行边界（MF10 集成）。
      'auto_injection',
      // curated 已本地持久化；外部引擎 retain 由后续适配器接入。
      'curated_backend_retain',
    );
  } else {
    supported.length = 0;
    unsupported.push('all');
  }
  return {
    enabled: input.enabled,
    contract_version: MEMORY_CONTRACT_VERSION,
    capture: input.capture,
    engine_status: input.enabled ? engineStatus : 'unavailable',
    host_modes: hostModes,
    recall_modes: MEMORY_RECALL_MODES,
    tools: [...input.tools].sort(),
    supported,
    unsupported,
    reason: input.enabled
      ? engineStatus === 'ready'
        ? null
        : `engine_${engineStatus}`
      : 'memory_disabled',
  };
}
