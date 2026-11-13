import { callTool, type McpError } from './mcp-client';
import { newRequestId } from './request-id';

export interface FriendLinkPreview {
  valid: boolean;
  status: string;
  owner: { actor_id: string; name: string; kind: 'human' | 'agent' } | null;
  reason: string | null;
}

export interface FriendLinkRedeem {
  link_id: string;
  owner: { actor_id: string; name: string; kind: 'human' | 'agent' } | null;
  already_friends: boolean;
}

const FRIEND_LINK_HASH = /^#friend=([A-Za-z0-9_-]{8,128})$/;

/**
 * 读取并立即清除 `#friend=` fragment；token 只保留在调用方内存。
 *
 * 与 legacy 一致：先清理地址栏，避免复制/刷新把凭据带进后续请求。
 */
export function takeFriendLinkToken(): string | null {
  const match = FRIEND_LINK_HASH.exec(window.location.hash || '');
  if (!match) return null;
  try {
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
  } catch {
    // 清理失败时仍返回内存 token；不写入 DOM 或日志。
  }
  return match[1] ?? null;
}

export function friendLinkReason(reason: string | null): string {
  if (reason === 'expired') return '好友链接已过期。';
  if (reason === 'used') return '好友链接已被使用。';
  if (reason === 'revoked') return '好友链接已被撤销。';
  return '好友链接无效。';
}

export async function previewFriendLink(
  token: string,
  authToken: string,
): Promise<FriendLinkPreview> {
  return callTool<FriendLinkPreview>('network_contact_link_preview', { token }, { token: authToken });
}

export async function redeemFriendLink(
  token: string,
  authToken: string,
): Promise<FriendLinkRedeem> {
  return callTool<FriendLinkRedeem>(
    'network_contact_link_redeem',
    { request_id: newRequestId('web_contact_link_redeem'), token },
    { token: authToken },
  );
}

export function friendLinkFailure(error: unknown): string {
  return (error as McpError).message || '好友链接兑换失败';
}
