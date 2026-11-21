import type { Hono } from 'hono';
import { stat } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';

import { CLI_BUNDLE_FILENAME } from '../bun/cli-bundle';
import { LIMITS } from '../contracts/limits';
import { matchesEtag } from '../http/conditional-request';
import {
  PWA_MANIFEST_BODY,
  PWA_MANIFEST_ETAG,
  PWA_SERVICE_WORKER_BODY,
  PWA_SERVICE_WORKER_ETAG,
  pwaAssetEtag,
  pwaAssetForUrl,
  readPwaAsset,
} from './pwa/assets.server';
import type { LoadedWebRelease } from './web-release';

const SKILLS_ROOT = resolve(import.meta.dir, '../../public/skills');
const AGENT_ICONS_ROOT = resolve(import.meta.dir, '../../public/agent-icons');
/** Vite 构建产物目录；`WEB_DIST_DIR` 只用于测试/自定义部署覆盖。 */
const WEB_DIST_ROOT = resolve(import.meta.dir, '../../dist/web');
const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
};
const STATIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** 4B-6 起 legacy 壳已删除；浏览器岛只保留 React 仍在用的 Markdown 与画板。 */
const LIVE_ASSETS: ReadonlySet<string> = new Set(['chat-markdown.js', 'chat-drawboard.js']);
const RETIRED_ASSETS: ReadonlySet<string> = new Set(['chat-resizer.js', 'chat-icons.js']);

/** 旧 shell 包装已删除，保留一个发布周期的 410 让存量客户端得到明确迁移信号。 */
const RETIRED_SKILL_PATH = /^[a-z0-9][a-z0-9._-]*\.sh$/u;

export interface WebAssetDeps {
  /** 启动时构建的 AI 消息 Markdown bundle；null 表示构建失败、页面回退纯文本。 */
  markdownAsset?: string | null;
  /** bundle 内容哈希；作为 `/assets/chat-markdown.js` 的 ETag，避免重复传输。 */
  markdownAssetVersion?: string | null;
  /** 按需加载的 Fabric 画板 bundle；null 表示构建失败、打开时显示可读错误。 */
  drawboardAsset?: string | null;
  /** 画板 bundle 内容哈希；`/assets/chat-drawboard.js` 的 ETag。 */
  drawboardAssetVersion?: string | null;
  /** 启动时构建的 agentnet CLI bundle；null 表示构建失败、/skills/agentnet.js 返回 404。 */
  clientAsset?: string | null;
  /** CLI bundle 内容哈希；作为 ETag，客户端重复请求可命中 304。 */
  clientAssetVersion?: string | null;
  /** Vite 产物目录；默认仓库根的 `dist/web`，测试可指向临时目录。 */
  spaDistDir?: string;
  /** 发布模式快照；null/undefined 时走 `dist/web` 兼容模式。 */
  webRelease?: LoadedWebRelease | null;
}

/** 已退役的脚本路径返回 410，而不是静默 404，便于旧客户端发现迁移。 */
function retiredSkillResponse(): Response {
  return new Response(
    'This shell helper has been removed. Download /skills/agentnet.js and run `bun agentnet.js --help`.',
    {
      status: 410,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    },
  );
}

export function registerStaticAssetRoute(app: Hono, deps: WebAssetDeps): void {
  const spaDistDir = deps.spaDistDir ?? WEB_DIST_ROOT;
  const webRelease = deps.webRelease;
  // 只服务构建产物：拒绝路径穿越、目录不列表。
  // - 兼容模式：扩展名白名单 + 文件名 ETag + 一年 immutable；
  // - 发布模式：只有 append-only 索引认可的 URL 才能读取，MIME/摘要/缓存策略
  //   全部来自发布描述；旧页在切换后仍能取到上一个 build 的哈希资源。
  const staticNotFound = (relative: string): Response => {
    const contentType =
      STATIC_CONTENT_TYPES[extname(relative).toLowerCase()] ?? 'text/plain; charset=utf-8';
    return new Response('Not Found', {
      status: 404,
      headers: {
        'content-type': contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  };
  app.get('/static/*', async (c) => {
    let relative: string;
    try {
      relative = decodeURIComponent(c.req.path.slice('/static/'.length));
    } catch {
      return c.notFound();
    }
    if (relative.length === 0 || relative.includes('\0')) return c.notFound();

    if (webRelease) {
      const asset = webRelease.index.assets[relative];
      if (!asset) return staticNotFound(relative);
      const publicRoot = resolve(webRelease.publicDir);
      const path = resolve(publicRoot, relative);
      if (!path.startsWith(`${publicRoot}${sep}`)) return staticNotFound(relative);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return staticNotFound(relative);
      const etag = `"${asset.sha256}"`;
      const headers = {
        'content-type': asset.contentType,
        'cache-control': asset.immutable ? STATIC_CACHE_CONTROL : 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
        etag,
      };
      if (matchesEtag(c.req.header('if-none-match'), etag)) {
        return c.body(null, 304, headers);
      }
      return c.body(await Bun.file(path).arrayBuffer(), 200, headers);
    }

    const contentType = STATIC_CONTENT_TYPES[extname(relative).toLowerCase()];
    if (!contentType) return c.notFound();
    const path = resolve(spaDistDir, relative);
    if (!path.startsWith(`${spaDistDir}${sep}`)) return c.notFound();
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return c.notFound();
    const etag = `"${basename(path)}"`;
    const headers = {
      'content-type': contentType,
      'cache-control': STATIC_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      etag,
    };
    if (matchesEtag(c.req.header('if-none-match'), etag)) {
      return c.body(null, 304, headers);
    }
    return c.body(await Bun.file(path).arrayBuffer(), 200, headers);
  });
}

export function registerPublicAssetRoutes(app: Hono, deps: WebAssetDeps): void {
  const webRelease = deps.webRelease;
  // 运行中进程公告的是启动时固定的发布；切换指针但未重启时这里仍是旧值。
  // 未加载可用发布（兼容模式或构建缺失）返回 503，不公告候选版本。
  app.get('/web-version.json', (c) => {
    if (!webRelease) {
      return c.text('Web release unavailable', 503, { 'cache-control': 'no-store' });
    }
    return c.json(
      {
        deploymentId: webRelease.deploymentId,
        buildId: webRelease.manifest.buildId,
        minWebContract: webRelease.manifest.minWebContract,
        maxWebContract: webRelease.manifest.maxWebContract,
      },
      200,
      { 'cache-control': 'no-store' },
    );
  });

  // PWA 固定 URL：两种发布模式都由进程内生成的同一份字节提供。
  // manifest/sw 允许重新验证（no-cache + 内容 ETag）；图标 URL 含内容哈希，
  // 可安全使用一年 immutable。
  app.get('/manifest.webmanifest', (c) => {
    const headers = {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      etag: PWA_MANIFEST_ETAG,
    };
    if (matchesEtag(c.req.header('if-none-match'), PWA_MANIFEST_ETAG)) {
      return c.body(null, 304, headers);
    }
    return c.body(PWA_MANIFEST_BODY, 200, headers);
  });

  app.get('/sw.js', (c) => {
    const headers = {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'service-worker-allowed': '/',
      etag: PWA_SERVICE_WORKER_ETAG,
    };
    if (matchesEtag(c.req.header('if-none-match'), PWA_SERVICE_WORKER_ETAG)) {
      return c.body(null, 304, headers);
    }
    return c.body(PWA_SERVICE_WORKER_BODY, 200, headers);
  });

  app.get('/pwa/:file', async (c) => {
    const asset = pwaAssetForUrl(`/pwa/${c.req.param('file')}`);
    const notFound = () =>
      c.text('Not Found', 404, {
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
    if (!asset) return notFound();
    let bytes: ArrayBuffer;
    try {
      bytes = await readPwaAsset(asset);
    } catch {
      return notFound();
    }
    const etag = pwaAssetEtag(asset);
    const headers = {
      'content-type': asset.contentType,
      'cache-control': STATIC_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      etag,
    };
    if (matchesEtag(c.req.header('if-none-match'), etag)) {
      return c.body(null, 304, headers);
    }
    return c.body(bytes, 200, headers);
  });

  // 浏览器岛 bundle：React 仍从 `/assets/*` 懒加载 Markdown 与画板。
  // 4B-6 删除的 resizer/icons 返回 410，给仍缓存旧 HTML 的客户端明确迁移信号。
  const assets: Record<
    string,
    { body: string | null | undefined; version: string | null | undefined }
  > = {
    'chat-markdown.js': { body: deps.markdownAsset, version: deps.markdownAssetVersion },
    'chat-drawboard.js': { body: deps.drawboardAsset, version: deps.drawboardAssetVersion },
  };
  app.get('/assets/:name', async (c) => {
    const name = c.req.param('name');
    if (RETIRED_ASSETS.has(name)) {
      return c.text('This browser asset has been removed in 4B-6.', 410, {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
    }
    if (!LIVE_ASSETS.has(name)) return c.notFound();

    // 发布模式：固定别名只读取首次迁移冻结的基线字节，永不指向最新 build。
    if (webRelease) {
      const alias =
        name === 'chat-markdown.js'
          ? webRelease.legacy?.aliases['chat-markdown.js']
          : webRelease.legacy?.aliases['chat-drawboard.js'];
      if (!alias) return c.text('Not Found', 404, { 'cache-control': 'no-store' });
      const root = resolve(webRelease.root);
      const path = resolve(root, alias.file);
      if (!path.startsWith(`${root}${sep}`)) {
        return c.text('Not Found', 404, { 'cache-control': 'no-store' });
      }
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) {
        return c.text('Not Found', 404, { 'cache-control': 'no-store' });
      }
      const etag = `"${alias.sha256}"`;
      const headers = {
        'content-type': alias.contentType,
        'cache-control': `public, max-age=${LIMITS.webAliasCacheMaxAgeSeconds}`,
        'x-content-type-options': 'nosniff',
        etag,
      };
      if (matchesEtag(c.req.header('if-none-match'), etag)) {
        return c.body(null, 304, headers);
      }
      return c.body(await Bun.file(path).arrayBuffer(), 200, headers);
    }

    const asset = assets[name];
    const body = asset?.body;
    if (!body) {
      return c.text('Not Found', 404, { 'cache-control': 'no-store' });
    }
    return c.body(body, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': `public, max-age=${LIMITS.webAliasCacheMaxAgeSeconds}`,
      'x-content-type-options': 'nosniff',
      ...(asset.version ? { etag: `"${asset.version}"` } : {}),
    });
  });

  // 公开只读技能文档与 CLI bundle：只允许 public/skills 下的一层 .md，
  // 以及启动期内存构建的 agentnet.js；拒绝路径穿越。
  // 文件本身不含凭据；调用方自行通过 AGENTNET_TOKEN 提供 Bearer。
  // 旧 .sh 包装已删除，保留一个发布周期的 410；其他非法路径仍 404。
  app.get('/skills/:file', async (c) => {
    const file = c.req.param('file');
    if (RETIRED_SKILL_PATH.test(file)) return retiredSkillResponse();
    if (!/^[a-z0-9][a-z0-9._-]*\.md$/u.test(file) && file !== CLI_BUNDLE_FILENAME) {
      return c.notFound();
    }

    if (file === CLI_BUNDLE_FILENAME) {
      if (!deps.clientAsset) return c.notFound();
      const etag = deps.clientAssetVersion ? `"${deps.clientAssetVersion}"` : null;
      const headers = {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
        ...(etag ? { etag } : {}),
      };
      if (etag && matchesEtag(c.req.header('if-none-match'), etag)) {
        return c.body(null, 304, headers);
      }
      return c.body(deps.clientAsset, 200, headers);
    }

    const path = resolve(SKILLS_ROOT, file);
    if (!path.startsWith(`${SKILLS_ROOT}${sep}`)) return c.notFound();
    const source = await Bun.file(path).text().catch(() => null);
    if (source === null) return c.notFound();
    return c.body(source, 200, {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    });
  });

  // 本地品牌头像与授权说明：只允许 agent-icons 目录下的白名单文件，拒绝路径穿越。
  app.get('/agent-icons/:file', async (c) => {
    const file = c.req.param('file');
    if (!/^(?:[a-z0-9][a-z0-9-]*\.(?:svg|png)|LICENSE|ATTRIBUTION\.md)$/u.test(file)) {
      return c.notFound();
    }
    const path = resolve(AGENT_ICONS_ROOT, file);
    if (!path.startsWith(`${AGENT_ICONS_ROOT}${sep}`)) return c.notFound();
    const isPng = file.endsWith('.png');
    const body = await (isPng
      ? Bun.file(path).bytes()
      : Bun.file(path).text()
    ).catch(() => null);
    if (body === null) return c.notFound();
    return c.body(body, 200, {
      'content-type': isPng
        ? 'image/png'
        : file.endsWith('.svg')
          ? 'image/svg+xml; charset=utf-8'
          : 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
  });
}
