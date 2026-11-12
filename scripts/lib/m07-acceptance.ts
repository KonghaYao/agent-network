/**
 * M07 私有文件授权与公开发布的端到端片段（M07-T01 / M07-T02）。
 *
 * 只覆盖真实 HTTP 与成员资格：裸 `/f`、Range、HEAD、票据、移除成员后的撤权，
 * 以及公开发布必须有权限。过期/配额/GC 竞争需要操纵时间与维护任务，由
 * `scripts/verify-m07.ts` 在同一进程内用真实 migrations 覆盖。
 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  uploadTestFile,
  type McpConnection,
  type UploadedTestFile,
} from './harness';
import { acceptGroupInvites, befriend, registerIdentity, type RoomDetail } from './acceptance-helpers';

interface RoomFileView {
  room_file_id: string;
  file_id: string;
  public_url: string;
  preview_url: string;
  download_url: string;
  retained: boolean;
}

async function statusOf(url: string, init?: RequestInit): Promise<number> {
  return (await fetch(url, init)).status;
}

function createFile(
  connection: McpConnection,
  name: string,
  body: string | Uint8Array,
  mimeType = 'text/plain',
): Promise<UploadedTestFile> {
  return uploadTestFile(connection.token, { name, mimeType, body });
}

function bind(
  connection: McpConnection,
  roomId: string,
  fileId: string,
): Promise<{ file: RoomFileView }> {
  return callTool(connection.client, 'network_room_file_bind', {
    request_id: newRequestId('bind'),
    room_id: roomId,
    file_id: fileId,
  });
}

function roomFile(
  connection: McpConnection,
  roomId: string,
  fileId: string,
): Promise<{ file: RoomFileView }> {
  return callTool(connection.client, 'network_room_file_get', {
    room_id: roomId,
    file_id: fileId,
  });
}

/** 1×1 PNG：用于确认私有票据与公开发布都保持光栅图片内联预览。 */
const PNG_BYTES = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZc9WQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);

export async function runPrivateFileAcceptance(): Promise<void> {
  const ownerConn = await connectClient(newToken());
  const memberConn = await connectClient(newToken());
  const otherConn = await connectClient(newToken());
  const strangerConn = await connectClient(newToken());

  try {
    await registerIdentity(ownerConn, {
      kind: 'agent',
      name: 'M07 Owner',
      sessionId: `m07_owner_${crypto.randomUUID()}`,
    });
    await registerIdentity(memberConn, {
      kind: 'agent',
      name: 'M07 Member',
      sessionId: `m07_member_${crypto.randomUUID()}`,
    });
    await registerIdentity(otherConn, {
      kind: 'agent',
      name: 'M07 Other',
      sessionId: `m07_other_${crypto.randomUUID()}`,
    });
    await registerIdentity(strangerConn, {
      kind: 'agent',
      name: 'M07 Stranger',
      sessionId: `m07_stranger_${crypto.randomUUID()}`,
    });

    const ownerId = (await callTool<{ actor_id: string }>(ownerConn.client, 'network_me'))
      .actor_id;
    const memberId = (await callTool<{ actor_id: string }>(memberConn.client, 'network_me'))
      .actor_id;
    const otherId = (await callTool<{ actor_id: string }>(otherConn.client, 'network_me'))
      .actor_id;

    await befriend(ownerConn, ownerId, memberConn, memberId);
    await befriend(ownerConn, ownerId, otherConn, otherId);
    const room = await callTool<RoomDetail>(ownerConn.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'group',
      members: [memberId, otherId],
      title: 'M07 私有文件群',
    });
    const roomId = room.room.room_id;
    await acceptGroupInvites(memberConn, roomId);
    await acceptGroupInvites(otherConn, roomId);

    const uploaded = await createFile(ownerConn, 'm07-secret.txt', 'm07 secret bytes');
    checkEqual('[M07-T01] 上传默认可见性为 public', uploaded.visibility, 'public');
    checkEqual('[M07-T01] 默认公开的裸 publicUrl 可读', await statusOf(uploaded.publicUrl), 200);
    const bound = await bind(ownerConn, roomId, uploaded.fileId);
    // 显式撤销公开，进入票据/成员代次授权路径。
    await callTool(ownerConn.client, 'network_file_publish', {
      request_id: newRequestId('unpublish'),
      file_id: uploaded.fileId,
      public: false,
    });

    // M07-T01：非成员知道 file_id / 旧裸 URL / Range 也读不到私有字节。
    checkEqual('[M07-T01] 私有文件裸 publicUrl GET 返回 404', await statusOf(uploaded.publicUrl), 404);
    checkEqual(
      '[M07-T01] 私有文件裸 publicUrl 带 Range 仍返回 404',
      await statusOf(uploaded.publicUrl, { headers: { range: 'bytes=0-3' } }),
      404,
    );
    checkEqual(
      '[M07-T01] 私有文件裸 publicUrl HEAD 返回 404',
      await statusOf(uploaded.publicUrl, { method: 'HEAD' }),
      404,
    );
    checkEqual(
      '[M07-T01] 私有文件裸 publicUrl ?download=1 返回 404',
      await statusOf(`${uploaded.publicUrl}?download=1`),
      404,
    );
    checkEqual(
      '[M07-T01] 非成员按 file_id 直读被拒',
      (
        await expectToolError(
          '[M07-T01] 非成员直读',
          roomFile(strangerConn, roomId, uploaded.fileId),
          'NOT_MEMBER',
        )
      ).code,
      'NOT_MEMBER',
    );
    checkEqual(
      '[M07-T01] 上传时的文件票据不能读取已绑定私有文件',
      await statusOf(uploaded.previewUrl),
      404,
    );
    const ownerRead = await fetch(bound.file.preview_url);
    checkEqual('[M07-T01] 上传者使用绑定票据可读', ownerRead.status, 200);
    checkEqual('[M07-T01] 绑定票据内容一致', await ownerRead.text(), 'm07 secret bytes');

    // 票据支持 HEAD/Range/If-None-Match，且仍只对授权身份签发。
    const ranged = await fetch(bound.file.preview_url, { headers: { range: 'bytes=0-3' } });
    checkEqual('[M07-T01] 私有票据 Range 返回 206', ranged.status, 206);
    checkEqual('[M07-T01] 私有票据 Range 内容正确', await ranged.text(), 'm07 ');
    checkEqual(
      '[M07-T01] 私有票据 Range content-range 正确',
      ranged.headers.get('content-range'),
      'bytes 0-3/16',
    );
    const head = await fetch(bound.file.preview_url, { method: 'HEAD' });
    checkEqual('[M07-T01] 私有票据 HEAD 返回 200', head.status, 200);
    checkEqual('[M07-T01] 私有票据 HEAD 返回完整长度', head.headers.get('content-length'), '16');
    checkEqual('[M07-T01] 私有票据 HEAD 不返回正文', (await head.text()).length, 0);
    const etag = head.headers.get('etag') ?? '';
    const notModified = await fetch(bound.file.preview_url, {
      headers: { 'if-none-match': etag },
    });
    checkEqual('[M07-T01] 私有票据 If-None-Match 返回 304', notModified.status, 304);

    // 绑定后的普通附件应获得完整 30 天，而不是上传草稿的 24 小时。
    const filePage = await callTool<{
      items: { expires_at: string; retained: boolean }[];
    }>(ownerConn.client, 'network_room_file_list', { room_id: roomId });
    const fileInfo = filePage.items[0];
    checkEqual('[M07-T01] 绑定后文件进入房间列表', Boolean(fileInfo), true);
    checkEqual('[M07-T01] 绑定后不是保留态', fileInfo?.retained, false);
    check(
      '[M07-T01] 绑定后保留 30 天',
      Number(fileInfo?.expires_at ?? 0) > Date.now() + 29 * 24 * 60 * 60_000,
      fileInfo?.expires_at,
    );

    // M07-T02：移除成员后新下载与未使用旧票据失效；其他合法成员正常读取。
    const memberBefore = await roomFile(memberConn, roomId, uploaded.fileId);
    const otherBefore = await roomFile(otherConn, roomId, uploaded.fileId);
    checkEqual(
      '[M07-T02] 被移除成员事先拿到未使用票据 200',
      await statusOf(memberBefore.file.preview_url),
      200,
    );
    await callTool(ownerConn.client, 'network_room_members_update', {
      request_id: newRequestId('remove'),
      room_id: roomId,
      remove: [memberId],
    });
    checkEqual(
      '[M07-T02] 移除后未使用旧票据返回 404',
      await statusOf(memberBefore.file.preview_url),
      404,
    );
    await expectToolError(
      '[M07-T02] 移除后新的按 ID 读取',
      roomFile(memberConn, roomId, uploaded.fileId),
      'NOT_MEMBER',
    );
    checkEqual(
      '[M07-T02] 其他合法成员的旧票据仍可读',
      await statusOf(otherBefore.file.preview_url),
      200,
    );
    const otherAfter = await roomFile(otherConn, roomId, uploaded.fileId);
    checkEqual('[M07-T02] 其他合法成员可获取新票据', await statusOf(otherAfter.file.preview_url), 200);
    checkEqual('[M07-T02] 上传者票据不受影响', await statusOf(bound.file.preview_url), 200);

    // 私有光栅图片仍以内联方式预览。
    const image = await createFile(
      ownerConn,
      'm07-image.png',
      PNG_BYTES,
      'image/png',
    );
    const boundImage = await bind(ownerConn, roomId, image.fileId);
    const imageResponse = await fetch(boundImage.file.preview_url);
    checkEqual('[M07-T01] 私有图片票据返回 200', imageResponse.status, 200);
    checkEqual('[M07-T01] 私有图片 content-type', imageResponse.headers.get('content-type'), 'image/png');
    check(
      '[M07-T01] 私有图片保持 inline 预览',
      (imageResponse.headers.get('content-disposition') ?? '').startsWith('inline'),
      imageResponse.headers.get('content-disposition'),
    );

    // 公开发布是独立、需权限的动作；默认公开，显式撤销后裸 URL 立即 404。
    const publishable = await createFile(ownerConn, 'm07-publish.txt', 'm07 public bytes');
    const publishableBound = await bind(ownerConn, roomId, publishable.fileId);
    checkEqual(
      '[M07-PUB] 新文件默认公开裸 URL 可读',
      await statusOf(publishableBound.file.public_url),
      200,
    );
    const memberPublish = await expectToolError(
      '[M07-PUB] 普通成员不能切换可见性',
      callTool(otherConn.client, 'network_file_publish', {
        request_id: newRequestId('publish'),
        file_id: publishable.fileId,
        public: false,
      }),
      'NOT_OWNER',
    );
    checkEqual('[M07-PUB] 普通成员发布错误码', memberPublish.code, 'NOT_OWNER');
    const unpublished = await callTool<{ public: boolean; public_url: string; preview_url: string }>(
      ownerConn.client,
      'network_file_publish',
      {
        request_id: newRequestId('unpublish'),
        file_id: publishable.fileId,
        public: false,
      },
    );
    checkEqual('[M07-PUB] 撤销公开后裸 URL 立即 404', await statusOf(unpublished.public_url), 404);
    checkEqual(
      '[M07-PUB] 撤销公开后带票据地址仍可读',
      await statusOf(unpublished.preview_url),
      200,
    );
    // 撤销后可以再次公开：事件键不能按 file_id 复用。
    const republished = await callTool<{ public_url: string }>(
      ownerConn.client,
      'network_file_publish',
      {
        request_id: newRequestId('publish'),
        file_id: publishable.fileId,
        public: true,
      },
    );
    checkEqual('[M07-PUB] 再次公开裸 URL 可读', await statusOf(republished.public_url), 200);
    await callTool(ownerConn.client, 'network_file_publish', {
      request_id: newRequestId('unpublish'),
      file_id: publishable.fileId,
      public: false,
    });

    // 公开光栅图片（显式发布）保持 inline 预览，不因私有化收紧而破坏图片。
    const publicImage = await createFile(ownerConn, 'm07-public.png', PNG_BYTES, 'image/png');
    await bind(ownerConn, roomId, publicImage.fileId);
    const publicImageResult = await callTool<{ public_url: string }>(
      ownerConn.client,
      'network_file_publish',
      {
        request_id: newRequestId('publish'),
        file_id: publicImage.fileId,
        public: true,
      },
    );
    const publicImageResponse = await fetch(publicImageResult.public_url);
    checkEqual('[M07-PUB] 显式公开图片返回 200', publicImageResponse.status, 200);
    checkEqual(
      '[M07-PUB] 显式公开图片 content-type',
      publicImageResponse.headers.get('content-type'),
      'image/png',
    );
    check(
      '[M07-PUB] 显式公开图片保持 inline 预览',
      (publicImageResponse.headers.get('content-disposition') ?? '').startsWith('inline'),
      publicImageResponse.headers.get('content-disposition'),
    );
  } finally {
    await Promise.all([
      ownerConn.close(),
      memberConn.close(),
      otherConn.close(),
      strangerConn.close(),
    ]);
  }
}
