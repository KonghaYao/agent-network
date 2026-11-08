/**
 * Q05-T01 场景六：联系人申请/接受/拉黑并发。
 *
 * 100 轮使用新的合成 actor 对；接受与拉黑同时提交，最终只能是拉黑生效、
 * 关系结束、请求不悬挂，且不产生重复关系/邀请。解除拉黑不自动恢复好友。
 */

import {
  newRequestId,
  q05Check,
  q05Equal,
  q05Tool,
  q05ToolOutcome,
  registerHuman,
  type Q05Actor,
  type Q05Db,
  type Q05Server,
  type RoundBody,
} from './q05-harness';

interface ContactPage {
  items: {
    actor_id: string;
    relation: string;
  }[];
}

export const q05ContactStats = {
  rounds: 0,
  acceptCommittedBeforeBlock: 0,
  blockPreventedAccept: 0,
  blockFirstRejected: 0,
};

export function q05ContactRound(
  server: Q05Server,
  db: Q05Db,
): RoundBody {
  return async (round) => {
    q05ContactStats.rounds += 1;
    // 确定性的“拉黑先到”路径：接受必须被明确拒绝，且不建立好友关系。
    const [blockFirstLeft, blockFirstRight] = await Promise.all([
      registerHuman(server, `Q05 拉黑优先 A ${round}`),
      registerHuman(server, `Q05 拉黑优先 B ${round}`),
    ]);
    const blockFirstRequest = await q05Tool<{
      status: string;
      request: { contact_request_id: string };
    }>(server, blockFirstLeft.token, 'network_contact_request', {
      request_id: newRequestId(`block_first_req_${round}`),
      actor_id: blockFirstRight.actor_id,
    });
    await q05Tool(server, blockFirstLeft.token, 'network_contact_block', {
      request_id: newRequestId(`block_first_block_${round}`),
      actor_id: blockFirstRight.actor_id,
      reason: `Q05 拉黑优先 ${round}`,
    });
    const blockedAccept = await q05ToolOutcome(
      server,
      blockFirstRight.token,
      'network_contact_request_respond',
      {
        request_id: newRequestId(`block_first_accept_${round}`),
        contact_request_id: blockFirstRequest.request.contact_request_id,
        action: 'accept',
      },
    );
    q05Equal(`第 ${round} 轮拉黑优先拒绝接受`, blockedAccept.ok, false);
    q05Equal(`第 ${round} 轮拉黑优先错误码`, blockedAccept.code, 'BLOCKED');
    q05Equal(
      `第 ${round} 轮拉黑优先不建立关系`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM contact_relations WHERE pair_key = ? AND status = 'active'",
        [blockFirstLeft.actor_id, blockFirstRight.actor_id].sort().join('|'),
      ),
      0,
    );
    q05ContactStats.blockFirstRejected += 1;

    const [left, right] = await Promise.all([
      registerHuman(server, `Q05 联系人 A ${round}`),
      registerHuman(server, `Q05 联系人 B ${round}`),
    ]);
    const requested = await q05Tool<{
      status: string;
      request: { contact_request_id: string };
    }>(server, left.token, 'network_contact_request', {
      request_id: newRequestId(`contact_req_${round}`),
      actor_id: right.actor_id,
    });
    q05Equal(`第 ${round} 轮申请进入 pending`, requested.status, 'pending');

    const [acceptOutcome, blockOutcome, duplicateAccept, duplicateBlock] = await Promise.all([
      q05ToolOutcome(server, right.token, 'network_contact_request_respond', {
        request_id: newRequestId(`contact_accept_${round}`),
        contact_request_id: requested.request.contact_request_id,
        action: 'accept',
      }),
      q05ToolOutcome(server, left.token, 'network_contact_block', {
        request_id: newRequestId(`contact_block_${round}`),
        actor_id: right.actor_id,
        reason: `Q05 并发拉黑 ${round}`,
      }),
      q05ToolOutcome(server, right.token, 'network_contact_request_respond', {
        request_id: newRequestId(`contact_accept2_${round}`),
        contact_request_id: requested.request.contact_request_id,
        action: 'accept',
      }),
      q05ToolOutcome(server, left.token, 'network_contact_block', {
        request_id: newRequestId(`contact_block2_${round}`),
        actor_id: right.actor_id,
      }),
    ]);
    q05Equal(`第 ${round} 轮拉黑成功`, blockOutcome.ok, true);
    q05Equal(`第 ${round} 轮重复拉黑幂等`, duplicateBlock.ok, true);
    if (!acceptOutcome.ok) {
      q05ContactStats.blockPreventedAccept += 1;
      q05Check(
        `第 ${round} 轮拉黑后接受被明确拒绝`,
        acceptOutcome.code === 'BLOCKED' || acceptOutcome.code === 'CONFLICT',
        acceptOutcome.code,
      );
    } else {
      q05ContactStats.acceptCommittedBeforeBlock += 1;
    }

    const pairKey = [left.actor_id, right.actor_id].sort().join('|');
    const relations = db.rows<{ status: string }>(
      'SELECT status FROM contact_relations WHERE pair_key = ?',
      pairKey,
    );
    const activeRelations = relations.filter((row) => row.status === 'active');
    q05Equal(`第 ${round} 轮无 active 好友关系`, activeRelations.length, 0);
    q05Equal(`第 ${round} 轮关系行唯一`, relations.length, 1);
    q05Equal(
      `第 ${round} 轮只有一条 A→B 拉黑`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM contact_blocks WHERE blocker_actor_id = ? AND blocked_actor_id = ? AND released_at IS NULL",
        left.actor_id,
        right.actor_id,
      ),
      1,
    );
    q05Equal(
      `第 ${round} 轮不产生反向拉黑`,
      db.scalar(
        'SELECT COUNT(*) AS n FROM contact_blocks WHERE blocker_actor_id = ? AND blocked_actor_id = ?',
        right.actor_id,
        left.actor_id,
      ),
      0,
    );
    q05Equal(
      `第 ${round} 轮申请不悬挂`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM contact_requests WHERE pair_key = ? AND status = 'pending'",
        pairKey,
      ),
      0,
    );
    q05Equal(
      `第 ${round} 轮申请行唯一`,
      db.scalar('SELECT COUNT(*) AS n FROM contact_requests WHERE pair_key = ?', pairKey),
      1,
    );

    const leftView = await q05Tool<ContactPage>(server, left.token, 'network_contacts_list', {
      limit: 100,
    });
    const rightView = await q05Tool<ContactPage>(server, right.token, 'network_contacts_list', {
      limit: 100,
    });
    q05Check(
      `第 ${round} 轮 A 侧不可见 active 关系`,
      leftView.items.every(
        (item) => item.actor_id !== right.actor_id || item.relation !== 'active',
      ),
    );
    q05Check(
      `第 ${round} 轮 B 侧不可见 active 关系`,
      rightView.items.every(
        (item) => item.actor_id !== left.actor_id || item.relation !== 'active',
      ),
    );

    const unblocked = await q05ToolOutcome(server, left.token, 'network_contact_unblock', {
      request_id: newRequestId(`contact_unblock_${round}`),
      actor_id: right.actor_id,
    });
    q05Equal(`第 ${round} 轮解除拉黑成功`, unblocked.ok, true);
    q05Equal(
      `第 ${round} 轮解除拉黑不自动恢复好友`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM contact_relations WHERE pair_key = ? AND status = 'active'",
        pairKey,
      ),
      0,
    );
    q05Equal(
      `第 ${round} 轮解除后无有效拉黑`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM contact_blocks WHERE blocker_actor_id = ? AND blocked_actor_id = ? AND released_at IS NULL",
        left.actor_id,
        right.actor_id,
      ),
      0,
    );
    q05Check(`第 ${round} 轮重复接受未产生第二关系`, relations.length === 1);
    void duplicateAccept;
  };
}
