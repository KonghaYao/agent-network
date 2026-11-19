/**
 * 在线状态的三态判定：`true` 在线、`false` 明确离线、`null` 未知。
 *
 * 只有 Agent 且明确离线时才允许把头像置灰；人类成员没有 presence 数据，
 * `null` 也不能当成离线，否则会把“不知道”误报成“不可用”。
 */
export function isOfflineAgent(
  kind: 'human' | 'agent' | null | undefined,
  online: boolean | null | undefined,
): boolean {
  return kind === 'agent' && online === false;
}
