/**
 * Memory 面板：宿主/输入与治理。
 *
 * 宿主绑定由宿主 MCP 会话创建；页面只展示服务端等级、manifest 状态与
 * 治理操作。遗忘先本地排除，后端清除无法确认时保持 unknown，界面不会
 * 提前显示“已清除”。
 */
export const CHAT_MEMORY_GOVERNANCE_SCRIPT = `
const MEMORY_INPUT_STATUS_LABELS = {
  prepared: '已准备（尚未提交）',
  host_queued: '宿主已排队（不是证据）',
  host_reported_submitted: '宿主报告已提交（外部自报）',
  gateway_observed_submitted: '网关观察已提交（系统核验）',
  unknown: '状态未知'
};
const MEMORY_GOVERNANCE_ORIGIN_LABELS = {
  manual: '人工保存',
  imported_external_knowledge: '外部知识导入'
};

const memoryHostInfo = document.getElementById('memory-host-info');
const memoryManifestForm = document.getElementById('memory-manifest-form');
const memoryManifestId = document.getElementById('memory-manifest-id');
const memoryManifestStatus = document.getElementById('memory-manifest-status');
const memoryManifestResult = document.getElementById('memory-manifest-result');
const memoryGovernanceStatus = document.getElementById('memory-governance-status');
const memoryGovernanceRefresh = document.getElementById('memory-governance-refresh');
const memoryGovernanceConfirm = document.getElementById('memory-governance-confirm');
const memoryCuratedList = document.getElementById('memory-curated-list');
const memorySourceList = document.getElementById('memory-source-list');
const memorySourceMore = document.getElementById('memory-source-more');
const memoryOperation = document.getElementById('memory-operation');

let memoryGovernanceLoaded = false;
let memoryGovernanceEpoch = 0;
let memorySourceEpoch = 0;
let memorySourceCursor = null;
let memorySourceHasMore = false;
let memoryManifestEpoch = 0;
let memoryPendingForget = null;

function memoryInvalidateGovernance() {
  memoryGovernanceEpoch += 1;
  memorySourceEpoch += 1;
  memoryManifestEpoch += 1;
}

function memoryResetGovernanceView() {
  memoryInvalidateGovernance();
  memoryGovernanceLoaded = false;
  memorySourceCursor = null;
  memorySourceHasMore = false;
  memoryPendingForget = null;
  if (memoryHostInfo) memoryHostInfo.replaceChildren();
  if (memoryManifestForm) memoryManifestForm.reset();
  if (memoryManifestStatus) memorySetStatus(memoryManifestStatus, '', '');
  if (memoryManifestResult) memoryManifestResult.replaceChildren();
  if (memoryGovernanceStatus) memorySetStatus(memoryGovernanceStatus, '', '');
  if (memoryGovernanceConfirm) memoryGovernanceConfirm.replaceChildren();
  if (memoryCuratedList) memoryCuratedList.replaceChildren();
  if (memorySourceList) memorySourceList.replaceChildren();
  if (memorySourceMore) memorySourceMore.hidden = true;
  if (memoryOperation) {
    memoryOperation.hidden = true;
    memoryOperation.replaceChildren();
  }
}

function memoryExcerpt(value, max) {
  const text = String(value === null || value === undefined ? '' : value).replace(/\\s+/gu, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function memoryRenderHost() {
  if (!memoryHostInfo) return;
  memoryHostInfo.replaceChildren();
  if (!memoryAgentReady()) {
    memoryHostInfo.append(memoryErrorCard(
      'Memory 状态未就绪',
      '宿主与输入流程只在该 Agent 的 Memory 启用且当前空间可读时展示。'
    ));
    return;
  }
  const card = memoryCreate('div', 'memory-capability');
  const head = memoryCreate('div', 'memory-capability-head');
  head.append(memoryCreate('h3', '', '宿主与输入'));
  head.append(memoryChip(memoryLabel(MEMORY_HOST_LABELS, memoryStatus.host_level, '等级未知'), 'info'));
  head.append(memoryChip(memoryStatus.capture ? '采集开启' : '采集关闭',
    memoryStatus.capture ? 'good' : 'warn'));
  card.append(head);
  if (Array.isArray(memoryStatus.supported_host_modes)) {
    memoryAppendChipRow(card, '可能的接入等级', memoryStatus.supported_host_modes, MEMORY_HOST_LABELS, 'info');
  }
  const steps = memoryCreate('ol', 'memory-steps');
  const lines = [
    '宿主调用 network_memory_host_bind 获取服务端签发的 binding/generation；客户端声明的能力只用于协商，不能自报 trusted 或提高等级。',
    'claim 之后用 network_memory_input_prepare 把服务端签发的 selection 绑定到准确 run/input；prepared 只表示可供输入，不产生经历。',
    '宿主按实际发送给模型的最终 payload 重建 SubmittedInputManifest，不能用准备清单或裁剪前模板冒充最终清单。',
    'network_memory_input_status 只展示 prepared、宿主排队、宿主报告与网关观察；排队和受理都不是模型已提交的证据。',
    'network_memory_admit 的 input_exposure 回执被服务端采纳后才产生个人经历；context_delivery 只证明记忆包交付，不能推出原消息已消费。'
  ];
  for (const line of lines) steps.append(memoryCreate('li', '', line));
  card.append(steps);
  if (Array.isArray(memoryStatus.unsupported) && memoryStatus.unsupported.indexOf('auto_injection') >= 0) {
    card.append(memoryCreate('p', 'memory-note',
      '当前明确不支持自动注入：本面板不会把预热、召回或宿主排队显示为已注入。'));
  }
  memoryHostInfo.append(card);
}

function memoryLookupManifest(event) {
  if (event) event.preventDefault();
  if (!memoryAgentReady()) {
    memorySetStatus(memoryManifestStatus, 'Memory 内容工具只对 Agent 自身凭据开放。', 'error');
    return;
  }
  const manifestId = memoryManifestId ? memoryManifestId.value.trim() : '';
  if (!manifestId) {
    memorySetStatus(memoryManifestStatus, '请输入 manifest_id。', 'error');
    if (memoryManifestId) memoryManifestId.focus();
    return;
  }
  const captured = ++memoryManifestEpoch;
  memorySetStatus(memoryManifestStatus, '正在读取清单状态…', '');
  if (memoryManifestResult) memoryManifestResult.replaceChildren();
  callTool('network_memory_input_status', { manifest_id: manifestId }).then(function (result) {
    if (!memoryCurrent(memoryManifestEpoch, captured)) return;
    memorySetStatus(memoryManifestStatus, '', '');
    memoryRenderManifest(result);
  }).catch(function (error) {
    if (!memoryCurrent(memoryManifestEpoch, captured)) return;
    const info = memoryErrorInfo(error);
    memorySetStatus(memoryManifestStatus, info.title + '：' + info.detail, 'error');
    if (memoryManifestResult) {
      memoryManifestResult.replaceChildren(memoryErrorCard(info.title, info.detail, 'is-danger'));
    }
  });
}

function memoryRenderManifest(result) {
  if (!memoryManifestResult) return;
  memoryManifestResult.replaceChildren();
  const card = memoryCreate('div', 'memory-detail');
  const head = memoryCreate('div', 'memory-detail-head');
  head.append(memoryCreate('h3', '', '提交清单状态'));
  head.append(memoryChip(memoryLabel(MEMORY_INPUT_STATUS_LABELS, result.status, result.status),
    result.status === 'gateway_observed_submitted' ? 'good'
      : result.status === 'host_reported_submitted' ? 'info'
        : result.status === 'host_queued' || result.status === 'prepared' ? 'warn' : 'danger'));
  card.append(head);
  const dl = memoryCreate('dl');
  function add(term, value) {
    dl.append(memoryCreate('dt', '', term));
    dl.append(memoryCreate('dd', '', value));
  }
  add('清单', result.manifest_id || '');
  add('提交证据', result.submitted_evidence
    ? memoryLabel(MEMORY_EVIDENCE_LABELS, result.submitted_evidence, result.submitted_evidence)
    : '无');
  add('可提炼资格', result.retain_eligible ? '是（已有合格回执）' : '否');
  if (Array.isArray(result.retain_ids) && result.retain_ids.length > 0) {
    add('提炼意图', result.retain_ids.length + ' 条');
  }
  if (result.receipt_disposition) {
    add('回执处置', String(result.receipt_disposition) +
      (result.receipt_reason ? '（' + memoryLabel(MEMORY_REASON_LABELS, result.receipt_reason, result.receipt_reason) + '）' : ''));
  }
  add('清单 hash', memoryShortHash(result.manifest_sha256));
  add('payload hash', memoryShortHash(result.payload_sha256));
  add('创建时间', memoryTime(result.created_at));
  card.append(dl);
  card.append(memoryCreate('p', 'memory-note',
    'prepared 与宿主排队不是提交证据；retain_eligible 只由服务端采纳合格 input_exposure 回执后更新。'));
  memoryManifestResult.append(card);
}

function memoryRenderCuratedItem(item) {
  const row = memoryCreate('div', 'memory-row memory-row-static');
  const top = memoryCreate('div', 'memory-row-top');
  top.append(memoryCreate('span', 'memory-row-title', item.title || '未命名人工记忆'));
  top.append(memoryChip('修订 ' + String(item.revision), 'info'));
  row.append(top);
  const meta = [];
  meta.push(memoryLabel(MEMORY_GOVERNANCE_ORIGIN_LABELS, item.origin, item.origin || '人工保存'));
  meta.push('更新 ' + memoryTime(item.updated_at));
  row.append(memoryCreate('p', 'memory-row-meta', meta.join(' · ')));
  if (item.content) row.append(memoryCreate('p', 'memory-row-preview', memoryExcerpt(item.content, 160)));
  const actions = memoryCreate('div', 'memory-row-actions');
  const forget = memoryCreate('button', 'memory-action danger', '遗忘/移除');
  forget.type = 'button';
  forget.setAttribute('data-memory-forget-kind', 'curated');
  forget.setAttribute('data-memory-forget-id', item.curated_id);
  forget.setAttribute('data-memory-forget-revision', String(item.revision));
  forget.setAttribute('data-memory-forget-label', item.title || '人工记忆');
  forget.addEventListener('click', function () {
    memoryAskForget('curated', item.curated_id, item.revision, item.title || '人工记忆');
  });
  actions.append(forget);
  row.append(actions);
  return row;
}

function memoryRenderSourceItem(item) {
  const row = memoryCreate('div', 'memory-row memory-row-static');
  const top = memoryCreate('div', 'memory-row-top');
  top.append(memoryCreate('span', 'memory-row-title',
    '来源 · ' + memoryLabel(MEMORY_SOURCE_KIND_LABELS, item.source_kind, item.source_kind)));
  top.append(memoryChip('修订 ' + String(item.revision), 'info'));
  top.append(memoryChip(memoryLabel(MEMORY_SOURCE_STATE_LABELS, item.state, item.state),
    item.state === 'active' ? 'good' : 'warn'));
  if (item.available !== true) top.append(memoryChip('当前不可读', 'danger'));
  row.append(top);
  const meta = [];
  meta.push(memoryRoomName(item.origin_room_id));
  meta.push('创建 ' + memoryTime(item.created_at));
  if (item.content_bytes !== null && item.content_bytes !== undefined) {
    meta.push(memoryBytes(item.content_bytes));
  }
  row.append(memoryCreate('p', 'memory-row-meta', meta.join(' · ')));
  if (item.available === true) {
    const actions = memoryCreate('div', 'memory-row-actions');
    const forget = memoryCreate('button', 'memory-action danger', '遗忘/移除来源');
    forget.type = 'button';
    forget.setAttribute('data-memory-forget-kind', 'source');
    forget.setAttribute('data-memory-forget-id', item.source_id);
    forget.setAttribute('data-memory-forget-revision', String(item.revision));
    forget.setAttribute('data-memory-forget-label',
      memoryLabel(MEMORY_SOURCE_KIND_LABELS, item.source_kind, item.source_kind));
    forget.addEventListener('click', function () {
      memoryAskForget('source', item.source_id, item.revision,
        memoryLabel(MEMORY_SOURCE_KIND_LABELS, item.source_kind, item.source_kind));
    });
    actions.append(forget);
    row.append(actions);
  }
  return row;
}

function memoryAskForget(kind, id, revision, label) {
  memoryPendingForget = { kind: kind, id: id, revision: Number(revision), label: label };
  if (!memoryGovernanceConfirm) return;
  memoryGovernanceConfirm.replaceChildren();
  const box = memoryCreate('div', 'memory-confirm');
  box.append(memoryCreate('p', '', '确认遗忘「' + label + '」？遗忘会先在本地记忆排除，再异步清理后端；' +
    '无法确认后端副本清除时会保持“清除状态未知”。原始聊天、已发送内容与已经交付给模型的内容不会因此自动撤回。'));
  const actions = memoryCreate('div', 'memory-confirm-actions');
  const cancel = memoryCreate('button', 'memory-action', '取消');
  cancel.type = 'button';
  cancel.id = 'memory-confirm-cancel';
  cancel.addEventListener('click', memoryClearForgetConfirm);
  const apply = memoryCreate('button', 'memory-action danger', '确认遗忘');
  apply.type = 'button';
  apply.id = 'memory-confirm-apply';
  apply.addEventListener('click', memoryConfirmForget);
  actions.append(cancel, apply);
  box.append(actions);
  memoryGovernanceConfirm.append(box);
  cancel.focus();
}

function memoryClearForgetConfirm() {
  memoryPendingForget = null;
  if (memoryGovernanceConfirm) memoryGovernanceConfirm.replaceChildren();
}

function memoryConfirmForget() {
  const pending = memoryPendingForget;
  if (!pending) return;
  const apply = document.getElementById('memory-confirm-apply');
  if (apply) apply.disabled = true;
  memorySetStatus(memoryGovernanceStatus, '正在提交遗忘请求…', '');
  const target = pending.kind === 'curated'
    ? { kind: 'curated', curated_id: pending.id, revision: pending.revision }
    : { kind: 'source', source_id: pending.id, source_revision: pending.revision };
  callTool('network_memory_forget', {
    request_id: requestId('mem_forget'),
    target: target
  }).then(function (result) {
    memoryClearForgetConfirm();
    memorySetStatus(memoryGovernanceStatus, '遗忘请求已提交；后端清除状态仍需单独确认。', 'ok');
    memoryRenderOperationFromForget(result);
    if (result && result.operation_id) {
      callTool('network_memory_operation_get', { operation_id: result.operation_id }).then(function (view) {
        memoryRenderOperationFromGet(view, result);
      }).catch(function () {
        memoryRenderOperationFromForget(result);
      });
    }
    memoryLoadGovernance();
  }).catch(function (error) {
    const info = memoryErrorInfo(error);
    memorySetStatus(memoryGovernanceStatus, info.title + '：' + info.detail, 'error');
    if (apply) apply.disabled = false;
  });
}

function memoryRenderOperationFromForget(result) {
  if (!memoryOperation) return;
  memoryOperation.hidden = false;
  memoryOperation.replaceChildren();
  memoryOperation.append(memoryCreate('h3', '', '治理操作状态'));
  const dl = memoryCreate('dl');
  const add = function (term, value) {
    dl.append(memoryCreate('dt', '', term));
    dl.append(memoryCreate('dd', '', value));
  };
  add('状态', memoryLabel(MEMORY_AVAILABILITY_LABELS, result.status, result.status || '未知'));
  add('清除状态', memoryLabel(MEMORY_PURGE_LABELS, result.purge, '清除状态未知'));
  if (result.operation_id) add('作业', result.operation_id);
  memoryOperation.append(dl);
  memoryOperation.append(memoryCreate('p', 'memory-note',
    '“清除状态未知”表示尚未确认所有后端副本已清除；界面不会提前显示已清理。'));
}

function memoryRenderOperationFromGet(view, fallback) {
  if (!memoryOperation) return;
  const operation = view && view.operation ? view.operation : null;
  if (!operation) {
    if (fallback) memoryRenderOperationFromForget(fallback);
    else {
      memoryOperation.hidden = false;
      memoryOperation.replaceChildren(memoryErrorCard(
        '未找到作业状态',
        '本地排除可能已经生效，但无法读取后端作业阶段。不会据此重跑或声称已清除。'
      ));
    }
    return;
  }
  memoryOperation.hidden = false;
  memoryOperation.replaceChildren();
  memoryOperation.append(memoryCreate('h3', '', '治理操作状态'));
  const dl = memoryCreate('dl');
  const add = function (term, value) {
    dl.append(memoryCreate('dt', '', term));
    dl.append(memoryCreate('dd', '', value));
  };
  add('操作', memoryLabel(MEMORY_ACTION_LABELS, operation.action, operation.action));
  add('阶段', memoryLabel(MEMORY_STAGE_LABELS, operation.stage, operation.stage));
  add('可用性', memoryLabel(MEMORY_AVAILABILITY_LABELS, operation.availability, operation.availability));
  const purge = operation.purge ||
    (fallback && fallback.purge ? fallback.purge : null) ||
    (operation.action === 'forget' || operation.action === 'remove' ? 'unknown' : null);
  add('清除状态', purge
    ? memoryLabel(MEMORY_PURGE_LABELS, purge, purge)
    : '不适用');
  add('可重试', operation.retryable ? '是' : '否');
  if (operation.error) add('错误', memoryLabel(MEMORY_REASON_LABELS, operation.error, operation.error));
  if (operation.operation_id) add('作业', operation.operation_id);
  memoryOperation.append(dl);
  memoryOperation.append(memoryCreate('p', 'memory-note',
    purge === 'unknown' || purge === 'purge_pending'
      ? '清除状态尚未确认；未知不会自动重跑，也不会被显示为已清除。'
      : '阶段分别表示受理、来源生效与派生就绪，不能用单个完成号代替。'));
  if (operation.operation_id) {
    const refresh = memoryCreate('button', 'memory-action', '刷新作业状态');
    refresh.type = 'button';
    refresh.addEventListener('click', function () {
      callTool('network_memory_operation_get', { operation_id: operation.operation_id }).then(function (latest) {
        memoryRenderOperationFromGet(latest, fallback || null);
      }).catch(function (error) {
        const info = memoryErrorInfo(error);
        memorySetStatus(memoryGovernanceStatus, info.title + '：' + info.detail, 'error');
      });
    });
    memoryOperation.append(refresh);
  }
}

async function memoryLoadGovernance() {
  if (!memoryAgentReady()) return;
  memoryGovernanceLoaded = true;
  const captured = ++memoryGovernanceEpoch;
  memorySetStatus(memoryGovernanceStatus, '正在读取人工记忆与来源…', '');
  let failed = false;
  if (memoryCuratedList) {
    try {
      const page = await callTool('network_memory_list', { object_kind: 'curated', limit: MEMORY_WEB_CURATED_LIMIT });
      if (!memoryCurrent(memoryGovernanceEpoch, captured)) return;
      memoryCuratedList.replaceChildren();
      const items = page && Array.isArray(page.items) ? page.items : [];
      for (const item of items) memoryAppendListRow(memoryCuratedList, memoryRenderCuratedItem(item));
      if (items.length === 0) {
        memoryCuratedList.append(memoryEmpty('还没有人工保存的记忆。人工保存不等于读过群消息，也不升级证据等级。'));
      }
    } catch (error) {
      if (!memoryCurrent(memoryGovernanceEpoch, captured)) return;
      failed = true;
      const info = memoryErrorInfo(error);
      memoryCuratedList.replaceChildren(memoryErrorCard(info.title, info.detail, 'is-danger'));
    }
  }
  if (!memoryCurrent(memoryGovernanceEpoch, captured)) return;
  memorySourceCursor = null;
  memorySourceHasMore = false;
  await memoryLoadSources(true, captured);
  if (!memoryCurrent(memoryGovernanceEpoch, captured)) return;
  memorySetStatus(memoryGovernanceStatus,
    failed ? '部分治理数据读取失败，可重试。' : '', failed ? 'error' : '');
}

function memoryLoadSources(reset, governanceCaptured) {
  if (!memoryAgentReady() || !memorySourceList) return Promise.resolve();
  if (reset) {
    memorySourceCursor = null;
    memorySourceHasMore = false;
    memorySourceList.replaceChildren();
  }
  const captured = ++memorySourceEpoch;
  const args = { object_kind: 'source', limit: MEMORY_WEB_PAGE_SIZE };
  if (!reset && memorySourceCursor) args.cursor = memorySourceCursor;
  return callTool('network_memory_list', args).then(function (page) {
    if (governanceCaptured !== undefined &&
        !memoryCurrent(memoryGovernanceEpoch, governanceCaptured)) return;
    if (!memoryCurrent(memorySourceEpoch, captured)) return;
    const items = page && Array.isArray(page.items) ? page.items : [];
    for (const item of items) memoryAppendListRow(memorySourceList, memoryRenderSourceItem(item));
    memorySourceCursor = page ? page.next_cursor : null;
    memorySourceHasMore = Boolean(page && page.has_more && page.next_cursor);
    if (memorySourceMore) memorySourceMore.hidden = !memorySourceHasMore;
    if (reset && items.length === 0) {
      memorySourceList.append(memoryEmpty(
        '还没有该 Agent 实际获得过的来源。普通聊天消息不会因为出现在房间里就自动成为个人记忆来源。'
      ));
    }
  }).catch(function (error) {
    if (governanceCaptured !== undefined &&
        !memoryCurrent(memoryGovernanceEpoch, governanceCaptured)) return;
    if (!memoryCurrent(memorySourceEpoch, captured)) return;
    const info = memoryErrorInfo(error);
    memorySourceList.replaceChildren(memoryErrorCard(info.title, info.detail, 'is-danger'));
  });
}

if (memoryManifestForm) memoryManifestForm.addEventListener('submit', memoryLookupManifest);
if (memoryGovernanceRefresh) {
  memoryGovernanceRefresh.addEventListener('click', function () { memoryLoadGovernance(); });
}
if (memorySourceMore) {
  memorySourceMore.addEventListener('click', function () { memoryLoadSources(false); });
}
if (memoryGovernanceConfirm) {
  memoryGovernanceConfirm.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && memoryPendingForget) {
      event.stopPropagation();
      memoryClearForgetConfirm();
    }
  });
}
`;
