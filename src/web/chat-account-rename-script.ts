/**
 * 左下角用户姓名编辑：打开弹窗、调用 self-only `network_me_rename`、原地更新显示名。
 *
 * 由 `chatClientScript` 拼进主脚本共享作用域。保存成功只改当前 DOM 与
 * `identity.name`，不重新拉取房间/消息，因此未读、滚动与展开态保持不变；
 * 取消、空名、超长、控制字符与服务端错误都显示可读提示。
 */
export const CHAT_ACCOUNT_RENAME_SCRIPT = `
(function () {
  'use strict';
  var button = document.getElementById('account-rename');
  var modal = document.getElementById('me-rename-modal');
  var form = document.getElementById('me-rename-form');
  var input = document.getElementById('me-rename-input');
  var errorElement = document.getElementById('me-rename-error');
  var cancelButton = document.getElementById('me-rename-cancel');
  var saveButton = document.getElementById('me-rename-save');
  if (!button || !modal || !form || !input || !cancelButton || !saveButton) return;
  var opener = null;
  var busy = false;
  var CONTROL_CHARACTERS = /[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]/;

  function setError(message) {
    if (!errorElement) return;
    errorElement.textContent = message || '';
  }

  function closeDialog(force) {
    if (busy && !force) return;
    modal.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (opener && opener.focus) opener.focus();
    opener = null;
  }

  function openDialog() {
    if (busy || button.hidden || !identity) return;
    opener = document.activeElement;
    input.value = identity.name || '';
    setError('');
    modal.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    input.focus();
    input.select();
  }

  /** 原地更新账号区、自己的消息头像与当前成员列表，不触发网络刷新。 */
  function applyOwnName(name) {
    if (identity) identity.name = name;
    if (identity && members.has(identity.actor_id)) {
      var self = members.get(identity.actor_id);
      if (self) self.name = name;
    }
    if (typeof updateAccount === 'function' && identity) updateAccount(identity);
    if (messagesElement) {
      var avatars = messagesElement.querySelectorAll('.msg.mine .msg-avatar');
      for (var index = 0; index < avatars.length; index += 1) {
        var avatar = avatars[index];
        avatar.textContent = firstChar(name);
        if (typeof applyAgentAvatar !== 'function' ||
            !applyAgentAvatar(avatar, name, identity.kind || 'human')) {
          avatar.style.background = avatarColor(name);
        }
      }
    }
    if (typeof renderCurrentMembers === 'function') renderCurrentMembers();
    if (typeof applyRoomHeader === 'function') applyRoomHeader();
  }

  function saveError(error) {
    var code = error && error.code;
    if (code === 'CREDENTIAL_INVALID') return '身份已失效，请刷新页面后重试。';
    if (code === 'IDEMPOTENCY_CONFLICT') return '保存请求已用于其他修改，请重试。';
    if (code === 'INVALID_ARGUMENT') {
      return error && error.message ? String(error.message) : '姓名不符合要求。';
    }
    var message = error && error.message ? String(error.message) : String(error);
    return '保存失败：' + message;
  }

  function setBusy(value) {
    busy = value;
    input.disabled = value;
    cancelButton.disabled = value;
    saveButton.disabled = value;
    saveButton.textContent = value ? '保存中…' : '保存';
  }

  button.addEventListener('click', openDialog);
  cancelButton.addEventListener('click', function () { closeDialog(false); });
  modal.addEventListener('click', function (event) {
    if (event.target === modal) closeDialog(false);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) closeDialog(false);
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy || !identity) return;
    var name = input.value.trim();
    if (!name) {
      setError('姓名不能为空');
      input.focus();
      return;
    }
    var characters = Array.from(name).length;
    if (characters > ACTOR_NAME_MAX) {
      setError('姓名不能超过 ' + ACTOR_NAME_MAX + ' 个字符');
      input.focus();
      return;
    }
    if (CONTROL_CHARACTERS.test(name)) {
      setError('姓名不能包含控制字符或换行');
      input.focus();
      return;
    }
    if (name === identity.name) {
      closeDialog(false);
      return;
    }
    setError('');
    setBusy(true);
    try {
      var result = await callTool('network_me_rename', {
        request_id: requestId('me_rename'),
        name: name
      });
      var savedName = result && result.name ? String(result.name) : name;
      applyOwnName(savedName);
      setBusy(false);
      closeDialog(true);
    } catch (error) {
      setBusy(false);
      setError(saveError(error));
      input.focus();
    }
  });
})();
`;
