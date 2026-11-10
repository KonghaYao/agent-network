/**
 * Q05-T01 场景八：Agent 管理权交接 × 旧管理者重发 token。
 *
 * 100 轮，每轮创建独立 Agent 与在途任务；接任者接受交接的同时旧管理者
 * 并发重发 100 次 token。最终只能有一个管理者、一个有效运行凭据，旧 token
 * 全部失效，不重复轮换。
 */

import {
  burst,
  createGroup,
  createManagedAgent,
  newRequestId,
  q05Check,
  q05Equal,
  q05Tool,
  q05ToolOutcome,
  type Q05Actor,
  type Q05Db,
  type Q05Server,
  type RoundBody,
} from './q05-harness';

interface AgentManagementView {
  management: {
    manager_id: string;
    permission_version: number;
    status: string;
  } | null;
}

interface ReissueResult {
  actor_id: string;
  token: string;
}

interface TransferAcceptResult {
  status: string;
  token: string | null;
  agent_id: string;
}

export const q05AgentTransferStats = {
  rounds: 0,
  reissueSuccesses: 0,
  acceptSuccesses: 0,
  preReissueRevoked: 0,
};

export function q05AgentTransferRound(
  server: Q05Server,
  db: Q05Db,
  managers: Q05Actor[],
): RoundBody {
  return async (round) => {
    q05AgentTransferStats.rounds += 1;
    const managerIndex = (round - 1) % managers.length;
    const oldManager = managers[managerIndex]!;
    const newManager = managers[round % managers.length]!;
    const agent = await createManagedAgent(server, oldManager.token, `Q05 交接 Agent ${round}`);
    const befriended = await q05Tool<{ status: string }>(
      server,
      oldManager.token,
      'network_contact_request',
      {
        request_id: newRequestId(`agent_friend_${round}`),
        actor_id: agent.actor_id,
      },
    );
    q05Equal(`第 ${round} 轮管理者与自有 Agent 自动建联`, befriended.status, 'accepted');
    const roomId = await createGroup(
      server,
      oldManager,
      [agent],
      `Q05 交接任务群 ${round}`,
    );
    try {
      const proposed = await q05Tool<{ transfer_id: string }>(
      server,
      oldManager.token,
      'network_agent_transfer_propose',
      {
        request_id: newRequestId(`agent_transfer_${round}`),
        actor_id: agent.actor_id,
        to_manager_id: newManager.actor_id,
        note: `Q05 管理权交接 ${round}`,
      },
    );

    // 奇数轮先提交一次旧管理者重发，确定覆盖“重发成功后再交接”的顺序；
    // 偶数轮与并发批次一起竞争。
    const preReissue =
      round % 2 === 1
        ? await q05ToolOutcome<ReissueResult>(server, oldManager.token, 'network_agent_reissue_token', {
            request_id: newRequestId(`reissue_pre_${round}`),
            actor_id: agent.actor_id,
          })
        : null;
    q05Check(
      `第 ${round} 轮交接前重发顺序可控`,
      preReissue === null || preReissue.ok,
      preReissue?.code,
    );

    // 先发起 100 次旧管理者重发，再同时提交接任；两者在事务层竞争。
    const reissuesPromise = burst(100, () =>
      q05ToolOutcome<ReissueResult>(server, oldManager.token, 'network_agent_reissue_token', {
        request_id: newRequestId(`reissue_${round}`),
        actor_id: agent.actor_id,
      }),
    );
    const acceptPromise = q05ToolOutcome<TransferAcceptResult>(
      server,
      newManager.token,
      'network_agent_transfer_respond',
      {
        request_id: newRequestId(`agent_transfer_ok_${round}`),
        transfer_id: proposed.transfer_id,
        decision: 'accept',
      },
    );
    const [reissues, acceptOutcome] = await Promise.all([reissuesPromise, acceptPromise]);

    q05Equal(`第 ${round} 轮交接接受成功`, acceptOutcome.ok, true);
    const reissueTokens = reissues.flatMap((item) =>
      item.status === 'fulfilled' && item.value.ok && item.value.value
        ? [item.value.value.token]
        : [],
    );
    q05AgentTransferStats.reissueSuccesses += reissueTokens.length;
    const acceptResult = acceptOutcome.value;
    q05Check(`第 ${round} 轮接任者拿到新运行凭据`, typeof acceptResult?.token === 'string');
    q05AgentTransferStats.acceptSuccesses += 1;

    const management = await q05Tool<AgentManagementView>(
      server,
      newManager.token,
      'network_agent_management_get',
      { actor_id: agent.actor_id },
    );
    q05Equal(`第 ${round} 轮最终管理者唯一`, management.management?.manager_id, newManager.actor_id);
    q05Equal(`第 ${round} 轮权限版本只轮换一次`, management.management?.permission_version, 2);
    q05Equal(
      `第 ${round} 轮管理关系只有一条 active`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM agent_managements WHERE agent_id = ? AND status = 'active' AND manager_id = ?",
        agent.actor_id,
        newManager.actor_id,
      ),
      1,
    );
    q05Equal(
      `第 ${round} 轮旧管理者不再 active`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM agent_managements WHERE agent_id = ? AND status = 'active' AND manager_id = ?",
        agent.actor_id,
        oldManager.actor_id,
      ),
      0,
    );
    q05Equal(
      `第 ${round} 轮只有一个有效运行凭据`,
      db.scalar(
        'SELECT COUNT(*) AS n FROM credentials WHERE actor_id = ? AND revoked_at IS NULL',
        agent.actor_id,
      ),
      1,
    );
    const activeCredential = db.row<{ credential_id: string; device_id: string }>(
      'SELECT * FROM credentials WHERE actor_id = ? AND revoked_at IS NULL',
      agent.actor_id,
    )!;
    q05Equal(`第 ${round} 轮最终凭据来自交接`, activeCredential.device_id, 'management_transfer');
    const newTokenMe = await q05ToolOutcome<{ actor_id: string }>(
      server,
      acceptResult!.token!,
      'network_me',
      {},
    );
    q05Equal(`第 ${round} 轮新凭据可用`, newTokenMe.ok, true);
    q05Equal(`第 ${round} 轮新凭据绑定同一 Agent`, newTokenMe.value?.actor_id, agent.actor_id);

    const oldTokenMe = await q05ToolOutcome(server, agent.token, 'network_me', {});
    q05Equal(`第 ${round} 轮旧运行凭据失效`, oldTokenMe.ok, false);
    q05Equal(`第 ${round} 轮旧运行凭据错误码`, oldTokenMe.code, 'CREDENTIAL_INVALID');
    for (const token of reissueTokens) {
      const reissuedMe = await q05ToolOutcome(server, token, 'network_me', {});
      q05Equal(`第 ${round} 轮交接前重发的 token 全部失效`, reissuedMe.ok, false);
    }
    if (preReissue?.ok && preReissue.value) {
      const preTokenMe = await q05ToolOutcome(server, preReissue.value.token, 'network_me', {});
      q05Equal(`第 ${round} 轮确定性重发 token 交接后失效`, preTokenMe.ok, false);
      q05AgentTransferStats.preReissueRevoked += 1;
    }

    q05Equal(
      `第 ${round} 轮交接只接受一次`,
      db.scalar(
        "SELECT COUNT(*) AS n FROM agent_management_transfers WHERE transfer_id = ? AND status = 'accepted'",
        proposed.transfer_id,
      ),
      1,
    );

    const afterTransfer = await burst(10, () =>
      q05ToolOutcome(server, oldManager.token, 'network_agent_reissue_token', {
        request_id: newRequestId(`reissue_after_${round}`),
        actor_id: agent.actor_id,
      }),
    );
    q05Equal(
      `第 ${round} 轮交接后旧管理者不能重发`,
      afterTransfer.every(
        (item) =>
          item.status === 'fulfilled' &&
          !item.value.ok &&
          (item.value.code === 'PERMISSION_DENIED' || item.value.code === 'VERSION_CONFLICT'),
      ),
      true,
    );
    } finally {
      // 每轮独立群；每个管理者约 25 个群，低于活跃房间上限。
    }
  };
}
