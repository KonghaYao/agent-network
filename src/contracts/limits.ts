/** 第一版默认限制（§12.2）。所有阈值只有这一份实现。 */
export const LIMITS = {
  /** 单次 HTTP JSON body 上限。 */
  httpBodyBytes: 512 * 1024,
  /** 单条消息正文 UTF-8 上限。 */
  messageBodyBytes: 256 * 1024,
  /** actor 展示名称长度上限（按去空格后的字符数）。 */
  actorNameMax: 96,
  /** actor 展示名称 UTF-8 字节上限；96 个 4 字节字符最多 384 字节。 */
  actorNameBytes: 384,
  /** actor metadata 上限。 */
  actorMetadataBytes: 4 * 1024,
  /** 消息预览上限。 */
  previewBytes: 512,
  /** 历史页默认 / 最大条数。 */
  historyPageDefault: 50,
  historyPageMax: 100,
  /** 正文分块上限。 */
  bodyChunkBytes: 64 * 1024,
  /** 普通工具响应上限。 */
  toolResponseBytes: 256 * 1024,
  /** inbox 页默认 / 最大条数。 */
  inboxPageDefault: 20,
  inboxPageMax: 50,
  /** sync 页默认 / 最大条数。 */
  syncPageDefault: 100,
  syncPageMax: 200,
  /** 每 Agent pending 上限。 */
  pendingPerActor: 500,
  /** `network_agents_get` 单次批量读取上限；不做全局枚举。 */
  agentLookupMax: 100,
  /** `network_agents_managed_list` 默认 / 最大条数。 */
  managedAgentsPageDefault: 50,
  managedAgentsPageMax: 100,
  /** 一次性认领码有效期（毫秒）。 */
  agentClaimTtlMs: 15 * 60_000,
  /** 认领码错误尝试上限；达到后 claim 置 rejected。 */
  agentClaimMaxAttempts: 5,
  /** 管理委托默认有效期（毫秒）。 */
  agentDelegationTtlMs: 30 * 24 * 60 * 60_000,
  /** 停用原因 UTF-8 字节上限。 */
  agentDisableReasonBytes: 512,
  /** 浏览器本地 Agents 注册表上限；超过后保留最新条目。 */
  webAgentRegistryMax: 100,
  /** 成员选择器每次渲染的候选数量；搜索过滤后再分页。 */
  webMemberPickerPageSize: 100,
  /** 单次成员变更上限。 */
  memberChangeMax: 20,
  /** 好友申请附言 UTF-8 字节上限。 */
  contactRequestMessageBytes: 512,
  /** 好友申请默认有效期（毫秒）。 */
  contactRequestTtlMs: 7 * 24 * 60 * 60_000,
  /** 好友申请页默认 / 最大条数。 */
  contactRequestsPageDefault: 20,
  contactRequestsPageMax: 100,
  /** 单轮过期好友申请扫描上限。 */
  contactRequestExpiryBatchMax: 50,
  /**
   * 好友申请的发送者窗口限额；超过返回 RATE_LIMITED。
   * 管理者向自有 Agent 的自动建联是关系管理而非陌生申请，不计入该窗口。
   */
  contactRequestWindowMs: 10 * 60_000,
  contactRequestWindowMax: 30,
  /** 解除拉黑后的再申请冷却（毫秒）；冷却内新申请返回 RATE_LIMITED。 */
  contactUnblockCooldownMs: 5_000,
  /** 拉黑原因 UTF-8 字节上限。 */
  contactBlockReasonBytes: 512,
  /** 拉黑列表默认 / 最大条数。 */
  contactBlocksPageDefault: 20,
  contactBlocksPageMax: 100,
  /** 举报备注 UTF-8 字节上限；举报只保存定位信息，不复制正文。 */
  contactReportNoteBytes: 1024,
  /** 举报窗口限额（毫秒 / 次数）。 */
  contactReportWindowMs: 10 * 60_000,
  contactReportWindowMax: 20,
  /** 举报列表默认 / 最大条数。 */
  contactReportsPageDefault: 20,
  contactReportsPageMax: 100,
  /**
   * 同一发送者在一个窗口内对同一 recipient 的定向投递上限。
   * 命中返回 RATE_LIMITED，用于抑制重复 @ 造成的唤醒风暴。
   */
  mentionDeliveryWindowMs: 60_000,
  mentionDeliveryWindowMax: 120,
  /**
   * 群成员邀请/添加的发送者窗口限额；命中返回 RATE_LIMITED。
   * 只统计显式的成员添加审计，不把建群时的初始成员算作邀请。
   */
  roomInviteWindowMs: 10 * 60_000,
  roomInviteWindowMax: 60,
  /** 群成员上限。 */
  groupMembersMax: 100,
  /** 定向群邀请默认有效期（毫秒）。G02 的链接邀请复用同一初始值。 */
  roomInviteTtlMs: 7 * 24 * 60 * 60_000,
  /** 群邀请列表默认 / 最大条数。 */
  roomInvitationsPageDefault: 20,
  roomInvitationsPageMax: 100,
  /** 群公告 UTF-8 字节上限。 */
  roomAnnouncementBytes: 4 * 1024,
  /** 群角色审计默认 / 最大条数。 */
  roomRoleHistoryPageDefault: 20,
  roomRoleHistoryPageMax: 100,
  /** 群主转让提议默认有效期（毫秒）；接受前原群主继续负责。 */
  roomOwnerTransferTtlMs: 24 * 60 * 60_000,
  /** 单条消息 invoke 上限。 */
  invokeMax: 8,
  /** `network_message_send_status` 单次按 client_message_id 对账的数量上限。 */
  messageSendStatusMax: 20,
  /** 单条消息正文中自动归档的同源文件链接上限。 */
  messageFileLinksMax: 8,
  /** 协作深度与每个 root 的累计 delivery 上限。 */
  cooperationDepthMax: 4,
  rootDeliveryMax: 32,
  /** 每 Agent 的活跃房间上限。 */
  activeRoomsPerActor: 200,
  /** 房间文件保留上限（毫秒）；不提供续期接口。 */
  roomFileTtlMs: 30 * 24 * 60 * 60_000,
  /** 未绑定上传草稿的默认保留期（毫秒）。 */
  fileDraftTtlMs: 24 * 60 * 60_000,
  /** 软删文件在清理载荷前的宽限期（毫秒）；期间元数据可审计、可恢复。 */
  fileGcGraceMs: 7 * 24 * 60 * 60_000,
  /** 单个上传者未绑定草稿的总字节上限。 */
  draftBytesPerActor: 1024 * 1024 * 1024,
  /** 单个上传者未绑定草稿数量上限。 */
  draftFilesPerActor: 500,
  /** 过期房间文件墓碑在 expires_at 之后的额外保留期（毫秒）。 */
  roomFileTombstoneGraceMs: 7 * 24 * 60 * 60_000,
  /** 每个房间的文件数量上限。 */
  roomFilesPerRoom: 200,
  /** 每个房间的文件总字节上限。 */
  roomFileBytesPerRoom: 1024 * 1024 * 1024,
  /**
   * 房间文件下载票据有效期（毫秒）。票据只用于 `<img>`/下载链接等不能携带
   * Authorization 的场景；每次使用仍检查成员代次与当前历史边界。
   */
  fileTicketTtlMs: 60 * 60_000,
  /** 网页监控面板 URL 的 UTF-8 字节上限；只允许 http/https。 */
  roomMonitorUrlMax: 2048,
  /** 单个房间任务列表的短描述/结果字符上限（按 Unicode 码点）。 */
  roomTaskTextMax: 120,
  /** 每个房间任务数量上限。 */
  roomTasksPerRoom: 200,
  /** `network_task_summary` 单次 room_ids 过滤上限。 */
  taskLookupMax: 100,
  /** 房间文件列表默认 / 最大条数。 */
  roomFilePageDefault: 20,
  roomFilePageMax: 100,
  /** 成果列表默认 / 最大条数。 */
  artifactPageDefault: 20,
  artifactPageMax: 100,
  /** 成果摘要 UTF-8 字节上限。 */
  artifactSummaryBytes: 1024,
  /** 单次成果提交/释放的幂等结果上限（内部）。 */
  artifactVersionMax: 1_000_000,
  /** 每条流式订阅的 URI 上限；只允许 `agentnet://stream`。 */
  subscriptionUrisMax: 1,
  /** 统一 actor stream 单帧最多包含的 item 数。 */
  streamBatchMax: 20,
  /** 同一 actor 允许的物理连接数（重连重叠/多设备）。 */
  streamConnectionsPerActor: 4,
  /** 单条 stream 连接的待发送队列上限。 */
  streamQueueMax: 32,
  /** 内部提示上限；统一 stream 的单帧 JSON 也复用该字节上限。 */
  hintBytes: 1024,
  /** 单条监听待发送队列。 */
  listenQueueMax: 32,
  /** SSE 保活间隔（毫秒）；同时决定客户端断开后服务端发现离线的上限。 */
  keepaliveMs: 5_000,
  /** 主动轮换间隔（毫秒）。 */
  rotationMs: 15 * 60_000,
  /** 同 URI 通知合并窗口（毫秒）。 */
  notifyMergeMs: 250,
  /**
   * claimed 超过该时长没有 report/complete 时，网页提示“处理中未更新”。
   * 仅前端展示阈值，不轮询、不改变 delivery 状态。
   */
  claimedStaleMs: 2 * 60_000,
  /**
   * claimed 投递超过该时长没有 progress 更新时，向 recipient 的 inbox
   * 写入一条 `delivery_reminder` 事件；持续无更新时按同一周期重复提醒。
   */
  deliveryReminderMs: 3 * 60_000,
  /** 提醒扫描周期（毫秒）；与 60s 的维护周期解耦，保证提醒及时。 */
  deliveryReminderScanMs: 30_000,
  /** 单轮提醒扫描最多处理的投递数。 */
  deliveryReminderBatchMax: 50,
  /** 恢复 ticket 有效期（毫秒）。 */
  recoveryTicketMs: 3 * 60_000,
  /** 幂等窗口（毫秒）。 */
  operationsRetentionMs: 30 * 24 * 60 * 60_000,
  /** events 留存（毫秒）。 */
  eventsRetentionMs: 30 * 24 * 60 * 60_000,
  /** 已完成 outbox 留存（毫秒）。 */
  outboxRetentionMs: 7 * 24 * 60 * 60_000,
  /** outbox 单轮处理上限。 */
  outboxBatchMax: 100,
  /** outbox 租约时长（毫秒）。 */
  outboxLeaseMs: 30_000,
  /** 重连退避。 */
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  /** 重连抖动比例（±）。 */
  reconnectJitterRatio: 0.2,
  /** 连接稳定多久后重置重连计数。 */
  reconnectStableMs: 30_000,
  /** Agent 最后连接断开后等待重连的宽限；期间重连不产生上下线记录。 */
  agentPresenceGraceMs: 30_000,
  /**
   * 无 SSE 连接时，最近一次 Agent MCP 请求仍视为在线的窗口（毫秒）。
   * 20 秒 inbox 轮询与任意工具调用都会刷新；超过该窗口才进入 pending。
   */
  agentPresenceActivityTtlMs: 60_000,
  /** 活动时间写库节流；小于该间隔的重复请求只读不写，避免写放大。 */
  agentPresenceTouchThrottleMs: 5_000,
  /** 上下线宽限扫描周期。 */
  agentPresenceSweepMs: 5_000,
  /** 单次扫描确认的 pending 数量上限。 */
  agentPresenceSweepBatch: 50,
  /** 连续失败多少次后显示非阻塞提示。 */
  reconnectBannerAfterFailures: 5,
  /** 连续无 ack 多久后显示非阻塞提示。 */
  reconnectBannerAfterMs: 60_000,
  /**
   * 网页普通 RPC 的超时（毫秒）。流式订阅不套用该超时；
   * 前端只用它结束 loading 并显示可读错误，不改变服务端行为。
   */
  webRequestTimeoutMs: 15_000,
  /** 网页收到房间通知后的刷新合并窗口（毫秒）。 */
  webRefreshDebounceMs: 300,
  /** 浏览器本地发送意图上限；超出后保留最新条目。 */
  webOutboxMax: 50,
  /** 未确认/失败的本地发送意图保留时长（毫秒）。 */
  webOutboxTtlMs: 24 * 60 * 60_000,
  /** “已提交”本地提示保留时长（毫秒）；服务端消息出现后立即清理。 */
  webOutboxCommittedMs: 60_000,
  /** 网页消息区距底不超过该值时视为“跟随底部”。 */
  webScrollStickyPx: 80,
  /** 滚轮/触摸上翻意图的最小位移（像素）。 */
  webScrollIntentPx: 6,
  /** 用户上翻后的短窗口：期间异步高度与 scroll 事件都不得自动回底（毫秒）。 */
  webScrollSuppressPinMs: 250,
  /** 全量重建时落点未知，用于忽略钳制 scroll 事件的兜底窗口（毫秒）。 */
  webScrollProgrammaticMs: 200,
  /** 用户滚动停止多久后才做阅读锚点补偿（毫秒）。 */
  webScrollUserIdleMs: 160,
  /** 阅读锚点单次最大补偿位移；超过说明锚点已过期，直接丢弃（像素）。 */
  webScrollAnchorMaxShiftPx: 240,
  /** 距可滚动顶部不超过该比例时自动加载更早；0.1 即“距顶 10% 内”。 */
  webOlderAutoTopRatio: 0.1,
  /** 回到最新后的 mark_read 去抖窗口（毫秒）。 */
  webScrollMarkReadDelayMs: 250,
  /** MCP Events 默认订阅寿命（毫秒）。 */
  eventsSubscriptionTtlMs: 24 * 60 * 60_000,
  /** MCP Events 最小授权寿命（毫秒）。 */
  eventsSubscriptionTtlMinMs: 5 * 60_000,
  /** MCP Events 最大授权寿命（毫秒）；拒绝无过期订阅。 */
  eventsSubscriptionTtlMaxMs: 7 * 24 * 60 * 60_000,
  /** 过期订阅删除前的宽限期（毫秒）。 */
  eventsSubscriptionGraceMs: 24 * 60 * 60_000,
  /** 每个 actor 的活跃订阅上限。 */
  eventsSubscriptionsPerActor: 20,
  /** 全局活跃订阅上限。 */
  eventsSubscriptionsGlobal: 1000,
  /** 单订阅 pending + processing 投递上限（扫描背压）。 */
  eventsPendingDeliveriesPerSubscription: 500,
  /** 单次扫描事件数。 */
  eventsScanBatchMax: 50,
  /** 单 tick 扫描订阅数。 */
  eventsScanSubscriptionsPerTick: 50,
  /** 单 tick 领取投递数。 */
  eventsDeliveryBatchMax: 50,
  /** 出站 webhook 并发。 */
  eventsWebhookConcurrency: 4,
  /** challenge 验证超时（毫秒）。 */
  eventsVerificationTimeoutMs: 5_000,
  /** 单个 callback 地址的尝试超时（毫秒）；总预算仍由调用方 timeoutMs 控制。 */
  eventsCallbackAttemptTimeoutMs: 5_000,
  /** webhook 投递超时（毫秒）。 */
  eventsWebhookTimeoutMs: 10_000,
  /** webhook 响应最多读取字节数。 */
  eventsWebhookResponseBytes: 4096,
  /** callback URL 最大字节数。 */
  eventsCallbackUrlMaxBytes: 4096,
  /** webhook 最大尝试次数。 */
  eventsWebhookMaxAttempts: 8,
  /** webhook 最大重试窗口（毫秒）。 */
  eventsWebhookMaxAgeMs: 24 * 60 * 60_000,
  /** webhook 重试退避基数（毫秒）。 */
  eventsWebhookRetryBaseMs: 1_000,
  /** webhook 重试退避上限（毫秒）。 */
  eventsWebhookRetryMaxMs: 60 * 60_000,
  /** delivered/abandoned 投递留存（毫秒）。 */
  eventsDeliveryRetentionMs: 7 * 24 * 60 * 60_000,
  /** challenge 验证缓存（毫秒）。 */
  eventsVerificationCacheMs: 24 * 60 * 60_000,
  /** 旧 secret 双签宽限（毫秒）。 */
  eventsSecretRotationGraceMs: 60 * 60_000,
  /** 连续失败多少次后暂停订阅。 */
  eventsFailureSuspensionThreshold: 20,
  /** 单事件 webhook body 硬上限（字节）。 */
  eventsWebhookMaxPayloadBytes: 256 * 1024,
  /** 每 callback host 每分钟 challenge 上限。 */
  eventsVerificationPerHostPerMinute: 10,
  /** feedback request_id 字节上限（ASCII）。 */
  feedbackRequestIdBytes: 128,
  /** feedback harness 原始 UTF-8 字节上限。 */
  feedbackHarnessBytes: 128,
  /** feedback environment 原始 UTF-8 字节上限。 */
  feedbackEnvironmentBytes: 4 * 1024,
  /** feedback problem 原始 UTF-8 字节上限。 */
  feedbackProblemBytes: 16 * 1024,
} as const;

export function clampPage(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}
