/**
 * 阶段 1 真实 A/B/A 验收。
 *
 * 真实构建两套内容不同的发布（不同 build nonce），先启用 A 再切 B：
 * - 旧 A 页面的入口、懒模块与固定别名在 B 进程下仍可读取且摘要不变；
 * - 缺文件/摘要不符的半发布被拒绝，指针保持 B；
 * - B→A 回滚产生新 deploymentId，版本接口、HTML 与入口一致；
 * - `/health`、`/`、`GET /mcp` 与缓存头保持原契约。
 */

import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readCurrentBuildId,
  readLegacyAliases,
  sha256Hex,
  type WebReleaseAsset,
} from '../src/web/web-release';
import { check, checkEqual, checksPassed } from './lib/harness';
import { startTestServer, type TestServer } from './lib/test-server';
import {
  buildCandidate,
  probeLiveRelease,
  publishCandidate,
  rollbackTo,
  type WebReleaseCandidate,
} from './lib/web-release';

interface LazyChunk {
  readonly key: string;
  readonly file: string;
}

async function lazyChunkOf(candidate: WebReleaseCandidate): Promise<LazyChunk> {
  const manifest = JSON.parse(
    await readFile(join(candidate.webDir, '.vite/manifest.json'), 'utf8'),
  ) as Record<string, { file?: string; dynamicImports?: string[] }>;
  const entry = manifest['src/web/app/main.tsx'];
  const key = entry?.dynamicImports?.[0];
  const chunk = key ? manifest[key] : undefined;
  if (!key || !chunk?.file) throw new Error('无法定位入口懒模块');
  return { key, file: chunk.file };
}

function moduleAsset(candidate: WebReleaseCandidate, url: string): WebReleaseAsset {
  const asset = candidate.manifest.assets.find((item) => item.url === url);
  if (!asset) throw new Error(`清单缺少模块 ${url}`);
  return asset;
}

async function copyCandidate(
  source: WebReleaseCandidate,
  targetRoot: string,
  label: string,
): Promise<WebReleaseCandidate> {
  const candidateDir = join(targetRoot, `tamper-${label}-${crypto.randomUUID()}`);
  await cp(source.candidateDir, candidateDir, { recursive: true });
  return {
    candidateDir,
    webDir: join(candidateDir, 'web'),
    manifest: source.manifest,
    modules: source.modules,
  };
}

async function expectRejected(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('候选校验失败')) {
      throw new Error(`${label} 失败原因不是候选校验: ${message}`);
    }
    return;
  }
  throw new Error(`${label} 未被拒绝`);
}

async function fetchBytes(url: string): Promise<{ status: number; bytes: Uint8Array; headers: Headers }> {
  const response = await fetch(url);
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'agentnet-web-release-'));
  const scratch = await mkdtemp(join(tmpdir(), 'agentnet-web-release-scratch-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'agentnet-web-release-data-'));
  const env = { ENVIRONMENT: 'test', WEB_RELEASES_ROOT: root };
  let server: TestServer | undefined;
  let a: WebReleaseCandidate | undefined;
  let b: WebReleaseCandidate | undefined;
  let aDeploymentId = '';
  let bDeploymentId = '';
  let rollbackDeploymentId = '';
  let oldLazyStatus: number | null = null;
  try {
    console.log('构建与发布 A…');
    a = await buildCandidate({ releasesRoot: root, nonce: 'a' });
    const aPublished = await publishCandidate(a, {
      releasesRoot: root,
      freezeLegacy: true,
      keepCandidate: true,
    });
    check('A 已产生 deploymentId', typeof aPublished.deploymentId === 'string');
    aDeploymentId = aPublished.deploymentId ?? '';
    checkEqual('A 固定别名已冻结', aPublished.legacyFrozen, true);
    check(
      '候选 immutable 仅限 /static/assets/',
      a.manifest.assets.every(
        (asset) => asset.immutable === asset.url.startsWith('/static/assets/'),
      ),
    );

    const lazyA = await lazyChunkOf(a);
    const lazyAssetA = a.manifest.assets.find(
      (asset) => asset.url.endsWith(`/${lazyA.file}`),
    );
    check('A 懒模块在清单中', Boolean(lazyAssetA), lazyA.file);

    server = await startTestServer({ dataDir, env });
    const probeA = await probeLiveRelease(server.base, root, a.manifest.buildId);
    checkEqual('A deploymentId 一致', probeA.deploymentId, aDeploymentId);
    console.log(`  A buildId: ${a.manifest.buildId}`);
    console.log(`  A deploymentId: ${aDeploymentId}`);

    // PWA 固定 URL 不依赖 /static 索引：release 模式下 manifest/sw/图标仍可读。
    const pwaManifestResponse = await fetch(`${server.base}/manifest.webmanifest`);
    const pwaManifest = (await pwaManifestResponse.json()) as {
      id?: string;
      icons?: { src?: string }[];
    };
    checkEqual('release manifest 200', pwaManifestResponse.status, 200);
    checkEqual(
      'release manifest MIME',
      pwaManifestResponse.headers.get('content-type'),
      'application/manifest+json; charset=utf-8',
    );
    checkEqual(
      'release manifest no-cache',
      pwaManifestResponse.headers.get('cache-control'),
      'no-cache',
    );
    checkEqual('release manifest id', pwaManifest.id, '/');
    const pwaSwResponse = await fetch(`${server.base}/sw.js`);
    checkEqual('release sw 200', pwaSwResponse.status, 200);
    checkEqual(
      'release sw no-cache',
      pwaSwResponse.headers.get('cache-control'),
      'no-cache',
    );
    const pwaIconPath = pwaManifest.icons?.[0]?.src;
    check('release manifest 图标 URL', typeof pwaIconPath === 'string', pwaIconPath);
    if (pwaIconPath) {
      const pwaIcon = await fetch(`${server.base}${pwaIconPath}`);
      checkEqual('release 图标 200', pwaIcon.status, 200);
      check(
        'release 图标 immutable',
        (pwaIcon.headers.get('cache-control') ?? '').includes('immutable'),
      );
    }

    const aModule = moduleAsset(a, a.manifest.modules.markdown.url);
    const bundleText = (
      await Promise.all(
        a.manifest.assets
          .filter((asset) => asset.contentType.startsWith('text/javascript'))
          .map((asset) =>
            readFile(join(a!.webDir, asset.url.slice('/static/'.length)), 'utf8').catch(() => ''),
          ),
      )
    ).join('\n');
    check(
      '构建产物内嵌 markdown 哈希 URL',
      bundleText.includes(a.manifest.modules.markdown.url),
    );
    check(
      '构建产物内嵌 drawboard 哈希 URL',
      bundleText.includes(a.manifest.modules.drawboard.url),
    );
    const htmlA = await fetch(`${server.base}/`);
    const htmlAText = await htmlA.text();
    const entryMatchA = /<script type="module" src="([^"]+)"/u.exec(htmlAText);
    checkEqual('A HTML 入口与清单一致', entryMatchA?.[1], a.manifest.entry);

    await server.stop();
    server = undefined;

    console.log('构建与发布 B（真实内容差异）…');
    b = await buildCandidate({ releasesRoot: root, nonce: 'b' });
    check('A/B buildId 不同', a.manifest.buildId !== b.manifest.buildId);
    const entryA = a.manifest.assets.find((asset) => asset.url === a!.manifest.entry);
    const entryB = b.manifest.assets.find((asset) => asset.url === b!.manifest.entry);
    check(
      'A/B 入口字节不同',
      Boolean(entryA && entryB && entryA.sha256 !== entryB.sha256),
    );
    const bPublished = await publishCandidate(b, {
      releasesRoot: root,
      keepCandidate: true,
    });
    bDeploymentId = bPublished.deploymentId ?? '';
    check('B 已产生新 deploymentId', bDeploymentId !== aDeploymentId);
    checkEqual('固定别名未被 B 改写', bPublished.legacyFrozen, false);

    server = await startTestServer({ dataDir, env });
    const probeB = await probeLiveRelease(server.base, root, b.manifest.buildId);
    checkEqual('B deploymentId 一致', probeB.deploymentId, bDeploymentId);
    console.log(`  B buildId: ${b.manifest.buildId}`);
    console.log(`  B deploymentId: ${bDeploymentId}`);

    const htmlB = await (await fetch(`${server.base}/`)).text();
    const entryMatchB = /<script type="module" src="([^"]+)"/u.exec(htmlB);
    checkEqual('B HTML 入口与清单一致', entryMatchB?.[1], b.manifest.entry);
    check('B 入口与 A 不同', b.manifest.entry !== a.manifest.entry);

    // 五条页面路由（含 SSR share/join 与 404 变体）共用同一 buildId。
    for (const [path, expectedStatus] of [
      ['/c/room-release-test', 200],
      ['/pair', 200],
      ['/j/not-a-valid-key', 404],
      ['/a/missing_session', 404],
    ] as const) {
      const response = await fetch(`${server.base}${path}`);
      const text = await response.text();
      checkEqual(`${path} 状态`, response.status, expectedStatus);
      checkEqual(`${path} no-store`, response.headers.get('cache-control'), 'no-store');
      check(
        `${path} 内嵌同一 buildId`,
        text.includes('id="web-release"') && text.includes(b.manifest.buildId),
      );
    }

    // 旧 A 页：入口、懒模块、固定别名在 B 进程下仍可取到 A 的字节。
    const oldEntry = await fetchBytes(`${server.base}${a.manifest.entry}`);
    checkEqual('旧 A 入口 HTTP', oldEntry.status, 200);
    checkEqual(
      '旧 A 入口摘要不变',
      sha256Hex(oldEntry.bytes),
      entryA?.sha256 ?? '',
    );
    checkEqual(
      '旧 A 入口缓存头',
      oldEntry.headers.get('cache-control'),
      'public, max-age=31536000, immutable',
    );
    if (lazyAssetA) {
      const oldLazy = await fetchBytes(`${server.base}${lazyAssetA.url}`);
      oldLazyStatus = oldLazy.status;
      checkEqual('旧 A 懒模块 HTTP', oldLazy.status, 200);
      checkEqual('旧 A 懒模块摘要不变', sha256Hex(oldLazy.bytes), lazyAssetA.sha256);
      checkEqual('旧 A 懒模块 MIME', oldLazy.headers.get('content-type'), lazyAssetA.contentType);
    }
    const oldModule = await fetchBytes(`${server.base}${aModule.url}`);
    checkEqual('旧 A 哈希模块 HTTP', oldModule.status, 200);
    checkEqual('旧 A 哈希模块摘要不变', sha256Hex(oldModule.bytes), aModule.sha256);

    const legacy = await readLegacyAliases(root);
    check('固定别名已冻结', legacy !== null);
    for (const [name, alias] of Object.entries(legacy?.aliases ?? {})) {
      const response = await fetchBytes(`${server.base}/assets/${name}`);
      checkEqual(`${name} 仍为基线字节`, sha256Hex(response.bytes), alias.sha256);
      checkEqual(`${name} 缓存头`, response.headers.get('cache-control'), 'public, max-age=300');
    }

    // 半发布 1：清单内文件缺失。
    checkEqual('半发布前指针为 B', await readCurrentBuildId(root), b.manifest.buildId);
    const lazyB = await lazyChunkOf(b);
    const lazyAssetB = b.manifest.assets.find((asset) => asset.url.endsWith(`/${lazyB.file}`));
    check('B 懒模块在清单中', Boolean(lazyAssetB), lazyB.file);
    const missing = await copyCandidate(b, scratch, 'missing');
    if (lazyAssetB) {
      await unlink(join(missing.webDir, lazyAssetB.url.slice('/static/'.length)));
    }
    await expectRejected('缺文件候选', () =>
      publishCandidate(missing, { releasesRoot: root }),
    );
    checkEqual('缺文件后指针仍为 B', await readCurrentBuildId(root), b.manifest.buildId);

    // 半发布 2：文件存在但字节被改（大小不变）。
    const tampered = await copyCandidate(b, scratch, 'digest');
    const victim = tampered.manifest.assets.find(
      (asset) => asset.url !== tampered.manifest.entry && asset.bytes > 16,
    );
    check('找到可篡改资源', Boolean(victim));
    if (victim) {
      const path = join(tampered.webDir, victim.url.slice('/static/'.length));
      const bytes = new Uint8Array(await readFile(path));
      bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 0xff;
      await writeFile(path, bytes);
      await expectRejected('摘要不符候选', () => publishCandidate(tampered, { releasesRoot: root }));
    }
    checkEqual('摘要不符后指针仍为 B', await readCurrentBuildId(root), b.manifest.buildId);
    const afterHalf = await probeLiveRelease(server.base, root, b.manifest.buildId);
    checkEqual('半发布后运行中版本仍为 B', afterHalf.buildId, b.manifest.buildId);

    // 回滚 B → A。
    const rollback = await rollbackTo(root, 'previous');
    rollbackDeploymentId = rollback.deploymentId;
    checkEqual('回滚目标为 A', rollback.buildId, a.manifest.buildId);
    check('回滚产生新 deploymentId', ![aDeploymentId, bDeploymentId].includes(rollbackDeploymentId));
    await server.stop();
    server = undefined;

    server = await startTestServer({ dataDir, env });
    const probeRollback = await probeLiveRelease(server.base, root, a.manifest.buildId);
    checkEqual('回滚后 deploymentId 一致', probeRollback.deploymentId, rollbackDeploymentId);
    const htmlRollback = await (await fetch(`${server.base}/`)).text();
    const entryMatchRollback = /<script type="module" src="([^"]+)"/u.exec(htmlRollback);
    checkEqual('回滚后 HTML 入口为 A', entryMatchRollback?.[1], a.manifest.entry);

    // 回滚后 B 与 A 的资源都必须仍在。
    for (const asset of [...a.manifest.assets, ...b.manifest.assets]) {
      const response = await fetchBytes(`${server.base}${asset.url}`);
      checkEqual(`回滚后 ${asset.url} HTTP`, response.status, 200);
      checkEqual(`回滚后 ${asset.url} 摘要`, sha256Hex(response.bytes), asset.sha256);
    }
    const versionFinal = (await (await fetch(`${server.base}/web-version.json`)).json()) as {
      buildId?: string;
      minWebContract?: number;
      maxWebContract?: number;
    };
    checkEqual('最终版本 buildId=A', versionFinal.buildId, a.manifest.buildId);
    checkEqual('契约范围 1..1', `${versionFinal.minWebContract}..${versionFinal.maxWebContract}`, '1..1');

    console.log(
      JSON.stringify(
        {
          root,
          builds: {
            A: {
              buildId: a.manifest.buildId,
              deploymentId: aDeploymentId,
              entry: a.manifest.entry,
              entryBytes: entryA?.bytes ?? null,
              assets: a.manifest.assets.length,
              lazyModule: lazyAssetA?.url ?? null,
              markdown: a.manifest.modules.markdown.url,
            },
            B: {
              buildId: b.manifest.buildId,
              deploymentId: bDeploymentId,
              entry: b.manifest.entry,
              entryBytes: entryB?.bytes ?? null,
              assets: b.manifest.assets.length,
            },
          },
          oldAssetsAfterSwitch: {
            entryStatus: oldEntry.status,
            lazyStatus: oldLazyStatus,
            alias: 'baseline-frozen',
          },
          halfPublish: { missingFile: 'rejected', digestMismatch: 'rejected', pointer: 'B' },
          rollback: {
            deploymentId: rollbackDeploymentId,
            buildId: a.manifest.buildId,
            htmlEntry: entryMatchRollback?.[1] ?? null,
          },
          checks: checksPassed(),
        },
        null,
        2,
      ),
    );
  } finally {
    await server?.stop();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(scratch, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
