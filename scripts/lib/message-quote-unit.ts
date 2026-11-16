/**
 * 引用上下文的纯判定单测。
 *
 * 只覆盖 `quoteFromParent` 的分支：不存在的父消息、跨房间、加入前、
 * 解散上界、已撤回、发送者缺失与名称/预览截断。端到端读取在
 * `message-quote-acceptance.ts` 里覆盖。
 */

import { check, checkEqual } from './harness';
import { quoteFromParent } from '../../src/domain/messages/history';
import type { HistoryBoundary } from '../../src/domain/room-history';

function boundary(overrides: Partial<HistoryBoundary> = {}): HistoryBoundary {
  return {
    full: true,
    fromSeq: 0,
    fromAt: 0,
    toSeq: null,
    toAt: null,
    policyRevision: 1,
    memberGeneration: 1,
    ...overrides,
  };
}

function parent(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 'msg_parent',
    room_id: 'rm_quote',
    sender_id: 'agt_author',
    preview: '父消息预览',
    body_bytes: 18,
    created_seq: 5,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

const sender = { name: '父消息作者', kind: 'human' as const };

export function runMessageQuoteUnitChecks(): void {
  checkEqual(
    'quote 单元：父消息不存在返回 null',
    quoteFromParent(null, sender, 'rm_quote', boundary()),
    null,
  );
  checkEqual(
    'quote 单元：发送者删除返回 null',
    quoteFromParent(parent(), null, 'rm_quote', boundary()),
    null,
  );
  checkEqual(
    'quote 单元：跨房间返回 null',
    quoteFromParent(parent({ room_id: 'rm_other' }), sender, 'rm_quote', boundary()),
    null,
  );
  checkEqual(
    'quote 单元：加入前返回 null',
    quoteFromParent(parent({ created_seq: 5 }), sender, 'rm_quote', boundary({ full: false, fromSeq: 6 })),
    null,
  );
  checkEqual(
    'quote 单元：解散归档上界外返回 null',
    quoteFromParent(parent({ created_seq: 9 }), sender, 'rm_quote', boundary({ toSeq: 8 })),
    null,
  );
  checkEqual(
    'quote 单元：已撤回返回 null',
    quoteFromParent(parent({ body_bytes: 0 }), sender, 'rm_quote', boundary()),
    null,
  );

  const happy = quoteFromParent(parent(), sender, 'rm_quote', boundary());
  check('quote 单元：可见父消息返回 quote', happy !== null, happy);
  checkEqual('quote 单元：message_id', happy?.message_id, 'msg_parent');
  checkEqual('quote 单元：sender_id', happy?.sender_id, 'agt_author');
  checkEqual('quote 单元：sender_name', happy?.sender_name, '父消息作者');
  checkEqual('quote 单元：sender_kind', happy?.sender_kind, 'human');
  checkEqual('quote 单元：preview', happy?.preview, '父消息预览');
  checkEqual('quote 单元：created_at 为字符串', happy?.created_at, '1700000000000');

  const longPreview = quoteFromParent(
    parent({ preview: '引'.repeat(200) }),
    sender,
    'rm_quote',
    boundary(),
  );
  check(
    'quote 单元：preview 截断到 120 字节',
    longPreview !== null && Buffer.byteLength(longPreview.preview, 'utf8') <= 120,
    longPreview?.preview?.length,
  );
  checkEqual('quote 单元：preview 为 40 个三字节字符', longPreview?.preview, '引'.repeat(40));

  const longName = quoteFromParent(
    parent(),
    { name: '名'.repeat(120), kind: 'agent' as const },
    'rm_quote',
    boundary(),
  );
  check(
    'quote 单元：sender_name 不超过 96 字符',
    longName !== null && Array.from(longName.sender_name).length <= 96,
    longName?.sender_name?.length,
  );
  check(
    'quote 单元：sender_name 保持合法 UTF-8',
    longName !== null && longName.sender_name === '名'.repeat(96),
    longName?.sender_name?.length,
  );
}
