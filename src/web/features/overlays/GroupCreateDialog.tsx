import * as Ariakit from '@ariakit/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { LIMITS } from '../../../contracts/limits';
import {
  groupCreateFormSchema,
  type GroupCreateForm,
} from '../../../contracts/web-forms';
import { useContacts, type Contact } from '../../hooks/useContacts';
import { useWebSession } from '../../hooks/useWebSession';
import { callTool, type McpError } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';
import { navigate } from '../../app/router';
import { Modal } from './Modal';

interface CreatedRoom {
  room: { room_id: string };
}

/**
 * 建群弹窗：标题可选，成员来自 `network_contacts_list` 的 active 好友。
 *
 * 成员选择用 Ariakit Combobox 提供过滤与键盘操作；RHF 只校验本地表单，
 * 服务端的建群预检仍是最终权威。
 */
export function GroupCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const session = useWebSession();
  const token = session.session?.token ?? null;
  const actorId = session.session?.identity.actor_id ?? null;
  const contacts = useContacts(open);
  const [search, setSearch] = useState('');
  const [submitError, setSubmitError] = useState('');

  const combobox = Ariakit.useComboboxStore({ defaultOpen: false });

  const {
    register,
    handleSubmit,
    setValue,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<GroupCreateForm>({
    resolver: zodResolver(groupCreateFormSchema),
    defaultValues: { title: '', members: [] },
  });
  const selectedIds = useWatch({ control, name: 'members' });

  const selected = new Set(selectedIds);
  const needle = search.trim().toLowerCase();
  const candidates = contacts.contacts.filter(
    (contact) => !selected.has(contact.actor_id) && (!needle || contact.name.toLowerCase().includes(needle)),
  );

  const toggle = (contact: Contact) => {
    const next = selected.has(contact.actor_id)
      ? selectedIds.filter((id) => id !== contact.actor_id)
      : [...selectedIds, contact.actor_id];
    setValue('members', next, { shouldValidate: true });
    setSearch('');
    combobox.setValue('');
    combobox.setOpen(false);
  };

  const close = (next: boolean) => {
    if (isSubmitting) return;
    if (!next) {
      setSearch('');
      setSubmitError('');
      reset({ title: '', members: [] });
    }
    onOpenChange(next);
  };

  const submit = handleSubmit(async (values) => {
    if (!token) {
      setSubmitError('浏览器身份尚未初始化，请刷新页面后重试');
      return;
    }
    setSubmitError('');
    try {
      const title = values.title.trim();
      const created = await callTool<CreatedRoom>(
        'network_room_create',
        {
          request_id: newRequestId('web_group'),
          kind: 'group',
          members: values.members,
          ...(title ? { title } : {}),
        },
        { token },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.rooms(actorId) });
      reset({ title: '', members: [] });
      setSearch('');
      onOpenChange(false);
      navigate(`/c/${created.room.room_id}`);
    } catch (error) {
      setSubmitError((error as McpError).message || '创建群聊失败');
    }
  });

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="新建群聊"
      titleId="group-modal-title"
      contentId="group-modal"
      className="group-card"
      footer={
        <div className="row modal-actions">
          <button id="group-cancel" type="button" onClick={() => close(false)} disabled={isSubmitting}>
            取消
          </button>
          <button
            id="group-create"
            type="submit"
            form="group-form"
            className="primary"
            disabled={isSubmitting || !token}
          >
            {isSubmitting ? '正在创建…' : '创建'}
          </button>
        </div>
      }
    >
      <form id="group-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>群名（可选）</span>
          <input
            id="group-name-input"
            type="text"
            maxLength={LIMITS.roomTitleMax}
            placeholder="不填则显示“群聊”"
            autoComplete="off"
            {...register('title')}
          />
        </label>
        {errors.title ? <p className="field-error">{errors.title.message}</p> : null}

        <label className="field">
          <span>添加成员</span>
          <Ariakit.Combobox
            store={combobox}
            id="group-search"
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
        <div id="group-contacts" className="spa-combobox-list" role="group" aria-label="好友候选">
          <Ariakit.ComboboxList store={combobox} alwaysVisible>
            {candidates.map((contact) => (
              <Ariakit.ComboboxItem
                key={contact.actor_id}
                className="spa-combobox-item"
                value={contact.name}
                onClick={() => toggle(contact)}
              >
                <span>{contact.name}</span>
                <span className="mention-kind">{contact.kind === 'agent' ? 'Agent' : '人'}</span>
              </Ariakit.ComboboxItem>
            ))}
          </Ariakit.ComboboxList>
          {contacts.loading ? <p className="list-hint">正在读取好友…</p> : null}
          {!contacts.loading && candidates.length === 0 ? (
            <p className="list-hint">{needle ? '没有匹配的好友' : '没有可选好友'}</p>
          ) : null}
          {contacts.hasMore ? (
            <button
              id="group-contacts-more"
              className="list-retry"
              type="button"
              disabled={contacts.loadingMore}
              onClick={() => void contacts.loadMore()}
            >
              {contacts.loadingMore ? '正在加载…' : '加载更多好友'}
            </button>
          ) : null}
          {contacts.error ? <p className="field-error">{contacts.error}</p> : null}
        </div>

        <div id="group-selection" className="spa-chips" role="group" aria-label="已选成员">
          {selectedIds.map((id) => {
            const contact = contacts.contacts.find((entry) => entry.actor_id === id);
            return (
              <span className="spa-chip" key={id}>
                {contact?.name ?? id}
                <button
                  type="button"
                  aria-label={`移除 ${contact?.name ?? id}`}
                  onClick={() => {
                    setValue(
                      'members',
                      selectedIds.filter((value) => value !== id),
                      { shouldValidate: true },
                    );
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
        <p id="group-contacts-count" className="list-hint">
          已选 {selectedIds.length} 人
        </p>
        {errors.members ? (
          <p id="group-members-error" className="field-error">
            {errors.members.message}
          </p>
        ) : null}
        {submitError ? <p id="group-error" className="field-error" role="alert">{submitError}</p> : null}
      </form>
    </Modal>
  );
}
