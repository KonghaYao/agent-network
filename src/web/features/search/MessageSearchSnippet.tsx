import type { ReactNode } from 'react';

import type { SearchMatchRange } from './message-search-types';

/**
 * 用文本节点与 `<mark>` 渲染命中，不使用 innerHTML。
 *
 * 服务端 ranges 已排序并合并相邻区间；这里仍做边界夹紧与重叠过滤，
 * 防止旧响应或异常区间把文本切坏。
 */
export function MessageSearchSnippet({
  text,
  ranges,
}: {
  text: string;
  ranges?: SearchMatchRange[];
}) {
  if (!ranges || ranges.length === 0 || !text) return <>{text}</>;
  const sorted = ranges
    .filter(
      (range) =>
        Number.isInteger(range.start) &&
        Number.isInteger(range.end) &&
        range.start >= 0 &&
        range.end > range.start,
    )
    .slice()
    .sort((left, right) => left.start - right.start);
  if (sorted.length === 0) return <>{text}</>;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const range of sorted) {
    const start = Math.max(cursor, range.start);
    const end = Math.min(text.length, range.end);
    if (start >= text.length || end <= start) continue;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <mark key={`${start}:${end}`} className="message-search-mark">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}
