/**
 * Memory 面板：状态、召回、上下文与经历。
 *
 * 仅使用 `network_me` 与既有 `network_memory_*` 工具，不新增 REST 身份
 * 或 localStorage 正文缓存。人类身份只展示部署能力目录；Agent 内容工具
 * 仍由服务端按当前凭据、空间代次与来源授权重验。
 */
export const CHAT_MEMORY_SCRIPT = `

function memoryCreate(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function memoryLabel(map, value, fallback) {
  if (value === null || value === undefined || value === '') return fallback || '未知';
  return map[value] || String(value);
}

function memoryChip(label, tone) {
  const chip = memoryCreate('span', 'memory-chip' + (tone ? ' ' + tone : ''), label);
  return chip;
}

function memoryTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '时间未知';
  try {
    return new Date(number).toLocaleString('zh-CN', {
      hour12: false, month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (error) {
    return '时间未知';
  }
}

function memoryBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '';
  if (number < 1024) return number + ' B';
  if (number < 1024 * 1024) return (number / 1024).toFixed(1) + ' KB';
  return (number / (1024 * 1024)).toFixed(1) + ' MB';
}

function memoryShortHash(value) {
  if (!value) return '';
  return String(value).slice(0, 12) + '…';
}

function memoryRoomName(roomId) {
  if (!roomId) return '未绑定房间';
  for (const entry of roomEntries) {
    if (entry.room_id !== roomId) continue;
    if (entry.kind === 'group') return entry.title || '群聊';
    if (entry.name) return entry.name;
  }
  if (room && room.room_id === roomId) {
    if (room.kind === 'group') return room.title || '群聊';
    return room.title || '会话';
  }
  return '房间 ' + String(roomId).slice(-6);
}

function memoryErrorInfo(error) {
  const code = error && error.code ? String(error.code) : '';
  const message = error && error.message ? String(error.message) : '请求失败';
  const titles = {
    CREDENTIAL_INVALID: '凭据已失效',
    MEMORY_DISABLED: 'Memory 未启用',
    MEMORY_UNAVAILABLE: 'Memory 暂不可用',
    MEMORY_NOT_READY: 'Memory 尚未就绪',
    MEMORY_UNSUPPORTED: '当前不支持',
    MEMORY_UNSUPPORTED_GRANULARITY: '无法精确定位目标',
    MEMORY_TARGET_INVALID: '目标已失效',
    MEMORY_EVIDENCE_INSUFFICIENT: '证据不足',
    PERMISSION_DENIED: '无权读取',
    NOT_FOUND: '未找到',
    VERSION_CONFLICT: '版本已变化'
  };
  return {
    code: code,
    title: titles[code] || '操作失败',
    detail: message
  };
}

function memorySetStatus(element, text, tone) {
  if (!element) return;
  element.textContent = text || '';
  element.classList.toggle('is-error', tone === 'error');
  element.classList.toggle('is-ok', tone === 'ok');
}

function memoryErrorCard(title, detail, tone) {
  const card = memoryCreate('div', 'memory-error-card' + (tone ? ' ' + tone : ''));
  card.append(memoryCreate('strong', '', title));
  if (detail) card.append(memoryCreate('p', '', detail));
  return card;
}

function memoryEmpty(text) {
  return memoryCreate('p', 'memory-empty', text);
}

function memoryCurrent(counter, captured) {
  return Boolean(memoryDrawerElement && memoryDrawerElement.open && counter === captured);
}

function memoryInvalidateAll() {
  memoryStatusEpoch += 1;
  memoryRecallEpoch += 1;
  memoryContextEpoch += 1;
  memoryContextDetailEpoch += 1;
  memoryExperienceEpoch += 1;
  memoryExperienceDetailEpoch += 1;
  if (typeof memoryInvalidateGovernance === 'function') memoryInvalidateGovernance();
}

function memoryUpdateSubtitle(me) {
  if (!memorySubtitleElement) return;
  if (!me) {
    memorySubtitleElement.textContent = '正在读取身份…';
    return;
  }
  const kind = me.kind === 'agent' ? 'Agent' : me.kind === 'human' ? '人类' : '身份';
  memorySubtitleElement.textContent =
    kind + ' · ' + (me.name || '未命名') + ' · 仅按当前身份授权';
}

function memoryUpdateTabButtons() {
  if (!memoryTabsElement) return;
  const buttons = memoryTabsElement.querySelectorAll('[data-memory-tab]');
  for (const button of buttons) {
    button.setAttribute('aria-pressed', button.getAttribute('data-memory-tab') === memoryActiveTab ? 'true' : 'false');
  }
  if (!memoryPanelsElement) return;
  const panels = memoryPanelsElement.querySelectorAll('[data-memory-panel]');
  for (const panel of panels) {
    panel.hidden = panel.getAttribute('data-memory-panel') !== memoryActiveTab;
  }
}

function memoryShowTabs(show) {
  if (memoryTabsElement) memoryTabsElement.hidden = !show;
  if (memoryPanelsElement) memoryPanelsElement.hidden = !show;
  if (show) memoryUpdateTabButtons();
}

function memoryResetView() {
  memoryInvalidateAll();
  memoryMe = null;
  memoryStatus = null;
  memoryActiveTab = 'recall';
  memoryContextLoaded = false;
  memoryExperienceLoaded = false;
  memoryContextCursor = null;
  memoryContextHasMore = false;
  memoryExperienceCursor = null;
  memoryExperienceHasMore = false;
  memoryRecallContextRef = null;
  memoryContextSelectedId = null;
  memoryExperienceSelectedId = null;
  if (memoryCapabilityElement) memoryCapabilityElement.replaceChildren();
  if (memoryRecallQuery) memoryRecallQuery.value = '';
  if (memoryRecallStatus) memorySetStatus(memoryRecallStatus, '', '');
  if (memoryRecallResult) memoryRecallResult.replaceChildren();
  if (memoryContextStatus) memorySetStatus(memoryContextStatus, '', '');
  if (memoryContextList) memoryContextList.replaceChildren();
  if (memoryContextMore) memoryContextMore.hidden = true;
  if (memoryContextDetail) {
    memoryContextDetail.hidden = true;
    memoryContextDetail.replaceChildren();
  }
  if (memoryExperienceStatus) memorySetStatus(memoryExperienceStatus, '', '');
  if (memoryExperienceList) memoryExperienceList.replaceChildren();
  if (memoryExperienceMore) memoryExperienceMore.hidden = true;
  if (memoryExperienceDetail) {
    memoryExperienceDetail.hidden = true;
    memoryExperienceDetail.replaceChildren();
  }
  if (typeof memoryResetGovernanceView === 'function') memoryResetGovernanceView();
  memoryUpdateSubtitle(null);
  memorySetStatus(memoryStatusElement, '正在读取…', '');
  if (memoryBodyElement) memoryBodyElement.hidden = true;
  memoryShowTabs(false);
  memoryUpdateTabButtons();
}

function memoryAppendChipRow(root, label, values, mapper, tone) {
  if (!values || values.length === 0) return;
  const row = memoryCreate('div', 'memory-chip-row');
  row.append(memoryCreate('span', 'memory-detail-meta', label + '：'));
  for (const value of values) {
    row.append(memoryChip(memoryLabel(mapper || {}, value, String(value)), tone));
  }
  root.append(row);
}

function memoryAppendCatalogFacts(root, catalog, status) {
  if (!catalog) return;
  const facts = memoryCreate('div', 'memory-chip-row');
  const enabled = status ? status.enabled === true : catalog.enabled === true;
  facts.append(memoryChip('enabled=' + (enabled ? 'true' : 'false'), enabled ? 'good' : 'danger'));
  facts.append(memoryChip('capture=' + (status ? (status.capture ? 'true' : 'false') : (catalog.capture ? 'true' : 'false')),
    (status ? status.capture : catalog.capture) ? 'good' : 'warn'));
  if (catalog.contract_version) facts.append(memoryChip('契约 ' + catalog.contract_version, 'info'));
  if (catalog.engine_status) {
    const ready = catalog.engine_status === 'ready';
    facts.append(memoryChip('引擎=' + catalog.engine_status, ready ? 'good' : 'warn'));
  }
  root.append(facts);
  if (status && status.host_level) {
    const current = memoryCreate('div', 'memory-chip-row');
    current.append(memoryCreate('span', 'memory-detail-meta', '当前宿主等级：'));
    current.append(memoryChip(memoryLabel(MEMORY_HOST_LABELS, status.host_level, String(status.host_level)), 'info'));
    root.append(current);
  }
  memoryAppendChipRow(root, '可能的宿主等级', catalog.host_modes, MEMORY_HOST_LABELS, 'info');
  memoryAppendChipRow(root, '召回模式', catalog.recall_modes, MEMORY_RECALL_MODE_LABELS, 'info');
  memoryAppendChipRow(root, '支持能力', catalog.supported, MEMORY_SUPPORTED_LABELS, 'good');
  memoryAppendChipRow(root, '明确不支持', catalog.unsupported, MEMORY_UNSUPPORTED_LABELS, 'warn');
  if (status && status.counts) {
    const grid = memoryCreate('div', 'memory-stat-grid');
    const stats = [
      ['待处理作业', status.counts.jobs_pending],
      ['未知作业', status.counts.jobs_unknown],
      ['失败作业', status.counts.jobs_failed],
      ['待提炼', status.counts.retain_pending],
      ['可用上下文', status.counts.contexts_ready]
    ];
    for (const entry of stats) {
      const card = memoryCreate('div', 'memory-stat');
      card.append(memoryCreate('strong', '', String(entry[1] || 0)));
      card.append(memoryCreate('span', '', entry[0]));
      grid.append(card);
    }
    root.append(grid);
  }
}

function memoryRenderCapability(catalog, me, status, statusError) {
  if (!memoryCapabilityElement) return;
  memoryCapabilityElement.replaceChildren();
  if (!catalog) {
    memoryCapabilityElement.append(memoryErrorCard(
      'Memory 能力未宣告',
      '服务端没有返回 service.memory。这里不会猜测可用入口；请刷新目录或更新连接器。'
    ));
    return;
  }
  if (!catalog.enabled) {
    const card = memoryErrorCard(
      'Memory 未启用',
      '该部署未启用 Memory。聊天、群聊、任务与文件仍照常可用；这里不会显示不可用的召回、经历或治理入口。',
      'is-disabled'
    );
    memoryCapabilityElement.append(card);
    memoryAppendCatalogFacts(memoryCapabilityElement, catalog, status);
    return;
  }
  if (status && status.enabled !== true) {
    const card = memoryErrorCard(
      'Memory 暂不可用',
      '服务端当前空间状态为 enabled=false。已提交的账本与遗忘屏障仍保留；这里不会把不可读状态显示成空库。',
      'is-disabled'
    );
    memoryCapabilityElement.append(card);
    memoryAppendCatalogFacts(memoryCapabilityElement, catalog, status);
    return;
  }
  const head = memoryCreate('div', 'memory-capability-head');
  head.append(memoryCreate('h3', '', 'Memory 已启用'));
  head.append(memoryChip(me && me.kind === 'agent' ? 'Agent 身份' : '人类身份',
    me && me.kind === 'agent' ? 'good' : 'info'));
  memoryCapabilityElement.append(head);
  if (catalog.engine_status && catalog.engine_status !== 'ready') {
    memoryCapabilityElement.append(memoryErrorCard(
      '记忆引擎暂不可用',
      catalog.engine_status === 'unsupported'
        ? '当前适配器不支持检索/提炼。本地账本、已有上下文与遗忘屏障仍然保留；召回会如实返回 unsupported，不显示伪造空库。'
        : '引擎暂时不可用。已提交的账本与遗忘屏障仍然保留；召回会如实返回 unavailable，恢复后无需重建本地记录。',
      'is-danger'
    ));
  }
  memoryAppendCatalogFacts(memoryCapabilityElement, catalog, status);
  if (status && status.capture === false) {
    memoryCapabilityElement.append(memoryCreate('p', 'memory-note',
      '采集已关闭：不会新增消息来源或预热，但已有记忆、撤回与遗忘屏障仍然保留。'));
  }
  if (status && status.sources && status.sources.langfuse) {
    const source = status.sources.langfuse;
    memoryCapabilityElement.append(memoryCreate('p', 'memory-note',
      'Langfuse 来源：' + (source.configured ? '已配置（' + source.status + '）' : '未配置') +
      (source.reason ? '；原因：' + source.reason : '') +
      '。这里只显示阶段，不包含 host、project 或凭据。'));
  }
  if (me && me.kind !== 'agent') {
    memoryCapabilityElement.append(memoryCreate('p', 'memory-note',
      '当前身份是人类。Agent 私有记忆的正文、标题、范围与治理入口只对 Agent 自身凭据开放；' +
      '管理者不能通过此面板读取其他 Agent 的记忆。使用该 Agent 的 token 登录后可查看。'));
  }
  if (statusError) {
    const info = memoryErrorInfo(statusError);
    const card = memoryErrorCard(info.title, info.detail, 'is-danger');
    const retry = memoryCreate('button', 'memory-action', '重试');
    retry.type = 'button';
    retry.addEventListener('click', function () { memoryLoad().catch(function () {}); });
    card.append(retry);
    memoryCapabilityElement.append(card);
  } else if (me && me.kind === 'agent' && !status) {
    memoryCapabilityElement.append(memoryCreate('p', 'memory-note',
      '正在读取当前 Agent 的空间状态；该状态只包含计数与能力，不包含 provider、bank 或密钥。'));
  }
}

async function memoryLoad() {
  if (!memoryDrawerElement || !memoryDrawerElement.open) return;
  const captured = ++memoryStatusEpoch;
  memorySetStatus(memoryStatusElement, '正在读取身份与 Memory 状态…', '');
  let me = null;
  try {
    me = await callTool('network_me', {});
  } catch (error) {
    if (!memoryCurrent(memoryStatusEpoch, captured)) return;
    const info = memoryErrorInfo(error);
    if (memoryBodyElement) memoryBodyElement.hidden = true;
    memoryShowTabs(false);
    memorySetStatus(memoryStatusElement, info.title + '：' + info.detail, 'error');
    memoryCapabilityElement.replaceChildren(memoryErrorCard(info.title, info.detail, 'is-danger'));
    return;
  }
  if (!memoryCurrent(memoryStatusEpoch, captured)) return;
  memoryMe = me;
  memoryUpdateSubtitle(me);
  const catalog = me.service && me.service.memory ? me.service.memory : null;
  memoryStatus = null;
  if (memoryBodyElement) memoryBodyElement.hidden = false;
  memoryRenderCapability(catalog, me, null, null);
  if (!catalog || !catalog.enabled) {
    memoryShowTabs(false);
    memorySetStatus(memoryStatusElement, '', '');
    return;
  }
  if (me.kind !== 'agent') {
    memoryShowTabs(false);
    memorySetStatus(memoryStatusElement, '', '');
    return;
  }
  try {
    const status = await callTool('network_memory_status', {});
    if (!memoryCurrent(memoryStatusEpoch, captured)) return;
    memoryStatus = status || null;
    if (!status || status.enabled !== true) {
      memoryRenderCapability(catalog, me, status || null, null);
      memoryShowTabs(false);
      memorySetStatus(memoryStatusElement, '', '');
      return;
    }
    memoryRenderCapability(catalog, me, status, null);
    memoryShowTabs(true);
    memorySetStatus(memoryStatusElement, '', '');
    memorySelectTab(memoryActiveTab, true);
  } catch (error) {
    if (!memoryCurrent(memoryStatusEpoch, captured)) return;
    memoryStatus = null;
    memoryRenderCapability(catalog, me, null, error);
    memoryShowTabs(false);
    const info = memoryErrorInfo(error);
    memorySetStatus(memoryStatusElement, info.title + '：' + info.detail, 'error');
  }
}

function memorySelectTab(name, force) {
  if (!memoryDrawerElement || !memoryDrawerElement.open) return;
  if (!memoryTabsElement || memoryTabsElement.hidden) return;
  const allowed = ['recall', 'context', 'experience', 'host', 'governance'];
  if (allowed.indexOf(name) < 0) name = 'recall';
  memoryActiveTab = name;
  memoryUpdateTabButtons();
  if (name === 'context' && (force || !memoryContextLoaded)) memoryLoadContexts(true);
  if (name === 'experience' && (force || !memoryExperienceLoaded)) {
    memoryRefreshExperienceRoomOptions();
    memoryLoadExperiences(true);
  }
  if (name === 'host' && typeof memoryRenderHost === 'function') memoryRenderHost();
  if (name === 'governance' && typeof memoryLoadGovernance === 'function') {
    if (force || !memoryGovernanceLoaded) memoryLoadGovernance();
  }
}

async function memoryOpen() {
  if (!memoryDrawerElement) return;
  memoryResetView();
  if (!memoryDrawerElement.open) memoryDrawerElement.showModal();
  if (memoryOpenButton) memoryOpenButton.setAttribute('aria-expanded', 'true');
  await memoryLoad();
}

function memoryClose() {
  if (!memoryDrawerElement) return;
  if (memoryOpenButton) memoryOpenButton.setAttribute('aria-expanded', 'false');
  if (memoryDrawerElement.open) memoryDrawerElement.close();
  memoryResetView();
}

function memoryIdentityChanged() {
  if (!memoryMe) return;
  memoryInvalidateAll();
  memoryResetView();
  if (memoryDrawerElement && memoryDrawerElement.open) memoryDrawerElement.close();
}

/** SSE 重连后重验身份/空间；旧请求通过代次丢弃，面板不保留过期正文。 */
function memoryHandleReconnect() {
  if (!memoryDrawerElement || !memoryDrawerElement.open) return;
  memoryInvalidateAll();
  memoryRecallContextRef = null;
  memoryContextLoaded = false;
  memoryExperienceLoaded = false;
  if (memoryRecallResult) memoryRecallResult.replaceChildren();
  if (memoryContextList) memoryContextList.replaceChildren();
  if (memoryContextMore) memoryContextMore.hidden = true;
  if (memoryExperienceList) memoryExperienceList.replaceChildren();
  if (memoryExperienceMore) memoryExperienceMore.hidden = true;
  if (memoryContextDetail) {
    memoryContextDetail.hidden = true;
    memoryContextDetail.replaceChildren();
  }
  if (memoryExperienceDetail) {
    memoryExperienceDetail.hidden = true;
    memoryExperienceDetail.replaceChildren();
  }
  if (typeof memoryResetGovernanceView === 'function') memoryResetGovernanceView();
  memoryLoad().catch(function () {});
}

/** 切房后清掉房间相关列表；召回结果与身份状态保持不变。 */
function memoryHandleRoomChange() {
  if (!memoryDrawerElement || !memoryDrawerElement.open) return;
  memoryContextLoaded = false;
  memoryExperienceLoaded = false;
  if (memoryActiveTab === 'context') memoryLoadContexts(true);
  if (memoryActiveTab === 'experience') {
    memoryRefreshExperienceRoomOptions();
    memoryLoadExperiences(true);
  }
}

function memoryAgentReady() {
  return Boolean(memoryMe && memoryMe.kind === 'agent' && memoryStatus && memoryStatus.enabled === true);
}

function memoryAppendListRow(list, child) {
  const wrapper = memoryCreate('div', 'memory-list-item');
  wrapper.setAttribute('role', 'listitem');
  wrapper.append(child);
  list.append(wrapper);
}

function memoryRenderRecall(result) {
  if (!memoryRecallResult) return;
  memoryRecallResult.replaceChildren();
  if (!result) return;
  memoryRecallContextRef = result.context_ref || null;
  const status = String(result.status || 'unknown');
  const head = memoryCreate('div', 'memory-capability-head');
  const tone = status === 'ready' ? 'good'
    : status === 'empty' ? 'info'
      : status === 'pending' ? 'warn'
        : status === 'unavailable' || status === 'disabled' ? 'danger' : 'warn';
  head.append(memoryChip(memoryLabel(MEMORY_RECALL_STATUS_LABELS, status, status), tone));
  head.append(memoryChip(memoryLabel(MEMORY_COVERAGE_LABELS, result.coverage, '覆盖未知'), 'info'));
  head.append(memoryChip(result.evidence_complete ? '证据完整' : '证据不完整',
    result.evidence_complete ? 'good' : 'warn'));
  memoryRecallResult.append(head);
  const notes = {
    ready: '本次有界召回返回了候选；结果只是参考数据。',
    empty: '本次有界查询没有合格候选；不代表库内不存在。',
    pending: '召回仍在准备中；聊天与投递不受影响。',
    unavailable: '当前无法读取记忆后端；稍后可重试。',
    unsupported: '当前适配器不支持该查询或过滤；这里不会伪造空库。',
    disabled: 'Memory 未启用。',
    skipped_no_boundary: '没有有效的宿主运行边界，结果没有追加到原运行。'
  };
  if (notes[status]) memoryRecallResult.append(memoryCreate('p', 'memory-detail-meta', notes[status]));
  if (result.freshness && result.freshness.as_of) {
    memoryRecallResult.append(memoryCreate('p', 'memory-detail-meta',
      '数据时间：' + memoryTime(result.freshness.as_of)));
  }
  if (result.budget_used) {
    memoryRecallResult.append(memoryCreate('p', 'memory-detail-meta',
      '候选 ' + String(result.budget_used.candidates || 0) + ' 条 · 打包 ' +
      memoryBytes(result.budget_used.packaged_bytes) + (result.budget_used.truncated ? ' · 已截断' : '')));
  }
  if (Array.isArray(result.items) && result.items.length > 0) {
    for (const item of result.items) {
      const card = memoryCreate('div', 'memory-row memory-row-static');
      const top = memoryCreate('div', 'memory-row-top');
      top.append(memoryChip(memoryLabel(MEMORY_ORIGIN_LABELS, item.origin_kind, '来源未知'),
        item.origin_kind === 'authored' ? 'info' : 'good'));
      const representation = item.representation || {};
      top.append(memoryChip(memoryLabel(MEMORY_REPRESENTATION_LABELS, representation.kind, '表示未知'), 'info'));
      if (item.evidence) top.append(memoryChip(memoryLabel(MEMORY_EVIDENCE_LABELS, item.evidence, item.evidence), 'good'));
      card.append(top);
      const meta = [];
      if (representation.text_bytes !== undefined) meta.push(memoryBytes(representation.text_bytes));
      if (item.source && item.source.source_revision !== undefined) meta.push('来源修订 ' + item.source.source_revision);
      if (item.score !== null && item.score !== undefined) meta.push('排序分 ' + Number(item.score).toFixed(3) + '（非可信度）');
      card.append(memoryCreate('p', 'memory-row-meta', meta.join(' · ')));
      memoryRecallResult.append(card);
    }
  }
  if (Array.isArray(result.exclusions) && result.exclusions.length > 0) {
    const details = memoryCreate('details', 'memory-block');
    details.append(memoryCreate('summary', 'memory-detail-meta', '排除原因（' + result.exclusions.length + '）'));
    const list = memoryCreate('ul', 'memory-steps');
    for (const exclusion of result.exclusions) {
      list.append(memoryCreate('li', '', memoryLabel({
        permission: '权限不足',
        source_not_active: '来源已失效',
        forgotten: '已被遗忘',
        evidence_below_minimum: '低于最低证据',
        budget: '超出预算',
        unsupported_hard_filter: '不支持该硬过滤',
        target_scope: '目标受众不匹配'
      }, exclusion.reason, exclusion.reason) + (exclusion.detail ? '：' + exclusion.detail : '')));
    }
    details.append(list);
    memoryRecallResult.append(details);
  }
  if (result.injection) {
    memoryRecallResult.append(memoryCreate('p', 'memory-note',
      '参考数据：未获得注入许可。' + memoryLabel(MEMORY_REASON_LABELS, result.injection.reason,
        '召回结果不会自动进入模型输入。') + '召回结果不会自动进入模型输入。'));
  }
  if (memoryRecallContextRef) {
    const button = memoryCreate('button', 'memory-action', '查看召回上下文正文');
    button.type = 'button';
    button.addEventListener('click', function () {
      memorySelectTab('context', false);
      memoryLoadContextDetail(memoryRecallContextRef);
    });
    memoryRecallResult.append(button);
  }
}

function memorySubmitRecall(event) {
  if (event) event.preventDefault();
  if (!memoryAgentReady()) {
    memorySetStatus(memoryRecallStatus, 'Memory 内容工具只对 Agent 自身凭据开放。', 'error');
    return;
  }
  const query = memoryRecallQuery ? memoryRecallQuery.value.trim() : '';
  if (!query) {
    memorySetStatus(memoryRecallStatus, '请输入查询内容。', 'error');
    if (memoryRecallQuery) memoryRecallQuery.focus();
    return;
  }
  const captured = ++memoryRecallEpoch;
  memorySetStatus(memoryRecallStatus, '正在召回…', '');
  const args = {
    request_id: requestId('mem_recall'),
    mode: memoryRecallMode ? memoryRecallMode.value : 'lookup',
    dispatch: 'explicit',
    query: query,
    budget: { candidate_limit: MEMORY_WEB_RECALL_CANDIDATES, output_bytes: MEMORY_WEB_RECALL_OUTPUT_BYTES }
  };
  const evidence = memoryRecallEvidence ? memoryRecallEvidence.value : '';
  if (evidence) args.hard_filters = { minimum_evidence: evidence };
  callTool('network_memory_recall', args).then(function (result) {
    if (!memoryCurrent(memoryRecallEpoch, captured)) return;
    memorySetStatus(memoryRecallStatus, '', '');
    memoryRenderRecall(result);
  }).catch(function (error) {
    if (!memoryCurrent(memoryRecallEpoch, captured)) return;
    const info = memoryErrorInfo(error);
    memorySetStatus(memoryRecallStatus, info.title + '：' + info.detail, 'error');
    if (memoryRecallResult) {
      memoryRecallResult.replaceChildren(memoryErrorCard(info.title, info.detail, 'is-danger'));
    }
  });
}

function memoryMarkContextSelected(contextId) {
  memoryContextSelectedId = contextId;
  if (!memoryContextList) return;
  const rows = memoryContextList.querySelectorAll('[data-memory-context-id]');
  for (const row of rows) {
    row.setAttribute('aria-current', row.getAttribute('data-memory-context-id') === contextId ? 'true' : 'false');
  }
}

function memoryRenderContextRow(item) {
  const button = memoryCreate('button', 'memory-row');
  button.type = 'button';
  button.setAttribute('data-memory-context-id', item.context_id);
  if (item.context_id === memoryContextSelectedId) button.setAttribute('aria-current', 'true');
  const top = memoryCreate('div', 'memory-row-top');
  top.append(memoryCreate('span', 'memory-row-title',
    '记忆包 · ' + (item.kind === 'bound' ? 'bound' : 'lookup')));
  top.append(memoryChip(memoryLabel(MEMORY_VALIDITY_LABELS, item.validity, item.validity),
    item.validity === 'active' ? 'good' : item.validity === 'expired' ? 'warn' : 'danger'));
  button.append(top);
  const meta = [];
  meta.push('创建 ' + memoryTime(item.created_at));
  if (item.body_bytes !== undefined) meta.push(memoryBytes(item.body_bytes));
  if (item.recall_id) meta.push('召回 ' + String(item.recall_id).slice(-8));
  button.append(memoryCreate('p', 'memory-row-meta', meta.join(' · ')));
  button.addEventListener('click', function () {
    memoryMarkContextSelected(item.context_id);
    memoryLoadContextDetail(item.context_id);
  });
  return button;
}

function memoryLoadContexts(reset) {
  if (!memoryAgentReady() || !memoryContextList) return;
  if (reset) {
    memoryContextCursor = null;
    memoryContextHasMore = false;
    memoryContextLoaded = false;
    memoryContextSelectedId = null;
    memoryContextList.replaceChildren();
    if (memoryContextDetail) {
      memoryContextDetail.hidden = true;
      memoryContextDetail.replaceChildren();
    }
  }
  const captured = ++memoryContextEpoch;
  memorySetStatus(memoryContextStatus, '正在读取上下文…', '');
  const args = { limit: MEMORY_WEB_PAGE_SIZE };
  if (memoryContextKind && memoryContextKind.value) args.kind = memoryContextKind.value;
  if (!reset && memoryContextCursor) args.cursor = memoryContextCursor;
  callTool('network_memory_context_list', args).then(function (page) {
    if (!memoryCurrent(memoryContextEpoch, captured)) return;
    memoryContextLoaded = true;
    const items = page && Array.isArray(page.items) ? page.items : [];
    for (const item of items) memoryAppendListRow(memoryContextList, memoryRenderContextRow(item));
    memoryContextCursor = page ? page.next_cursor : null;
    memoryContextHasMore = Boolean(page && page.has_more && page.next_cursor);
    if (memoryContextMore) memoryContextMore.hidden = !memoryContextHasMore;
    if (reset && items.length === 0) {
      memoryContextList.append(memoryEmpty(
        '还没有记忆上下文。显式召回命中后会生成 lookup 记忆包；宿主绑定输入后才会生成 bound 记忆包。'
      ));
    }
    memorySetStatus(memoryContextStatus, items.length > 0 ? '已加载 ' + items.length + ' 个上下文' : '', '');
  }).catch(function (error) {
    if (!memoryCurrent(memoryContextEpoch, captured)) return;
    const info = memoryErrorInfo(error);
    memorySetStatus(memoryContextStatus, info.title + '：' + info.detail, 'error');
  });
}

function memoryLoadContextDetail(contextId) {
  if (!memoryAgentReady() || !memoryContextDetail || !contextId) return;
  const captured = ++memoryContextDetailEpoch;
  memoryContextDetail.hidden = false;
  memoryContextDetail.replaceChildren(memoryCreate('p', 'memory-detail-meta', '正在读取上下文正文…'));
  callTool('network_memory_context_get', { context_id: contextId }).then(function (result) {
    if (!memoryCurrent(memoryContextDetailEpoch, captured)) return;
    memoryContextDetail.replaceChildren();
    const head = memoryCreate('div', 'memory-detail-head');
    head.append(memoryCreate('h3', '', '记忆包正文'));
    const close = memoryCreate('button', 'memory-action', '收起');
    close.type = 'button';
    close.addEventListener('click', function () {
      memoryContextDetail.hidden = true;
      memoryContextDetail.replaceChildren();
    });
    head.append(close);
    memoryContextDetail.append(head);
    if (!result || result.available !== true) {
      const reason = result && result.reason ? result.reason : 'context_not_active';
      memoryContextDetail.append(memoryErrorCard(
        '当前不可读取',
        memoryLabel(MEMORY_REASON_LABELS, reason, reason) +
        '。撤回、遗忘、过期或受众变化后不会返回部分正文。',
        'is-danger'
      ));
      return;
    }
    const chips = memoryCreate('div', 'memory-chip-row');
    chips.append(memoryChip(result.kind === 'bound' ? 'bound 上下文' : 'lookup 上下文', 'info'));
    if (result.validity) {
      chips.append(memoryChip(memoryLabel(MEMORY_VALIDITY_LABELS, result.validity, result.validity),
        result.validity === 'active' ? 'good' : 'warn'));
    }
    if (result.body_sha256) chips.append(memoryChip('正文 ' + memoryShortHash(result.body_sha256), 'info'));
    memoryContextDetail.append(chips);
    const items = Array.isArray(result.items) ? result.items : [];
    for (const item of items) {
      const card = memoryCreate('div', 'memory-detail');
      const top = memoryCreate('div', 'memory-row-top');
      top.append(memoryChip(memoryLabel(MEMORY_ORIGIN_LABELS, item.origin_kind, '来源未知'), 'good'));
      if (item.evidence) top.append(memoryChip(memoryLabel(MEMORY_EVIDENCE_LABELS, item.evidence, item.evidence), 'info'));
      if (item.range) top.append(memoryChip('字节 ' + item.range.start + '–' + item.range.end, 'info'));
      card.append(top);
      if (item.origin_scope && item.origin_scope.room_id) {
        card.append(memoryCreate('p', 'memory-detail-meta',
          '来源房间：' + memoryRoomName(item.origin_scope.room_id)));
      }
      card.append(memoryCreate('div', 'memory-text', item.text || ''));
      memoryContextDetail.append(card);
    }
    if (items.length === 0 && result.body) {
      const details = memoryCreate('details', 'memory-block');
      details.append(memoryCreate('summary', 'memory-detail-meta', '原始上下文正文'));
      details.append(memoryCreate('div', 'memory-text', result.body));
      memoryContextDetail.append(details);
    }
    const injection = result.injection;
    if (injection) {
      memoryContextDetail.append(memoryCreate('p', 'memory-note',
        (injection.eligible ? '当前有效，但仍需宿主 admission 才能注入。' : '未获得注入许可。') +
        memoryLabel(MEMORY_REASON_LABELS, injection.reason, '每次读取都会重新校验当前权限。')));
    }
  }).catch(function (error) {
    if (!memoryCurrent(memoryContextDetailEpoch, captured)) return;
    const info = memoryErrorInfo(error);
    memoryContextDetail.replaceChildren(memoryErrorCard(info.title, info.detail, 'is-danger'));
  });
}

function memoryRefreshExperienceRoomOptions() {
  if (!memoryExperienceRoom) return;
  const current = memoryExperienceRoom.value;
  memoryExperienceRoom.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部房间';
  memoryExperienceRoom.append(all);
  for (const entry of roomEntries) {
    if (!entry.room_id) continue;
    const option = document.createElement('option');
    option.value = entry.room_id;
    option.textContent = entry.kind === 'group'
      ? (entry.title || '群聊')
      : (entry.name || '会话');
    memoryExperienceRoom.append(option);
  }
  memoryExperienceRoom.value = current || '';
  if (memoryExperienceRoom.value !== (current || '')) memoryExperienceRoom.value = '';
}

function memoryRenderExperienceRow(item) {
  const button = memoryCreate('button', 'memory-row');
  button.type = 'button';
  button.setAttribute('data-memory-experience-id', item.experience_id);
  if (item.experience_id === memoryExperienceSelectedId) button.setAttribute('aria-current', 'true');
  const top = memoryCreate('div', 'memory-row-top');
  top.append(memoryCreate('span', 'memory-row-title', memoryRoomName(item.origin_room_id)));
  top.append(memoryChip(memoryLabel(MEMORY_REPRESENTATION_LABELS, item.representation_kind, '表示未知'),
    item.representation_kind === 'summary' ? 'warn' : item.representation_kind === 'authored' ? 'info' : 'good'));
  top.append(memoryChip(memoryLabel(MEMORY_ORIGIN_LABELS, item.origin_kind, '来源未知'), 'info'));
  if (item.available !== true) top.append(memoryChip('当前不可用', 'danger'));
  button.append(top);
  const meta = [];
  meta.push(memoryTime(item.created_at));
  meta.push('成员代次 ' + String(item.origin_member_generation));
  if (item.evidence) meta.push(memoryLabel(MEMORY_EVIDENCE_LABELS, item.evidence, item.evidence));
  else meta.push('无提交证据');
  if (item.range) meta.push('字节 ' + item.range.start + '–' + item.range.end);
  button.append(memoryCreate('p', 'memory-row-meta', meta.join(' · ')));
  button.addEventListener('click', function () {
    memoryExperienceSelectedId = item.experience_id;
    const rows = memoryExperienceList ? memoryExperienceList.querySelectorAll('[data-memory-experience-id]') : [];
    for (const row of rows) {
      row.setAttribute('aria-current', row.getAttribute('data-memory-experience-id') === item.experience_id ? 'true' : 'false');
    }
    memoryLoadExperienceDetail(item.experience_id);
  });
  return button;
}

function memoryLoadExperiences(reset) {
  if (!memoryAgentReady() || !memoryExperienceList) return;
  if (reset) {
    memoryExperienceCursor = null;
    memoryExperienceHasMore = false;
    memoryExperienceLoaded = false;
    memoryExperienceSelectedId = null;
    memoryExperienceList.replaceChildren();
    if (memoryExperienceDetail) {
      memoryExperienceDetail.hidden = true;
      memoryExperienceDetail.replaceChildren();
    }
  }
  const captured = ++memoryExperienceEpoch;
  memorySetStatus(memoryExperienceStatus, '正在读取输入经历…', '');
  const args = { limit: MEMORY_WEB_PAGE_SIZE };
  if (memoryExperienceRoom && memoryExperienceRoom.value) args.room_id = memoryExperienceRoom.value;
  if (!reset && memoryExperienceCursor) args.cursor = memoryExperienceCursor;
  callTool('network_memory_experience_list', args).then(function (page) {
    if (!memoryCurrent(memoryExperienceEpoch, captured)) return;
    memoryExperienceLoaded = true;
    const items = page && Array.isArray(page.items) ? page.items : [];
    for (const item of items) memoryAppendListRow(memoryExperienceList, memoryRenderExperienceRow(item));
    memoryExperienceCursor = page ? page.next_cursor : null;
    memoryExperienceHasMore = Boolean(page && page.has_more && page.next_cursor);
    if (memoryExperienceMore) memoryExperienceMore.hidden = !memoryExperienceHasMore;
    if (reset && items.length === 0) {
      memoryExperienceList.append(memoryEmpty(
        '还没有实际提交形成的输入经历。未消费的消息、派发或准备清单不会显示为待办，也不会被伪报为已读。'
      ));
    }
    memorySetStatus(memoryExperienceStatus, items.length > 0 ? '已加载 ' + items.length + ' 条经历' : '', '');
  }).catch(function (error) {
    if (!memoryCurrent(memoryExperienceEpoch, captured)) return;
    const info = memoryErrorInfo(error);
    memorySetStatus(memoryExperienceStatus, info.title + '：' + info.detail, 'error');
  });
}

function memoryLoadExperienceDetail(experienceId) {
  if (!memoryAgentReady() || !memoryExperienceDetail || !experienceId) return;
  const captured = ++memoryExperienceDetailEpoch;
  memoryExperienceDetail.hidden = false;
  memoryExperienceDetail.replaceChildren(memoryCreate('p', 'memory-detail-meta', '正在读取经历…'));
  callTool('network_memory_experience_get', { experience_id: experienceId }).then(function (result) {
    if (!memoryCurrent(memoryExperienceDetailEpoch, captured)) return;
    memoryExperienceDetail.replaceChildren();
    const head = memoryCreate('div', 'memory-detail-head');
    head.append(memoryCreate('h3', '', '经历详情'));
    const close = memoryCreate('button', 'memory-action', '收起');
    close.type = 'button';
    close.addEventListener('click', function () {
      memoryExperienceDetail.hidden = true;
      memoryExperienceDetail.replaceChildren();
    });
    head.append(close);
    memoryExperienceDetail.append(head);
    if (!result || result.available !== true) {
      const reason = result && result.reason ? result.reason : 'not_found';
      memoryExperienceDetail.append(memoryErrorCard(
        '当前不可读取',
        memoryLabel(MEMORY_REASON_LABELS, reason, reason) +
        '。遗忘、撤回或权限变化后不会返回正文。',
        'is-danger'
      ));
      return;
    }
    const item = result.item || {};
    const chips = memoryCreate('div', 'memory-chip-row');
    chips.append(memoryChip(memoryLabel(MEMORY_REPRESENTATION_LABELS, item.representation_kind, '表示未知'),
      item.representation_kind === 'summary' ? 'warn' : 'good'));
    chips.append(memoryChip(memoryLabel(MEMORY_ORIGIN_LABELS, item.origin_kind, '来源未知'), 'info'));
    if (item.evidence) chips.append(memoryChip(memoryLabel(MEMORY_EVIDENCE_LABELS, item.evidence, item.evidence), 'good'));
    if (item.capture) chips.append(memoryChip('采集 ' + memoryLabel(MEMORY_CAPTURE_LABELS, item.capture, item.capture), 'info'));
    memoryExperienceDetail.append(chips);
    const meta = [];
    meta.push('来源房间：' + memoryRoomName(item.origin_room_id));
    meta.push('成员代次 ' + String(item.origin_member_generation));
    meta.push('时间 ' + memoryTime(item.created_at));
    if (item.range) meta.push('字节 ' + item.range.start + '–' + item.range.end);
    if (item.source_revision !== null && item.source_revision !== undefined) {
      meta.push('来源修订 ' + item.source_revision);
    }
    memoryExperienceDetail.append(memoryCreate('p', 'memory-detail-meta', meta.join(' · ')));
    if (item.representation_kind === 'summary') {
      memoryExperienceDetail.append(memoryCreate('p', 'memory-note',
        '摘要经历：只代表曾提交过该摘要，不代表原文已全部读取，也不推进原文覆盖。'));
    } else if (item.origin_kind === 'authored' || item.representation_kind === 'authored') {
      memoryExperienceDetail.append(memoryCreate('p', 'memory-note',
        '自身发布：这是该 Agent 的输出记录，不是外部阅读或他人验收证据。'));
    } else if (item.representation_kind === 'raw_fragment' || item.representation_kind === 'preview') {
      memoryExperienceDetail.append(memoryCreate('p', 'memory-note',
        '片段/预览经历：只覆盖显示的准确表示，不表示全文已消费。'));
    }
    memoryExperienceDetail.append(memoryCreate('div', 'memory-text', result.text || ''));
  }).catch(function (error) {
    if (!memoryCurrent(memoryExperienceDetailEpoch, captured)) return;
    const info = memoryErrorInfo(error);
    memoryExperienceDetail.replaceChildren(memoryErrorCard(info.title, info.detail, 'is-danger'));
  });
}

if (memoryOpenButton) {
  memoryOpenButton.addEventListener('click', function () {
    memoryOpen().catch(function (error) {
      memorySetStatus(memoryStatusElement,
        '打开记忆面板失败：' + (error && error.message ? error.message : error), 'error');
    });
  });
}
if (memoryCloseButton) {
  memoryCloseButton.addEventListener('click', function () { memoryClose(); });
}
if (memoryRefreshButton) {
  memoryRefreshButton.addEventListener('click', function () {
    memoryLoad().catch(function () {});
  });
}
if (memoryDrawerElement) {
  memoryDrawerElement.addEventListener('close', function () {
    if (memoryOpenButton) memoryOpenButton.setAttribute('aria-expanded', 'false');
    memoryInvalidateAll();
    memoryResetView();
  });
  memoryDrawerElement.addEventListener('click', function (event) {
    if (event.target === memoryDrawerElement) memoryClose();
  });
}
if (memoryTabsElement) {
  const memoryTabButtons = memoryTabsElement.querySelectorAll('[data-memory-tab]');
  for (const button of memoryTabButtons) {
    button.addEventListener('click', function () {
      memorySelectTab(button.getAttribute('data-memory-tab'), false);
    });
  }
}
if (memoryRecallForm) memoryRecallForm.addEventListener('submit', memorySubmitRecall);
if (memoryContextRefresh) {
  memoryContextRefresh.addEventListener('click', function () { memoryLoadContexts(true); });
}
if (memoryContextKind) {
  memoryContextKind.addEventListener('change', function () { memoryLoadContexts(true); });
}
if (memoryContextMore) {
  memoryContextMore.addEventListener('click', function () { memoryLoadContexts(false); });
}
if (memoryExperienceRefresh) {
  memoryExperienceRefresh.addEventListener('click', function () { memoryLoadExperiences(true); });
}
if (memoryExperienceRoom) {
  memoryExperienceRoom.addEventListener('change', function () { memoryLoadExperiences(true); });
}
if (memoryExperienceMore) {
  memoryExperienceMore.addEventListener('click', function () { memoryLoadExperiences(false); });
}
`;
