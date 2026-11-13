import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useArchivedAgents } from '../../hooks/useArchivedAgents';
import { useWebSession } from '../../hooks/useWebSession';
import { callTool } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';
import { avatarColor, firstChar } from '../../lib/rooms';
import { confirmDialog } from './confirm';

/**
 * 已归档 Agents 浮层：按服务端 `network_agents_get` 的归档状态列出 direct
 * Agent，恢复前二次确认。归档不删除房间、消息或凭据，只把会话从默认列举
 * 中隐藏；恢复成功后失效会话列表，聊天仍可直接打开。
 */
export function ArchiveAgentsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const session = useWebSession();
  const token = session.session?.token ?? null;
  const actorId = session.session?.identity.actor_id ?? null;
  const archived = useArchivedAgents(open);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStatus('');
    setBusyId(null);
  }, [open]);

  const restore = async (actor: string, name: string) => {
    if (!token || busyId) return;
    const confirmed = await confirmDialog({
      title: '恢复 Agent',
      message: `恢复 ${name} 后，这个单聊会重新出现在默认会话列表中；消息、文件与凭据都不受影响。`,
      confirmText: '恢复',
    });
    if (!confirmed) return;
    setBusyId(actor);
    setStatus(`正在恢复 ${name}…`);
    try {
      await callTool(
        'network_agent_unarchive',
        { request_id: newRequestId('web_agent_unarchive'), actor_id: actor },
        { token },
      );
      setStatus(`已恢复 ${name}，会话已重新出现在默认列表。`);
      if (actorId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.rooms(actorId) });
      }
      await archived.refetch();
    } catch (error) {
      setStatus(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyId(null);
    }
  };

  const statusText = archived.loading
    ? '正在读取已归档 Agent…'
    : archived.error
      ? `读取已归档 Agents 失败：${archived.error}`
      : status;
  const emptyVisible =
    !archived.loading && !archived.error && archived.items.length === 0;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-dialog-overlay" />
        <DialogPrimitive.Content
          id="archive-popover"
          className="modal-card spa-dialog-content archive-dialog"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title asChild>
            <h2 id="archive-popover-title">已归档 Agents</h2>
          </DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <button
              id="archive-popover-close"
              className="spa-dialog-close"
              type="button"
              aria-label="关闭已归档 Agents"
              title="关闭"
            >
              ×
            </button>
          </DialogPrimitive.Close>
          <p
            className="archive-popover-status"
            id="archive-popover-status"
            role="status"
            data-error={archived.error || status.startsWith('恢复失败') ? '1' : undefined}
            hidden={!statusText}
          >
            {statusText}
          </p>
          <ul
            className="archive-popover-list"
            id="archive-popover-list"
            aria-label="已归档 Agent"
          >
            {archived.items.map((item) => {
              const busy = busyId === item.actor_id;
              return (
                <li
                  className="archive-item"
                  key={item.actor_id}
                  data-actor-id={item.actor_id}
                >
                  <span
                    className="avatar archive-avatar"
                    style={{ background: avatarColor(item.name) }}
                    aria-hidden="true"
                  >
                    {firstChar(item.name)}
                  </span>
                  <span className="archive-name" title={item.name}>
                    {item.name}
                  </span>
                  <button
                    type="button"
                    className="archive-restore"
                    data-actor-id={item.actor_id}
                    aria-label={`恢复 ${item.name}`}
                    disabled={busyId !== null}
                    onClick={() => void restore(item.actor_id, item.name)}
                  >
                    {busy ? '恢复中…' : '恢复'}
                  </button>
                </li>
              );
            })}
          </ul>
          <p
            className="archive-popover-empty"
            id="archive-popover-empty"
            role="status"
            hidden={!emptyVisible}
          >
            暂无已归档 Agent
          </p>
          <p className="archive-dialog-note">
            归档只影响默认列举，不会删除消息、文件或凭据；恢复后会话重新出现。
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
