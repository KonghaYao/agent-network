/**
 * Q05-T01 场景一：同一 client_message_id / request_id 的并发同意图写入。
 *
 * 100 轮，每轮两个 100 并发批次；断言只有一条消息、一组 delivery、正文与
 * event_seq 一致，不同正文复用 request_id/client_message_id 被明确拒绝。
 */

import {
  burst,
  drainDelivery,
  fulfilled,
  newRequestId,
  q05Check,
  q05Equal,
  q05Tool,
  rejectedCodes,
  sendMessage,
  type Q05Actor,
  type Q05Db,
  type Q05Server,
  type RoundBody,
} from './q05-harness';

interface SendView {
  message: {
    message_id: string;
    created_seq: string;
    preview: string;
    body_bytes: number;
  };
  delivery_ids: string[];
}

interface MessageRow {
  message_id: string;
  body: string;
  created_seq: string | null;
}

export function q05MessagesRound(
  server: Q05Server,
  db: Q05Db,
  actor: Q05Actor,
  roomId: string,
  invokeA: Q05Actor,
  invokeB: Q05Actor,
): RoundBody {
  return async (round) => {
    const body = `Q05 并发消息 ${round} 轮（合成）`;
    const requestId = newRequestId(`msg_a_${round}`);
    const clientMessageId = `cm_q05a_${round}_${crypto.randomUUID()}`;

    // A. 同 request_id + 同 client_message_id 的 100 并发发送。
    const sameRequest = await burst(100, () =>
      sendMessage(server, actor, roomId, body, {
        requestId,
        clientMessageId,
        invoke: [invokeA.actor_id],
      }),
    );
    const sameRequestOk = fulfilled(sameRequest) as SendView[];
    q05Check(`第 ${round} 轮同 request_id 全部成功`, sameRequestOk.length === 100, {
      ok: sameRequestOk.length,
      codes: [...new Set(rejectedCodes(sameRequest))],
    });
    const messageIds = new Set(sameRequestOk.map((item) => item.message.message_id));
    q05Equal(`第 ${round} 轮只产生一条消息`, messageIds.size, 1);
    const seqs = new Set(sameRequestOk.map((item) => item.message.created_seq));
    q05Equal(`第 ${round} 轮同 request_id 的 seq 一致`, seqs.size, 1);
    const deliverySets = new Set(
      sameRequestOk.map((item) => [...item.delivery_ids].sort().join(',')),
    );
    q05Equal(`第 ${round} 轮只产生一组 delivery`, deliverySets.size, 1);
    q05Equal(`第 ${round} 轮 delivery 只给明确 invoke`, sameRequestOk[0]!.delivery_ids.length, 1);

    const messageId = sameRequestOk[0]!.message.message_id;
    const row = db.row<MessageRow>('SELECT * FROM messages WHERE message_id = ?', messageId);
    q05Check(`第 ${round} 轮权威正文一致`, row?.body === body, {
      actualBytes: row?.body.length,
      expectedBytes: body.length,
    });
    q05Equal(
      `第 ${round} 轮 client_message_id 只有一行`,
      db.scalar(
        'SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND client_message_id = ?',
        actor.actor_id,
        clientMessageId,
      ),
      1,
    );
    q05Equal(
      `第 ${round} 轮消息事件只有一条`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM events WHERE event_type = 'message_created' AND ref_id = ?",
        messageId,
      ),
      1,
    );
    q05Equal(
      `第 ${round} 轮该 request_id 只有一份幂等结果`,
      db.scalar(
        'SELECT COUNT(*) AS n FROM operations WHERE actor_id = ? AND request_id = ?',
        actor.actor_id,
        requestId,
      ),
      1,
    );
    await drainDelivery(server, invokeA, sameRequestOk[0]!.delivery_ids[0]!);

    // B. 同 client_message_id、不同 request_id 的 100 并发发送。
    const clientMessageIdB = `cm_q05b_${round}_${crypto.randomUUID()}`;
    const bodyB = `Q05 并发 client id ${round} 轮（合成）`;
    const distinctRequestIds = Array.from({ length: 100 }, () => newRequestId(`msg_b_${round}`));
    const sameClient = await burst(100, (index) =>
      sendMessage(server, actor, roomId, bodyB, {
        requestId: distinctRequestIds[index]!,
        clientMessageId: clientMessageIdB,
        invoke: [invokeB.actor_id],
      }),
    );
    const sameClientOk = fulfilled(sameClient) as SendView[];
    q05Check(`第 ${round} 轮同 client_message_id 全部成功`, sameClientOk.length === 100, {
      ok: sameClientOk.length,
      codes: [...new Set(rejectedCodes(sameClient))],
    });
    q05Equal(
      `第 ${round} 轮同 client_message_id 只产生一条消息`,
      new Set(sameClientOk.map((item) => item.message.message_id)).size,
      1,
    );
    q05Equal(
      `第 ${round} 轮同 client_message_id 只有一行`,
      db.scalar(
        'SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND client_message_id = ?',
        actor.actor_id,
        clientMessageIdB,
      ),
      1,
    );
    const rowB = db.row<MessageRow>(
      'SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?',
      actor.actor_id,
      clientMessageIdB,
    );
    q05Check(`第 ${round} 轮 client id 权威正文一致`, rowB?.body === bodyB);
    q05Equal(
      `第 ${round} 轮 client id 只产生一条 delivery`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM deliveries WHERE message_id = ? AND recipient_id = ?",
        rowB!.message_id,
        invokeB.actor_id,
      ),
      1,
    );
    await drainDelivery(server, invokeB, sameClientOk[0]!.delivery_ids[0]!);

    // C. 同 request_id 不同正文：先提交者成功，另一请求必须明确冲突。
    const conflictRequest = newRequestId(`msg_c_${round}`);
    const bodyC1 = `Q05 冲突正文 A ${round}`;
    const bodyC2 = `Q05 冲突正文 B ${round}`;
    const conflict = await Promise.allSettled([
      sendMessage(server, actor, roomId, bodyC1, {
        requestId: conflictRequest,
        clientMessageId: `cm_q05c1_${round}_${crypto.randomUUID()}`,
        invoke: [],
      }),
      sendMessage(server, actor, roomId, bodyC2, {
        requestId: conflictRequest,
        clientMessageId: `cm_q05c2_${round}_${crypto.randomUUID()}`,
        invoke: [],
      }),
    ]);
    const conflictOk = fulfilled(conflict) as SendView[];
    q05Equal(`第 ${round} 轮冲突对只允许一个成功`, conflictOk.length, 1);
    q05Equal(
      `第 ${round} 轮冲突方返回 IDEMPOTENCY_CONFLICT`,
      rejectedCodes(conflict).includes('IDEMPOTENCY_CONFLICT'),
      true,
    );
    q05Check(
      `第 ${round} 轮冲突只写入一个正文`,
      db.scalar('SELECT COUNT(*) AS n FROM messages WHERE body IN (?, ?)', bodyC1, bodyC2) === 1,
      {
        c1: db.scalar('SELECT COUNT(*) AS n FROM messages WHERE body = ?', bodyC1),
        c2: db.scalar('SELECT COUNT(*) AS n FROM messages WHERE body = ?', bodyC2),
      },
    );

    // D. 同 client_message_id 不同正文：稳定拒绝，不覆盖原消息。
    const stableClient = `cm_q05d_${round}_${crypto.randomUUID()}`;
    await sendMessage(server, actor, roomId, `Q05 稳定正文 ${round}`, {
      requestId: newRequestId(`msg_d_${round}`),
      clientMessageId: stableClient,
      invoke: [],
    });
    const overwrite = await sendMessage(server, actor, roomId, `Q05 覆盖正文 ${round}`, {
      requestId: newRequestId(`msg_d2_${round}`),
      clientMessageId: stableClient,
      invoke: [],
    }).catch((error: unknown) => error);
    q05Equal(
      `第 ${round} 轮不同正文复用 client_message_id 被拒`,
      overwrite instanceof Error && 'code' in overwrite ? (overwrite as { code: string }).code : 'OK',
      'IDEMPOTENCY_CONFLICT',
    );
    q05Equal(
      `第 ${round} 轮原消息正文未被覆盖`,
      db.row<MessageRow>('SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?', actor.actor_id, stableClient)?.body,
      `Q05 稳定正文 ${round}`,
    );
  };
}
