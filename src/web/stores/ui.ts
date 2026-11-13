import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import type { RoomFilter } from '../lib/rooms';

/**
 * UI 偏好只放这里：筛选、布局比例等可丢弃状态。
 *
 * 服务端权威（房间、消息、联系人、身份）不进 zustand；它们由 React
 * Query 缓存并在失效时重读。token 也不进 store，避免被持久化到错误的
 * 位置；身份仍由 `lib/identity.ts` 的单例管理。
 */

const ROOM_FILTER_KEY = 'agent-network-room-filter';
const UI_PREF_KEY = 'agent-network-ui-v1';

interface RoomFilterState {
  filter: RoomFilter;
  setFilter: (value: RoomFilter) => void;
}

/**
 * 兼容 legacy：旧页面把筛选直接写成 `friend` / `agent` / `group` 字符串。
 * persist 需要 JSON，因此这里在存储边界做一层转换，读回仍是纯字符串。
 */
const legacyFilterStorage: StateStorage = {
  getItem: (name) => {
    try {
      const raw = localStorage.getItem(name);
      if (!raw) return null;
      if (raw.startsWith('{')) return raw;
      const filter = raw === 'agent' || raw === 'group' ? raw : 'friend';
      return JSON.stringify({ state: { filter }, version: 1 });
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      const parsed = JSON.parse(value) as { state?: { filter?: unknown } };
      const filter = parsed.state?.filter;
      localStorage.setItem(
        name,
        filter === 'agent' || filter === 'group' ? filter : 'friend',
      );
    } catch {
      // 隐私模式：本次会话仍可用，只是不记忆。
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      // 同上。
    }
  },
};

export const useRoomFilterStore = create<RoomFilterState>()(
  persist(
    (set) => ({
      filter: 'friend',
      setFilter: (filter) => set({ filter }),
    }),
    {
      name: ROOM_FILTER_KEY,
      version: 1,
      storage: createJSONStorage(() => legacyFilterStorage),
      partialize: (state) => ({ filter: state.filter }),
    },
  ),
);

interface UiPrefState {
  /** `react-resizable-panels` 的桌面布局（panel id → 百分比）。 */
  homeLayout: Record<string, number> | null;
  setHomeLayout: (layout: Record<string, number>) => void;
}

export const useUiPrefStore = create<UiPrefState>()(
  persist(
    (set) => ({
      homeLayout: null,
      setHomeLayout: (homeLayout) => set({ homeLayout }),
    }),
    {
      name: UI_PREF_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ homeLayout: state.homeLayout }),
    },
  ),
);

/** 同步读：首次渲染与 legacy 页面共享同一个 key。 */
export function readRoomFilter(): RoomFilter {
  return useRoomFilterStore.getState().filter;
}

export function writeRoomFilter(value: RoomFilter): void {
  useRoomFilterStore.getState().setFilter(value);
}
