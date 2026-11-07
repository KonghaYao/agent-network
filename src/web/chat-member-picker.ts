import { LIMITS } from '../contracts/limits';

/**
 * 共享成员选择器：建群与添加成员复用同一套行渲染、搜索、分页与多选。
 *
 * 只处理纯 UI 状态，不发 RPC、不做授权；候选数据由调用方读取，服务端
 * 仍会重新校验好友、黑名单、容量与幂等。选择保存在控制器里，因此搜索、
 * “加载更多”和渲染重排都不会丢失已勾选成员。
 *
 * 片段与其它脚本拼进同一个内联 `<script>` 共享作用域。
 */
export const CHAT_MEMBER_PICKER_SCRIPT = `
const MEMBER_PICKER_PAGE_SIZE = ${LIMITS.webMemberPickerPageSize};

function createMemberPicker(options) {
  const settings = options || {};
  const root = settings.root || null;
  const searchInput = settings.search || null;
  const moreButton = settings.more || null;
  const countElement = settings.count || null;
  const selectionElement = settings.selection || null;
  let contacts = [];
  let selected = new Set();
  let excluded = new Set();
  let query = '';
  let limit = MEMBER_PICKER_PAGE_SIZE;
  let note = '';
  let busy = false;

  function selectedIds() {
    return Array.from(selected);
  }

  function notify() {
    if (typeof settings.onChange === 'function') settings.onChange(selectedIds());
  }

  function updateSummary() {
    if (selectionElement) {
      selectionElement.textContent = selected.size > 0
        ? '已选 ' + selected.size + ' 人'
        : '未选择';
    }
    if (root) {
      for (const choice of root.querySelectorAll('.contact-choice')) {
        const input = choice.querySelector('input[type=checkbox]');
        choice.classList.toggle('selected', Boolean(input && input.checked));
      }
    }
  }

  function filteredContacts() {
    return contacts.filter(function (contact) {
      if (!contact || typeof contact.actor_id !== 'string') return false;
      if (excluded.has(contact.actor_id)) return false;
      if (!query) return true;
      return String(contact.name || '').toLowerCase().indexOf(query) >= 0;
    });
  }

  function render() {
    if (!root) return;
    root.replaceChildren();
    const visible = filteredContacts();
    if (countElement) countElement.textContent = String(visible.length);
    if (visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'members-empty';
      empty.textContent = note || settings.empty || '没有可选的成员';
      root.append(empty);
    } else {
      for (const contact of visible.slice(0, limit)) {
        const label = document.createElement('label');
        label.className = 'contact-choice';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = contact.actor_id;
        input.checked = selected.has(contact.actor_id);
        input.disabled = busy;
        if (input.checked) label.classList.add('selected');
        const avatar = avatarElement(
          contact.name,
          contact.kind === 'agent' ? 'agent' : null,
          'avatar contact-avatar'
        );
        const name = document.createElement('span');
        name.className = 'contact-name';
        name.textContent = contact.name;
        const noteElement = document.createElement('span');
        noteElement.className = 'contact-note';
        // 个人备注由 A04 提供；当前没有字段时如实显示“无备注”。
        noteElement.textContent = contact.note ? '备注：' + contact.note : '无备注';
        noteElement.title = noteElement.textContent;
        const kind = document.createElement('span');
        kind.className = 'contact-kind';
        kind.textContent = contact.kind === 'agent' ? 'Agent' : '人';
        label.append(input, avatar, name, noteElement, kind);
        root.append(label);
      }
      if (note && visible.length > 0) {
        const hint = document.createElement('p');
        hint.className = 'members-empty';
        hint.textContent = note;
        root.append(hint);
      }
    }
    if (moreButton) {
      moreButton.hidden = visible.length <= limit;
      moreButton.disabled = busy;
    }
    updateSummary();
    notify();
  }

  function setBusy(next) {
    busy = Boolean(next);
    if (root) root.setAttribute('aria-busy', busy ? 'true' : 'false');
    render();
  }

  if (root) {
    root.addEventListener('change', function (event) {
      const target = event.target;
      if (!target || target.type !== 'checkbox') return;
      if (target.checked) selected.add(target.value);
      else selected.delete(target.value);
      updateSummary();
      notify();
    });
  }
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      query = searchInput.value.trim().toLowerCase();
      limit = MEMBER_PICKER_PAGE_SIZE;
      render();
    });
  }
  if (moreButton) {
    moreButton.addEventListener('click', function () {
      if (busy) return;
      limit += MEMBER_PICKER_PAGE_SIZE;
      render();
    });
  }

  return {
    setContacts(next) {
      contacts = Array.isArray(next) ? next.filter(function (contact) {
        return Boolean(contact) && typeof contact.actor_id === 'string';
      }) : [];
      render();
    },
    setExcluded(ids) {
      excluded = new Set(Array.isArray(ids) ? ids : []);
      render();
    },
    setNote(next) {
      note = next ? String(next) : '';
      render();
    },
    setBusy: setBusy,
    selectedIds: selectedIds,
    clearSelection() {
      selected = new Set();
      if (searchInput) searchInput.value = '';
      query = '';
      limit = MEMBER_PICKER_PAGE_SIZE;
      render();
    },
    reset() {
      contacts = [];
      selected = new Set();
      excluded = new Set();
      query = '';
      limit = MEMBER_PICKER_PAGE_SIZE;
      note = '';
      busy = false;
      if (searchInput) searchInput.value = '';
      render();
    },
    render: render
  };
}
`;
