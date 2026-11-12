/**
 * 0043 群历史默认 full 回填迁移。
 *
 * 用真实 migrations 目录构造 0042 旧库，验证：
 * - 存量 group 从 from_join 回填为 full，policy_revision 递增；
 * - 已是 full 的群与 direct 房间策略、版本保持不变；
 * - 回填不修改 updated_at，重复迁移不产生变更。
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrate } from '../../src/bun/migrate';
import { check, checkEqual } from './harness';

const MIGRATIONS = join(import.meta.dir, '../../migrations');
const BACKFILL = '0043_group_history_full_backfill.sql';

interface RoomPolicyRow {
  room_id: string;
  member_history_policy: string;
  policy_revision: number;
  updated_at: number;
}

export function runGroupHistoryMigrationUnitChecks(): void {
  const dir = mkdtempSync(join(tmpdir(), 'agent-network-gh-'));
  const db = new Database(':memory:');
  try {
    for (const name of readdirSync(MIGRATIONS).filter(
      (entry) => entry.endsWith('.sql') && entry < BACKFILL,
    )) {
      copyFileSync(join(MIGRATIONS, name), join(dir, name));
    }
    migrate(db, dir);
    db.exec(`
      INSERT INTO rooms
        (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
         member_seq, last_message_id, member_history_policy, policy_revision,
         created_at, updated_at)
      VALUES
        ('rm_gh_group_join', 'group', 'usr_gh_owner', '回填群', NULL, 0, 0, 0,
         NULL, 'from_join', 3, 1000, 2000),
        ('rm_gh_group_full', 'group', 'usr_gh_owner', '已全历史群', NULL, 0, 0, 0,
         NULL, 'full', 1, 1000, 2000),
        ('rm_gh_direct', 'direct', NULL, '', 'usr_gh_a|usr_gh_b', 0, 0, 0,
         NULL, 'from_join', 7, 1000, 2000);
    `);

    copyFileSync(join(MIGRATIONS, BACKFILL), join(dir, BACKFILL));
    checkEqual('0043 迁移应用一次', migrate(db, dir).join(','), BACKFILL);

    const rows = db
      .prepare(
        `SELECT room_id, member_history_policy, policy_revision, updated_at
           FROM rooms ORDER BY room_id`,
      )
      .all() as RoomPolicyRow[];
    const byId = new Map(rows.map((row) => [row.room_id, row]));
    const backfilled = byId.get('rm_gh_group_join');
    const alreadyFull = byId.get('rm_gh_group_full');
    const direct = byId.get('rm_gh_direct');

    checkEqual('存量群回填为 full', backfilled?.member_history_policy, 'full');
    checkEqual('存量群策略版本递增', backfilled?.policy_revision, 4);
    checkEqual('回填不修改 updated_at', backfilled?.updated_at, 2000);
    checkEqual('已 full 的群策略不变', alreadyFull?.member_history_policy, 'full');
    checkEqual('已 full 的群版本不变', alreadyFull?.policy_revision, 1);
    checkEqual('direct 房间策略不变', direct?.member_history_policy, 'from_join');
    checkEqual('direct 房间版本不变', direct?.policy_revision, 7);
    checkEqual('direct 房间 updated_at 不变', direct?.updated_at, 2000);
    checkEqual('二次迁移无变更', migrate(db, dir).length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
