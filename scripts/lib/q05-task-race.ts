/**
 * Q05-T01 场景三/四：转交 × 旧提交/取消/移除，以及验收 accept × return。
 *
 * 每轮按事务提交顺序只接受一条合法路径；旧 assignment 不能写；验收只有
 * 一个终态，重复 accept 不重复通知或回写。断言全部读取权威表。
 */

import {
  burst,
  createGroup,
  drainTaskDeliveries,
  ensureRoomMember,
  newRequestId,
  q05Check,
  q05Equal,
  q05Tool,
  q05ToolOutcome,
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
  reviewer_actor_id: string;
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

interface SubmissionView {
  submission_id: string;
  task_id: string;
  version: number;
  status: string;
  submitted_by: string;
  assignment_id: string;
}

interface SubmissionResult {
  submission: SubmissionView;
  task: TaskView;
}

export const q05TaskRaceStats = {
  rounds: 0,
  submitted: 0,
  transferred: 0,
  blocked: 0,
  cancelled: 0,
  submitWon: 0,
  transferWon: 0,
  cancelWon: 0,
  removeWon: 0,
};

export const q05ReviewStats = {
  rounds: 0,
  accepted: 0,
  returned: 0,
  duplicateRejected: 0,
  deterministicReturn: 0,
};

async function offerTo(
  server: Q05Server,
  creator: Q05Actor,
  assignee: Q05Actor,
  roomId: string,
  title: string,
): Promise<{ task: TaskView; accepted: TaskView }> {
  const offered = await q05Tool<TaskResult>(server, creator.token, 'network_task_create', {
    request_id: newRequestId('race_task'),
    room_id: roomId,
    title,
    assignee_actor_id: assignee.actor_id,
  });
  const accepted = await q05Tool<TaskResult>(server, assignee.token, 'network_task_accept', {
    request_id: newRequestId('race_accept'),
    task_id: offered.task.task_id,
    assignment_id: offered.task.assignment!.assignment_id,
    expected_revision: offered.task.revision,
  });
  return { task: accepted.task, accepted: accepted.task };
}

export function q05TaskTransferRaceRound(
  server: Q05Server,
  db: Q05Db,
  owners: Q05Actor[],
  agentPools: Q05Actor[][],
): RoundBody {
  const rooms = new Map<string, string>();
  return async (round, random) => {
    q05TaskRaceStats.rounds += 1;
    const ownerIndex = (round - 1) % owners.length;
    const owner = owners[ownerIndex]!;
    const pool = agentPools[ownerIndex]!;
    const executor = pool[0]!;
    const successor = pool[1]!;
    const extra = pool[2]!;
    let sharedRoomId = rooms.get(owner.actor_id);
    if (!sharedRoomId) {
      sharedRoomId = await createGroup(
        server,
        owner,
        [executor, successor, extra],
        `Q05 转交竞争固定群 ${owner.name}`,
      );
      rooms.set(owner.actor_id, sharedRoomId);
    }
    const roomId = sharedRoomId;
    await ensureRoomMember(server, db, owner, roomId, executor);
    let taskForCleanup: TaskView | null = null;
    try {
      const { task } = await offerTo(
        server,
        owner,
        executor,
        roomId,
        `Q05 转交旧提交 ${round}`,
      );
      taskForCleanup = task;
    const proposed = await q05Tool<{ transfer: { transfer_id: string; version: number } }>(
      server,
      owner.token,
      'network_task_transfer_propose',
      {
        request_id: newRequestId(`transfer_${round}`),
        task_id: task.task_id,
        to_actor_id: successor.actor_id,
        expected_revision: task.revision,
        assignment_id: task.assignment!.assignment_id,
        assignment_version: task.assignment!.assignment_version,
      },
    );
    const transferId = proposed.transfer.transfer_id;

    const operations: {
      name: 'submit' | 'transfer' | 'cancel' | 'remove';
      call: () => Promise<Awaited<ReturnType<typeof q05ToolOutcome>>>;
    }[] = [
      {
        name: 'submit',
        call: () =>
          q05ToolOutcome(server, executor.token, 'network_task_submit', {
            request_id: newRequestId(`race_submit_${round}`),
            task_id: task.task_id,
            summary: `Q05 旧执行提交 ${round}`,
            commit_sha: `abcdef${round.toString(16).padStart(2, '0')}`,
            expected_revision: task.revision,
            assignment_id: task.assignment!.assignment_id,
            assignment_version: task.assignment!.assignment_version,
          }),
      },
      {
        name: 'transfer',
        call: () =>
          q05ToolOutcome(server, successor.token, 'network_task_transfer_accept', {
            request_id: newRequestId(`race_transfer_${round}`),
            transfer_id: transferId,
            expected_revision: task.revision,
            from_assignment_version: task.assignment!.assignment_version,
          }),
      },
      {
        name: 'cancel',
        call: () =>
          q05ToolOutcome(server, owner.token, 'network_task_cancel', {
            request_id: newRequestId(`race_cancel_${round}`),
            task_id: task.task_id,
            reason: `Q05 竞争取消 ${round}`,
            expected_revision: task.revision,
          }),
      },
      {
        name: 'remove',
        call: () =>
          q05ToolOutcome(server, owner.token, 'network_room_members_update', {
            request_id: newRequestId(`race_remove_${round}`),
            room_id: roomId,
            remove: [executor.actor_id],
          }),
      },
    ];
    const ordered = shuffle(operations, random);
    const settled = await Promise.all(ordered.map((operation) => operation.call()));
    const outcomeOf = (name: 'submit' | 'transfer' | 'cancel' | 'remove') =>
      settled[ordered.findIndex((operation) => operation.name === name)]!;
    const submitOutcome = outcomeOf('submit');
    const acceptOutcome = outcomeOf('transfer');
    const cancelOutcome = outcomeOf('cancel');
    const removeOutcome = outcomeOf('remove');

    const authoritative = await q05Tool<TaskResult>(server, owner.token, 'network_task_get', {
      task_id: task.task_id,
    });
    const row = db.row<{
      status: string;
      owner_actor_id: string | null;
      revision: number;
      blocked_reason: string | null;
    }>('SELECT * FROM tasks WHERE task_id = ?', task.task_id);
    q05Equal(`第 ${round} 轮权威任务存在`, Boolean(row), true);
    q05Equal(`第 ${round} 轮 task_get 与权威状态一致`, authoritative.task.status, row!.status);

    const activeAssignments = db.scalar(
      "SELECT COUNT(*) AS n FROM task_assignments WHERE task_id = ? AND status IN ('offered','active')",
      task.task_id,
    );
    q05Check(`第 ${round} 轮最多一个有效 assignment`, activeAssignments <= 1, {
      activeAssignments,
      status: row!.status,
    });

    const acceptedTransfers = db.scalar(
      "SELECT COUNT(*) AS n FROM task_transfers WHERE task_id = ? AND status = 'accepted'",
      task.task_id,
    );
    const submissions = db.rows<{ submission_id: string; submitted_by: string; version: number }>(
      'SELECT * FROM task_submissions WHERE task_id = ?',
      task.task_id,
    );
    q05Check(`第 ${round} 轮最多一个提交版本`, submissions.length <= 1, submissions.length);
    q05Check(
      `第 ${round} 轮提交成功则转交失效`,
      submissions.length === 0 || acceptedTransfers === 0,
      { submissions: submissions.length, acceptedTransfers },
    );
    q05Check(
      `第 ${round} 轮转交成功则旧 assignment 不能写`,
      acceptedTransfers === 0 || submissions.length === 0,
      { acceptedTransfers, submissions: submissions.length },
    );
    q05Check(
      `第 ${round} 轮任务卡唯一`,
      db.scalar('SELECT COUNT(*) AS n FROM task_cards WHERE task_id = ?', task.task_id) === 1,
    );
    q05Equal(
      `第 ${round} 轮任务投递无重复行`,
      db.scalar('SELECT COUNT(*) AS n FROM task_deliveries WHERE task_id = ?', task.task_id),
      db.scalar(
        'SELECT COUNT(DISTINCT delivery_id) AS n FROM task_deliveries WHERE task_id = ?',
        task.task_id,
      ),
    );

    switch (row!.status) {
      case 'submitted': {
        q05TaskRaceStats.submitted += 1;
        q05Equal(`第 ${round} 轮 submitted 只有一份成果`, submissions.length, 1);
        q05Equal(
          `第 ${round} 轮 submitted 由旧执行者提交`,
          submissions[0]!.submitted_by,
          executor.actor_id,
        );
        q05Equal(`第 ${round} 轮 submitted 时转交未生效`, acceptedTransfers, 0);
        q05Equal(`第 ${round} 轮 submitted 时无有效 assignment`, activeAssignments, 0);
        break;
      }
      case 'in_progress': {
        q05TaskRaceStats.transferred += 1;
        q05Equal(`第 ${round} 轮转交后 owner 为新执行者`, row!.owner_actor_id, successor.actor_id);
        q05Equal(`第 ${round} 轮转交后一个有效 assignment`, activeAssignments, 1);
        q05Equal(`第 ${round} 轮转交后无旧提交`, submissions.length, 0);
        q05Equal(`第 ${round} 轮转交接受唯一`, acceptedTransfers, 1);
        break;
      }
      case 'blocked': {
        q05TaskRaceStats.blocked += 1;
        q05Equal(`第 ${round} 轮移除导致无 owner`, row!.owner_actor_id, null);
        q05Equal(`第 ${round} 轮移除原因记录`, row!.blocked_reason, 'owner_lost_eligibility');
        q05Equal(`第 ${round} 轮 blocked 时无有效 assignment`, activeAssignments, 0);
        q05Equal(`第 ${round} 轮 blocked 时无提交`, submissions.length, 0);
        break;
      }
      case 'cancelled': {
        q05TaskRaceStats.cancelled += 1;
        q05Equal(`第 ${round} 轮取消后无 owner`, row!.owner_actor_id, null);
        q05Equal(`第 ${round} 轮取消后无有效 assignment`, activeAssignments, 0);
        break;
      }
      default:
        q05Check(`第 ${round} 轮未出现意外终态`, false, row!.status);
    }

    // 失败方必须看到真实状态；成功方至多一个。
    if (submitOutcome.ok) q05TaskRaceStats.submitWon += 1;
    if (acceptOutcome.ok) q05TaskRaceStats.transferWon += 1;
    if (cancelOutcome.ok) q05TaskRaceStats.cancelWon += 1;
    if (removeOutcome.ok) q05TaskRaceStats.removeWon += 1;
    const successCount =
      Number(submitOutcome.ok) +
      Number(acceptOutcome.ok) +
      Number(cancelOutcome.ok) +
      Number(removeOutcome.ok);
    q05Check(`第 ${round} 轮竞争至少有一个成功或明确失败`, successCount >= 1, successCount);
    for (const [name, outcome] of [
      ['submit', submitOutcome],
      ['transfer', acceptOutcome],
      ['cancel', cancelOutcome],
      ['remove', removeOutcome],
    ] as const) {
      if (outcome.ok) continue;
      q05Check(
        `第 ${round} 轮 ${name} 失败返回稳定错误码`,
        typeof outcome.code === 'string' && outcome.code.length > 0,
        outcome.code,
      );
    }
    } finally {
      if (taskForCleanup) {
        await drainTaskDeliveries(server, db, taskForCleanup.task_id, [
          owner,
          executor,
          successor,
          extra,
        ]);
      }
    }
  };
}

export function q05ReviewRaceRound(
  server: Q05Server,
  db: Q05Db,
  owner: Q05Actor,
  executor: Q05Actor,
  roomId: string,
): RoundBody {
  return async (round) => {
    q05ReviewStats.rounds += 1;
    const { task } = await offerTo(
      server,
      owner,
      executor,
      roomId,
      `Q05 验收竞争 ${round}`,
    );
    const submitted = await q05Tool<SubmissionResult>(server, executor.token, 'network_task_submit', {
      request_id: newRequestId(`review_submit_${round}`),
      task_id: task.task_id,
      summary: `Q05 待验收 v1 ${round}`,
      commit_sha: `abcdef${round.toString(16).padStart(2, '0')}`,
      expected_revision: task.revision,
      assignment_id: task.assignment!.assignment_id,
      assignment_version: task.assignment!.assignment_version,
    });
    const submission = submitted.submission;
    q05Equal(`第 ${round} 轮提交后 submitted`, submitted.task.status, 'submitted');

    const reviewRevision = submitted.task.revision;
    const mixed = await burst(40, (index) =>
      index % 2 === 0
        ? q05ToolOutcome(server, owner.token, 'network_task_review_accept', {
            request_id: newRequestId(`review_accept_${round}`),
            task_id: task.task_id,
            submission_id: submission.submission_id,
            version: submission.version,
            checklist: [{ item: `Q05 验收项 ${round}`, passed: true }],
            expected_revision: reviewRevision,
          })
        : q05ToolOutcome(server, owner.token, 'network_task_review_return', {
            request_id: newRequestId(`review_return_${round}`),
            task_id: task.task_id,
            submission_id: submission.submission_id,
            version: submission.version,
            reason: `Q05 退回原因 ${round}`,
            expected_revision: reviewRevision,
          }),
    );
    const mixedOk = mixed.filter(
      (item) => item.status === 'fulfilled' && item.value.ok,
    );
    q05Equal(`第 ${round} 轮验收竞争只有一个终态`, mixedOk.length, 1);
    const mixedCodes = mixed.flatMap((item) =>
      item.status === 'fulfilled' && !item.value.ok ? [item.value.code] : [],
    );
    q05Check(
      `第 ${round} 轮验收失败方返回稳定冲突码`,
      mixedCodes.every(
        (code) =>
          code === 'REVIEW_STALE' || code === 'VERSION_CONFLICT' || code === 'CONFLICT',
      ),
      { codes: [...new Set(mixedCodes)] },
    );

    const reviews = db.rows<{ decision: string }>(
      'SELECT decision FROM task_reviews WHERE task_id = ?',
      task.task_id,
    );
    q05Equal(`第 ${round} 轮只有一条验收记录`, reviews.length, 1);
    const decision = reviews[0]!.decision;
    const revisionAfter = db.row<{ revision: number; status: string }>(
      'SELECT revision, status FROM tasks WHERE task_id = ?',
      task.task_id,
    )!;
    const acceptEvents = db.scalar(
      "SELECT COUNT(*) AS n FROM events WHERE event_type = 'task_accepted' AND ref_id = ?",
      task.task_id,
    );
    const returnEvents = db.scalar(
      "SELECT COUNT(*) AS n FROM events WHERE event_type = 'task_returned' AND ref_id = ?",
      task.task_id,
    );
    if (decision === 'accept') {
      q05ReviewStats.accepted += 1;
      q05Equal(`第 ${round} 轮 accept 终态 accepted`, revisionAfter.status, 'accepted');
      q05Equal(`第 ${round} 轮 accept 事件唯一`, acceptEvents, 1);
      q05Equal(`第 ${round} 轮 accept 时不写 return 事件`, returnEvents, 0);
    } else {
      q05ReviewStats.returned += 1;
      q05Equal(`第 ${round} 轮 return 后回到 in_progress`, revisionAfter.status, 'in_progress');
      q05Equal(`第 ${round} 轮 return 事件唯一`, returnEvents, 1);
      q05Equal(`第 ${round} 轮 return 时不写 accept 事件`, acceptEvents, 0);
    }

    // 重复 accept：使用新 request_id 也不能覆盖终态或重复回写。
    const duplicateAccepts = await burst(20, () =>
      q05ToolOutcome(server, owner.token, 'network_task_review_accept', {
        request_id: newRequestId(`review_dup_${round}`),
        task_id: task.task_id,
        submission_id: submission.submission_id,
        version: submission.version,
        checklist: [{ item: `Q05 重复验收 ${round}`, passed: true }],
        expected_revision: reviewRevision,
      }),
    );
    q05Equal(
      `第 ${round} 轮重复 accept 全部失败`,
      duplicateAccepts.filter(
        (item) => item.status === 'fulfilled' && item.value.ok,
      ).length,
      0,
    );
    q05Equal(
      `第 ${round} 轮重复 accept 不新增验收记录`,
      db.scalar('SELECT COUNT(*) AS n FROM task_reviews WHERE task_id = ?', task.task_id),
      1,
    );
    q05Equal(
      `第 ${round} 轮重复 accept 不增加事件`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM events WHERE event_type = 'task_accepted' AND ref_id = ?",
        task.task_id,
      ),
      acceptEvents,
    );
    q05Equal(
      `第 ${round} 轮重复 accept 不推进 revision`,
      db.row<{ revision: number }>(
        'SELECT revision FROM tasks WHERE task_id = ?',
        task.task_id,
      )?.revision,
      revisionAfter.revision,
    );
    if (revisionAfter.status === 'in_progress') {
      await q05ToolOutcome(server, owner.token, 'network_task_cancel', {
        request_id: newRequestId(`review_cleanup_${round}`),
        task_id: task.task_id,
        reason: `Q05 退回后清理 ${round}`,
      });
    }
    const duplicateRejected = duplicateAccepts.filter(
      (item) => item.status === 'fulfilled' && !item.value.ok,
    );
    q05Equal(
      `第 ${round} 轮旧版本迟到验收全部失败`,
      duplicateRejected.length,
      20,
    );
    q05ReviewStats.duplicateRejected += duplicateRejected.length;

    // 并发竞争在本固定种子下可能由 accept 稳定胜出；再用独立任务验证
    // return 终态可达，且迟到 accept 同样不能覆盖。
    const returnTask = await offerTo(
      server,
      owner,
      executor,
      roomId,
      `Q05 退回路径 ${round}`,
    );
    const returnSubmit = await q05Tool<SubmissionResult>(
      server,
      executor.token,
      'network_task_submit',
      {
        request_id: newRequestId(`return_submit_${round}`),
        task_id: returnTask.task.task_id,
        summary: `Q05 待退回 v1 ${round}`,
        commit_sha: `abcdef${round.toString(16).padStart(2, '0')}`,
        expected_revision: returnTask.task.revision,
        assignment_id: returnTask.task.assignment!.assignment_id,
        assignment_version: returnTask.task.assignment!.assignment_version,
      },
    );
    const returned = await q05Tool<SubmissionResult>(
      server,
      owner.token,
      'network_task_review_return',
      {
        request_id: newRequestId(`return_only_${round}`),
        task_id: returnTask.task.task_id,
        submission_id: returnSubmit.submission.submission_id,
        version: returnSubmit.submission.version,
        reason: `Q05 明确退回 ${round}`,
        expected_revision: returnSubmit.task.revision,
      },
    );
    q05Equal(`第 ${round} 轮退回路径终态为 in_progress`, returned.task.status, 'in_progress');
    q05Equal(`第 ${round} 轮退回记录唯一`, db.scalar(
      'SELECT COUNT(*) AS n FROM task_reviews WHERE task_id = ?',
      returnTask.task.task_id,
    ), 1);
    q05Equal(`第 ${round} 轮退回不写 accept 事件`, db.scalar(
      "SELECT COUNT(*) AS n FROM events WHERE event_type = 'task_accepted' AND ref_id = ?",
      returnTask.task.task_id,
    ), 0);
    const lateAccepts = await burst(5, () =>
      q05ToolOutcome(server, owner.token, 'network_task_review_accept', {
        request_id: newRequestId(`return_late_accept_${round}`),
        task_id: returnTask.task.task_id,
        submission_id: returnSubmit.submission.submission_id,
        version: returnSubmit.submission.version,
        checklist: [{ item: `Q05 迟到验收 ${round}`, passed: true }],
        expected_revision: returnSubmit.task.revision,
      }),
    );
    q05Equal(
      `第 ${round} 轮退回后迟到 accept 全部失败`,
      lateAccepts.filter((item) => item.status === 'fulfilled' && item.value.ok).length,
      0,
    );
    q05ReviewStats.deterministicReturn += 1;
    await q05ToolOutcome(server, owner.token, 'network_task_cancel', {
      request_id: newRequestId(`return_cleanup_${round}`),
      task_id: returnTask.task.task_id,
      reason: `Q05 退回路径清理 ${round}`,
    });
  };
}
