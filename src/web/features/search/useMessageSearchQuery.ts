import { useCallback, useEffect, useRef, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import { callTool, type McpError } from '../../lib/mcp-client';
import type {
  MessageSearchHit,
  MessageSearchMode,
  MessageSearchPage,
  MessageSearchScope,
} from './message-search-types';

export type MessageSearchPhase =
  | 'idle'
  | 'loading'
  | 'loading-more'
  | 'results'
  | 'empty'
  | 'scan-limited-empty'
  | 'error';

interface SearchArguments {
  roomId: string;
  token: string;
  query: string;
  mode: MessageSearchMode;
  scope: MessageSearchScope;
}

interface UseMessageSearchQueryOptions extends SearchArguments {
  open: boolean;
  composing: boolean;
}

export interface MessageSearchQueryController {
  hits: MessageSearchHit[];
  phase: MessageSearchPhase;
  busy: boolean;
  hasMore: boolean;
  scanLimited: boolean;
  scannedCount: number;
  error: string;
  /** 每次非“加载更多”的响应递增，用来重置键盘选中项。 */
  session: number;
  runNow: () => void;
  loadMore: () => void;
}

function failureText(error: unknown): string {
  return (error as McpError).message || '搜索失败，请重试';
}

function isCancelled(error: unknown): boolean {
  if (!error) return false;
  if ((error as Error).name === 'AbortError') return true;
  return (error as McpError).code === 'ABORTED';
}

function messageKey(hit: MessageSearchHit): string {
  return `${hit.room_id}:${hit.message_id}`;
}

/**
 * 搜索请求状态机：300ms 防抖、AbortController 与 generation 双重护栏。
 *
 * 旧查询、旧模式、旧范围或旧房间的响应必须在写入 state 前同时通过
 * generation 与 key 校验；关闭弹窗时主动 abort，不把取消显示成错误。
 */
export function useMessageSearchQuery({
  open,
  roomId,
  token,
  query,
  mode,
  scope,
  composing,
}: UseMessageSearchQueryOptions): MessageSearchQueryController {
  const [hits, setHits] = useState<MessageSearchHit[]>([]);
  const [phase, setPhase] = useState<MessageSearchPhase>('idle');
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [scanLimited, setScanLimited] = useState(false);
  const [scannedCount, setScannedCount] = useState(0);
  const [error, setError] = useState('');
  const [session, setSession] = useState(0);

  const argsRef = useRef<SearchArguments>({ roomId, token, query, mode, scope });
  argsRef.current = { roomId, token, query, mode, scope };
  const openRef = useRef(open);
  openRef.current = open;
  const hitsRef = useRef<MessageSearchHit[]>([]);
  const cursorRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const keyRef = useRef('');
  const controllerRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const reset = useCallback(() => {
    generationRef.current += 1;
    keyRef.current = '';
    controllerRef.current?.abort();
    controllerRef.current = null;
    busyRef.current = false;
    cursorRef.current = null;
    hitsRef.current = [];
    setHits([]);
    setPhase('idle');
    setBusy(false);
    setHasMore(false);
    setScanLimited(false);
    setScannedCount(0);
    setError('');
  }, []);

  const run = useCallback(async (more: boolean) => {
    const current = argsRef.current;
    const value = current.query.trim();
    if (!openRef.current || !value || busyRef.current) return;
    if (more && !cursorRef.current) return;

    const key = [
      current.roomId,
      current.scope,
      current.mode,
      value,
    ].join('\u0000');
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    keyRef.current = key;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setPhase(more ? 'loading-more' : 'loading');
    if (!more) {
      hitsRef.current = [];
      cursorRef.current = null;
      setHits([]);
      setHasMore(false);
      setScanLimited(false);
      setScannedCount(0);
      }

    const currentRequest = () =>
      generation === generationRef.current && key === keyRef.current;

    try {
      const page = await callTool<MessageSearchPage>(
        'network_message_search',
        {
          ...(current.scope === 'room' ? { room_id: current.roomId } : {}),
          scope: current.scope,
          mode: current.mode,
          query: value,
          limit: LIMITS.messageSearchPageDefault,
          ...(more && cursorRef.current ? { cursor: cursorRef.current } : {}),
        },
        { token: current.token, signal: controller.signal },
      );
      if (!currentRequest()) return;
      const seen = new Set(hitsRef.current.map(messageKey));
      const next = (page.items ?? []).filter((hit) => {
        const keyOfHit = messageKey(hit);
        if (seen.has(keyOfHit)) return false;
        seen.add(keyOfHit);
        return true;
      });
      const merged = more ? [...hitsRef.current, ...next] : next;
      hitsRef.current = merged;
      setHits(merged);
      cursorRef.current = page.next_cursor ?? null;
      setHasMore(page.has_more === true);
      setScanLimited(page.scan_limited === true);
      setScannedCount(page.scanned_count ?? 0);
      setPhase(
        merged.length === 0 ? (page.scan_limited ? 'scan-limited-empty' : 'empty') : 'results',
      );
      if (!more) setSession((valueNow) => valueNow + 1);
    } catch (failure) {
      if (!currentRequest() || isCancelled(failure)) return;
      setError(failureText(failure));
      setPhase('error');
      if (!more) {
        hitsRef.current = [];
        cursorRef.current = null;
        setHits([]);
        setHasMore(false);
        setScanLimited(false);
        setScannedCount(0);
      }
    } finally {
      if (generation === generationRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, []);

  // 输入/模式/范围/房间/身份变化：先终止旧请求，再按 300ms 防抖启动新请求。
  useEffect(() => {
    if (!open) {
      reset();
      return undefined;
    }
    reset();
    const value = query.trim();
    if (!value || composing) return undefined;
    const timer = window.setTimeout(() => {
      timerRef.current = null;
      void run(false);
    }, LIMITS.webMessageSearchDebounceMs);
    timerRef.current = timer;
    return () => {
      if (timerRef.current === timer) timerRef.current = null;
      window.clearTimeout(timer);
    };
    // token 变化（重新登录/身份切换）也必须丢弃旧结果。
  }, [open, roomId, token, query, mode, scope, composing, reset, run]);

  useEffect(
    () => () => {
      clearTimer();
      generationRef.current += 1;
      controllerRef.current?.abort();
    },
    [clearTimer],
  );

  const runNow = useCallback(() => {
    clearTimer();
    void run(false);
  }, [clearTimer, run]);

  const loadMore = useCallback(() => {
    clearTimer();
    void run(true);
  }, [clearTimer, run]);

  return {
    hits,
    phase,
    busy,
    hasMore,
    scanLimited,
    scannedCount,
    error,
    session,
    runNow,
    loadMore,
  };
}
