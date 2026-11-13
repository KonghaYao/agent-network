/**
 * Web 页面共用的转义工具。
 *
 * 4B-6 删除 legacy 页面壳后，卡片页样式由 React（`app.css`/`tokens.css`）
 * 接管；这里只保留服务端壳与 SSR 页面共同需要的转义函数。
 */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 内联到 `<script>` 的 JSON 必须转义 HTML 敏感字符与行分隔符。 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}
