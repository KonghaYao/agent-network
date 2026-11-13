import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { LIMITS } from '../../../contracts/limits';
import { roomRenameFormSchema, type RoomRenameForm } from '../../../contracts/web-forms';
import type { RoomView } from '../../lib/chat';
import { callTool, type McpError } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';
import { Modal } from './Modal';

/** 群改名：`expected_title` 用打开弹窗时的名称，冲突由服务端返回。 */
export function RenameRoomDialog({
  open,
  onOpenChange,
  room,
  token,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: RoomView;
  token: string;
}) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState('');
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<RoomRenameForm>({
    resolver: zodResolver(roomRenameFormSchema),
    defaultValues: { title: room.title },
  });

  useEffect(() => {
    if (open) reset({ title: room.title });
  }, [open, reset, room.title]);

  const submit = handleSubmit(async (values) => {
    setSubmitError('');
    try {
      await callTool(
        'network_room_rename',
        {
          request_id: newRequestId('web_room_rename'),
          room_id: room.room_id,
          title: values.title,
          expected_title: room.title,
        },
        { token },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) }),
        queryClient.invalidateQueries({ queryKey: ['rooms'] }),
      ]);
      onOpenChange(false);
    } catch (error) {
      setSubmitError((error as McpError).message || '修改群名失败');
    }
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="修改群名"
      titleId="room-rename-title"
      contentId="room-rename-dialog"
      footer={
        <div className="row modal-actions">
          <button id="room-rename-cancel" type="button" onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button
            id="room-rename-save"
            type="submit"
            form="room-rename-form"
            className="primary"
            disabled={isSubmitting}
          >
            {isSubmitting ? '正在保存…' : '保存'}
          </button>
        </div>
      }
    >
      <form id="room-rename-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>群名</span>
          <input
            id="room-rename-input"
            type="text"
            maxLength={LIMITS.roomTitleMax}
            autoComplete="off"
            {...register('title')}
          />
        </label>
        {errors.title ? <p className="field-error">{errors.title.message}</p> : null}
        {submitError ? (
          <p id="room-rename-error" className="field-error" role="alert">
            {submitError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
