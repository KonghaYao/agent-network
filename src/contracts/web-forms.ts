import { z } from 'zod';

import { LIMITS } from './limits';

/**
 * 浏览器表单的本地校验。
 *
 * 刻意不 import 服务端 `schemas.ts`：浏览器只需要在提交前给出可读提示，
 * 字节上限与最终权威仍在服务端。这里只复用 `LIMITS` 常量。
 */

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

export const groupCreateFormSchema = z.object({
  title: z.string().trim().max(LIMITS.roomTitleMax, `群名不能超过 ${LIMITS.roomTitleMax} 个字符`),
  members: z
    .array(z.string().min(1))
    .min(1, '请至少选择一位成员')
    .max(LIMITS.memberChangeMax, `一次最多选择 ${LIMITS.memberChangeMax} 位成员`),
});

export const meRenameFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '名称不能为空')
    .max(LIMITS.actorNameMax, `名称不能超过 ${LIMITS.actorNameMax} 个字符`),
});

export const roomRenameFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, '群名不能为空')
    .max(LIMITS.roomTitleMax, `群名不能超过 ${LIMITS.roomTitleMax} 个字符`),
});

export const announcementFormSchema = z.object({
  announcement: z
    .string()
    .max(LIMITS.roomAnnouncementBytes * 2, '公告过长')
    .refine(
      (value) => byteLength(value) <= LIMITS.roomAnnouncementBytes,
      `公告不能超过 ${LIMITS.roomAnnouncementBytes} 字节`,
    ),
});

export const reportFormSchema = z.object({
  category: z.enum(['harassment', 'spam', 'fraud', 'other']),
  note: z
    .string()
    .max(LIMITS.contactReportNoteBytes * 2, '补充说明过长')
    .refine(
      (value) => byteLength(value) <= LIMITS.contactReportNoteBytes,
      `补充说明不能超过 ${LIMITS.contactReportNoteBytes} 字节`,
    )
    .optional(),
});

/** 新建 Agent：名称上限与 legacy 共用 `LIMITS.actorNameMax`。 */
export const newAgentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '名称不能为空')
    .max(LIMITS.actorNameMax, `名称最多 ${LIMITS.actorNameMax} 个字符`),
});

/** 监控 URL 允许留空（表示清除），否则只接受 http/https。 */
export const monitorUrlFormSchema = z.object({
  url: z
    .string()
    .trim()
    .max(LIMITS.roomMonitorUrlMax, `网址不能超过 ${LIMITS.roomMonitorUrlMax} 个字符`)
    .refine(
      (value) => value === '' || /^https?:\/\/[^\s]+$/iu.test(value),
      '只允许 http 或 https 网址',
    ),
});

export type GroupCreateForm = z.infer<typeof groupCreateFormSchema>;
export type MeRenameForm = z.infer<typeof meRenameFormSchema>;
export type RoomRenameForm = z.infer<typeof roomRenameFormSchema>;
export type AnnouncementForm = z.infer<typeof announcementFormSchema>;
export type ReportForm = z.infer<typeof reportFormSchema>;
export type NewAgentForm = z.infer<typeof newAgentFormSchema>;
export type MonitorUrlForm = z.infer<typeof monitorUrlFormSchema>;
