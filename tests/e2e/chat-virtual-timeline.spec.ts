import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 虚拟时间线 P0 验收：DOM 上限、prepend 锚定、跳转、已读水位与移动端。
 *
 * 默认种子 400 条；用 `E2E_VIRTUAL_MESSAGES=1000|3000|5000` 跑规模基线。
 * 报告只依赖确定性指标（条数、节点数、锚点漂移），帧率仅记录不门禁。
 */

const TOTAL = Math.max(60, Number(process.env.E2E_VIRTUAL_MESSAGES ?? 400));

async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const file = resolve(process.cwd(), '.e2e/server.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { base?: unknown };
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

interface ToolEnvelope {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
}

async function callTool<T>(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'agent-network-e2e',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: ToolEnvelope;
  };
  if (payload.error) throw new Error(payload.error.message ?? 'MCP 调用失败');
  const result = payload.result;
  if (!result) throw new Error('MCP 响应缺少 result');
  if (result.isError === true) {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(text ?? '工具调用失败');
  }
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP 响应缺少正文');
  return JSON.parse(text) as T;
}

interface Registered {
  actor_id: string;
  name: string;
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

interface RoomsList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface RoomDetail {
  room: { room_id: string; my_last_read_seq: string; head_seq: string };
}

interface HistoryPage {
  items: { message_id: string; created_seq: string }[];
}

async function registerHuman(
  base: string,
  name: string,
  device: string,
): Promise<{ token: string; actor: Registered }> {
  const token = crypto.randomUUID();
  const actor = await callTool<Registered>(base, token, 'network_register', {
    request_id: requestId('virt_reg'),
    kind: 'human',
    name,
    device_id: device,
  });
  return { token, actor };
}

async function befriend(
  base: string,
  fromToken: string,
  peer: Registered,
  peerToken: string,
): Promise<string> {
  const contact = await callTool<ContactRequestResult>(base, fromToken, 'network_contact_request', {
    request_id: requestId('virt_contact'),
    actor_id: peer.actor_id,
  });
  const contactRequestId = contact.request?.contact_request_id;
  if (!contactRequestId) throw new Error('好友申请未创建');
  await callTool(base, peerToken, 'network_contact_request_respond', {
    request_id: requestId('virt_contact'),
    contact_request_id: contactRequestId,
    action: 'accept',
  });
  const rooms = await callTool<RoomsList>(base, fromToken, 'network_rooms_list', { limit: 50 });
  const direct = rooms.items.find(
    (room) => room.kind === 'direct' && room.peer?.actor_id === peer.actor_id,
  );
  if (!direct) throw new Error('好友通过后未生成 direct 会话');
  return direct.room_id;
}

async function seedMessages(
  base: string,
  token: string,
  roomId: string,
  count: number,
): Promise<void> {
  const batch = 25;
  for (let start = 1; start <= count; start += batch) {
    await Promise.all(
      Array.from({ length: Math.min(batch, count - start + 1) }, (_, offset) => {
        const index = start + offset;
        const body =
          index % 17 === 0
            ? `## 虚拟时间线报告 ${index}\n\n- 第一条\n- 第二条\n- 第三条`
            : index % 41 === 0
              ? `虚拟时间线长消息 ${index}\n\n${'长段落内容。'.repeat(90)}`
              : `虚拟时间线消息 ${index}`;
        return callTool(base, token, 'network_message_send', {
          request_id: requestId('virt_seed'),
          client_message_id: crypto.randomUUID(),
          room_id: roomId,
          invoke: [],
          body,
        });
      }),
    );
  }
}

async function openRoom(page: Page, roomId: string): Promise<void> {
  const origin = await baseUrl();
  await page.goto(`${origin}/c/${roomId}`);
  await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
  await expect(page.locator('#messages')).toHaveAttribute('data-timeline-mode', 'virtual');
  await expect.poll(() => loadedCount(page), { timeout: 20_000 }).toBe(50);
  await expect(page.locator('#messages')).toHaveAttribute('data-loaded-ready', 'true');
}

async function loadedCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const node = document.getElementById('messages');
    return Number(node?.getAttribute('data-loaded-message-count') ?? '0');
  });
}

async function domNodeCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.getElementById('messages')?.querySelectorAll('*').length ?? 0,
  );
}

async function bottomGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const node = document.getElementById('messages');
    return node ? node.scrollHeight - node.scrollTop - node.clientHeight : 0;
  });
}

async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const node = document.getElementById('messages');
    if (!node) return;
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -800, bubbles: true }));
    node.scrollTop = 0;
  });
}

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const node = document.getElementById('messages');
    if (node) node.scrollTop = node.scrollHeight;
  });
  await expect.poll(() => bottomGap(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
}

/**
 * 真实触摸滚动手势（移动端）。`yDistance > 0` 表示手指向下拖（看更早的
 * 消息），`< 0` 表示向底部 fling。CDP 手势会派发 touchstart/touchmove/
 * touchend，因此同时覆盖“手势门控”和真实滚动。
 */
async function touchScroll(page: Page, yDistance: number, speed = 2_000): Promise<void> {
  const box = await page.locator('#messages').boundingBox();
  if (!box) throw new Error('缺少消息区');
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.synthesizeScrollGesture', {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      yDistance,
      speed,
      gestureSourceType: 'touch',
    });
  } finally {
    await cdp.detach();
  }
}

async function messageBox(page: Page): Promise<{
  top: number;
  maxTop: number;
  gap: number;
  pinned: string | null;
  atBottom: string | null;
  jumpHidden: boolean;
  lastVisible: boolean;
}> {
  return page.evaluate(() => {
    const node = document.getElementById('messages');
    if (!node) throw new Error('缺少 #messages');
    const rect = node.getBoundingClientRect();
    const last = Array.from(node.querySelectorAll('.msg[data-message-id]')).at(-1);
    const lastRect = last?.getBoundingClientRect();
    return {
      top: node.scrollTop,
      maxTop: Math.max(0, node.scrollHeight - node.clientHeight),
      gap: node.scrollHeight - node.scrollTop - node.clientHeight,
      pinned: node.getAttribute('data-virt-pinned'),
      atBottom: node.getAttribute('data-virt-at-bottom'),
      jumpHidden: document.getElementById('jump-latest')?.hasAttribute('hidden') ?? true,
      lastVisible: lastRect ? lastRect.bottom <= rect.bottom + 1 : false,
    };
  });
}

async function loadOlderUntil(page: Page, target: number): Promise<void> {
  while ((await loadedCount(page)) < target) {
    const before = await loadedCount(page);
    await page.evaluate(() => {
      (document.getElementById('older') as HTMLButtonElement | null)?.click();
    });
    await expect.poll(() => loadedCount(page), { timeout: 20_000 }).toBeGreaterThan(before);
  }
}

interface BottomFrame {
  top: number;
  height: number;
  gap: number;
}

interface BottomProbeReport {
  frames: number;
  minTop: number;
  maxTop: number;
  range: number;
  /** 采样期间 scrollHeight 的最大增长；用于确认长追加真的发生了高度变化。 */
  heightGrowth: number;
  scrollEvents: number;
  maxGap: number;
  finalGap: number;
  maxBackward: number;
  /** 相对历史最高 scrollTop 的最大回退；向下滚动本身不计入。 */
  maxBackwardFromPeak: number;
  /** 首次到达底部之后的最大回退；-1 表示采样期间没有到达底部。 */
  maxBackwardAfterArrival: number;
  maxVisibleBackwardAfterArrival: number;
  /** 首次到达底部之后的最大 gap。 */
  maxGapAfterArrival: number;
}

interface BottomProbeState {
  frames: BottomFrame[];
  scrollEvents: number;
  stopped: boolean;
  onScroll: (() => void) | null;
  arrivalIndex: number;
  arrivalAt: number;
}

async function startBottomProbe(page: Page, painted = false): Promise<void> {
  await page.evaluate((sampleAfterPaint) => {
    const node = document.getElementById('messages') as HTMLElement;
    const state: BottomProbeState = {
      frames: [],
      scrollEvents: 0,
      stopped: false,
      onScroll: null,
      arrivalIndex: -1,
      arrivalAt: -1,
    };
    (window as unknown as { __bottomProbe: BottomProbeState }).__bottomProbe = state;
    state.onScroll = () => {
      state.scrollEvents += 1;
    };
    node.addEventListener('scroll', state.onScroll, { passive: true });
    const sample = () => {
      const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
      if (state.arrivalIndex < 0 && node.scrollTop > 0 && gap <= 2) {
        state.arrivalIndex = state.frames.length;
        state.arrivalAt = performance.now();
      }
      state.frames.push({
        top: node.scrollTop,
        height: node.scrollHeight,
        gap,
      });
    };
    const tick = () => {
      if (state.stopped) return;
      if (sampleAfterPaint) {
        // setTimeout(0) 在上一帧绘制之后运行：只记录真正画到屏幕上的状态，
        // 不把绘制前被同步校正掉的瞬态算成可见回退。
        setTimeout(() => {
          if (state.stopped) return;
          sample();
          requestAnimationFrame(tick);
        }, 0);
        return;
      }
      sample();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, painted);
}

async function stopBottomProbe(page: Page): Promise<BottomProbeReport> {
  return page.evaluate(() => {
    const node = document.getElementById('messages') as HTMLElement;
    const state = (window as unknown as {
      __bottomProbe: {
        frames: BottomFrame[];
        scrollEvents: number;
        stopped: boolean;
        onScroll: (() => void) | null;
        arrivalIndex: number;
      };
    }).__bottomProbe;
    state.stopped = true;
    if (state.onScroll) node.removeEventListener('scroll', state.onScroll);
    const frames = state.frames;
    const tops = frames.map((frame) => frame.top);
    let maxBackward = 0;
    for (let index = 1; index < frames.length; index += 1) {
      maxBackward = Math.max(maxBackward, frames[index - 1]!.top - frames[index]!.top);
    }
    let peak = -1;
    let maxBackwardFromPeak = 0;
    for (const top of tops) {
      peak = Math.max(peak, top);
      maxBackwardFromPeak = Math.max(maxBackwardFromPeak, peak - top);
    }
    const gaps = frames.map((frame) => frame.gap);
    const arrivalFrames =
      state.arrivalIndex >= 0 ? frames.slice(state.arrivalIndex) : [];
    const arrivalTops = arrivalFrames.map((frame) => frame.top);
    let arrivalPeak = -1;
    let maxBackwardAfterArrival = 0;
    for (const top of arrivalTops) {
      arrivalPeak = Math.max(arrivalPeak, top);
      maxBackwardAfterArrival = Math.max(
        maxBackwardAfterArrival,
        arrivalPeak - top,
      );
    }
    // 只有 gap > 2 才代表“最新消息已经被推离底部”。到底后高度测量引起的
    // scrollTop 回退如果 gap 仍为 0，画面锚在内容底部，用户看不到位移。
    let runningPeak = -1;
    let maxVisibleBackwardAfterArrival = 0;
    frames.forEach((frame, index) => {
      runningPeak = Math.max(runningPeak, frame.top);
      if (index >= state.arrivalIndex && frame.gap > 2) {
        maxVisibleBackwardAfterArrival = Math.max(
          maxVisibleBackwardAfterArrival,
          runningPeak - frame.top,
        );
      }
    });
    return {
      frames: frames.length,
      minTop: Math.min(...tops),
      maxTop: Math.max(...tops),
      range: Math.round((Math.max(...tops) - Math.min(...tops)) * 100) / 100,
      heightGrowth:
        Math.round(
          (Math.max(...frames.map((frame) => frame.height)) -
            Math.min(...frames.map((frame) => frame.height))) *
            100,
        ) / 100,
      scrollEvents: state.scrollEvents,
      maxGap: Math.round(Math.max(...gaps) * 100) / 100,
      finalGap: Number(
        (node.scrollHeight - node.scrollTop - node.clientHeight).toFixed(2),
      ),
      maxBackward: Math.round(maxBackward * 100) / 100,
      maxBackwardFromPeak: Math.round(maxBackwardFromPeak * 100) / 100,
      maxBackwardAfterArrival:
        arrivalFrames.length > 0
          ? Math.round(maxBackwardAfterArrival * 100) / 100
          : -1,
      maxVisibleBackwardAfterArrival:
        arrivalFrames.length > 0
          ? Math.round(maxVisibleBackwardAfterArrival * 100) / 100
          : -1,
      maxGapAfterArrival:
        arrivalFrames.length > 0
          ? Math.round(Math.max(...arrivalFrames.map((frame) => frame.gap)) * 100) / 100
          : -1,
    };
  });
}

interface EntryFrame {
  t: number;
  top: number;
  height: number;
  gap: number;
  visible: boolean;
}

interface EntryProbeReport {
  frames: number;
  visibleFrames: number;
  firstVisibleAt: number;
  /** rAF 采样（绘制前）的相对峰值回退，任务要求的门禁指标。 */
  maxBackward: number;
  /** 绘制后采样的最大回退；底部高度补偿可能产生 gap=0 的 scrollTop 回退。 */
  maxBackwardPainted: number;
  maxBackwardAllFrames: number;
  /** 绘制后可见的最大 gap（真正画到屏幕上的“离底”）。 */
  maxGap: number;
  /**
   * 只在“确实离底（gap>2）”的绘制后帧上统计的相对峰值回退。
   * scrollTop 随底部高度收缩而下降但 gap 仍为 0 时，画面锚在内容底部，
   * 不是可见回退（与计划文档 12.3 的判定一致）。
   */
  maxVisibleBackwardPainted: number;
  paintedFrames: number;
  /** rAF 采样（绘制前）的最大 gap，仅用于诊断。 */
  maxGapRaf: number;
  maxGapAllFrames: number;
  atBottomSequence: string[];
  flipsAfterFirstTrue: number;
  finalGap: number;
  finalAtBottom: string | null;
  /** 第一帧可见时 `#messages` 的文本长度；慢 Markdown 下用于识别“空气泡先 reveal”。 */
  firstVisibleTextLen: number;
  /** 第一帧可见时已挂载 Markdown 岛的总字符数。 */
  firstVisibleMarkdownChars: number;
  /** 第一帧可见时仍在读取元数据的文件卡数量。 */
  firstVisibleFileLoading: number;
  /** 第一帧可见时的滚动位置与高度，用于定位 reveal 瞬间的回退。 */
  firstVisibleTop: number;
  firstVisibleHeight: number;
  /** 最大可见回退的时刻与前后帧（top/height）。 */
  maxBackwardAt: number;
  maxBackwardFrom: number;
  maxBackwardTo: number;
  maxBackwardFromHeight: number;
  maxBackwardToHeight: number;
}

/**
 * 从 `#messages` 出现的第一帧开始逐帧采样。测试不能先等页面/数据就绪再采样，
 * 否则会跳过真正会发生回退的进入窗口。
 */
async function installEntryProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      frames: [] as EntryFrame[],
      painted: [] as EntryFrame[],
      stopped: false,
      atBottom: [] as string[],
      firstVisibleAt: -1,
      firstVisibleTextLen: -1,
      firstVisibleMarkdownChars: -1,
      firstVisibleFileLoading: -1,
      firstVisibleTop: -1,
      firstVisibleHeight: -1,
      startedAt: -1,
    };
    (window as unknown as { __entryProbe: typeof state }).__entryProbe = state;
    const begin = () => {
      const node = document.getElementById('messages') as HTMLElement | null;
      if (!node) {
        requestAnimationFrame(begin);
        return;
      }
      const startedAt = performance.now();
      state.startedAt = startedAt;
      const tick = () => {
        if (state.stopped) return;
        const t = performance.now() - startedAt;
        const visible = window.getComputedStyle(node).visibility !== 'hidden';
        if (visible && state.firstVisibleAt < 0) {
          state.firstVisibleAt = t;
          state.firstVisibleTextLen = (node.textContent ?? '').trim().length;
          let markdownChars = 0;
          node.querySelectorAll('.msg-markdown').forEach((element) => {
            markdownChars += (element.textContent ?? '').trim().length;
          });
          state.firstVisibleMarkdownChars = markdownChars;
          state.firstVisibleFileLoading = node.querySelectorAll(
            '.msg-file[data-loading="1"]',
          ).length;
          state.firstVisibleTop = node.scrollTop;
          state.firstVisibleHeight = node.scrollHeight;
        }
        state.frames.push({
          t,
          top: node.scrollTop,
          height: node.scrollHeight,
          gap: node.scrollHeight - node.scrollTop - node.clientHeight,
          visible,
        });
        // 绘制后的状态：只有它代表用户真正看到的画面。
        setTimeout(() => {
          if (state.stopped) return;
          state.painted.push({
            t: performance.now() - startedAt,
            top: node.scrollTop,
            height: node.scrollHeight,
            gap: node.scrollHeight - node.scrollTop - node.clientHeight,
            visible: window.getComputedStyle(node).visibility !== 'hidden',
          });
        }, 0);
        const atBottom = node.getAttribute('data-virt-at-bottom');
        // 只统计显示后的翻转；隐藏阶段的测量回调用户看不到。
        if (
          visible &&
          atBottom !== null &&
          state.atBottom[state.atBottom.length - 1] !== atBottom
        ) {
          state.atBottom.push(atBottom);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(begin);
  });
}

async function stopEntryProbe(page: Page): Promise<EntryProbeReport> {
  return page.evaluate(() => {
    const node = document.getElementById('messages') as HTMLElement;
    const state = (window as unknown as {
      __entryProbe: {
        frames: EntryFrame[];
        painted: EntryFrame[];
        stopped: boolean;
        atBottom: string[];
        firstVisibleAt: number;
        firstVisibleTextLen: number;
        firstVisibleMarkdownChars: number;
        firstVisibleFileLoading: number;
        firstVisibleTop: number;
        firstVisibleHeight: number;
      };
    }).__entryProbe;
    state.stopped = true;
    const frames = state.frames;
    const visible = frames.filter((frame) => frame.visible);
    const paintedVisible = state.painted.filter((frame) => frame.visible);
    const peakBackward = (list: EntryFrame[]): number => {
      let peak = -1;
      let backward = 0;
      for (const frame of list) {
        peak = Math.max(peak, frame.top);
        backward = Math.max(backward, peak - frame.top);
      }
      return backward;
    };
    const backwardDetail = (() => {
      let peak = -1;
      let peakFrame: EntryFrame | null = null;
      let best = 0;
      let at = 0;
      let fromTop = 0;
      let toTop = 0;
      let fromHeight = 0;
      let toHeight = 0;
      for (const frame of visible) {
        if (frame.top >= peak) {
          peak = frame.top;
          peakFrame = frame;
        }
        const backward = peak - frame.top;
        if (peakFrame && backward > best) {
          best = backward;
          at = frame.t;
          fromTop = peakFrame.top;
          toTop = frame.top;
          fromHeight = peakFrame.height;
          toHeight = frame.height;
        }
      }
      return { at, fromTop, toTop, fromHeight, toHeight };
    })();
    const maxGap = (list: EntryFrame[]): number =>
      list.length ? Math.max(...list.map((frame) => frame.gap)) : 0;
    const visibleBackwardPainted = (() => {
      let peak = -1;
      let backward = 0;
      for (const frame of paintedVisible) {
        peak = Math.max(peak, frame.top);
        if (frame.gap > 2) backward = Math.max(backward, peak - frame.top);
      }
      return backward;
    })();
    const firstTrue = state.atBottom.indexOf('true');
    return {
      frames: frames.length,
      visibleFrames: visible.length,
      firstVisibleAt: Math.round(state.firstVisibleAt * 100) / 100,
      maxBackward: Math.round(peakBackward(visible) * 100) / 100,
      maxBackwardAllFrames:
        Math.round(peakBackward(frames) * 100) / 100,
      maxBackwardPainted:
        Math.round(peakBackward(paintedVisible) * 100) / 100,
      maxGap: Math.round(maxGap(paintedVisible) * 100) / 100,
      maxVisibleBackwardPainted: Math.round(visibleBackwardPainted * 100) / 100,
      paintedFrames: paintedVisible.length,
      maxGapRaf: Math.round(maxGap(visible) * 100) / 100,
      maxGapAllFrames: Math.round(maxGap(frames) * 100) / 100,
      atBottomSequence: state.atBottom,
      flipsAfterFirstTrue:
        firstTrue < 0
          ? -1
          : state.atBottom.slice(firstTrue).filter((value) => value === 'false').length,
      finalGap: Number(
        (node.scrollHeight - node.scrollTop - node.clientHeight).toFixed(2),
      ),
      finalAtBottom: node.getAttribute('data-virt-at-bottom'),
      firstVisibleTextLen: state.firstVisibleTextLen,
      firstVisibleMarkdownChars: state.firstVisibleMarkdownChars,
      firstVisibleFileLoading: state.firstVisibleFileLoading,
      firstVisibleTop: state.firstVisibleTop,
      firstVisibleHeight: state.firstVisibleHeight,
      maxBackwardAt: Math.round(backwardDetail.at * 100) / 100,
      maxBackwardFrom: backwardDetail.fromTop,
      maxBackwardTo: backwardDetail.toTop,
      maxBackwardFromHeight: backwardDetail.fromHeight,
      maxBackwardToHeight: backwardDetail.toHeight,
    };
  });
}

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface UploadedFile {
  fileId: string;
  publicUrl: string;
}

async function uploadRoomFile(
  base: string,
  token: string,
  roomId: string,
  name: string,
  mimeType: string,
  body: Buffer,
): Promise<UploadedFile> {
  const response = await fetch(`${base}/mcp-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'MCPP-Files-Version': '1',
      'content-type': mimeType,
      'MCPP-File-Name': encodeURIComponent(name),
      'MCPP-File-Size': String(body.length),
    },
    body: body as unknown as BodyInit,
  });
  if (response.status !== 201) throw new Error(`上传 ${name} 失败：HTTP ${response.status}`);
  const uploaded = (await response.json()) as UploadedFile;
  await callTool(base, token, 'network_room_file_bind', {
    request_id: requestId('virt_file_bind'),
    room_id: roomId,
    file_id: uploaded.fileId,
  });
  await callTool(base, token, 'network_file_publish', {
    request_id: requestId('virt_file_publish'),
    room_id: roomId,
    file_id: uploaded.fileId,
    public: true,
  });
  return uploaded;
}

function richBody(index: number, imageUrl: string, documentUrl: string): string {
  if (index % 5 === 0) {
    return [
      `## Peri 维护记录 ${index}`,
      '',
      '| 检查项 | 结果 | 备注 |',
      '| --- | --- | --- |',
      '| 时间线 | 稳定 | 虚拟化 |',
      '| 贴底 | 观察 | 长内容 |',
      '',
      '```ts',
      'const samples = frames.map((frame) => frame.top);',
      'const range = Math.max(...samples) - Math.min(...samples);',
      '```',
      '',
      `> 第 ${index} 段：底部需要稳定，不应来回跳动。`,
    ].join('\n');
  }
  if (index % 7 === 0) {
    return `Peri 维护截图 ${index}\n\n[Peri 截图.png](${imageUrl})`;
  }
  if (index % 11 === 0) {
    return `Peri 维护长清单 ${index}\n\n${'- 核对 Markdown、图片、文件卡与 Task 的高度变化。\n'.repeat(18)}`;
  }
  if (index % 13 === 0) {
    return `Peri 维护文档 ${index}\n\n[维护记录.md](${documentUrl})`;
  }
  return `Peri 维护进度 ${index}：已完成第 ${index} 项检查，继续观察底部。`;
}

/**
 * 滚动条场景的 120 条富 Markdown：表格、代码与长段落，不加图片/文件卡与
 * Task。复现单次拖到底后 Virtuoso 继续测量/footer 的 46–287px 残留；同时
 * 避免给同一 beforeAll 的其他用例额外引入图片/文件卡加载时序。
 */
async function seedScrollTimeline(
  base: string,
  token: string,
  roomId: string,
  count: number,
): Promise<void> {
  const batch = 20;
  for (let start = 1; start <= count; start += batch) {
    await Promise.all(
      Array.from({ length: Math.min(batch, count - start + 1) }, (_, offset) => {
        const index = start + offset;
        const body =
          index % 5 === 0
            ? [
                `## 滚动条记录 ${index}`,
                '',
                '| 项 | 值 |',
                '| --- | --- |',
                '| 滚动 | 观察 |',
                '| 贴底 | 复核 |',
                '',
                '```ts',
                `const offset = ${index};`,
                '```',
              ].join('\n')
            : `滚动条消息 ${index}：${'检查长内容。'.repeat(index % 11 === 0 ? 18 : 1)}`;
        return callTool(base, token, 'network_message_send', {
          request_id: requestId('virt_scroll_seed'),
          client_message_id: crypto.randomUUID(),
          room_id: roomId,
          invoke: [],
          body,
        });
      }),
    );
  }
}

async function seedRichTimeline(
  base: string,
  token: string,
  roomId: string,
  count: number,
  imageUrl: string,
  documentUrl: string,
): Promise<void> {
  const batch = 20;
  for (let start = 1; start <= count; start += batch) {
    await Promise.all(
      Array.from({ length: Math.min(batch, count - start + 1) }, (_, offset) => {
        const index = start + offset;
        return callTool<{ message: { message_id: string } }>(
          base,
          token,
          'network_message_send',
          {
            request_id: requestId('virt_rich'),
            client_message_id: crypto.randomUUID(),
            room_id: roomId,
            invoke: [],
            body: richBody(index, imageUrl, documentUrl),
          },
        ).then(async (sent) => {
          if (index % 29 === 0) {
            await callTool(base, token, 'network_task_mark', {
              request_id: requestId('virt_rich_task'),
              room_id: roomId,
              message_id: sent.message.message_id,
            });
          }
        });
      }),
    );
  }
}

/**
 * 慢 Markdown 房间只放 Agent 正文（表格/代码/长列表），不放文件卡：
 * 入口 reveal 的等待对象是 Markdown 岛本身，排除缩略图异步解码的干扰。
 */
async function seedSlowMarkdownRoom(
  base: string,
  token: string,
  roomId: string,
  count: number,
): Promise<void> {
  const batch = 8;
  for (let start = 1; start <= count; start += batch) {
    await Promise.all(
      Array.from({ length: Math.min(batch, count - start + 1) }, (_, offset) => {
        const index = start + offset;
        const body =
          index % 3 === 0
            ? [
                `## 慢 Markdown ${index}`,
                '',
                '| 项 | 状态 | 备注 |',
                '| --- | --- | --- |',
                ...Array.from(
                  { length: 10 },
                  (_, row) => `| 检查 ${row + 1} | 通过 | 入口时序 |`,
                ),
                '',
                '```ts',
                'const pending = mounted.filter((item) => !item.ready);',
                '```',
              ].join('\n')
            : `慢 Markdown 进度 ${index}：${'入口等待正文就绪。'.repeat(12)}`;
        return callTool(base, token, 'network_message_send', {
          request_id: requestId('virt_slow_md'),
          client_message_id: crypto.randomUUID(),
          room_id: roomId,
          invoke: [],
          body,
        });
      }),
    );
  }
}

interface AnchorSample {
  id: string;
  top: number;
}

async function firstVisibleAnchor(page: Page): Promise<AnchorSample | null> {
  return page.evaluate(() => {
    const list = document.getElementById('messages');
    if (!list) return null;
    const top = list.getBoundingClientRect().top;
    const bottom = list.getBoundingClientRect().bottom;
    // 选第一条完整落在视口内的消息；半截在顶部的条目会随 overscan 变化，
    // 不适合作为 prepend 前后稳定的锚点。
    const node = Array.from(list.querySelectorAll<HTMLElement>('.msg[data-message-id]')).find(
      (element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= top - 1 && rect.top < bottom - 1;
      },
    );
    if (!node) return null;
    return { id: node.dataset.messageId ?? '', top: node.getBoundingClientRect().top };
  });
}

test.describe.configure({ timeout: 300_000 });

test.describe('virtual chat timeline', () => {
  let base = '';
  let tokenA = '';
  let tokenB = '';
  let roomId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const a = await registerHuman(base, `虚拟 A ${suffix}`, `virt-${suffix}-a`);
    const b = await registerHuman(base, `虚拟 B ${suffix}`, `virt-${suffix}-b`);
    tokenA = a.token;
    tokenB = b.token;
    roomId = await befriend(base, tokenA, b.actor, tokenB);
    await seedMessages(base, tokenB, roomId, TOTAL);
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 存储不可用时由页面错误态兜底。
      }
    }, tokenA);
  });

  test(`keeps a bounded DOM window with ${TOTAL} loaded messages`, async ({ page }) => {
    await openRoom(page, roomId);
    expect(await domNodeCount(page)).toBeLessThan(2000);

    const started = Date.now();
    while ((await loadedCount(page)) < TOTAL) {
      const before = await loadedCount(page);
      await expect(page.locator('#older')).toBeEnabled({ timeout: 10_000 });
      await page.evaluate(() => {
        (document.getElementById('older') as HTMLButtonElement | null)?.click();
      });
      await expect.poll(() => loadedCount(page), { timeout: 20_000 }).toBeGreaterThan(before);
    }
    expect(await loadedCount(page)).toBe(TOTAL);
    expect(Date.now() - started).toBeLessThan(120_000);

    const nodes = await domNodeCount(page);
    const visible = await page.locator('#messages .msg[data-message-id]').count();
    expect(nodes).toBeLessThanOrEqual(2000);
    expect(visible).toBeLessThan(300);

    const frames = await page.evaluate(async () => {
      const node = document.getElementById('messages');
      if (!node) return { p50: 0, p95: 0, max: 0, longFrames: 0 };
      const samples: number[] = [];
      let last = performance.now();
      let running = true;
      const tick = (now: number) => {
        samples.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const max = node.scrollHeight - node.clientHeight;
      for (let index = 0; index < 40; index += 1) {
        node.scrollTop = index % 2 === 0 ? max * 0.35 : max * 0.65;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      running = false;
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const sorted = samples.slice().sort((left, right) => left - right);
      const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      return {
        p50: at(0.5),
        p95: at(0.95),
        max: sorted.at(-1) ?? 0,
        longFrames: samples.filter((value) => value > 50).length,
      };
    });

    console.log(
      `VIRTUAL_SCALE ${JSON.stringify({
        loaded: TOTAL,
        domNodes: nodes,
        visibleMessages: visible,
        frameP50: Number(frames.p50.toFixed(1)),
        frameP95: Number(frames.p95.toFixed(1)),
        frameMax: Number(frames.max.toFixed(1)),
        longFrames: frames.longFrames,
      })}`,
    );
    expect(frames.p95).toBeLessThan(20);
    expect(frames.longFrames).toBe(0);
  });

  test('keeps the prepend anchor within 2px', async ({ page }) => {
    await openRoom(page, roomId);
    await scrollToTop(page);
    // startReached 可能在滚到顶部时自动补一页；先等数据窗口稳定，
    // 再用手动点击验证“一次 prepend”，避免自动补页与点击竞争。
    let loadedBefore = await loadedCount(page);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(200);
      const current = await loadedCount(page);
      if (current === loadedBefore) break;
      loadedBefore = current;
    }
    await page.waitForTimeout(300);
    loadedBefore = await loadedCount(page);
    const before = await firstVisibleAnchor(page);
    expect(before).not.toBeNull();
    if (!before) return;

    await page.evaluate((anchorId) => {
      const target = (window as unknown as { __virtDrift?: unknown }).__virtDrift;
      void target;
      const list = document.getElementById('messages');
      if (!list) return;
      const record = {
        id: anchorId,
        initialTop: 0,
        samples: [] as number[],
        scrollTops: [] as number[],
      };
      const node = list.querySelector<HTMLElement>(
        `.msg[data-message-id="${anchorId}"]`,
      );
      record.initialTop = node?.getBoundingClientRect().top ?? 0;
      const started = performance.now();
      const tick = () => {
        const current = list.querySelector<HTMLElement>(
          `.msg[data-message-id="${anchorId}"]`,
        );
        if (current) {
          record.samples.push(current.getBoundingClientRect().top - record.initialTop);
        }
        record.scrollTops.push(list.scrollTop);
        if (performance.now() - started < 2_500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (window as unknown as { __virtDrift?: unknown }).__virtDrift = record;
    }, before.id);

    await page.evaluate(() => {
      (document.getElementById('older') as HTMLButtonElement | null)?.click();
    });
    await expect.poll(() => loadedCount(page), { timeout: 20_000 }).toBe(loadedBefore + 50);
    await page.waitForTimeout(2_600);

    const report = await page.evaluate(() => {
      const record = (window as unknown as { __virtDrift?: {
        samples: number[];
        scrollTops: number[];
      } }).__virtDrift;
      const samples = record?.samples ?? [];
      const scrollTops = record?.scrollTops ?? [];
      const absolute = samples.map((value) => Math.abs(value));
      return {
        maxAbsDrift: absolute.length ? Math.max(...absolute) : 0,
        correctedDrift: absolute.length ? absolute[absolute.length - 1] ?? 0 : 0,
        missed: scrollTops.length > 1 && scrollTops.every((value) => value === scrollTops[0]),
        samples: samples.length,
      };
    });

    const after = await firstVisibleAnchor(page);
    expect(after?.id).toBe(before.id);
    expect(Math.abs((after?.top ?? 0) - before.top)).toBeLessThanOrEqual(2);
    console.log(
      `VIRTUAL_PREPEND ${JSON.stringify({
        ...report,
        before: before.id,
        after: after?.id,
        loaded: loadedBefore + 50,
        top: after?.top,
      })}`,
    );
    expect(report.correctedDrift).toBeLessThanOrEqual(2);
    expect(report.missed).toBe(false);
    expect(report.maxAbsDrift).toBeLessThanOrEqual(8);
  });

  test('jumps to a quoted message inside the virtual window', async ({ page }) => {
    await openRoom(page, roomId);
    const target = await firstVisibleAnchor(page);
    expect(target).not.toBeNull();
    if (!target) return;

    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('virt_reply'),
      client_message_id: crypto.randomUUID(),
      room_id: roomId,
      reply_to: target.id,
      invoke: [],
      body: '虚拟时间线引用跳转',
    });
    const reply = page
      .locator('#messages .msg[data-message-id]')
      .filter({ hasText: '虚拟时间线引用跳转' });
    await expect(reply).toBeVisible({ timeout: 15_000 });
    await reply.locator('.reply-reference').click();

    const jumped = page.locator(`#messages .msg[data-message-id="${target.id}"]`);
    await expect(jumped).toBeVisible({ timeout: 10_000 });
    // 点击引用后 Virtuoso 的滚动/测量异步完成；等待目标真正进入视口，
    // 而不是在滚动尚未结束时单次采样。500ms 上限不放宽“在视口内”的要求。
    await page.waitForFunction(
      (messageId) => {
        const list = document.getElementById('messages');
        const node = document.querySelector<HTMLElement>(
          `#messages .msg[data-message-id="${messageId}"]`,
        );
        if (!list || !node) return false;
        const rect = node.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        return rect.bottom > listRect.top && rect.top < listRect.bottom;
      },
      target.id,
      { timeout: 500, polling: 'raf' },
    );
  });

  test('does not advance the read watermark while scrolled away', async ({ page }) => {
    await openRoom(page, roomId);
    await expect.poll(() => bottomGap(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
    await page.waitForTimeout(600);
    const read = await callTool<RoomDetail>(base, tokenA, 'network_room_get', {
      room_id: roomId,
    });
    expect(Number(read.room.my_last_read_seq)).toBeGreaterThan(0);

    await scrollToTop(page);
    await page.waitForTimeout(400);
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('virt_live'),
      client_message_id: crypto.randomUUID(),
      room_id: roomId,
      invoke: [],
      body: '虚拟时间线未读消息',
    });
    await page.waitForTimeout(1_000);
    const after = await callTool<RoomDetail>(base, tokenA, 'network_room_get', {
      room_id: roomId,
    });
    expect(after.room.my_last_read_seq).toBe(read.room.my_last_read_seq);
  });

  test('keeps the mobile single column without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openRoom(page, roomId);
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('#composer')).toBeVisible();
    expect(await domNodeCount(page)).toBeLessThan(2000);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  });
});

/**
 * 贴底稳定性：真实「Peri 维护」会话包含大量 Agent 长 Markdown、图片、文件卡
 * 与 Task。旧实现在第一帧 atBottom 就 reveal，且只用 rAF 校正，入口阶段
 * 可复现 197px 回退（基线 5/5）；到达底部可复现 56/76px 的可见回退。
 * 这里固化入口、到达、静止与追加时的位置不变量，不依赖帧率。
 */
test.describe('virtual timeline bottom stability', () => {
  const RICH_TOTAL = 240;
  const LOADED_TARGET = 220;
  // 滚动条用例使用 120 条：旧用例的 240 条 + 两次写到底会让第二次写入恰好
  // 覆盖真实底部，掩盖单次拖到底后 Virtuoso 继续测量/footer 的 46–287px 残留。
  const SCROLL_TOTAL = 120;
  const LIGHT_TOTAL = 80;
  // 慢 Markdown 用例使用更小的房间：入口数据窗口更快就绪，延迟 100ms 的
  // 资源必然晚于/逼近 reveal，才能稳定复现“空气泡先显示”的时序。
  const SLOW_MARKDOWN_TOTAL = 32;
  let base = '';
  let ownerToken = '';
  let agentToken = '';
  let roomId = '';
  let scrollRoomId = '';
  let lightRoomId = '';
  let slowRoomId = '';
  let lightAgentToken = '';
  let imageUrl = '';
  let documentUrl = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `贴底 Owner ${suffix}`, `virt-bottom-${suffix}`);
    ownerToken = owner.token;
    const agent = await callTool<{ actor_id: string; token: string }>(
      base,
      ownerToken,
      'network_agent_create',
      { request_id: requestId('virt_bottom_agent'), name: `Peri 维护 ${suffix}` },
    );
    agentToken = agent.token;
    const created = await callTool<{ room: { room_id: string } }>(
      base,
      ownerToken,
      'network_room_create',
      {
        request_id: requestId('virt_bottom_room'),
        kind: 'direct',
        members: [agent.actor_id],
      },
    );
    roomId = created.room.room_id;
    const scrollRoom = await callTool<{ room: { room_id: string } }>(
      base,
      ownerToken,
      'network_room_create',
      {
        request_id: requestId('virt_scroll_room'),
        kind: 'direct',
        members: [agent.actor_id],
      },
    );
    scrollRoomId = scrollRoom.room.room_id;
    const lightAgent = await callTool<{ actor_id: string; token: string }>(
      base,
      ownerToken,
      'network_agent_create',
      { request_id: requestId('virt_light_agent'), name: `轻量时间线 ${suffix}` },
    );
    const lightRoom = await callTool<{ room: { room_id: string } }>(
      base,
      ownerToken,
      'network_room_create',
      {
        request_id: requestId('virt_light_room'),
        kind: 'direct',
        members: [lightAgent.actor_id],
      },
    );
    lightRoomId = lightRoom.room.room_id;
    lightAgentToken = lightAgent.token;
    const slowRoom = await callTool<{ room: { room_id: string } }>(
      base,
      ownerToken,
      'network_room_create',
      {
        request_id: requestId('virt_slow_room'),
        kind: 'group',
        members: [agent.actor_id],
        title: '慢 Markdown 入口',
      },
    );
    slowRoomId = slowRoom.room.room_id;
    await seedMessages(base, lightAgent.token, lightRoomId, LIGHT_TOTAL);
    const image = await uploadRoomFile(
      base,
      ownerToken,
      roomId,
      'Peri 截图.png',
      'image/png',
      PIXEL_PNG,
    );
    const document = await uploadRoomFile(
      base,
      ownerToken,
      roomId,
      '维护记录.md',
      'text/markdown',
      Buffer.from('# Peri 维护记录\n\n- 时间线\n- 贴底\n', 'utf8'),
    );
    imageUrl = image.publicUrl;
    documentUrl = document.publicUrl;
    await seedRichTimeline(base, agentToken, roomId, RICH_TOTAL, imageUrl, documentUrl);
    await seedScrollTimeline(base, agentToken, scrollRoomId, SCROLL_TOTAL);
    await seedSlowMarkdownRoom(base, agentToken, slowRoomId, SLOW_MARKDOWN_TOTAL);
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 存储不可用时由页面错误态兜底。
      }
    }, ownerToken);
  });

  test('enters the room without a visible backward jump', async ({ page }) => {
    // 采样从 #messages 出现的第一帧开始，不等待数据/首轮测量完成。
    await installEntryProbe(page);
    const origin = await baseUrl();
    await page.goto(`${origin}/c/${roomId}`);
    await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
    await page.waitForTimeout(900);
    const report = await stopEntryProbe(page);
    console.log(`VIRTUAL_BOTTOM_ENTRY ${JSON.stringify(report)}`);

    // 至少覆盖进入后的稳定窗口；可见帧过少说明采样起点失效。
    expect(report.visibleFrames).toBeGreaterThan(10);
    expect(report.paintedFrames).toBeGreaterThan(5);
    expect(report.firstVisibleAt).toBeLessThanOrEqual(400);
    expect(report.maxBackward).toBeLessThanOrEqual(20);
    // 绘制后的 gap 才是用户看到的“最新消息被推离底部”。
    expect(report.maxGap).toBeLessThanOrEqual(20);
    expect(report.finalGap).toBeLessThanOrEqual(2);
    expect(report.finalAtBottom).toBe('true');
    // 到达底部后不得再反复翻转 data-virt-at-bottom。
    expect(report.flipsAfterFirstTrue).toBe(0);
  });

  // 慢资源：Markdown 岛延迟到达时，入口不能先以空气泡 reveal，再让真实
  // 高度在绘制后把底部顶开。旧实现（`d9aa96e`）100/300ms 各 3/3 失败；
  // 修复后首帧可见时正文已挂载，绘制后 gap 为 0。
  for (const delay of [100, 300]) {
    test(`reveals after slow Markdown (${delay}ms) without a visible jump`, async ({ page }) => {
      await page.route('**/assets/chat-markdown.js*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        await route.continue();
      });
      await installEntryProbe(page);
      const origin = await baseUrl();
      await page.goto(`${origin}/c/${slowRoomId}`);
      await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
      // 从 `#messages` 出现的第一帧起完整采样 900ms；慢 Markdown 会推迟
      // reveal，固定从 goto 起算会少采到可见帧。
      await page.waitForFunction(
        () => {
          const probe = (window as unknown as { __entryProbe?: { startedAt: number } })
            .__entryProbe;
          return (
            probe !== undefined && probe.startedAt > 0 && performance.now() - probe.startedAt >= 900
          );
        },
        undefined,
        { timeout: 10_000, polling: 'raf' },
      );
      const report = await stopEntryProbe(page);
      console.log(`VIRTUAL_BOTTOM_SLOW_MARKDOWN_${delay} ${JSON.stringify(report)}`);

      expect(report.visibleFrames).toBeGreaterThan(10);
      expect(report.paintedFrames).toBeGreaterThan(5);
      expect(report.firstVisibleAt).toBeGreaterThan(0);
      // 可见后第一帧必须有正文；不能把空气泡画给用户。
      expect(report.firstVisibleTextLen).toBeGreaterThan(0);
      // 慢 Markdown 场景的窗口里至少有一条已挂载的 Markdown 正文：
      // reveal 不能早于 pending 归零。
      expect(report.firstVisibleMarkdownChars).toBeGreaterThan(0);
      expect(report.maxBackward).toBeLessThanOrEqual(20);
      // 绘制后的可见回退：gap>2 时 scrollTop 相对峰值的回退。
      expect(report.maxVisibleBackwardPainted).toBeLessThanOrEqual(20);
      expect(report.maxGap).toBeLessThanOrEqual(20);
      expect(report.finalGap).toBeLessThanOrEqual(2);
      expect(report.finalAtBottom).toBe('true');
    });
  }

  // 富内容入口：240 条混排长 Markdown、图片文件卡、`.md` 文件卡与 Task。
  // 文件卡是 lazy chunk，元数据 `network_room_file_get` 决定缩略图与
  // “类型 · 大小 · 时间”行；若在 reveal 后才返回，卡片会从 244px 长到
  // 420px（独立夹具曾出现一帧 149px 可见 gap）。这里把元数据延迟 400ms，
  // 固定“晚于旧实现 reveal”的时序；旧实现首帧仍会画出读取中的卡片。
  test('reveals 240 rich messages after slow Markdown without a visible jump', async ({
    page,
  }) => {
    await page.route('**/assets/chat-markdown.js*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.continue();
    });
    await page.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-name'] === 'network_room_file_get') {
        // 400ms 保证元数据稳定晚于旧实现的 reveal（约 250–320ms），
        // 又不至于超过 2s pending 上限。
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await route.continue();
    });
    await installEntryProbe(page);
    const origin = await baseUrl();
    await page.goto(`${origin}/c/${roomId}`);
    await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
    await page.waitForFunction(
      () => {
        const probe = (window as unknown as { __entryProbe?: { startedAt: number } })
          .__entryProbe;
        return (
          probe !== undefined && probe.startedAt > 0 && performance.now() - probe.startedAt >= 1_400
        );
      },
      undefined,
      { timeout: 15_000, polling: 'raf' },
    );
    const report = await stopEntryProbe(page);
    console.log(`VIRTUAL_BOTTOM_RICH_SLOW_MARKDOWN ${JSON.stringify(report)}`);

    expect(report.visibleFrames).toBeGreaterThan(10);
    expect(report.firstVisibleMarkdownChars).toBeGreaterThan(0);
    // 文件卡元数据/缩略图占位也必须计入入口 pending：首帧不能还有
    // “正在读取…”的卡片在 reveal 后长高。
    expect(report.firstVisibleFileLoading).toBe(0);
    expect(report.maxVisibleBackwardPainted).toBeLessThanOrEqual(20);
    expect(report.maxGap).toBeLessThanOrEqual(20);
    expect(report.finalGap).toBeLessThanOrEqual(2);
    expect(report.finalAtBottom).toBe('true');
    expect(report.flipsAfterFirstTrue).toBe(0);
  });

  // 2s 兜底：慢 Markdown 挂起 3s/5s 时，入口在
  // webTimelineRevealPendingMaxWaitMs 后必须显示；内容晚到不能把底部一次性
  // 顶开（旧实现实测单帧 4,568px、最终残留 18px）。
  for (const delay of [3_000, 5_000]) {
    test(`absorbs late Markdown after the ${delay}ms stall`, async ({ page }) => {
      await page.route('**/assets/chat-markdown.js*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        await route.continue();
      });
      await installEntryProbe(page);
      const origin = await baseUrl();
      await page.goto(`${origin}/c/${slowRoomId}`);
      await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
      await page.waitForFunction(
        (wait) => {
          const probe = (window as unknown as { __entryProbe?: { startedAt: number } })
            .__entryProbe;
          return (
            probe !== undefined &&
            probe.startedAt > 0 &&
            performance.now() - probe.startedAt >= wait
          );
        },
        delay + 1_200,
        { timeout: 20_000, polling: 'raf' },
      );
      const report = await stopEntryProbe(page);
      const markdownChars = await page.evaluate(() => {
        let chars = 0;
        document.querySelectorAll('#messages .msg-markdown').forEach((element) => {
          chars += (element.textContent ?? '').trim().length;
        });
        return chars;
      });
      console.log(
        `VIRTUAL_BOTTOM_LATE_MARKDOWN_${delay} ${JSON.stringify({
          ...report,
          markdownChars,
        })}`,
      );

      // 2s 上限必须显示，不能白屏等到资源到达。
      expect(report.firstVisibleAt).toBeGreaterThan(0);
      expect(report.firstVisibleAt).toBeLessThanOrEqual(2_500);
      expect(markdownChars).toBeGreaterThan(0);
      // 内容晚到时的绘制后 gap：允许 20px 的测量/布局误差，不能出现单帧大跳。
      expect(report.maxGap).toBeLessThanOrEqual(20);
      expect(report.finalGap).toBeLessThanOrEqual(2);
      expect(report.finalAtBottom).toBe('true');
    });
  }

  test('stays pinned after scrolling the loaded window to the bottom', async ({ page }) => {
    await openRoom(page, lightRoomId);
    await loadOlderUntil(page, LIGHT_TOTAL);
    await scrollToTop(page);
    await page.waitForTimeout(300);

    // 用户上翻阅读时到达一条中等高度的 Markdown 消息（表格 + 列表）。它
    // 此时不在已挂载窗口里，滚到底部才首次渲染并测量真实高度。
    await callTool(base, lightAgentToken, 'network_message_send', {
      request_id: requestId('virt_manual_live'),
      client_message_id: crypto.randomUUID(),
      room_id: lightRoomId,
      invoke: [],
      body: [
        '## 上翻时到达的表格消息',
        '',
        '| 项 | 状态 | 备注 |',
        '| --- | --- | --- |',
        ...Array.from(
          { length: 14 },
          (_, index) => `| 检查 ${index + 1} | 通过 | 到达底部后首次渲染 |`,
        ),
        '',
        ...Array.from(
          { length: 10 },
          (_, index) => `- 到达底部后展开的第 ${index + 1} 条说明，用于增加真实高度。`,
        ),
      ].join('\n'),
    });
    await expect.poll(() => loadedCount(page), { timeout: 15_000 }).toBeGreaterThan(LIGHT_TOTAL);
    await page.waitForTimeout(300);

    await startBottomProbe(page, true);
    const box = await page.locator('#messages').boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // 一次滚轮手势直接拖到底：新消息首次挂载，Markdown 真实高度随后才测量。
    // 逐段滚轮会让底部条目提前测好，掩盖到达瞬间的缺陷。
    await page.mouse.wheel(0, 200_000);
    // 以页面内第一帧 gap≤2 为到达起点，再完整观察 500ms；外部轮询会
    // 晚几十毫秒，正好跳过到达瞬间的回退。
    await page.waitForFunction(
      () => {
        const state = (window as unknown as { __bottomProbe?: BottomProbeState })
          .__bottomProbe;
        return (
          state !== undefined &&
          state.arrivalIndex >= 0 &&
          performance.now() - state.arrivalAt >= 500
        );
      },
      undefined,
      { timeout: 10_000, polling: 'raf' },
    );
    const report = await stopBottomProbe(page);
    console.log(`VIRTUAL_BOTTOM_MANUAL ${JSON.stringify(report)}`);

    expect(report.maxGapAfterArrival).toBeGreaterThanOrEqual(0);
    expect(report.maxGapAfterArrival).toBeLessThanOrEqual(20);
    expect(report.maxVisibleBackwardAfterArrival).toBeLessThanOrEqual(20);
    expect(report.finalGap).toBeLessThanOrEqual(2);
    expect(await page.locator('#messages').getAttribute('data-virt-at-bottom')).toBe('true');
  });

  test('re-pins after dragging the scrollbar to the bottom', async ({ page }) => {
    // 120 条富内容只写一次到底：240 条 + 两次写入会让第二次恰好覆盖真实
    // 底部，掩盖 Virtuoso 在拖到底后继续测量/footer 的残留。
    await openRoom(page, scrollRoomId);
    await loadOlderUntil(page, SCROLL_TOTAL);
    await scrollToTop(page);
    await expect.poll(async () => (await messageBox(page)).pinned, { timeout: 5_000 }).toBe('false');
    // 让程序化到顶的“向上意图”窗口过去，避免把 re-pin 误判成用户仍在阅读。
    await page.waitForTimeout(400);

    // Windows/Linux 经典滚动条的模拟路径：指针按下在滚动容器上，拖到真实
    // 底部后于 window 松手。原生 overlay 滚动条未必派发 pointerdown，这里
    // 直接派发 PointerEvent 覆盖处理路径；程序化 scrollTop 触发真实 scroll。
    await page.evaluate(() => {
      const node = document.getElementById('messages');
      if (!node) throw new Error('缺少 #messages');
      node.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          buttons: 1,
        }),
      );
      node.scrollTop = node.scrollHeight;
    });
    // 单次写入后等待 Virtuoso 完成测量回写；此时当前 gap 可能是 46–287px，
    // 但手势中确实到过底部，松手后必须按方向/落点 re-pin。
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
        }),
      );
    });

    // 松手 500ms 后必须回到真实底部并重新 pinned，否则下一条新消息不会跟随。
    await page.waitForTimeout(500);
    const released = await messageBox(page);
    expect(released.gap).toBeLessThanOrEqual(2);
    expect(released.pinned).toBe('true');
    expect(released.jumpHidden).toBe(true);
    expect(released.lastVisible).toBe(true);
    const sent = await callTool<{ message: { message_id: string } }>(
      base,
      agentToken,
      'network_message_send',
      {
        request_id: requestId('virt_scrollbar_live'),
        client_message_id: crypto.randomUUID(),
        room_id: scrollRoomId,
        invoke: [],
        body: `滚动条拖到底后到达的消息 ${crypto.randomUUID().slice(0, 8)}`,
      },
    );
    await expect(
      page.locator(`#messages .msg[data-message-id="${sent.message.message_id}"]`),
    ).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => bottomGap(page), { timeout: 15_000 }).toBeLessThanOrEqual(2);
    const followed = await messageBox(page);
    expect(followed.pinned).toBe('true');
    expect(followed.lastVisible).toBe(true);
  });

  test('keeps scrollTop stable for 2s after reaching the bottom', async ({ page }) => {
    await openRoom(page, roomId);
    await loadOlderUntil(page, LOADED_TARGET);
    await scrollToBottom(page);
    // 等 Markdown 岛、图片、文件卡与 Task 摘要完成首轮挂载/测量。
    await page.waitForTimeout(2_000);

    await startBottomProbe(page);
    await page.waitForTimeout(2_000);
    const report = await stopBottomProbe(page);
    console.log(`VIRTUAL_BOTTOM_IDLE ${JSON.stringify(report)}`);

    expect(report.frames).toBeGreaterThan(80);
    // 到底静止后不应再有程序化滚动；scroll 事件为 0 也说明没有与测量互抢。
    expect(report.scrollEvents).toBe(0);
    expect(report.range).toBeLessThanOrEqual(1);
    expect(report.maxBackward).toBeLessThanOrEqual(1);
    expect(report.finalGap).toBeLessThanOrEqual(2);
  });

  test('follows a long append without bouncing back', async ({ page }) => {
    await openRoom(page, roomId);
    await loadOlderUntil(page, LOADED_TARGET);
    await scrollToBottom(page);
    await page.waitForTimeout(1_000);

    await startBottomProbe(page);
    const sent = await callTool<{ message: { message_id: string } }>(
      base,
      agentToken,
      'network_message_send',
      {
        request_id: requestId('virt_bottom_live'),
        client_message_id: crypto.randomUUID(),
        room_id: roomId,
        invoke: [],
        body: [
          '## Peri 维护实时追加',
          '',
          '| 项 | 状态 |',
          '| --- | --- |',
          '| 贴底 | 观察 |',
          '',
          `${'实时追加的长 Markdown 段落，用于观察高度变化后的跟随。\n'.repeat(24)}`,
          `[Peri 截图.png](${imageUrl})`,
        ].join('\n'),
      },
    );
    await expect(
      page.locator(`#messages .msg[data-message-id="${sent.message.message_id}"]`),
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2_500);
    const report = await stopBottomProbe(page);
    console.log(`VIRTUAL_BOTTOM_APPEND ${JSON.stringify(report)}`);

    expect(await bottomGap(page)).toBeLessThanOrEqual(2);
    // 长追加必须真的带来高度变化；修复后每一帧都在绘制前贴底，因此不再
    // 用“看得见的 gap>50”作为跟随证据，改为要求 gap 始终 ≤2。
    expect(report.heightGrowth).toBeGreaterThan(50);
    expect(report.maxGap).toBeLessThanOrEqual(2);
    expect(report.range).toBeGreaterThan(0);
    // 只允许向下跟随；任何明显的向上回弹都是旧实现的测量争抢。
    expect(report.maxBackward).toBeLessThanOrEqual(2);
    expect(await page.locator('#messages').getAttribute('data-virt-at-bottom')).toBe('true');
  });
});

/**
 * 移动端触摸贴底（390×844、isMobile、hasTouch）。
 *
 * 回归背景：940af35 的贴底修复里，touchstart/touchmove 只写入“上翻意图”
 * 时间戳，从不取消 pinned；紧接着每个 scroll 事件都被同步写回
 * scrollHeight。触摸设备没有 wheel，pinned 因此恒为真，用户完全滚不动，
 * 也到不了真正的底部。四条用例分别覆盖：触摸滚动/回到底部、按钮、
 * 输入框/键盘、上翻期间的新消息。
 */
test.describe('mobile touch bottom follow', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });

  const TOTAL = 120;
  let base = '';
  let ownerToken = '';
  let agentToken = '';
  let roomId = '';
  let imageUrl = '';
  let documentUrl = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `移动 Owner ${suffix}`, `virt-mobile-${suffix}`);
    ownerToken = owner.token;
    const agent = await callTool<{ actor_id: string; token: string }>(
      base,
      ownerToken,
      'network_agent_create',
      { request_id: requestId('virt_mobile_agent'), name: `移动 Agent ${suffix}` },
    );
    agentToken = agent.token;
    const created = await callTool<{ room: { room_id: string } }>(
      base,
      ownerToken,
      'network_room_create',
      {
        request_id: requestId('virt_mobile_room'),
        kind: 'group',
        members: [agent.actor_id],
        title: '移动端贴底',
      },
    );
    roomId = created.room.room_id;
    const image = await uploadRoomFile(
      base,
      ownerToken,
      roomId,
      '移动截图.png',
      'image/png',
      PIXEL_PNG,
    );
    const document = await uploadRoomFile(
      base,
      ownerToken,
      roomId,
      '移动记录.md',
      'text/markdown',
      Buffer.from('# 移动端记录\n\n- 时间线\n- 贴底\n', 'utf8'),
    );
    imageUrl = image.publicUrl;
    documentUrl = document.publicUrl;
    await seedRichTimeline(base, agentToken, roomId, TOTAL, imageUrl, documentUrl);
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 存储不可用时由页面错误态兜底。
      }
    }, ownerToken);
  });

  test('scrolls away from the bottom and returns without snap-back', async ({ page }) => {
    await openRoom(page, roomId);
    const start = await messageBox(page);
    expect(start.gap).toBeLessThanOrEqual(2);

    // 向上拖（看更早）：修复前 pinned 恒为真，scrollTop 会被每个 scroll
    // 事件写回底部，这里会直接停在 maxTop。
    await touchScroll(page, 1_200);
    await expect
      .poll(async () => (await messageBox(page)).top, { timeout: 10_000 })
      .toBeLessThan(start.maxTop - 200);
    const away = await messageBox(page);
    expect(away.pinned).toBe('false');
    expect(away.jumpHidden).toBe(false);
    expect(away.lastVisible).toBe(false);

    // 向下 fling 回到底部：最新消息必须真正进入视口。
    await touchScroll(page, -20_000, 6_000);
    await expect.poll(() => bottomGap(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
    const arrived = await messageBox(page);
    expect(arrived.atBottom).toBe('true');
    expect(arrived.jumpHidden).toBe(true);
    expect(arrived.lastVisible).toBe(true);

    // 松手后不得被 layout effect / RO / MO 拉回或抖动。
    const frames = await page.evaluate(async () => {
      const node = document.getElementById('messages');
      const samples: number[] = [];
      const startedAt = performance.now();
      while (performance.now() - startedAt < 800) {
        if (node) samples.push(node.scrollTop);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return samples;
    });
    expect(frames.length).toBeGreaterThan(30);
    expect(Math.max(...frames) - Math.min(...frames)).toBeLessThanOrEqual(1);
    expect((await messageBox(page)).gap).toBeLessThanOrEqual(2);
  });

  test('jump-latest returns to the newest message', async ({ page }) => {
    await openRoom(page, roomId);
    await touchScroll(page, 1_200);
    await expect(page.locator('#jump-latest')).toBeVisible();
    const jump = page.locator('#jump-latest');
    await jump.tap();
    await expect.poll(() => bottomGap(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
    const box = await messageBox(page);
    expect(box.pinned).toBe('true');
    expect(box.jumpHidden).toBe(true);
    expect(box.lastVisible).toBe(true);
  });

  test('keeps the bottom when the keyboard opens from a pinned timeline', async ({ page }) => {
    // 底部点输入框后视口收缩：门控曾把布局 scroll 当成用户离开底部，导致
    // 最新消息移出视口、后续消息不再跟随。重复 3 次覆盖手势时间戳抖动。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await openRoom(page, roomId);
      const start = await messageBox(page);
      expect(start.gap).toBeLessThanOrEqual(2);
      // 初始 pinned 由 React 状态默认为 true，属性只在首次 setPin 后写入。
      expect(start.pinned).not.toBe('false');

      await page.locator('#composer textarea').tap();
      // 无头环境没有软键盘：用更矮的视口模拟 visualViewport 收缩。
      await page.setViewportSize({ width: 390, height: 520 });
      await expect
        .poll(async () => (await messageBox(page)).gap, { timeout: 5_000 })
        .toBeLessThanOrEqual(2);
      const shrunk = await messageBox(page);
      expect(shrunk.pinned).not.toBe('false');
      expect(shrunk.jumpHidden).toBe(true);
      expect(shrunk.lastVisible).toBe(true);

      // 不只是“凑巧可见”：键盘打开后到达的新消息也必须继续跟随。
      const sent = await callTool<{ message: { message_id: string } }>(
        base,
        agentToken,
        'network_message_send',
        {
          request_id: requestId('virt_mobile_keyboard_live'),
          client_message_id: crypto.randomUUID(),
          room_id: roomId,
          invoke: [],
          body: `键盘弹出后到达的消息 ${attempt + 1}`,
        },
      );
      await expect(
        page.locator(`#messages .msg[data-message-id="${sent.message.message_id}"]`),
      ).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => bottomGap(page), { timeout: 15_000 }).toBeLessThanOrEqual(2);
      const followed = await messageBox(page);
      expect(followed.pinned).not.toBe('false');
      expect(followed.lastVisible).toBe(true);

      await page.setViewportSize({ width: 390, height: 844 });
    }
  });

  test('keyboard viewport shrink neither yanks nor blocks the bottom', async ({ page }) => {
    await openRoom(page, roomId);
    await touchScroll(page, 1_200);
    await expect(page.locator('#jump-latest')).toBeVisible();
    const before = await messageBox(page);

    await page.locator('#composer textarea').tap();
    // 无头环境没有软键盘：用更矮的视口模拟 visualViewport 收缩。
    await page.setViewportSize({ width: 390, height: 520 });
    await page.waitForTimeout(600);
    const shrunk = await messageBox(page);
    // 键盘弹起不能把正在阅读的历史强行拉到底部。
    expect(Math.abs(shrunk.top - before.top)).toBeLessThanOrEqual(2);
    expect(shrunk.jumpHidden).toBe(false);

    // 键盘打开时仍然可以滚到底，并且 fling 惯性结束后必须真正恢复跟随
    // （只看松手瞬间或 lastVisible 会漏掉 pinned=false 的回归）。
    await touchScroll(page, -20_000, 6_000);
    await expect.poll(() => bottomGap(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
    const arrived = await messageBox(page);
    expect(arrived.lastVisible).toBe(true);
    expect(arrived.jumpHidden).toBe(true);
    await expect
      .poll(async () => (await messageBox(page)).pinned, { timeout: 10_000 })
      .toBe('true');

    const sent = await callTool<{ message: { message_id: string } }>(
      base,
      agentToken,
      'network_message_send',
      {
        request_id: requestId('virt_mobile_keyboard_bottom'),
        client_message_id: crypto.randomUUID(),
        room_id: roomId,
        invoke: [],
        body: '键盘打开时 fling 到底后到达的消息',
      },
    );
    await expect(
      page.locator(`#messages .msg[data-message-id="${sent.message.message_id}"]`),
    ).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => bottomGap(page), { timeout: 15_000 }).toBeLessThanOrEqual(2);
    const followed = await messageBox(page);
    expect(followed.pinned).toBe('true');
    expect(followed.lastVisible).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('new message while reading history does not force the bottom', async ({ page }) => {
    await openRoom(page, roomId);
    await touchScroll(page, 1_200);
    await expect(page.locator('#jump-latest')).toBeVisible();
    await expect(page.locator('#jump-latest-label')).toHaveText('回到最新');
    const before = await messageBox(page);

    const sent = await callTool<{ message: { message_id: string } }>(
      base,
      agentToken,
      'network_message_send',
      {
        request_id: requestId('virt_mobile_live'),
        client_message_id: crypto.randomUUID(),
        room_id: roomId,
        invoke: [],
        body: [
          '## 移动端阅读期间到达',
          '',
          '| 项 | 状态 |',
          '| --- | --- |',
          '| 视线 | 保持 |',
          '',
          `${'阅读历史时不能把视角拽回底部。\n'.repeat(12)}`,
        ].join('\n'),
      },
    );
    await expect(page.locator('#jump-latest-label')).toHaveText('有新消息 · 回到最新', {
      timeout: 15_000,
    });
    const after = await messageBox(page);
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(4);
    expect(after.jumpHidden).toBe(false);

    await page.locator('#jump-latest').tap();
    await expect.poll(() => bottomGap(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
    await expect(
      page.locator(`#messages .msg[data-message-id="${sent.message.message_id}"]`),
    ).toBeVisible({ timeout: 15_000 });
  });
});
