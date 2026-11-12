/**
 * MF06：Memory 能力目录。
 *
 * 只声明客户端可依赖的能力与明确不支持项；不包含 provider、bank、密钥或
 * 内部路由。客户端可据此降级：Memory 关闭时不调用内容工具，tool-only 宿主
 * 不宣称自动注入完成，未配置网关时不显示“系统核验提交”。
 */
import { MEMORY_CONTRACT_VERSION } from './contracts-core';
import { MEMORY_RECALL_MODES } from './recall-contracts';
import { hostSupports, type MemoryHostIntegrationLevel } from './recall-contracts';
import type { MemoryHostPolicy } from './host-bridge';

export interface MemoryCatalogInput {
  enabled: boolean;
  capture: boolean;
  policy: MemoryHostPolicy;
  tools: readonly string[];
  /** 引擎是否声明 native reflect；stub/未配置时为 false。 */
  reflect?: boolean;
}

export interface MemoryCapabilityCatalog {
  enabled: boolean;
  contract_version: typeof MEMORY_CONTRACT_VERSION;
  capture: boolean;
  host_modes: readonly MemoryHostIntegrationLevel[];
  recall_modes: readonly string[];
  tools: readonly string[];
  supported: readonly string[];
  unsupported: readonly string[];
  reason: string | null;
}

export function memoryCapabilityCatalog(input: MemoryCatalogInput): MemoryCapabilityCatalog {
  const level = input.policy.trust_level;
  const hostModes: MemoryHostIntegrationLevel[] =
    level === 'controlled_gateway'
      ? ['tool_only', 'adapted_host', 'controlled_gateway']
      : level === 'adapted_host'
        ? ['tool_only', 'adapted_host']
        : ['tool_only'];
  const supported: string[] = [];
  const unsupported: string[] = [];
  if (input.enabled) {
    supported.push(
      'explicit_lookup',
      'lookup_context',
      'context_read',
      'source_list_get',
      'curated_put_correct',
      'forget_source_curated_experience',
      'experience_list_get',
      'catchup_plan',
      'host_bind_close',
    );
    if (hostSupports(level, 'run_binding')) {
      supported.push('run_binding', 'input_prepare', 'context_delivery_receipt');
    }
    if (hostSupports(level, 'final_manifest_report')) supported.push('submitted_input_manifest');
    if (hostSupports(level, 'submission_evidence')) supported.push('input_exposure_receipt');
    if (hostSupports(level, 'gateway_observation')) supported.push('gateway_observation');
    if (input.reflect) supported.push('native_reflect');
    else unsupported.push('native_reflect');
    unsupported.push(
      // 当前部署没有任务实体；消息式任务使用 message 目标。
      'task_target',
      // 自动注入需要 claim 后的 bound Context 与宿主运行边界（MF10 集成）。
      'auto_injection',
      // curated 已本地持久化；外部引擎 retain 由后续适配器接入。
      'curated_backend_retain',
    );
  } else {
    unsupported.push('all');
  }
  return {
    enabled: input.enabled,
    contract_version: MEMORY_CONTRACT_VERSION,
    capture: input.capture,
    host_modes: hostModes,
    recall_modes: MEMORY_RECALL_MODES,
    tools: [...input.tools].sort(),
    supported,
    unsupported,
    reason: input.enabled ? null : 'memory_disabled',
  };
}
