/**
 * 4B-6 验收：Vite manifest、`/static/*`、SSR 壳与 legacy 资源退役。
 *
 * 4B-6 删除 legacy 页面壳后不再有 `WEB_SPA_ROUTES` 灰度；五条页面路由
 * 始终由 React 壳渲染。manifest 缺失时页面返回 503，而不是静默回退。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadSpaManifest } from '../src/web/spa-manifest';
import { check, checkEqual, checksPassed } from './lib/harness';
import { startTestServer, type TestServer } from './lib/test-server';

const DIST = resolve(import.meta.dir, '../dist/web');
const MANIFEST = resolve(DIST, '.vite/manifest.json');

async function fetchText(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  return { response, text: await response.text() };
}

async function missingManifest(): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentnet-spa-missing-'));
  try {
    return await loadSpaManifest(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function brokenManifest(): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentnet-spa-broken-'));
  try {
    await mkdir(resolve(dir, '.vite'), { recursive: true });
    await writeFile(
      resolve(dir, '.vite/manifest.json'),
      JSON.stringify({
        'src/web/app/main.tsx': { file: 'assets/missing.js', isEntry: true },
      }),
    );
    return await loadSpaManifest(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

interface RegisteredAgent {
  actor_id: string;
  agent_session_id: string;
}

/** 通过真实 MCP 注册 Agent，拿到可访问 /a/<session> 的 session 与 token。 */
async function registerAgent(base: string): Promise<RegisteredAgent & { token: string }> {
  const token = crypto.randomUUID();
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'network_register',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name: 'network_register',
        arguments: {
          request_id: requestId('spa_reg'),
          kind: 'agent',
          name: 'SPA 分享',
          agent_session_id: `sess_spa_${crypto.randomUUID().replaceAll('-', '')}`,
        },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'agent-network-spa-test',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const payload = (await response.json()) as {
    result?: { structuredContent?: RegisteredAgent; isError?: boolean };
  };
  const identity = payload.result?.structuredContent;
  if (!identity?.agent_session_id) throw new Error('注册 Agent 失败');
  return { ...identity, token };
}

function bootstrapJson(html: string): Record<string, unknown> | null {
  const match = /<script type="application\/json" id="spa-bootstrap">([\s\S]*?)<\/script>/u.exec(html);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function main() {
  check('dist manifest exists (run bun run build:web first)', await Bun.file(MANIFEST).exists());
  checkEqual('missing manifest returns null', await missingManifest(), null);
  checkEqual('broken manifest returns null', await brokenManifest(), null);

  const manifest = await loadSpaManifest(DIST);
  check('real manifest loads', manifest !== null);
  if (!manifest) throw new Error('manifest 未加载');
  check('entry points at /static', manifest.entry.startsWith('/static/'), manifest.entry);
  check(
    'css entries point at /static',
    manifest.css.every((href) => href.startsWith('/static/')),
    manifest.css,
  );

  let spa: TestServer | undefined;
  let fallback: TestServer | undefined;
  let emptyDist: string | undefined;
  try {
    spa = await startTestServer({
      tag: 'spa-shell',
      env: { ENVIRONMENT: 'test', WEB_DIST_DIR: DIST },
    });

    // 静态资源：白名单、不可变缓存、ETag/304、拒绝 manifest 与路径穿越。
    const asset = await fetchText(`${spa.base}${manifest.entry}`);
    checkEqual('static asset status', asset.response.status, 200);
    checkEqual(
      'static asset content-type',
      asset.response.headers.get('content-type'),
      'text/javascript; charset=utf-8',
    );
    checkEqual(
      'static asset cache-control',
      asset.response.headers.get('cache-control'),
      'public, max-age=31536000, immutable',
    );
    checkEqual('static asset nosniff', asset.response.headers.get('x-content-type-options'), 'nosniff');
    const etag = asset.response.headers.get('etag');
    check('static asset has etag', typeof etag === 'string' && etag.length > 2, etag);
    const notModified = await fetch(`${spa.base}${manifest.entry}`, {
      headers: { 'if-none-match': etag ?? '' },
    });
    checkEqual('static asset 304 on etag match', notModified.status, 304);
    checkEqual(
      'static json is not served',
      (await fetch(`${spa.base}/static/.vite/manifest.json`)).status,
      404,
    );
    checkEqual(
      'static directory is not listed',
      (await fetch(`${spa.base}/static/assets/`)).status,
      404,
    );
    checkEqual(
      'static path traversal rejected',
      (await fetch(`${spa.base}/static/..%2f..%2fpackage.json`)).status,
      404,
    );

    // 五条页面路由始终输出 React 壳；灰度 query/cookie 不再生效。
    for (const [path, route] of [
      ['/', 'home'],
      ['/c/room-test', 'room'],
      ['/pair', 'pair'],
    ] as const) {
      const page = await fetchText(`${spa.base}${path}`);
      checkEqual(`${route} status`, page.response.status, 200);
      check(
        `${route} renders the React shell`,
        page.text.includes(`data-spa-route="${route}"`) &&
          page.text.includes('<div id="root"></div>') &&
          page.text.includes('id="spa-bootstrap"'),
      );
      checkEqual(`${route} no-store`, page.response.headers.get('cache-control'), 'no-store');
      check(`${route} has no legacy spa cookie`, page.response.headers.get('set-cookie') === null);
      check(`${route} has no credential`, !/ank_[0-9a-z]{32}/iu.test(page.text));
    }
    const home = await fetchText(`${spa.base}/`);
    check(
      'home no longer embeds the legacy client',
      !home.text.includes('initialRoomId') &&
        !home.text.includes('id="composer"') &&
        !home.text.includes('id="room-search"'),
    );
    checkEqual(
      'spa=0 no longer restores a legacy page',
      (await fetchText(`${spa.base}/?spa=0`)).text.includes('data-spa-route="home"'),
      true,
    );
    const cookieHome = await fetchText(`${spa.base}/`, {
      cookie: 'agent-network-spa=room',
    });
    check(
      'spa cookie is ignored',
      cookieHome.text.includes('data-spa-route="home"') &&
        cookieHome.response.headers.get('set-cookie') === null,
    );
    const chat = await fetchText(`${spa.base}/c/room-test`);
    check(
      'room renders the chat shell',
      chat.text.includes('data-spa-route="room"') &&
        chat.text.includes('class="wide page-room"') &&
        !chat.text.includes('initialRoomId'),
    );

    // 分享/邀请/配对：SSR 静态标记保留，HTML 不含 token 或私有数据。
    const agent = await registerAgent(spa.base);
    const share = await fetchText(`${spa.base}/a/${encodeURIComponent(agent.agent_session_id)}`);
    checkEqual('share status', share.response.status, 200);
    check(
      'share is server-rendered with public data',
      share.text.includes('data-spa-route="share"') &&
        share.text.includes('class="page-share"') &&
        share.text.includes('id="add"') &&
        share.text.includes(agent.actor_id) &&
        share.text.includes('发送好友申请'),
    );
    check(
      'share keeps title and OG metadata',
      share.text.includes('<title>添加 SPA 分享 · WeBots</title>') &&
        share.text.includes('property="og:title"') &&
        share.text.includes('property="og:description"'),
    );
    check(
      'share does not leak token or legacy client',
      !share.text.includes(agent.token) &&
        !share.text.includes('agent-network-token=') &&
        !share.text.includes('id="room-search"'),
    );
    const shareBootstrap = bootstrapJson(share.text);
    check(
      'share bootstrap only carries public profile',
      shareBootstrap?.route === 'share' &&
        (shareBootstrap.actor as { actor_id?: string } | null)?.actor_id === agent.actor_id &&
        !JSON.stringify(shareBootstrap).includes(agent.token),
    );

    const missingShare = await fetchText(`${spa.base}/a/missing_${crypto.randomUUID()}`);
    checkEqual('share unknown session is 404', missingShare.response.status, 404);
    check(
      'share 404 keeps the React shell',
      missingShare.text.includes('data-spa-route="share"') &&
        missingShare.text.includes('分享链接无效'),
    );

    const joinPage = await fetchText(`${spa.base}/j/${'b'.repeat(32)}`);
    checkEqual('join status', joinPage.response.status, 200);
    check(
      'join is an SSR shell without group data',
      joinPage.text.includes('data-spa-route="join"') &&
        joinPage.text.includes('class="page-join"') &&
        joinPage.text.includes('id="join-action"') &&
        joinPage.text.includes('邀请码有效不等于已加入') &&
        !joinPage.text.includes('join-title">群聊'),
    );
    check(
      'join bootstrap carries invite key',
      (bootstrapJson(joinPage.text)?.inviteKey as string | undefined) === 'b'.repeat(32),
    );
    const invalidJoin = await fetchText(`${spa.base}/j/not-a-valid-key`);
    checkEqual('join invalid key is 404', invalidJoin.response.status, 404);
    check(
      'join 404 keeps the React shell',
      invalidJoin.text.includes('data-spa-route="join"') &&
        invalidJoin.text.includes('邀请无效'),
    );

    const pair = await fetchText(`${spa.base}/pair`);
    checkEqual('pair status', pair.response.status, 200);
    check(
      'pair is a CSR card shell without challenge',
      pair.text.includes('data-spa-route="pair"') &&
        pair.text.includes('class="page-pair"') &&
        pair.text.includes('<div id="root"></div>') &&
        !pair.text.includes('id="pair-challenge"'),
    );
    checkEqual(
      'pair keeps no-referrer',
      pair.response.headers.get('referrer-policy'),
      'no-referrer',
    );

    // 4B-6 资源退役：Markdown/画板仍被 React 懒加载；旧 resizer/icons 返回 410。
    const markdown = await fetch(`${spa.base}/assets/chat-markdown.js`);
    checkEqual('markdown asset still served', markdown.status, 200);
    const drawboard = await fetch(`${spa.base}/assets/chat-drawboard.js`);
    checkEqual('drawboard asset still served', drawboard.status, 200);
    for (const retired of ['chat-resizer.js', 'chat-icons.js']) {
      const response = await fetch(`${spa.base}/assets/${retired}`);
      checkEqual(`${retired} returns 410`, response.status, 410);
      checkEqual(`${retired} is not cached`, response.headers.get('cache-control'), 'no-store');
    }
    checkEqual(
      'unknown asset returns 404',
      (await fetch(`${spa.base}/assets/unknown.js`)).status,
      404,
    );

    // manifest 缺失：页面 503，API/健康检查与浏览器岛不受影响。
    emptyDist = await mkdtemp(join(tmpdir(), 'agentnet-spa-empty-'));
    fallback = await startTestServer({
      tag: 'spa-no-manifest',
      env: { ENVIRONMENT: 'test', WEB_DIST_DIR: emptyDist },
    });
    for (const path of ['/', '/c/room-test', '/a/sess_missing', '/j/abcdefghijklmnop', '/pair']) {
      const response = await fetch(`${fallback.base}${path}`);
      checkEqual(`missing manifest ${path} returns 503`, response.status, 503);
      checkEqual(
        `missing manifest ${path} is not cached`,
        response.headers.get('cache-control'),
        'no-store',
      );
    }
    checkEqual('health still works without manifest', (await fetch(`${fallback.base}/health`)).status, 200);
    checkEqual(
      'markdown bundle is independent of the manifest',
      (await fetch(`${fallback.base}/assets/chat-markdown.js`)).status,
      200,
    );
  } finally {
    await Promise.all([spa?.dispose(), fallback?.dispose()]);
    if (emptyDist) await rm(emptyDist, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\nspa shell checks passed: ${checksPassed()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
