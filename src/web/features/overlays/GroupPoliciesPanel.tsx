import { Button, Select as LensoSelect } from '../../app/lenso-controls';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';

import type { RoomView } from '../../lib/chat';
import { callTool, type McpError } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';

type MemberPolicy = 'members' | 'owner_admin';
type HistoryPolicy = 'from_join' | 'full';
type JoinPolicy = 'open' | 'approval';

interface PolicyForm {
  member_message: MemberPolicy;
  member_invite: MemberPolicy;
  member_history: HistoryPolicy;
  member_join: JoinPolicy;
  member_profile: MemberPolicy;
  member_mention_all: MemberPolicy;
}

const DEFAULTS: PolicyForm = {
  member_message: 'members',
  member_invite: 'members',
  member_history: 'full',
  member_join: 'open',
  member_profile: 'members',
  member_mention_all: 'owner_admin',
};

function formOf(room: RoomView): PolicyForm {
  const policies = room.policies;
  if (!policies) return DEFAULTS;
  return {
    member_message: policies.member_message,
    member_invite: policies.member_invite,
    member_history: policies.member_history,
    member_join: policies.member_join,
    member_profile: policies.member_profile,
    member_mention_all: policies.member_mention_all,
  };
}

function failureText(error: unknown): string {
  return (error as McpError).message || String(error);
}

function Select<T extends string>({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <LensoSelect
        id={id}
        aria-label={label}
        value={value}
        disabled={disabled}
        options={options}
        onChange={(next) => onChange(next as T)}
      />
    </div>
  );
}

/**
 * 群主设置普通成员策略。
 *
 * 策略版本来自 `network_room_get`；保存时必须带同一 revision，服务端在
 * 事务内复核，避免并发修改被静默覆盖。历史策略收紧会立即影响加入前的
 * 消息与文件可见性，页面不缓存旧范围的正文。
 */
export function GroupPoliciesPanel({
  room,
  token,
  active,
}: {
  room: RoomView;
  token: string;
  active: boolean;
}) {
  const canManage = room.capabilities?.manage_policy === true && !room.read_only;
  const queryClient = useQueryClient();
  const [form, setForm] = useState<PolicyForm>(() => formOf(room));
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm(formOf(room));
  }, [room]);

  useEffect(() => {
    if (!active) return;
    setStatus('');
    setError(false);
  }, [active]);

  if (!canManage) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const previous = formOf(room);
    const payload: Record<string, string | number> = {
      request_id: newRequestId('web_room_policy'),
      room_id: room.room_id,
      expected_policy_revision: room.policy_revision ?? 1,
    };
    for (const key of Object.keys(form) as (keyof PolicyForm)[]) {
      if (form[key] !== previous[key]) payload[`${key}_policy`] = form[key];
    }
    if (Object.keys(payload).length === 3) {
      setStatus('没有需要保存的修改。');
      return;
    }
    setBusy(true);
    setError(false);
    setStatus('正在保存群策略…');
    try {
      await callTool('network_room_policy_set', payload, { token });
      setStatus('已保存群策略。');
      await queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) });
    } catch (failure) {
      setForm(previous);
      setError(true);
      setStatus(`保存失败：${failureText(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="group-policies" className="group-policies" aria-label="群策略">
      <div className="members-section-head">
        <h3>群策略</h3>
      </div>
      <form className="group-policy-form" onSubmit={(event) => void submit(event)}>
        <Select
          id="group-policy-message"
          label="普通成员发言"
          value={form.member_message}
          disabled={busy}
          options={[
            { value: 'members', label: '所有成员' },
            { value: 'owner_admin', label: '仅群主/管理员' },
          ]}
          onChange={(value) => setForm((current) => ({ ...current, member_message: value }))}
        />
        <Select
          id="group-policy-invite"
          label="普通成员邀请"
          value={form.member_invite}
          disabled={busy}
          options={[
            { value: 'members', label: '所有成员' },
            { value: 'owner_admin', label: '仅群主/管理员' },
          ]}
          onChange={(value) => setForm((current) => ({ ...current, member_invite: value }))}
        />
        <Select
          id="group-policy-history"
          label="新成员历史"
          value={form.member_history}
          disabled={busy}
          options={[
            { value: 'full', label: '全部历史' },
            { value: 'from_join', label: '仅加入后' },
          ]}
          onChange={(value) => setForm((current) => ({ ...current, member_history: value }))}
        />
        <Select
          id="group-policy-join"
          label="入群方式"
          value={form.member_join}
          disabled={busy}
          options={[
            { value: 'open', label: '直接加入' },
            { value: 'approval', label: '需要审批' },
          ]}
          onChange={(value) => setForm((current) => ({ ...current, member_join: value }))}
        />
        <Select
          id="group-policy-profile"
          label="群资料编辑"
          value={form.member_profile}
          disabled={busy}
          options={[
            { value: 'members', label: '所有成员' },
            { value: 'owner_admin', label: '仅群主/管理员' },
          ]}
          onChange={(value) => setForm((current) => ({ ...current, member_profile: value }))}
        />
        <Select
          id="group-policy-mention-all"
          label="@所有人"
          value={form.member_mention_all}
          disabled={busy}
          options={[
            { value: 'owner_admin', label: '仅群主/管理员' },
            { value: 'members', label: '所有成员' },
          ]}
          onChange={(value) => setForm((current) => ({ ...current, member_mention_all: value }))}
        />
        <div className="row">
          <Button id="group-policy-save" className="primary" type="submit" disabled={busy}>
            {busy ? '正在保存…' : '保存策略'}
          </Button>
        </div>
      </form>
      <p
        id="group-policy-status"
        className="form-error"
        role="status"
        aria-live="polite"
        data-error={error ? '1' : undefined}
      >
        {status}
      </p>
    </section>
  );
}
