import { Button, FieldError, Input, Label } from '../../app/lenso-controls';
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
import { useUpdateWriteBlocked } from '../../pwa/update-store';
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
  const writeBlocked = useUpdateWriteBlocked();
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
    if (writeBlocked) {
      setSubmitError('当前页面与服务器版本不兼容，请先更新后再修改群名');
      return;
    }
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
          <Button id="room-rename-cancel" type="button" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            id="room-rename-save"
            type="submit"
            form="room-rename-form"
            className="primary"
            disabled={isSubmitting || writeBlocked}
          >
            {isSubmitting ? '正在保存…' : '保存'}
          </Button>
        </div>
      }
    >
      <form id="room-rename-form" onSubmit={(event) => void submit(event)}>
        <div className="field">
          <Label htmlFor="room-rename-input">群名</Label>
          <Input
            id="room-rename-input"
            type="text"
            maxLength={LIMITS.roomTitleMax}
            autoComplete="off"
            aria-describedby={errors.title ? 'room-rename-input-error' : undefined}
            aria-invalid={errors.title ? true : undefined}
            {...register('title')}
          />
        </div>
        {errors.title ? (
          <FieldError id="room-rename-input-error">{errors.title.message}</FieldError>
        ) : null}
        {writeBlocked ? (
          <p id="room-rename-update-block" className="composer-update-block" role="status">
            当前页面与服务器版本不兼容，请先更新后再修改群名。
          </p>
        ) : null}
        {submitError ? (
          <p id="room-rename-error" className="field-error" role="alert">
            {submitError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
