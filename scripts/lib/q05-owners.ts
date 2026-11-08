/**
 * Q05-T01 场景九：群主转让 × 退群/解散/移除。
 *
 * 100 轮，每轮创建新群、链接邀请与待确认转让，再并发提交接受、解散、退群
 * 与移除。最终必须是一个 active owner 或 dissolved；绝不出现 ownerless active
 * 群；解散后旧邀请/链接不能加入。
 */

import {
  createGroup,
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

interface OwnerTransferView {
  transfer_id: string;
  version: number;
  status: string;
}

interface RoomDetailView {
  owner_transfer: OwnerTransferView | null;
}

export const q05OwnerStats = {
  rounds: 0,
  dissolved: 0,
  transferred: 0,
  ownerRetained: 0,
};

export function q05OwnerTransferRound(
  server: Q05Server,
  db: Q05Db,
  owners: Q05Actor[],
  outsider: Q05Actor,
): RoundBody {
  return async (round, random) => {
    q05OwnerStats.rounds += 1;
    // 轮换群主，避免单一身份累计 100 个群触发活跃房间上限；每轮仍是真实建群。
    const owner = owners[(round - 1) % owners.length]!;
    const successor = owners[round % owners.length]!;
    const roomId = await createGroup(
      server,
      owner,
      [successor],
      `Q05 群主竞争 ${round}`,
    );
    try {
      const created = await q05Tool<{
      invitation: { invitation_id: string };
      invite_key: string | null;
      share_url: string | null;
    }>(server, owner.token, 'network_room_invite_create', {
      request_id: newRequestId(`owner_invite_${round}`),
      room_id: roomId,
      max_uses: 5,
    });
    const invitation = {
      invitation_id: created.invitation.invitation_id,
      invite_key: created.invite_key ?? '',
    };
    const proposed = await q05Tool<RoomDetailView>(
      server,
      owner.token,
      'network_room_owner_transfer_propose',
      {
        request_id: newRequestId(`owner_propose_${round}`),
        room_id: roomId,
        target_actor_id: successor.actor_id,
      },
    );
    q05Equal(`第 ${round} 轮转让提议 pending`, proposed.owner_transfer?.status, 'pending');
    const transfer = proposed.owner_transfer!;

    const operations: {
      name: 'accept' | 'dissolve' | 'leave' | 'remove';
      call: () => Promise<Awaited<ReturnType<typeof q05ToolOutcome>>>;
    }[] = [
      {
        name: 'accept',
        call: () =>
          q05ToolOutcome(server, successor.token, 'network_room_owner_transfer_respond', {
            request_id: newRequestId(`owner_accept_${round}`),
            transfer_id: transfer.transfer_id,
            action: 'accept',
            expected_version: transfer.version,
          }),
      },
      {
        name: 'dissolve',
        call: () =>
          q05ToolOutcome(server, owner.token, 'network_room_dissolve', {
            request_id: newRequestId(`owner_dissolve_${round}`),
            room_id: roomId,
            reason: `Q05 群主竞争解散 ${round}`,
          }),
      },
      {
        name: 'leave',
        call: () =>
          q05ToolOutcome(server, owner.token, 'network_room_leave', {
            request_id: newRequestId(`owner_leave_${round}`),
            room_id: roomId,
          }),
      },
      {
        name: 'remove',
        call: () =>
          q05ToolOutcome(server, owner.token, 'network_room_members_update', {
            request_id: newRequestId(`owner_remove_${round}`),
            room_id: roomId,
            remove: [successor.actor_id],
          }),
      },
    ];
    // 固定种子驱动提交顺序；四路调用仍在同一 tick 放行，形成真实竞争。
    const ordered = shuffle(operations, random);
    const settled = await Promise.all(ordered.map((operation) => operation.call()));
    const outcomeOf = (name: 'accept' | 'dissolve' | 'leave' | 'remove') =>
      settled[ordered.findIndex((operation) => operation.name === name)]!;
    const acceptOutcome = outcomeOf('accept');
    const dissolveOutcome = outcomeOf('dissolve');
    const leaveOutcome = outcomeOf('leave');
    const removeOutcome = outcomeOf('remove');

    const room = db.row<{ owner_id: string | null; dissolved_at: number | null }>(
      'SELECT owner_id, dissolved_at FROM rooms WHERE room_id = ?',
      roomId,
    )!;
    const activeOwners = db.rows<{ actor_id: string }>(
      "SELECT actor_id FROM room_members WHERE room_id = ? AND status = 'active' AND role = 'owner'",
      roomId,
    );
    const acceptedTransfers = db.scalar(
      "SELECT COUNT(*) AS n FROM room_owner_transfers WHERE room_id = ? AND status = 'accepted'",
      roomId,
    );
    if (room.dissolved_at === null) {
      q05Check(`第 ${round} 轮 active 群必须有 owner`, room.owner_id !== null, room.owner_id);
      q05Equal(`第 ${round} 轮 active 群 owner 行唯一`, activeOwners.length, 1);
      q05Equal(`第 ${round} 轮 owner 与成员角色一致`, activeOwners[0]?.actor_id, room.owner_id);
      q05Check(
        `第 ${round} 轮 owner 只能是原群主或接任者`,
        room.owner_id === owner.actor_id || room.owner_id === successor.actor_id,
        room.owner_id,
      );
      if (room.owner_id === successor.actor_id) {
        q05OwnerStats.transferred += 1;
        q05Equal(`第 ${round} 轮接任者转让只接受一次`, acceptedTransfers, 1);
        q05Equal(`第 ${round} 轮接任后原群主不再是 owner`, activeOwners[0]?.actor_id, successor.actor_id);
      } else {
        q05OwnerStats.ownerRetained += 1;
        q05Equal(`第 ${round} 轮未接受的转让不改变 owner`, acceptedTransfers, 0);
      }
      q05Equal(`第 ${round} 轮 active 群不接受解散`, dissolveOutcome.ok, false);
    } else {
      q05OwnerStats.dissolved += 1;
      q05Check(
        `第 ${round} 轮 dissolved 群保留归档 owner 至多一个`,
        activeOwners.length <= 1,
        activeOwners.length,
      );
      q05Equal(
        `第 ${round} 轮解散后邀请全部撤销`,
        db.scalar(
          "SELECT COUNT(*) AS n FROM room_invitations WHERE room_id = ? AND status = 'pending'",
          roomId,
        ),
        0,
      );
      q05Equal(
        `第 ${round} 轮解散后邀请状态为 revoked`,
        db.row<{ status: string }>(
          'SELECT status FROM room_invitations WHERE invitation_id = ?',
          invitation.invitation_id,
        )?.status,
        'revoked',
      );
      // 链接预览可能继续展示已解散群的只读介绍；安全边界以“不能加入”为准。
      const joinAttempt = await q05ToolOutcome(server, outsider.token, 'network_room_invite_respond', {
        request_id: newRequestId(`owner_old_link_${round}`),
        invitation_id: invitation.invitation_id,
        invite_key: invitation.invite_key,
        action: 'accept',
      });
      q05Equal(`第 ${round} 轮解散后旧链接不能加入`, joinAttempt.ok, false);
      q05Equal(
        `第 ${round} 轮解散后 outsider 仍未加入`,
        db.scalar(
          "SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'",
          roomId,
          outsider.actor_id,
        ),
        0,
      );
      q05Equal(`第 ${round} 轮解散时转让未 accepted`, acceptedTransfers, 0);
    }

    const totalAcceptedTransfers = db.scalar(
      "SELECT COUNT(*) AS n FROM room_owner_transfers WHERE room_id = ? AND status = 'accepted'",
      roomId,
    );
    q05Check(
      `第 ${round} 轮群主转让接受至多一次`,
      totalAcceptedTransfers <= 1,
      totalAcceptedTransfers,
    );
    q05Check(
      `第 ${round} 轮不存在 ownerless active 群`,
      !(room.dissolved_at === null && (room.owner_id === null || activeOwners.length !== 1)),
      { room, activeOwners: activeOwners.length },
    );
    for (const [name, outcome] of [
      ['accept', acceptOutcome],
      ['dissolve', dissolveOutcome],
      ['leave', leaveOutcome],
      ['remove', removeOutcome],
    ] as const) {
      if (outcome.ok) continue;
      q05Check(
        `第 ${round} 轮 ${name} 失败有稳定错误码`,
        typeof outcome.code === 'string' && outcome.code.length > 0,
        outcome.code,
      );
    }
    } finally {
      // 群按群主轮换创建；每个身份只累计约 25 个群，无需清理。
    }
  };
}
