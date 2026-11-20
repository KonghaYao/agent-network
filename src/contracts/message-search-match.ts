/**
 * 消息搜索的纯文本匹配与片段裁剪。
 *
 * 这里只放无 I/O 的文本函数，服务端与浏览器可共享同一语义：
 * - exact：ASCII 大小写不敏感（与 SQLite `lower()` 对齐）的连续子串；
 * - fuzzy：双侧全角 ASCII 折叠、ASCII 小写、删除 Unicode 空白/标点后，
 *   在正文中按顺序寻找 query 码点子序列；
 * - 所有区间都是 `snippet` 字符串本身的 UTF-16 code unit、左闭右开区间。
 */

export interface SearchMatchRange {
  /** 片段内 UTF-16 起点（含）。 */
  start: number;
  /** 片段内 UTF-16 终点（不含）。 */
  end: number;
}

export interface SearchSnippet {
  snippet: string;
  match_ranges: SearchMatchRange[];
}

const WHITE_SPACE_OR_PUNCTUATION = /[\p{White_Space}\p{P}]/u;
const FULLWIDTH_FIRST = 0xff01;
const FULLWIDTH_LAST = 0xff5e;
const FULLWIDTH_OFFSET = 0xfee0;
const IDEOGRAPHIC_SPACE = 0x3000;

/**
 * fuzzy 的单个码点折叠。
 *
 * 全角 ASCII 与全角空格只做一对一映射，避免 NFKC 展开让原文位置失真；
 * 折叠后的空白/标点删除，符号（emoji、`+`、数学符号等）保留。
 */
export function foldSearchCodePoint(codePoint: number): string | null {
  let folded = codePoint;
  if (codePoint >= FULLWIDTH_FIRST && codePoint <= FULLWIDTH_LAST) {
    folded = codePoint - FULLWIDTH_OFFSET;
  } else if (codePoint === IDEOGRAPHIC_SPACE) {
    folded = 0x20;
  }
  if (folded >= 0x41 && folded <= 0x5a) folded += 0x20;
  const text = String.fromCodePoint(folded);
  return WHITE_SPACE_OR_PUNCTUATION.test(text) ? null : text;
}

/** 归一化 fuzzy 查询词；结果为空表示没有任何可匹配字符。 */
export function normalizeFuzzyQuery(query: string): string {
  const parts: string[] = [];
  for (const char of query) {
    const folded = foldSearchCodePoint(char.codePointAt(0) ?? 0);
    if (folded !== null) parts.push(folded);
  }
  return parts.join('');
}

/**
 * 在正文中寻找最早结束的贪心保序子序列。
 *
 * 返回每个 query 码点命中的原文 UTF-16 区间；重复字符必须消耗不同正文位置。
 */
export function findFuzzyMatch(
  body: string,
  normalizedQuery: string,
): SearchMatchRange[] | null {
  if (normalizedQuery.length === 0) return null;
  const query = Array.from(normalizedQuery);
  const positions: SearchMatchRange[] = [];
  let cursor = 0;
  let offset = 0;
  for (const char of body) {
    const folded = foldSearchCodePoint(char.codePointAt(0) ?? 0);
    if (folded !== null && folded === query[cursor]) {
      positions.push({ start: offset, end: offset + char.length });
      cursor += 1;
      if (cursor === query.length) return positions;
    }
    offset += char.length;
  }
  return null;
}

function asciiFold(text: string): string {
  return text.replace(/[A-Z]/gu, (char) => char.toLowerCase());
}

/** 合并重叠或相邻区间，并按起点排序。 */
export function mergeRanges(ranges: SearchMatchRange[]): SearchMatchRange[] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SearchMatchRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/** exact 的可见连续命中；ASCII 折叠不改变 UTF-16 长度。 */
export function findExactRanges(text: string, query: string): SearchMatchRange[] {
  if (query.length === 0) return [];
  const foldedText = asciiFold(text);
  const foldedQuery = asciiFold(query);
  const ranges: SearchMatchRange[] = [];
  let from = 0;
  while (from <= foldedText.length - foldedQuery.length) {
    const index = foldedText.indexOf(foldedQuery, from);
    if (index === -1) break;
    ranges.push({ start: index, end: index + foldedQuery.length });
    from = index + 1;
  }
  return mergeRanges(ranges);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 从 index 开始向右移动 count 个码点，不拆代理对。 */
function advance(text: string, index: number, count: number): number {
  let cursor = index;
  let remaining = count;
  while (remaining > 0 && cursor < text.length) {
    const width =
      isHighSurrogate(text.charCodeAt(cursor)) && isLowSurrogate(text.charCodeAt(cursor + 1))
        ? 2
        : 1;
    cursor += width;
    remaining -= 1;
  }
  return cursor;
}

/** 从 index 开始向左移动 count 个码点，不拆代理对。 */
function retreat(text: string, index: number, count: number): number {
  let cursor = index;
  let remaining = count;
  while (remaining > 0 && cursor > 0) {
    cursor -= 1;
    if (isLowSurrogate(text.charCodeAt(cursor)) && cursor > 0 && isHighSurrogate(text.charCodeAt(cursor - 1))) {
      cursor -= 1;
    }
    remaining -= 1;
  }
  return cursor;
}

function countCodePoints(text: string, start: number, end: number): number {
  let cursor = start;
  let count = 0;
  while (cursor < end) {
    const width =
      isHighSurrogate(text.charCodeAt(cursor)) && cursor + 1 < end && isLowSurrogate(text.charCodeAt(cursor + 1))
        ? 2
        : 1;
    cursor += width;
    count += 1;
  }
  return count;
}

interface SnippetWindow {
  start: number;
  end: number;
}

function snippetWindow(
  body: string,
  firstStart: number,
  lastEnd: number,
  maxChars: number,
  contextChars: number,
): SnippetWindow {
  const chain = countCodePoints(body, firstStart, lastEnd);
  let start = retreat(body, firstStart, contextChars);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lead = start > 0;
    let capacity = maxChars - (lead ? 1 : 0);
    if (capacity < 1) return { start, end: start };
    let end = advance(body, start, capacity);
    if (end < body.length) {
      capacity -= 1;
      end = advance(body, start, capacity);
      if (end >= body.length) {
        capacity += 1;
        end = advance(body, start, capacity);
      }
    }
    // 整条命中链装得下时向右对齐，让链尾也进入窗口。
    if (chain <= capacity) {
      const aligned = retreat(body, lastEnd, capacity);
      if (aligned > start) {
        start = aligned;
        continue;
      }
    }
    return { start, end };
  }
  const lead = start > 0;
  const capacity = Math.max(1, maxChars - (lead ? 1 : 0));
  return { start, end: advance(body, start, capacity) };
}

/**
 * 生成 fuzzy 片段及片段内 UTF-16 命中区间。
 *
 * 先在首个命中前取 `contextChars` 个码点上下文；整条链能装入窗口时向右调整。
 * 省略号也占用 `maxChars` 预算，裁剪不拆代理对。
 */
export function buildSearchSnippet(
  body: string,
  ranges: SearchMatchRange[],
  maxChars: number,
  contextChars: number,
): SearchSnippet {
  if (ranges.length === 0 || maxChars <= 0) return { snippet: '', match_ranges: [] };
  const first = ranges[0]!;
  const last = ranges.at(-1)!;
  const window = snippetWindow(body, first.start, last.end, maxChars, contextChars);
  const lead = window.start > 0;
  const trail = window.end < body.length;
  const snippet = `${lead ? '…' : ''}${body.slice(window.start, window.end)}${trail ? '…' : ''}`;
  const offset = lead ? 1 : 0;
  const visible: SearchMatchRange[] = [];
  for (const range of ranges) {
    if (range.end <= window.start || range.start >= window.end) continue;
    const start = offset + Math.max(range.start, window.start) - window.start;
    const end = offset + Math.min(range.end, window.end) - window.start;
    if (end > start) visible.push({ start, end });
  }
  return { snippet, match_ranges: mergeRanges(visible) };
}
