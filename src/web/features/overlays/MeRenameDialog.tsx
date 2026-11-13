import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { LIMITS } from '../../../contracts/limits';
import { meRenameFormSchema, type MeRenameForm } from '../../../contracts/web-forms';
import { callTool, type McpError } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';
import { Modal } from './Modal';

/** 本人改名：只改自己的 actor 名称，成功后刷新 session 与房间列表。 */
export function MeRenameDialog({
  open,
  onOpenChange,
  currentName,
  token,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  token: string;
}) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState('');
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<MeRenameForm>({
    resolver: zodResolver(meRenameFormSchema),
    defaultValues: { name: currentName },
  });

  useEffect(() => {
    if (open) reset({ name: currentName });
  }, [currentName, open, reset]);

  const submit = handleSubmit(async (values) => {
    setSubmitError('');
    try {
      await callTool(
        'network_me_rename',
        { request_id: newRequestId('web_me_rename'), name: values.name },
        { token },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.session() }),
        queryClient.invalidateQueries({ queryKey: ['rooms'] }),
      ]);
      onOpenChange(false);
    } catch (error) {
      setSubmitError((error as McpError).message || '修改名称失败');
    }
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="修改我的名称"
      titleId="me-rename-title"
      contentId="me-rename-dialog"
      footer={
        <div className="row modal-actions">
          <button id="me-rename-cancel" type="button" onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button
            id="me-rename-save"
            type="submit"
            form="me-rename-form"
            className="primary"
            disabled={isSubmitting}
          >
            {isSubmitting ? '正在保存…' : '保存'}
          </button>
        </div>
      }
    >
      <form id="me-rename-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>名称</span>
          <input
            id="me-rename-input"
            type="text"
            maxLength={LIMITS.actorNameMax}
            autoComplete="off"
            {...register('name')}
          />
        </label>
        {errors.name ? <p className="field-error">{errors.name.message}</p> : null}
        {submitError ? (
          <p id="me-rename-error" className="field-error" role="alert">
            {submitError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
