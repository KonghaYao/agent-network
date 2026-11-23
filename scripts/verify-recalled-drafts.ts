/**
 * 撤回后重新编辑的本地原文缓存单测。
 *
 * 纯内存 Storage，不启动浏览器；覆盖有界淘汰、actor 隔离、空正文、
 * 恢复后移除与身份清理（含退出登录时普通草稿按 actor 精确清理）。真实 sessionStorage 与发送/撤回链路由
 * `tests/e2e/group-message-moderation.spec.ts` 驱动。
 *
 * 运行：`bun scripts/verify-recalled-drafts.ts`
 */
import {
  RECALLED_DRAFT_BODY_MAX_BYTES,
  RECALLED_DRAFT_MAX_ITEMS,
  RECALLED_DRAFT_TOTAL_MAX_BYTES,
  clearRecalledDrafts,
  forgetRecalledDraft,
  listRecalledDrafts,
  readRecalledDraft,
  recalledDraftStorageKey,
  rememberRecalledDraft,
  type RecalledDraftStorage,
} from '../src/web/lib/recalled-drafts';
import { clearActorDrafts, draftKey } from '../src/web/lib/drafts';
import { check, checkEqual, checksPassed } from './lib/harness';

class MemoryStorage implements RecalledDraftStorage {
  private readonly map = new Map<string, string>();
  failWrites = false;

  get length(): number {
    return this.map.size;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota exceeded');
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

function fresh(): MemoryStorage {
  return new MemoryStorage();
}

// ---- 空正文与单条上限 ----
{
  const storage = fresh();
  rememberRecalledDraft('alice', 'm_empty', '', { storage });
  rememberRecalledDraft('alice', 'm_space', '   \n\t ', { storage });
  checkEqual('空正文与纯空白不入缓存', listRecalledDrafts('alice', storage).length, 0);
  checkEqual('空正文读取为 null', readRecalledDraft('alice', 'm_empty', storage), null);
}
{
  const storage = fresh();
  const exact = 'a'.repeat(RECALLED_DRAFT_BODY_MAX_BYTES);
  const over = 'b'.repeat(RECALLED_DRAFT_BODY_MAX_BYTES + 1);
  rememberRecalledDraft('alice', 'm_exact', exact, { storage });
  rememberRecalledDraft('alice', 'm_over', over, { storage });
  checkEqual('16KB 正文保留', readRecalledDraft('alice', 'm_exact', storage), exact);
  checkEqual('超过 16KB 正文不缓存', readRecalledDraft('alice', 'm_over', storage), null);
}
{
  const storage = fresh();
  // 中文按 UTF-8 字节计算：5000 个汉字 15000B 可存，6000 个 18000B 超限。
  rememberRecalledDraft('alice', 'm_cn_ok', '中'.repeat(5000), { storage });
  rememberRecalledDraft('alice', 'm_cn_over', '中'.repeat(6000), { storage });
  check('多字节正文按字节上限判断', readRecalledDraft('alice', 'm_cn_ok', storage) !== null);
  checkEqual('多字节超限正文不缓存', readRecalledDraft('alice', 'm_cn_over', storage), null);
}

// ---- 条数上限：丢最旧 ----
{
  const storage = fresh();
  for (let index = 1; index <= RECALLED_DRAFT_MAX_ITEMS + 1; index += 1) {
    rememberRecalledDraft('alice', `m_${index}`, `正文 ${index}`, { storage });
  }
  const items = listRecalledDrafts('alice', storage);
  checkEqual('条数上限 30', items.length, RECALLED_DRAFT_MAX_ITEMS);
  checkEqual('最新一条在首位', items[0]?.message_id, `m_${RECALLED_DRAFT_MAX_ITEMS + 1}`);
  checkEqual('最旧一条被淘汰', readRecalledDraft('alice', 'm_1', storage), null);
  checkEqual(
    '淘汰后仍保留第二旧',
    readRecalledDraft('alice', 'm_2', storage),
    '正文 2',
  );
}

// ---- 总字节上限：继续丢最旧 ----
{
  const storage = fresh();
  const body = 'x'.repeat(RECALLED_DRAFT_BODY_MAX_BYTES);
  const count = Math.floor(RECALLED_DRAFT_TOTAL_MAX_BYTES / RECALLED_DRAFT_BODY_MAX_BYTES) + 1;
  for (let index = 1; index <= count; index += 1) {
    rememberRecalledDraft('alice', `big_${index}`, body, { storage });
  }
  const items = listRecalledDrafts('alice', storage);
  checkEqual(
    '总字节上限只保留 128KB',
    items.length,
    Math.floor(RECALLED_DRAFT_TOTAL_MAX_BYTES / RECALLED_DRAFT_BODY_MAX_BYTES),
  );
  checkEqual('最旧的大正文被淘汰', readRecalledDraft('alice', 'big_1', storage), null);
  checkEqual('最新的大正文保留', readRecalledDraft('alice', `big_${count}`, storage), body);
}

// ---- 同一消息重复留存只保留最新 ----
{
  const storage = fresh();
  rememberRecalledDraft('alice', 'm_same', '旧正文', { storage });
  rememberRecalledDraft('alice', 'm_same', '新正文', { now: Date.now() + 1, storage });
  checkEqual('重复消息只保留一条', listRecalledDrafts('alice', storage).length, 1);
  checkEqual('重复消息使用最新正文', readRecalledDraft('alice', 'm_same', storage), '新正文');
}

// ---- actor 隔离与读取校验 ----
{
  const storage = fresh();
  rememberRecalledDraft('alice', 'm_shared', 'alice 的正文', { storage });
  rememberRecalledDraft('bob', 'm_shared', 'bob 的正文', { storage });
  checkEqual('alice 读到自己的副本', readRecalledDraft('alice', 'm_shared', storage), 'alice 的正文');
  checkEqual('bob 读到自己的副本', readRecalledDraft('bob', 'm_shared', storage), 'bob 的正文');
  clearRecalledDrafts('alice', storage);
  checkEqual('清理 alice 后自己的副本消失', readRecalledDraft('alice', 'm_shared', storage), null);
  checkEqual('清理 alice 不影响 bob', readRecalledDraft('bob', 'm_shared', storage), 'bob 的正文');
}
{
  const storage = fresh();
  storage.setItem(
    recalledDraftStorageKey('bob'),
    JSON.stringify({
      v: 1,
      actor_id: 'alice',
      items: [{ message_id: 'm_wrong', body: '不是 bob 的正文', bytes: 24, saved_at: 0 }],
    }),
  );
  checkEqual('信封 actor 不一致时读取丢弃', readRecalledDraft('bob', 'm_wrong', storage), null);
  checkEqual('信封 actor 不一致时列表为空', listRecalledDrafts('bob', storage).length, 0);
}

// ---- 恢复后移除 ----
{
  const storage = fresh();
  rememberRecalledDraft('alice', 'm_one', '第一条', { storage });
  rememberRecalledDraft('alice', 'm_two', '第二条', { storage });
  forgetRecalledDraft('alice', 'm_one', storage);
  checkEqual('恢复后对应消息移除', readRecalledDraft('alice', 'm_one', storage), null);
  checkEqual('恢复不移除其他消息', readRecalledDraft('alice', 'm_two', storage), '第二条');
  forgetRecalledDraft('alice', 'm_missing', storage);
  checkEqual('移除不存在的消息保持其余条目', listRecalledDrafts('alice', storage).length, 1);
}

// ---- 身份边界清理 ----
{
  const storage = fresh();
  rememberRecalledDraft('alice', 'm_a', 'alice', { storage });
  rememberRecalledDraft('bob', 'm_b', 'bob', { storage });
  storage.setItem('agent-network-draft-v1:alice:room', '普通草稿不在此命名空间');
  clearRecalledDrafts(null, storage);
  checkEqual('清空全部撤回副本', listRecalledDrafts('alice', storage).length, 0);
  check(
    '清空不影响其他 sessionStorage key',
    storage.getItem('agent-network-draft-v1:alice:room') !== null,
  );
}

// ---- 普通草稿：退出/切号只清当前 actor ----
{
  const storage = fresh();
  storage.setItem(draftKey('alice', 'rm_1'), 'alice 房间 1 草稿');
  storage.setItem(draftKey('alice', 'rm_2'), 'alice 房间 2 草稿');
  storage.setItem(draftKey('bob', 'rm_1'), 'bob 房间 1 草稿');
  storage.setItem('agent-network-token', 'token');
  storage.setItem('agent-network-logged-out', '1');
  clearActorDrafts('alice', storage);
  checkEqual(
    '退出清空当前 actor 第一个房间草稿',
    storage.getItem(draftKey('alice', 'rm_1')),
    null,
  );
  checkEqual(
    '退出清空当前 actor 第二个房间草稿',
    storage.getItem(draftKey('alice', 'rm_2')),
    null,
  );
  checkEqual(
    '重新登录不会回填旧 actor 草稿',
    storage.getItem(draftKey('alice', 'rm_1')),
    null,
  );
  checkEqual('其他 actor 草稿不受影响', storage.getItem(draftKey('bob', 'rm_1')), 'bob 房间 1 草稿');
  checkEqual('非草稿偏好不受影响', storage.getItem('agent-network-token'), 'token');
  checkEqual('退出标记不受影响', storage.getItem('agent-network-logged-out'), '1');

  clearActorDrafts(null, storage);
  checkEqual('actor 未知时不误删任何草稿', storage.getItem(draftKey('bob', 'rm_1')), 'bob 房间 1 草稿');
}

// ---- 写失败静默降级 ----
{
  const storage = fresh();
  storage.failWrites = true;
  let threw = false;
  try {
    rememberRecalledDraft('alice', 'm_fail', '写不进去', { storage });
    forgetRecalledDraft('alice', 'm_fail', storage);
    clearRecalledDrafts('alice', storage);
    clearRecalledDrafts(null, storage);
  } catch {
    threw = true;
  }
  check('存储写失败不抛错', !threw);
  checkEqual('写失败时读取为空', readRecalledDraft('alice', 'm_fail', storage), null);
}

// ---- 无 sessionStorage 时默认降级 ----
{
  let threw = false;
  try {
    rememberRecalledDraft('alice', 'm_no_storage', '无存储环境');
    checkEqual('无默认存储时读取为 null', readRecalledDraft('alice', 'm_no_storage'), null);
  } catch {
    threw = true;
  }
  check('无默认存储时不抛错', !threw);
}

console.log(`\n撤回原文缓存单测通过：${checksPassed()} 项`);
