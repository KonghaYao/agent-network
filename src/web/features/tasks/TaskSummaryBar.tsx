import { useQuery } from '@tanstack/react-query';

import { useWebSession } from '../../hooks/useWebSession';
import type { HistoryMessage } from '../../lib/chat';
import { callTool } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { avatarColor, firstChar } from '../../lib/rooms';

export interface TaskSummary {
  root_message_id: string;
  room_id: string;
  preview: string;
  message_count: number;
  participant_count: number;
  participants: { actor_id: string; name: string }[];
}

interface SummaryPage {
  items: TaskSummary[];
}

/**
 * 消息式 Task 摘要行。
 *
 * 只在当前消息页出现起点；摘要按当前 head 失效，SSE 刷新历史后重新读取。
 * 读取失败不覆盖消息本身，只隐藏摘要行。
 */
export function TaskSummaryBar({
  item,
  roomId,
  headSeq,
  onOpen,
}: {
  item: HistoryMessage;
  roomId: string;
  headSeq: string;
  onOpen: (rootId: string, focusMessageId: string | null) => void;
}) {
  const session = useWebSession();
  const token = session.session?.token ?? null;
  const marked = item.task_root_id === item.message_id;
  const summaryQuery = useQuery({
    queryKey: queryKeys.taskSummary(roomId, item.message_id, headSeq),
    enabled: Boolean(token && marked),
    queryFn: ({ signal }) =>
      callTool<SummaryPage>(
        'network_task_summaries',
        { room_id: roomId, root_message_ids: [item.message_id] },
        { token: token ?? undefined, signal },
      ),
    retry: false,
    staleTime: 10_000,
  });
  const summary = summaryQuery.data?.items.find(
    (entry) => entry.root_message_id === item.message_id,
  );
  if (!marked || !summary) return null;
  const participants = summary.participants.slice(0, 3);
  const more = Math.max(0, summary.participant_count - participants.length);
  return (
    <div className="msg-task-bar-slot">
      <button
        type="button"
        className="task-bar"
        data-task-root={item.message_id}
        aria-label={`Task：${summary.preview || '任务'}，${summary.message_count} 条消息`}
        onClick={() => onOpen(item.message_id, null)}
      >
        <span className="task-bar-icon" aria-hidden="true">
          T
        </span>
        <span className="task-bar-avatars">
          {participants.map((participant) => (
            <span
              key={participant.actor_id}
              className="task-avatar"
              title={participant.name}
              style={{ background: avatarColor(participant.name) }}
            >
              {firstChar(participant.name)}
            </span>
          ))}
          {more > 0 ? <span className="task-bar-more">+{more}</span> : null}
        </span>
        <span className="task-bar-preview">{summary.preview || item.preview || '（无正文）'}</span>
        <span className="task-bar-count">{summary.message_count} 消息</span>
      </button>
    </div>
  );
}
