/**
 * 消息文件元数据缓存/队列单元验收。
 *
 * 覆盖独立验证复现的两个票据问题与并发上限：
 * 1. 10 个唯一 fileId 同时入队时真实网络并发不超过 4；
 * 2. 缓存 key 按凭据摘要隔离，同一标签页切换身份不会拿到旧票据；
 * 3. 打开预览/下载前的 `ensureFresh` 在 55 分钟后重签；
 * 4. 同一 key 的在途请求仍会合并。
 *
 * 运行：bun scripts/verify-file-meta-cache.ts
 */

import { LIMITS } from '../src/contracts/limits';
import type { RoomFileItem } from '../src/web/lib/files-ui';
import {
  createFileMetaLoader,
  fileMetaIdentity,
  type FileMetaFetcher,
} from '../src/web/lib/file-meta-cache';
import { check, checkEqual } from './lib/harness';

function item(fileId: string, ticket: string): RoomFileItem {
  return {
    file_id: fileId,
    name: `${fileId}.txt`,
    size: 1,
    mime_type: 'text/plain',
    preview_url: `/f/${fileId}?t=${ticket}`,
    download_url: `/f/${fileId}?download=1&t=${ticket}`,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function checkConcurrency(): Promise<void> {
  let active = 0;
  let maxActive = 0;
  const releases = new Map<string, () => void>();
  const fetcher: FileMetaFetcher = (_roomId, fileId) =>
    new Promise<RoomFileItem>((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      releases.set(fileId, () => {
        active -= 1;
        resolve(item(fileId, 'ticket'));
      });
    });
  const loader = createFileMetaLoader(fetcher);
  const loads = Array.from({ length: 10 }, (_, index) =>
    loader.load('identity', 'room', `f${index}`, 'token'),
  );

  await flush();
  checkEqual(
    '10 个唯一 fileId 入队后只启动并发上限数量的请求',
    maxActive,
    LIMITS.webMessageFileConcurrency,
  );

  let progressed = false;
  let exceeded = false;
  while (releases.size > 0) {
    const next = releases.entries().next().value as [string, () => void] | undefined;
    if (!next) break;
    releases.delete(next[0]);
    next[1]();
    progressed = true;
    await flush();
    if (maxActive > LIMITS.webMessageFileConcurrency) exceeded = true;
  }
  check(
    `排队过程中网络并发始终不超过 ${LIMITS.webMessageFileConcurrency}`,
    !exceeded,
    { maxActive },
  );

  const entries = await Promise.all(loads);
  check('10 个请求全部完成', progressed && entries.length === 10);
  checkEqual('最终占用归零', loader.pending(), 0);
  check('并发探针确实观察到了并行请求', maxActive > 1, { maxActive });
}

async function checkIdentityIsolation(): Promise<void> {
  const tokens: string[] = [];
  const fetcher: FileMetaFetcher = async (_roomId, fileId, token) => {
    tokens.push(token);
    return item(fileId, token);
  };
  const loader = createFileMetaLoader(fetcher);
  const firstIdentity = fileMetaIdentity('token-a');
  const secondIdentity = fileMetaIdentity('token-b');
  check('不同凭据产生不同内存标识', firstIdentity !== secondIdentity);

  const first = await loader.load(firstIdentity, 'room', 'file', 'token-a');
  const second = await loader.load(secondIdentity, 'room', 'file', 'token-b');

  checkEqual('身份切换后重新获取元数据与票据', tokens.length, 2);
  checkEqual('身份 A 的下载地址带 A 的票据', first.item?.download_url, '/f/file?download=1&t=token-a');
  checkEqual('身份 B 的下载地址带 B 的票据', second.item?.download_url, '/f/file?download=1&t=token-b');
  checkEqual(
    '身份 B 的缓存读取不会命中身份 A 的条目',
    loader.read(firstIdentity, 'room', 'file')?.item?.download_url,
    '/f/file?download=1&t=token-a',
  );
  checkEqual(
    '身份 B 自己的缓存条目存在',
    loader.read(secondIdentity, 'room', 'file')?.item?.download_url,
    '/f/file?download=1&t=token-b',
  );
}

async function checkInFlightDedupe(): Promise<void> {
  let calls = 0;
  const pending: { release: (() => void) | null } = { release: null };
  const fetcher: FileMetaFetcher = (_roomId, fileId) =>
    new Promise<RoomFileItem>((resolve) => {
      calls += 1;
      pending.release = () => resolve(item(fileId, 'shared'));
    });
  const loader = createFileMetaLoader(fetcher);
  const identity = fileMetaIdentity('token');
  const first = loader.load(identity, 'room', 'file', 'token');
  const second = loader.load(identity, 'room', 'file', 'token');
  await flush();
  checkEqual('同一 fileId 的并发请求合并为一次网络调用', calls, 1);
  pending.release?.();
  const [a, b] = await Promise.all([first, second]);
  check('合并的两个调用拿到同一结果', a.item?.download_url === b.item?.download_url);
}

async function checkTicketExpiry(): Promise<void> {
  let clock = 1_000;
  let calls = 0;
  const fetcher: FileMetaFetcher = async (_roomId, fileId) => {
    calls += 1;
    return item(fileId, `ticket-${calls}`);
  };
  const loader = createFileMetaLoader(fetcher, () => clock);
  const identity = fileMetaIdentity('token');

  const initial = await loader.load(identity, 'room', 'file', 'token');
  checkEqual('首次加载生成票据 1', initial.item?.download_url, '/f/file?download=1&t=ticket-1');

  clock += LIMITS.webMessageFileCacheTtlMs - 1;
  const stillFresh = await loader.ensureFresh(identity, 'room', 'file', 'token');
  checkEqual('未满 55 分钟沿用缓存', calls, 1);
  checkEqual('缓存票据保持不变', stillFresh.item?.download_url, '/f/file?download=1&t=ticket-1');

  clock += 2;
  const refreshed = await loader.ensureFresh(identity, 'room', 'file', 'token');
  checkEqual('超过 55 分钟后重新获取一次', calls, 2);
  checkEqual('刷新后使用新票据', refreshed.item?.download_url, '/f/file?download=1&t=ticket-2');
  checkEqual('缓存记录新的获取时间', loader.read(identity, 'room', 'file')?.at, clock);
}

async function checkFailureRetry(): Promise<void> {
  let calls = 0;
  const fetcher: FileMetaFetcher = async (_roomId, fileId) => {
    calls += 1;
    if (calls === 1) throw new Error('FILE_UNAVAILABLE');
    return item(fileId, 'retry');
  };
  const loader = createFileMetaLoader(fetcher);
  const identity = fileMetaIdentity('token');

  let failed = false;
  try {
    await loader.load(identity, 'room', 'file', 'token');
  } catch (error) {
    failed = (error as Error).message === 'FILE_UNAVAILABLE';
  }
  check('首次获取失败会 reject', failed);

  const retried = await loader.ensureFresh(identity, 'room', 'file', 'token');
  checkEqual('失败缓存不会阻止用户重试', calls, 2);
  checkEqual('重试成功后返回可用票据', retried.item?.download_url, '/f/file?download=1&t=retry');
}

await checkConcurrency();
await checkIdentityIsolation();
await checkInFlightDedupe();
await checkTicketExpiry();
await checkFailureRetry();
console.log('\n文件元数据缓存/队列单元验收通过');
