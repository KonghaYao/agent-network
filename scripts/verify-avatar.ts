/**
 * 头像后端专项验收。
 *
 * 1. 进程内：真实 migrations + Drizzle 兼容 D1，验证迁移列、写入校验、
 *    旧头像释放与维护任务（GC）保留。
 * 2. 服务端：默认 http://127.0.0.1:8792（AGENTNET_URL 可覆盖），验证上传→
 *    设置→各读面 avatar_url→替换/清除→拒绝非本人、SVG、HTML 文件。
 *
 * 运行：bun run test:avatar
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { BusinessError } from '../src/contracts/errors';
import { getActor } from '../src/storage/queries';
import type { Principal } from '../src/domain/principal';
import { updateProfile } from '../src/domain/identity';
import { maintain } from '../src/maintenance';
import type { Env } from '../src/env';
import {
  baseUrl,
  callTool,
  check,
  checkEqual,
  checksPassed,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
} from './lib/harness';

const MIGRATIONS = resolve(import.meta.dir, '../migrations');
const PNG_1X1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  ),
  (char) => char.charCodeAt(0),
);

interface DriveSeed {
  fileId: string;
  ownerId: string;
  mimeType?: string;
  expiryOffsetMs?: number;
  visibility?: 'public' | 'private';
  state?: 'draft' | 'bound' | 'deleted';
  roomId?: string | null;
  retained?: number;
}

function seedDrive(db: D1Database, seed: DriveSeed): void {
  const now = Date.now();
  const expiry = now + (seed.expiryOffsetMs ?? 24 * 60 * 60_000);
  db.prepare(
    `INSERT INTO drive_files
       (file_id, owner_scope, uploader_id, name, mime_type, size, sha256, state,
        visibility, room_id, created_at, expires_at, retained, deleted_at, deleted_by, purged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  )
    .bind(
      seed.fileId,
      `actor:${seed.ownerId}`,
      seed.ownerId,
      'avatar.png',
      seed.mimeType ?? 'image/png',
      PNG_1X1.byteLength,
      'a'.repeat(64),
      seed.state ?? 'draft',
      seed.visibility ?? 'public',
      seed.roomId ?? null,
      now - 60_000,
      expiry,
      seed.retained ?? 0,
    )
    .run();
}

async function avatarDbChecks(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agentnet-avatar-'));
  const dbPath = join(root, 'avatar.sqlite');
  const sqlite = new Database(dbPath, { create: true });
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(sqlite, MIGRATIONS);
  const db = createD1(sqlite);
  const now = Date.now();
  try {
    const columns = sqlite.prepare('PRAGMA table_info(actors)').all() as Array<{ name: string }>;
    check('迁移包含 actors.avatar_file_id', columns.some((column) => column.name === 'avatar_file_id'));

    for (const [actorId, name] of [
      ['usr_avatar_a', 'Avatar A'],
      ['usr_avatar_b', 'Avatar B'],
    ] as const) {
      db.prepare(
        `INSERT INTO actors
           (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
            pending_count, created_at, updated_at)
         VALUES (?, 'human', NULL, ?, '{}', 0, 0, 0, ?, ?)`,
      )
        .bind(actorId, name, now, now)
        .run();
    }

    const actor = await getActor(db, 'usr_avatar_a');
    if (!actor) throw new Error('seed actor missing');
    const principal: Principal = { credentialHash: 'probe', actor, credential: null };

    seedDrive(db, { fileId: 'f_avatar_0000000000000001', ownerId: 'usr_avatar_a' });
    seedDrive(db, { fileId: 'f_avatar_0000000000000002', ownerId: 'usr_avatar_a' });
    seedDrive(db, { fileId: 'f_avatar_0000000000000003', ownerId: 'usr_avatar_b' });
    seedDrive(db, {
      fileId: 'f_avatar_0000000000000004',
      ownerId: 'usr_avatar_a',
      mimeType: 'image/svg+xml',
    });
    seedDrive(db, {
      fileId: 'f_avatar_0000000000000005',
      ownerId: 'usr_avatar_a',
      expiryOffsetMs: -60_000,
    });
    seedDrive(db, {
      fileId: 'f_avatar_0000000000000006',
      ownerId: 'usr_avatar_a',
      visibility: 'private',
    });

    const reject = async (label: string, fileId: string): Promise<void> => {
      try {
        await updateProfile(
          db,
          principal,
          { request_id: newRequestId('avatar_reject'), avatar_file_id: fileId },
          'https://example.test',
        );
      } catch (error) {
        checkEqual(
          label,
          error instanceof BusinessError ? error.code : String(error),
          'INVALID_ARGUMENT',
        );
        return;
      }
      throw new Error(`${label} 未拒绝`);
    };

    await reject('拒绝其他身份上传的文件', 'f_avatar_0000000000000003');
    await reject('拒绝 SVG 头像', 'f_avatar_0000000000000004');
    await reject('拒绝已过期文件', 'f_avatar_0000000000000005');
    await reject('拒绝未公开文件', 'f_avatar_0000000000000006');
    await reject('拒绝不存在的文件', 'f_avatar_0000000000000009');

    const first = await updateProfile(
      db,
      principal,
      { request_id: newRequestId('avatar_set'), avatar_file_id: 'f_avatar_0000000000000001' },
      'https://example.test',
    );
    checkEqual('设置头像返回同源路径', first.avatar_url, '/f/f_avatar_0000000000000001');
    const retained = (await getActor(db, 'usr_avatar_a'))?.avatar_file_id;
    checkEqual('actors.avatar_file_id 已写入', retained, 'f_avatar_0000000000000001');
    checkEqual(
      '头像文件被保留（retained=1 且无过期时间）',
      JSON.stringify(
        sqlite
          .prepare('SELECT retained, expires_at FROM drive_files WHERE file_id = ?')
          .get('f_avatar_0000000000000001'),
      ),
      JSON.stringify({ retained: 1, expires_at: null }),
    );

    const second = await updateProfile(
      db,
      principal,
      { request_id: newRequestId('avatar_replace'), avatar_file_id: 'f_avatar_0000000000000002' },
      'https://example.test',
    );
    checkEqual('替换头像返回新路径', second.avatar_url, '/f/f_avatar_0000000000000002');
    const old = sqlite
      .prepare('SELECT retained, expires_at FROM drive_files WHERE file_id = ?')
      .get('f_avatar_0000000000000001') as { retained: number; expires_at: number | null };
    check('旧头像解除保留', old.retained === 0);
    check('旧头像获得普通 TTL', typeof old.expires_at === 'number' && old.expires_at > now);

    // 让旧文件立即到期；维护任务应软删未再被引用的旧头像。
    sqlite
      .prepare('UPDATE drive_files SET expires_at = ? WHERE file_id = ?')
      .run(now - 1_000, 'f_avatar_0000000000000001');
    await maintain({ DB: db } as unknown as Env);
    checkEqual(
      '旧头像可被 GC 软删',
      (
        sqlite.prepare('SELECT state FROM drive_files WHERE file_id = ?').get(
          'f_avatar_0000000000000001',
        ) as { state: string }
      ).state,
      'deleted',
    );

    // 当前头像即使 TTL 过去也不能被回收。
    sqlite
      .prepare('UPDATE drive_files SET expires_at = ?, retained = 1 WHERE file_id = ?')
      .run(now - 1_000, 'f_avatar_0000000000000002');
    await maintain({ DB: db } as unknown as Env);
    checkEqual(
      '当前头像不被维护任务软删',
      JSON.stringify(
        sqlite
          .prepare('SELECT state, retained FROM drive_files WHERE file_id = ?')
          .get('f_avatar_0000000000000002'),
      ),
      JSON.stringify({ state: 'draft', retained: 1 }),
    );

    const cleared = await updateProfile(
      db,
      principal,
      { request_id: newRequestId('avatar_clear'), avatar_file_id: null },
      'https://example.test',
    );
    checkEqual('清除头像返回 null', cleared.avatar_url, null);
    checkEqual(
      '清除后旧头像解除保留',
      (
        sqlite.prepare('SELECT retained FROM drive_files WHERE file_id = ?').get(
          'f_avatar_0000000000000002',
        ) as { retained: number }
      ).retained,
      0,
    );

    const named = await updateProfile(
      db,
      principal,
      { request_id: newRequestId('avatar_name'), name: 'Avatar A2' },
      'https://example.test',
    );
    checkEqual('既有改名行为不变', named.name, 'Avatar A2');

    // 同一 request_id 重放不得再写一次；不同 payload 必须冲突。
    try {
      await updateProfile(
        db,
        principal,
        { request_id: 'avatar_idem', avatar_file_id: 'f_avatar_0000000000000002' },
        'https://example.test',
      );
      await updateProfile(
        db,
        principal,
        { request_id: 'avatar_idem', avatar_file_id: null },
        'https://example.test',
      );
      throw new Error('幂等冲突未触发');
    } catch (error) {
      checkEqual(
        '同一 request_id 改头像 payload 返回 IDEMPOTENCY_CONFLICT',
        error instanceof BusinessError ? error.code : String(error),
        'IDEMPOTENCY_CONFLICT',
      );
    }
  } finally {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
}

interface UploadResponse {
  fileId: string;
  publicUrl: string;
}

async function upload(
  token: string,
  name: string,
  mimeType: string,
  body: Uint8Array,
): Promise<UploadResponse> {
  const response = await fetch(`${baseUrl()}/mcp-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'MCPP-Files-Version': '1',
      'content-type': mimeType,
      'MCPP-File-Name': name,
      'MCPP-File-Size': String(body.byteLength),
    },
    body: body as unknown as BodyInit,
  });
  checkEqual(`上传 ${name} 返回 201`, response.status, 201);
  return (await response.json()) as UploadResponse;
}

interface Identity {
  actor_id: string;
  name: string;
  avatar_url: string | null;
}

interface ContactPage {
  items: { actor_id: string; avatar_url: string | null }[];
}

interface SearchPage {
  items: { actor: { actor_id: string; avatar_url: string | null } }[];
}

interface RoomDetail {
  room: { room_id: string; kind: string };
  members: { actor_id: string; avatar_url: string | null }[];
  peer?: { actor_id: string; avatar_url: string | null } | null;
}

interface RoomPage {
  items: { room_id: string; peer?: { actor_id: string; avatar_url: string | null } | null }[];
}

async function liveChecks(): Promise<void> {
  const tokenA = newToken();
  const tokenB = newToken();
  const a = await connectClient(tokenA);
  const b = await connectClient(tokenB);
  try {
    const identityA = await callTool<Identity>(a.client, 'network_register', {
      request_id: newRequestId('avatar_reg_a'),
      kind: 'human',
      name: `Avatar Probe A ${crypto.randomUUID().slice(0, 8)}`,
    });
    const identityB = await callTool<Identity>(b.client, 'network_register', {
      request_id: newRequestId('avatar_reg_b'),
      kind: 'human',
      name: `Avatar Probe B ${crypto.randomUUID().slice(0, 8)}`,
    });
    checkEqual('新注册无头像', identityA.avatar_url, null);

    const avatarA = await upload(tokenA, 'a.png', 'image/png', PNG_1X1);
    const avatarA2 = await upload(tokenA, 'a2.png', 'image/png', PNG_1X1);
    const avatarB = await upload(tokenB, 'b.png', 'image/png', PNG_1X1);
    const svg = await upload(
      tokenA,
      'a.svg',
      'image/svg+xml',
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    );
    const html = await upload(
      tokenA,
      'a.html',
      'text/html',
      new TextEncoder().encode('<!doctype html><title>x</title>'),
    );

    await expectToolError(
      '拒绝其他身份的文件',
      callTool(a.client, 'network_profile_update', {
        request_id: newRequestId('avatar_other'),
        avatar_file_id: avatarB.fileId,
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      '拒绝 SVG',
      callTool(a.client, 'network_profile_update', {
        request_id: newRequestId('avatar_svg'),
        avatar_file_id: svg.fileId,
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      '拒绝 HTML',
      callTool(a.client, 'network_profile_update', {
        request_id: newRequestId('avatar_html'),
        avatar_file_id: html.fileId,
      }),
      'INVALID_ARGUMENT',
    );

    const setA = await callTool<Identity>(a.client, 'network_profile_update', {
      request_id: newRequestId('avatar_set_a'),
      avatar_file_id: avatarA.fileId,
    });
    checkEqual('设置头像返回同源路径', setA.avatar_url, `/f/${avatarA.fileId}`);
    const meA = await callTool<Identity>(a.client, 'network_me', {});
    checkEqual('network_me 返回头像', meA.avatar_url, `/f/${avatarA.fileId}`);

    const setB = await callTool<Identity>(b.client, 'network_profile_update', {
      request_id: newRequestId('avatar_set_b'),
      avatar_file_id: avatarB.fileId,
    });
    checkEqual('B 头像设置成功', setB.avatar_url, `/f/${avatarB.fileId}`);

    // 好友关系 + direct 房间。
    const request = await callTool<{ request: { contact_request_id: string } }>(
      a.client,
      'network_contact_request',
      {
        request_id: newRequestId('avatar_friend'),
        actor_id: identityB.actor_id,
        message: 'avatar probe friend',
      },
    );
    await callTool(b.client, 'network_contact_request_respond', {
      request_id: newRequestId('avatar_accept'),
      contact_request_id: request.request.contact_request_id,
      action: 'accept',
    });
    const contacts = await callTool<ContactPage>(b.client, 'network_contacts_list', {});
    checkEqual(
      '好友列表返回头像',
      contacts.items.find((item) => item.actor_id === identityA.actor_id)?.avatar_url,
      `/f/${avatarA.fileId}`,
    );
    const search = await callTool<SearchPage>(b.client, 'network_contact_search', {
      query: identityA.name,
      limit: 10,
    });
    checkEqual(
      '联系人搜索返回头像',
      search.items.find((item) => item.actor.actor_id === identityA.actor_id)?.actor.avatar_url,
      `/f/${avatarA.fileId}`,
    );

    const rooms = await callTool<RoomPage>(b.client, 'network_rooms_list', { limit: 50 });
    const direct = rooms.items.find((item) => item.peer?.actor_id === identityA.actor_id);
    check('rooms_list direct 对端返回头像', Boolean(direct));
    checkEqual('rooms_list direct 对端头像地址', direct?.peer?.avatar_url, `/f/${avatarA.fileId}`);
    const directDetail = await callTool<RoomDetail>(b.client, 'network_room_get', {
      room_id: direct!.room_id,
    });
    checkEqual(
      'room_get 成员返回头像',
      directDetail.members.find((member) => member.actor_id === identityA.actor_id)?.avatar_url,
      `/f/${avatarA.fileId}`,
    );

    const group = await callTool<RoomDetail & { results?: { actor_id: string; avatar_url: string | null }[] }>(
      a.client,
      'network_room_create',
      {
        request_id: newRequestId('avatar_group'),
        kind: 'group',
        members: [identityB.actor_id],
        title: 'Avatar Probe Group',
      },
    );
    checkEqual(
      '建群结果返回头像',
      group.results?.find((item) => item.actor_id === identityB.actor_id)?.avatar_url,
      `/f/${avatarB.fileId}`,
    );
    const groupDetail = await callTool<RoomDetail>(a.client, 'network_room_get', {
      room_id: group.room.room_id,
    });
    checkEqual(
      '群成员列表返回头像',
      groupDetail.members.find((member) => member.actor_id === identityB.actor_id)?.avatar_url,
      `/f/${avatarB.fileId}`,
    );

    const sent = await callTool<{ message: { message_id: string } }>(
      b.client,
      'network_message_send',
      {
        request_id: newRequestId('avatar_msg'),
        client_message_id: `avatar_probe_${crypto.randomUUID()}`,
        room_id: direct!.room_id,
        body: 'avatar-probe-history-token',
      },
    );
    check('发送探测消息', Boolean(sent.message.message_id));
    const history = await callTool<{
      items: { sender_id: string; sender_avatar_url: string | null }[];
    }>(a.client, 'network_history_list', { room_id: direct!.room_id, limit: 20 });
    checkEqual(
      '历史 sender 返回头像',
      history.items.find((item) => item.sender_id === identityB.actor_id)?.sender_avatar_url,
      `/f/${avatarB.fileId}`,
    );
    const found = await callTool<{
      items: { sender_id: string; sender_avatar_url: string | null }[];
    }>(a.client, 'network_message_search', {
      room_id: direct!.room_id,
      query: 'avatar-probe-history-token',
      limit: 10,
    });
    checkEqual(
      '消息搜索 sender 返回头像',
      found.items.find((item) => item.sender_id === identityB.actor_id)?.sender_avatar_url,
      `/f/${avatarB.fileId}`,
    );

    // 替换后旧文件解除保留；仍可被公开读取，但不再是 retained。
    await callTool<Identity>(a.client, 'network_profile_update', {
      request_id: newRequestId('avatar_replace_a'),
      avatar_file_id: avatarA2.fileId,
    });
    const oldInfo = await callTool<{ retained: boolean }>(a.client, 'drive_file_info', {
      fileId: avatarA.fileId,
    });
    checkEqual('替换后旧头像不再 retained', oldInfo.retained, false);
    const replaced = await callTool<Identity>(a.client, 'network_me', {});
    checkEqual('替换后 me 返回新头像', replaced.avatar_url, `/f/${avatarA2.fileId}`);

    const cleared = await callTool<Identity>(a.client, 'network_profile_update', {
      request_id: newRequestId('avatar_clear_a'),
      avatar_file_id: null,
    });
    checkEqual('清除头像', cleared.avatar_url, null);

    // Agent 自己的 login 也返回头像。
    const tokenAgent = newToken();
    const agent = await connectClient(tokenAgent);
    try {
      await callTool(agent.client, 'network_register', {
        request_id: newRequestId('avatar_reg_agent'),
        kind: 'agent',
        agent_session_id: `sess_avatar_${crypto.randomUUID().replaceAll('-', '')}`,
        name: `Avatar Agent ${crypto.randomUUID().slice(0, 8)}`,
      });
      const agentAvatar = await upload(tokenAgent, 'agent.png', 'image/png', PNG_1X1);
      await callTool(agent.client, 'network_profile_update', {
        request_id: newRequestId('avatar_set_agent'),
        avatar_file_id: agentAvatar.fileId,
      });
      const login = await callTool<{ avatar_url: string | null }>(agent.client, 'network_login', {});
      checkEqual('login 返回头像', login.avatar_url, `/f/${agentAvatar.fileId}`);
    } finally {
      await agent.close();
    }
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
}

async function main(): Promise<void> {
  await avatarDbChecks();
  await liveChecks();
  console.log(`\nAvatar checks passed: ${checksPassed()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
