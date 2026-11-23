/** 第一版默认限制（§12.2）。所有阈值只有这一份实现。 */
export const LIMITS = {
  /** 单次 HTTP JSON body 上限。 */
  httpBodyBytes: 512 * 1024,
  /** 单条消息正文 UTF-8 上限。 */
  messageBodyBytes: 256 * 1024,
  /** 普通人类消息可撤回时间窗（毫秒）。 */
  messageRecallWindowMs: 2 * 60_000,
  /**
   * 网页撤回前读取原文的安全余量（毫秒）：读取必须为后续撤回请求留出时间。
   * 普通成员剩余窗口不足该值时跳过读取；读取超时也不会超过
   * `remaining - 安全余量`，避免一次可选读取把撤回拖过服务端窗口。
   */
  webRecallWindowSafetyMarginMs: 2_000,
  /** actor 展示名称长度上限（按去空格后的字符数）。 */
  actorNameMax: 96,
  /** actor 展示名称 UTF-8 字节上限；96 个 4 字节字符最多 384 字节。 */
  actorNameBytes: 384,
  /** actor metadata 上限。 */
  actorMetadataBytes: 4 * 1024,
  /** 消息预览上限。 */
  previewBytes: 512,
  /** `network_message_read` 首次分块返回的引用预览 UTF-8 上限。 */
  quotePreviewBytes: 120,
  /** 历史页默认 / 最大条数。 */
  historyPageDefault: 50,
  historyPageMax: 100,
  /** 正文分块上限。 */
  bodyChunkBytes: 64 * 1024,
  /** 消息搜索关键词字符数上限。 */
  messageSearchQueryMax: 200,
  /** 消息搜索页默认 / 最大条数。 */
  messageSearchPageDefault: 25,
  messageSearchPageMax: 50,
  /** 消息上下文前后条数上限与默认值。 */
  messageContextMax: 10,
  messageContextDefault: 3,
  /** 搜索结果片段字符数（码点）。 */
  messageSearchSnippetChars: 240,
  /** 搜索结果片段首个命中前的上下文码点数。 */
  messageSearchSnippetContextChars: 40,
  /** 模糊搜索单请求最多检查的候选消息数。 */
  messageSearchFuzzyScanMax: 500,
  /** 模糊搜索单请求最多读取的正文 UTF-8 字节数。 */
  messageSearchFuzzyScanBytes: 2 * 1024 * 1024,
  /** 模糊搜索单次读取候选 metadata 的批量上限。 */
  messageSearchFuzzyBatchMax: 32,
  /** 同义词语义组最多保留的归一化词数。 */
  messageSearchSynonymGroupMax: 8,
  /** 同义词单次扩展返回的归一化词数上限。 */
  messageSearchSynonymExpansionMax: 8,
  /** 参与同义词匹配的最小归一化码点数，避免短词泛化。 */
  messageSearchSynonymMinCodePoints: 2,
  /** 搜索游标字符串长度上限。 */
  messageSearchCursorMax: 2048,
  /** 网页搜索输入防抖（毫秒）。 */
  webMessageSearchDebounceMs: 300,
  /** 网页定位目标消息的闪烁时长（毫秒）。 */
  webMessageSearchFlashMs: 1_600,
  /** 消息式 Task 单次摘要批量上限；未标记或不可见的根直接省略。 */
  taskSummaryRootsMax: 20,
  /** 摘要参与者头像组上限；`participant_count` 仍返回完整去重计数。 */
  taskParticipantsMax: 200,
  /** Trace 页默认 / 最大条数；长集合分页读取，不一次全量返回。 */
  taskTracePageDefault: 50,
  taskTracePageMax: 100,
  /** Task 搜索页默认 / 最大条数；按起点聚合后分页。 */
  taskSearchPageDefault: 20,
  taskSearchPageMax: 50,
  /** 每个 Task 摘要返回的命中消息上限；完整数量用 hit_count。 */
  taskSearchMatchesMax: 3,
  /** 单次 Task 搜索扫描的命中消息上限；超过时标记 truncated，不静默全表扫描。 */
  taskSearchScanMax: 2_000,
  /** 房间常驻 Task 列表默认 / 最大条数。 */
  taskListPageDefault: 20,
  taskListPageMax: 20,
  /** 列表项最多展示的 Agent 参与者；`participant_count` 仍返回完整计数。 */
  taskListParticipantsMax: 3,
  /** 列表项最近处理消息预览条数。 */
  taskListRecentMessagesMax: 3,
  /** 列表项根与最近消息的字符预览上限；完整正文仍走消息读取。 */
  taskListPreviewChars: 160,
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
  /**
   * Agent 管理权交接提议默认/最长有效期（毫秒）。
   *
   * 接受前原管理者继续负责；超过有效期后提议只关闭，不改管理权、不轮换凭据。
   */
  agentTransferTtlMs: 24 * 60 * 60_000,
  /** 交接提议最短有效期；只用于测试与临时演示。 */
  agentTransferTtlMinMs: 1_000,
  /** 交接备注 UTF-8 字节上限；不复制进 Agent delivery。 */
  agentTransferNoteBytes: 1_024,
  /** 交接列表默认 / 最大条数。 */
  agentTransferListDefault: 20,
  agentTransferListMax: 100,
  /** 管理视图返回的 active 群关系上限。 */
  agentManagementRoomsMax: 50,
  /** 管理视图返回的 active 委托上限。 */
  agentManagementDelegationsMax: 50,
  /** 管理视图返回的在途投递明细上限。 */
  agentManagementDeliveriesMax: 20,
  /** 管理视图返回的审计摘要条数上限。 */
  agentManagementAuditMax: 20,
  /** 停用原因 UTF-8 字节上限。 */
  agentDisableReasonBytes: 512,
  /**
   * 设备配对挑战默认/最长有效期（毫秒）。
   *
   * 挑战只是一次性短期证明，不是长期凭据；测试可传更短值验证过期，
   * 但不能超过 5 分钟。
   */
  devicePairingTtlMs: 5 * 60_000,
  /** 配对挑战最短有效期；只用于测试与临时演示。 */
  devicePairingTtlMinMs: 1_000,
  /** 单个挑战允许的错误设备证明尝试次数。 */
  devicePairingMaxAttempts: 5,
  /** 同一 actor 同时 pending/approved 的配对挑战上限。 */
  devicePairingPendingMax: 5,
  /** 配对设备名称/平台 UTF-8 字节上限。 */
  devicePairingLabelBytes: 96,
  devicePairingPlatformBytes: 64,
  /** 待确认配对列表默认/最大条数。 */
  devicePairingListDefault: 20,
  devicePairingListMax: 50,
  /** 设备列表最大条数；单 actor 的设备数量远小于该上限。 */
  deviceListMax: 100,
  /**
   * 凭据/设备最近活动写入节流（毫秒）。认证路径只在超过该间隔时写一次
   * `credentials.last_used_at` 与 `devices.last_seen_at`，避免每个请求都写库。
   */
  deviceActivityThrottleMs: 1_000,
  /** 浏览器本地身份注册表上限；只保存 token 与最小资料，用于显式切换。 */
  webIdentityRegistryMax: 10,
  /** 浏览器 sync 游标持久化时每个 scope 的最大长度。 */
  webSyncCursorMax: 2048,
  /** 浏览器本地 Agents 注册表上限；超过后保留最新条目。 */
  webAgentRegistryMax: 100,
  /** 成员选择器每次渲染的候选数量；搜索过滤后再分页。 */
  webMemberPickerPageSize: 100,
  /**
   * Agent 消息预览被截断但正文不超过该字节数时，页面自动读取全文并直接渲染。
   * 超过该上限仍显示「查看全文」，避免一次刷新并发读取过多大消息。
   *
   * 只对视口内的消息触发，并受 `webAgentAutoExpandConcurrency` 限制。
   * 16–32 KiB 的消息自动展开后仍可通过「收起」折叠；超过该值由用户显式展开。
   */
  webAgentAutoExpandBytes: 32 * 1024,
  /**
   * 自动展开全文的最大并发数。
   *
   * 每条消息可能分多块读取；并发过高会在首屏抢占连接并拖慢可见消息渲染。
   */
  webAgentAutoExpandConcurrency: 3,
  /**
   * 超长消息默认折叠为预览的正文阈值（UTF-8 字节）。
   *
   * 首屏只有 `body_bytes` 与 512B 预览，直接用字节数判断，避免为了折叠额外读取全文。
   * 16 KiB 约等于 5500 个中文字符（3 字节/字），远超一屏；低于该值的截断消息
   * 自动/手动展开后保持完整正文，不再折叠。
   */
  webLongMessageCollapseBytes: 16 * 1024,
  /**
   * 消息正文中连续 base64 文本的最小折叠长度（去除空白后的字符数）。
   *
   * 64 位哈希、短 token 不触发；只对足够长、且几乎全部由 base64 字符组成的
   * 文本做展示折叠，不解码、不识别文件类型。
   */
  webBase64CollapseChars: 512,
  /** 折叠态只渲染的 base64 预览字符数；复制始终使用完整正文。 */
  webBase64PreviewChars: 384,
  /** 单次成员变更上限。 */
  memberChangeMax: 20,
  /** 好友搜索默认 / 最大结果数；搜索不授予关系权限。 */
  contactSearchPageDefault: 20,
  contactSearchPageMax: 50,
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
  /**
   * 好友邀请链接默认 / 最短有效期（毫秒）。
   *
   * 链接是一次性、可撤销的短期入口，不是长期凭据；明文 token 只在创建
   * 响应出现一次，服务端只保存摘要。`expires_in_ms` 只允许缩短到测试用
   * 的最短值，不能超过默认 24 小时。
   */
  contactLinkTtlMs: 24 * 60 * 60_000,
  contactLinkTtlMinMs: 1_000,
  /** 每个 actor 同时 pending 的好友邀请链接上限。 */
  contactLinkPendingMax: 5,
  /** 链接 token 的随机字节数；只保存 SHA-256 摘要。 */
  contactLinkKeyBytes: 24,
  /** 好友邀请链接列表默认 / 最大条数。 */
  contactLinkListDefault: 20,
  contactLinkListMax: 50,
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
  /** 邀请可配置的最长有效期；短于默认值用于测试与临时活动。 */
  roomInviteTtlMaxMs: 30 * 24 * 60 * 60_000,
  /** 邀请可配置的最短有效期；只用于临时活动与验收，默认远长于此。 */
  roomInviteTtlMinMs: 1_000,
  /** 链接邀请默认 / 最大成功加入次数。 */
  roomInviteLinkDefaultUses: 20,
  roomInviteLinkMaxUses: 100,
  /** 同一群同时有效的链接邀请上限，防止无限堆积可分享入口。 */
  roomInviteLinksPerRoom: 20,
  /** 每个群邀请 key 的随机字节数；只保存 SHA-256 摘要。 */
  roomInviteKeyBytes: 24,
  /** 群邀请列表默认 / 最大条数。 */
  roomInvitationsPageDefault: 20,
  roomInvitationsPageMax: 100,
  /** 入群申请列表默认 / 最大条数。 */
  roomJoinRequestsPageDefault: 20,
  roomJoinRequestsPageMax: 100,
  /** 群名称字符上限，与创建和编辑输入契约一致。 */
  roomTitleMax: 160,
  /** 每个群最多置顶的消息数；迁移 CHECK 与该运行时阈值必须一致。 */
  roomPinnedMessagesMax: 3,
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
  /** 消息文件卡片元数据/票据请求的并发上限。 */
  webMessageFileConcurrency: 4,
  /** 消息文件卡片元数据 LRU 条数。 */
  webMessageFileCacheMax: 256,
  /** 元数据与票据缓存时间；票据有效期 60 分钟，提前 5 分钟重签。 */
  webMessageFileCacheTtlMs: 55 * 60_000,
  /** 元数据失败缓存时间（毫秒）；用户仍可手动重试。 */
  webMessageFileFailureTtlMs: 60_000,
  /** 客户端监听器每条投递最多下载并附带的同源附件数。 */
  monitorAttachmentMax: 3,
  /** 单个附件的字节上限；超过只跳过，不阻塞投递。 */
  monitorAttachmentBytes: 5 * 1024 * 1024,
  /** 单个附件的整体下载超时（毫秒），含重定向与读取。 */
  monitorAttachmentTimeoutMs: 5_000,
  /** 附件下载的并发上限；保持有界，避免一次投递打满连接。 */
  monitorAttachmentConcurrency: 2,
  /** 附件文件保留时长（毫秒）；启动、退出与周期任务清理更早的文件。 */
  monitorAttachmentRetentionMs: 24 * 60 * 60_000,
  /** 长进程中附件清理的周期（毫秒）；与保留期共同决定最迟删除时间。 */
  monitorAttachmentCleanupIntervalMs: 60 * 60_000,
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
  /** 消息式 Task 起点短标题字符上限（按 Unicode 码点）。 */
  taskTitleMax: 120,
  /** 单次提交冻结的材料数量上限（旧成果接口兼容）。 */
  taskSubmissionMaterialsMax: 20,
  /** 单次提交记录的外链数量上限（旧成果接口兼容）。 */
  taskSubmissionLinksMax: 20,
  /** 实现提交 SHA 字符上限；接受 7–64 位十六进制（旧成果接口兼容）。 */
  taskSubmissionCommitShaMax: 64,
  /** 单条验收核对项 UTF-8 字节上限（旧成果接口兼容）。 */
  taskReviewChecklistItemBytes: 2 * 1024,
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
  /**
   * 提醒携带的消息摘要 UTF-8 上限。
   *
   * `text` 会再引用一次摘要，因此按字节而不是字符限制；与
   * `deliveryReminderSenderNameBytes` 一起保证单条提醒 stream item 连同
   * 信封不超过 `hintBytes`，不会被帧截断丢弃。完整正文始终不进入提醒。
   */
  deliveryReminderPreviewBytes: 120,
  /** 提醒携带的发送者展示名 UTF-8 上限；`sender_id` 始终保留完整身份。 */
  deliveryReminderSenderNameBytes: 96,
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
  /** touch 节流缓存的最大 actor 数；超出后按 LRU 淘汰。 */
  agentPresenceTouchCacheMax: 10_000,
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
  /** 前台恢复事件的合并窗口：online/visibility/pageshow/ACK 只跑一轮（毫秒）。 */
  webRecoveryDebounceMs: 300,
  /** 上一轮恢复结束后，短时间内再次触发只并入下一轮，不重复鉴权（毫秒）。 */
  webRecoveryQuietMs: 1_500,
  /**
   * 后台停留超过该时长后，回前台做一轮完整核对（毫秒）。
   * 普通长后台只显示非阻塞提示，不遮住当前身份的缓存内容；只有身份/成员/
   * 凭据边界信号才进入遮罩。
   */
  webRecoveryLongBackgroundMs: 5 * 60_000,
  /** 恢复轮进行中，非阻塞「正在同步」提示延迟出现（毫秒），避免快速轮次闪烁。 */
  webRecoveryHintDelayMs: 300,
  /** 恢复遮罩与同步提示的淡入淡出时长（毫秒）；reduced-motion 下不播放。 */
  webRecoveryTransitionMs: 160,
  /** 一次恢复批次最多顺序补读的历史页数；达到后让出主线程继续下一批。 */
  historyCatchUpBatchPages: 20,
  /** 单轮补洞的页数硬上限，防止异常游标无限循环；超过按权限/游标失效重建。 */
  historyCatchUpMaxPages: 1_000,
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
  /**
   * 距可滚动顶部不超过该比例时自动加载更早。
   * 基准是 `scrollHeight - clientHeight`（可滚动范围），0.1 即距顶端 10%；
   * 不可滚动时不触发。
   */
  webOlderAutoTopRatio: 0.1,
  /** 回到最新后的 mark_read 去抖窗口（毫秒）。 */
  webScrollMarkReadDelayMs: 250,
  /**
   * 群聊自动 @ 的兜底读取：已加载窗口无法给出上一位成员时，发送前回读
   * 最近一条消息。超时（毫秒）后按现有窗口语义直接发送，不阻塞、不报错。
   */
  webAutoMentionProbeTimeoutMs: 1_500,
  /** 兜底读取的条数；只为判断最近一条消息的发送者。 */
  webAutoMentionProbeLimit: 1,
  /**
   * 切回房间时允许直接预渲染的缓存消息上限。
   * 超过该值只应用房间元数据并显示加载态，由最新页重新填充；
   * 避免把数百条已加载历史整表重绘后再被刷新覆盖。
   */
  webRoomCacheRenderMax: 80,
  /** Browser full-text cache; mounted messages retain their current bodies. */
  webExpandedBodyCacheBytes: 4 * 1024 * 1024,
  webExpandedBodyCacheMax: 256,
  /**
   * 消息数超过该值才开启 `content-visibility` 长列表隔离。
   * 短会话保持原生滚动高度估算，避免引入滚动条跳动。
   */
  webLongMessageListThreshold: 200,
  /** 未压缩应用入口的硬上限（字节）；发布构建与测量脚本共用。 */
  webEntryHardLimitBytes: 972_800,
  /** 手机扫码帧循环间隔（毫秒）；串行解码，失败不提示。 */
  webPairingScanIntervalMs: 120,
  /** 软件解码前把相机帧缩到的最大边长（像素），限制弱机 CPU。 */
  webPairingScanMaxDimension: 640,
  /** 网页头像：源文件上限与居中裁剪后的输出边长。 */
  webAvatarSourceMaxBytes: 8 * 1024 * 1024,
  webAvatarOutputSize: 512,
  /** 已登录设备未批准时的受控兑换轮询间隔（毫秒）。 */
  webPairingRedeemPollMs: 2_000,
  /** 版本检查相邻事件的合并节流（毫秒）；强制检查可绕过一次。 */
  webVersionCheckThrottleMs: 60_000,
  /** 前台页面的周期版本检查间隔（毫秒）；后台暂停。 */
  webVersionForegroundIntervalMs: 15 * 60_000,
  /** `/web-version.json` 请求超时（毫秒）；失败只标记，不阻断聊天。 */
  webVersionRequestTimeoutMs: 4_000,
  /** 一次性草稿快照的保留时间（毫秒）；恢复或过期后删除。 */
  webUpdateSnapshotTtlMs: 10 * 60_000,
  /** 发布资源保留窗口（毫秒）：最近 7 天内启用的 build 全部保留。 */
  webReleaseRetentionMs: 7 * 24 * 60 * 60_000,
  /** 无论窗口如何都保留最近 N 个不同 buildId。 */
  webReleaseRetainedBuilds: 2,
  /** 清理脚本的额外隔离期；避免刚上传但尚未被任何发布引用的文件被误删。 */
  webReleaseGcGraceMs: 24 * 60 * 60_000,
  /** 固定兼容别名的缓存时长（秒）；别名字节永不自动指向最新。 */
  webAliasCacheMaxAgeSeconds: 300,
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
  /** Events 调度异常重试；避免异常导致唤醒丢失或零延迟忙循环。 */
  eventsRuntimeErrorRetryMs: 5_000,
  /** 平台 setTimeout 最大延迟；更远的持久到期时间分段唤醒。 */
  eventsRuntimeMaxTimerMs: 2_147_483_647,
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
  /** Memory 后端作业租约（毫秒）；过期只表示可对账，不等于远端失败。 */
  memoryJobLeaseMs: 60_000,
  /** 进程内缓存的已确认后端空间代次上限。 */
  memoryReadySpaceCacheEntries: 512,
  /** 单轮 Memory 作业领取上限。 */
  memoryJobBatchLimit: 20,
  /** Memory 可重试作业最大尝试次数；耗尽后保持 failed 显式状态。 */
  memoryJobMaxAttempts: 8,
  /** Memory 作业重试退避基数 / 上限（毫秒）。 */
  memoryJobBackoffBaseMs: 1_000,
  memoryJobBackoffMaxMs: 5 * 60_000,
  /** 运行时 tick 周期（毫秒）；由 Bun 入口定时调用。 */
  memoryTickIntervalMs: 5_000,
  /** unknown 作业对账周期；与领取分开，避免把未知当失败重跑。 */
  memoryReconcileIntervalMs: 30_000,
  /** 空间 provisioning sweep 周期与单批上限；sweep 单轮最多处理一批。 */
  memoryProvisionIntervalMs: 6 * 60 * 60_000,
  memoryProvisionSweepBatch: 50,
  /**
   * Phase C：delivery 记忆参考包的预算。
   *
   * 每 delivery 最多一次工具调用；包只读当前 space 中 origin_room_id 等于
   * 当前房间的来源/经历。正文按字符与 UTF-8 字节双重截断，最终 JSON 不超过
   * `memoryInjectMessageMaxBytes`，也在 `memoryInjectResponseBytes` 硬上限内。
   */
  memoryInjectMessageMaxItems: 6,
  memoryInjectItemMaxChars: 320,
  memoryInjectItemMaxBytes: 1_024,
  memoryInjectMessageMaxBytes: 4 * 1024,
  /** 新工具结构化结果的绝对硬上限（16 KiB）；低于 MCP 通用响应上限。 */
  memoryInjectResponseBytes: 16 * 1024,
  /** 单次候选扫描条数；只做索引查询，不 JOIN messages、不调用 Hindsight。 */
  memoryInjectScanCandidates: 50,
  /** 服务端构建 pack 的硬超时（毫秒）；超时返回空块，不阻塞调用方。 */
  memoryInjectMessageTimeoutMs: 250,
  /** monitor 外层调用超时（毫秒）；失败只降级该投递，不阻塞 delivery。 */
  memoryInjectMonitorTimeoutMs: 2_000,
  /** 参考包建议有效期；过期只表示需要重新读取，不产生后台任务。 */
  memoryInjectPackTtlMs: 30_000,
  /** 客户端按 delivery:attempt 去重的有界条目数。 */
  memoryInjectClientCacheEntries: 512,
  /** 定时回填窗口宽度与调度周期（毫秒）；窗口按整点对齐。 */
  memoryBackfillIntervalMs: 60 * 60_000,
  memoryBackfillWindowMs: 60 * 60_000,
  /** 停机后单轮最多补偿的窗口数；更早的窗口显式跳过并记录。 */
  memoryBackfillMaxCatchupWindows: 24,
  /** 回填单页消息数与 rowid 越界回看行数。 */
  memoryBackfillPageSize: 100,
  memoryBackfillScanSafetyRows: 200,
  /** prepared selection / catchup 计划的短期 TTL（毫秒）。 */
  memoryPreparedTtlMs: 10 * 60_000,
  memoryCatchupTtlMs: 24 * 60 * 60_000,
  /** lookup/bound Context 的默认 TTL；到期后重验不通过，不回写正文。 */
  memoryContextTtlMs: 60 * 60_000,
  /** HostBinding 默认租约；宿主不续租即视为运行边界已结束。 */
  memoryHostLeaseMs: 24 * 60 * 60_000,
  /** 已完成 Memory 作业的审计留存（毫秒）；来源/tombstone 不受此期限影响。 */
  memoryJobRetentionMs: 30 * 24 * 60 * 60_000,
  /** Hindsight 单次 HTTP 请求默认超时；调用方 deadline_at 可缩短。 */
  memoryAdapterTimeoutMs: 10_000,
  /** 只对幂等请求（含 operation_id 的 retain / 读 / delete）重试的次数。 */
  memoryAdapterMaxRetries: 2,
  /** 指数退避基数（毫秒）；仍受 deadline_at 约束。 */
  memoryAdapterRetryBaseMs: 250,
  /** 适配器列举 documents/memories 的页大小上限。 */
  memoryAdapterListPageSize: 100,
  /** Web Memory 面板单页大小；服务端仍按工具 schema 再夹取。 */
  memoryWebPageSize: 20,
  /** Web 显式召回候选与输出预算；只用于发起请求，不改变服务端策略。 */
  memoryWebRecallCandidates: 10,
  memoryWebRecallOutputBytes: 64 * 1024,
  /** Web 人工记忆列表上限；curated 当前不分页。 */
  memoryWebCuratedLimit: 50,
  /** 只读 Agent 记忆面板的单次上游超时（毫秒）；比 Web 请求预算短。 */
  memoryPanelTimeoutMs: 12_000,
  /** 只读面板归一化 DTO 缓存（毫秒）。 */
  memoryPanelCacheTtlMs: 30_000,
  /** 只读面板缓存最大条目数；include_rows 单条可达数百 KB，故按 32 条封顶。 */
  memoryPanelCacheEntries: 32,
  /** 记忆图默认/最大节点数；服务端硬裁剪，超出即报 truncated。 */
  memoryPanelGraphNodesDefault: 120,
  memoryPanelGraphNodesMax: 120,
  /** 客户端请求的节点上限；服务端仍按真实输出上限夹取。 */
  memoryPanelGraphNodesRequestMax: 240,
  /** 记忆图最大边数。 */
  memoryPanelGraphEdgesMax: 600,
  /** 实体共现图最大边数。 */
  memoryPanelEntityGraphEdgesMax: 200,
  /** 客户端请求的实体图边上限；服务端仍按真实输出上限夹取。 */
  memoryPanelEntityGraphEdgesRequestMax: 400,
  /** 实体共现图最大节点数。 */
  memoryPanelEntityGraphNodesMax: 200,
  /** 记忆事实列表默认/最大页大小；UI 可一次取回大页后本地分页。 */
  memoryPanelFactsPageDefault: 20,
  memoryPanelFactsPageMax: 500,
  /** 时间线默认/最大事件数与上游合并页参数。 */
  memoryPanelTimelineDaysDefault: 30,
  memoryPanelTimelineLimitDefault: 300,
  memoryPanelTimelineLimitMax: 500,
  memoryPanelTimelinePageMax: 200,
  memoryPanelTimelinePagesMax: 5,
  memoryPanelTimelineTextChars: 96,
  memoryPanelTimelineEntitiesMax: 3,
  memoryPanelTimelineEntityChars: 40,
  /** 时间线归一化结果 JSON 预算。 */
  memoryPanelTimelineBytes: 248 * 1024,
  /** 实体列表默认/最大页大小。 */
  memoryPanelEntitiesPageDefault: 50,
  memoryPanelEntitiesPageMax: 100,
  /** 搜索词字符上限。 */
  memoryPanelSearchMax: 120,
  /** 搜索输入防抖（毫秒）。 */
  memoryPanelSearchDebounceMs: 400,
  /** 事实列表每条展示的实体预览数。 */
  memoryPanelFactEntitiesShown: 3,
  /** 记忆图节点文本 / label 字符上限。 */
  memoryPanelGraphTextChars: 600,
  memoryPanelGraphLabelChars: 80,
  /**
   * 字节预算裁剪时的节点正文下限（字符）。
   *
   * 长文本节点先截到该下限，把预算留给边；只有边已到下限仍超预算才继续压正文。
   */
  memoryPanelGraphTextFloorChars: 140,
  /**
   * 字节预算裁剪时至少保留的边数（min(现有边数, 该值)）。
   *
   * 星座视图依赖边；即使长文本把图核心撑爆，也不能先把边裁光。
   */
  memoryPanelGraphEdgesMin: 120,
  /** 事实列表正文截断字符数。 */
  memoryPanelFactsTextChars: 1_200,
  /** 记忆详情正文 UTF-8 字节上限。 */
  memoryPanelDetailTextBytes: 32 * 1024,
  /**
   * 记忆图核心（nodes/edges，含 base）JSON 字节预算。
   *
   * include_rows 时先按此预算保证星座图可用，再按下面的总预算附加/裁剪行。
   */
  memoryPanelGraphCoreBytes: 200 * 1024,
  /** graph.include_rows 表格行默认/最大条数与正文截断字符数。 */
  memoryPanelRowsDefault: 200,
  memoryPanelRowsMax: 500,
  memoryPanelRowsTextCharsDefault: 400,
  memoryPanelRowsTextCharsMax: 1_200,
  /**
   * `network_agent_memory_graph` 单一总预算：完整结果（base、nodes/edges、
   * table_rows、timeline 及其它字段）序列化 JSON 的 UTF-8 字节上限。
   *
   * 必须小于 `toolResponseBytes`（256 KiB）；240 KiB 为 MCP 的 content /
   * structuredContent 字段包装留出余量。超限时先按最旧行成块裁剪 table_rows
   * （置 rows_truncated=true 并重建 timeline），行裁空后才兜底裁剪边/节点。
   */
  memoryPanelGraphResponseBytes: 240 * 1024,
  /** 时间过滤允许的最大跨度（天）。 */
  memoryPanelDateSpanDays: 366,
  /** 列表 offset 上限，避免深分页放大上游压力。 */
  memoryPanelOffsetMax: 5_000,
} as const;

export function clampPage(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}
