/**
 * Q05-T01 场景二：公开领取 100 并发与指定 offer 100 并发接受。
 *
 * 领取/接受都只允许一个 active assignment；失败方必须看到真实 owner 与
 * CLAIM_CONFLICT/ASSIGNMENT_STALE；任务卡与投递不得重复。
 */

import {
  burst,
  drainDelivery,
  fulfilled,
  newRequestId,
  q05Check,
  q05Equal,
  q05Tool,
  Q05ToolError,
  rejectedCodes,
  sendMessage,
  shuffle,
  type Q05Actor,
  type Q05Db,
  type Q05Server,
  type RoundBody,
} from './q05-harness';

interface TaskView {
  task_id: string;
  status: string;
  revision: number;
  owner_actor_id: string | null;
  card_message_id: string | null;
  delivery_ids: string[];
  assignment: {
    assignment_id: string;
    assignment_version: number;
    owner_actor_id: string;
    status: string;
  } | null;
}

interface TaskResult {
  task: TaskView;
}

export const q05ClaimStats = {
  claimRounds: 0,
  offerRounds: 0,
  claimWinners: 0,
  acceptWinners: 0,
};

export function q05ClaimRound(
  server: Q05Server,
  db: Q05Db,
  creator: Q05Actor,
  candidates: Q05Actor[],
  roomId: string,
): RoundBody {
  return async (round, random) => {
    q05ClaimStats.claimRounds += 1;
    const source = await sendMessage(server, creator, roomId, `Q05 领取来源 ${round}`, {
      requestId: newRequestId(`claim_src_${round}`),
      clientMessageId: `cm_claim_src_${round}_${crypto.randomUUID()}`,
      invoke: [],
    });
    const created = await q05Tool<TaskResult>(server, creator.token, 'network_task_create', {
      request_id: newRequestId(`claim_task_${round}`),
      room_id: roomId,
      title: `Q05 公开领取 ${round}`,
      source_message_id: source.message.message_id,
    });
    q05Equal(`第 ${round} 轮领取任务初始 unassigned`, created.task.status, 'unassigned');
    q05Equal(`第 ${round} 轮来源消息只生成一张任务卡`, db.scalar(
      'SELECT COUNT(*) AS n FROM task_cards WHERE task_id = ?',
      created.task.task_id,
    ), 1);
    q05Equal(`第 ${round} 轮公开任务初始无投递`, db.scalar(
      'SELECT COUNT(*) AS n FROM task_deliveries WHERE task_id = ?',
      created.task.task_id,
    ), 0);

    const ordered = shuffle(candidates, random);
    const claims = await burst(100, (index) =>
      q05Tool<TaskResult>(server, ordered[index % ordered.length]!.token, 'network_task_claim', {
        request_id: newRequestId(`claim_${round}`),
        task_id: created.task.task_id,
      }),
    );
    const winners = fulfilled(claims) as TaskResult[];
    q05Equal(`第 ${round} 轮只有一个领取成功`, winners.length, 1);
    q05ClaimStats.claimWinners += winners.length;
    const winner = winners[0]!.task;
    q05Equal(`第 ${round} 轮领取后 in_progress`, winner.status, 'in_progress');
    q05Check(`第 ${round} 轮领取后有 owner`, typeof winner.owner_actor_id === 'string');

    const codes = rejectedCodes(claims);
    q05Equal(`第 ${round} 轮失败方全部 CLAIM_CONFLICT`, codes.every((code) => code === 'CLAIM_CONFLICT'), true);
    const sawActualOwner = claims.some(
      (item) =>
        item.status === 'rejected' &&
        item.reason instanceof Error &&
        (item.reason as unknown as { details?: Record<string, unknown> }).details?.owner_actor_id ===
          winner.owner_actor_id,
    );
    q05Check(`第 ${round} 轮失败方能读到真实 owner`, sawActualOwner);

    const active = db.scalar(
      "SELECT COUNT(*) AS n FROM task_assignments WHERE task_id = ? AND status IN ('offered','active')",
      created.task.task_id,
    );
    q05Equal(`第 ${round} 轮只有一个 active assignment`, active, 1);
    const assignment = db.row<{ assignment_id: string; owner_actor_id: string; status: string }>(
      'SELECT * FROM task_assignments WHERE task_id = ?',
      created.task.task_id,
    );
    q05Equal(`第 ${round} 轮 assignment owner 与任务 owner 一致`, assignment?.owner_actor_id, winner.owner_actor_id);
    q05Equal(`第 ${round} 轮 assignment 状态 active`, assignment?.status, 'active');
    q05Equal(
      `第 ${round} 轮公开领取不产生任务投递`,
      db.scalar('SELECT COUNT(*) AS n FROM task_deliveries WHERE task_id = ?', created.task.task_id),
      0,
    );
    q05Equal(
      `第 ${round} 轮任务卡唯一`,
      db.scalar('SELECT COUNT(*) AS n FROM task_cards WHERE task_id = ?', created.task.task_id),
      1,
    );
    const final = await q05Tool<TaskResult>(server, creator.token, 'network_task_get', {
      task_id: created.task.task_id,
    });
    q05Equal(`第 ${round} 轮权威 owner 与响应一致`, final.task.owner_actor_id, winner.owner_actor_id);
  };
}

export function q05OfferAcceptRound(
  server: Q05Server,
  db: Q05Db,
  creator: Q05Actor,
  candidate: Q05Actor,
  roomId: string,
): RoundBody {
  return async (round) => {
    q05ClaimStats.offerRounds += 1;
    const offered = await q05Tool<TaskResult>(server, creator.token, 'network_task_create', {
      request_id: newRequestId(`accept_task_${round}`),
      room_id: roomId,
      title: `Q05 指定接受 ${round}`,
      assignee_actor_id: candidate.actor_id,
    });
    q05Equal(`第 ${round} 轮 offer 初始 offered`, offered.task.status, 'offered');
    q05Check(`第 ${round} 轮 offer 生成 assignment`, Boolean(offered.task.assignment));
    q05Equal(`第 ${round} 轮 offer 只生成一条投递`, offered.task.delivery_ids.length, 1);
    q05Equal(`第 ${round} 轮 offer 只生成一张任务卡`, db.scalar(
      'SELECT COUNT(*) AS n FROM task_cards WHERE task_id = ?',
      offered.task.task_id,
    ), 1);
    q05Equal(`第 ${round} 轮 offer 投递表唯一`, db.scalar(
      'SELECT COUNT(*) AS n FROM task_deliveries WHERE task_id = ?',
      offered.task.task_id,
    ), 1);

    const accepts = await burst(100, () =>
      q05Tool<TaskResult>(server, candidate.token, 'network_task_accept', {
        request_id: newRequestId(`accept_${round}`),
        task_id: offered.task.task_id,
        assignment_id: offered.task.assignment!.assignment_id,
        expected_revision: offered.task.revision,
      }),
    );
    const winners = fulfilled(accepts) as TaskResult[];
    q05Equal(`第 ${round} 轮只有一个接受成功`, winners.length, 1);
    q05ClaimStats.acceptWinners += winners.length;
    q05Equal(`第 ${round} 轮接受后 in_progress`, winners[0]!.task.status, 'in_progress');
    q05Equal(
      `第 ${round} 轮失败方返回 ASSIGNMENT_STALE`,
      rejectedCodes(accepts).every((code) => code === 'ASSIGNMENT_STALE'),
      true,
    );
    const sawAcceptOwner = accepts.some(
      (item) =>
        item.status === 'rejected' &&
        item.reason instanceof Q05ToolError &&
        item.reason.details.owner_actor_id === candidate.actor_id,
    );
    q05Check(`第 ${round} 轮接受失败方读到真实 owner`, sawAcceptOwner);
    q05Equal(
      `第 ${round} 轮只有一个 active assignment`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM task_assignments WHERE task_id = ? AND status IN ('offered','active')",
        offered.task.task_id,
      ),
      1,
    );
    q05Equal(
      `第 ${round} 轮 owner 唯一`,
      db.scalar(
        "SELECT COUNT(DISTINCT owner_actor_id) AS n FROM task_assignments WHERE task_id = ?",
        offered.task.task_id,
      ),
      1,
    );
    q05Equal(
      `第 ${round} 轮任务仍是同一条投递`,
      db.scalar('SELECT COUNT(*) AS n FROM task_deliveries WHERE task_id = ?', offered.task.task_id),
      1,
    );
    q05Equal(
      `第 ${round} 轮任务卡仍唯一`,
      db.scalar('SELECT COUNT(*) AS n FROM task_cards WHERE task_id = ?', offered.task.task_id),
      1,
    );
    const after = await q05Tool<TaskResult>(server, creator.token, 'network_task_get', {
      task_id: offered.task.task_id,
    });
    q05Equal(`第 ${round} 轮接受后 owner`, after.task.owner_actor_id, candidate.actor_id);
    const delivery = db.row<{ delivery_id: string }>(
      'SELECT delivery_id FROM task_deliveries WHERE task_id = ?',
      offered.task.task_id,
    );
    if (delivery) await drainDelivery(server, candidate, delivery.delivery_id);
  };
}
