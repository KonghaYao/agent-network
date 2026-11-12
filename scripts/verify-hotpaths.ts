/** Real-server browser regressions for routine chat and group interactions. */
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { startServer, makeContext, rawTool } from './verify-web';

const id = () => crypto.randomUUID();
const checks: string[] = [];
function pass(name: string) { checks.push(name); console.log('PASS ' + name); }
const server = await startServer();
process.env.AGENTNET_URL = server.base;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const errors: string[] = [];
const token = id();
const tool = <T = any>(name: string, args: Record<string, unknown> = {}, auth = token) =>
  rawTool<T>(auth, name, args);
let page: Page;
async function ready(roomId: string) {
  await page.waitForFunction(`activeRoomId === ${JSON.stringify(roomId)} && room && room.room_id === activeRoomId && document.getElementById('chat-body').getAttribute('aria-busy') === 'false' && !document.getElementById('send').disabled`);
}
async function route(roomId: string) {
  await page.evaluate(`navigateTo('/c/' + ${JSON.stringify(roomId)})`);
  await ready(roomId);
}
async function delay(name: string, roomId?: string, ms = 700) {
  await page.evaluate(`window.__delayMcp = ${JSON.stringify({name, roomId, ms})}; window.__delayedMcpHit = false;`);
}
async function clearDelay() { await page.evaluate('window.__delayMcp = null'); }
async function send(roomId: string, body: string, auth = token) {
  return tool('network_message_send', {request_id:id(),client_message_id:id(),room_id:roomId,body,invoke:[]}, auth);
}
try {
  await tool('network_register', {request_id:id(),kind:'human',name:'热点验收用户'});
  const agent = await tool('network_agent_create', {request_id:id(),name:'热点验收 Agent'});
  const actor = agent.actor || agent;
  const agentToken = agent.token || new URL(agent.mcp_url).searchParams.get('token');
  const a = await tool('network_room_create', {request_id:id(),kind:'group',title:'长历史群',members:[actor.actor_id]});
  const b = await tool('network_room_create', {request_id:id(),kind:'group',title:'切换目标群',members:[actor.actor_id]});
  const aId = a.room.room_id, bId = b.room.room_id;
  for (let i=0;i<120;i++) await send(aId, i === 119 ? '**末条 Markdown**\n\n正文' : '历史消息 '+i, agentToken);
  await send(bId, '目标群唯一消息');
  const created = await makeContext(browser,token,{width:1280,height:900},errors);
  page = created.page;
  await page.goto(server.base+'/c/'+aId);
  await ready(aId);
  await page.waitForFunction(`document.querySelector('#messages .msg-markdown')`);
  await page.evaluate(`window.__keptMessage = document.querySelector('#messages .msg:last-of-type') || document.querySelector('#messages .msg'); window.__keptBubble = window.__keptMessage.querySelector('.bubble'); window.__keptSidebar = document.querySelector('#room-list a');`);
  await page.evaluate('refresh(true)');
  assert.equal(await page.evaluate('window.__keptMessage.isConnected && window.__keptBubble.isConnected'),true);
  assert.equal(await page.evaluate('window.__keptSidebar.isConnected'),true);
  pass('no-op refresh retains message, Markdown bubble and sidebar nodes');
  await page.evaluate(`window.__olderPromise = loadOlder()`);
  await page.evaluate('window.__olderPromise');
  assert.ok(await page.locator('#messages .msg').count()>50);
  await page.evaluate(`window.__oldest = document.querySelector('#messages .msg'); window.__historyCount = document.querySelectorAll('#messages .msg').length`);
  await send(aId,'新到达消息',agentToken);
  await page.evaluate('refresh(true)');
  assert.equal(await page.evaluate('window.__oldest.isConnected'),true);
  assert.ok(await page.locator('#messages .msg').count()>50);
  pass('new messages preserve loaded older-history DOM');
  await delay('network_room_get',bId);
  await page.evaluate(`navigateTo('/c/' + ${JSON.stringify(bId)})`);
  assert.equal(await page.locator('#messages .msg').count(),0);
  assert.equal(await page.locator('#send').isDisabled(),true);
  assert.equal(await page.locator('#title').textContent(),'会话');
  await route(aId);
  await new Promise(r=>setTimeout(r,800));
  assert.equal(await page.evaluate('activeRoomId'),aId);
  assert.equal(await page.locator('#title').textContent(),'长历史群');
  await clearDelay();
  pass('uncached switch clears old content immediately and ignores late responses');
  let releaseSend!: () => void;
  let sendCommitted!: () => void;
  const sendGate=new Promise<void>(resolve=>{releaseSend=resolve;});
  const sendFetched=new Promise<void>(resolve=>{sendCommitted=resolve;});
  let heldSend=false;
  await page.route('**/mcp', async request=>{
    if (!heldSend && request.request().postDataJSON()?.params?.name === 'network_message_send') {
      heldSend=true;
      const response=await request.fetch();
      sendCommitted();
      await sendGate;
      await request.fulfill({response});
    } else await request.continue();
  });
  await page.fill('#body','迟到响应的已发送消息');
  await page.click('#send');
  await sendFetched;
  await page.fill('#body','切房前输入的下一条草稿');
  await route(bId);
  releaseSend();
  await page.waitForFunction(`!composerRequests.has(${JSON.stringify(aId)})`);
  await page.unroute('**/mcp');
  await route(aId);
  assert.equal(await page.locator('#body').inputValue(),'切房前输入的下一条草稿');
  await page.fill('#body','');
  pass('late send completion preserves the next draft saved before switching rooms');
  // Sending consumes only its own explicit @ selections, independently of later text edits.
  for (const selectAgain of [false,true]) {
    await page.fill('#body','@');
    await page.locator('#mention-picker .mention-item').filter({hasText:actor.name}).first().click();
    await page.fill('#body','@'+actor.name+' 原选择发送 '+selectAgain);
    let release!: () => void;
    let committed!: () => void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const fetched=new Promise<void>(resolve=>{committed=resolve;});
    let held=false;
    await page.route('**/mcp',async request=>{
      if (!held && request.request().postDataJSON()?.params?.name === 'network_message_send') {
        held=true;
        const response=await request.fetch();
        committed();
        await gate;
        await request.fulfill({response});
      } else await request.continue();
    });
    await page.click('#send');
    await fetched;
    if (selectAgain) {
      await page.fill('#body','@');
      await page.locator('#mention-picker .mention-item').filter({hasText:actor.name}).first().click();
    }
    const nextBody='@'+actor.name+' 下一条草稿 '+selectAgain;
    await page.fill('#body',nextBody);
    release();
    await page.waitForFunction(`!composerRequests.has(${JSON.stringify(aId)})`);
    assert.equal(await page.locator('#body').inputValue(),nextBody);
    assert.equal(await page.evaluate(`(mentionSelections.get(${JSON.stringify(aId)}) || []).length`),selectAgain ? 1 : 0);
    await page.unroute('**/mcp');
    await page.click('#send');
    await page.waitForFunction(`!composerRequests.has(${JSON.stringify(aId)}) && document.getElementById('body').value === ''`);
    const args=await page.evaluate(`window.__mcpCalls.filter(x=>x.name === 'network_message_send' && x.body.params.arguments.body === ${JSON.stringify(nextBody)}).at(-1).body.params.arguments`) as { invoke?: string[] };
    if (selectAgain) assert.deepEqual(args.invoke,[actor.actor_id]);
    else assert.equal(Object.hasOwn(args,'invoke'),false);
    pass(selectAgain ? 'late send preserves newly selected mention in the next draft'
      : 'late send consumes its old mention selection without clearing the next draft');
  }
  // A committed send's follow-up refresh may be aborted by navigation; it is not a send failure.
  await page.evaluate('stopActorStream(); refresh(true)');
  let releaseRefresh!: () => void;
  let refreshStarted!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const refreshFetched = new Promise<void>(resolve => { refreshStarted = resolve; });
  await page.route('**/mcp', async request => {
    const args = request.request().postDataJSON()?.params;
    if (args?.name === 'network_room_get' && args.arguments.room_id === aId) {
      refreshStarted();
      await refreshGate;
      await request.continue().catch(() => undefined);
    } else await request.continue();
  });
  await page.fill('#body','提交后刷新时切换房间');
  await page.click('#send');
  await refreshFetched;
  await route(bId);
  releaseRefresh();
  await page.waitForFunction(`!composerRequests.has(${JSON.stringify(aId)})`);
  await page.unroute('**/mcp');
  assert.deepEqual(errors,[]);
  await route(aId);
  pass('navigation aborts post-send refresh without an unhandled error or false send failure');
  let failRefresh = true;
  await page.route('**/mcp',async request=>{
    const args=request.request().postDataJSON()?.params;
    if (failRefresh && args?.name === 'network_room_get' && args.arguments.room_id === aId) {
      failRefresh=false;
      await request.fulfill({status:503,body:'temporary read failure'});
    } else await request.continue();
  });
  await page.fill('#body','消息提交成功但刷新失败');
  await page.click('#send');
  await page.waitForFunction(`!composerRequests.has(${JSON.stringify(aId)}) && document.getElementById('status').textContent.includes('消息已发送，刷新会话失败')`);
  assert.equal((await tool('network_history_list',{room_id:aId,limit:10})).items.filter((x:any)=>x.preview.includes('消息提交成功但刷新失败')).length,1);
  assert.equal(await page.locator('#body').inputValue(),'');
  assert.equal(await page.locator('.outbox-retry').count(),0);
  assert.deepEqual(errors,[]);
  await page.unroute('**/mcp');
  await page.evaluate('startActorStream()');
  pass('post-send refresh failure preserves the committed message without a retry or page error');
  // Full plain text is a successful expansion; it must not be fetched on every refresh.
  const plain = '自动展开纯文本'.repeat(140);
  const sent = await send(aId,plain,agentToken);
  await page.evaluate('refresh(true)');
  await page.waitForFunction(`Array.from(document.querySelectorAll('#messages .bubble')).some(n=>n.textContent === ${JSON.stringify(plain)})`);
  const reads = await page.evaluate(`window.__mcpCalls.filter(x=>x.name==='network_message_read').length`);
  await page.evaluate('refresh(true)');
  assert.equal(await page.evaluate(`window.__mcpCalls.filter(x=>x.name==='network_message_read').length`),reads);
  pass('plain Agent full-text expansion is cached without repeat reads');
  // Announcement revision is captured at open, not at submit after a remote update.
  await page.click('#room-announcement-edit');
  await page.fill('#announcement-input','本地旧版本草稿');
  const before = await tool('network_room_get',{room_id:aId});
  await tool('network_room_announcement_set',{request_id:id(),room_id:aId,announcement:'另一设备已更新',expected_announcement_revision:before.room.announcement_revision});
  await page.evaluate('refresh(false)');
  await page.click('#announcement-save');
  await page.waitForFunction(`document.getElementById('announcement-error').textContent.includes('已被其他人更新')`);
  assert.equal((await tool('network_room_get',{room_id:aId})).room.announcement,'另一设备已更新');
  await route(bId);
  assert.equal(await page.locator('#announcement-modal').isHidden(),true);
  pass('announcement rejects stale revision and closes on room switch');
  // Permission-protected rename, optimistic conflict, replay, and no unread head change.
  const rename = {request_id:id(),room_id:bId,title:'重命名后的群',expected_title:b.room.title};
  const beforeRename = await tool('network_room_get',{room_id:bId});
  const renamed = await tool('network_room_rename',rename);
  assert.equal(renamed.room.head_seq,beforeRename.room.head_seq);
  await tool('network_room_rename',rename);
  await assert.rejects(tool('network_room_rename',{...rename,request_id:id(),title:'过期覆盖'}), /VERSION_CONFLICT/);
  await assert.rejects(tool('network_room_rename',{request_id:id(),room_id:bId,title:'越权改名',expected_title:renamed.room.title},agentToken),/PERMISSION_DENIED/);
  await page.evaluate('refresh(false)');
  await page.click('#add-members');
  await page.fill('#group-name-input','通过设置改名');
  let lostRename=false;
  await page.route('**/mcp', async request => {
    if (!lostRename && request.request().postDataJSON()?.params?.name === 'network_room_rename') {
      lostRename=true;
      await request.fetch();
      await request.abort('failed');
    } else await request.continue();
  });
  await page.click('#group-name-save');
  await page.waitForFunction(`document.getElementById('group-profile-status').textContent.includes('保存失败')`);
  await page.click('#group-name-save');
  await page.waitForFunction(`document.getElementById('group-profile-status').textContent === '群名称已更新'`);
  await page.unroute('**/mcp');
  const renameIds=await page.evaluate(`window.__mcpCalls.filter(x=>x.name==='network_room_rename').map(x=>x.body.params.arguments.request_id)`);
  assert.equal((renameIds as string[]).length,2);
  assert.equal(new Set(renameIds as string[]).size,1);
  pass('group name retry after committed response loss reuses its request ID');
  await page.waitForFunction(`document.getElementById('title').textContent === '通过设置改名'`);
  assert.equal((await tool('network_room_get',{room_id:bId})).room.title,'通过设置改名');
  // Two writes from the same snapshot: only one may commit.
  const snapshot = await tool('network_room_get',{room_id:bId});
  const racers = await Promise.allSettled(['并发一','并发二'].map(title=>tool('network_room_rename',{
    request_id:id(),room_id:bId,title,expected_title:snapshot.room.title
  })));
  assert.equal(racers.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(racers.filter(x=>x.status==='rejected').length,1);
  await page.evaluate('refresh(false)');
  pass('group rename UI, replay, concurrent edit rejection and authorization');
  await page.click('#members-close');
  // A completed old form must not overwrite a newer edit when its response arrives late.
  await page.click('#add-members');
  await page.fill('#group-name-input','旧表单已提交');
  let releaseRename!: () => void;
  let renameCommitted!: () => void;
  const renameGate = new Promise<void>(resolve => { releaseRename = resolve; });
  const renameFetched = new Promise<void>(resolve => { renameCommitted = resolve; });
  let heldRename = false;
  await page.route('**/mcp', async request => {
    if (!heldRename && request.request().postDataJSON()?.params?.name === 'network_room_rename') {
      heldRename = true;
      const response = await request.fetch();
      renameCommitted();
      await renameGate;
      await request.fulfill({response});
    } else await request.continue();
  });
  await page.evaluate('window.__oldRename = saveGroupName(); void 0');
  await renameFetched;
  await page.click('#members-close');
  await page.evaluate('refresh(false)');
  await page.click('#add-members');
  await page.fill('#group-name-input','新表单最终群名');
  await page.click('#group-name-save');
  await page.waitForFunction(`document.getElementById('group-profile-status').textContent === '群名称已更新'`);
  releaseRename();
  await page.evaluate('window.__oldRename');
  assert.equal(await page.locator('#title').textContent(),'新表单最终群名');
  assert.equal(await page.locator('#group-name-input').inputValue(),'新表单最终群名');
  assert.equal((await tool('network_room_get',{room_id:bId})).room.title,'新表单最终群名');
  await page.unroute('**/mcp');
  await page.click('#members-close');
  pass('late rename response cannot roll back a reopened form or newer room title');
  // Adding an existing friend follows the server's active-membership result.
  const friendToken=id();
  const friend=await tool('network_register',{request_id:id(),kind:'human',name:'待邀请好友'},friendToken);
  const req=await tool('network_contact_request',{request_id:id(),actor_id:friend.actor_id});
  await tool('network_contact_request_respond',{request_id:id(),contact_request_id:req.request.contact_request_id,action:'accept'},friendToken);
  await page.click('#add-members');
  await page.locator('#members-contacts input[value="'+friend.actor_id+'"]').check();
  await page.click('#members-add');
  await page.waitForFunction(`document.getElementById('members-current').textContent.includes('待邀请好友')`);
  assert.match(await page.locator('#members-error').textContent() || '',/已添加/);
  assert.equal(await page.locator('#members-contacts input[value="'+friend.actor_id+'"]').count(),0);
  pass('adding friend reports committed membership and removes stale candidate');
  await page.fill('#members-current-search','待邀请好友');
  assert.equal(await page.locator('#members-current .member-roster-item:visible').count(),1);
  await page.fill('#members-current-search','');
  // A normal message refresh must not close an open member action menu.
  await page.locator('#members-current .member-menu-toggle').first().click();
  await send(bId,'成员操作期间的新消息',agentToken);
  await page.evaluate('refresh(false)');
  assert.equal(await page.locator('#members-current .member-menu-toggle[aria-expanded="true"]').count(),1);
  pass('member search and open action menu survive ordinary chat refresh');
  await page.click('#members-close');
  await send(bId,'提及校验 @待邀请好友');
  await page.evaluate('refresh(true)');
  const mentionMessage=page.locator('#messages .msg').filter({hasText:'提及校验'});
  assert.equal(await mentionMessage.locator('.mention').count(),1);
  await tool('network_me_rename',{request_id:id(),name:'已改名好友'},friendToken);
  await page.evaluate('refresh(true)');
  assert.equal(await mentionMessage.locator('.mention').count(),0);
  pass('incremental timeline invalidates mention rendering when member names change');
  // Late create cannot navigate over a new user interaction; rapid submit is single-flight.
  await page.click('#new-group');
  await page.locator('#group-contacts input[value="'+actor.actor_id+'"]').check();
  await page.fill('#group-title','后台完成群');
  await delay('network_room_create');
  const countBefore=Number(await page.evaluate(`window.__mcpCalls.filter(x=>x.name==='network_room_create').length`));
  await page.evaluate(`document.getElementById('group-form').requestSubmit(); document.getElementById('group-form').requestSubmit()`);
  await page.waitForFunction('window.__delayedMcpHit');
  await page.click('#group-cancel');
  await page.click('#new-group');
  await page.fill('#group-title','新表单草稿');
  await new Promise(r=>setTimeout(r,850));
  assert.equal(await page.evaluate(`window.__mcpCalls.filter(x=>x.name==='network_room_create').length`),countBefore+1);
  assert.equal(await page.locator('#group-modal').isVisible(),true);
  assert.equal(await page.locator('#group-title').inputValue(),'新表单草稿');
  assert.equal(await page.evaluate('activeRoomId'),bId);
  await clearDelay();
  await page.click('#group-cancel');
  pass('group submit is single-flight; late create preserves reopened form and current route');
  // Lost create response: retry must reuse the original request ID and return one room.
  await page.click('#new-group');
  await page.locator('#group-contacts input[value="'+actor.actor_id+'"]').check();
  await page.fill('#group-title','丢失响应重试群');
  let dropped=false;
  await page.route('**/mcp', async route => {
    const body=route.request().postDataJSON();
    if (!dropped && body?.params?.name === 'network_room_create') {
      dropped=true;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.click('#group-create');
  await page.waitForFunction(`document.getElementById('group-error').textContent.includes('创建失败')`);
  await page.click('#group-create');
  await page.waitForFunction(`document.getElementById('title').textContent === '丢失响应重试群'`);
  await page.unroute('**/mcp');
  const retries=await page.evaluate(`window.__mcpCalls.filter(x=>x.name==='network_room_create' && x.body.params.arguments.title==='丢失响应重试群').map(x=>x.body.params.arguments.request_id)`);
  assert.equal(new Set(retries as string[]).size,1);
  assert.equal((await tool('network_rooms_list',{limit:100})).items.filter((x:any)=>x.title==='丢失响应重试群').length,1);
  pass('create retry after committed response loss creates exactly one group');
  await route(bId);
  // Leave a non-active group from the sidebar without reloading or navigating away.
  const foreign=await tool('network_room_create',{request_id:id(),kind:'group',title:'好友发起群',members:[(await tool('network_me')).actor_id]},friendToken);
  // 人拉人直接入群：owner 已被好友直接加入，不需要接受邀请。
  await page.evaluate('loadRooms()');
  // loadRooms can share a pre-join read; let the queued membership refresh materialize the row.
  await page.locator('#room-list a[data-room-id="'+foreign.room.room_id+'"]').waitFor();
  // Freeze an authoritative list response from before leaving, then deliver it late.
  await page.waitForFunction('!roomsPromise');
  let releaseOldList!: () => void;
  let oldListReady!: () => void;
  const oldListGate = new Promise<void>(resolve => { releaseOldList = resolve; });
  const oldListFetched = new Promise<void>(resolve => { oldListReady = resolve; });
  let heldList = false;
  await page.route('**/mcp', async request => {
    if (!heldList && request.request().postDataJSON()?.params?.name === 'network_rooms_list') {
      heldList = true;
      const response = await request.fetch();
      oldListReady();
      await oldListGate;
      await request.fulfill({response});
    } else await request.continue();
  });
  await page.evaluate('window.__oldList = loadRooms(); void 0');
  await oldListFetched;
  await page.locator('#room-list a[data-room-id="'+foreign.room.room_id+'"]').click({button:'right'});
  const marker=await page.evaluate('window.__spaMarker');
  await page.click('#room-menu-leave-group');
  await page.locator('#confirm-dialog[open] [data-confirm-ok]').click();
  await page.waitForFunction(`!roomEntries.some(entry => entry.room_id === ${JSON.stringify(foreign.room.room_id)})`);
  assert.equal(await page.evaluate('activeRoomId'),bId);
  assert.equal(await page.evaluate('window.__spaMarker'),marker);
  assert.equal((await tool('network_rooms_list',{limit:100})).items.some((x:any)=>x.room_id===foreign.room.room_id),false);
  pass('leave background group preserves active route and page instance');
  releaseOldList();
  await page.evaluate('window.__oldList');
  assert.equal(await page.locator('#room-list a[data-room-id="'+foreign.room.room_id+'"]').count(),0);
  await page.unroute('**/mcp');
  pass('late pre-leave list response cannot resurrect a departed group');
  // A successful rejoin is still discoverable; remote leave/removal cleans every device.
  const selfId = (await tool('network_me')).actor_id;
  await tool('network_room_members_update',{request_id:id(),room_id:foreign.room.room_id,add:[selfId]},friendToken);
  await page.evaluate('loadRooms()');
  await page.locator('#room-list a[data-room-id="'+foreign.room.room_id+'"]').waitFor();
  await tool('network_room_leave',{request_id:id(),room_id:foreign.room.room_id});
  await page.waitForFunction(`!roomEntries.some(entry => entry.room_id === ${JSON.stringify(foreign.room.room_id)})`);
  assert.equal(await page.evaluate('activeRoomId'),bId);
  pass('rejoined groups return; remote leave removes only the affected sidebar entry');
  await tool('network_room_members_update',{request_id:id(),room_id:foreign.room.room_id,add:[selfId]},friendToken);
  await route(foreign.room.room_id);
  await tool('network_room_members_update',{request_id:id(),room_id:foreign.room.room_id,remove:[selfId]},friendToken);
  await page.waitForFunction('!activeRoomId');
  assert.equal(await page.locator('#room-list a[data-room-id="'+foreign.room.room_id+'"]').count(),0);
  assert.equal(await page.locator('#messages .msg').count(),0);
  pass('remote removal from the active group clears timeline, route and sidebar');
  await route(bId);
  // Dissolve current room through visible settings and retain read-only history.
  await page.click('#add-members');
  await page.click('#group-dissolve');
  await page.locator('#confirm-dialog[open] [data-confirm-ok]').click();
  await page.waitForFunction(`document.getElementById('room-archive-banner').hidden === false`);
  assert.equal(await page.locator('#composer').isHidden(),true);
  await route(aId);
  assert.equal(await page.locator('#composer').isVisible(),true);
  assert.equal(await page.locator('#room-archive-banner').isHidden(),true);
  await assert.rejects(tool('network_room_rename',{request_id:id(),room_id:bId,title:'归档改名',expected_title:(await tool('network_room_get',{room_id:bId})).room.title}),/ROOM_DISSOLVED|PERMISSION_DENIED/);
  pass('dissolve uses settings, keeps archive, and switching restores writable composer');
  // Uploading attachment is never silently omitted by an early Enter or message refresh.
  let releaseUpload!: () => void;
  const uploadGate=new Promise<void>(resolve=>{releaseUpload=resolve;});
  await page.route('**/mcp-upload', async request=>{await uploadGate; await request.continue();});
  await page.fill('#body','附件必须一起发送');
  await page.setInputFiles('#composer-file-input',{
    name:'热点附件.txt',mimeType:'text/plain',buffer:Buffer.from('attachment readiness')
  });
  await page.locator('#composer-files .composer-file').waitFor();
  assert.equal(await page.locator('#send').isDisabled(),true);
  const sendsBefore=await page.evaluate(`window.__mcpCalls.filter(x=>x.name==='network_message_send').length`);
  await page.locator('#body').press('Enter');
  await page.evaluate('refresh(true)');
  assert.equal(await page.locator('#send').isDisabled(),true);
  assert.equal(await page.evaluate(`window.__mcpCalls.filter(x=>x.name==='network_message_send').length`),sendsBefore);
  releaseUpload();
  await page.click('#send');
  await page.waitForFunction(`document.querySelectorAll('#composer-files .composer-file').length === 0`);
  assert.match(String(await page.evaluate(`window.__mcpCalls.filter(x=>x.name==='network_message_send').at(-1).body.params.arguments.body`)),/附件必须一起发送[\s\S]*\/f\//);
  await page.unroute('**/mcp-upload');
  pass('pending uploads block early send across refresh and include attachments when ready');
  // File-only retries exercise composer matching and the retry toolbar's file-key snapshot.
  await page.fill('#body','');
  await page.setInputFiles('#composer-file-input',{
    name:'仅附件重试.txt',mimeType:'text/plain',buffer:Buffer.from('file-only retry')
  });
  let failFileSend=true;
  await page.route('**/mcp', async request=>{
    const body=request.request().postDataJSON();
    if (failFileSend && body?.params?.name === 'network_message_send') {
      failFileSend=false;
      await request.fulfill({status:503,body:'temporary failure'});
    } else await request.continue();
  });
  await page.click('#send');
  await page.locator('.outbox-retry').click();
  await page.waitForFunction(`document.querySelectorAll('#composer-files .composer-file').length === 0`);
  await page.unroute('**/mcp');
  pass('file-only send retry clears consumed attachment without a text draft');
  // Keyboard focus and responsive group form.
  await page.setViewportSize({width:390,height:844});
  await page.click('#add-members');
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  assert.equal(await page.evaluate(`(() => {
    const card=document.querySelector('.members-card').getBoundingClientRect();
    return ['members-add','members-cancel','group-dissolve'].every(id=>{
      const rect=document.getElementById(id).getBoundingClientRect();
      return rect.top>=card.top && rect.bottom<=card.bottom && rect.bottom<=innerHeight;
    });
  })()`),true);
  pass('group settings fit 390px viewport and keep action buttons visible');
  if (process.env.HOTPATH_SCREENSHOT) await page.screenshot({path:process.env.HOTPATH_SCREENSHOT});
  assert.deepEqual(errors,[]);
  await created.context.close();
  console.log(JSON.stringify({passed:checks.length,checks,page_errors:errors},null,2));
} catch (error) {
  console.error('Browser errors:', errors);
  if (page!) console.error(await page.evaluate(`({title:document.getElementById('title')?.textContent,status:document.getElementById('status')?.textContent,group:document.getElementById('group-error')?.textContent,members:document.getElementById('members-error')?.textContent})`).catch(()=>null));
  throw error;
} finally { await browser.close(); await server.stop(); }
