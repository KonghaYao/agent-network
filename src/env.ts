import type { FileService } from '@peri-code/mcpp/files';

import type { NotificationHub } from './realtime/hub';

/** MCP Events 运行配置；只有 EVENTS_ENABLED=1 且密钥有效时才构造。 */
export interface EventsConfig {
  /** AES-256-GCM 密钥，只用于加密 webhook secret。 */
  encryptionKey: CryptoKey;
  /** 可选的 callback host 精确 allowlist；null 表示不启用。 */
  callbackAllowlist: ReadonlySet<string> | null;
  /** 仅 ENVIRONMENT=test 且显式开关时为 true，允许 loopback/私网与自签证书。 */
  allowPrivateCallbacks: boolean;
  /** 测试用 CA PEM；只在 allowPrivateCallbacks 时生效。 */
  tlsCa?: string;
  verificationTimeoutMs: number;
  deliveryTimeoutMs: number;
  /** 每 callback host 每分钟 challenge 上限；默认取 LIMITS。 */
  verificationPerHostPerMinute: number;
}

export interface Env {
  DB: D1Database;
  NOTIFICATION_HUB: NotificationHub;
  ENVIRONMENT: string;
  PUBLIC_ORIGIN: string;
  /** 启用 MCPP Files 时存在；关闭后 drive 工具与上传路由不注册。 */
  FILES?: FileService;
  /** 启用 MCP Events 时存在；缺失时不声明 events 能力、不注册方法。 */
  EVENTS?: EventsConfig;
}
