import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { navigate } from '../app/router';
import { confirmDialog } from '../features/overlays/confirm';
import type { WebIdentity } from '../lib/identity';
import type { RoomMember, RoomView } from '../lib/chat';
import { addLocalAgent, agentConnectPrompt, listLocalAgents } from '../lib/agents';
import { copyText } from '../lib/files';
import { groupCopyPrompt } from '../lib/group-copy';
import { callTool, type McpError } from '../lib/mcp-client';
import { newRequestId } from '../lib/request-id';
import { queryKeys } from '../lib/query-keys';
import type { RoomPreference } from '../lib/room-preferences';
import type { RoomPreferencesState } from './useRoomPreferences';

export interface AgentManagementView {
  actor_id: string;
  disabled: boolean;
  can_manage: boolean;
  can_transfer: boolean;
  pending_transfer: { can_accept: boolean; can_cancel: boolean } | null;
}

interface AgentReissueResult {
  actor_id: string;
  token: string;
  mcp_url: string;
}

interface AgentDisableResult {
  actor_id: string;
  stopped?: { pending_deliveries: number; claimed_deliveries: number };
}

export interface ReissueState {
  name: string;
  prompt: string;
}

function failureText(error: unknown): string {
  return (error as McpError).message || String(error);
}

function registryToken(mcpUrl: string): string | null {
  try {
    const value = new URL(mcpUrl).searchParams.get('token');
    return value && /^[A-Za-z0-9._~-]+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 会话菜单的写操作：偏好、联系人安全、Agent 管理与群解散。
 *
 * 从 ChatPage 拆出，避免页面同时承担时间线、对话框与全部菜单事务。
 * 所有写操作都带唯一 `request_id`，成功后只失效相关查询，不改本地缓存。
 */
export function useRoomMenuActions({
  room,
  peer,
  identity,
  token,
  members,
  management,
  blocked,
  preferences,
  queryClient,
  setStatus,
  closeOverlays,
}: {
  room: RoomView | null;
  peer: RoomMember | null;
  identity: WebIdentity | null;
  token: string | null;
  members: Map<string, RoomMember>;
  management: AgentManagementView | null;
  blocked: boolean;
  preferences: RoomPreferencesState;
  queryClient: ReturnType<typeof useQueryClient>;
  setStatus: (message: string) => void;
  closeOverlays: () => void;
}) {
  const [reissue, setReissue] = useState<ReissueState | null>(null);
  const [renameAgentOpen, setRenameAgentOpen] = useState(false);

  const canManageAgent =
    peer?.kind === 'agent' &&
    (management?.can_manage === true || room?.peer_can_manage === true);

  const onTogglePreference = useCallback(
    (field: keyof RoomPreference) => {
      if (!room) return;
      const saved = preferences.toggle(room.room_id, field);
      setStatus(saved ? '已更新，仅在此浏览器生效' : '已临时更新；浏览器未能保存设置');
    },
    [preferences, room, setStatus],
  );

  const onCopyPrompt = useCallback(async () => {
    if (!room || !identity) return;
    try {
      if (room.kind === 'group') {
        await copyText(groupCopyPrompt(room, Array.from(members.values())));
        setStatus(room.read_only ? '已复制只读群标识' : '已复制群信息，可直接粘贴给 Agent');
        return;
      }
      if (peer?.kind !== 'agent') return;
      const local = listLocalAgents(identity.actor_id).find(
        (entry) => entry.actor_id === peer.actor_id,
      );
      const value = local ? registryToken(local.mcp_url) : null;
      if (!value) {
        setStatus(
          '本浏览器没有保存该 Agent 的 token/MCP URL；请让用户提供，或让用户新建 Agent 并把提示词给你。',
        );
        return;
      }
      await copyText(agentConnectPrompt(value, peer.actor_id));
      setStatus('已复制 Agent 连接提示词（含凭据，勿转发）');
    } catch (error) {
      setStatus(`复制失败：${failureText(error)}`);
    }
  }, [identity, members, peer, room, setStatus]);

  const onToggleBlock = useCallback(async () => {
    if (!peer || !token || !identity || !room || room.kind !== 'direct') return;
    const confirmed = await confirmDialog({
      title: blocked ? '解除拉黑' : '拉黑',
      message: blocked
        ? '解除拉黑只恢复“可以重新联系”的状态，不会自动恢复好友关系；需要重新建立关系时必须重新申请。确定解除拉黑？'
        : '拉黑后：\n· 立即结束当前好友关系\n· 拒绝新的私聊、好友申请与 direct 邀请\n· 不会移出共同群，也不会删除历史消息\n· 解除拉黑不会自动恢复好友，需要重新申请\n\n共同群里来自对方的定向 @ 通知会按你的设置静默。确定拉黑？',
      confirmText: blocked ? '解除拉黑' : '拉黑',
      danger: !blocked,
    });
    if (!confirmed) return;
    try {
      await callTool(
        blocked ? 'network_contact_unblock' : 'network_contact_block',
        {
          request_id: newRequestId(blocked ? 'web_contact_unblock' : 'web_contact_block'),
          actor_id: peer.actor_id,
        },
        { token },
      );
      setStatus(blocked ? '已解除拉黑；好友关系需要重新申请' : '已拉黑；历史保留，共同群不受影响');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.contactBlocks(identity.actor_id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identity.actor_id) }),
      ]);
    } catch (error) {
      setStatus(`操作失败：${failureText(error)}`);
    }
  }, [blocked, identity, peer, queryClient, room, setStatus, token]);

  const onDeleteFriend = useCallback(async () => {
    if (!peer || !token || !identity || !room || room.kind !== 'direct') return;
    const confirmed = await confirmDialog({
      title: '删除好友',
      message:
        '删除好友会结束双方好友关系，但保留历史消息与共同群；重新建立关系需要重新申请。\n删除好友不会阻止对方再次申请；如需拒绝私聊与申请，请使用“拉黑”。确定删除好友？',
      confirmText: '删除好友',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await callTool(
        'network_contact_remove',
        { request_id: newRequestId('web_contact_remove'), actor_id: peer.actor_id },
        { token },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identity.actor_id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.contacts(identity.actor_id) }),
      ]);
      navigate('/');
    } catch (error) {
      setStatus(`删除失败：${failureText(error)}`);
    }
  }, [identity, peer, queryClient, room, setStatus, token]);

  const onArchive = useCallback(async () => {
    if (!peer || peer.kind !== 'agent' || !token || !identity) return;
    const confirmed = await confirmDialog({
      title: '归档 Agent',
      message: `归档 ${peer.name} 后，这个单聊会从默认会话列表隐藏，可随时在“已归档 Agents”中恢复；消息、文件与凭据都不受影响。`,
      confirmText: '归档',
    });
    if (!confirmed) return;
    try {
      await callTool(
        'network_agent_archive',
        { request_id: newRequestId('web_agent_archive'), actor_id: peer.actor_id },
        { token },
      );
      setStatus('已归档，可在已归档 Agents 中恢复');
      await queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identity.actor_id) });
    } catch (error) {
      setStatus(`归档失败：${failureText(error)}`);
    }
  }, [identity, peer, queryClient, setStatus, token]);

  const onToggleAgentDisabled = useCallback(async () => {
    if (!peer || peer.kind !== 'agent' || !token || !identity) return;
    try {
      const state = await callTool<AgentManagementView>(
        'network_agent_management_get',
        { actor_id: peer.actor_id },
        { token },
      );
      const disabled = Boolean(state.disabled);
      if (!disabled) {
        const confirmed = await confirmDialog({
          title: '停用 Agent',
          message:
            '停用后该 Agent 的旧凭据会被拒绝，领取/上报/完成/失败与新投递全部停止；待处理投递会被取消，不会自动结束任何外部工作。确定继续？',
          confirmText: '停用',
          danger: true,
        });
        if (!confirmed) {
          setStatus('已取消停用。');
          return;
        }
      }
      const result = await callTool<AgentDisableResult>(
        disabled ? 'network_agent_enable' : 'network_agent_disable',
        {
          request_id: newRequestId(disabled ? 'web_agent_enable' : 'web_agent_disable'),
          actor_id: peer.actor_id,
        },
        { token },
      );
      if (result.actor_id !== peer.actor_id) throw new Error('停用/启用结果不完整');
      const stopped = result.stopped;
      setStatus(
        disabled
          ? '已启用：该 Agent 可以重新执行与接收投递'
          : stopped
            ? `已停用：取消 ${stopped.pending_deliveries} 条待处理、${stopped.claimed_deliveries} 条已领取投递`
            : '已停用：该 Agent 不能再执行或接收新投递',
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentManagement(peer.actor_id),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identity.actor_id) }),
      ]);
    } catch (error) {
      setStatus(`停用/启用失败：${failureText(error)}`);
    }
  }, [identity, peer, queryClient, setStatus, token]);

  const onReissueToken = useCallback(async () => {
    if (!peer || peer.kind !== 'agent' || !token || !identity) return;
    const confirmed = await confirmDialog({
      title: '重置链接',
      message:
        '这会注销该 Agent 的旧 token 并生成新 token；旧 token 立即失效，现有 MCP/SSE/事件连接会失效。重置后不会自动复制，请在新提示词出现后点击「复制提示词」。',
      confirmText: '重新生成',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await callTool<AgentReissueResult>(
        'network_agent_reissue_token',
        {
          request_id: newRequestId('web_agent_reissue'),
          actor_id: peer.actor_id,
        },
        { token },
      );
      if (!result.token || result.actor_id !== peer.actor_id) {
        throw new Error('重发结果不完整');
      }
      const existing = listLocalAgents(identity.actor_id).find(
        (entry) => entry.actor_id === peer.actor_id,
      );
      addLocalAgent(identity.actor_id, {
        owner_actor_id: identity.actor_id,
        actor_id: result.actor_id,
        name: existing?.name ?? peer.name,
        agent_session_id: existing?.agent_session_id ?? null,
        created_at: existing?.created_at ?? String(Date.now()),
        mcp_url: result.mcp_url,
      });
      setReissue({
        name: peer.name,
        prompt: agentConnectPrompt(result.token, result.actor_id),
      });
      setStatus('已重置：新 token 已生成，旧 token 已失效。请点击「复制提示词」。');
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agentManagement(peer.actor_id),
      });
    } catch (error) {
      setStatus(`重置失败：${failureText(error)}`);
    }
  }, [identity, peer, queryClient, setStatus, token]);

  const onDissolve = useCallback(async () => {
    if (!room || room.kind !== 'group' || !token || !identity) return;
    const confirmed = await confirmDialog({
      title: '解散群聊',
      message:
        '解散群聊后：\n· 所有成员立即失去新的发言、邀请与文件写入权限\n· 待处理投递与邀请链接、入群申请立即失效\n· 解散时仍在群的成员保留截至解散点的只读归档；此前已退群/被移除者无归档资格\n· 已下载到本地的文件副本无法收回\n\n解散不删除消息、文件或成果。确定解散？',
      confirmText: '解散群聊',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await callTool<{ dissolve?: { cancelled_deliveries: number } }>(
        'network_room_dissolve',
        { request_id: newRequestId('web_room_dissolve'), room_id: room.room_id },
        { token },
      );
      setStatus(
        result.dissolve
          ? `已解散，取消 ${result.dissolve.cancelled_deliveries} 条待处理投递`
          : '已解散',
      );
      closeOverlays();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.room(room.room_id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identity.actor_id) }),
      ]);
    } catch (error) {
      setStatus(`解散失败：${failureText(error)}`);
    }
  }, [closeOverlays, identity, queryClient, room, setStatus, token]);

  return {
    canManageAgent,
    reissue,
    setReissue,
    renameAgentOpen,
    setRenameAgentOpen,
    onTogglePreference,
    onCopyPrompt,
    onToggleBlock,
    onDeleteFriend,
    onArchive,
    onToggleAgentDisabled,
    onReissueToken,
    onDissolve,
  };
}
