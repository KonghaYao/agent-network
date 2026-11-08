/**
 * Q05-T02 故障注入：事务回滚、响应丢失、outbox、重启、外部结果未知与重连。
 *
 * 故障只在测试进程的 HTTP 边界、SQLite 夹具与同一 DATA_DIR 的新进程上注入，
 * 不修改生产代码路径。断言以权威表、实际权限和可观察流为准。
 */

import { Database } from 'bun:sqlite';

import { createD1 } from '../../src/bun/d1';
import type { Env } from '../../src/env';
import { maintain } from '../../src/maintenance';
import { remindStaleDeliveries } from '../../src/domain/delivery-reminders';
import { remindStaleTasks } from '../../src/domain/task-reminders';
import { rawRpc } from './harness';

import {
  createGroup,
  createManagedAgent,
  drainDelivery,
  newRequestId,
  newToken,
  openQ05Stream,
  q05Check,
  q05Equal,
  q05Tool,
  q05ToolOutcome,
  sendMessage,
  startDropProxy,
  streamEventIds,
  waitForCondition,
  type Q05Db,
  type Q05Server,
  type RoundBody,
} from './q05-harness';
import type { Q05Fixture } from './q05-fixture';

interface SyncItem {
  event_id: string;
  seq: string;
  type: string;
  ref_id: string;
}

interface SyncPage {
  items: SyncItem[];
  next_cursor: string;
  head_cursor: string;
  has_more: boolean;
  reset_required: boolean;
}

interface TaskView {
  task_id: string;
  status: string;
  revision: number;
  owner_actor_id: string | null;
  assignment: {
    assignment_id: string;
    assignment_version: number;
    status: string;
  } | null;
  delivery_ids: string[];
}

interface TaskResult {
  task: TaskView;
}

async function runMaintenance(server: Q05Server): Promise<void> {
  const raw = new Database(server.dbPath);
  raw.exec('PRAGMA busy_timeout = 5000');
  try {
    await maintain({ DB: createD1(raw), ENVIRONMENT: 'test', PUBLIC_ORIGIN: server.base } as Env);
  } finally {
    raw.close();
  }
}

async function runReminders(server: Q05Server): Promise<void> {
  const raw = new Database(server.dbPath);
  raw.exec('PRAGMA busy_timeout = 5000');
  try {
    const d1 = createD1(raw);
    await remindStaleDeliveries(d1);
    await remindStaleTasks(d1);
  } finally {
    raw.close();
  }
}

async function syncAll(
  server: Q05Server,
  token: string,
  scope: string,
  cursor?: string,
): Promise<{ items: SyncItem[]; pages: number; lastCursor: string }> {
  const items: SyncItem[] = [];
  let next = cursor;
  let pages = 0;
  let lastCursor = cursor ?? '';
  for (;;) {
    const page = await q05Tool<SyncPage>(server, token, 'network_sync', {
      scope,
      ...(next ? { cursor: next } : {}),
      limit: 100,
    });
    q05Equal('sync 不使用静默重置', page.reset_required, false);
    items.push(...page.items);
    pages += 1;
    lastCursor = page.next_cursor;
    if (!page.has_more) break;
    next = page.next_cursor;
    if (pages > 20) throw new Error('sync 分页超过 20 页');
  }
  return { items, pages, lastCursor };
}

function outboxForMessage(db: Q05Db, messageId: string): {
  outbox_id: string;
  event_seq: number;
  status: string;
} | null {
  return db.row(
    `SELECT o.outbox_id, o.event_seq, o.status
       FROM outbox o JOIN events e ON e.event_seq = o.event_seq
      WHERE e.event_key = ?
      ORDER BY o.outbox_id ASC LIMIT 1`,
    `message:${messageId}`,
  );
}

export function q05FaultBodies(
  server: Q05Server,
  db: Q05Db,
  fixture: Q05Fixture,
): { name: string; body: RoundBody }[] {
  return [
    {
      name: 'transaction-rollback',
      body: async () => {
        const clientId = `cm_q05_rollback_${crypto.randomUUID()}`;
        const first = await sendMessage(server, fixture.u1, fixture.mainRoomId, 'Q05 回滚原消息', {
          requestId: newRequestId('rollback_first'),
          clientMessageId: clientId,
          invoke: [],
        });
        const conflicting = await q05ToolOutcome(server, fixture.u1.token, 'network_message_send', {
          request_id: newRequestId('rollback_conflict'),
          client_message_id: clientId,
          room_id: fixture.mainRoomId,
          body: 'Q05 必须整批回滚的正文',
          invoke: [],
        });
        q05Equal('事务回滚：冲突正文被拒', conflicting.ok, false);
        q05Equal('事务回滚：错误码稳定', conflicting.code, 'IDEMPOTENCY_CONFLICT');
        q05Equal(
          '事务回滚：原消息仍唯一',
          db.scalar(
            'SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND client_message_id = ?',
            fixture.u1.actor_id,
            clientId,
          ),
          1,
        );
        q05Equal(
          '事务回滚：冲突正文未落库',
          db.scalar(
            'SELECT COUNT(*) AS n FROM messages WHERE body = ?',
            'Q05 必须整批回滚的正文',
          ),
          0,
        );
        q05Equal(
          '事务回滚：操作所有权未残留',
          db.scalar(
            'SELECT COUNT(*) AS n FROM operations WHERE actor_id = ? AND request_id LIKE ?',
            fixture.u1.actor_id,
            'rollback_conflict%',
          ),
          0,
        );
        q05Equal(
          '事务回滚：原消息事件唯一',
          db.scalar(
            "SELECT COUNT(*) AS n FROM events WHERE event_type = 'message_created' AND ref_id = ?",
            first.message.message_id,
          ),
          1,
        );
        const retry = await sendMessage(server, fixture.u1, fixture.mainRoomId, 'Q05 回滚后新请求', {
          requestId: newRequestId('rollback_retry'),
          clientMessageId: `cm_q05_rollback_retry_${crypto.randomUUID()}`,
          invoke: [],
        });
        q05Check('事务回滚：新请求可继续写入', Boolean(retry.message.message_id));

        const missingAttachmentTask = await q05ToolOutcome(
          server,
          fixture.u1.token,
          'network_task_create',
          {
            request_id: newRequestId('rollback_task'),
            room_id: fixture.mainRoomId,
            title: 'Q05 不应半提交的任务',
            attachment_file_ids: ['f_q05_missing_attachment'],
          },
        );
        q05Equal('事务回滚：无效附件任务被拒', missingAttachmentTask.ok, false);
        q05Equal(
          '事务回滚：任务未半提交',
          db.scalar(
            "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Q05 不应半提交的任务'",
          ),
          0,
        );
      },
    },
    {
      name: 'response-loss',
      body: async () => {
        const proxy = startDropProxy(server.base);
        try {
          const clientId = `cm_q05_drop_${crypto.randomUUID()}`;
          const requestId = newRequestId('drop_message');
          const args = {
            request_id: requestId,
            client_message_id: clientId,
            room_id: fixture.mainRoomId,
            body: 'Q05 提交后响应丢失',
            invoke: [],
          };
          let dropped = false;
          try {
            await rawRpc('tools/call', { name: 'network_message_send', arguments: args }, {
              token: fixture.u1.token,
              url: new URL(`${proxy.base}/mcp`),
              headers: { 'x-q05-drop': '1' },
            });
          } catch {
            dropped = true;
          }
          q05Check('响应丢失：客户端确实读不到响应', dropped);
          const row = db.row<{ message_id: string }>(
            'SELECT message_id FROM messages WHERE sender_id = ? AND client_message_id = ?',
            fixture.u1.actor_id,
            clientId,
          )!;
          q05Check('响应丢失：业务已提交', Boolean(row?.message_id));
          const committed = row.message_id;
          const retry = await sendMessage(server, fixture.u1, fixture.mainRoomId, args.body, {
            requestId,
            clientMessageId: clientId,
            invoke: [],
          });
          q05Equal('响应丢失：同 request_id 重试返回同一消息', retry.message.message_id, committed);
          q05Equal(
            '响应丢失：消息仍只有一条',
            db.scalar(
              'SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND client_message_id = ?',
              fixture.u1.actor_id,
              clientId,
            ),
            1,
          );
          q05Equal(
            '响应丢失：事件仍只有一条',
            db.scalar(
              "SELECT COUNT(*) AS n FROM events WHERE event_type = 'message_created' AND ref_id = ?",
              committed,
            ),
            1,
          );

          const taskRequestId = newRequestId('drop_task');
          const taskTitle = `Q05 响应丢失任务 ${crypto.randomUUID()}`;
          let taskDropped = false;
          try {
            await rawRpc('tools/call', {
              name: 'network_task_create',
              arguments: {
                request_id: taskRequestId,
                room_id: fixture.mainRoomId,
                title: taskTitle,
              },
            }, {
              token: fixture.u1.token,
              url: new URL(`${proxy.base}/mcp`),
              headers: { 'x-q05-drop': '1' },
            });
          } catch {
            taskDropped = true;
          }
          q05Check('响应丢失：任务请求确实断开', taskDropped);
          const taskRow = db.row<{ task_id: string }>(
            'SELECT task_id FROM tasks WHERE title = ?',
            taskTitle,
          )!;
          q05Check('响应丢失：任务已提交', Boolean(taskRow?.task_id));
          const taskRetry = await q05Tool<TaskResult>(
            server,
            fixture.u1.token,
            'network_task_create',
            { request_id: taskRequestId, room_id: fixture.mainRoomId, title: taskTitle },
          );
          q05Equal('响应丢失：任务重试返回同一 task_id', taskRetry.task.task_id, taskRow.task_id);
          q05Equal(
            '响应丢失：任务卡唯一',
            db.scalar('SELECT COUNT(*) AS n FROM task_cards WHERE task_id = ?', taskRow.task_id),
            1,
          );
        } finally {
          await proxy.stop();
        }
      },
    },
    {
      name: 'outbox-replay',
      body: async () => {
        const message = await sendMessage(
          server,
          fixture.u2,
          fixture.directU1U2,
          'Q05 outbox 补发消息',
          { requestId: newRequestId('outbox_msg'), invoke: [] },
        );
        await waitForCondition('outbox 首次完成', () => {
          return outboxForMessage(db, message.message.message_id)?.status === 'completed';
        });
        const before = outboxForMessage(db, message.message.message_id)!;
        const eventSeq = before.event_seq;

        // 模拟“发布后、完成标记前”崩溃：只回拨 outbox 状态，不改业务事件。
        db.exec(
          "UPDATE outbox SET status = 'pending', lease_token = NULL, lease_until = NULL, completed_at = NULL WHERE outbox_id = ?",
          before.outbox_id,
        );
        await server.restart();
        const stream = await openQ05Stream(server, fixture.u1.token, ['agentnet://stream']);
        await q05Tool(server, fixture.u1.token, 'network_me', {});
        await stream.waitFor(
          (frame) => frame.includes(message.message.message_id),
          'outbox 重启后补发事件',
          10_000,
        );
        await waitForCondition('outbox 补发后完成', () => {
          return outboxForMessage(db, message.message.message_id)?.status === 'completed';
        });
        q05Equal(
          'outbox 补发不复制业务事件',
          db.scalar(
            "SELECT COUNT(*) AS n FROM events WHERE event_type = 'message_created' AND ref_id = ?",
            message.message.message_id,
          ),
          1,
        );
        const streamIds = streamEventIds(stream.frames);
        q05Check(
          'outbox 补发按 event_id 去重后只有一条',
          new Set(streamIds.filter((id) => id === String(eventSeq))).size === 1 &&
            streamIds.includes(String(eventSeq)),
          { eventSeq, streamIds: [...new Set(streamIds)] },
        );

        // 模拟“发布前、租约未到期”崩溃：重启后不得被静默丢弃，也不得提前发布。
        const holding = await sendMessage(
          server,
          fixture.u2,
          fixture.directU1U2,
          'Q05 outbox 持锁消息',
          { requestId: newRequestId('outbox_hold'), invoke: [] },
        );
        await waitForCondition('outbox 持锁消息首次完成', () => {
          return outboxForMessage(db, holding.message.message_id)?.status === 'completed';
        });
        const held = outboxForMessage(db, holding.message.message_id)!;
        db.exec(
          "UPDATE outbox SET status = 'processing', lease_token = 'q05-held', lease_until = ?, completed_at = NULL WHERE outbox_id = ?",
          Date.now() + 60 * 60_000,
          held.outbox_id,
        );
        await server.restart();
        const streamHeld = await openQ05Stream(server, fixture.u1.token, ['agentnet://stream']);
        await q05Tool(server, fixture.u1.token, 'network_me', {});
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
        q05Equal(
          'outbox 持锁期间不提前完成',
          outboxForMessage(db, holding.message.message_id)?.status,
          'processing',
        );
        q05Check(
          'outbox 持锁期间不丢事件',
          db.scalar(
            "SELECT COUNT(*) AS n FROM events WHERE event_type = 'message_created' AND ref_id = ?",
            holding.message.message_id,
          ) === 1,
        );
        db.exec(
          "UPDATE outbox SET lease_until = ? WHERE outbox_id = ?",
          Date.now() - 1_000,
          held.outbox_id,
        );
        await q05Tool(server, fixture.u1.token, 'network_me', {});
        await waitForCondition('outbox 租约到期后补发', () => {
          return outboxForMessage(db, holding.message.message_id)?.status === 'completed';
        });
        await streamHeld.waitFor(
          (frame) => frame.includes(holding.message.message_id),
          'outbox 租约到期后事件可观察',
          10_000,
        );
        q05Equal(
          'outbox 租约恢复不复制事件',
          db.scalar(
            "SELECT COUNT(*) AS n FROM events WHERE event_type = 'message_created' AND ref_id = ?",
            holding.message.message_id,
          ),
          1,
        );
        await stream.close();
        await streamHeld.close();
      },
    },
    {
      name: 'restart-recovery',
      body: async () => {
        // 使用本组专用 Agent 接收提醒，避免与消息场景的 @ 投递窗口相互污染。
        const reminderAgent = await createManagedAgent(
          server,
          fixture.u1.token,
          `Q05 重启提醒 Agent ${crypto.randomUUID().slice(0, 8)}`,
        );
        const friend = await q05Tool<{ status: string }>(
          server,
          fixture.u1.token,
          'network_contact_request',
          { request_id: newRequestId('restart_agent_friend'), actor_id: reminderAgent.actor_id },
        );
        q05Equal('重启提醒 Agent 建联成功', friend.status, 'accepted');
        const roomId = await createGroup(
          server,
          fixture.u1,
          [fixture.b1, reminderAgent],
          `Q05 重启恢复 ${crypto.randomUUID().slice(0, 8)}`,
        );
        const offered = await q05Tool<TaskResult>(server, fixture.u1.token, 'network_task_create', {
          request_id: newRequestId('restart_task'),
          room_id: roomId,
          title: 'Q05 重启任务',
          assignee_actor_id: fixture.b1.actor_id,
        });
        const accepted = await q05Tool<TaskResult>(server, fixture.b1.token, 'network_task_accept', {
          request_id: newRequestId('restart_task_accept'),
          task_id: offered.task.task_id,
          assignment_id: offered.task.assignment!.assignment_id,
          expected_revision: offered.task.revision,
        });
        // 先结束 offer 投递，避免 task_reminder 按设计让位给 delivery_reminder。
        const offerDelivery = db.row<{ delivery_id: string }>(
          "SELECT delivery_id FROM task_deliveries WHERE task_id = ? AND kind = 'task_offer'",
          offered.task.task_id,
        );
        if (offerDelivery) await drainDelivery(server, fixture.b1, offerDelivery.delivery_id);
        await q05Tool(server, fixture.b1.token, 'network_task_progress', {
          request_id: newRequestId('restart_progress'),
          task_id: offered.task.task_id,
          percent: 40,
          note: 'Q05 重启前进度',
          expected_revision: accepted.task.revision,
        });
        const marker = await sendMessage(server, fixture.u1, roomId, 'Q05 重启前消息', {
          requestId: newRequestId('restart_msg'),
          clientMessageId: `cm_restart_${crypto.randomUUID()}`,
          invoke: [reminderAgent.actor_id],
        });
        const delivery = db.row<{ delivery_id: string; state: string }>(
          'SELECT delivery_id, state FROM deliveries WHERE message_id = ? AND recipient_id = ?',
          marker.message.message_id,
          reminderAgent.actor_id,
        )!;
        const claimed = await q05Tool<{ delivery_id: string; attempt: number; claim_id: string }>(
          server,
          reminderAgent.token,
          'network_delivery_claim',
          { request_id: newRequestId('restart_claim'), delivery_id: delivery.delivery_id },
        );
        const old = Date.now() - 4 * 60_000;
        db.exec(
          'UPDATE deliveries SET progress_at = ?, last_reminded_at = NULL WHERE delivery_id = ?',
          old,
          delivery.delivery_id,
        );
        db.exec(
          'UPDATE tasks SET last_progress_at = ? WHERE task_id = ?',
          old,
          offered.task.task_id,
        );
        db.exec(
          'UPDATE task_assignments SET last_progress_at = ? WHERE assignment_id = ?',
          old,
          accepted.task.assignment!.assignment_id,
        );
        await runReminders(server);
        await runMaintenance(server);
        const remindersBefore = db.scalar(
          'SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ?',
          offered.task.task_id,
        );
        const deliveryRemindersBefore = db.scalar(
          "SELECT COUNT(*) AS n FROM events WHERE event_type = 'delivery_reminder' AND ref_id = ?",
          delivery.delivery_id,
        );
        q05Check('重启前任务提醒已持久化', remindersBefore >= 1, remindersBefore);
        q05Check('重启前投递提醒已持久化', deliveryRemindersBefore >= 1, deliveryRemindersBefore);

        await server.restart();
        const afterRestart = await q05Tool<TaskResult>(server, fixture.b1.token, 'network_task_get', {
          task_id: offered.task.task_id,
        });
        q05Equal('重启后任务状态保持 in_progress', afterRestart.task.status, 'in_progress');
        q05Equal('重启后任务 owner 保持', afterRestart.task.owner_actor_id, fixture.b1.actor_id);
        q05Equal(
          '重启后任务提醒未丢失',
          db.scalar('SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ?', offered.task.task_id),
          remindersBefore,
        );
        q05Equal(
          '重启后投递提醒未丢失',
          db.scalar(
            "SELECT COUNT(*) AS n FROM events WHERE event_type = 'delivery_reminder' AND ref_id = ?",
            delivery.delivery_id,
          ),
          deliveryRemindersBefore,
        );
        await runReminders(server);
        q05Equal(
          '重启后重复扫描不重复任务提醒',
          db.scalar('SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ?', offered.task.task_id),
          remindersBefore,
        );
        q05Equal(
          '重启后重复扫描不重复投递提醒',
          db.scalar(
            "SELECT COUNT(*) AS n FROM events WHERE event_type = 'delivery_reminder' AND ref_id = ?",
            delivery.delivery_id,
          ),
          deliveryRemindersBefore,
        );
        const history = await q05Tool<{ items: { message_id: string }[] }>(
          server,
          fixture.u1.token,
          'network_history_list',
          { room_id: roomId, limit: 50 },
        );
        q05Check(
          '重启后房间历史未丢失',
          history.items.some((item) => item.message_id === marker.message.message_id),
        );
        const inbox = await q05Tool<{ items: { delivery_id: string; state: string }[] }>(
          server,
          reminderAgent.token,
          'network_inbox_list',
          { state: 'all', limit: 50 },
        );
        const claimedAfter = inbox.items.find((item) => item.delivery_id === claimed.delivery_id);
        q05Check('重启后 claimed 投递仍可读', Boolean(claimedAfter), claimedAfter?.state);
        q05Equal('重启后 claimed 状态保持', claimedAfter?.state, 'claimed');
      },
    },
    {
      name: 'execution-unknown',
      body: async () => {
        const roomId = await createGroup(
          server,
          fixture.u1,
          [fixture.b1],
          `Q05 未知结果 ${crypto.randomUUID().slice(0, 8)}`,
        );
        const offered = await q05Tool<TaskResult>(server, fixture.u1.token, 'network_task_create', {
          request_id: newRequestId('unknown_task'),
          room_id: roomId,
          title: 'Q05 外部结果未知',
          assignee_actor_id: fixture.b1.actor_id,
        });
        const accepted = await q05Tool<TaskResult>(server, fixture.b1.token, 'network_task_accept', {
          request_id: newRequestId('unknown_accept'),
          task_id: offered.task.task_id,
          assignment_id: offered.task.assignment!.assignment_id,
          expected_revision: offered.task.revision,
        });
        const actionId = `act_q05_${crypto.randomUUID().replaceAll('-', '')}`;
        const unknown = await q05Tool<{
          task: { status: string; blocked_reason: string | null };
          action: { action_id: string; state: string };
        }>(server, fixture.b1.token, 'network_task_execution_unknown', {
          request_id: newRequestId('unknown_action'),
          task_id: offered.task.task_id,
          action_id: actionId,
          reason: 'Q05 外部调用响应丢失',
          assignment_id: accepted.task.assignment!.assignment_id,
          assignment_version: accepted.task.assignment!.assignment_version,
          expected_revision: accepted.task.revision,
        });
        q05Equal('未知结果：任务 blocked', unknown.task.status, 'blocked');
        q05Equal('未知结果：原因 execution_unknown', unknown.task.blocked_reason, 'execution_unknown');
        q05Equal('未知结果：action 保持 unknown', unknown.action.state, 'unknown');
        const deliveryCountBefore = db.scalar(
          'SELECT COUNT(*) AS n FROM task_deliveries WHERE task_id = ?',
          offered.task.task_id,
        );
        const duplicate = await q05Tool<{ action: { action_id: string; state: string } }>(
          server,
          fixture.b1.token,
          'network_task_execution_unknown',
          {
            request_id: newRequestId('unknown_action_dup'),
            task_id: offered.task.task_id,
            action_id: actionId,
            reason: 'Q05 重复上报',
          },
        ).catch((error: unknown) => error);
        q05Check(
          '未知结果：重复上报收敛为同一 action 或稳定冲突',
          duplicate instanceof Error ||
            (duplicate as { action?: { state?: string } }).action?.state === 'unknown',
        );
        await server.restart();
        const afterRestart = await q05Tool<TaskResult>(server, fixture.b1.token, 'network_task_get', {
          task_id: offered.task.task_id,
        });
        q05Equal('未知结果：重启后仍 blocked', afterRestart.task.status, 'blocked');
        const actionAfter = db.row<{ state: string }>(
          'SELECT state FROM task_external_actions WHERE action_id = ?',
          actionId,
        );
        q05Equal('未知结果：重启后仍 unknown', actionAfter?.state, 'unknown');
        q05Equal(
          '未知结果：不自动创建新投递',
          db.scalar('SELECT COUNT(*) AS n FROM task_deliveries WHERE task_id = ?', offered.task.task_id),
          deliveryCountBefore,
        );
        const resolved = await q05Tool<{
          task: { status: string };
          action: { state: string };
        }>(server, fixture.b1.token, 'network_task_execution_resolve', {
          request_id: newRequestId('unknown_resolve'),
          action_id: actionId,
          outcome: 'confirmed',
          evidence: 'Q05 已向外部系统查询 action_id，确认成功',
          assignment_id: accepted.task.assignment!.assignment_id,
          assignment_version: accepted.task.assignment!.assignment_version,
        });
        q05Equal('未知结果：对账 confirmed 后恢复 in_progress', resolved.task.status, 'in_progress');
        q05Equal('未知结果：action 标记 confirmed', resolved.action.state, 'confirmed');
        q05Equal(
          '未知结果：对账不重复副作用',
          db.scalar('SELECT COUNT(*) AS n FROM task_deliveries WHERE task_id = ?', offered.task.task_id),
          deliveryCountBefore,
        );
        const secondResolve = await q05ToolOutcome(server, fixture.b1.token, 'network_task_execution_resolve', {
          request_id: newRequestId('unknown_resolve_2'),
          action_id: actionId,
          outcome: 'rejected',
          evidence: 'Q05 已结论不可再次更改',
        });
        q05Equal('未知结果：action 结论不可改写', secondResolve.ok, false);
      },
    },
    {
      name: 'credential-reconnect',
      body: async () => {
        // 建立游标后断开流，离线期间写入，再重启并按 event_id 补读。
        const initial = await syncAll(server, fixture.u1.token, `room:${fixture.directU1U2}`);
        const cursor = initial.lastCursor;
        const stream = await openQ05Stream(server, fixture.u1.token, ['agentnet://stream']);
        try {
          for (let index = 0; index < 2; index += 1) {
            const message = await sendMessage(
              server,
              fixture.u2,
              fixture.directU1U2,
              `Q05 在线消息 ${index}`,
              { requestId: newRequestId('reconnect_online'), invoke: [] },
            );
            await stream.waitFor(
              (frame) => frame.includes(message.message.message_id),
              `重连前在线消息 ${index} 到达`,
              8_000,
            );
          }
        } finally {
          await stream.close();
        }
        const offlineIds: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const message = await sendMessage(
            server,
            fixture.u2,
            fixture.directU1U2,
            `Q05 离线消息 ${index}`,
            { requestId: newRequestId('reconnect_offline'), invoke: [] },
          );
          offlineIds.push(message.message.message_id);
        }
        await server.restart();
        const catchUp = await syncAll(
          server,
          fixture.u1.token,
          `room:${fixture.directU1U2}`,
          cursor,
        );
        const messageEvents = catchUp.items.filter((item) => item.type === 'message_created');
        q05Equal('重连补读消息数量完整', messageEvents.length >= 5, true);
        q05Equal(
          '重连补读按 event_id 去重',
          new Set(catchUp.items.map((item) => item.event_id)).size,
          catchUp.items.length,
        );
        for (const messageId of offlineIds) {
          q05Equal(
            `重连补读包含离线消息 ${messageId.slice(-6)}`,
            messageEvents.filter((item) => item.ref_id === messageId).length,
            1,
          );
        }

        // 被撤销的旧凭据不能读、写或收流；主设备仍可用。
        const deviceToken = newToken();
        const pairing = await q05Tool<{ pairing_id: string; challenge: string }>(
          server,
          fixture.u1.token,
          'network_device_pairing_create',
          { request_id: newRequestId('reconnect_pair'), device_label: 'Q05 重连设备', platform: 'iOS' },
        );
        const deviceId = `q05_reconnect_${crypto.randomUUID()}`;
        await q05Tool(server, deviceToken, 'network_device_pairing_join', {
          request_id: newRequestId('reconnect_join'),
          challenge: pairing.challenge,
          device_id: deviceId,
          device_label: 'Q05 重连设备',
          platform: 'iOS',
        });
        await q05Tool(server, fixture.u1.token, 'network_device_pairing_approve', {
          request_id: newRequestId('reconnect_approve'),
          pairing_id: pairing.pairing_id,
        });
        const redeemed = await q05Tool<{ token?: string }>(
          server,
          deviceToken,
          'network_device_pairing_redeem',
          {
            request_id: newRequestId('reconnect_redeem'),
            challenge: pairing.challenge,
            device_id: deviceId,
          },
        );
        const revokedToken = redeemed.token ?? deviceToken;
        const activeStream = await openQ05Stream(server, revokedToken, ['agentnet://stream']);
        await q05Tool(server, fixture.u1.token, 'network_device_revoke', {
          request_id: newRequestId('reconnect_revoke'),
          device_id: deviceId,
        });
        await Promise.race([
          activeStream.closed,
          waitForCondition('等待撤销流关闭', () => false, 3_000).catch(() => undefined),
        ]);
        q05Check('撤销凭据的活跃流已关闭', activeStream.isClosed());
        const readAfterRevoke = await q05ToolOutcome(server, revokedToken, 'network_room_get', {
          room_id: fixture.directU1U2,
        });
        q05Equal('撤销凭据不能读取', readAfterRevoke.ok, false);
        q05Equal('撤销凭据读取错误码', readAfterRevoke.code, 'CREDENTIAL_INVALID');
        const writeAfterRevoke = await q05ToolOutcome(server, revokedToken, 'network_message_send', {
          request_id: newRequestId('reconnect_write'),
          client_message_id: `cm_reconnect_${crypto.randomUUID()}`,
          room_id: fixture.directU1U2,
          body: 'Q05 撤销凭据写入（必须失败）',
          invoke: [],
        });
        q05Equal('撤销凭据不能写入', writeAfterRevoke.ok, false);
        const primary = await q05ToolOutcome(server, fixture.u1.token, 'network_me', {});
        q05Equal('主设备不受撤销影响', primary.ok, true);
        await activeStream.close();
      },
    },
  ];
}
