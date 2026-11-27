/**
 * React Query 的键：server state 只按 actor/room 维度缓存，UI 偏好不进缓存。
 *
 * 键里带 actor_id，身份切换时不需要逐个手工失效；退出登录会直接
 * `queryClient.clear()`，避免把上一个身份的房间或联系人留在内存。
 */
export const queryKeys = {
  session: () => ['session'] as const,
  rooms: (actorId: string | null) => ['rooms', actorId ?? 'anonymous'] as const,
  room: (roomId: string) => ['room', roomId] as const,
  roomFiles: (roomId: string) => ['room', roomId, 'files'] as const,
  history: (roomId: string, timeline: boolean) =>
    ['room', roomId, 'history', timeline ? 'timeline' : 'default'] as const,
  taskSummary: (roomId: string, rootId: string, version: string) =>
    ['room', roomId, 'task-summary', rootId, version] as const,
  taskSummaries: (roomId: string) => ['room', roomId, 'task-summary'] as const,
  /** 房间级 Task 缓存前缀：列表、打开的 Trace 共用同一失效入口。
   *  放在 `room` 前缀之外，避免房间级 invalidate 用旧游标重读所有列表页。 */
  roomTasks: (roomId: string) => ['room-tasks', roomId] as const,
  /** 只命中常驻列表，不命中 Trace。 */
  taskLists: (roomId: string) => ['room-tasks', roomId, 'list'] as const,
  taskList: (
    roomId: string,
    actorId: string | null,
    status: 'open' | 'completed' | 'all',
    authorization: string,
  ) =>
    ['room-tasks', roomId, 'list', actorId ?? 'anonymous', status, authorization] as const,
  taskTraces: (roomId: string) => ['room-tasks', roomId, 'trace'] as const,
  taskTrace: (roomId: string, rootId: string | null, focusId: string | null) =>
    ['room-tasks', roomId, 'trace', rootId ?? 'none', focusId ?? 'root'] as const,
  contacts: (actorId: string | null) => ['contacts', actorId ?? 'anonymous'] as const,
  contactBlocks: (actorId: string | null) => ['contact-blocks', actorId ?? 'anonymous'] as const,
  agentManagement: (actorId: string | null) =>
    ['agent-management', actorId ?? 'anonymous'] as const,
  contactRequests: (actorId: string | null) =>
    ['contact-requests', actorId ?? 'anonymous'] as const,
  contactRequestBadge: (actorId: string | null) =>
    ['contact-requests', actorId ?? 'anonymous', 'badge'] as const,
  archivedAgents: (actorId: string | null, ids: readonly string[]) =>
    ['archived-agents', actorId ?? 'anonymous', ids.join('|')] as const,
  leavePreview: (roomId: string) => ['room', roomId, 'leave-preview'] as const,
  /** 个人看板：`['focus']` 是 SSE 与写操作的统一失效前缀。 */
  focus: () => ['focus'] as const,
  focusStatus: (actorId: string | null) => ['focus', 'status', actorId ?? 'anonymous'] as const,
  focusItems: (actorId: string | null, archived: boolean, query: string) =>
    ['focus', 'items', actorId ?? 'anonymous', archived ? 'archived' : 'current', query] as const,
  focusItem: (actorId: string | null, itemId: string | null) =>
    ['focus', 'item', actorId ?? 'anonymous', itemId ?? 'none'] as const,
};

export type QueryKey = ReturnType<(typeof queryKeys)[keyof typeof queryKeys]>;
