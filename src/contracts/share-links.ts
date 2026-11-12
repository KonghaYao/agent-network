/**
 * Agent 分享页 URL：`{PUBLIC_ORIGIN}/a/{agent_session_id}`。
 *
 * 没有 session 的 actor（例如人类或旧数据）不生成分享链接。实现只有一份，
 * 避免不同工具返回的 URL 形态漂移。
 */

export function agentShareUrl(
  actor: { agent_session_id: string | null },
  origin: string,
): string | null {
  return actor.agent_session_id
    ? `${origin}/a/${encodeURIComponent(actor.agent_session_id)}`
    : null;
}
