import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { createFreshIdentity } from '../../lib/identity';
import { queryKeys } from '../../lib/query-keys';

/**
 * 退出后的恢复入口：显式点击才会清除退出标记并注册新身份。
 *
 * `createFreshIdentity` 自身 single-flight，连续点击最多注册一次；失败时
 * 保留退出标记与重试按钮，成功后把 session 写回查询缓存，侧栏随即恢复。
 */
export function LoggedOutStart() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await createFreshIdentity();
      queryClient.setQueryData(queryKeys.session(), session);
    } catch (failure) {
      const message = (failure as Error).message || '创建身份失败';
      setError(`创建身份失败：${message}。请重试。`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        id="logged-out-start"
        className="list-retry"
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          void start();
        }}
      >
        {busy ? '正在创建新身份…' : '创建新身份并继续'}
      </button>
      {error ? (
        <p id="logged-out-error" className="logged-out-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
