/**
 * Task Focus Web 端验收（TF-06）。
 *
 * 真实迁移 + 临时 DATA_DIR + 真实 Bun 服务，通过 MCP 注册两位 Human、创建
 * 两个房间与消息，再用 SQL 种入 owner 自己的卡与证据。Playwright 在
 * 1440×900 与 390×844 下覆盖入口、浮窗、三列、详情、归档、快速跳转、
 * 原消息直达与返回断点。只做本机验收，不访问生产。
 *
 * 运行：bun scripts/verify-focus-web.ts（会先构建 web）。
 */

import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';

import { chromium, type Browser, type Page } from 'playwright';

import { check, checkEqual, checksPassed } from './lib/harness';
import { initScript, rawTool, startServer } from './lib/web-test-fixture';

const ROOT = resolve(import.meta.dir, '..');
const AT = Date.now();

interface Actor {
  actor_id: string;
  name: string;
  kind: string;
}

interface RoomDetail {
  room: { room_id: string; title?: string };
}

interface FocusStatusView {
  enabled: boolean;
  status: string;
  counts: { needs_me: number; tracking: number; done: number; archived: number };
  secretary_actor_id: string | null;
  runtime_ready: boolean;
}

interface MessageIds {
  gate: string;
  regression: string;
  design: string;
  rota: string;
  retro: string;
  pack: string;
  delivered: string;
  private: string;
}

interface Seeded {
  gateRoom: string;
  otherRoom: string;
  privateRoom: string;
  gateEvidenceMessage: string;
  messages: MessageIds;
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function befriend(requesterToken: string, targetToken: string, targetId: string): Promise<void> {
  const requested = await rawTool<{
    status: string;
    request: { contact_request_id: string } | null;
  }>(requesterToken, 'network_contact_request', {
    request_id: requestId('contact_request'),
    actor_id: targetId,
  });
  if (requested.status === 'accepted') return;
  if (!requested.request) throw new Error(`好友申请未进入 pending: ${requested.status}`);
  await rawTool(targetToken, 'network_contact_request_respond', {
    request_id: requestId('contact_accept'),
    contact_request_id: requested.request.contact_request_id,
    action: 'accept',
  });
}

async function send(
  token: string,
  roomId: string,
  body: string,
): Promise<string> {
  const sent = await rawTool<{ message: { message_id: string } }>(token, 'network_message_send', {
    request_id: requestId('send'),
    client_message_id: crypto.randomUUID(),
    room_id: roomId,
    body,
    invoke: [],
  });
  return sent.message.message_id;
}

async function createRoom(
  token: string,
  members: string[],
  title: string,
): Promise<string> {
  const created = await rawTool<RoomDetail>(token, 'network_room_create', {
    request_id: requestId('room'),
    kind: 'group',
    members,
    title,
  });
  return created.room.room_id;
}

async function enableAndActivate(
  token: string,
  ownerId: string,
  db: Database,
): Promise<string> {
  const status = await rawTool<FocusStatusView>(token, 'network_focus_enable', {
    request_id: requestId('focus_enable'),
  });
  if (!status.secretary_actor_id) throw new Error('开启后缺少秘书 actor');
  db.prepare(
    "UPDATE focus_bindings SET status = 'active', enabled_at = ?, updated_at = ? WHERE owner_actor_id = ?",
  ).run(AT, AT, ownerId);
  return status.secretary_actor_id;
}

function seedItem(
  db: Database,
  input: {
    itemId: string;
    owner: string;
    secretary: string;
    title: string;
    column: 'needs_me' | 'tracking' | 'done';
    nextStep?: string;
    waitingOn?: string | null;
    dueText?: string | null;
    dueAt?: number | null;
    summary?: string;
    version?: number;
    archivedAt?: number | null;
    updatedAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO focus_items
       (item_id, owner_actor_id, secretary_actor_id, title, column_key, next_step,
        waiting_on, due_at, due_text, summary, version, archived_at, archived_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.itemId,
    input.owner,
    input.secretary,
    input.title,
    input.column,
    input.nextStep ?? '',
    input.waitingOn ?? null,
    input.dueAt ?? null,
    input.dueText ?? null,
    input.summary ?? '',
    input.version ?? 1,
    input.archivedAt ?? null,
    input.archivedAt ? input.owner : null,
    AT,
    input.updatedAt ?? AT,
  );
}

function seedEvidence(
  db: Database,
  input: {
    evidenceId: string;
    itemId: string;
    owner: string;
    roomId: string;
    messageId: string;
    purpose?: string;
    createdAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO focus_evidence
       (evidence_id, item_id, owner_actor_id, source_kind, source_key, room_id, message_id,
        delivery_id, source_revision, purpose, occurred_at, created_at)
     VALUES (?, ?, ?, 'message', ?, ?, ?, NULL, 1, ?, ?, ?)`,
  ).run(
    input.evidenceId,
    input.itemId,
    input.owner,
    `message:${input.messageId}`,
    input.roomId,
    input.messageId,
    input.purpose ?? 'source',
    input.createdAt ?? AT,
    input.createdAt ?? AT,
  );
}

function seed(db: Database, owner: Actor, other: Actor, secretary: string, data: Seeded): void {
  const m = data.messages;
  const base = {
    gateEvidenceMessage: data.gateEvidenceMessage,
  };
  seedItem(db, {
    itemId: 'fit_gate',
    owner: owner.actor_id,
    secretary,
    title: '确认 RC2 灰度放行',
    column: 'needs_me',
    nextStep: '确认是否放行，回复发布群',
    waitingOn: '我来决定',
    dueText: '今天 16:00',
    summary: '回归 32/32 通过，周敏已私聊交付 RC2，轮到你确认是否放行。',
    version: 3,
    updatedAt: AT + 100,
  });
  seedEvidence(db, {
    evidenceId: 'fev_gate_old',
    itemId: 'fit_gate',
    owner: owner.actor_id,
    roomId: data.gateRoom,
    messageId: m.gate,
    createdAt: AT + 1,
  });
  seedEvidence(db, {
    evidenceId: 'fev_gate_delivery',
    itemId: 'fit_gate',
    owner: owner.actor_id,
    roomId: data.otherRoom,
    messageId: base.gateEvidenceMessage,
    purpose: 'delivery',
    createdAt: AT + 2,
  });
  db.prepare(
    `INSERT INTO focus_revisions
       (revision_id, item_id, version, decision_id, changes_json, reason, evidence_json, created_at)
     VALUES (?, 'fit_gate', 3, ?, '{}', '周敏交付安装包', '[]', ?)`,
  ).run('frev_gate_3', 'dec_gate_3', AT + 3);

  seedItem(db, {
    itemId: 'fit_retro',
    owner: owner.actor_id,
    secretary,
    title: '整理本轮灰度复盘',
    column: 'needs_me',
    nextStep: '把一页灰度复盘发给阿宁',
    waitingOn: '我的交付',
    dueText: '明天 10:00',
    summary: '阿宁另行委托你整理一页复盘，包含放行决定和交付时间。',
    version: 1,
    updatedAt: AT + 90,
  });
  seedEvidence(db, {
    evidenceId: 'fev_retro',
    itemId: 'fit_retro',
    owner: owner.actor_id,
    roomId: data.gateRoom,
    messageId: m.retro,
  });

  seedItem(db, {
    itemId: 'fit_restricted',
    owner: owner.actor_id,
    secretary,
    title: '失去来源的旧事项',
    column: 'needs_me',
    nextStep: '旧的下一次动作',
    summary: '这条内容不应出现在界面上。',
    version: 1,
    updatedAt: AT + 80,
  });
  seedEvidence(db, {
    evidenceId: 'fev_restricted_visible',
    itemId: 'fit_restricted',
    owner: owner.actor_id,
    roomId: data.gateRoom,
    messageId: m.pack,
  });
  seedEvidence(db, {
    evidenceId: 'fev_restricted_hidden',
    itemId: 'fit_restricted',
    owner: owner.actor_id,
    roomId: data.privateRoom,
    messageId: m.private,
  });

  const trackingTitles = [
    '等周敏交付 RC2 安装包',
    '跟进事项 01',
    '跟进事项 02',
    '跟进事项 03',
    '跟进事项 04',
    '跟进事项 05',
    '跟进事项 06',
    '跟进事项 07',
    '跟进事项 08',
  ];
  trackingTitles.forEach((title, index) => {
    const itemId = index === 0 ? 'fit_wait' : `fit_track_${index}`;
    seedItem(db, {
      itemId,
      owner: owner.actor_id,
      secretary,
      title,
      column: 'tracking',
      nextStep: title === '等周敏交付 RC2 安装包' ? '等周敏确认' : '等待对方进展',
      waitingOn: index === 0 ? '周敏' : '对方',
      summary: '测试跟进列。',
      updatedAt: AT - index,
    });
    seedEvidence(db, {
      evidenceId: `fev_${itemId}`,
      itemId,
      owner: owner.actor_id,
      roomId: index === 0 ? data.otherRoom : data.gateRoom,
      messageId: index === 0 ? m.delivered : m.regression,
      createdAt: AT + index,
    });
  });

  seedItem(db, {
    itemId: 'fit_done',
    owner: owner.actor_id,
    secretary,
    title: '选定移动端导航方案',
    column: 'done',
    nextStep: '',
    summary: '你已确认第二版，乔伊可以进稿。',
    version: 1,
    updatedAt: AT - 20,
  });
  seedEvidence(db, {
    evidenceId: 'fev_done',
    itemId: 'fit_done',
    owner: owner.actor_id,
    roomId: data.gateRoom,
    messageId: m.design,
  });

  seedItem(db, {
    itemId: 'fit_archived',
    owner: owner.actor_id,
    secretary,
    title: '交周末值班排班表',
    column: 'needs_me',
    nextStep: '',
    summary: '已完成并归档。',
    version: 2,
    archivedAt: AT - 100,
    updatedAt: AT - 100,
  });
  seedEvidence(db, {
    evidenceId: 'fev_archived',
    itemId: 'fit_archived',
    owner: owner.actor_id,
    roomId: data.gateRoom,
    messageId: m.rota,
  });

  // 另一位 owner 的卡：A 的看板与快速跳转都不得出现。
  seedItem(db, {
    itemId: 'fit_other_owner',
    owner: other.actor_id,
    secretary: 'agt_other_secretary_placeholder',
    title: '周敏的私事：整理值班表',
    column: 'needs_me',
    nextStep: '只给周敏看',
    summary: '另一 owner 的内容。',
    version: 1,
  });
}

async function waitText(page: Page, selector: string, text: string, timeout = 15_000): Promise<void> {
  await page.locator(selector).filter({ hasText: text }).first().waitFor({ timeout });
}

async function openEntryBoard(page: Page): Promise<void> {
  await page.locator('#focus-entry').waitFor({ state: 'visible' });
  await page.locator('#focus-entry').click();
  await page.locator('#focus-board').waitFor({ state: 'visible' });
}

async function closeBoardWithEscape(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  await page.keyboard.press('Escape');
}

async function main() {
  const build = Bun.spawnSync(['bun', 'run', 'build:web'], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (build.exitCode !== 0) throw new Error('构建 web 失败');

  const server = await startServer();
  process.env.AGENTNET_URL = server.base;
  let db: Database | undefined;
  let browser: Browser | undefined;
  try {
    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    const tokenC = crypto.randomUUID();
    const tokenD = crypto.randomUUID();
    const humanA = await rawTool<Actor>(tokenA, 'network_register', {
      request_id: requestId('reg'),
      kind: 'human',
      name: '林舟',
    });
    const humanB = await rawTool<Actor>(tokenB, 'network_register', {
      request_id: requestId('reg'),
      kind: 'human',
      name: '周敏',
    });
    const humanC = await rawTool<Actor>(tokenC, 'network_register', {
      request_id: requestId('reg'),
      kind: 'human',
      name: '空看板',
    });
    const humanD = await rawTool<Actor>(tokenD, 'network_register', {
      request_id: requestId('reg'),
      kind: 'human',
      name: '宋青',
    });
    await befriend(tokenA, tokenB, humanB.actor_id);
    await befriend(tokenB, tokenD, humanD.actor_id);

    const gateRoom = await createRoom(tokenA, [humanB.actor_id], '版本发布群');
    const otherRoom = await createRoom(tokenA, [humanB.actor_id], '灰度验收群');
    const privateRoom = await createRoom(tokenB, [humanD.actor_id], '周敏的私事');

    const messages = {
      gate: await send(
        tokenA,
        gateRoom,
        '本轮 RC2 灰度，等回归结果和安装包都齐了，由我拍板。周敏负责交包。',
      ),
      regression: await send(tokenB, gateRoom, '回归 32/32 通过，结果已核对。'),
      design: await send(tokenA, gateRoom, '空状态插画第二版已确认。'),
      rota: await send(tokenA, gateRoom, '周末排班表我先整理。'),
      retro: await send(tokenA, gateRoom, '阿宁请你明天 10:00 前交一页灰度复盘。'),
      pack: await send(tokenB, gateRoom, 'RC2 安装包已准备好。'),
      delivered: await send(
        tokenB,
        otherRoom,
        '发布群约定的 RC2 安装包已经交付，版本 rc2。林舟，轮到你确认灰度了。',
      ),
      private: await send(tokenB, privateRoom, '这里只有周敏能看到。'),
    };

    db = new Database(join(server.dataDir, 'agent-network.sqlite'));
    db.exec('PRAGMA busy_timeout = 5000;');
    const secretaryA = await enableAndActivate(tokenA, humanA.actor_id, db);
    const secretaryB = await enableAndActivate(tokenB, humanB.actor_id, db);
    seed(db, humanA, humanB, secretaryA, {
      gateRoom,
      otherRoom,
      privateRoom,
      gateEvidenceMessage: messages.delivered,
      messages,
    });
    // B 自己的卡使用 B 的秘书；A 永远读不到。
    db.prepare('UPDATE focus_items SET secretary_actor_id = ? WHERE item_id = ?').run(
      secretaryB,
      'fit_other_owner',
    );

    browser = await chromium.launch();
    const allErrors: string[] = [];

    // ---------- 桌面：入口、浮窗、三列、详情、归档、SSE ----------
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await desktop.addInitScript({ content: initScript(tokenA) });
    const page = await desktop.newPage();
    page.on('pageerror', (error) => allErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') allErrors.push(`console: ${message.text()}`);
    });
    await page.goto(`${server.base}/`);
    await page.locator('#focus-entry').waitFor({ state: 'visible' });
    check('入口：未进入聊天也可开启/打开我的看板', (await page.locator('#focus-entry').innerText()).includes('我的看板'));
    checkEqual('入口：needs_me 计数徽标', (await page.locator('.focus-entry-count').innerText()).trim(), '3');
    await openEntryBoard(page);
    check('浮窗：标题', (await page.locator('#focus-board-title').innerText()).includes('我的看板'));
    check(
      '浮窗：副标题显示需要我的数量',
      (await page.locator('.focus-board-sub').innerText()).includes('林舟的任务秘书 · 3 件需要我'),
    );
    checkEqual('浮窗：当前 tab 计数', (await page.locator('.focus-tabs button').nth(0).innerText()).replace(/\s+/gu, ' '), '当前事项 13');
    checkEqual('浮窗：已归档 tab 计数', (await page.locator('.focus-tabs button').nth(1).innerText()).replace(/\s+/gu, ' '), '已归档 1');
    for (const lane of ['needs_me', 'tracking', 'done']) {
      check(`三列可见：${lane}`, await page.locator(`.focus-lane[data-lane="${lane}"]`).isVisible());
    }
    checkEqual(
      '需要我列计数',
      (await page.locator('.focus-lane[data-lane="needs_me"] .focus-lane-count').innerText()).trim(),
      '3',
    );
    checkEqual(
      '跟进中列计数',
      (await page.locator('.focus-lane[data-lane="tracking"] .focus-lane-count').innerText()).trim(),
      '9',
    );
    check('restricted 卡只显示来源已失效', (await page.locator('.focus-card--restricted').innerText()).includes('来源已失效'));
    check(
      'restricted 卡不显示被遮蔽内容',
      !(await page.locator('.focus-card--restricted').innerText()).includes('失去来源的旧事项'),
    );
    check(
      '另一 owner 的事项不出现',
      (await page.locator('#focus-board').getByText('周敏的私事：整理值班表').count()) === 0,
    );
    if (process.env.FOCUS_SHOTS === '1') {
      await page.screenshot({ path: '/tmp/focus-desktop.png' });
    }
    // 点击遮罩一次收起整窗，再重新打开继续。
    await page.mouse.click(5, 5);
    await page.locator('#focus-board').waitFor({ state: 'detached', timeout: 10_000 });
    check('点击遮罩收起整窗', (await page.locator('#focus-board').count()) === 0);
    await openEntryBoard(page);

    // 详情：桌面右侧并排。
    await page.locator('[data-focus-item="fit_gate"] .focus-card-body').click();
    await page.locator('.focus-detail').waitFor({ state: 'visible' });
    check('详情：与三列并排', await page.locator('.focus-lane[data-lane="needs_me"]').isVisible());
    check('详情：标题', (await page.locator('.focus-detail-title').innerText()).includes('确认 RC2 灰度放行'));
    await waitText(page, '.focus-evidence-sender', '周敏');
    check('详情：证据显示发送人', (await page.locator('.focus-evidence-sender').allInnerTexts()).includes('周敏'));
    check('详情：证据显示会话名', (await page.locator('.focus-evidence-room').allInnerTexts()).some((text) => text.includes('灰度验收群')));
    check('详情：修订历史可折叠', await page.locator('.focus-revisions summary').isVisible());
    check('详情：底部归档按钮', await page.locator('.focus-archive-button').isVisible());
    if (process.env.FOCUS_SHOTS === '1') {
      await page.screenshot({ path: '/tmp/focus-desktop-detail.png' });
    }

    // 归档确认：从列移除、计数更新、轻提示。
    await page.locator('.focus-archive-button').click();
    await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
    await page.locator('#confirm-dialog-ok').click();
    await page.locator('[data-focus-item="fit_gate"]').waitFor({ state: 'detached' });
    check('归档后卡片从列移除', (await page.locator('[data-focus-item="fit_gate"]').count()) === 0);
    check(
      '归档后副标题计数更新',
      (await page.locator('.focus-board-sub').innerText()).includes('2 件需要我'),
    );
    checkEqual(
      '归档后已归档 tab 计数',
      (await page.locator('.focus-tabs button').nth(1).innerText()).replace(/\s+/gu, ' '),
      '已归档 2',
    );
    check('归档轻提示', (await page.locator('.focus-notice').innerText()).includes('已归档『') || (await page.locator('.focus-notice').innerText()).includes('已归档「'));

    // 已归档只读。
    await page.locator('.focus-tabs button').nth(1).click();
    await page.locator('[data-focus-item="fit_gate"]').waitFor({ state: 'visible' });
    await page.locator('[data-focus-item="fit_gate"] .focus-card-body').click();
    await page.locator('.focus-detail').waitFor({ state: 'visible' });
    check('已归档详情只读（无归档按钮）', (await page.locator('.focus-archive-button').count()) === 0);
    check('已归档详情显示归档时间', (await page.locator('.focus-detail-foot').innerText()).includes('已归档'));
    await page.keyboard.press('Escape');
    await page.locator('.focus-detail').waitFor({ state: 'detached' });
    await page.locator('.focus-tabs button').nth(0).click();

    // SSE：外部归档后看板自动失效，不需要刷新页面。
    await rawTool(tokenA, 'network_focus_archive', {
      item_id: 'fit_done',
      request_id: requestId('archive_sse'),
      expected_version: 1,
    });
    await page.locator('[data-focus-item="fit_done"]').waitFor({ state: 'detached', timeout: 12_000 });
    check('SSE focus.updated 自动刷新列', (await page.locator('[data-focus-item="fit_done"]').count()) === 0);
    checkEqual(
      'SSE 后已归档计数',
      (await page.locator('.focus-tabs button').nth(1).innerText()).replace(/\s+/gu, ' '),
      '已归档 3',
    );

    // ⌘K：快速跳转、输入自动聚焦、方向键、Esc 顺序。
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await page.keyboard.press('Meta+k');
    await page.locator('#focus-board').waitFor({ state: 'visible' });
    await page.locator('#focus-quick-input').waitFor({ state: 'visible' });
    checkEqual(
      '⌘K 打开快速跳转并聚焦输入',
      await page.evaluate(() => document.activeElement?.id ?? ''),
      'focus-quick-input',
    );
    await page.locator('#focus-quick-input').fill('RC2');
    await page.locator('.focus-quick-row').first().waitFor({ timeout: 10_000 });
    await page.keyboard.press('ArrowDown');
    checkEqual(
      '快速跳转 ↑↓ 选择',
      await page.locator('#focus-quick-results [role="option"]').nth(1).getAttribute('aria-selected'),
      'true',
    );
    await page.keyboard.press('Escape');
    await page.locator('#focus-quick-input').waitFor({ state: 'detached' });
    check('Esc 先收起搜索', await page.locator('#focus-board').isVisible());
    await page.keyboard.press('Escape');
    await page.locator('.focus-detail').waitFor({ state: 'detached' });
    await page.keyboard.press('Meta+k');
    await page.locator('#focus-quick-input').waitFor({ state: 'visible' });

    // 中文组合输入不提交。
    await page.locator('#focus-quick-input').fill('RC2');
    await page.locator('.focus-quick-row').first().waitFor({ timeout: 10_000 });
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#focus-quick-input');
      if (!input) return;
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    check('中文组合输入 Enter 不提交', await page.locator('#focus-quick-input').isVisible());

    // 事项结果：Enter 打开详情。
    await page.locator('#focus-quick-input').fill('整理本轮灰度复盘');
    await page.locator('.focus-quick-row').first().waitFor({ timeout: 10_000 });
    await page.keyboard.press('Enter');
    await page.locator('#focus-quick-input').waitFor({ state: 'detached' });
    await page.locator('.focus-detail-title').filter({ hasText: '整理本轮灰度复盘' }).waitFor();
    check('事项搜索结果打开详情', (await page.locator('.focus-detail-title').innerText()).includes('整理本轮灰度复盘'));
    await page.keyboard.press('Escape');
    await page.locator('.focus-detail').waitFor({ state: 'detached' });

    // 原消息结果：收起浮窗、跨房定位、返回断点恢复搜索词。
    await page.locator('#focus-quick-trigger').click();
    await page.locator('#focus-quick-input').fill('安装包已经交付');
    await page.locator('.focus-quick-row').first().waitFor({ timeout: 10_000 });
    check(
      '原消息结果显示会话与发言人',
      (await page.locator('.focus-quick-row-sub').first().innerText()).includes('灰度验收群'),
    );
    await page.keyboard.press('Enter');
    await page.locator('#focus-board').waitFor({ state: 'detached', timeout: 10_000 });
    await page.waitForURL(`**/c/${otherRoom}`, { timeout: 10_000 });
    await page.locator('.msg.search-active').first().waitFor({ timeout: 10_000 });
    check('原消息跳转到另一会话并高亮', page.url().includes(`/c/${otherRoom}`));
    await page.locator('#focus-return').waitFor({ state: 'visible' });
    await page.locator('#focus-return').click();
    await page.locator('#focus-board').waitFor({ state: 'visible' });
    await page.locator('#focus-quick-input').waitFor({ state: 'visible' });
    checkEqual(
      '返回看板恢复搜索词',
      await page.locator('#focus-quick-input').inputValue(),
      '安装包已经交付',
    );
    await page
      .locator('#focus-quick-results [role="option"][aria-selected="true"]')
      .first()
      .waitFor({ timeout: 10_000 });
    check(
      '返回看板恢复选中结果',
      (await page.locator('#focus-quick-results [role="option"][aria-selected="true"]').count()) === 1,
    );
    await page.keyboard.press('Escape');
    await page.locator('#focus-quick-input').waitFor({ state: 'detached' });

    // 详情 → 原消息 → 返回同一条事项与列滚动位置。
    await page.locator('[data-focus-item="fit_wait"] .focus-card-body').click();
    await page.locator('.focus-detail').waitFor({ state: 'visible' });
    await page
      .locator('.focus-lane[data-lane="tracking"] .focus-lane-cards')
      .evaluate((node) => {
        node.scrollTop = 180;
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
    await page.waitForTimeout(100);
    await page.locator('.focus-evidence-item .focus-card-action').first().click();
    await page.waitForURL(`**/c/${otherRoom}`, { timeout: 10_000 });
    await page.locator('.msg.search-active').first().waitFor({ timeout: 10_000 });
    await page.locator('#focus-return').click();
    await page.locator('#focus-board').waitFor({ state: 'visible' });
    await page.locator('.focus-detail-title').filter({ hasText: '等周敏交付 RC2 安装包' }).waitFor();
    check('返回看板恢复选中事项', (await page.locator('.focus-detail-title').innerText()).includes('等周敏交付 RC2 安装包'));
    await page.waitForFunction(
      () =>
        (document.querySelector<HTMLElement>(
          '.focus-lane[data-lane="tracking"] .focus-lane-cards',
        )?.scrollTop ?? 0) >= 150,
      undefined,
      { timeout: 5_000 },
    );
    check(
      '返回看板恢复列滚动断点',
      (await page
        .locator('.focus-lane[data-lane="tracking"] .focus-lane-cards')
        .evaluate((node) => node.scrollTop)) >= 150,
    );
    await page.keyboard.press('Escape');
    await page.locator('.focus-detail').waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await page.locator('#focus-board').waitFor({ state: 'detached' });
    check('返回后跳转态清除', (await page.locator('#focus-return').count()) === 0);

    // 草稿：原地收起浮窗不改变输入；输入中 ⌘K 让位给编辑器。
    await page.locator('#body').fill('草稿留在原地');
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(200);
    check('输入草稿时 ⌘K 不抢焦点', (await page.locator('#focus-board').count()) === 0);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press('Meta+k');
    await page.locator('#focus-board').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#focus-quick-input').waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await page.locator('.focus-detail').waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await page.locator('#focus-board').waitFor({ state: 'detached' });
    checkEqual('原地收起浮窗草稿仍在', await page.locator('#body').inputValue(), '草稿留在原地');
    await desktop.close();

    // ---------- 错误重试：列表请求失败 → 一行错误 → 重试恢复 ----------
    const failContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await failContext.addInitScript({ content: initScript(tokenA) });
    const failPage = await failContext.newPage();
    await failPage.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-name'] === 'network_focus_list') {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await failPage.goto(`${server.base}/`);
    await openEntryBoard(failPage);
    await failPage.locator('.focus-state').filter({ hasText: '看板暂时打不开' }).waitFor({ timeout: 10_000 });
    check('列表失败显示一行错误', (await failPage.locator('.focus-state').innerText()).includes('看板暂时打不开'));
    check(
      '错误文案不暴露 HTTP/SQL',
      !/HTTP|SQL|500|fetch/iu.test(await failPage.locator('.focus-state').innerText()),
    );
    await failPage.unroute('**/mcp');
    await failPage.locator('.focus-state .focus-retry').click();
    await failPage.locator('[data-focus-item="fit_retro"]').waitFor({ timeout: 10_000 });
    check('错误重试后恢复三列', await failPage.locator('[data-focus-item="fit_retro"]').isVisible());
    await failContext.close();

    // ---------- 手机：AccountMenu 入口、近全屏、三 tab、详情替换列表 ----------
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    await mobile.addInitScript({ content: initScript(tokenA) });
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(`${server.base}/c/${gateRoom}`);
    await mobilePage.locator('#account-menu-toggle').waitFor({ state: 'visible' });
    await mobilePage.locator('#account-menu-toggle').click();
    const focusItem = mobilePage.getByRole('menuitem', { name: /我的看板/ });
    await focusItem.waitFor({ timeout: 10_000 });
    check('手机端菜单第一组入口与计数', (await focusItem.innerText()).includes('2 件需要我'));
    await focusItem.click();
    await mobilePage.locator('#focus-board').waitFor({ state: 'visible' });
    const boardBox = await mobilePage.locator('#focus-board').boundingBox();
    check(
      '手机端近全屏并留边距',
      Boolean(boardBox && boardBox.width >= 370 && boardBox.height >= 820),
      boardBox,
    );
    checkEqual(
      '手机端三栏 tab 数量',
      await mobilePage.locator('.focus-mobile-tabs [role="tab"]').count(),
      3,
    );
    if (process.env.FOCUS_SHOTS === '1') {
      await mobilePage.screenshot({ path: '/tmp/focus-mobile.png' });
    }
    await mobilePage.locator('.focus-mobile-tabs [data-lane="tracking"]').click();
    check('手机端切换栏目', await mobilePage.locator('.focus-lane[data-lane="tracking"]').isVisible());
    check('手机端只显示当前栏目', (await mobilePage.locator('.focus-lane').count()) === 1);
    await mobilePage.locator('[data-focus-item="fit_wait"] .focus-card-body').click();
    await mobilePage.locator('.focus-detail').waitFor({ state: 'visible' });
    check('手机端详情替换列表', (await mobilePage.locator('.focus-lane').count()) === 0);
    await mobilePage.locator('.focus-detail-back').click();
    await mobilePage.locator('.focus-lane[data-lane="tracking"]').waitFor({ state: 'visible' });
    check('手机端返回栏目', await mobilePage.locator('.focus-lane[data-lane="tracking"]').isVisible());
    await mobilePage.locator('.focus-tabs button').nth(1).click();
    await mobilePage.locator('.focus-archive-grid').waitFor({ state: 'visible' });
    check('手机端已归档列表', (await mobilePage.locator('.focus-archive-grid .focus-card').count()) >= 3);
    await mobile.close();

    // ---------- 首次开启：provisioning 静默准备 → 轮询 active → 空态 ----------
    const enable = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await enable.addInitScript({ content: initScript(tokenC) });
    const enablePage = await enable.newPage();
    await enablePage.goto(`${server.base}/`);
    await enablePage.locator('#focus-entry').waitFor({ state: 'visible' });
    checkEqual('未开启入口文案', (await enablePage.locator('#focus-entry').innerText()).trim(), '开启任务秘书');
    await enablePage.locator('#focus-entry').click();
    await enablePage.locator('#focus-board').waitFor({ state: 'visible' });
    await enablePage.locator('.focus-state').filter({ hasText: '秘书正在准备你的看板' }).waitFor({ timeout: 10_000 });
    check('provisioning 显示安静准备态', (await enablePage.locator('.focus-state').innerText()).includes('秘书正在准备你的看板'));
    await enablePage
      .locator('.focus-state')
      .filter({ hasText: '秘书暂不可用，稍后重试' })
      .waitFor({ timeout: 20_000 });
    check(
      'provisioning 超时只显示一行不可用与重试',
      (await enablePage.locator('.focus-state').innerText()).includes('秘书暂不可用，稍后重试') &&
        (await enablePage.locator('.focus-state .focus-retry').count()) === 1,
    );
    await enablePage.locator('.focus-state .focus-retry').click();
    await enablePage
      .locator('.focus-state')
      .filter({ hasText: '秘书正在准备你的看板' })
      .waitFor({ timeout: 5_000 });
    db.prepare(
      "UPDATE focus_bindings SET status = 'active', enabled_at = ?, updated_at = ? WHERE owner_actor_id = ?",
    ).run(Date.now(), Date.now(), humanC.actor_id);
    await enablePage.locator('.focus-state').filter({ hasText: '秘书还没有整理出需要你处理的事' }).waitFor({ timeout: 12_000 });
    check('active 后加载并显示空态', (await enablePage.locator('.focus-state').innerText()).includes('秘书还没有整理出需要你处理的事'));
    await enable.close();

    check('浏览器无未捕获错误', allErrors.length === 0, allErrors.slice(0, 4));
    console.log(`\n${checksPassed()} 项检查通过`);
  } finally {
    await browser?.close();
    db?.close();
    await server.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
