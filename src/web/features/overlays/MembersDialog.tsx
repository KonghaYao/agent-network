import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { accountAvatarFor } from '../../lib/agent-avatar';
import { useContacts } from '../../hooks/useContacts';
import type { OwnerTransferView, RoomMember, RoomView } from '../../lib/chat';
import { callTool, type McpError } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';
import { avatarColor, firstChar } from '../../lib/rooms';
import { confirmDialog } from './confirm';
import { GroupInvitesPanel } from './GroupInvitesPanel';
import { GroupPoliciesPanel } from './GroupPoliciesPanel';
import { Modal } from './Modal';

const ROLE_LABEL: Record<RoomMember['role'], string> = {
  owner: '群主',
  admin: '管理员',
  member: '成员',
};

/** 成员/候选行头像；品牌图标加载失败时保留首字。 */
function MemberAvatar({
  name,
  kind,
  className,
}: {
  name: string;
  kind: RoomMember['kind'];
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  const spec = accountAvatarFor(name, kind);
  const showImage = spec !== null && !failed;
  return (
    <span
      className={`avatar ${className}${showImage ? ' avatar-icon' : ''}`.trim()}
      aria-hidden="true"
      style={showImage ? undefined : { background: avatarColor(name) }}
    >
      {firstChar(name)}
      {showImage ? (
        <img
          className="avatar-img"
          src={spec.src}
          alt=""
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}

function roleText(member: RoomMember): string {
  const role = ROLE_LABEL[member.role] ?? '成员';
  return member.kind === 'agent' ? `${role} · Agent` : role;
}

/**
 * 群成员弹窗：legacy 双栏「已在群 / 未在群」，右侧勾选后一次提交。
 *
 * 成员增删后只失效 `network_room_get`；消息历史不因成员变化重读。
 * 邀请与策略面板仍在滚动区内，底部动作固定可见。
 */
export function MembersDialog({
  open,
  onOpenChange,
  room,
  members,
  ownerTransfer,
  identityId,
  token,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: RoomView;
  members: RoomMember[];
  ownerTransfer: OwnerTransferView | null;
  identityId: string;
  token: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const contacts = useContacts(open);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  const [candidateSearch, setCandidateSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [successor, setSuccessor] = useState('');
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const memberIds = new Set(members.map((member) => member.actor_id));
  const memberNeedle = memberSearch.trim().toLowerCase();
  const visibleMembers = memberNeedle
    ? members.filter((member) => member.name.toLowerCase().includes(memberNeedle))
    : members;
  const candidateNeedle = candidateSearch.trim().toLowerCase();
  const candidates = contacts.contacts.filter(
    (contact) =>
      !memberIds.has(contact.actor_id) &&
      (!candidateNeedle || contact.name.toLowerCase().includes(candidateNeedle)),
  );
  const selectedSet = new Set(selected);
  const canAdd = room.capabilities?.invite_members === true && !room.read_only;

  useEffect(() => {
    if (!open) return;
    setMemberSearch('');
    setCandidateSearch('');
    setSelected([]);
    setError('');
  }, [open, room.room_id]);

  // 成员列表被刷新后，已加入的人不再保留在勾选状态。
  useEffect(() => {
    const ids = new Set(members.map((member) => member.actor_id));
    setSelected((current) => {
      const next = current.filter((actorId) => !ids.has(actorId));
      return next.length === current.length ? current : next;
    });
  }, [members]);

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
      setCandidateSearch('');
    } catch (failure) {
      setError((failure as McpError).message || '成员操作失败');
    } finally {
      setBusy(null);
    }
  };

  const addMembers = async () => {
    if (!canAdd || busy !== null || selected.length === 0) return;
    setError('');
    setBusy('add');
    try {
      await callTool(
        'network_room_members_update',
        {
          request_id: newRequestId('web_members'),
          room_id: room.room_id,
          add: selected,
        },
        { token },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) });
      setSelected([]);
      setCandidateSearch('');
    } catch (failure) {
      // 失败保留勾选，用户可以直接重试。
      setError((failure as McpError).message || '添加成员失败');
    } finally {
      setBusy(null);
    }
  };

  const toggleCandidate = (actorId: string, checked: boolean) => {
    setSelected((current) => {
      if (checked) return current.includes(actorId) ? current : [...current, actorId];
      return current.filter((id) => id !== actorId);
    });
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

  const setRole = async (member: RoomMember, role: 'admin' | 'member') => {
    if (busy) return;
    if (!member.role_revision) {
      setError('成员角色版本缺失，请关闭弹窗后重新打开再试。');
      return;
    }
    setBusy(`${role}-${member.actor_id}`);
    setError('');
    try {
      await callTool(
        'network_room_role_set',
        {
          request_id: newRequestId('web_room_role'),
          room_id: room.room_id,
          actor_id: member.actor_id,
          role,
          expected_role_revision: member.role_revision,
        },
        { token },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) });
    } catch (failure) {
      setError(
        (failure as McpError).message ||
          (role === 'admin' ? '设置管理员失败' : '撤销管理员失败'),
      );
    } finally {
      setBusy(null);
    }
  };

  const dissolve = async () => {
    if (busy || room.can_dissolve !== true) return;
    const confirmed = await confirmDialog({
      title: '解散群聊',
      message:
        '解散群聊后：\n· 所有成员立即失去新的发言、邀请与文件写入权限\n· 待处理投递与邀请链接、入群申请立即失效\n· 解散时仍在群的成员保留截至解散点的只读归档；此前已退群/被移除者无归档资格\n· 已下载到本地的文件副本无法收回\n\n解散不删除消息、文件或成果。确定解散？',
      confirmText: '解散群聊',
      danger: true,
    });
    if (!confirmed) return;
    setBusy('dissolve');
    setError('');
    try {
      await callTool(
        'network_room_dissolve',
        { request_id: newRequestId('web_room_dissolve'), room_id: room.room_id },
        { token },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identityId) }),
      ]);
      onOpenChange(false);
    } catch (failure) {
      setError((failure as McpError).message || '解散群聊失败');
    } finally {
      setBusy(null);
    }
  };

  const transferCandidates = members.filter(
    (member) => member.role !== 'owner' && member.actions?.can_transfer_owner === true,
  );

  const transferRequest = async (action: 'accept' | 'reject') => {
    if (!ownerTransfer || busy) return;
    setBusy(`transfer-${action}`);
    setError('');
    try {
      await callTool(
        'network_room_owner_transfer_respond',
        {
          request_id: newRequestId('web_owner_transfer'),
          transfer_id: ownerTransfer.transfer_id,
          action,
          expected_version: ownerTransfer.version,
        },
        { token },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) });
    } catch (failure) {
      setError((failure as McpError).message || '群主转让操作失败');
    } finally {
      setBusy(null);
    }
  };

  const transferCancel = async () => {
    if (!ownerTransfer || busy) return;
    setBusy('transfer-cancel');
    setError('');
    try {
      await callTool(
        'network_room_owner_transfer_cancel',
        {
          request_id: newRequestId('web_owner_transfer'),
          transfer_id: ownerTransfer.transfer_id,
          expected_version: ownerTransfer.version,
        },
        { token },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) });
    } catch (failure) {
      setError((failure as McpError).message || '取消群主转让失败');
    } finally {
      setBusy(null);
    }
  };

  const transferPropose = async (targetActorId: string) => {
    const target = transferCandidates.find((member) => member.actor_id === targetActorId);
    if (!target || busy) return;
    setBusy('transfer-propose');
    setError('');
    try {
      await callTool(
        'network_room_owner_transfer_propose',
        {
          request_id: newRequestId('web_owner_transfer'),
          room_id: room.room_id,
          target_actor_id: target.actor_id,
          ...(target.role_revision ? { expected_role_revision: target.role_revision } : {}),
        },
        { token },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) });
    } catch (failure) {
      setError((failure as McpError).message || '发起群主转让失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="群成员"
      titleId="members-modal-title"
      contentId="members-modal"
      className="members-card"
      closeId="members-close"
      closeButtonRef={closeButtonRef}
      initialFocusRef={closeButtonRef}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          {busy ? (
            <p id="members-status" className="members-status" role="status">
              {busy === 'add' ? '正在添加成员…' : `正在处理「${busy}」…`}
            </p>
          ) : null}
          {error ? (
            <p id="members-error" className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row modal-actions members-actions">
            <span
              id="members-selection"
              className="members-selection"
              role="status"
              aria-live="polite"
            >
              {selected.length > 0 ? `已选 ${selected.length} 人` : '未选择'}
            </span>
            {room.can_dissolve === true && !room.read_only ? (
              <button
                id="group-dissolve"
                className="danger"
                type="button"
                disabled={busy !== null}
                onClick={() => void dissolve()}
              >
                解散群聊
              </button>
            ) : null}
            <button
              id="members-cancel"
              type="button"
              disabled={busy !== null}
              onClick={() => onOpenChange(false)}
            >
              取消
            </button>
            <button
              id="members-add"
              className="primary"
              type="button"
              disabled={!canAdd || busy !== null || selected.length === 0}
              onClick={() => void addMembers()}
            >
              {busy === 'add' ? '正在添加…' : '添加'}
            </button>
          </div>
        </>
      }
    >
      <div className="members-scroll">
        <div className="members-columns">
          <section className="members-column" aria-labelledby="members-current-title">
            <header className="members-column-head">
              <h3 id="members-current-title">已在群</h3>
              <span
                id="members-current-count"
                className="members-count"
                aria-live="polite"
              >
                {members.length}
              </span>
            </header>
            <input
              id="members-current-search"
              className="member-picker-search"
              type="search"
              placeholder="搜索群成员"
              aria-label="搜索群成员"
              autoComplete="off"
              value={memberSearch}
              onChange={(event) => setMemberSearch(event.target.value)}
            />
            <ul id="members-current" className="member-roster" aria-label="当前群成员">
              {visibleMembers.map((member) => {
                const actions = member.actions ?? null;
                return (
                  <li className="member-roster-item spa-member" key={member.actor_id}>
                    <MemberAvatar
                      name={member.name}
                      kind={member.kind}
                      className="member-avatar"
                    />
                    <span className="member-roster-name">
                      {member.name}
                      {member.actor_id === identityId ? '（我）' : ''}
                    </span>
                    <span className="member-roster-role">{roleText(member)}</span>
                    {actions &&
                    (actions.can_set_admin ||
                      actions.can_revoke_admin ||
                      actions.can_remove) ? (
                      <span className="member-roster-actions">
                        {actions.can_set_admin ? (
                          <button
                            className="member-action"
                            type="button"
                            title="设为管理员"
                            aria-label={`设为管理员 ${member.name}`}
                            disabled={busy !== null}
                            onClick={() => void setRole(member, 'admin')}
                          >
                            管
                          </button>
                        ) : null}
                        {actions.can_revoke_admin ? (
                          <button
                            className="member-action"
                            type="button"
                            title="撤销管理员"
                            aria-label={`撤销管理员 ${member.name}`}
                            disabled={busy !== null}
                            onClick={() => void setRole(member, 'member')}
                          >
                            撤
                          </button>
                        ) : null}
                        {actions.can_remove ? (
                          <button
                            className="member-action danger"
                            type="button"
                            title="移出群聊"
                            aria-label={`移除 ${member.name}`}
                            disabled={busy !== null}
                            onClick={() => void remove(member)}
                          >
                            ×
                          </button>
                        ) : null}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {visibleMembers.length === 0 ? (
              <p id="members-current-empty" className="members-empty" role="status">
                {memberNeedle ? '没有匹配的群成员' : '群里还没有成员'}
              </p>
            ) : null}

            {room.kind === 'group' &&
            !room.read_only &&
            (ownerTransfer ||
              (room.my_role === 'owner' && transferCandidates.length > 0)) ? (
              <section id="members-transfer" className="members-transfer" aria-live="polite">
                {ownerTransfer ? (
                  <>
                    <h3 className="members-transfer-title">群主转让</h3>
                    <p className="members-transfer-line">
                      「{ownerTransfer.from_owner_name}」提议把群主转让给「
                      {ownerTransfer.to_actor_name}」。
                    </p>
                    <p className="members-transfer-meta">
                      状态 {ownerTransfer.status}；接受前群主不变。
                    </p>
                    <div className="members-transfer-actions">
                      {ownerTransfer.can_accept ? (
                        <button
                          className="primary"
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void transferRequest('accept')}
                        >
                          接受转让
                        </button>
                      ) : null}
                      {ownerTransfer.can_reject ? (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void transferRequest('reject')}
                        >
                          拒绝
                        </button>
                      ) : null}
                      {ownerTransfer.can_cancel ? (
                        <button
                          className="danger"
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void transferCancel()}
                        >
                          取消转让
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <>
                    <h3 className="members-transfer-title">群主转让</h3>
                    <p className="members-transfer-meta">
                      选择一位成员接任群主；对方接受后才会生效。
                    </p>
                    <div className="row">
                      <select
                        id="members-transfer-select"
                        aria-label="选择群主接任者"
                        value={successor}
                        onChange={(event) => setSuccessor(event.target.value)}
                      >
                        <option value="">选择接任者</option>
                        {transferCandidates.map((member) => (
                          <option value={member.actor_id} key={member.actor_id}>
                            {member.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="primary"
                        id="members-transfer-propose"
                        type="button"
                        disabled={busy !== null || !successor}
                        onClick={() => void transferPropose(successor)}
                      >
                        发起转让
                      </button>
                    </div>
                  </>
                )}
              </section>
            ) : null}
          </section>

          <section className="members-column" aria-labelledby="members-candidates-title">
            <header className="members-column-head">
              <h3 id="members-candidates-title">未在群</h3>
              <span id="members-contacts-count" className="members-count" aria-live="polite">
                {canAdd ? candidates.length : 0}
              </span>
            </header>
            <input
              id="members-search"
              className="member-picker-search"
              type="search"
              placeholder="搜索好友名称"
              aria-label="搜索好友名称"
              autoComplete="off"
              disabled={!canAdd || contacts.loading}
              value={candidateSearch}
              onChange={(event) => setCandidateSearch(event.target.value)}
            />
            <div
              id="members-contacts"
              className="contact-list"
              role="group"
              aria-label="可添加的好友"
            >
              {!canAdd ? (
                <p className="members-empty" role="status">
                  {room.read_only
                    ? '群已解散，成员列表只读'
                    : '当前群设置不允许你邀请成员'}
                </p>
              ) : (
                <>
                  {candidates.map((contact) => (
                    <label
                      className={`contact-choice${selectedSet.has(contact.actor_id) ? ' selected' : ''}`}
                      key={contact.actor_id}
                    >
                      <input
                        type="checkbox"
                        value={contact.actor_id}
                        checked={selectedSet.has(contact.actor_id)}
                        disabled={busy !== null}
                        onChange={(event) =>
                          toggleCandidate(contact.actor_id, event.target.checked)
                        }
                      />
                      <MemberAvatar
                        name={contact.name}
                        kind={contact.kind}
                        className="contact-avatar"
                      />
                      <span className="contact-name">{contact.name}</span>
                      <span className="contact-kind">
                        {contact.kind === 'agent' ? 'Agent' : '人'}
                      </span>
                    </label>
                  ))}
                  {contacts.loading ? (
                    <p className="members-empty">正在读取好友…</p>
                  ) : null}
                  {!contacts.loading && candidates.length === 0 ? (
                    <p className="members-empty">
                      {candidateNeedle
                        ? '没有匹配的成员'
                        : contacts.hasMore
                          ? '当前页没有可添加的好友，可加载更多。'
                          : '没有可添加的好友：好友都已在群里。'}
                    </p>
                  ) : null}
                  {contacts.error ? (
                    <p className="members-empty" role="alert">
                      {contacts.error}
                    </p>
                  ) : null}
                </>
              )}
            </div>
            {canAdd && contacts.hasMore ? (
              <button
                id="members-more"
                className="member-picker-more"
                type="button"
                disabled={contacts.loadingMore || busy !== null}
                onClick={() => void contacts.loadMore()}
              >
                {contacts.loadingMore ? '正在加载…' : '加载更多'}
              </button>
            ) : null}
          </section>
        </div>

        <GroupInvitesPanel room={room} token={token} active={open} />
        <GroupPoliciesPanel room={room} token={token} active={open} />
      </div>
    </Modal>
  );
}
