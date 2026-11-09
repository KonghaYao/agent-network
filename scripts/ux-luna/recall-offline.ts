import { chromium, type Page } from 'playwright';
import { Database } from 'bun:sqlite';
import { createFixture } from './fixture';
import { rawTool } from '../verify-web';

declare function syncCatchUp(): Promise<void>;

declare function callTool(name: string, args: Record<string, unknown>): Promise<unknown>;

const fixture = await createFixture(['chat']);
const d = fixture.scenarios.chat;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox'] });
const contextA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await contextA.addInitScript((token) => localStorage.setItem('agent-network-token', token), d.me.token);
await contextB.addInitScript((token) => localStorage.setItem('agent-network-token', token), d.wang.token);
const pageA = await contextA.newPage();
const pageB = await contextB.newPage();
pageA.setDefaultTimeout(10000);
pageB.setDefaultTimeout(10000);
const id = () => crypto.randomUUID();
const check = (condition: unknown, label: string) => { if (!condition) throw new Error(`失败：${label}`); console.log(`通过：${label}`); };
async function open(page: Page, roomId: string) {
  await page.goto(fixture.base);
  await page.locator('#room-filter').waitFor();
  const row = page.locator('#room-list a[href="/c/' + roomId + '"]');
  if (await row.count()) await row.click();
  else await page.goto(fixture.base + '/c/' + roomId);
  await page.locator('#chat-body').waitFor();
  await page.waitForFunction(() => document.querySelector('#chat-body')?.getAttribute('aria-busy') === 'false');
}
try {
  const db = new Database(`${fixture.dataDir}/agent-network.sqlite`, { readonly: true });
  const oldBody = '老消息检索标记：周五青柠会议室 15:30，预算 8600 元。';
  const target = db.prepare("SELECT message_id FROM messages WHERE room_id = ? AND body = ?").get(d.rooms.history.room_id, oldBody) as { message_id: string };
  db.close();
  check(Boolean(target?.message_id), '定位一条超过最新 50 条的旧消息');

  await open(pageA, d.rooms.history.room_id);
  await open(pageB, d.rooms.history.room_id);
  const targetRow = pageA.locator('#messages [data-message-id="' + target.message_id + '"]');
  for (let i = 0; i < 5 && !(await targetRow.count()); i += 1) {
    const older = pageA.locator('#older');
    if (!(await older.isVisible()) || await older.isDisabled()) break;
    await older.click();
    await pageA.waitForTimeout(80);
  }
  check(await targetRow.count() === 1, '旧消息已实际进入浏览器历史缓存');
  const beforeText = await targetRow.innerText();
  check(beforeText.includes(oldBody), '缓存中的旧消息正文在撤回前可见');
  await pageA.getByRole('tab', { name: '好友', exact: true }).click();
  await pageA.locator('#room-list a[href="/c/' + d.rooms.directWang.room_id + '"]').click();
  await pageA.waitForFunction(() => document.querySelector('#chat-body')?.getAttribute('aria-busy') === 'false');

  await contextA.setOffline(true);
  await pageA.waitForTimeout(250);
  await pageB.evaluate(async ({ requestId, messageId }) => {
    await callTool('network_message_recall', { request_id: requestId, message_id: messageId });
  }, { requestId: id(), messageId: target.message_id });
  await contextA.setOffline(false);
  await pageA.waitForTimeout(2500);
  await pageA.getByRole('tab', { name: '群聊', exact: true }).click();
  await pageA.locator('#room-list a[href="/c/' + d.rooms.history.room_id + '"]').click();
  await pageA.waitForFunction(() => document.querySelector('#chat-body')?.getAttribute('aria-busy') === 'false');
  await pageA.waitForFunction((messageId) => {
    const node = document.querySelector('#messages [data-message-id="' + messageId + '"]');
    return Boolean(node && node.textContent?.includes('此消息已撤回'));
  }, target.message_id, { timeout: 12000 });
  const after = await pageA.locator('#messages [data-message-id="' + target.message_id + '"]').innerText();
  check(after.includes('此消息已撤回') && !after.includes(oldBody), '离线期间他端撤回后，非当前房间的旧缓存被增量同步清除');

  const remaining = await pageA.locator('#messages [data-message-id]').count();
  check(remaining >= 50, '同步保留已加载的长时间线，不清空历史缓存');

  const resetBody = '强制游标重置后需要清除的展开正文：' + '权限过期正文。'.repeat(80);
  await pageA.locator('#body').fill(resetBody);
  await pageA.locator('#body').press('Enter');
  await pageA.waitForFunction((text) => document.querySelector('#messages')?.textContent?.includes(text), resetBody.slice(0, 20));
  const resetRow = pageA.locator('#messages [data-message-id]').last();
  const resetMessageId = await resetRow.getAttribute('data-message-id');
  await resetRow.locator('button.expand').click();
  await pageA.waitForFunction((text) => document.querySelector('#messages')?.textContent?.includes(text), '权限过期正文。'.repeat(20));
  const resetDb = new Database(`${fixture.dataDir}/agent-network.sqlite`, { readonly: true });
  const resetSender = resetDb.prepare('SELECT sender_id FROM messages WHERE message_id = ?').get(resetMessageId) as { sender_id: string };
  resetDb.close();
  await contextA.setOffline(true);
  await pageA.waitForTimeout(150);
  const resetSenderToken = resetSender.sender_id === d.wang.actor_id ? d.wang.token : d.me.token;
  await rawTool(resetSenderToken, 'network_message_recall', { request_id: id(), message_id: resetMessageId! });
  await pageA.evaluate(({ actorId, roomId }) => {
    const key = 'agent-network-sync-v1:' + actorId;
    const cursors = JSON.parse(localStorage.getItem(key) || '{}');
    const payload = { v: 1, scope: 'sync:room:' + roomId, dir: 'after', seq: -1, snapshot: -1 };
    cursors['room:' + roomId] = btoa(JSON.stringify(payload)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    localStorage.setItem(key, JSON.stringify(cursors));
  }, { actorId: d.me.actor_id, roomId: d.rooms.history.room_id });
  await contextA.setOffline(false);
  await pageA.evaluate(async () => { if (typeof syncCatchUp === 'function') await syncCatchUp(); });
  await pageA.waitForFunction((messageId) => {
    const row = document.querySelector('#messages [data-message-id="' + messageId + '"]');
    return Boolean(row && row.textContent?.includes('此消息已撤回'));
  }, resetMessageId, { timeout: 12000 });
  const cursorAfterReset = await pageA.evaluate(({ actorId, roomId }) => {
    const store = JSON.parse(localStorage.getItem('agent-network-sync-v1:' + actorId) || '{}');
    const cursor = store['room:' + roomId];
    if (!cursor) return -1;
    const padded = cursor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - cursor.length % 4) % 4);
    return JSON.parse(atob(padded)).seq;
  }, { actorId: d.me.actor_id, roomId: d.rooms.history.room_id });
  check(cursorAfterReset >= 0, 'reset_required清理房间缓存后推进sync游标');
  check(!(await pageA.locator('#messages [data-message-id="' + resetMessageId + '"]').innerText()).includes('权限过期正文。'), 'reset_required后权威刷新不恢复旧展开正文');

  const privateBody = '被移出房间后必须清理的展开正文：' + '本地缓存秘密内容。'.repeat(80);
  await rawTool(d.wang.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: d.rooms.history.room_id, body: privateBody, invoke: [] });
  await pageB.getByRole('tab', { name: '好友', exact: true }).click();
  await pageB.locator('#room-list a[href="/c/' + d.rooms.directWang.room_id + '"]').click();
  await pageB.getByRole('tab', { name: '群聊', exact: true }).click();
  await pageB.locator('#room-list a[href="/c/' + d.rooms.history.room_id + '"]').click();
  await pageB.waitForFunction(() => document.querySelector('#chat-body')?.getAttribute('aria-busy') === 'false');
  const privateRow = pageB.locator('#messages [data-message-id]').last();
  await pageB.waitForFunction((text) => document.querySelector('#messages')?.textContent?.includes(text), privateBody.slice(0, 20));
  const privateMessageId = await privateRow.getAttribute('data-message-id');
  check(Boolean(privateMessageId), '建立待验证的展开正文缓存');
  await privateRow.locator('button.expand').click();
  await pageB.waitForFunction((text) => document.querySelector('#messages')?.textContent?.includes(text), '本地缓存秘密内容。'.repeat(20));
  check(await privateRow.locator('button.expand').count() === 0, '展开正文已显示完整内容');
  await contextB.setOffline(true);
  await pageB.waitForTimeout(150);
  await pageA.evaluate(async ({ requestId, roomId, actorId }) => {
    await callTool('network_room_members_update', { request_id: requestId, room_id: roomId, remove: [actorId] });
  }, { requestId: id(), roomId: d.rooms.history.room_id, actorId: d.wang.actor_id });
  await contextB.setOffline(false);
  await pageB.waitForFunction(() => !document.querySelector('#messages')?.textContent?.includes('本地缓存秘密内容。') &&
    document.querySelector('#send')?.hasAttribute('disabled'), undefined, { timeout: 12000 });
  check(await pageB.locator('#send').isDisabled(), '失去成员资格后立即清空正文并禁用发送');
  check(!await pageB.locator('#messages').innerText().then((text) => text.includes('本地缓存秘密内容。')), '失去成员资格后展开正文不再保留在页面');
  console.log('离线撤回前端同步通过');
} finally {
  await browser.close();
  await fixture.stop();
}
