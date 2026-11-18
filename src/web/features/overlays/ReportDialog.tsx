import { Button, FieldError, Label, Select, TextArea } from '../../app/lenso-controls';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { LIMITS } from '../../../contracts/limits';
import { reportFormSchema, type ReportForm } from '../../../contracts/web-forms';
import { callTool, type McpError } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';
import { Modal } from './Modal';

const CATEGORIES: { value: ReportForm['category']; label: string }[] = [
  { value: 'harassment', label: '骚扰' },
  { value: 'spam', label: '垃圾信息' },
  { value: 'fraud', label: '欺诈' },
  { value: 'other', label: '其他' },
];

/** 举报单聊对端；举报不产生 delivery，也不会唤醒 Agent。 */
export function ReportDialog({
  open,
  onOpenChange,
  targetId,
  targetName,
  roomId,
  token,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetId: string;
  targetName: string;
  roomId: string;
  token: string;
}) {
  const [status, setStatus] = useState('');
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ReportForm>({
    resolver: zodResolver(reportFormSchema),
    defaultValues: { category: 'other', note: '' },
  });

  const submit = handleSubmit(async (values) => {
    setStatus('');
    try {
      await callTool(
        'network_contact_report',
        {
          request_id: newRequestId('web_report'),
          target_actor_id: targetId,
          category: values.category,
          ...(values.note?.trim() ? { note: values.note.trim() } : {}),
          room_id: roomId,
        },
        { token },
      );
      reset({ category: 'other', note: '' });
      onOpenChange(false);
      setStatus('举报已提交');
    } catch (error) {
      setStatus((error as McpError).message || '提交举报失败');
    }
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`举报 ${targetName}`}
      titleId="report-modal-title"
      contentId="report-modal"
      footer={
        <div className="row modal-actions">
          <Button id="report-cancel" type="button" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            id="report-submit"
            type="submit"
            form="report-form"
            className="primary danger"
            disabled={isSubmitting}
          >
            {isSubmitting ? '正在提交…' : '提交举报'}
          </Button>
        </div>
      }
    >
      <form id="report-form" onSubmit={(event) => void submit(event)}>
        <div className="field">
          <Label htmlFor="report-category">类型</Label>
          <Controller
            control={control}
            name="category"
            render={({ field, fieldState }) => (
              <Select
                id="report-category"
                name="category"
                aria-label="举报类型"
                aria-invalid={fieldState.invalid}
                aria-describedby={errors.category ? 'report-category-error' : undefined}
                value={field.value}
                options={CATEGORIES}
                onChange={field.onChange}
                ref={field.ref}
              />
            )}
          />
        </div>
        {errors.category ? (
          <FieldError id="report-category-error">{errors.category.message}</FieldError>
        ) : null}
        <div className="field">
          <Label htmlFor="report-note">补充说明（可选）</Label>
          <TextArea
            id="report-note"
            rows={4}
            maxLength={LIMITS.contactReportNoteBytes * 2}
            aria-describedby={errors.note ? 'report-note-error' : undefined}
            aria-invalid={errors.note ? true : undefined}
            {...register('note')}
          />
        </div>
        {errors.note ? (
          <FieldError id="report-note-error">{errors.note.message}</FieldError>
        ) : null}
        {status ? (
          <p id="report-status" className="field-error" role="status">
            {status}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
