/**
 * 新建 Agent 弹窗的客户端片段。
 *
 * 由 `chatClientScript` 拼进主脚本共享作用域，因此可复用
 * `ensureIdentity`、`callTool`、`requestId` 与 `legacyCopyText`。创建走
 * `network_agent_create`：服务端在同一事务内建立 Agent、管理绑定与初始
 * 凭据。新 Agent 的 token/URL/提示词只保存在本片段的闭包变量与弹窗
 * 输入框/文本区里，关闭即清空；创建成功后把该 Agent 自己的 MCP URL
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
const NEW_AGENT_SKILL_PATH = '/skills/agent-network-skills.md';

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

/** 新版 CLI 接入提示词：下载 agentnet.js，用一次性 token 登录；并声明群聊 @ 规则。 */
function newAgentBuildPrompt(skillUrl, mcpUrl, token, name, actorId) {
  const serverUrl = location.origin;
  const cliUrl = serverUrl + '/skills/agentnet.js';
  return [
    '你是 WeBots Agent。请用新版 agentnet CLI 接入，不要使用旧的 sh 脚本。',
    '',
    '1. 下载最新 CLI：',
    '   curl -fsSL ' + cliUrl + ' -o agentnet.js',
    '2. 用创建时签发的新 token 上线并确认身份：',
    '   AGENTNET_URL="' + serverUrl + '" AGENTNET_TOKEN="' + token + '" bun agentnet.js login',
    '   bun agentnet.js me',
    '3. 只有新建身份时才走首次上线：',
    '   bun agentnet.js --url "' + serverUrl + '" issue',
    '   AGENTNET_TOKEN="<新 token>" bun agentnet.js --url "' + serverUrl +
      '" register --name "<身份名称>" --session "<agent_session_id>"',
    '   AGENTNET_TOKEN="<新 token>" bun agentnet.js --url "' + serverUrl + '" login',
    '',
    '技能文档：' + skillUrl,
    '连接信息：',
    '身份名称：' + name,
    'actor_id：' + actorId,
    'MCP URL：' + mcpUrl,
    'AGENTNET_MCP_URL="' + mcpUrl + '"',
    'AGENTNET_TOKEN="' + token + '"',
    '',
    '群聊 @ 规则：只在需要提醒或派活时 @ 对方；@ 名称必须使用投递里的 sender_name，' +
      '不要凭记忆写；普通回复不要乱 @。',
    '',
    '按技能文档确认身份、把 share_url 发给用户，并在已有订阅下异步监听和处理消息。' +
      '不要重复发明步骤。',
    '凭据只给目标 Agent，勿发群、日志或截图。'
  ].join('\\n');
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
  // 关闭时再对账一次，覆盖会话创建响应丢失或流通知未及时到达；不阻塞关闭。
  loadRooms().catch(function () {});
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
    // 用浏览器 human 身份创建 Agent；服务端在同一事务中绑定管理关系与初始凭据。
    const me = await ensureIdentity();
    if (seq !== newAgentRequestSeq) return;
    const created = await callTool('network_agent_create', {
      request_id: requestId('web_agent_create'),
      name: name
    });
    if (seq !== newAgentRequestSeq) return;
    const token = created && created.token;
    const url = created && created.mcp_url;
    if (typeof token !== 'string' || token.length === 0 ||
        typeof url !== 'string' || url.length === 0) {
      throw new Error('服务端未返回有效的 MCP URL');
    }
    if (!created || typeof created.actor_id !== 'string') {
      throw new Error('创建成功但未返回 actor 信息');
    }
    // token 只在首次响应返回一次；确认后才写入页面字段。
    newAgentToken = token;
    newAgentUrl = url;
    const agentSessionId = typeof created.agent_session_id === 'string'
      ? created.agent_session_id
      : '';
    const registered = {
      actor_id: created.actor_id,
      share_url: created.share_url
    };
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
      newAgentPromptInput.value = newAgentBuildPrompt(
        skillUrl,
        newAgentUrl,
        newAgentToken,
        name,
        registered.actor_id
      );
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
    // 新建 Agent 已由服务端绑定 active manager，direct 会话会在同一事务内
    // 自动建立 auto_manager 关系；不再发好友申请，也不伪造好友成功。
    let roomError = '';
    try {
      const detail = await callTool('network_room_create', {
        request_id: requestId('web_agent_room'),
        kind: 'direct',
        members: [registered.actor_id]
      });
      if (detail && detail.room && typeof detail.room.room_id === 'string') {
        // 先按 head_seq 乐观标记为已读，避免刚创建的会话闪出未读红点。
        detail.room.my_last_read_seq = detail.room.head_seq;
        seedRoomCacheFromDetail(detail);
        let readSeq = detail.room.head_seq;
        try {
          const marked = await callTool('network_room_mark_read', {
            room_id: detail.room.room_id,
            through_seq: detail.room.head_seq
          });
          if (marked && marked.last_read_seq != null) {
            readSeq = String(marked.last_read_seq);
          }
        } catch (error) {
          // 非致命：本地已按 head_seq 视为已读；服务端已读位置仍为 0，
          // 刷新后可能重新出现未读红点。
          if (window.console && console.warn) {
            console.warn('新建 Agent 会话已读同步失败：' +
              (error && error.message ? error.message : String(error)));
          }
        }
        detail.room.my_last_read_seq = readSeq;
        const entry = roomEntries.find(function (item) {
          return item.room_id === detail.room.room_id;
        });
        if (entry) {
          entry.head_seq = detail.room.head_seq;
          entry.my_last_read_seq = readSeq;
          roomEntries = sortRooms(roomEntries);
          renderRooms();
        }
      }
    } catch (error) {
      roomError = error && error.message ? error.message : String(error);
    }
    // 弹窗已在会话创建期间关闭：列表已更新，不再触碰已清空的弹窗字段。
    if (seq !== newAgentRequestSeq) return;
    if (newAgentCreateButton) {
      newAgentCreateButton.disabled = true;
      newAgentCreateButton.textContent = '已创建';
    }
    if (!newAgentShareInput || !newAgentShareInput.value) {
      newAgentSetError('Agent 已创建，但服务端未返回分享链接');
    } else if (roomError || registryError) {
      const warnings = [];
      if (roomError) warnings.push('会话添加失败：' + roomError);
      if (registryError) warnings.push(registryError);
      newAgentSetError('Agent 已创建，但' + warnings.join('；'));
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
