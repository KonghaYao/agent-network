import { BusinessError } from '../contracts/errors';
import { decodeCursor, type CursorPayload } from '../contracts/cursor';
import type { RoomMemberRow, RoomRow } from '../storage/rows';

/**
 * 群历史边界的唯一计算入口。
 *
 * 所有读取路径（消息、时间线、sync、搜索、附件、任务上下文）都从这里
 * 取得边界，避免“列表过滤了、按 ID 直读仍然放行”。边界只在每次请求时
 * 按当前成员代次和当前群策略计算，旧游标只定位数据，不携带授权。
 *
 * - direct 房间保持既有单聊语义，不设加入边界。
 * - group 默认 `from_join`：只能读取 `joined_seq`/`joined_at` 之后的内容。
 * - group `full`：群主显式开启后边界为 0；关闭后下一次读取立即回到
 *   `from_join`，已复制内容无法回收。
 */
export interface HistoryBoundary {
  full: boolean;
  /** 消息、事件与时间线使用的序号边界。 */
  fromSeq: number;
  /** 文件、任务等按创建时间记录的资源使用的毫秒边界。 */
  fromAt: number;
  policyRevision: number;
  memberGeneration: number;
}

export function historyBoundary(
  room: Pick<RoomRow, 'kind' | 'member_history_policy' | 'policy_revision'>,
  member: Pick<RoomMemberRow, 'joined_seq' | 'joined_at' | 'member_generation'>,
): HistoryBoundary {
  const full = room.kind === 'direct' || room.member_history_policy === 'full';
  return {
    full,
    fromSeq: full ? 0 : member.joined_seq,
    fromAt: full ? 0 : member.joined_at,
    policyRevision: room.policy_revision,
    memberGeneration: member.member_generation,
  };
}

/** 历史/搜索/时间线游标包含成员代次；重新加入后旧代次游标不能继续用。 */
export function historyCursorScope(
  kind: 'history' | 'timeline' | 'search' | 'files',
  roomId: string,
  generation: number,
): string {
  return `room:${roomId}:${kind}:g${generation}`;
}

const HISTORY_CURSOR_KINDS = ['history', 'timeline', 'search', 'files'] as const;

/**
 * 解码带成员代次的游标。
 *
 * 旧版本游标（没有 `:g<n>`）或重新加入前的游标统一返回 `CURSOR_EXPIRED`，
 * 不把 scope 不匹配误报成 `INVALID_ARGUMENT`，也不允许旧游标借新代次继续翻页。
 * 跨视图（如 messages 游标传给 timeline）仍保持 `INVALID_ARGUMENT`，否则客户端
 * 会把参数错误误判为需要重新翻页。
 */
export function decodeHistoryCursor(
  value: string,
  scope: string,
  roomId: string,
): CursorPayload {
  try {
    return decodeCursor(value, scope);
  } catch (error) {
    if (
      error instanceof BusinessError &&
      error.code === 'INVALID_ARGUMENT' &&
      typeof error.details?.actual === 'string'
    ) {
      const actual = error.details.actual;
      const expectedPrefix = `room:${roomId}:`;
      const kindPart = scope.startsWith(expectedPrefix)
        ? scope.slice(expectedPrefix.length)
        : '';
      const kindSeparator = kindPart.indexOf(':');
      const kind = kindSeparator === -1 ? kindPart : kindPart.slice(0, kindSeparator);
      const sameKind =
        kind.length > 0 &&
        (HISTORY_CURSOR_KINDS as readonly string[]).includes(kind) &&
        (actual === `room:${roomId}:${kind}` ||
          actual.startsWith(`room:${roomId}:${kind}:g`));
      const legacyFileCursor = kind === 'files' && actual === `room_files:${roomId}`;
      if (sameKind || legacyFileCursor) {
        throw new BusinessError('CURSOR_EXPIRED', '成员代次或历史边界已变化，请重新读取', {
          scope,
          actual,
        });
      }
    }
    throw error;
  }
}

/**
 * 文件/任务等按创建事件序号记录的资源：
 * - 新行 `created_seq` 非空时按序号判定；
 * - 升级前的旧行没有序号，回退到 `created_at`，保留既有成员已有内容；
 * - `full` 边界返回恒真条件，不拼接调用点自己的 SQL。
 */
export function createdHistoryFilter(
  alias: string,
  boundary: HistoryBoundary,
): { sql: string; binds: number[] } {
  if (boundary.full) return { sql: '1 = 1', binds: [] };
  return {
    sql: `((${alias}.created_seq IS NOT NULL AND ${alias}.created_seq >= ?)
      OR (${alias}.created_seq IS NULL AND ${alias}.created_at >= ?))`,
    binds: [boundary.fromSeq, boundary.fromAt],
  };
}

/** 只用于已经装载到内存的单行判断；旧的 NULL created_seq 回退到 created_at。 */
export function visibleMessage(
  row: Pick<{ created_seq: number }, 'created_seq'>,
  boundary: HistoryBoundary,
): boolean {
  return boundary.full || row.created_seq >= boundary.fromSeq;
}

export function visibleCreated(
  row: { created_seq: number | null; created_at: number },
  boundary: HistoryBoundary,
): boolean {
  if (boundary.full) return true;
  return row.created_seq === null
    ? row.created_at >= boundary.fromAt
    : row.created_seq >= boundary.fromSeq;
}

/** 读取结果附带的授权快照，客户端可显示材料失权或调试边界。 */
export interface HistorySnapshot {
  policy_revision: number;
  history_from_seq: string;
  member_generation: string;
}

export function historySnapshot(boundary: HistoryBoundary): HistorySnapshot {
  return {
    policy_revision: boundary.policyRevision,
    history_from_seq: String(boundary.fromSeq),
    member_generation: String(boundary.memberGeneration),
  };
}
