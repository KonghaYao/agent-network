import { useCallback, useEffect, useRef, useState } from 'react';

import { LIMITS } from '../../contracts/limits';
import {
  mergeTimelineItems,
  nextOlderCursor,
  reverseChronological,
  type HistoryItem,
  type HistoryPage,
} from '../lib/chat';
import { callTool, type McpError } from '../lib/mcp-client';
import type { SearchNavigationTarget } from '../features/search/message-search-types';

export type MessageSearchNavigationStatus = 'idle' | 'loading' | 'anchored' | 'error';

export interface AnchorWindowInfo {
  message_id: string;
  has_older: boolean;
  has_newer: boolean;
}

export interface MessageSearchNavigationState {
  status: MessageSearchNavigationStatus;
  roomId: string | null;
  target: SearchNavigationTarget | null;
  items: HistoryItem[];
  nextOlder: string | null;
  olderLoading: boolean;
  olderError: string | null;
  anchorWindow: AnchorWindowInfo | null;
  activeMessageId: string | null;
  query: string;
  mode: SearchNavigationTarget['mode'] | null;
  jumpToken: number;
  error: string | null;
}

export interface MessageSearchNavigationController {
  state: MessageSearchNavigationState;
  openAnchor: (target: SearchNavigationTarget) => Promise<boolean>;
  flashMessage: (target: SearchNavigationTarget) => void;
  loadOlder: () => Promise<void>;
  clear: () => void;
}

const INITIAL_STATE: MessageSearchNavigationState = {
  status: 'idle',
  roomId: null,
  target: null,
  items: [],
  nextOlder: null,
  olderLoading: false,
  olderError: null,
  anchorWindow: null,
  activeMessageId: null,
  query: '',
  mode: null,
  jumpToken: 0,
  error: null,
};

function failureText(error: unknown): string {
  return (error as McpError).message || '定位消息失败，请重试';
}

function historyArgs(
  roomId: string,
  humanTimeline: boolean,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    room_id: roomId,
    limit: LIMITS.historyPageDefault,
    ...(humanTimeline ? { view: 'timeline' } : {}),
    ...extra,
  };
}

/**
 * 搜索定位的独立历史窗口。
 *
 * 窗口只保存在本 hook 内，不写 React Query 的实时 timeline 缓存；订阅与
 * 实时缓存继续运行，返回最新时直接复用。每次 anchor 请求重新鉴权。
 */
export function useMessageSearchNavigation({
  roomId,
  token,
  humanTimeline,
}: {
  roomId: string;
  token: string;
  humanTimeline: boolean;
}): MessageSearchNavigationController {
  const [state, setState] = useState<MessageSearchNavigationState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const humanRef = useRef(humanTimeline);
  humanRef.current = humanTimeline;
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const abort = useCallback(() => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const clear = useCallback(() => {
    abort();
    setState((current) => ({ ...INITIAL_STATE, jumpToken: current.jumpToken }));
  }, [abort]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abort();
    };
  }, [abort]);

  // 切房、换 token 或身份视图变化时丢弃旧窗口，避免把上一房间的
  // 授权窗口渲染到新房间。
  useEffect(() => {
    abort();
    setState((current) => ({ ...INITIAL_STATE, jumpToken: current.jumpToken }));
  }, [abort, humanTimeline, roomId, token]);

  const openAnchor = useCallback(
    async (target: SearchNavigationTarget): Promise<boolean> => {
      const activeToken = tokenRef.current;
      if (!activeToken || target.room_id !== roomIdRef.current) return false;
      abort();
      const generation = generationRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      setState((current) => ({
        ...current,
        status: 'loading',
        roomId: target.room_id,
        target,
        activeMessageId: target.message_id,
        query: target.query,
        mode: target.mode,
        error: null,
        olderError: null,
      }));
      try {
        const page = await callTool<HistoryPage>(
          'network_history_list',
          historyArgs(target.room_id, humanRef.current, {
            anchor_message_id: target.message_id,
          }),
          { token: activeToken, signal: controller.signal },
        );
        if (
          generation !== generationRef.current ||
          target.room_id !== roomIdRef.current ||
          !mountedRef.current
        ) {
          return false;
        }
        const items = reverseChronological(page, humanRef.current);
        const found = items.some(
          (item) => item.kind !== 'presence' && item.message_id === target.message_id,
        );
        if (!found) {
          setState((current) => ({
            ...current,
            status: 'error',
            error: '消息当前不可见，请重新搜索',
          }));
          return false;
        }
        setState((current) => ({
          ...current,
          status: 'anchored',
          roomId: target.room_id,
          target,
          items,
          nextOlder: nextOlderCursor(page, humanRef.current),
          olderLoading: false,
          olderError: null,
          anchorWindow: page.anchor_window ?? null,
          activeMessageId: target.message_id,
          query: target.query,
          mode: target.mode,
          jumpToken: current.jumpToken + 1,
          error: null,
        }));
        return true;
      } catch (error) {
        if (generation !== generationRef.current || !mountedRef.current) return false;
        const message = failureText(error);
        setState((current) => ({
          ...current,
          status: 'error',
          error: message,
        }));
        return false;
      } finally {
        if (generation === generationRef.current) controllerRef.current = null;
      }
    },
    [abort],
  );

  const flashMessage = useCallback(
    (target: SearchNavigationTarget) => {
      abort();
      setState((current) => ({
        ...current,
        status: current.items.length > 0 ? 'anchored' : 'idle',
        roomId: target.room_id,
        target,
        activeMessageId: target.message_id,
        query: target.query,
        mode: target.mode,
        jumpToken: current.jumpToken + 1,
        error: null,
      }));
    },
    [abort],
  );

  const loadOlder = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== 'anchored' || !current.nextOlder || current.olderLoading) return;
    const activeToken = tokenRef.current;
    if (!activeToken) return;
    const cursor = current.nextOlder;
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((value) => ({ ...value, olderLoading: true, olderError: null }));
    try {
      const page = await callTool<HistoryPage>(
        'network_history_list',
        historyArgs(current.roomId ?? roomIdRef.current, humanRef.current, {
          direction: 'before',
          cursor,
        }),
        { token: activeToken, signal: controller.signal },
      );
      if (generation !== generationRef.current || !mountedRef.current) return;
      const incoming = reverseChronological(page, humanRef.current);
      setState((value) => ({
        ...value,
        items: mergeTimelineItems(value.items, incoming),
        nextOlder: nextOlderCursor(page, humanRef.current),
        olderLoading: false,
        olderError: null,
      }));
    } catch (error) {
      if (generation !== generationRef.current || !mountedRef.current) return;
      setState((value) => ({
        ...value,
        olderLoading: false,
        olderError: failureText(error),
      }));
    } finally {
      if (generation === generationRef.current) controllerRef.current = null;
    }
  }, []);

  return { state, openAnchor, flashMessage, loadOlder, clear };
}
