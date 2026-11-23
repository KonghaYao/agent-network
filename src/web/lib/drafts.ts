/**
 * 普通输入草稿的 key 与身份边界清理。
 *
 * 草稿按 `actor + room` 存 localStorage（崩溃恢复用），因此退出登录、切号、
 * 撤权与配对换身份时必须清掉正在离开的 actor 的草稿，避免下一次会话或
 * 其他身份看到上一份未发送正文。localStorage 可枚举，按前缀精确匹配，
 * 不触碰其他 actor 的草稿或非草稿偏好。
 */

const DRAFT_PREFIX = 'agent-network-draft-v1:';

/** 只依赖 Storage 的最小接口；单元测试注入内存实现。 */
export interface DraftStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

function defaultStorage(): DraftStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 房间草稿 key；Composer 与身份清理共用同一规则。 */
export function draftKey(actorId: string, roomId: string): string {
  return `${DRAFT_PREFIX}${actorId}:${roomId}`;
}

/**
 * 清理单个 actor 的全部房间草稿。
 *
 * actor 为空（尚未登录/身份未知）时不做任何事，避免把其他身份的草稿一起
 * 删掉；存储不可用时静默降级，不影响退出流程。
 */
export function clearActorDrafts(
  actorId: string | null,
  storage: DraftStorage | null = defaultStorage(),
): void {
  if (!actorId || !storage) return;
  const prefix = `${DRAFT_PREFIX}${actorId}:`;
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) storage.removeItem(key);
    }
  } catch {
    // 隐私模式或存储被禁用：退出流程继续，草稿清理尽力而为。
  }
}
