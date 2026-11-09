/**
 * 群聊 @ 选择器与提及解析（网页端片段）。
 *
 * 与 `chat-script.ts` 其余片段拼进同一个 `<script>` 共享作用域；拆出只为
 * 控制单文件行数，不改变工具契约、DOM id/class 或页面行为。选择器只保存
 * `actor_id`，展示名仅用于插入正文、去重与展示。
 */
export const CHAT_MENTION_SCRIPT = `
function hideMentionPicker() {
  if (mentionPicker) mentionPicker.hidden = true;
  activeMention = null;
}

/** 删除/改写 @ 文本后，旧的同名 actor 选择不能占用下一次选中的目标。 */
function pruneMentionSelections(roomId, text) {
  const selections = mentionSelections.get(roomId);
  if (!selections) return;
  mentionSelections.set(roomId, selections.filter(function (entry) {
    return text.indexOf('@' + entry.name) >= 0;
  }));
}

function updateMentionPicker() {
  if (!mentionPicker || !bodyInput || !room || room.kind !== 'group' || !identity) {
    hideMentionPicker();
    return;
  }
  const value = bodyInput.value;
  const caret = bodyInput.selectionStart === null ? value.length : bodyInput.selectionStart;
  const match = value.slice(0, caret).match(/@([^\\s@]*)$/);
  if (!match) {
    hideMentionPicker();
    return;
  }
  const query = match[1];
  activeMention = { start: caret - query.length - 1, end: caret };
  const lower = query.toLowerCase();
  const candidates = [];
  for (const member of members.values()) {
    if (member.actor_id === identity.actor_id) continue;
    if (lower && member.name.toLowerCase().indexOf(lower) < 0) continue;
    candidates.push(member);
  }
  mentionPicker.replaceChildren();
  if (candidates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'list-hint';
    empty.textContent = query ? '没有匹配成员' : '房间还没有其他成员';
    mentionPicker.append(empty);
  } else {
    for (const member of candidates.slice(0, 20)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mention-item';
      item.setAttribute('role', 'option');
      const selected = mentionSelectionsFor(activeRoomId).some(function (entry) {
        return entry.actor_id === member.actor_id;
      });
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected) item.classList.add('selected');
      const name = document.createElement('span');
      name.textContent = member.name;
      const kind = document.createElement('span');
      kind.className = 'mention-kind';
      kind.textContent = member.kind === 'agent' ? 'Agent' : '人';
      item.append(name, kind);
      item.addEventListener('click', function () { insertMention(member); });
      mentionPicker.append(item);
    }
  }
  mentionPicker.hidden = false;
}

function insertMention(member) {
  if (!activeMention || !bodyInput || !activeRoomId) return;
  const selections = mentionSelectionsFor(activeRoomId);
  const index = selections.findIndex(function (item) { return item.actor_id === member.actor_id; });
  const selection = { actor_id: member.actor_id, name: member.name, kind: member.kind };
  if (index >= 0) {
    // 新选择拥有新对象，旧发送只能消费其提交时捕获的选择。
    selections[index] = selection;
  } else {
    selections.push(selection);
  }
  const value = bodyInput.value;
  const insert = '@' + member.name + ' ';
  bodyInput.value = value.slice(0, activeMention.start) + insert + value.slice(activeMention.end);
  const position = activeMention.start + insert.length;
  bodyInput.setSelectionRange(position, position);
  if (activeRoomId) {
    drafts.set(activeRoomId, bodyInput.value);
    draftSave(activeRoomId, bodyInput.value);
  }
  hideMentionPicker();
  resizeComposer();
  bodyInput.focus();
}

function mentionSelectionsFor(roomId) {
  let selections = mentionSelections.get(roomId);
  if (!selections) {
    selections = [];
    mentionSelections.set(roomId, selections);
  }
  return selections;
}

/**
 * 只保留正文中仍然存在的选择器目标。
 *
 * 同名成员按 token 出现次数分配：先选中的先占用；删除一个「@名字」只移除
 * 一个目标。长名字先匹配，避免「@小明」抢占「@小明 同学」的出现位置。
 * 返回的 actor_id 是发送的唯一依据，展示名变化不会把目标指向别人。
 */
function resolvedMentionSelection(roomId, body) {
  const selections = mentionSelectionsFor(roomId);
  if (selections.length === 0) return { items: [], error: null };
  for (const selection of selections) {
    const member = members.get(selection.actor_id);
    if (!member || member.status === 'removed' || member.status === 'left') {
      return { items: [], error: '所选成员已不在房间，请重新选择' };
    }
    selection.name = member.name;
    selection.kind = member.kind;
  }
  const byName = new Map();
  for (const selection of selections) {
    const list = byName.get(selection.name) || [];
    list.push(selection);
    byName.set(selection.name, list);
  }
  const names = Array.from(byName.keys()).sort(function (a, b) {
    return b.length - a.length;
  });
  const used = new Array(body.length).fill(false);
  const counts = new Map();
  for (const name of names) {
    const token = '@' + name;
    let from = 0;
    let count = 0;
    while (from <= body.length - token.length) {
      const at = body.indexOf(token, from);
      if (at < 0) break;
      let overlap = false;
      for (let index = at; index < at + token.length; index += 1) {
        if (used[index]) {
          overlap = true;
          break;
        }
      }
      if (!overlap) {
        for (let index = at; index < at + token.length; index += 1) used[index] = true;
        count += 1;
      }
      from = at + token.length;
    }
    counts.set(name, count);
  }
  const kept = [];
  for (const name of names) {
    const list = byName.get(name) || [];
    const count = counts.get(name) || 0;
    for (let index = 0; index < Math.min(count, list.length); index += 1) {
      kept.push(list[index]);
    }
  }
  return { items: kept, error: null };
}
`;
