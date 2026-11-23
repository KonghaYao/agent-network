import { useSyncExternalStore } from 'react';

import {
  readRecalledDraft,
  recalledDraftsRevision,
  subscribeRecalledDrafts,
} from '../lib/recalled-drafts';

/**
 * 订阅本标签页的撤回原文缓存。
 *
 * 只在墓碑行使用：发送成功、恢复后移除与身份清理都会推进模块级修订号，
 * 让同一行立即出现/移除「重新编辑」入口；缓存本身按 actor 隔离。
 */
export function useRecalledDraft(actorId: string | null, messageId: string): string | null {
  useSyncExternalStore(
    subscribeRecalledDrafts,
    recalledDraftsRevision,
    recalledDraftsRevision,
  );
  if (!actorId) return null;
  return readRecalledDraft(actorId, messageId);
}
