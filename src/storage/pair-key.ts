/**
 * `contact_relations.pair_key` 的 SQL 生成。
 *
 * 关系链按字典序较小的 actor 在前，保证同一对 actor 只有一种 key。联系人列表的
 * 两侧都是行内列，无法在 TypeScript 侧逐行计算，因此统一生成同一段 CASE；
 * 只有一个常量 actor 的调用点仍可用 `sortedPairKey()` 直接绑定。
 */

export function sortedPairKeySql(left: string, right: string): string {
  return `CASE WHEN ${left} < ${right} THEN ${left} || '|' || ${right} ELSE ${right} || '|' || ${left} END`;
}
