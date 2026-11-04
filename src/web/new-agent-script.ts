/**
 * 新建 Agent 弹窗的客户端片段。
 *
 * 由 `chatClientScript` 拼进主脚本共享作用域，因此可复用
 * `ensureIdentity`、`callTool`、`callToolWithToken`、`requestId` 与
 * `legacyCopyText`。新 Agent 的 token/URL/提示词只保存在本片段的闭包变量与
 * 弹窗输入框/文本区里，关闭即清空；注册成功后把该 Agent 自己的 MCP URL
 * 写入当前 human 的本地 Agents 注册表，供会话右键提示词复用，不写
 * human token、提示词或 console。
 */
export const NEW_AGENT_SCRIPT = `
const newAgentButton = document.getElementById('new-agent');
const newAgentModal = document.getElementById('new-agent-modal');
const newAgentForm = document.getElementById('new-agent-form');
const newAgentNameInput = document.getElementById('new-agent-name');
const newAgentCreateButton = document.getElementById('new-agent-create');
const newAgentCloseButton = document.getElementById('new-agent-close');
const newAgentErrorElement = document.getElementById('new-agent-error');
const newAgentResultElement = document.getElementById('new-agent-result');
const newAgentUrlInput = document.getElementById('new-agent-url');
const newAgentShareInput = document.getElementById('new-agent-share');
const newAgentSkillUrlInput = document.getElementById('new-agent-skill-url');
const newAgentPromptInput = document.getElementById('new-agent-prompt');
const newAgentCopyButton = document.getElementById('new-agent-copy');
const newAgentShareCopyButton = document.getElementById('new-agent-share-copy');
const newAgentPromptCopyButton = document.getElementById('new-agent-prompt-copy');
const NEW_AGENT_SKILL_PATH = '/skills/agent-network-curl.md';

let newAgentToken = '';
let newAgentUrl = '';
let newAgentBusy = false;
let newAgentCreated = false;
let newAgentRequestSeq = 0;
let newAgentOpener = null;
const newAgentCopyTimers = new Map();

function newAgentSkillUrl() {
  return location.origin + NEW_AGENT_SKILL_PATH;
}

/** 纯 URL skill 提示词：只引用技能文档与连接信息，不重复技能步骤。 */
function newAgentBuildPrompt(skillUrl, mcpUrl, token, name) {
  return '你是 WeBots Agent。请先阅读并严格按技能文档执行：\\n' + skillUrl +
    '\\n\\n连接信息：\\n' +
    'AGENTNET_MCP_URL="' + mcpUrl + '"\\n' +
    'AGENTNET_TOKEN="' + token + '"\\n' +
    '你的 Agent 身份：' + name +
    '\\n\\n按技能文档确认身份、把 share_url 发给用户、进入异步监听并处理消息。' +
    '不要重复发明步骤。凭据只给目标 Agent，勿发群、日志或截图。';
}

function newAgentSetError(message) {
  if (newAgentErrorElement) newAgentErrorElement.textContent = message || '';
}

function newAgentResetCopyButton(button) {
  if (!button) return;
  const timer = newAgentCopyTimers.get(button);
  if (timer) clearTimeout(timer);
  newAgentCopyTimers.delete(button);
  const label = button.getAttribute('data-label');
  if (label) button.textContent = label;
}

function newAgentReset() {
  // 先作废旧请求，避免关闭后到达的成功响应重新显示凭据。
  newAgentRequestSeq += 1;
  newAgentToken = '';
  newAgentUrl = '';
  newAgentBusy = false;
  newAgentCreated = false;
  if (newAgentUrlInput) newAgentUrlInput.value = '';
  if (newAgentShareInput) newAgentShareInput.value = '';
  if (newAgentSkillUrlInput) newAgentSkillUrlInput.value = '';
  if (newAgentPromptInput) newAgentPromptInput.value = '';
  if (newAgentResultElement) newAgentResultElement.hidden = true;
  if (newAgentNameInput) newAgentNameInput.disabled = false;
  if (newAgentCreateButton) {
    newAgentCreateButton.disabled = false;
    newAgentCreateButton.textContent = '创建';
  }
  if (newAgentCloseButton) newAgentCloseButton.disabled = false;
  newAgentResetCopyButton(newAgentCopyButton);
  newAgentResetCopyButton(newAgentShareCopyButton);
  newAgentResetCopyButton(newAgentPromptCopyButton);
  newAgentSetError('');
}

function newAgentOpen() {
  if (!newAgentModal) return;
  newAgentOpener = document.activeElement;
  if (newAgentNameInput) newAgentNameInput.value = '';
  newAgentReset();
  newAgentModal.hidden = false;
  if (newAgentButton) newAgentButton.setAttribute('aria-expanded', 'true');
  if (newAgentNameInput) newAgentNameInput.focus();
}

function newAgentClose() {
  if (!newAgentModal || newAgentModal.hidden) return;
  newAgentReset();
  newAgentModal.hidden = true;
  if (newAgentButton) newAgentButton.setAttribute('aria-expanded', 'false');
  const opener = newAgentOpener;
  newAgentOpener = null;
  if (opener && opener.focus) opener.focus();
}

async function newAgentCopyValue(value) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      // 非安全上下文或权限被拒时回退到 execCommand。
    }
  }
  legacyCopyText(value);
}

function newAgentShowCopied(button) {
  if (!button) return;
  if (!button.getAttribute('data-label')) {
    button.setAttribute('data-label', button.textContent);
  }
  const label = button.getAttribute('data-label');
  button.textContent = '已复制';
  const previous = newAgentCopyTimers.get(button);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(function () {
    button.textContent = label;
    newAgentCopyTimers.delete(button);
  }, 1500);
  newAgentCopyTimers.set(button, timer);
}

async function newAgentCopy(button, input, label) {
  if (!input || !input.value) {
    newAgentSetError(label + '尚未生成');
    return;
  }
  try {
    await newAgentCopyValue(input.value);
    newAgentSetError('');
    newAgentShowCopied(button);
  } catch (error) {
    newAgentSetError('复制' + label + '失败：' + (error && error.message ? error.message : String(error)));
  }
}

async function newAgentCreate(event) {
  event.preventDefault();
  if (newAgentBusy || newAgentCreated) return;
  const name = newAgentNameInput ? newAgentNameInput.value.trim() : '';
  if (!name) {
    newAgentSetError('名称不能为空');
    if (newAgentNameInput) newAgentNameInput.focus();
    return;
  }
  if (name.length > ACTOR_NAME_MAX) {
    newAgentSetError('名称最多 ' + ACTOR_NAME_MAX + ' 个字符');
    if (newAgentNameInput) newAgentNameInput.focus();
    return;
  }
  newAgentBusy = true;
  newAgentCreated = false;
  newAgentToken = '';
  newAgentUrl = '';
  newAgentRequestSeq += 1;
  const seq = newAgentRequestSeq;
  if (newAgentCreateButton) {
    newAgentCreateButton.disabled = true;
    newAgentCreateButton.textContent = '创建中…';
  }
  if (newAgentResultElement) newAgentResultElement.hidden = true;
  newAgentSetError('');
  try {
    // 只复用浏览器 human 身份来申请 token；注册必须使用下面返回的新 token。
    const me = await ensureIdentity();
    if (seq !== newAgentRequestSeq) return;
    const issued = await callTool('network_issue_token', {});
    if (seq !== newAgentRequestSeq) return;
    const token = issued && issued.token;
    const url = issued && issued.url;
    if (typeof token !== 'string' || token.length === 0 ||
        typeof url !== 'string' || url.length === 0) {
      throw new Error('服务端未返回有效的 MCP URL');
    }
    // 在注册成功前只把 token 留在内存，失败时连同 URL 一起丢弃。
    newAgentToken = token;
    newAgentUrl = url;
    const agentSessionId = 'sess_' + crypto.randomUUID().replaceAll('-', '');
    const registered = await callToolWithToken('network_register', {
      request_id: requestId('web_agent_reg'),
      kind: 'agent',
      name: name,
      agent_session_id: agentSessionId
    }, token);
    if (seq !== newAgentRequestSeq) return;
    if (!registered || typeof registered.actor_id !== 'string') {
      throw new Error('注册成功但未返回 actor 信息');
    }
    newAgentCreated = true;
    newAgentBusy = false;
    if (newAgentNameInput) newAgentNameInput.disabled = true;
    if (newAgentUrlInput) newAgentUrlInput.value = newAgentUrl;
    if (newAgentShareInput) {
      newAgentShareInput.value =
        typeof registered.share_url === 'string' ? registered.share_url : '';
    }
    const skillUrl = newAgentSkillUrl();
    if (newAgentSkillUrlInput) newAgentSkillUrlInput.value = skillUrl;
    if (newAgentPromptInput) {
      newAgentPromptInput.value = newAgentBuildPrompt(skillUrl, newAgentUrl, newAgentToken, name);
    }
    if (newAgentResultElement) newAgentResultElement.hidden = false;
    // 本地注册表保存该 Agent 自己的 MCP URL，供右键提示词复用；不保存 human token。
    // 保存失败不影响已创建的 Agent 与弹窗内的一次性 URL。
    const registryError = agentRegistryAdd(me && me.actor_id, {
      actor_id: registered.actor_id,
      name: name,
      agent_session_id: agentSessionId,
      created_at: String(Date.now()),
      mcp_url: newAgentUrl
    });
    if (newAgentCreateButton) {
      newAgentCreateButton.disabled = true;
      newAgentCreateButton.textContent = '已创建';
    }
    if (!newAgentShareInput || !newAgentShareInput.value) {
      newAgentSetError('Agent 已创建，但服务端未返回分享链接');
    } else if (registryError) {
      newAgentSetError('Agent 已创建，但' + registryError);
    }
    if (newAgentUrlInput) {
      newAgentUrlInput.focus();
      newAgentUrlInput.select();
    }
  } catch (error) {
    if (seq !== newAgentRequestSeq) return;
    newAgentBusy = false;
    newAgentCreated = false;
    newAgentToken = '';
    newAgentUrl = '';
    if (newAgentUrlInput) newAgentUrlInput.value = '';
    if (newAgentShareInput) newAgentShareInput.value = '';
    if (newAgentSkillUrlInput) newAgentSkillUrlInput.value = '';
    if (newAgentPromptInput) newAgentPromptInput.value = '';
    if (newAgentResultElement) newAgentResultElement.hidden = true;
    if (newAgentCreateButton) {
      newAgentCreateButton.disabled = false;
      newAgentCreateButton.textContent = '创建';
    }
    newAgentSetError('创建失败：' + (error && error.message ? error.message : String(error)));
  }
}

if (newAgentButton) newAgentButton.addEventListener('click', newAgentOpen);
if (newAgentForm) newAgentForm.addEventListener('submit', newAgentCreate);
if (newAgentCloseButton) newAgentCloseButton.addEventListener('click', newAgentClose);
if (newAgentModal) {
  newAgentModal.addEventListener('click', function (event) {
    if (event.target === newAgentModal) newAgentClose();
  });
}
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && newAgentModal && !newAgentModal.hidden) newAgentClose();
});
if (newAgentCopyButton) {
  newAgentCopyButton.addEventListener('click', function () {
    newAgentCopy(newAgentCopyButton, newAgentUrlInput, ' MCP URL ');
  });
}
if (newAgentShareCopyButton) {
  newAgentShareCopyButton.addEventListener('click', function () {
    newAgentCopy(newAgentShareCopyButton, newAgentShareInput, '分享链接');
  });
}
if (newAgentPromptCopyButton) {
  newAgentPromptCopyButton.addEventListener('click', function () {
    newAgentCopy(newAgentPromptCopyButton, newAgentPromptInput, '提示词');
  });
}
`;
