/**
 * 标签页未读提示单测：不依赖服务端与浏览器，只验证计数口径、标题文案、
 * favicon 文案与免打扰排除。
 *
 * 运行：bun scripts/verify-tab-badge.ts
 */

import { BASE_FAVICON_HREF } from '../src/web/lib/favicon';
import type { RoomPreferenceMap } from '../src/web/lib/room-preferences';
import type { RoomSummary } from '../src/web/lib/rooms';
import {
  acknowledgeRooms,
  badgeCount,
  badgeLabel,
  badgeRooms,
  titleWithBadge,
} from '../src/web/lib/tab-badge';
import { check, checkEqual, checksPassed } from './lib/harness';

function room(overrides: Partial<RoomSummary> & { room_id: string }): RoomSummary {
  return {
    kind: 'direct',
    name: overrides.room_id,
    peer_kind: 'human',
    peer_actor_id: null,
    peer_online: null,
    head_seq: '0',
    my_last_read_seq: '0',
    last_message: null,
    updated_at: '0',
    read_only: false,
    peer_archived: false,
    ...overrides,
  };
}

function muted(...roomIds: string[]): RoomPreferenceMap {
  return Object.fromEntries(roomIds.map((roomId) => [roomId, { pinned: false, muted: true }]));
}

function verifyLabels(): void {
  const cases: [number, string][] = [
    [Number.NaN, ''],
    [-3, ''],
    [0, ''],
    [0.9, ''],
    [1, '1'],
    [2.7, '2'],
    [9, '9'],
    [10, '9+'],
    [999, '9+'],
  ];
  for (const [count, expected] of cases) {
    checkEqual(`favicon 文案 ${count}`, badgeLabel(count), expected);
  }
}

function verifyTitles(): void {
  checkEqual('无未读恢复原标题', titleWithBadge('WeBots', 0), 'WeBots');
  checkEqual('一个未读会话', titleWithBadge('WeBots', 1), '(1) WeBots');
  checkEqual('多个未读会话', titleWithBadge('WeBots', 3), '(3) WeBots');
  checkEqual('超过上限折叠', titleWithBadge('会话 · WeBots', 12), '(9+) 会话 · WeBots');
}

function verifyCounts(): void {
  const rooms = [
    room({ room_id: 'rm_unread', head_seq: '5', my_last_read_seq: '4' }),
    room({ room_id: 'rm_read', head_seq: '5', my_last_read_seq: '5' }),
    room({ room_id: 'rm_muted', head_seq: '9', my_last_read_seq: '1' }),
    room({ room_id: 'rm_archived', head_seq: '4', my_last_read_seq: '0', peer_archived: true }),
    room({ room_id: 'rm_readonly', head_seq: '4', my_last_read_seq: '0', read_only: true }),
  ];
  const preferences = muted('rm_muted');

  checkEqual(
    '只统计需要提醒的未读会话',
    badgeCount(rooms, preferences),
    1,
  );
  checkEqual(
    '未读会话 id',
    badgeRooms(rooms, preferences).map((entry) => entry.room_id).join(','),
    'rm_unread',
  );
  checkEqual(
    '同一会话多条消息仍只算一个会话',
    badgeCount([
      room({ room_id: 'rm_many', head_seq: '100', my_last_read_seq: '0' }),
      room({ room_id: 'rm_many_next', head_seq: '8', my_last_read_seq: '7' }),
    ], {}),
    2,
  );
  checkEqual(
    '免打扰会话不计入',
    badgeCount([room({ room_id: 'rm_muted', head_seq: '3', my_last_read_seq: '0' })], muted('rm_muted')),
    0,
  );
  checkEqual(
    '免打扰只排除自身',
    badgeCount(
      [
        room({ room_id: 'rm_muted', head_seq: '3', my_last_read_seq: '0' }),
        room({ room_id: 'rm_loud', head_seq: '3', my_last_read_seq: '0' }),
      ],
      muted('rm_muted'),
    ),
    1,
  );
}

function verifyFloors(): void {
  const rooms = [
    room({ room_id: 'rm_a', head_seq: '5', my_last_read_seq: '0' }),
    room({ room_id: 'rm_b', head_seq: '2', my_last_read_seq: '0' }),
  ];
  const seen = acknowledgeRooms(rooms, {});
  checkEqual('聚焦后水位覆盖未读', badgeCount(rooms, {}, seen), 0);
  checkEqual('水位记录每个房间 head_seq', `${seen.rm_a}/${seen.rm_b}`, '5/2');
  checkEqual('无变化时返回同一引用', acknowledgeRooms(rooms, seen), seen);

  const arrived = [
    room({ room_id: 'rm_a', head_seq: '6', my_last_read_seq: '0' }),
    room({ room_id: 'rm_b', head_seq: '2', my_last_read_seq: '0' }),
  ];
  checkEqual('聚焦后新消息重新提示', badgeCount(arrived, {}, seen), 1);
  checkEqual(
    '新消息房间 id',
    badgeRooms(arrived, {}, seen).map((entry) => entry.room_id).join(','),
    'rm_a',
  );
  checkEqual('水位只增不减', acknowledgeRooms(rooms, seen), seen);
}

function verifyFaviconSource(): void {
  check('基础图标是内联 data URI', BASE_FAVICON_HREF.startsWith('data:image/svg+xml;charset=utf-8,'));
  check('基础图标不请求外部服务', !BASE_FAVICON_HREF.includes('http://') && !BASE_FAVICON_HREF.includes('https://'));
  checkEqual('favicon 与标题共用同一文案', badgeLabel(10), '9+');
}

function main(): void {
  console.log('标签页未读提示单测');
  verifyLabels();
  verifyTitles();
  verifyCounts();
  verifyFloors();
  verifyFaviconSource();
  console.log(`\n标签页未读提示单测通过 ${checksPassed()} 项`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
