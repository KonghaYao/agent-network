/**
 * 发布底座的低成本单元验收：缓存策略与清理顺序/候选目录。
 *
 * 真实 A/B/A、原子切换与资源字节仍由 `verify-web-release.ts` 覆盖；
 * 这里只验证不需要启动服务、不需要 Vite 的边界行为。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { check, checkEqual, checksPassed } from './lib/harness';
import { addPin, collectAssets, pruneReleases, publishCandidate, readPins, withReleaseLock } from './lib/web-release';
import {
  activateDeployment,
  buildIdDirectory,
  computeBuildId,
  contentTypeForPath,
  readCurrentBuildId,
  readLegacyAliases,
  resolveWebReleaseMode,
  sha256Hex,
  staticRelativeFromUrl,
  staticUrlFromRelative,
  WEB_CONTRACT_VERSION,
  WEB_RELEASE_MAX_CONTRACT,
  WEB_RELEASE_MIN_CONTRACT,
  WEB_RELEASE_SCHEMA_VERSION,
  writeJsonAtomic,
  type WebReleaseAsset,
  type WebReleaseManifest,
} from '../src/web/web-release';

function makeAsset(relative: string, content: string, immutable: boolean): WebReleaseAsset {
  const bytes = new TextEncoder().encode(content);
  return {
    url: staticUrlFromRelative(relative),
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
    contentType: contentTypeForPath(relative),
    immutable,
  };
}

function makeManifest(
  assets: readonly WebReleaseAsset[],
  entry: WebReleaseAsset,
): WebReleaseManifest {
  const markdown = assets.find((asset) => asset.url.includes('chat-markdown'))!;
  const drawboard = assets.find((asset) => asset.url.includes('chat-drawboard'))!;
  const digestInput = {
    schemaVersion: WEB_RELEASE_SCHEMA_VERSION,
    webContract: WEB_CONTRACT_VERSION,
    minWebContract: WEB_RELEASE_MIN_CONTRACT,
    maxWebContract: WEB_RELEASE_MAX_CONTRACT,
    entry: entry.url,
    css: [] as string[],
    modules: { markdown, drawboard },
    assets,
  } as const;
  return {
    ...digestInput,
    buildId: computeBuildId(digestInput),
    createdAt: new Date().toISOString(),
  };
}

function checkReleaseMode(): void {
  const implicit = resolveWebReleaseMode(undefined, '/tmp/default-releases');
  checkEqual('未设置 env 不启用发布模式', implicit.enabled, false);
  checkEqual('未设置 env 使用默认根', implicit.root, '/tmp/default-releases');
  const explicit = resolveWebReleaseMode('/tmp/explicit-releases', '/tmp/default-releases');
  checkEqual('显式设置 env 启用发布模式', explicit.enabled, true);
  checkEqual('显式设置 env 使用显式根', explicit.root, '/tmp/explicit-releases');
}

async function checkImmutablePolicy(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agentnet-release-immutable-'));
  try {
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'assets/main-abc123.js'), 'console.log(1);\n');
    await writeFile(join(dir, 'sw.js'), 'self.addEventListener("install", () => {});\n');
    await writeFile(join(dir, 'manifest.webmanifest'), '{"name":"test"}\n');
    const assets = await collectAssets(dir, {
      immutable: (relative) => relative.startsWith('assets/'),
      strictMime: true,
    });
    const byRelative = new Map(
      assets.map((asset) => [staticRelativeFromUrl(asset.url), asset] as const),
    );
    checkEqual('assets/ 内容地址文件 immutable', byRelative.get('assets/main-abc123.js')?.immutable, true);
    checkEqual('sw.js 不 immortal', byRelative.get('sw.js')?.immutable, false);
    checkEqual(
      'manifest.webmanifest 不 immortal',
      byRelative.get('manifest.webmanifest')?.immutable,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function checkPrune(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agentnet-release-prune-'));
  try {
    const entry = makeAsset('assets/entry-abc.js', 'entry', true);
    const markdown = makeAsset('assets/chat-markdown-abc.js', 'markdown', true);
    const drawboard = makeAsset('assets/chat-drawboard-abc.js', 'drawboard', true);
    const manifest = makeManifest([entry, markdown, drawboard], entry);
    const releaseDir = join(root, 'releases', buildIdDirectory(manifest.buildId));
    await writeJsonAtomic(join(releaseDir, 'release.json'), manifest);
    for (const asset of manifest.assets) {
      const relative = staticRelativeFromUrl(asset.url);
      await mkdir(dirname(join(root, 'public', relative)), { recursive: true });
      await writeFile(join(root, 'public', relative), relative);
    }
    const stale = makeAsset('assets/stale-dead.js', 'stale', true);
    await writeFile(join(root, 'public', staticRelativeFromUrl(stale.url)), 'stale');
    const recent = makeAsset('assets/recent.js', 'recent', true);
    const recentPath = staticRelativeFromUrl(recent.url);
    const missing = makeAsset('assets/missing.js', 'missing', true);
    await writeFile(join(root, 'public', recentPath), 'recent');
    await writeJsonAtomic(join(root, 'immutable-index.json'), {
      schemaVersion: WEB_RELEASE_SCHEMA_VERSION,
      assets: Object.fromEntries(
        [...manifest.assets, stale, recent, missing].map((asset) => [staticRelativeFromUrl(asset.url), asset]),
      ),
    });
    await activateDeployment(root, manifest, 'deploy');

    const now = Date.now();
    const oldCandidate = join(root, 'candidates/build-old/web');
    const newCandidate = join(root, 'candidates/build-new/web');
    await mkdir(oldCandidate, { recursive: true });
    await mkdir(newCandidate, { recursive: true });
    await writeFile(join(oldCandidate, 'entry.js'), 'old');
    await writeFile(join(newCandidate, 'entry.js'), 'new');
    const oldTime = new Date(now - 60_000);
    await utimes(join(root, 'candidates/build-old'), oldTime, oldTime);
    await utimes(join(root, 'public', staticRelativeFromUrl(stale.url)), oldTime, oldTime);

    const dryRun = await pruneReleases({ root, apply: false, graceMs: 1_000, now });
    checkEqual('dry-run 不删除公共资源', dryRun.removed, 0);
    checkEqual('dry-run 不删除候选目录', dryRun.removedCandidateDirs, 0);
    checkEqual('dry-run 列出过期候选目录', dryRun.candidateDirs.length, 1);
    check('dry-run 保留新候选目录', dryRun.candidateDirs.every((item) => item.name === 'build-old'));
    check('过期公共资源仍在', Boolean(await stat(join(root, 'public', staticRelativeFromUrl(stale.url))).catch(() => null)));

    const applied = await pruneReleases({ root, apply: true, graceMs: 1_000, now });
    checkEqual('apply 删除无引用资源', applied.removed, 1);
    checkEqual('apply 删除过期候选目录', applied.removedCandidateDirs, 1);
    checkEqual(
      'apply 后公共资源已删除',
      await stat(join(root, 'public', staticRelativeFromUrl(stale.url))).catch(() => null),
      null,
    );
    checkEqual('apply 后过期候选目录已删除', await stat(join(root, 'candidates/build-old')).catch(() => null), null);
    check('apply 后新候选目录仍在', Boolean(await stat(join(root, 'candidates/build-new')).catch(() => null)));
    const index = JSON.parse(await readFile(join(root, 'immutable-index.json'), 'utf8')) as {
      assets: Record<string, unknown>;
    };
    check(
      '索引不再引用已删除资源',
      !(staticRelativeFromUrl(stale.url) in index.assets),
    );
    check('清理没有文件或引用的索引项', !(staticRelativeFromUrl(missing.url) in index.assets));
    check('隔离期内资源仍在索引', recentPath in index.assets);
    checkEqual('隔离期内资源仍可读取', await readFile(join(root, 'public', recentPath), 'utf8'), 'recent');
    for (const asset of manifest.assets) {
      check(
        `索引保留当前发布资源 ${asset.url}`,
        staticRelativeFromUrl(asset.url) in index.assets,
      );
      check(
        `当前发布资源仍在 ${asset.url}`,
        Boolean(await stat(join(root, 'public', staticRelativeFromUrl(asset.url))).catch(() => null)),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function checkMigrationCommit(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agentnet-release-commit-'));
  try {
    const candidateDir = join(root, 'candidates', 'migration-test');
    const webDir = join(candidateDir, 'web');
    const entry = makeAsset('assets/entry.js', 'entry', true);
    const markdown = makeAsset('assets/chat-markdown.js', 'markdown', true);
    const drawboard = makeAsset('assets/chat-drawboard.js', 'drawboard', true);
    const manifest = makeManifest([entry, markdown, drawboard], entry);
    await mkdir(join(webDir, 'assets'), { recursive: true });
    for (const [asset, body] of [[entry, 'entry'], [markdown, 'markdown'], [drawboard, 'drawboard']] as const) {
      await writeFile(join(webDir, staticRelativeFromUrl(asset.url)), body);
    }
    const candidate = {
      candidateDir, webDir, manifest,
      modules: {
        markdown: { url: markdown.url, bytes: new TextEncoder().encode('markdown') },
        drawboard: { url: drawboard.url, bytes: new TextEncoder().encode('drawboard') },
      },
    };
    const migrate = () => publishCandidate(candidate, {
      releasesRoot: root, pin: 'migration-baseline', freezeLegacy: true, keepCandidate: true,
    });
    await withReleaseLock(root, async () => {
      await assert.rejects(migrate, /正在运行/u);
      await assert.rejects(() => addPin(root, manifest.buildId), /正在运行/u);
      await assert.rejects(() => pruneReleases({ root, apply: true, graceMs: 0 }), /正在运行/u);
    });
    checkEqual('锁冲突时未发布', await readCurrentBuildId(root), null);
    await writeFile(join(root, 'pins.json'), 'invalid');
    await assert.rejects(migrate, SyntaxError);
    checkEqual('pin 失败保持旧入口', await readCurrentBuildId(root), null);
    const legacy = await readLegacyAliases(root);
    check('固定别名已持久化', legacy?.baselineBuildId === manifest.buildId);
    await rm(join(root, 'pins.json'));
    await migrate();
    checkEqual('故障重试完成切换', await readCurrentBuildId(root), manifest.buildId);
    checkEqual('恢复后迁移基线 pin 可读', (await readPins(root)).legacyBaseline, manifest.buildId);
    checkEqual('恢复时未覆盖已冻结的别名', (await readLegacyAliases(root))?.frozenAt, legacy?.frozenAt);
    await assert.rejects(migrate, /拒绝重复迁移/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  checkReleaseMode();
  await checkImmutablePolicy();
  await checkPrune();
  await checkMigrationCommit();
  console.log(`\n发布底座单元验收通过：${checksPassed()} 项`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
