import * as Ariakit from '@ariakit/react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useContacts } from '../../hooks/useContacts';
import type { RoomMember, RoomView } from '../../lib/chat';
import { callTool, type McpError } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';
import { confirmDialog } from './confirm';
import { Modal } from './Modal';

const ROLE_LABEL: Record<RoomMember['role'], string> = {
  owner: '群主',
  admin: '管理员',
  member: '成员',
};

/**
 * 群成员弹窗：读取当前成员，owner/管理员可以从好友里直接加人。
 *
 * 成员增删后只失效 `network_room_get`；消息历史不因成员变化重读。
 */
export function MembersDialog({
  open,
  onOpenChange,
  room,
  members,
  identityId,
  token,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: RoomView;
  members: RoomMember[];
  identityId: string;
  token: string;
}) {
  const queryClient = useQueryClient();
  const contacts = useContacts(open);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const combobox = Ariakit.useComboboxStore({ defaultOpen: false });

  const memberIds = new Set(members.map((member) => member.actor_id));
  const needle = search.trim().toLowerCase();
  const candidates = contacts.contacts.filter(
    (contact) => !memberIds.has(contact.actor_id) && (!needle || contact.name.toLowerCase().includes(needle)),
  );
  const canAdd = room.capabilities?.invite_members === true && !room.read_only;

  const update = async (payload: { add?: string[]; remove?: string[] }, actorName: string) => {
    setError('');
    setBusy(actorName);
    try {
      await callTool(
        'network_room_members_update',
        {
          request_id: newRequestId('web_members'),
          room_id: room.room_id,
          ...payload,
        },
        { token },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) });
      setSearch('');
      combobox.setValue('');
    } catch (failure) {
      setError((failure as McpError).message || '成员操作失败');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (member: RoomMember) => {
    if (busy) return;
    const confirmed = await confirmDialog({
      title: '移除成员',
      message: `确定把「${member.name}」移出群聊？对方会立即失去该群的发言与文件授权。`,
      confirmText: '移除',
      danger: true,
    });
    if (!confirmed) return;
    await update({ remove: [member.actor_id] }, member.actor_id);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="群成员"
      titleId="members-modal-title"
      contentId="members-modal"
      className="members-card"
      footer={
        <div className="row modal-actions">
          <button id="members-close" type="button" onClick={() => onOpenChange(false)}>
            关闭
          </button>
        </div>
      }
    >
      <div id="members-current" className="spa-member-list" role="group" aria-label="当前成员">
        {members.map((member) => (
          <div className="spa-member" key={member.actor_id}>
            <span className="spa-member-name">
              {member.name}
              {member.actor_id === identityId ? '（我）' : ''}
            </span>
            <span className="spa-member-role">{ROLE_LABEL[member.role] ?? '成员'}</span>
            {member.actions?.can_remove ? (
              <button
                type="button"
                className="danger"
                aria-label={`移除 ${member.name}`}
                disabled={busy !== null}
                onClick={() => void remove(member)}
              >
                移除
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {canAdd ? (
        <div className="spa-members-add">
          <label className="field">
            <span>添加成员</span>
            <Ariakit.Combobox
              store={combobox}
              id="members-search"
              placeholder="搜索好友名称"
              autoComplete="off"
              value={search}
              setValueOnChange={false}
              showOnChange={false}
              showOnClick={false}
              onChange={(event) => {
                setSearch(event.currentTarget.value);
                combobox.setInputValue(event.currentTarget.value);
              }}
            />
          </label>
          <div id="members-contacts" className="spa-combobox-list" role="group" aria-label="可添加的好友">
            <Ariakit.ComboboxList store={combobox} alwaysVisible>
              {candidates.map((contact) => (
                <Ariakit.ComboboxItem
                  key={contact.actor_id}
                  className="spa-combobox-item"
                  value={contact.name}
                  onClick={() => void update({ add: [contact.actor_id] }, contact.actor_id)}
                >
                  <span>{contact.name}</span>
                  <span className="mention-kind">{contact.kind === 'agent' ? 'Agent' : '人'}</span>
                </Ariakit.ComboboxItem>
              ))}
            </Ariakit.ComboboxList>
            {contacts.loading ? <p className="list-hint">正在读取好友…</p> : null}
            {!contacts.loading && candidates.length === 0 ? (
              <p className="list-hint">{needle ? '没有匹配的好友' : '没有可添加的好友'}</p>
            ) : null}
            {contacts.hasMore ? (
              <button
                id="members-more"
                className="list-retry"
                type="button"
                disabled={contacts.loadingMore}
                onClick={() => void contacts.loadMore()}
              >
                {contacts.loadingMore ? '正在加载…' : '加载更多好友'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {busy ? <p id="members-status" role="status">正在处理「{busy}」…</p> : null}
      {error ? (
        <p id="members-error" className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
