/**
 * `metadata` / `scopes` 等 TEXT 列的 JSON 对象解析。
 *
 * 解析失败、非对象、数组与 `null` 一律返回空对象；调用方不需要再写 try/catch。
 */

export function parseMetadataObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
