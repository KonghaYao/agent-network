/** 搜索弹窗的前端类型；不从 domain 导入，避免服务端模块进入浏览器 chunk。 */
export type MessageSearchMode = 'exact' | 'fuzzy';
export type MessageSearchScope = 'room' | 'all';

/** `snippet` 内的 UTF-16 左闭右开区间；与服务端 `match_ranges` 同义。 */
export interface SearchMatchRange {
  start: number;
  end: number;
}

export interface MessageSearchHit {
  message_id: string;
  room_id: string;
  room_kind: 'direct' | 'group';
  room_display_name: string;
  sender_id: string;
  sender_name: string;
  sender_kind: string;
  snippet: string;
  preview: string;
  body_bytes: number;
  created_at: number;
  created_seq: number;
  reply_to: string | null;
  match_ranges?: SearchMatchRange[];
}

export interface MessageSearchPage {
  items: MessageSearchHit[];
  next_cursor: string | null;
  has_more: boolean;
  scan_limited?: boolean;
  scanned_count?: number;
}

/** 定位请求只描述结果，不携带授权或房间快照；每次定位重新向服务端鉴权。 */
export interface SearchNavigationTarget {
  room_id: string;
  message_id: string;
  query: string;
  mode: MessageSearchMode;
  scope: MessageSearchScope;
}

export type LocateResult = { ok: true } | { ok: false; error: string };
