import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { LIMITS } from '../../../contracts/limits';
import {
  announcementFormSchema,
  type AnnouncementForm,
} from '../../../contracts/web-forms';
import type { RoomView } from '../../lib/chat';
import { callTool, type McpError } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';
import { Modal } from './Modal';

/** 群公告编辑：只有 owner/管理员入口可见；提交后失效房间详情。 */
export function AnnouncementDialog({
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
  } = useForm<AnnouncementForm>({
    resolver: zodResolver(announcementFormSchema),
    defaultValues: { announcement: room.announcement },
  });

  useEffect(() => {
    if (open) reset({ announcement: room.announcement });
  }, [open, reset, room.announcement]);

  const submit = handleSubmit(async (values) => {
    setSubmitError('');
    try {
      await callTool(
        'network_room_announcement_set',
        {
          request_id: newRequestId('web_announcement'),
          room_id: room.room_id,
          announcement: values.announcement,
          expected_announcement_revision: room.announcement_revision ?? 1,
        },
        { token },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) });
      onOpenChange(false);
    } catch (error) {
      setSubmitError((error as McpError).message || '保存公告失败');
    }
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="群公告"
      titleId="announcement-modal-title"
      contentId="announcement-modal"
      footer={
        <div className="row modal-actions">
          <button id="announcement-cancel" type="button" onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button
            id="announcement-save"
            type="submit"
            form="announcement-form"
            className="primary"
            disabled={isSubmitting}
          >
            {isSubmitting ? '正在保存…' : '保存'}
          </button>
        </div>
      }
    >
      <form id="announcement-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>公告正文</span>
          <textarea
            id="announcement-input"
            rows={6}
            maxLength={LIMITS.roomAnnouncementBytes * 2}
            placeholder="留空表示清除公告"
            {...register('announcement')}
          />
        </label>
        {errors.announcement ? (
          <p id="announcement-error" className="field-error">
            {errors.announcement.message}
          </p>
        ) : null}
        {submitError ? (
          <p id="announcement-error" className="field-error" role="alert">
            {submitError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
