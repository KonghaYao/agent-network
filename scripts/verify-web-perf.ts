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
  return { humanToken, agentToken, agent, roomId };
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
    browser = await chromium.launch({ headless: true });
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
      await page.evaluate(`document.getElementById('messages').scrollTop = 0`);
      const advanced = await page
        .waitForFunction(
          `document.querySelectorAll('#messages .msg').length > ${before}`,
          undefined,
          { timeout: 20_000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!advanced) break;
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
    await context.close();

    const sortedOlder = olderDurations.slice().sort((a, b) => a - b);
    const medianOlder = sortedOlder.length
      ? sortedOlder[Math.floor(sortedOlder.length / 2)]
      : 0;
    const report = {
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
