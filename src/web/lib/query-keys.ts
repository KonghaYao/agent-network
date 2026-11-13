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
  history: (roomId: string, timeline: boolean) =>
    ['room', roomId, 'history', timeline ? 'timeline' : 'default'] as const,
  contacts: (actorId: string | null) => ['contacts', actorId ?? 'anonymous'] as const,
  leavePreview: (roomId: string) => ['room', roomId, 'leave-preview'] as const,
};

export type QueryKey = ReturnType<(typeof queryKeys)[keyof typeof queryKeys]>;
