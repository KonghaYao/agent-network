/**
 * A07 好友邀请链接验收。
 *
 * 覆盖：创建/无鉴权预览、一次性兑换直接建立双向 active 关系、自己、
 * 拉黑双向、已存在关系幂等且不消费链接、过期/撤销/已用、pending 上限、
 * owner-only 撤销、token 不在结果与列表中、PUBLIC_ORIGIN 分享 URL、
 * 兑换事件为 human-only informational 且不产生 delivery/pending。
 */

import { LIMITS } from '../../src/contracts/limits';
import {
  baseUrl,
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
  rawRpc,
  sleep,
  type McpConnection,
} from './harness';
import { registerIdentity, type Identity } from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

interface ContactLinkView {
  link_id: string;
  status: 'pending' | 'used' | 'revoked' | 'expired';
  created_at: string;
  expires_at: string;
  used_by: { actor_id: string; name: string; kind: string } | null;
  used_at: string | null;
  revoked_at: string | null;
  can_revoke: boolean;
}

interface ContactLinkCreateResult {
  link: ContactLinkView;
  share_url: string;
}

interface ContactLinkPreviewResult {
  valid: boolean;
  status: ContactLinkView['status'] | 'invalid';
  owner: { actor_id: string; name: string; kind: string } | null;
  expires_at: string | null;
  reason: 'invalid' | 'expired' | 'used' | 'revoked' | null;
}

interface ContactLinkRedeemResult {
  link_id: string;
  owner: { actor_id: string; name: string; kind: string };
  relation: {
    pair_key: string;
    status: 'active' | 'ended';
    source: 'request' | 'auto_manager' | 'invite_link';
  };
  already_friends: boolean;
}

interface ContactLinkRevokeResult {
  link: ContactLinkView;
  already_revoked: boolean;
}

interface ContactLinkListResult {
  items: ContactLinkView[];
}

interface ContactRow {
  actor_id: string;
  relation: 'active' | 'none';
}

interface StreamItemView {
  source?: string;
  kind?: string;
  ref_id?: string;
  attention?: string;
}

function expectedOrigin(): string {
  return (process.env.PUBLIC_ORIGIN ?? baseUrl()).replace(/\/+$/u, '');
}

function linkToken(shareUrl: string): string {
  const url = new URL(shareUrl);
  const match = /^#friend=(.+)$/u.exec(url.hash);
  if (!match?.[1]) throw new Error('share_url 缺少 #friend=<token>');
  return match[1];
}

function streamItemsOf(event: { params: Record<string, unknown> }): StreamItemView[] {
  const meta = event.params._meta as Record<string, unknown> | undefined;
  const payload = meta?.[STREAM_EVENT_META] as { items?: StreamItemView[] } | undefined;
  return payload?.items ?? [];
}

async function createLink(
  connection: McpConnection,
  options: { requestId?: string; expiresInMs?: number } = {},
): Promise<ContactLinkCreateResult> {
  return callTool<ContactLinkCreateResult>(connection.client, 'network_contact_link_create', {
    request_id: options.requestId ?? newRequestId('clink'),
    ...(options.expiresInMs !== undefined ? { expires_in_ms: options.expiresInMs } : {}),
  });
}

async function previewLink(token: string): Promise<ContactLinkPreviewResult> {
  const response = await rawRpc('tools/call', {
    name: 'network_contact_link_preview',
    arguments: { token },
  });
  const result = response.body.result as
    | { structuredContent?: ContactLinkPreviewResult; isError?: boolean }
    | undefined;
  if (!result?.structuredContent) throw new Error('preview 无结构化结果');
  return result.structuredContent;
}

async function redeemLink(
  connection: McpConnection,
  token: string,
  requestId = newRequestId('clredeem'),
): Promise<ContactLinkRedeemResult> {
  return callTool<ContactLinkRedeemResult>(connection.client, 'network_contact_link_redeem', {
    request_id: requestId,
    token,
  });
}

async function contactRelation(connection: McpConnection, target: string): Promise<string | null> {
  const page = await callTool<{ items: ContactRow[] }>(connection.client, 'network_contacts_list', {
    limit: 100,
  });
  return page.items.find((item) => item.actor_id === target)?.relation ?? null;
}

export async function runContactLinkAcceptance(): Promise<void> {
  console.log('  · A07 好友邀请链接');
  const aConn = await connectClient(newToken());
  const bConn = await connectClient(newToken());
  const cConn = await connectClient(newToken());
  const dConn = await connectClient(newToken());
  const eConn = await connectClient(newToken());
  let subscription: Awaited<ReturnType<typeof openSubscription>> | null = null;
  try {
    const a: Identity = await registerIdentity(aConn, { kind: 'human', name: 'A07 邀请人' });
    const b: Identity = await registerIdentity(bConn, { kind: 'human', name: 'A07 用户乙' });
    const c: Identity = await registerIdentity(cConn, { kind: 'human', name: 'A07 用户丙' });
    const d: Identity = await registerIdentity(dConn, { kind: 'human', name: 'A07 用户丁' });
    const e: Identity = await registerIdentity(eConn, { kind: 'human', name: 'A07 用户戊' });

    // 创建：URL 使用 PUBLIC_ORIGIN，明文不在 link 快照，重放不可恢复。
    const createRequestId = newRequestId('clink');
    const created = await createLink(aConn, { requestId: createRequestId });
    const token = linkToken(created.share_url);
    check(
      'A07 创建链接返回 PUBLIC_ORIGIN 分享 URL',
      created.share_url.startsWith(`${expectedOrigin()}/#friend=`),
      created.share_url.replace(/#friend=.*/u, '#friend=<redacted>'),
    );
    check('A07 创建返回 pending 且 owner 可撤销', created.link.status === 'pending' && created.link.can_revoke);
    check(
      'A07 创建响应与 link 快照不含 token/token_hash',
      !('token' in created) &&
        !JSON.stringify(created).includes('token_hash') &&
        !JSON.stringify(created.link).includes(token),
      Object.keys(created),
    );
    await expectToolError(
      'A07 创建同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE',
      createLink(aConn, { requestId: createRequestId }),
      'TOKEN_NOT_REPLAYABLE',
    );
    const anonymousPreview = await previewLink(token);
    checkEqual('A07 无鉴权预览有效链接', anonymousPreview.valid, true);
    checkEqual('A07 预览返回邀请人名称', anonymousPreview.owner?.name, 'A07 邀请人');
    const invalidPreview = await previewLink('not_a_real_friend_link_token');
    check(
      'A07 无效 token 预览返回 invalid 且不泄露 token',
      invalidPreview.valid === false && invalidPreview.reason === 'invalid',
      invalidPreview,
    );

    // 自己不能兑换；失败不消费链接。
    await expectToolError(
      'A07 自己兑换返回 INVALID_ARGUMENT',
      redeemLink(aConn, token),
      'INVALID_ARGUMENT',
    );
    const afterSelf = await callTool<ContactLinkListResult>(
      aConn.client,
      'network_contact_link_list',
      { limit: 50 },
    );
    checkEqual(
      'A07 自己兑换失败不消费链接',
      afterSelf.items.find((item) => item.link_id === created.link.link_id)?.status,
      'pending',
    );

    // 订阅 A 后由 B 兑换：直接 active，事件为 contact informational。
    const collector = notificationCollector(aConn.client);
    subscription = await openSubscription(aConn.client, [STREAM_URI]);
    const aPendingBefore = (await callTool<Identity>(aConn.client, 'network_me', {})).pending_count;
    const bPendingBefore = (await callTool<Identity>(bConn.client, 'network_me', {})).pending_count;
    const redeemRequestId = newRequestId('clredeem');
    const redeemed = await redeemLink(bConn, token, redeemRequestId);
    checkEqual('A07 兑换直接返回 active 关系', redeemed.relation.status, 'active');
    checkEqual('A07 关系来源为 invite_link', redeemed.relation.source, 'invite_link');
    checkEqual('A07 首次兑换 already_friends=false', redeemed.already_friends, false);
    checkEqual('A07 兑换返回邀请人', redeemed.owner.actor_id, a.actor_id);
    checkEqual('A07 兑换方看到 active 关系', await contactRelation(bConn, a.actor_id), 'active');
    checkEqual('A07 邀请方看到 active 关系', await contactRelation(aConn, b.actor_id), 'active');
    checkEqual(
      'A07 兑换不创建 pending 好友申请',
      (
        await callTool<{ items: { contact_request_id: string }[] }>(
          aConn.client,
          'network_contact_requests_list',
          { direction: 'all', status: 'pending', limit: 50 },
        )
      ).items.length,
      0,
    );
    const streamEvent = await collector.waitFor(
      (event) =>
        event.params.uri === STREAM_URI &&
        streamItemsOf(event).some(
          (item) => item.kind === 'contact' && item.ref_id === created.link.link_id,
        ),
      'A07 兑换事件',
    );
    check(
      'A07 兑换只发 contact informational 事件',
      streamItemsOf(streamEvent).every(
        (item) => item.kind === 'contact' && item.attention === 'informational',
      ),
      streamItemsOf(streamEvent),
    );
    const aPendingAfter = (await callTool<Identity>(aConn.client, 'network_me', {})).pending_count;
    const bPendingAfter = (await callTool<Identity>(bConn.client, 'network_me', {})).pending_count;
    checkEqual('A07 兑换不增加邀请方 pending_count', aPendingAfter, aPendingBefore);
    checkEqual('A07 兑换不增加兑换方 pending_count', bPendingAfter, bPendingBefore);
    const aInbox = await callTool<{ items: unknown[] }>(aConn.client, 'network_inbox_list', {
      limit: 10,
    });
    checkEqual('A07 兑换不创建 delivery', aInbox.items.length, 0);

    // 重放同一 request_id 返回首次结果；新 request_id 返回已使用。
    const replayResult = await redeemLink(bConn, token, redeemRequestId);
    checkEqual('A07 同一 request_id 兑换重放返回首次结果', replayResult.already_friends, false);
    checkEqual('A07 重放结果关系仍为 active', replayResult.relation.status, 'active');
    const usedError = await expectToolError(
      'A07 已使用链接再次兑换返回 CONTACT_LINK_INVALID',
      redeemLink(bConn, token),
      'CONTACT_LINK_INVALID',
    );
    checkEqual('A07 已使用 reason=used', (usedError.body.details as { reason?: string })?.reason, 'used');
    const usedPreview = await previewLink(token);
    check(
      'A07 已使用链接预览 valid=false',
      usedPreview.valid === false && usedPreview.reason === 'used',
      usedPreview,
    );

    // owner-only 撤销、重复撤销幂等、撤销后不能兑换。
    const revocable = await createLink(aConn);
    const revocableToken = linkToken(revocable.share_url);
    const otherRevoke = await expectToolError(
      'A07 非 owner 撤销返回 PERMISSION_DENIED',
      callTool(bConn.client, 'network_contact_link_revoke', {
        request_id: newRequestId('clrevoke'),
        link_id: revocable.link.link_id,
      }),
      'PERMISSION_DENIED',
    );
    check('A07 非 owner 撤销错误包含权限提示', otherRevoke.message.includes('只有链接创建者'));
    const revoked = await callTool<ContactLinkRevokeResult>(
      aConn.client,
      'network_contact_link_revoke',
      { request_id: newRequestId('clrevoke'), link_id: revocable.link.link_id },
    );
    checkEqual('A07 owner 撤销后状态为 revoked', revoked.link.status, 'revoked');
    const revokedAgain = await callTool<ContactLinkRevokeResult>(
      aConn.client,
      'network_contact_link_revoke',
      { request_id: newRequestId('clrevoke'), link_id: revocable.link.link_id },
    );
    checkEqual('A07 重复撤销幂等', revokedAgain.already_revoked, true);
    const revokedError = await expectToolError(
      'A07 撤销后不能兑换',
      redeemLink(cConn, revocableToken),
      'CONTACT_LINK_INVALID',
    );
    checkEqual(
      'A07 已撤销 reason=revoked',
      (revokedError.body.details as { reason?: string })?.reason,
      'revoked',
    );
    await expectToolError(
      'A07 撤销未知链接返回 NOT_FOUND',
      callTool(aConn.client, 'network_contact_link_revoke', {
        request_id: newRequestId('clrevoke'),
        link_id: 'clink_missing',
      }),
      'NOT_FOUND',
    );

    // 已存在关系：幂等 success，不消费链接；第三方仍可兑换。
    const reusable = await createLink(aConn);
    const reusableToken = linkToken(reusable.share_url);
    const already = await redeemLink(bConn, reusableToken);
    checkEqual('A07 已是好友返回 already_friends=true', already.already_friends, true);
    checkEqual('A07 已是好友关系仍为 active', already.relation.status, 'active');
    const reusableAfterAlready = await callTool<ContactLinkListResult>(
      aConn.client,
      'network_contact_link_list',
      { limit: 50 },
    );
    checkEqual(
      'A07 已是好友不消费链接',
      reusableAfterAlready.items.find((item) => item.link_id === reusable.link.link_id)?.status,
      'pending',
    );
    const thirdParty = await redeemLink(eConn, reusableToken);
    checkEqual('A07 未消费链接可被第三方兑换', thirdParty.already_friends, false);
    checkEqual('A07 第三方关系 active', await contactRelation(eConn, a.actor_id), 'active');

    // 拉黑优先于加好友：任一方向都 BLOCKED，且链接保持 pending。
    const blockedLink = await createLink(aConn);
    const blockedToken = linkToken(blockedLink.share_url);
    await callTool(aConn.client, 'network_contact_block', {
      request_id: newRequestId('clblock'),
      actor_id: d.actor_id,
    });
    await expectToolError(
      'A07 邀请方拉黑后兑换返回 BLOCKED',
      redeemLink(dConn, blockedToken),
      'BLOCKED',
    );
    await callTool(aConn.client, 'network_contact_unblock', {
      request_id: newRequestId('clunblock'),
      actor_id: d.actor_id,
    });
    await callTool(dConn.client, 'network_contact_block', {
      request_id: newRequestId('clblock'),
      actor_id: a.actor_id,
    });
    await expectToolError(
      'A07 兑换方拉黑邀请方同样 BLOCKED',
      redeemLink(dConn, blockedToken),
      'BLOCKED',
    );
    const blockedList = await callTool<ContactLinkListResult>(
      aConn.client,
      'network_contact_link_list',
      { limit: 50 },
    );
    checkEqual(
      'A07 拉黑失败不消费链接',
      blockedList.items.find((item) => item.link_id === blockedLink.link.link_id)?.status,
      'pending',
    );
    await callTool(dConn.client, 'network_contact_unblock', {
      request_id: newRequestId('clunblock'),
      actor_id: a.actor_id,
    });
    const thirdUser = await redeemLink(cConn, blockedToken);
    checkEqual('A07 拉黑尝试后链接仍可被其他人兑换', thirdUser.already_friends, false);
    checkEqual('A07 用户丙关系 active', await contactRelation(cConn, a.actor_id), 'active');

    // 过期：读取时标记 expired，兑换返回 reason=expired。
    const expiring = await createLink(aConn, { expiresInMs: LIMITS.contactLinkTtlMinMs });
    const expiringToken = linkToken(expiring.share_url);
    await sleep(LIMITS.contactLinkTtlMinMs + 250);
    const expiredError = await expectToolError(
      'A07 过期链接返回 CONTACT_LINK_INVALID',
      redeemLink(eConn, expiringToken),
      'CONTACT_LINK_INVALID',
    );
    checkEqual(
      'A07 过期 reason=expired',
      (expiredError.body.details as { reason?: string })?.reason,
      'expired',
    );
    const expiredPreview = await previewLink(expiringToken);
    check(
      'A07 过期链接预览 valid=false',
      expiredPreview.valid === false && expiredPreview.reason === 'expired',
      expiredPreview,
    );

    // pending 上限：当前 pending 数量已知，补满后下一次返回 QUOTA_EXCEEDED。
    let pendingList = await callTool<ContactLinkListResult>(
      aConn.client,
      'network_contact_link_list',
      { limit: 50 },
    );
    let pendingCount = pendingList.items.filter((item) => item.status === 'pending').length;
    while (pendingCount < LIMITS.contactLinkPendingMax) {
      await createLink(aConn);
      pendingCount += 1;
    }
    const quotaError = await expectToolError(
      'A07 pending 链接超过上限返回 QUOTA_EXCEEDED',
      createLink(aConn),
      'QUOTA_EXCEEDED',
    );
    checkEqual(
      'A07 超限 details.max 与 LIMITS 一致',
      (quotaError.body.details as { max?: number })?.max,
      LIMITS.contactLinkPendingMax,
    );

    // 列表：owner-scoped、使用状态展示兑换者、无明文/摘要。
    pendingList = await callTool<ContactLinkListResult>(aConn.client, 'network_contact_link_list', {
      limit: 50,
    });
    const usedItem = pendingList.items.find((item) => item.link_id === created.link.link_id);
    checkEqual('A07 列表显示已使用状态', usedItem?.status, 'used');
    checkEqual('A07 列表显示兑换者', usedItem?.used_by?.actor_id, b.actor_id);
    checkEqual('A07 列表不返回 share_url', JSON.stringify(pendingList).includes('#friend='), false);
    checkEqual('A07 列表不返回 token_hash', JSON.stringify(pendingList).includes('token_hash'), false);
    const bList = await callTool<ContactLinkListResult>(bConn.client, 'network_contact_link_list', {
      limit: 50,
    });
    checkEqual('A07 列表按 owner 隔离', bList.items.length, 0);
    const activeFriend = await callTool<{ items: ContactRow[] }>(
      aConn.client,
      'network_contacts_list',
      { limit: 100 },
    );
    check(
      'A07 好友列表包含 B/C/E',
      [b.actor_id, c.actor_id, e.actor_id].every((actorId) =>
        activeFriend.items.some((item) => item.actor_id === actorId && item.relation === 'active'),
      ),
      activeFriend.items.map((item) => item.actor_id),
    );
    checkEqual(
      'A07 被拉黑用户未建立关系',
      activeFriend.items.some((item) => item.actor_id === d.actor_id),
      false,
    );
  } finally {
    await subscription?.close().catch(() => undefined);
    await aConn.close();
    await bConn.close();
    await cConn.close();
    await dConn.close();
    await eConn.close();
  }
}
