/**
 * 从好友目录与群成员名单发起单聊。
 *
 * 直接调用 network_room_create 的 direct 幂等键，让服务端复用已有好友单聊；
 * 页面按 FRIEND_REQUIRED / BLOCKED 给出可理解的反馈，不在本地猜测关系权限。
 */
export const CHAT_CONTACT_DIRECTORY_SCRIPT = `
const directChatPending = new Map();
let directChatStatusElement = null;

function directChatStatusTarget(target, message, isError) {
  const element = target && target.isConnected ? target : directChatStatusElement;
  if (!element) return;
  element.textContent = message || '';
  if (isError) element.dataset.error = '1';
  else delete element.dataset.error;
}

function directChatErrorMessage(error) {
  const code = error && error.code;
  if (code === 'FRIEND_REQUIRED') return '你们还不是好友，不能发起单聊。请先建立好友关系。';
  if (code === 'BLOCKED') return '双方存在拉黑关系，无法发起单聊。';
  if (code === 'NOT_FOUND') return '找不到这位群成员，可能已退出或被移除。';
  if (code === 'PERMISSION_DENIED') return '当前关系不允许发起单聊。';
  return '暂时无法发起单聊，请稍后重试。';
}

/** room_create 对 direct pair 幂等：重复入口都会得到相同的 room_id。 */
async function startDirectConversation(actorId, actorName, statusTarget, sourceModal) {
  if (!actorId || !identity) {
    directChatStatusTarget(statusTarget, '请先登录后再发起单聊。', true);
    return;
  }
  if (actorId === identity.actor_id) {
    directChatStatusTarget(statusTarget, '这是你自己，不能向自己发起单聊。', true);
    return;
  }
  const pending = directChatPending.get(actorId);
  if (pending) return pending;

  const ownerId = identity.actor_id;
  const sourceRoomId = activeRoomId;
  const sourceEpoch = roomEpoch;
  const intent = { requestId: requestId('direct') };
  const label = actorName || '这位好友';
  directChatStatusTarget(statusTarget, '正在打开与 ' + label + ' 的单聊…', false);
  const operation = (async function () {
    try {
      const detail = await callTool('network_room_create', {
        request_id: intent.requestId,
        kind: 'direct',
        members: [actorId]
      });
      if (!identity || identity.actor_id !== ownerId || !detail || !detail.room || !detail.room.room_id) {
        return;
      }
      // A delayed create must not pull the user back after they close the source
      // surface or switch rooms while the request is in flight.
      if (activeRoomId !== sourceRoomId || roomEpoch !== sourceEpoch ||
          (sourceModal && sourceModal.hidden)) return;
      const roomId = seedRoomCacheFromDetail(detail);
      if (contactModal && !contactModal.hidden) closeContactModal();
      setRoomFilter('direct');
      navigateTo('/c/' + encodeURIComponent(roomId));
    } catch (error) {
      if (!identity || identity.actor_id !== ownerId) return;
      directChatStatusTarget(statusTarget, directChatErrorMessage(error), true);
    } finally {
      if (directChatPending.get(actorId) === operation) directChatPending.delete(actorId);
    }
  })();
  directChatPending.set(actorId, operation);
  return operation;
}

function addDirectChatAction(row, actor) {
  if (!row || !actor || !actor.actor_id || !identity || actor.actor_id === identity.actor_id) return;
  const actions = document.createElement('div');
  actions.className = 'contact-request-actions';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '发起单聊';
  button.setAttribute('aria-label', '与 ' + (actor.name || '好友') + ' 发起单聊');
  button.addEventListener('click', function () {
    startDirectConversation(actor.actor_id, actor.name, directChatStatusElement, contactModal);
  });
  actions.append(button);
  row.append(actions);
}

if (contactFriendList && !directChatStatusElement) {
  directChatStatusElement = document.createElement('p');
  directChatStatusElement.id = 'direct-chat-status';
  directChatStatusElement.className = 'muted';
  directChatStatusElement.setAttribute('role', 'status');
  directChatStatusElement.setAttribute('aria-live', 'polite');
  contactFriendList.parentElement.insertBefore(directChatStatusElement, contactFriendList);
}
`;
