import { QueryClient } from '@tanstack/react-query';

/**
 * 服务端状态缓存。
 *
 * 所有数据仍以 MCP 工具结果为准：查询只读取，写入走 mutation 后
 * invalidate；SSE 只触发失效，不把通知正文塞进缓存。当前页面只有一
 * 个 React 根，因此共享一个客户端；退出登录时整个清空。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 工具错误（凭据失效、权限、参数）重试不会改变结果；断线恢复由
      // SSE 重新订阅后的失效触发，不在查询层退避。
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
    mutations: {
      retry: false,
    },
  },
});

/** 退出登录/切换身份：丢弃上一个 actor 的缓存。 */
export function clearQueryCache(): void {
  queryClient.clear();
}
