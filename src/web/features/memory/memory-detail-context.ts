import { createContext, useContext } from 'react';

/**
 * 详情层向外壳登记自己的开合状态。
 *
 * Lenso 外壳的 Esc 门控必须依赖状态，不能等事件传播到 document 后再
 * `querySelector`：Radix 详情可能在 capture 阶段就卸载，查询会把一次 Esc
 * 误判成“父层无详情”并同时关闭父抽屉。登记与详情提交同步完成，外壳据此
 * 决定本次 Esc 交给详情还是自己。
 */
export interface MemoryDetailBinding {
  setDetailOpen: (open: boolean, close?: (() => void) | null) => void;
}

export const MemoryDetailContext = createContext<MemoryDetailBinding | null>(null);

export function useMemoryDetailBinding(): MemoryDetailBinding | null {
  return useContext(MemoryDetailContext);
}
