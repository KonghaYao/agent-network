/** `If-None-Match` 只接受精确匹配或 `*`；弱比较前缀按 RFC 9110 处理。 */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((value) => value.trim().replace(/^W\//u, ''))
    .some((value) => value === '*' || value === etag);
}
