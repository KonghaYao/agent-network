import { useCallback, useEffect, useRef, useState } from 'react';

import { callTool, type McpError } from '../lib/mcp-client';
import { newRequestId } from '../lib/request-id';

export interface MonitorView {
  url: string;
  updated_at: string | null;
}

export interface RoomMonitorState {
  url: string | null;
  loaded: boolean;
  loading: boolean;
  busy: boolean;
  status: string;
  error: string | null;
  save: (url: string) => Promise<boolean>;
  clear: () => Promise<boolean>;
  refresh: () => Promise<void>;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return (error as McpError)?.message || String(error);
}

/**
 * 网页监控：只在面板打开时读取，不轮询；保存/清除都走幂等 request_id。
 *
 * URL 不写 localStorage，也不进入 console。关闭或切房由调用方卸载组件，
 * iframe 随之销毁。
 */
export function useRoomMonitor(
  roomId: string,
  token: string | null,
  enabled: boolean,
): RoomMonitorState {
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);

  const load = useCallback(
    async (options: { silent?: boolean; refresh?: boolean } = {}) => {
      if (!token) return;
      const captured = ++epoch.current;
      setLoading(true);
      if (!options.silent) setStatus('正在读取…');
      try {
        const result = await callTool<{ monitor: MonitorView | null }>(
          'network_room_monitor_get',
          { room_id: roomId },
          { token },
        );
        if (captured !== epoch.current) return;
        const next = safeUrl(result?.monitor?.url);
        setUrl(next);
        setLoaded(true);
        setError(null);
        setStatus(result?.monitor ? (options.refresh ? '已刷新。' : '') : '');
      } catch (failure) {
        if (captured !== epoch.current) return;
        const code = (failure as McpError).code;
        if (code === 'NOT_MEMBER' || code === 'NOT_FOUND') {
          setUrl(null);
          setLoaded(true);
        }
        setError(`读取网页地址失败：${message(failure)}`);
        setStatus('');
      } finally {
        if (captured === epoch.current) setLoading(false);
      }
    },
    [roomId, token],
  );

  useEffect(() => {
    if (!enabled || !token) return;
    void load();
    return () => {
      epoch.current += 1;
    };
  }, [enabled, load, token]);

  const commit = useCallback(
    async (next: string | null): Promise<boolean> => {
      if (!token || busy) return false;
      const captured = ++epoch.current;
      setBusy(true);
      setError(null);
      setStatus(next ? '正在保存…' : '正在清除…');
      try {
        const result = await callTool<{ monitor: MonitorView | null }>(
          'network_room_monitor_set',
          {
            request_id: newRequestId('monitor'),
            room_id: roomId,
            url: next,
          },
          { token },
        );
        if (captured !== epoch.current) return false;
        setUrl(safeUrl(result?.monitor?.url));
        setLoaded(true);
        setStatus(next ? '已保存' : '已清除。');
        return true;
      } catch (failure) {
        if (captured !== epoch.current) return false;
        setError(`${next ? '保存失败：' : '清除失败：'}${message(failure)}`);
        setStatus('');
        return false;
      } finally {
        if (captured === epoch.current) setBusy(false);
      }
    },
    [busy, roomId, token],
  );

  const save = useCallback(
    async (raw: string): Promise<boolean> => {
      const trimmed = raw.trim();
      if (!trimmed) return commit(null);
      const safe = safeUrl(trimmed);
      if (!safe) {
        setError('网址格式无效：只允许 http 或 https。');
        setStatus('');
        return false;
      }
      return commit(safe);
    },
    [commit],
  );

  const clear = useCallback(async () => commit(null), [commit]);
  const refresh = useCallback(async () => {
    await load({ refresh: true, silent: true });
  }, [load]);

  return { url, loaded, loading, busy, status, error, save, clear, refresh };
}
