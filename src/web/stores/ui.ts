import type { RoomFilter } from '../lib/rooms';

/** 会话筛选沿用 legacy 的 localStorage key；旧值 `direct` 迁移到好友。 */
const ROOM_FILTER_KEY = 'agent-network-room-filter';

export function readRoomFilter(): RoomFilter {
  try {
    const stored = localStorage.getItem(ROOM_FILTER_KEY);
    if (stored === 'agent' || stored === 'group') return stored;
    return 'friend';
  } catch {
    return 'friend';
  }
}

export function writeRoomFilter(value: RoomFilter): void {
  try {
    localStorage.setItem(ROOM_FILTER_KEY, value);
  } catch {
    // 隐私模式禁用存储时只影响记忆，不影响本次筛选。
  }
}
