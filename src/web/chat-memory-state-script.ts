/**
 * Memory 面板的常量、DOM 引用与运行状态。
 *
 * 与 `chat-memory-script.ts` 拼进同一个应用页脚本共享作用域；拆分只为
 * 控制单文件行数，不改变工具契约或页面行为。
 */
export const CHAT_MEMORY_STATE_SCRIPT = `
const MEMORY_HOST_LABELS = {
  tool_only: '仅工具调用',
  api_tool_only: '仅工具调用',
  adapted_host: '已适配宿主',
  controlled_gateway: '受控网关'
};
const MEMORY_RECALL_MODE_LABELS = {
  bootstrap: '引导召回',
  related: '关联召回',
  task: '任务召回',
  lookup: '显式查询',
  reflect: '综合分析'
};
const MEMORY_RECALL_STATUS_LABELS = {
  ready: '已返回',
  empty: '本次无候选',
  pending: '准备中',
  unavailable: '暂不可用',
  unsupported: '当前不支持',
  disabled: '未启用',
  skipped_no_boundary: '未赶上运行边界'
};
const MEMORY_REPRESENTATION_LABELS = {
  raw_full: '原文',
  raw_fragment: '原文片段',
  preview: '预览',
  summary: '摘要',
  memory_context: '记忆包',
  authored: '自身发布'
};
const MEMORY_ORIGIN_LABELS = {
  experienced: '输入经历',
  authored: '自身发布',
  curated: '人工记忆'
};
const MEMORY_EVIDENCE_LABELS = {
  host_reported_submitted: '宿主报告已提交',
  gateway_observed_submitted: '网关观察已提交',
  served: '已交付'
};
const MEMORY_CAPTURE_LABELS = {
  none: '未采集',
  pending: '提炼待处理',
  extracted: '已提炼',
  excluded: '已排除'
};
const MEMORY_SOURCE_KIND_LABELS = {
  message: '消息',
  task_offer: '任务卡',
  task_detail: '任务详情',
  task_attachment: '任务附件',
  task_submission: '任务提交',
  task_review: '任务验收',
  task_handoff: '交接材料',
  file: '文件',
  manual: '人工来源'
};
const MEMORY_SOURCE_STATE_LABELS = {
  active: '有效',
  superseded: '已被新修订替代',
  retracted: '已排除'
};
const MEMORY_VALIDITY_LABELS = {
  active: '当前有效',
  expired: '已过期',
  revoked: '已撤回',
  superseded: '已替代',
  excluded: '已排除'
};
const MEMORY_COVERAGE_LABELS = {
  bounded: '有界结果',
  exhaustive: '完整结果',
  unknown: '覆盖未知'
};
const MEMORY_AVAILABILITY_LABELS = {
  ready: '就绪',
  pending: '处理中',
  unavailable: '暂不可用',
  unsupported: '当前不支持',
  disabled: '未启用'
};
const MEMORY_STAGE_LABELS = {
  accepted: '已受理',
  source_applied: '来源已生效',
  derived_ready: '派生就绪',
  unknown: '无法确认'
};
const MEMORY_PURGE_LABELS = {
  purged: '已确认清除',
  purge_pending: '清除处理中',
  unknown: '清除状态未知',
  unsupported_granularity: '无法精确定位'
};
const MEMORY_ACTION_LABELS = {
  forget: '遗忘/移除',
  put: '保存人工记忆',
  correct: '修订人工记忆',
  retain: '提炼记忆',
  recall: '召回',
  remove: '清除',
  ensure_space: '建立空间',
  rebuild: '重建'
};
const MEMORY_SUPPORTED_LABELS = {
  explicit_lookup: '显式查询',
  lookup_context: 'lookup 上下文',
  context_read: '上下文读取',
  source_list_get: '来源列表/详情',
  curated_put_correct: '人工记忆保存/修订',
  forget_source_curated_experience: '遗忘来源/人工/经历',
  experience_list_get: '经历列表/详情',
  catchup_plan: '补读计划',
  host_bind_close: '宿主绑定/关闭',
  run_binding: '运行绑定',
  input_prepare: '输入准备',
  context_delivery_receipt: '记忆包交付回执',
  submitted_input_manifest: '最终输入清单',
  input_exposure_receipt: '源输入消费回执',
  gateway_observation: '网关观察',
  native_reflect: '原生综合分析',
  native_export: '原生导出',
  hard_time_filter: '硬时间过滤'
};
const MEMORY_UNSUPPORTED_LABELS = {
  native_reflect: '原生综合分析',
  native_export: '原生导出',
  hard_time_filter: '硬时间过滤',
  engine_recall: '引擎召回',
  task_target: '任务目标',
  auto_injection: '自动注入',
  curated_backend_retain: '人工记忆后端保留',
  all: '全部能力'
};
const MEMORY_REASON_LABELS = {
  lookup_only: 'lookup 包只作查询结果，没有注入许可',
  not_ready: '还没有可注入的上下文',
  auto_pending_claim: '自动召回仍等待 claim 后的宿主边界',
  context_not_found: '上下文不存在或不属于当前空间',
  context_missing: '上下文已不存在',
  context_invalidated: '上下文已失效',
  context_expired: '上下文已过期',
  context_not_active: '上下文当前不可注入',
  expired: '已过期',
  revoked: '已撤回',
  superseded: '已被新版本替代',
  excluded: '已被治理排除',
  tombstoned: '已被遗忘',
  not_found: '未找到',
  permission_denied: '当前无权读取',
  ownership_changed: '归属或空间代次已变化',
  content_reader_required: '只有 Agent 自身可读取正文',
  source_not_active: '来源已排除或不可用',
  source_missing: '来源不存在',
  memory_disabled: '部署未启用 Memory',
  engine_unavailable: '记忆引擎暂不可用',
  engine_unsupported: '记忆引擎不支持检索',
  agent_credential_required: '需要 Agent 自身凭据',
  credential_revoked: '凭据已撤销'
};

const memoryDrawerElement = document.getElementById('memory-drawer');
const memoryOpenButton = document.getElementById('memory-open');
const memoryCloseButton = document.getElementById('memory-close');
const memoryRefreshButton = document.getElementById('memory-refresh');
const memorySubtitleElement = document.getElementById('memory-subtitle');
const memoryStatusElement = document.getElementById('memory-status');
const memoryBodyElement = document.getElementById('memory-body');
const memoryCapabilityElement = document.getElementById('memory-capability');
const memoryTabsElement = document.getElementById('memory-tabs');
const memoryPanelsElement = document.getElementById('memory-panels');
const memoryRecallForm = document.getElementById('memory-recall-form');
const memoryRecallMode = document.getElementById('memory-recall-mode');
const memoryRecallQuery = document.getElementById('memory-recall-query');
const memoryRecallEvidence = document.getElementById('memory-recall-evidence');
const memoryRecallStatus = document.getElementById('memory-recall-status');
const memoryRecallResult = document.getElementById('memory-recall-result');
const memoryContextKind = document.getElementById('memory-context-kind');
const memoryContextRefresh = document.getElementById('memory-context-refresh');
const memoryContextStatus = document.getElementById('memory-context-status');
const memoryContextList = document.getElementById('memory-context-list');
const memoryContextMore = document.getElementById('memory-context-more');
const memoryContextDetail = document.getElementById('memory-context-detail');
const memoryExperienceRoom = document.getElementById('memory-experience-room');
const memoryExperienceRefresh = document.getElementById('memory-experience-refresh');
const memoryExperienceStatus = document.getElementById('memory-experience-status');
const memoryExperienceList = document.getElementById('memory-experience-list');
const memoryExperienceMore = document.getElementById('memory-experience-more');
const memoryExperienceDetail = document.getElementById('memory-experience-detail');

let memoryMe = null;
let memoryStatus = null;
let memoryActiveTab = 'recall';
let memoryStatusEpoch = 0;
let memoryRecallEpoch = 0;
let memoryContextEpoch = 0;
let memoryContextDetailEpoch = 0;
let memoryExperienceEpoch = 0;
let memoryExperienceDetailEpoch = 0;
let memoryContextLoaded = false;
let memoryExperienceLoaded = false;
let memoryContextCursor = null;
let memoryContextHasMore = false;
let memoryExperienceCursor = null;
let memoryExperienceHasMore = false;
let memoryRecallContextRef = null;
let memoryContextSelectedId = null;
let memoryExperienceSelectedId = null;
`;
