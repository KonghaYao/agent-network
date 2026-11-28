/**
 * Task Focus 秘书运行时的启动配置。
 *
 * 五项全部为空表示未启用；部分填写属于部署错误，必须启动失败，并且只
 * 输出缺失的变量名。任何值都不得进入日志。
 */

import type { FocusRuntimeConfig } from '../env';

const FOCUS_ENV_KEYS = [
  'WEBOTS_SWARM_BASE_URL',
  'WEBOTS_SWARM_API_KEY',
  'WEBOTS_FOCUS_MODEL',
  'WEBOTS_FOCUS_MCP_URL',
  'WEBOTS_FOCUS_SERVICE_TOKEN',
] as const;

export type FocusEnvKey = (typeof FOCUS_ENV_KEYS)[number];

export function resolveFocusConfig(
  source: Record<string, string | undefined> = process.env,
): FocusRuntimeConfig | null {
  const values = new Map<FocusEnvKey, string>();
  const missing: FocusEnvKey[] = [];
  for (const key of FOCUS_ENV_KEYS) {
    const value = source[key]?.trim() ?? '';
    if (value.length === 0) missing.push(key);
    else values.set(key, value);
  }
  if (values.size === 0) return null;
  if (missing.length > 0) {
    // 只列变量名，不打印任何值，避免把部署凭据带进启动日志。
    throw new Error(`Task Focus runtime config incomplete: missing ${missing.join(', ')}`);
  }
  return {
    baseUrl: values.get('WEBOTS_SWARM_BASE_URL') as string,
    apiKey: values.get('WEBOTS_SWARM_API_KEY') as string,
    model: values.get('WEBOTS_FOCUS_MODEL') as string,
    mcpUrl: values.get('WEBOTS_FOCUS_MCP_URL') as string,
    serviceToken: values.get('WEBOTS_FOCUS_SERVICE_TOKEN') as string,
  };
}
