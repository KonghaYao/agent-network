import type { Browser, BrowserContext, Page } from 'playwright';

import { rawRpc } from './harness';
import { reservePort, startTestServer } from './test-server';

const IGNORED_CONSOLE = ['Failed to load resource', 'net::ERR_'];

export async function rawTool<T>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await rawRpc('tools/call', { name, arguments: args }, { token });
  const result = response.body.result as
    | {
        isError?: boolean;
        structuredContent?: T;
        content?: { type: string; text?: string }[];
      }
    | undefined;
  if (!result) throw new Error(`工具 ${name} 无结果: ${JSON.stringify(response.body)}`);
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (result.isError) {
    let detail: { code?: string; message?: string } = {};
    if (text) {
      try {
        detail = JSON.parse(text) as { code?: string; message?: string };
      } catch {
        detail = { message: text };
      }
    }
    throw new Error(`${detail.code ?? 'UNKNOWN'}: ${detail.message ?? ''}`);
  }
  if (result.structuredContent) return result.structuredContent;
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function startServer(): Promise<{
  base: string;
  dataDir: string;
  stop: () => Promise<void>;
}> {
  // Playwright 需要 PUBLIC_ORIGIN 与访问地址一致，先预留端口再交给共享启动器；
  // 预留与绑定之间只有毫秒级窗口，避免多个套件用随机端口互相碰撞。
  const port = reservePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startTestServer({
    port,
    tag: 'web',
    env: {
      PUBLIC_ORIGIN: base,
      // 测试专用短宽限；生产默认仍由 contracts/limits.ts 决定。
      AGENT_PRESENCE_GRACE_MS: '1200',
      AGENT_PRESENCE_ACTIVITY_TTL_MS: '1200',
      AGENT_PRESENCE_TOUCH_THROTTLE_MS: '100',
      AGENT_PRESENCE_SWEEP_MS: '150',
    },
  });
  return {
    base: server.base,
    dataDir: server.dataDir,
    stop: () => server.dispose(),
  };
}

export function initScript(token: string, seedOnce = false): string {
  return `(() => {
  const TOKEN = ${JSON.stringify(token)};
  const SEED_ONCE = ${seedOnce ? 'true' : 'false'};
  let skipTokenSeed = false;
  if (SEED_ONCE) {
    try { skipTokenSeed = sessionStorage.getItem('__tokenSeeded') === '1'; } catch (error) {}
  }
  try {
    if (!skipTokenSeed) localStorage.setItem('agent-network-token', TOKEN);
    if (SEED_ONCE) sessionStorage.setItem('__tokenSeeded', '1');
    const prior = Number(sessionStorage.getItem('__spaMarker') || '0');
    window.__spaMarker = prior + 1;
    sessionStorage.setItem('__spaMarker', String(prior + 1));
    const loads = Number(sessionStorage.getItem('__loadCount') || '0');
    window.__loadCount = loads;
  } catch (error) {
    window.__spaMarker = 1;
    window.__loadCount = 0;
  }
  window.addEventListener('load', function () {
    window.__loadCount += 1;
    try { sessionStorage.setItem('__loadCount', String(window.__loadCount)); } catch (error) {}
  });
  window.__mcpCalls = [];
  window.__fetchLog = [];
  window.__delayMcp = null;
  window.__delayedMcpHit = false;
  window.__failStreams = false;
  window.__streamSignals = [];
  window.__abortControllers = [];
  const NativeAbortController = window.AbortController;
  window.AbortController = function TrackedAbortController() {
    const controller = new NativeAbortController();
    window.__abortControllers.push(controller);
    return controller;
  };
  window.AbortController.prototype = NativeAbortController.prototype;
  window.__abortStream = function () {
    for (let index = window.__abortControllers.length - 1; index >= 0; index -= 1) {
      const controller = window.__abortControllers[index];
      if (!controller.signal.aborted && window.__streamSignals.indexOf(controller.signal) >= 0) {
        controller.abort();
        return true;
      }
    }
    return false;
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const headers = (init && init.headers) || {};
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (error) {}
    const notifications = body && body.params && body.params.notifications;
    const subscriptions = notifications && notifications.resourceSubscriptions;
    const isStream = headers['mcp-method'] === 'subscriptions/listen' &&
      Array.isArray(subscriptions) && subscriptions.indexOf('agentnet://stream') >= 0;
    const call = {
      method: headers['mcp-method'] || null,
      name: headers['mcp-name'] || null,
      body: body,
      id: body && body.id,
      subscriptions: Array.isArray(subscriptions) ? subscriptions : null,
      // 只记录布尔值，避免把 token 放进可打印的调用记录。
      hasAuth: Boolean(headers['authorization']),
      humanAuth: headers['authorization'] === 'Bearer ' + TOKEN,
      stream: isStream,
      aborted: false,
      at: Date.now()
    };
    window.__mcpCalls.push(call);
    if (isStream && init && init.signal) {
      window.__streamSignals.push(init.signal);
      if (window.__failStreams) {
        call.failed = true;
        return Promise.reject(new TypeError('simulated stream failure'));
      }
    }
    const args = body && body.params && body.params.arguments;
    const roomId = args && args.room_id ? args.room_id : null;
    const log = function (phase, detail) {
      window.__fetchLog.push({
        name: call.name || call.method,
        roomId: roomId,
        phase: phase,
        detail: detail === undefined ? null : detail,
        at: Date.now()
      });
    };
    log('call');
    if (init && init.signal) {
      if (init.signal.aborted) call.aborted = true;
      else init.signal.addEventListener('abort', function () { call.aborted = true; log('aborted'); }, { once: true });
    }
    const delay = window.__delayMcp;
    const shouldDelay = Boolean(
      delay && call.name === delay.name && (!delay.roomId || roomId === delay.roomId)
    );
    if (shouldDelay) window.__delayedMcpHit = true;
    return originalFetch(input, init).then(
      function (response) {
        log('resolved', response.status);
        if (!shouldDelay) return response;
        log('delaying-response');
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(response); }, delay.ms);
        });
      },
      function (error) { log('rejected', error && error.name); throw error; }
    );
  };
})();`;
}

export async function makeContext(
  browser: Browser,
  token: string,
  viewport: { width: number; height: number },
  allErrors: string[],
  watchConsole = true,
  seedTokenOnce = false,
  contextOptions: { colorScheme?: 'dark' | 'light'; hasTouch?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, ...contextOptions });
  await context.addInitScript({ content: initScript(token, seedTokenOnce) });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const recordError = (message: string): void => {
    const safe = message.replace(/([?&]token=)[^&\s]+/g, '$1[redacted]');
    allErrors.push(safe);
    console.error('Browser error at', page.url().split(/[?#]/)[0], safe);
  };
  page.on('pageerror', (error) => recordError(`pageerror: ${error.stack || error.message}`));
  if (watchConsole) {
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (IGNORED_CONSOLE.some((part) => text.includes(part))) return;
      recordError(`console: ${text}`);
    });
  }
  return { context, page };
}
