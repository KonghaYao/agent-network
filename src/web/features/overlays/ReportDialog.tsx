import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

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
          <button id="report-cancel" type="button" onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button
            id="report-submit"
            type="submit"
            form="report-form"
            className="primary danger"
            disabled={isSubmitting}
          >
            {isSubmitting ? '正在提交…' : '提交举报'}
          </button>
        </div>
      }
    >
      <form id="report-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>类型</span>
          <select id="report-category" {...register('category')}>
            {CATEGORIES.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>补充说明（可选）</span>
          <textarea
            id="report-note"
            rows={4}
            maxLength={LIMITS.contactReportNoteBytes * 2}
            {...register('note')}
          />
        </label>
        {errors.note ? <p className="field-error">{errors.note.message}</p> : null}
        {status ? (
          <p id="report-status" className="field-error" role="status">
            {status}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
