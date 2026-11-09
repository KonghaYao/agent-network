/**
 * 长上下文网页性能基准。
 *
 * 默认 500 条消息；`PERF_WEB_MESSAGES=2000` 为手动档。
 * 复用 `scripts/verify-web.ts` 的自托管实例、浏览器上下文与 __mcpCalls 观测。
 *
 * 指标：
 * - 首屏（50 条）与加载完全部历史后的 `.msg-markdown` root 数；
 * - `#messages *` 节点数；
 * - PerformanceObserver longtask 数量/总时长/最大值；
 * - 每页“加载更早”耗时（从 scrollTop=0 到消息数增加）。
 *
 * 运行：
 *   bun run test:web:perf
 *   PERF_WEB_MESSAGES=2000 bun run test:web:perf
 *   PERF_WEB_ASSERT=0 bun run test:web:perf --out reports/evidence/web-perf-baseline.json
 *
 * 这是本机同 fixture 的前后对比，不代表线上 RTT；数字写入报告，不进入常规门禁。
 */

import { chromium, type Browser } from 'playwright';

import { makeContext, rawTool, startServer } from './verify-web';

const TARGET_MESSAGES = Number(process.env.PERF_WEB_MESSAGES || '500');
const ASSERT = process.env.PERF_WEB_ASSERT !== '0';
const OUT_ARG = process.argv.indexOf('--out');
const OUT_PATH = OUT_ARG >= 0 ? process.argv[OUT_ARG + 1] : null;

interface Actor {
  actor_id: string;
  name: string;
  agent_session_id?: string | null;
}

interface RoomDetail {
  room: { room_id: string; title?: string; head_seq: string };
}

interface PhaseMetrics {
  messages: number;
  markdown_roots: number;
  message_dom_nodes: number;
  long_tasks: number;
  long_task_total_ms: number;
  long_task_max_ms: number;
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function rawBefriend(
  requesterToken: string,
  targetToken: string,
  target: { actor_id?: string; agent_session_id?: string },
): Promise<void> {
  const requested = await rawTool<{
    status: string;
    request: { contact_request_id: string } | null;
  }>(requesterToken, 'network_contact_request', {
    request_id: requestId('contact_request'),
    ...(target.actor_id
      ? { actor_id: target.actor_id }
      : { agent_session_id: target.agent_session_id }),
  });
  if (requested.status === 'accepted') return;
  if (!requested.request) throw new Error(`好友申请未进入 pending: ${requested.status}`);
  await rawTool(targetToken, 'network_contact_request_respond', {
    request_id: requestId('contact_accept'),
    contact_request_id: requested.request.contact_request_id,
    action: 'accept',
  });
}

function agentBody(index: number, agentName: string): string {
  if (index % 10 === 0) {
    return [
      `**Agent 性能消息 ${index}**`,
      `@${agentName} 请处理`,
      '',
      '| 列 | 值 |',
      '| --- | --- |',
      `| ${index} | perf |`,
      '',
      '```ts',
      `const perf${index} = ${index};`,
      '```',
      `附件链接：https://example.com/f/f_perf_${index}`,
    ].join('\n');
  }
  if (index % 3 === 0) {
    return `**Agent 性能消息 ${index}**\n\n普通 Markdown 内容 ${index}`;
  }
  return `Agent 性能消息 ${index}\n第二行内容 ${index}`;
}

async function seed(serverBase: string): Promise<{
  humanToken: string;
  agentToken: string;
  agent: Actor;
  roomId: string;
  alternateRoomId: string;
}> {
  process.env.AGENTNET_URL = serverBase;
  const humanToken = crypto.randomUUID();
  await rawTool<Actor>(humanToken, 'network_register', {
    request_id: requestId('perf_reg'),
    kind: 'human',
    name: '性能验收人类',
  });
  const agentToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
  const agent = await rawTool<Actor>(agentToken, 'network_register', {
    request_id: requestId('perf_reg'),
    kind: 'agent',
    name: '性能验收 Agent',
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  await rawBefriend(humanToken, agentToken, {
    agent_session_id: agent.agent_session_id ?? undefined,
  });
  const room = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('perf_room'),
    kind: 'group',
    title: '长上下文性能群',
    members: [agent.actor_id],
  });
  const roomId = room.room.room_id;
  for (let index = 1; index <= TARGET_MESSAGES; index += 1) {
    // 70% Agent，30% 人类；Agent 消息覆盖 Markdown/代码/表格/@/链接。
    const fromAgent = index % 10 < 7;
    await rawTool(fromAgent ? agentToken : humanToken, 'network_message_send', {
      request_id: requestId('perf_msg'),
      client_message_id: crypto.randomUUID(),
      room_id: roomId,
      ...(fromAgent ? { invoke: [] } : {}),
      body: fromAgent ? agentBody(index, agent.name) : `人类性能消息 ${index}`,
    });
    if (index % 100 === 0) console.log(`seed: ${index}/${TARGET_MESSAGES}`);
  }
  const alternate = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('perf_alternate'), kind: 'direct', members: [agent.actor_id],
  });
  return { humanToken, agentToken, agent, roomId, alternateRoomId: alternate.room.room_id };
}

async function readMetrics(page: import('playwright').Page, since: number): Promise<PhaseMetrics> {
  return page.evaluate(`(() => {
    const tasks = (window.__longTasks || []).filter(function (entry) { return entry.start >= ${since}; });
    let total = 0;
    let max = 0;
    for (const task of tasks) {
      total += task.duration;
      if (task.duration > max) max = task.duration;
    }
    const messages = document.getElementById('messages');
    const scroller = messages || document;
    return {
      messages: messages ? messages.querySelectorAll('.msg').length : 0,
      markdown_roots: messages ? messages.querySelectorAll('.msg-markdown').length : 0,
      message_dom_nodes: messages ? messages.querySelectorAll('*').length : 0,
      long_tasks: tasks.length,
      long_task_total_ms: Math.round(total * 10) / 10,
      long_task_max_ms: Math.round(max * 10) / 10
    };
  })()`) as Promise<PhaseMetrics>;
}

async function main(): Promise<void> {
  const server = await startServer();
  process.env.AGENTNET_URL = server.base;
  let browser: Browser | null = null;
  const allErrors: string[] = [];
  try {
    const data = await seed(server.base);
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
    const { context, page } = await makeContext(
      browser,
      data.humanToken,
      { width: 1280, height: 900 },
      allErrors,
    );
    await context.addInitScript({
      content: `(() => {
        window.__longTasks = [];
        try {
          new PerformanceObserver(function (list) {
            for (const entry of list.getEntries()) {
              window.__longTasks.push({ start: entry.startTime, duration: entry.duration });
            }
          }).observe({ entryTypes: ['longtask'] });
        } catch (error) {}
      })();`,
    });
    const navigationStart = Date.now();
    await page.goto(`${server.base}/c/${data.roomId}`);
    await page.waitForFunction(
      `document.querySelectorAll('#messages .msg').length >= 50`,
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForFunction(
      `(() => {
        const node = document.getElementById('messages');
        return node && node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
      })()`,
      undefined,
      { timeout: 15_000 },
    );
    // 等可见区 Markdown 首轮升级稳定。
    await page.waitForFunction(
      `document.querySelectorAll('#messages .msg-markdown').length >= 1`,
      undefined,
      { timeout: 20_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    const initial = await readMetrics(page, 0);

    const olderDurations: number[] = [];
    for (let pageIndex = 1; pageIndex <= 60; pageIndex += 1) {
      const before = await page.locator('#messages .msg').count();
      if (before >= TARGET_MESSAGES) break;
      const started = Date.now();
      await page.locator('#messages').hover();
      const delta = await page.locator('#messages').evaluate((element) => -element.scrollTop - element.clientHeight);
      await page.mouse.wheel(0, delta);
      const advanced = await page
        .waitForFunction(
          `document.querySelectorAll('#messages .msg').length > ${before}`,
          undefined,
          { timeout: 20_000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!advanced) {
        console.log('older-page-stalled', await page.evaluate("JSON.stringify({count:currentItems.length,olderEnded,olderError,olderLoading,top:messagesElement.scrollTop,hasCursor:Boolean(nextOlder)})"));
        break;
      }
      // 等本页基本补齐（末页可能不足 20 条，超时也继续记录）。
      await page
        .waitForFunction(
          `document.querySelectorAll('#messages .msg').length >= ${Math.min(
            TARGET_MESSAGES,
            before + 20,
          )}`,
          undefined,
          { timeout: 5_000 },
        )
        .catch(() => undefined);
      olderDurations.push(Date.now() - started);
      // 让 prepend 锚点恢复与懒 Markdown 队列完成后再触发下一页。
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // 回到最新，让可见区升级后再统计“全量已加载”状态。
    await page.evaluate(`(() => {
      const node = document.getElementById('messages');
      if (node) node.scrollTop = node.scrollHeight;
    })()`);
    await page.waitForFunction(
      `(() => {
        const node = document.getElementById('messages');
        return node && node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
      })()`,
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForFunction(
      `document.querySelectorAll('#messages .msg-markdown').length >= 1`,
      undefined,
      { timeout: 20_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    const full = await readMetrics(page, 0);
    const loadElapsed = Date.now() - navigationStart;
    const scriptEvaluated = await page.evaluate(
      `(window.__mcpCalls || []).filter(function (call) {
        return call.name === 'network_history_list' && call.body &&
          call.body.params && call.body.params.arguments &&
          call.body.params.arguments.cursor;
      }).length`,
    );
    // Measure actual refresh work after long-history paging, not just the first page.
    const refreshSamples: { duration_ms: number; retained_nodes: number; total_nodes: number }[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      refreshSamples.push(await page.evaluate(`(async () => {
        const nodes = Array.from(document.querySelectorAll('#messages .msg'));
        const started = performance.now();
        await refresh(true);
        return { duration_ms: Math.round((performance.now()-started)*10)/10,
          retained_nodes: nodes.filter(node=>node.isConnected).length, total_nodes:nodes.length };
      })()`));
    }
    // Switch away while reading the middle of a fully loaded timeline, then
    // return through the visible conversation list and verify the exact anchor.
    await page.waitForTimeout(350);
    await page.locator('#messages').hover();
    const readingDelta = await page.locator('#messages').evaluate((element) => -(element.scrollHeight - element.clientHeight) / 2);
    await page.mouse.wheel(0, readingDelta);
    await page.waitForTimeout(350);
    const captureAnchor = () => page.locator('#messages').evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      const node = Array.from(element.querySelectorAll('[data-message-id]')).find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      return { message_id: node?.getAttribute('data-message-id'),
        offset: node ? node.getBoundingClientRect().top - viewport.top : null };
    });
    await page.evaluate(`(() => {
      window.__restoreTrace = [];
      const restore = scrollController.restorePosition;
      scrollController.restorePosition = function(top, pinned, anchor) {
        const snapshot = (phase) => {
          const node = Array.from(messagesElement.children).find(node => node.dataset.messageId === anchor?.messageId);
          window.__restoreTrace.push({ phase, top: messagesElement.scrollTop, height: messagesElement.scrollHeight,
            target: anchor, offset: node ? node.getBoundingClientRect().top - messagesElement.getBoundingClientRect().top : null });
        };
        snapshot('before'); restore(top, pinned, anchor); snapshot('immediate');
        requestAnimationFrame(() => snapshot('frame')); setTimeout(() => snapshot('settled'), 450);
      };
    })()`);
    const anchorBefore = await captureAnchor();
    console.log('before-cache-switch', JSON.stringify({ full, anchorBefore }));
    await page.getByRole('tab', { name: '单聊', exact: true }).click();
    await page.locator('#room-list a[href="/c/' + data.alternateRoomId + '"]').click();
    await page.waitForFunction(() => document.querySelector('#chat-body')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('tab', { name: '群聊', exact: true }).click();
    const switchStarted = Date.now();
    await page.locator('#room-list a[href="/c/' + data.roomId + '"]').click();
    await page.waitForFunction((target) => document.querySelectorAll('#messages .msg').length === target, TARGET_MESSAGES).catch(async (error) => {
      console.log('cache-switch-failure', await page.evaluate("JSON.stringify({count:currentItems.length,pinned:scrollController.isPinned(),cached:roomCache.get(activeRoomId)?.items.length,head:document.getElementById('title')?.textContent})"));
      throw error;
    });
    const switchDuration = Date.now() - switchStarted;
    await page.waitForTimeout(500);
    const anchorAfter = await captureAnchor();
    const cacheSwitch = { duration_ms: switchDuration, retained_messages: await page.locator('#messages .msg').count(),
      before: anchorBefore, after: anchorAfter, anchor_preserved: Boolean(anchorBefore.message_id) &&
        anchorBefore.message_id === anchorAfter.message_id && Math.abs(Number(anchorBefore.offset) - Number(anchorAfter.offset)) <= 3 };
    const topBeforeUserScroll = await page.locator('#messages').evaluate(element => element.scrollTop);
    await page.locator('#messages').hover();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(350);
    const topAfterUserScroll = await page.locator('#messages').evaluate(element => element.scrollTop);
    await page.waitForTimeout(500);
    const topSettled = await page.locator('#messages').evaluate(element => element.scrollTop);
    const userScroll = { before: topBeforeUserScroll, after: topAfterUserScroll, settled: topSettled,
      respected: topAfterUserScroll - topBeforeUserScroll > 100 && Math.abs(topSettled - topAfterUserScroll) <= 3 };
    const restoreTrace = await page.evaluate('window.__restoreTrace || []');
    await context.close();

    const sortedOlder = olderDurations.slice().sort((a, b) => a - b);
    const medianOlder = sortedOlder.length
      ? sortedOlder[Math.floor(sortedOlder.length / 2)]
      : 0;
    const report = {
      refresh_samples: refreshSamples,
      cache_switch: cacheSwitch,
      restore_trace: restoreTrace,
      user_scroll: userScroll,
      target_messages: TARGET_MESSAGES,
      loaded_messages: full.messages,
      page_size: 50,
      history_pages: scriptEvaluated,
      initial,
      full,
      load_elapsed_ms: loadElapsed,
      older_page_ms: {
        samples: olderDurations.length,
        median: medianOlder,
        max: olderDurations.length ? Math.max(...olderDurations) : 0,
        all: olderDurations,
      },
      page_errors: allErrors,
      assertions: ASSERT,
    };
    const json = JSON.stringify(report, null, 2);
    console.log(json);
    if (OUT_PATH) await Bun.write(OUT_PATH, json + '\n');

    if (ASSERT) {
      const failures: string[] = [];
      if (full.messages !== TARGET_MESSAGES) failures.push('历史未完整加载');
      if (!cacheSwitch.anchor_preserved) failures.push('长缓存切回未恢复阅读锚点');
      if (!userScroll.respected) failures.push('缓存恢复后用户滚动被旧锚点覆盖');
      if (cacheSwitch.duration_ms > 5000) failures.push('长缓存切回超过5秒');
      if (allErrors.length) failures.push('浏览器出现脚本错误');
      if (initial.markdown_roots < 1) failures.push('首屏没有可见 Markdown root');
      if (initial.markdown_roots >= 50) {
        failures.push(`首屏 Markdown root 过多: ${initial.markdown_roots}`);
      }
      if (full.markdown_roots >= Math.floor(full.messages / 2)) {
        failures.push(
          `长历史 Markdown root 未收敛: ${full.markdown_roots}/${full.messages}`,
        );
      }
      if (full.message_dom_nodes <= full.messages * 5) {
        failures.push(`消息 DOM 节点异常: ${full.message_dom_nodes}`);
      }
      const slowestOlder = olderDurations.length ? Math.max(...olderDurations) : 0;
      if (slowestOlder > 5_000) failures.push(`加载更早单页超过 5s: ${slowestOlder}ms`);
      if (failures.length > 0) {
        throw new Error('web perf 断言失败:\n' + failures.join('\n'));
      }
      console.log(
        `web perf PASS: messages=${full.messages} roots=${initial.markdown_roots}->${full.markdown_roots} ` +
          `dom=${full.message_dom_nodes} olderMedian=${medianOlder}ms`,
      );
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await server.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
