import { chromium } from 'playwright';
import { createFixture } from './fixture';
import { rawTool } from '../verify-web';

const fixture = await createFixture(['chat']);
const d = fixture.scenarios.chat;
const id = () => crypto.randomUUID();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox'] });
try {
  const found = await rawTool<any>(d.me.token, 'network_message_search', { room_id: d.rooms.history.room_id, query: '青柠', limit: 10 });
  const recent = await rawTool<any>(d.me.token, 'network_history_list', { room_id: d.rooms.history.room_id, limit: 50 });
  if (!found.items.some((item: any) => item.snippet.includes('青柠') && !recent.items.some((row: any) => row.message_id === item.message_id))) throw new Error('full-history search missed unloaded message 23 青柠');
  const context = await rawTool<any>(d.me.token, 'network_message_context', { room_id: d.rooms.history.room_id, message_id: found.items[0].message_id, before: 2, after: 2 });
  if (context.items.length !== 5 || !context.items.some((item: any) => item.message_id === found.items[0].message_id)) throw new Error('bounded context window is incorrect');
  for (const body of ['分页标记旧一', '分页标记旧二']) await rawTool(d.me.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: d.rooms.history.room_id, body, invoke: [] });
  const firstPage = await rawTool<any>(d.me.token, 'network_message_search', { room_id: d.rooms.history.room_id, query: '分页标记', limit: 1 });
  if (!firstPage.next_cursor) throw new Error('search pagination did not return cursor');
  await rawTool(d.me.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: d.rooms.history.room_id, body: '分页标记新一', invoke: [] });
  const secondPage = await rawTool<any>(d.me.token, 'network_message_search', { room_id: d.rooms.history.room_id, query: '分页标记', limit: 1, cursor: firstPage.next_cursor });
  if (secondPage.items.some((item: any) => item.snippet.includes('新一'))) throw new Error('search page exceeded its fixed snapshot');
  let queryCursorDenied = false;
  try { await rawTool(d.me.token, 'network_message_search', { room_id: d.rooms.history.room_id, query: 'changed query', limit: 1, cursor: firstPage.next_cursor }); } catch { queryCursorDenied = true; }
  if (!queryCursorDenied) throw new Error('search cursor was reusable with a different query');
  const longQuery = '青'.repeat(200);
  for (const suffix of ['一', '二']) await rawTool(d.me.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: d.rooms.history.room_id, body: longQuery + suffix, invoke: [] });
  const longFirst = await rawTool<any>(d.me.token, 'network_message_search', { room_id: d.rooms.history.room_id, query: longQuery, limit: 1 });
  if (!longFirst.next_cursor) throw new Error('200-character query did not produce a pagination cursor');
  await rawTool<any>(d.me.token, 'network_message_search', { room_id: d.rooms.history.room_id, query: longQuery, limit: 1, cursor: longFirst.next_cursor });
  const recalled = await rawTool<any>(d.me.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: d.rooms.history.room_id, body: '撤回搜索标记', invoke: [] });
  await rawTool(d.me.token, 'network_message_recall', { request_id: id(), message_id: recalled.message.message_id });
  const recalledSearch = await rawTool<any>(d.me.token, 'network_message_search', { room_id: d.rooms.history.room_id, query: '撤回搜索标记' });
  if (recalledSearch.items.length) throw new Error('recalled tombstone appeared in search');
  const outsider = d.longName;
  let denied = false;
  try { await rawTool(outsider.token, 'network_message_search', { room_id: d.rooms.history.room_id, query: '青柠' }); } catch { denied = true; }
  if (!denied) throw new Error('nonmember search was not denied');
  const preJoin = await rawTool<any>(d.wang.token, 'network_room_create', { request_id: id(), kind: 'group', title: '历史边界验证', members: [d.me.actor_id] });
  const edgeRoom = preJoin.room;
  await rawTool(d.wang.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: edgeRoom.room_id, body: '加入前私密标记', invoke: [] });
  const invitation = preJoin.invited.find((item: any) => item.actor_id === d.me.actor_id);
  await rawTool(d.me.token, 'network_room_invite_respond', { request_id: id(), invitation_id: invitation.invitation_id, action: 'accept' });
  const hiddenBeforeJoin = await rawTool<any>(d.me.token, 'network_message_search', { room_id: edgeRoom.room_id, query: '加入前私密标记' });
  if (hiddenBeforeJoin.items.length) throw new Error('from_join leaked a pre-join message');
  let policyRevision = edgeRoom.policy_revision ?? 1;
  const fullPolicy = await rawTool<any>(d.wang.token, 'network_room_policy_set', { request_id: id(), room_id: edgeRoom.room_id, member_history_policy: 'full', expected_policy_revision: policyRevision });
  policyRevision = fullPolicy.room?.policy_revision ?? fullPolicy.policy_revision ?? policyRevision + 1;
  const visibleWithFull = await rawTool<any>(d.me.token, 'network_message_search', { room_id: edgeRoom.room_id, query: '加入前私密标记' });
  if (!visibleWithFull.items.length) throw new Error('full policy did not expose pre-join history');
  await rawTool(d.wang.token, 'network_room_policy_set', { request_id: id(), room_id: edgeRoom.room_id, member_history_policy: 'from_join', expected_policy_revision: policyRevision });
  const hiddenAfterPolicyClose = await rawTool<any>(d.me.token, 'network_message_search', { room_id: edgeRoom.room_id, query: '加入前私密标记' });
  if (hiddenAfterPolicyClose.items.length) throw new Error('search retained pre-join visibility after full policy closed');
  let wrongRoomDenied = false;
  try { await rawTool(d.me.token, 'network_message_context', { room_id: d.rooms.directWang.room_id, message_id: found.items[0].message_id }); } catch { wrongRoomDenied = true; }
  if (!wrongRoomDenied) throw new Error('context accepted a message ID from another room');
  for (const body of ['重加游标标记一', '重加游标标记二']) await rawTool(d.wang.token, 'network_message_send', { request_id: id(), client_message_id: id(), room_id: edgeRoom.room_id, body, invoke: [] });
  const beforeRejoin = await rawTool<any>(d.me.token, 'network_message_search', { room_id: edgeRoom.room_id, query: '重加游标标记', limit: 1 });
  if (!beforeRejoin.next_cursor) throw new Error('rejoin cursor fixture failed to paginate');
  await rawTool(d.me.token, 'network_room_leave', { request_id: id(), room_id: edgeRoom.room_id });
  await rawTool(d.wang.token, 'network_room_members_update', { request_id: id(), room_id: edgeRoom.room_id, add: [d.me.actor_id] });
  let staleRejoinCursorDenied = false;
  try { await rawTool(d.me.token, 'network_message_search', { room_id: edgeRoom.room_id, query: '重加游标标记', limit: 1, cursor: beforeRejoin.next_cursor }); } catch (error: any) { staleRejoinCursorDenied = /CURSOR_EXPIRED/.test(error.message); }
  if (!staleRejoinCursorDenied) throw new Error('pre-rejoin cursor was not rejected after rejoining');

  const contextPage = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await contextPage.addInitScript((token) => localStorage.setItem('agent-network-token', token), d.me.token);
  const page = await contextPage.newPage(); page.setDefaultTimeout(10000);
  await page.goto(fixture.base + '/c/' + d.rooms.history.room_id);
  await page.locator('#chat-body').waitFor();
  const searchButton = page.getByRole('button', { name: '搜索聊天记录' });
  await searchButton.waitFor(); await searchButton.click();
  await page.getByRole('searchbox', { name: '搜索消息内容' }).fill('青柠');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByText(/青柠会议室/).waitFor();
  await page.getByText(/青柠会议室/).click();
  await page.getByRole('dialog', { name: '查看上下文' }).waitFor();
  await page.getByText(/第 22 条/).waitFor();
  await contextPage.close();
  await rawTool(d.me.token, 'network_room_dissolve', { request_id: id(), room_id: d.rooms.history.room_id });
  const archiveContext = await rawTool<any>(d.me.token, 'network_message_context', { room_id: d.rooms.history.room_id, message_id: found.items[0].message_id });
  if (!archiveContext.items.some((item: any) => item.message_id === found.items[0].message_id)) throw new Error('dissolved archive context was unavailable');
  console.log(JSON.stringify({ searchMatchSeq: found.items[0].created_seq, contextRows: context.items.length, nonmemberDenied: denied, fixedSnapshotAndQueryBoundCursor: true, longUnicodeQueryCursor: true, recalledMessageExcluded: true, fromJoinAndFullPolicyBoundaries: true, staleRejoinCursorDenied, wrongRoomDenied, dissolvedArchiveContext: true, mobileSearchAndContext: true }));
} finally { await browser.close(); await fixture.stop(); }
