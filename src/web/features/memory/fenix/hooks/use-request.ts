/**
 * Local replacement for the subset of `ahooks` `useRequest` used by the vendored
 * memory UI (auto/manual/ready/refreshDeps/refresh/error). Not ported from upstream:
 * ahooks is intentionally not added as a dependency.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseRequestOptions {
  manual?: boolean;
  ready?: boolean;
  refreshDeps?: readonly unknown[];
  onError?: (error: Error) => void;
}

export interface UseRequestResult<T, P extends unknown[]> {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
  run: (...args: P) => Promise<T | undefined>;
  refresh: () => void;
}

export function useRequest<T, P extends unknown[] = []>(
  service: (...args: P) => Promise<T>,
  options: UseRequestOptions = {},
): UseRequestResult<T, P> {
  const { manual = false, ready = true, refreshDeps = [] } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(!manual && ready);
  const [error, setError] = useState<Error | undefined>(undefined);

  const serviceRef = useRef(service);
  const onErrorRef = useRef(options.onError);
  const argsRef = useRef<P>([] as unknown as P);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  serviceRef.current = service;
  onErrorRef.current = options.onError;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async (...args: P): Promise<T | undefined> => {
    argsRef.current = args;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    try {
      const result = await serviceRef.current(...args);
      if (!mountedRef.current || requestId !== requestIdRef.current) return undefined;
      setData(result);
      setError(undefined);
      return result;
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return undefined;
      const normalized = caught instanceof Error ? caught : new Error(String(caught));
      setError(normalized);
      onErrorRef.current?.(normalized);
      return undefined;
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void run(...argsRef.current);
  }, [run]);

  useEffect(() => {
    if (manual || !ready) return undefined;
    // Defer the auto-run to a microtask and cancel it in cleanup. React StrictMode
    // replays mount effects (setup -> cleanup -> setup) synchronously, so without
    // this guard one user action issues two identical requests in development.
    // Manual `run`/`refresh` stay synchronous (event handlers are not replayed).
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void run(...([] as unknown as P));
    });
    return () => {
      cancelled = true;
    };
    // `refreshDeps` is the upstream contract for re-running; the service identity
    // changes every render and must not be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manual, ready, ...refreshDeps]);

  return { data, loading, error, run, refresh };
}
