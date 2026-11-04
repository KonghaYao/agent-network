/**
 * 会话列表右键菜单：复制让 Agent 接入当前房间的提示词。
 *
 * 事件委托挂在 `#room-list` 上，`renderRooms` 重建列表后无需重新绑定。
 * 桌面右键与移动端长按 500ms 打开同一菜单。direct Agent 会话与群聊会从
 * 本地 Agents 注册表查找当前 human 保存的 Agent MCP URL，把 URL 与 token
 * 写进提示词；菜单本身不展示凭据，凭据只进入剪贴板。
 */
export const CHAT_ROOM_MENU_SCRIPT = `
const ROOM_MENU_LONG_PRESS_MS = 500;
const ROOM_MENU_MARGIN = 8;
const ROOM_MENU_COPY_LABEL = '复制 Agent 连接提示词';
const ROOM_MENU_COPYING_LABEL = '正在准备…';
const ROOM_MENU_COPIED_LABEL = '已复制';
const ROOM_MENU_COPIED_WITH_CREDENTIALS = '已复制（含凭据，勿转发）';
const ROOM_MENU_COPIED_WITHOUT_CREDENTIALS = '已复制（未包含凭据）';
const ROOM_MENU_MISSING_CREDENTIALS =
  '本浏览器没有保存该 Agent 的 token/MCP URL；请让用户提供，或让用户新建 Agent 并把提示词给你。';
// URL 会被放进 shell 的双引号 export 行；只接受生成器会产出的 ASCII 字符集，
// 排除引号、反引号、反斜杠、$ 与空白，避免把 localStorage 内容当命令执行。
const ROOM_MENU_SAFE_URL_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~:/?#[]@!&'()*+,;=%-";

let roomMenuTarget = null;
let roomMenuAnchor = null;
let roomMenuPressTimer = null;
let roomMenuPressPoint = null;
let roomMenuSuppressClickUntil = 0;
let roomMenuBusy = false;

function roomMenuNode() {
  return document.getElementById('room-menu');
}

function roomMenuResetStatus() {
  const status = document.getElementById('room-menu-status');
  if (!status) return;
  status.textContent = '';
  status.hidden = true;
  status.classList.remove('error', 'ok');
}

function closeRoomMenu() {
  const menu = roomMenuNode();
  if (roomMenuPressTimer) {
    clearTimeout(roomMenuPressTimer);
    roomMenuPressTimer = null;
  }
  roomMenuPressPoint = null;
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  roomMenuTarget = null;
  roomMenuAnchor = null;
  roomMenuBusy = false;
  const button = document.getElementById('room-menu-copy-prompt');
  if (button) {
    button.textContent = ROOM_MENU_COPY_LABEL;
    button.disabled = false;
  }
  roomMenuResetStatus();
}

/** 菜单靠近光标显示；越界时向左/向上翻转，保证不溢出视口。 */
function positionRoomMenu(menu, x, y) {
  menu.hidden = false;
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  let left = x;
  let top = y;
  if (left + rect.width + ROOM_MENU_MARGIN > viewportWidth) {
    left = viewportWidth - rect.width - ROOM_MENU_MARGIN;
  }
  if (left < ROOM_MENU_MARGIN) left = ROOM_MENU_MARGIN;
  if (top + rect.height + ROOM_MENU_MARGIN > viewportHeight) top = y - rect.height;
  if (top < ROOM_MENU_MARGIN) top = ROOM_MENU_MARGIN;
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}

function openRoomMenu(link, x, y) {
  const menu = roomMenuNode();
  const button = document.getElementById('room-menu-copy-prompt');
  if (!menu || !button) return;
  const roomId = link.getAttribute('data-room-id') || '';
  if (!roomId) return;
  const kind = link.getAttribute('data-room-kind');
  const roomName = (link.getAttribute('data-room-name') || '').trim() ||
    (kind === 'group' ? '群聊' : '单聊');
  const entry = roomEntries.find(function (item) { return item.room_id === roomId; });
  roomMenuTarget = {
    roomId: roomId,
    roomName: roomName,
    kind: kind,
    peer_actor_id: entry ? entry.peer_actor_id : null,
    peer_kind: entry ? entry.peer_kind : null
  };
  roomMenuAnchor = link;
  roomMenuBusy = false;
  button.textContent = ROOM_MENU_COPY_LABEL;
  button.disabled = false;
  roomMenuResetStatus();
  positionRoomMenu(menu, x, y);
  try {
    button.focus({ preventScroll: true });
  } catch (error) {
    button.focus();
  }
}

/** 从本地保存的 MCP URL 提取 URL 与 query token；格式异常时返回 null。 */
function roomMenuCredential(mcpUrl) {
  if (typeof mcpUrl !== 'string' || mcpUrl.length === 0) return null;
  for (const char of mcpUrl) {
    if (ROOM_MENU_SAFE_URL_CHARS.indexOf(char) < 0) return null;
  }
  let parsed = null;
  try {
    parsed = new URL(mcpUrl);
  } catch (error) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const token = parsed.searchParams.get('token') || '';
  if (!/^[A-Za-z0-9._~-]+$/.test(token)) return null;
  return { mcpUrl: mcpUrl, token: token };
}

function roomMenuPeerFromDetail(detail, me) {
  const members = detail && Array.isArray(detail.members) ? detail.members : [];
  const others = members.filter(function (member) {
    return member && member.actor_id !== me.actor_id;
  });
  return others.length === 1 ? others[0] : null;
}

/**
 * 解析提示词凭据：direct 找对方 Agent，group 找房间内第一个有本地
 * MCP URL 的 Agent。需要房间详情且读取失败时抛出，由调用方显示错误。
 */
async function roomMenuCredentialFor(target, me) {
  const read = agentRegistryItems(me.actor_id);
  const byActor = new Map();
  for (const item of read.items) {
    const credential = roomMenuCredential(item.mcp_url);
    if (credential) {
      byActor.set(item.actor_id, {
        mcpUrl: credential.mcpUrl,
        token: credential.token,
        name: item.name,
        actorId: item.actor_id
      });
    }
  }
  if (target.kind === 'direct') {
    let peer = target.peer_actor_id
      ? { actor_id: target.peer_actor_id, kind: target.peer_kind }
      : null;
    if (!peer || !peer.kind) {
      const detail = await callTool('network_room_get', { room_id: target.roomId });
      peer = roomMenuPeerFromDetail(detail, me);
    }
    if (!peer || peer.kind !== 'agent') return null;
    return byActor.get(peer.actor_id) || null;
  }
  const detail = await callTool('network_room_get', { room_id: target.roomId });
  const members = detail && Array.isArray(detail.members) ? detail.members : [];
  for (const member of members) {
    if (member && member.kind === 'agent' && byActor.has(member.actor_id)) {
      return byActor.get(member.actor_id);
    }
  }
  return null;
}

/** 提示词只引用技能文档，附恢复连接所需信息；不重复技能里的工具步骤。 */
function roomAgentPrompt(roomId, roomName, credential) {
  const skillUrl = location.origin + '/skills/agent-network-curl.md';
  let prompt = '你是 WeBots Agent。请先阅读并严格按技能文档执行：\\n' +
    skillUrl + '\\n\\n连接信息：\\n';
  if (credential) {
    prompt += 'AGENTNET_MCP_URL="' + credential.mcpUrl + '"\\n' +
      'AGENTNET_TOKEN="' + credential.token + '"\\n' +
      '房间：' + roomId + '（' + roomName + '）\\n' +
      '你的 Agent 身份：' + credential.name + '（' + credential.actorId + '）\\n\\n' +
      '按技能文档恢复连接并处理该房间消息。不要重复发明步骤。\\n' +
      '凭据只给目标 Agent，勿发群、日志或截图。';
  } else {
    prompt += ROOM_MENU_MISSING_CREDENTIALS + '\\n' +
      '房间：' + roomId + '（' + roomName + '）\\n\\n' +
      '按技能文档恢复连接并处理该房间消息。不要重复发明步骤。';
  }
  return prompt;
}

async function copyRoomAgentPrompt() {
  const target = roomMenuTarget;
  if (!target || roomMenuBusy) return;
  const status = document.getElementById('room-menu-status');
  const button = document.getElementById('room-menu-copy-prompt');
  roomMenuBusy = true;
  if (button) {
    button.disabled = true;
    button.textContent = ROOM_MENU_COPYING_LABEL;
  }
  roomMenuResetStatus();
  let copied = false;
  try {
    const me = await ensureIdentity();
    if (roomMenuTarget !== target) return;
    const credential = await roomMenuCredentialFor(target, me);
    if (roomMenuTarget !== target) return;
    const prompt = roomAgentPrompt(target.roomId, target.roomName, credential);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(prompt);
      } catch (error) {
        legacyCopyText(prompt);
      }
    } else {
      legacyCopyText(prompt);
    }
    if (roomMenuTarget !== target) return;
    copied = true;
    if (status) {
      status.textContent = credential
        ? ROOM_MENU_COPIED_WITH_CREDENTIALS
        : ROOM_MENU_COPIED_WITHOUT_CREDENTIALS;
      status.hidden = false;
      status.classList.remove('error');
      status.classList.add('ok');
    }
    if (button) button.textContent = ROOM_MENU_COPIED_LABEL;
  } catch (error) {
    if (roomMenuTarget === target && status) {
      status.textContent = '准备提示词失败：' +
        (error && error.message ? error.message : String(error));
      status.hidden = false;
      status.classList.remove('ok');
      status.classList.add('error');
    }
  } finally {
    roomMenuBusy = false;
    if (button) {
      button.disabled = false;
      if (!copied && roomMenuTarget === target) button.textContent = ROOM_MENU_COPY_LABEL;
    }
  }
}

function clearRoomMenuPress() {
  if (roomMenuPressTimer) {
    clearTimeout(roomMenuPressTimer);
    roomMenuPressTimer = null;
  }
  roomMenuPressPoint = null;
}

if (roomListElement) {
  roomListElement.addEventListener('contextmenu', function (event) {
    const link = event.target instanceof Element ? event.target.closest('a.room-item') : null;
    if (!link || !roomListElement.contains(link)) return;
    event.preventDefault();
    clearRoomMenuPress();
    openRoomMenu(link, event.clientX, event.clientY);
  });

  // 移动端没有右键：按住 500ms 打开同一菜单；移动超过 8px 视为滚动/拖拽。
  roomListElement.addEventListener('pointerdown', function (event) {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const link = event.target instanceof Element ? event.target.closest('a.room-item') : null;
    if (!link) return;
    clearRoomMenuPress();
    const x = event.clientX;
    const y = event.clientY;
    roomMenuPressPoint = { x: x, y: y };
    roomMenuPressTimer = setTimeout(function () {
      roomMenuPressTimer = null;
      roomMenuPressPoint = null;
      // 长按结束后浏览器仍会补发 click，阻止它跳转。
      roomMenuSuppressClickUntil = Date.now() + 600;
      openRoomMenu(link, x, y);
    }, ROOM_MENU_LONG_PRESS_MS);
  });
  roomListElement.addEventListener('pointermove', function (event) {
    if (!roomMenuPressPoint) return;
    if (Math.abs(event.clientX - roomMenuPressPoint.x) > 8 ||
      Math.abs(event.clientY - roomMenuPressPoint.y) > 8) {
      clearRoomMenuPress();
    }
  });
  roomListElement.addEventListener('pointerup', clearRoomMenuPress);
  roomListElement.addEventListener('pointercancel', clearRoomMenuPress);
  roomListElement.addEventListener('click', function (event) {
    if (Date.now() >= roomMenuSuppressClickUntil) return;
    const link = event.target instanceof Element ? event.target.closest('a.room-item') : null;
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
  });
}

const roomMenuCopyButton = document.getElementById('room-menu-copy-prompt');
if (roomMenuCopyButton) {
  roomMenuCopyButton.addEventListener('click', function () {
    copyRoomAgentPrompt().catch(function () {});
  });
}

document.addEventListener('pointerdown', function (event) {
  const menu = roomMenuNode();
  if (!menu || menu.hidden) return;
  if (event.target instanceof Node && menu.contains(event.target)) return;
  closeRoomMenu();
}, true);

document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;
  const menu = roomMenuNode();
  if (!menu || menu.hidden) return;
  const anchor = roomMenuAnchor;
  event.preventDefault();
  closeRoomMenu();
  if (anchor && document.contains(anchor)) {
    try {
      anchor.focus({ preventScroll: true });
    } catch (error) {
      anchor.focus();
    }
  }
});

// 滚动（含侧栏内部滚动）与窗口尺寸变化都会让菜单失去定位参照，直接关闭。
document.addEventListener('scroll', function () {
  clearRoomMenuPress();
  closeRoomMenu();
}, true);
window.addEventListener('resize', closeRoomMenu);
`;
