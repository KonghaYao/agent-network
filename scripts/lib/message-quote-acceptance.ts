/**
 * 引用消息读取端到端验收（B2）。
 *
 * 通过公开工具验证 `network_message_read` 首次分块返回 reply_to 与有界 quote：
 * 有引用、无引用、长正文多分块、撤回、加入前边界，以及 quote 不改变正文、
 * 分块与游标。父消息不存在的分支由 `message-quote-unit.ts` 覆盖；发送入口
 * 会拒绝指向不存在/不可见父消息的 reply_to，端到端无法构造该状态。
 */

import { callTool, check, checkEqual, newRequestId, type McpConnection } from './harness';
import {
  createActor,
  createRoom,
  makeFriends,
  roomDetail,
  setPolicy,
} from './group-history-helpers';
import { sendMessage } from './acceptance-helpers';

const RUN = crypto.randomUUID().replaceAll('-', '').slice(0, 10);

interface QuoteView {
  message_id: string;
  sender_id: string;
  sender_name: string;
  sender_kind: 'human' | 'agent';
  preview: string;
  created_at: string;
}

interface ReadChunkView {
  message_id: string;
  room_id: string;
  chunk: string;
  chunk_cursor: string;
  next_cursor: string | null;
  eof: boolean;
  body_bytes: number;
  created_seq: string;
  reply_to?: string | null;
  quote?: QuoteView | null;
}

async function readChunk(
  connection: McpConnection,
  messageId: string,
  cursor?: string,
): Promise<ReadChunkView> {
  return callTool<ReadChunkView>(connection.client, 'network_message_read', {
    message_id: messageId,
    ...(cursor === undefined ? {} : { chunk_cursor: cursor }),
  });
}

export async function runMessageQuoteAcceptance(): Promise<void> {
  const owner = await createActor('引用验收 owner', 'human');
  const peer = await createActor('引用验收 peer', 'human');
  const late = await createActor('引用验收 late', 'human');
  const seed = await createActor('引用验收 seed', 'human');
  try {
    await makeFriends(owner, peer);
    await makeFriends(owner, late);
    await makeFriends(owner, seed);

    const roomId = await createRoom(
      owner.connection,
      [peer.actor.actor_id],
      `引用验收群 ${RUN}`,
    );

    // ---- 有引用：首次分块返回结构化 quote ----
    const parentBody = `父消息 ${RUN} 完整正文`;
    const parent = await sendMessage(owner.connection, roomId, parentBody);
    const replyBody = `回复 ${RUN}`;
    const reply = await sendMessage(peer.connection, roomId, replyBody, {
      replyTo: parent.message.message_id,
    });
    const first = await readChunk(peer.connection, reply.message.message_id);
    checkEqual('引用：首次分块 reply_to', first.reply_to, parent.message.message_id);
    checkEqual('引用：首次分块 chunk_cursor', first.chunk_cursor, '0');
    checkEqual('引用：正文不受影响', first.chunk, replyBody);
    checkEqual('引用：eof', first.eof, true);
    checkEqual('引用：next_cursor', first.next_cursor, null);
    check('引用：quote 非空', first.quote !== null && first.quote !== undefined, first.quote);
    checkEqual('引用：quote message_id', first.quote?.message_id, parent.message.message_id);
    checkEqual('引用：quote sender_id', first.quote?.sender_id, owner.actor.actor_id);
    checkEqual('引用：quote sender_name', first.quote?.sender_name, owner.actor.name);
    checkEqual('引用：quote sender_kind', first.quote?.sender_kind, 'human');
    checkEqual('引用：quote preview', first.quote?.preview, parentBody);
    check(
      '引用：quote created_at 为毫秒字符串',
      typeof first.quote?.created_at === 'string' && /^\d+$/u.test(first.quote.created_at),
      first.quote?.created_at,
    );

    // 显式 chunk_cursor=0 仍视为首次分块。
    const explicitZero = await readChunk(peer.connection, reply.message.message_id, '0');
    checkEqual('引用：chunk_cursor=0 仍带 quote', explicitZero.quote?.message_id, parent.message.message_id);

    // ---- 无引用：reply_to 与 quote 都是 null ----
    const plain = await readChunk(owner.connection, parent.message.message_id);
    checkEqual('无引用：reply_to 为 null', plain.reply_to, null);
    checkEqual('无引用：quote 为 null', plain.quote, null);

    // ---- 长正文：quote 只出现一次，正文/分块/游标不变 ----
    const longParent = await sendMessage(owner.connection, roomId, `长正文父消息 ${RUN}`);
    const longBody = `长回复 ${RUN} ${'长'.repeat(32_000)}`;
    const longReply = await sendMessage(peer.connection, roomId, longBody, {
      replyTo: longParent.message.message_id,
    });
    const longFirst = await readChunk(peer.connection, longReply.message.message_id);
    checkEqual('长引用：首块带 quote', longFirst.quote?.message_id, longParent.message.message_id);
    checkEqual('长引用：首块 eof=false', longFirst.eof, false);
    check('长引用：首块有 next_cursor', typeof longFirst.next_cursor === 'string' && longFirst.next_cursor.length > 0);
    let assembled = longFirst.chunk;
    let cursor = longFirst.next_cursor;
    let rounds = 1;
    while (cursor !== null && cursor !== undefined) {
      const next = await readChunk(peer.connection, longReply.message.message_id, cursor);
      if (rounds === 1) {
        checkEqual('长引用：后续分块省略 reply_to', next.reply_to, undefined);
        checkEqual('长引用：后续分块省略 quote', next.quote, undefined);
      }
      assembled += next.chunk;
      cursor = next.next_cursor;
      rounds += 1;
      check('长引用：分块轮次有界', rounds < 20, rounds);
    }
    checkEqual('长引用：拼接正文与发送一致', assembled, longBody);
    checkEqual('长引用：body_bytes 与发送一致', longFirst.body_bytes, Buffer.byteLength(longBody, 'utf8'));
    checkEqual('长引用：chunk_cursor 从 0 开始', longFirst.chunk_cursor, '0');

    // ---- 父消息已撤回：quote 为 null，正文照常可读 ----
    const recalledParent = await sendMessage(owner.connection, roomId, `待撤回父消息 ${RUN}`);
    const afterRecallReply = await sendMessage(peer.connection, roomId, `撤回后回复 ${RUN}`, {
      replyTo: recalledParent.message.message_id,
    });
    await callTool(owner.connection.client, 'network_message_recall', {
      request_id: newRequestId('quote_recall'),
      message_id: recalledParent.message.message_id,
    });
    const recalledRead = await readChunk(peer.connection, afterRecallReply.message.message_id);
    checkEqual('撤回引用：reply_to 保留', recalledRead.reply_to, recalledParent.message.message_id);
    checkEqual('撤回引用：quote 为 null', recalledRead.quote, null);
    checkEqual('撤回引用：正文照常返回', recalledRead.chunk, `撤回后回复 ${RUN}`);

    // ---- 父消息在加入前：当前边界不可见时 quote 为 null ----
    const boundaryRoom = await createRoom(
      owner.connection,
      [seed.actor.actor_id],
      `引用边界群 ${RUN}`,
    );
    const beforeJoin = await sendMessage(owner.connection, boundaryRoom, `加入前父消息 ${RUN}`);
    await callTool(owner.connection.client, 'network_room_members_update', {
      request_id: newRequestId('quote_add_member'),
      room_id: boundaryRoom,
      add: [late.actor.actor_id],
    });
    const beforePolicy = await roomDetail(owner.connection, boundaryRoom);
    await setPolicy(owner.connection, boundaryRoom, beforePolicy.room.policy_revision, {
      member_history_policy: 'from_join',
    });
    const afterJoinReply = await sendMessage(owner.connection, boundaryRoom, `加入后回复 ${RUN}`, {
      replyTo: beforeJoin.message.message_id,
    });
    const lateRead = await readChunk(late.connection, afterJoinReply.message.message_id);
    checkEqual('加入前引用：reply_to 保留', lateRead.reply_to, beforeJoin.message.message_id);
    checkEqual('加入前引用：quote 为 null', lateRead.quote, null);
    checkEqual('加入前引用：正文照常返回', lateRead.chunk, `加入后回复 ${RUN}`);
  } finally {
    await Promise.all([owner.connection.close(), peer.connection.close(), late.connection.close(), seed.connection.close()]);
  }
}
