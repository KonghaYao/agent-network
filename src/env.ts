import type { FileService } from '@peri-code/mcpp/files';

import type { MemoryRuntime } from './memory/runtime';
import type { MemoryHostPolicy } from './memory/host-bridge';
import type { MemoryEngineInfo } from './memory/capability-catalog';
import type { NotificationHub } from './realtime/hub';
import type { AgentPresenceTimeline } from './realtime/presence-timeline';

/** 4D-1 可切换的 MCP 传输实现。 */
export type McpImplementation = 'native' | 'mcp-use';

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
  /**
   * 服务端 MCP 传输实现。缺省 `native`（官方 SDK），`mcp-use` 走
   * `createMcpTransport`。两者只替换传输/注册层，不改变工具注册与协议行为；
   * 切换在重启后生效，`MCP_IMPL=native` 是回滚开关。
   */
  MCP_IMPL?: McpImplementation;
  /** Agent 上下线持久化时间线；缺失时只保留 hub 的进程内在线状态。 */
  PRESENCE?: AgentPresenceTimeline;
  ENVIRONMENT: string;
  PUBLIC_ORIGIN: string;
  /**
   * 消息搜索是否启用 FTS5 trigram；默认 true。`MESSAGE_SEARCH_FTS=0` 可回滚到
   * 全表 `instr(lower())`，1–2 字始终走该路径。
   */
  MESSAGE_SEARCH_FTS?: boolean;
  /**
   * 房间文件下载票据密钥。启动时已由 `resolveFileTicketSecret` 解析：
   * 优先取部署方配置，缺省为 `DATA_DIR/file-ticket.key` 的持久化密钥。
   * 多实例部署必须显式配置同一值，或共享同一 `DATA_DIR`。
   */
  FILE_TICKET_SECRET?: string;
  /** 启用 MCPP Files 时存在；关闭后 drive 工具与上传路由不注册。 */
  FILES?: FileService;
  /** 启用 MCP Events 时存在；缺失时不声明 events 能力、不注册方法。 */
  EVENTS?: EventsConfig;
  /**
   * MF03 Memory 运行时；MEMORY_ENABLED=1 时由 Bun 入口构造。
   * 缺失表示不启动作业领取，但已提交的 Memory 账本与遗忘屏障仍保留。
   */
  MEMORY?: MemoryRuntime;
  /**
   * MF10 引擎能力摘要；只来自部署配置与实际适配器声明。
   * 不包含 provider/bank 路由或凭据，用于能力目录与 UI 状态。
   */
  MEMORY_ENGINE?: MemoryEngineInfo;
  /**
   * MF07 宿主信任策略；只由部署配置/受控网关构造，不能来自客户端输入。
   * 缺省 tool_only：只能显式查询与读取已准备结果。
   */
  MEMORY_HOST?: MemoryHostPolicy;
}
