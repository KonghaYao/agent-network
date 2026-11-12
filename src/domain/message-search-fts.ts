/**
 * FTS5 trigram 查询条件。
 *
 * trigram 只索引至少 3 个 Unicode 码点的子串；更短的查询词必须回退
 * `instr(lower(...))`。查询词始终作为 FTS 短语传入，避免 `-`、`*`、
 * `OR`、`NEAR` 等被解释成 FTS 查询语法；短语内双引号按 FTS5 规则加倍。
 */
export function messageSearchFtsPhrase(query: string, enabled = true): string | null {
  if (!enabled) return null;
  if (Array.from(query).length < 3) return null;
  return `"${query.replaceAll('"', '""')}"`;
}
