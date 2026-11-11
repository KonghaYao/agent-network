import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture } from './fixture';
import { rawTool } from '../verify-web';

const outputDir=process.env.UX_OUTPUT || resolve(dirname(fileURLToPath(import.meta.url)),'group-fixes-results');
await mkdir(outputDir,{recursive:true});
const session=await createFixture(['groups']);
const data=session.scenarios.groups;
const base=session.base;
const browser=await chromium.launch({
  headless:true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),
  args:['--no-sandbox']
});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript((token:string)=>localStorage.setItem('agent-network-token',token),data.me.token);
const page=await context.newPage();
page.setDefaultTimeout(8000);
let stage='initializing';
const pageErrors:string[]=[];
page.on('pageerror',(e:any)=>pageErrors.push(String(e.message).slice(0,300)));
const adminContext=await browser.newContext({viewport:{width:1440,height:1000}});
await adminContext.addInitScript((token:string)=>localStorage.setItem('agent-network-token',token),data.wang.token);
const adminPage=await adminContext.newPage();
adminPage.setDefaultTimeout(8000);

type Status='PASS'|'BUG'|'UX_GAP'|'FEATURE_GAP'|'BLOCKED';
type Finding={id:string,goal:string,steps:string[],expected:string,observed:string,status:Status,severity?:'P0'|'P1'|'P2',evidence:string[]};
const findings:Finding[]=[];
function record(id:string,goal:string,steps:string[],expected:string,observed:string,status:Status,evidence:string[],severity?:'P0'|'P1'|'P2'){
  findings.push({id,goal,steps,expected,observed,status,...(severity?{severity}:{}),evidence});
}
const id=()=>crypto.randomUUID();
const tool=(token:string,name:string,args:Record<string,unknown>={})=>rawTool<any>(token,name,{request_id:id(),...args});
async function waitContains(target:any,selector:string,value:string){
  await target.waitForFunction(({selector,value}:any)=>Boolean(document.querySelector(selector)?.textContent?.includes(value)),{selector,value},{timeout:8000});
}
async function openRoom(target:any,roomId:string,kind:'direct'|'group'){
  const filter=target.locator(kind==='group'?'#room-filter-group':'#room-filter-friend');
  await filter.click();
  const link=target.locator('#room-list a[href="/c/'+roomId+'"]');
  await link.waitFor({state:'visible'});
  await link.click();
  await target.waitForFunction((id:string)=>location.pathname==='/c/'+encodeURIComponent(id),roomId);
  await target.locator('#chat-body').waitFor({state:'visible'});
  await target.waitForFunction(()=>document.querySelector('#chat-body')?.getAttribute('aria-busy')==='false',null,{timeout:10000});
}
async function openMembers(target:any){
  await target.locator('#add-members').click();
  await target.locator('#members-modal').waitFor({state:'visible'});
}
async function createNonFriendGroup(){
  const outsiderToken=id();
  const outsider={token:outsiderToken,...await tool(outsiderToken,'network_register',{kind:'human',name:'群外同事赵同学'})};
  const request=await tool(data.wang.token,'network_contact_request',{actor_id:outsider.actor_id});
  if(request.request){
    await tool(outsider.token,'network_contact_request_respond',{contact_request_id:request.request.contact_request_id,action:'accept'});
  }
  const created=await tool(data.wang.token,'network_room_create',{kind:'group',title:'成员私聊权限核验群',members:[data.me.actor_id,outsider.actor_id]});
  for(const invitation of created.invited||[]){
    const recipient=invitation.actor_id===data.me.actor_id?data.me:outsider;
    await tool(recipient.token,'network_room_invite_respond',{invitation_id:invitation.invitation_id,action:'accept'});
  }
  return {room:created.room,outsider};
}
async function setAdminFromUi(){
  await openRoom(page,data.rooms.owned.room_id,'group');
  await openMembers(page);
  const wang=page.locator('#members-current li.member-roster-item').filter({hasText:'小王'}).first();
  await wang.locator('button[aria-label="成员操作"]').click();
  await page.getByRole('menuitem',{name:'设为管理员',exact:true}).click();
  await waitContains(page,'#members-current','管理员');
  await page.locator('#members-close').click();
}
async function prepareAdminPage(){
  stage='loading member browser context';
  await adminPage.goto(base,{waitUntil:'domcontentloaded'});
  await adminPage.locator('#room-list a').first().waitFor({state:'visible'});
  await openRoom(adminPage,data.rooms.owned.room_id,'group');
  await openMembers(adminPage);
}
async function delayTool(target:any,toolName:string,argsMatch:(args:any)=>boolean){
  let seenResolve:()=>void=()=>{};
  let releaseResolve:()=>void=()=>{};
  let finishedResolve:()=>void=()=>{};
  const seen=new Promise<void>(resolve=>{seenResolve=resolve;});
  const finished=new Promise<void>(resolve=>{finishedResolve=resolve;});
  const release=new Promise<void>(resolve=>{releaseResolve=resolve;});
  const matches=(request:any)=>{
    let match=false;
    try{
      const body=request.postDataJSON();
      match=request.headers()['mcp-name']===toolName&&argsMatch(body?.params?.arguments||{});
    }catch{}
    return match;
  };
  const onFinished=(request:any)=>{if(matches(request))finishedResolve();};
  target.on('requestfinished',onFinished);
  const handler=async(route:any)=>{
    const request=route.request();
    const match=matches(request);
    if(match){seenResolve();await release;}
    await route.continue();
  };
  await target.route('**/mcp',handler);
  return {seen,finished,release:releaseResolve,remove:async()=>{await target.unroute('**/mcp',handler);target.off('requestfinished',onFinished);}};
}

let summary:any={baseline:'e7a9af5',base:'本地自托管临时实例（不含地址或 token）',findings};
try{
  stage='opening main UI';
  await page.goto(base,{waitUntil:'domcontentloaded'});
  stage='waiting for main room list';
  await page.locator('#room-list a').first().waitFor({state:'visible'});

  // U05a: the friend request dialog no longer duplicates the friend directory.
  await page.locator('#contact-requests').click();
  await page.locator('#contact-modal').waitFor({state:'visible'});
  const friendPanels=await page.locator('#contact-modal .contact-friends-panel, #contact-modal #contact-friend-list').count();
  const contactModalText=await page.locator('#contact-modal').textContent();
  await page.locator('#contact-tab-requests').click();
  const contactRequestsVisible=await page.locator('#contact-request-list').isVisible();
  await page.locator('#contact-tab-more').click();
  const contactLinkVisible=await page.locator('#contact-link-create').isVisible();
  const contactPolicyVisible=await page.locator('#contact-policy-select').isVisible();
  const noFriendBlock=friendPanels===0&&!(contactModalText??'').includes('我的好友');
  record('U05a','好友申请弹窗不再展示我的好友',['打开“好友申请”弹窗'],
    '弹窗只保留待处理申请、好友链接与接收策略，不出现“我的好友”区块',noFriendBlock&&contactRequestsVisible&&contactLinkVisible&&contactPolicyVisible?'弹窗无“我的好友”区块；待处理申请、好友链接与接收策略入口仍在。':'弹窗仍渲染“我的好友”或缺少其他入口。',noFriendBlock&&contactRequestsVisible&&contactLinkVisible&&contactPolicyVisible?'PASS':'BUG',
    ['我的好友区块数量='+friendPanels,'弹窗文本含“我的好友”='+(contactModalText??'').includes('我的好友'),'申请/链接/策略入口='+[contactRequestsVisible,contactLinkVisible,contactPolicyVisible].join('/')]);
  await page.locator('#contact-modal-close').click();
  await page.locator('#contact-modal').waitFor({state:'hidden'});

  // A delayed direct-room response must not pull the user back after the member
  // dialog closes and another conversation is opened.
  await openRoom(page,data.rooms.owned.room_id,'group');
  await openMembers(page);
  const delayedDirect=await delayTool(page,'network_room_create',(args:any)=>args.kind==='direct'&&(args.members||[]).includes(data.wang.actor_id));
  const delayWangRow=page.locator('#members-current li.member-roster-item').filter({hasText:'小王'}).first();
  await delayWangRow.locator('button[aria-label="成员操作"]').click();
  await page.getByRole('menuitem',{name:'发起单聊',exact:true}).click();
  await delayedDirect.seen;
  await page.locator('#members-close').click();
  await openRoom(page,data.rooms.directLi.room_id,'direct');
  delayedDirect.release();
  await delayedDirect.finished;
  await delayedDirect.remove();
  await page.waitForTimeout(100);
  const directSwitchStayed=page.url().endsWith(data.rooms.directLi.room_id);
  const membersModalClosed=await page.locator('#members-modal').isHidden();
  record('U05d','单聊创建响应晚到时的切房',['从群成员入口发起小王单聊并暂缓响应','关闭群设置','切换到小李单聊后放行响应'],
    '完成创建后不强制切回小王单聊；关闭群设置与当前房间保持不变',directSwitchStayed&&membersModalClosed?'响应晚到后仍留在小李单聊，群设置保持关闭。':'响应晚到后强制切房或重开群设置。',directSwitchStayed&&membersModalClosed?'PASS':'BUG',
    ['当前路由仍为小李 direct='+directSwitchStayed,'群设置关闭='+membersModalClosed]);

  // U05b: the existing group-member entry must reuse the already seeded direct room.
  await page.locator('#contact-modal').waitFor({state:'hidden'});
  await openRoom(page,data.rooms.owned.room_id,'group');
  await openMembers(page);
  const wangRow=page.locator('#members-current li.member-roster-item').filter({hasText:'小王'}).first();
  await wangRow.locator('button[aria-label="成员操作"]').click();
  await page.getByRole('menuitem',{name:'发起单聊',exact:true}).click();
  await page.waitForFunction((id:string)=>location.pathname==='/c/'+encodeURIComponent(id),data.rooms.directWang.room_id);
  const wangDirectCount=await page.locator('#room-list a[href="/c/'+data.rooms.directWang.room_id+'"]:visible').count();
  record('U05b','从群成员入口发起私聊',['打开 fixtures.owned 群的群设置','在小王成员行选择“发起单聊”'],
    '从群成员入口复用已存在的小王 direct',page.url().endsWith(data.rooms.directWang.room_id)&&wangDirectCount===1?'进入 fixture 中已有的小王 direct，列表未出现重复房间。':'群成员入口没有复用现有 direct。',page.url().endsWith(data.rooms.directWang.room_id)&&wangDirectCount===1?'PASS':'BUG',
    ['路由等于既有 direct room_id='+page.url().endsWith(data.rooms.directWang.room_id),'既有 direct 列表行数='+wangDirectCount]);

  // Setup an actual group member who is not a friend, then test server permission feedback from the UI.
  const nonFriend=await createNonFriendGroup();
  await openRoom(page,nonFriend.room.room_id,'group');
  await openMembers(page);
  const outsiderRow=page.locator('#members-current li.member-roster-item').filter({hasText:'群外同事赵同学'}).first();
  await outsiderRow.locator('button[aria-label="成员操作"]').click();
  await page.getByRole('menuitem',{name:'发起单聊',exact:true}).click();
  await waitContains(page,'#members-error','还不是好友');
  const nonFriendMessage=await page.locator('#members-error').innerText();
  const stayedInGroup=page.url().endsWith(nonFriend.room.room_id);
  record('U05c','非好友群成员的单聊权限反馈',['在含非好友成员的群设置中选择该成员','点击“发起单聊”'],
    '服务端拒绝创建 direct，并向用户说明先建立好友关系',stayedInGroup&&nonFriendMessage.includes('先建立好友关系')?'仍留在原群设置；界面提示“还不是好友…请先建立好友关系”。':'非好友权限错误没有清晰反馈或误开了单聊。',stayedInGroup&&nonFriendMessage.includes('先建立好友关系')?'PASS':'BUG',
    ['原群路由未改变='+stayedInGroup,'权限提示='+nonFriendMessage]);
  await page.locator('#members-close').click();

  // Open Wang's ordinary-member view before promoting him; the edit controls must be absent/disabled.
  await openRoom(page,data.rooms.owned.room_id,'group');
  await page.locator('#room-announcement-edit').click();
  await page.locator('#announcement-input').fill('权限检查用公告');
  await page.locator('#announcement-save').click();
  await page.locator('#announcement-modal').waitFor({state:'hidden'});
  await prepareAdminPage();
  const memberNameDisabled=await adminPage.locator('#group-name-input').isDisabled();
  const memberSaveHidden=await adminPage.locator('#group-name-save').isHidden();
  await adminPage.locator('#members-close').click();
  await adminPage.locator('#room-announcement-edit').click();
  const memberAnnouncementSaveHidden=await adminPage.locator('#announcement-save').isHidden();
  const memberAnnouncementReadOnly=await adminPage.locator('#announcement-input').getAttribute('readonly')!==null;
  await adminPage.locator('#announcement-close').click();
  record('U08','普通成员与管理员权限边界',['以小王打开群设置','检查群名编辑权限','检查公告编辑入口'],
    '普通成员不能编辑群名或公告；升级为管理员后按当前群策略获得权限',memberNameDisabled&&memberSaveHidden&&memberAnnouncementSaveHidden&&memberAnnouncementReadOnly?'普通成员不能编辑群名；公告可查看但输入只读且保存按钮隐藏。':'普通成员权限界面未完整限制群名或公告编辑。',memberNameDisabled&&memberSaveHidden&&memberAnnouncementSaveHidden&&memberAnnouncementReadOnly?'PASS':'BUG',
    ['成员身份下 group-name-input.disabled='+memberNameDisabled,'group-name-save.hidden='+memberSaveHidden,'公告保存按钮隐藏='+memberAnnouncementSaveHidden,'公告输入只读='+memberAnnouncementReadOnly]);

  // Promote Wang through the owner UI. No direct API mutations are used for the conflict races.
  await setAdminFromUi();
  await openRoom(adminPage,data.rooms.directWang.room_id,'direct');
  await openRoom(adminPage,data.rooms.owned.room_id,'group');
  await openMembers(adminPage);
  const adminNameEditable=!(await adminPage.locator('#group-name-input').isDisabled());
  const adminCanSave=await adminPage.locator('#group-name-save').isVisible();
  await adminPage.locator('#members-close').click();
  const adminAnnouncementVisible=await adminPage.locator('#room-announcement-edit').isVisible();
  await adminPage.locator('#room-announcement-edit').click();
  const adminAnnouncementEditable=await adminPage.locator('#announcement-save').isVisible()&&!(await adminPage.locator('#announcement-input').getAttribute('readonly'));
  await adminPage.locator('#announcement-close').click();
  record('U08b','管理员按群设置获得编辑权限',['群主从成员操作菜单把小王设为管理员','小王返回该群设置','检查群名和公告入口'],
    '群内 owner_admin 策略允许管理员编辑群名与公告',adminNameEditable&&adminCanSave&&adminAnnouncementVisible&&adminAnnouncementEditable?'升级后群名输入可编辑、保存可见，公告输入可编辑且保存可见。':'管理员授权后的编辑入口未按群策略显示。',adminNameEditable&&adminCanSave&&adminAnnouncementVisible&&adminAnnouncementEditable?'PASS':'BUG',
    ['管理员 group-name-input.enabled='+adminNameEditable,'群名保存按钮可见='+adminCanSave,'公告入口可见='+adminAnnouncementVisible,'公告输入可编辑且保存可见='+adminAnnouncementEditable]);

  // U06: a competing admin saves first; owner draft stays in the modal and requires explicit retry.
  await openRoom(page,data.rooms.owned.room_id,'group');
  await openMembers(page);
  const ownerDraft='群主保留草稿并重试';
  await page.locator('#group-name-input').fill(ownerDraft);
  await openMembers(adminPage);
  await adminPage.locator('#group-name-input').fill('管理员先行版本');
  await adminPage.locator('#group-name-save').click();
  await waitContains(adminPage,'#group-profile-status','群名称已更新');
  const nameLatestRead=await delayTool(page,'network_room_get',(args:any)=>args.room_id===data.rooms.owned.room_id);
  await page.locator('#group-name-save').click();
  await nameLatestRead.seen;
  const lateNameDraft='群主在读取期间继续编辑的草稿';
  await page.locator('#group-name-input').fill(lateNameDraft);
  nameLatestRead.release();
  await nameLatestRead.finished;
  await nameLatestRead.remove();
  await waitContains(page,'#group-profile-status','草稿已保留');
  const nameDraftPreserved=(await page.locator('#group-name-input').inputValue())===lateNameDraft;
  const nameRetryLabel=await page.locator('#group-name-save').innerText();
  const nameRetryExplicit=nameRetryLabel==='确认覆盖并重试';
  const latestNameVisible=(await page.locator('#group-profile-status').innerText()).includes('管理员先行版本');
  let nameRetrySaved=false;
  if(nameDraftPreserved&&nameRetryExplicit){
    await page.locator('#group-name-save').click();
    await waitContains(page,'#group-profile-status','群名称已更新');
    nameRetrySaved=(await page.locator('#title').innerText())===lateNameDraft;
  }
  record('U06','群名 CAS 冲突保留草稿并明确重试',['群主输入新名称但暂不保存','管理员先保存另一个名称','群主提交旧版本草稿，读取最新版本期间再修改草稿','核对草稿与按钮提示后确认覆盖重试'],
    '检测 VERSION_CONFLICT；拉取最新期望版本，保留冲突期间继续输入的草稿，并等待用户明确确认后再覆盖',nameDraftPreserved&&nameRetryExplicit&&latestNameVisible&&nameRetrySaved?'冲突处理期间继续输入的草稿仍在输入框；最新群名完整展示；按钮明确变为“确认覆盖并重试”；确认后保存成功。':'群名冲突、并发输入保留、最新版本显示、明确重试或重试保存未完整通过。',nameDraftPreserved&&nameRetryExplicit&&latestNameVisible&&nameRetrySaved?'PASS':'BUG',
    ['管理员先行保存成功=true','冲突响应等待期间继续输入且草稿保留='+nameDraftPreserved,'最新群名完整展示='+latestNameVisible,'显式重试按钮='+nameRetryLabel,'确认重试保存成功='+nameRetrySaved]);

  // U07: conflict on announcement revision with the same admin UI, keep the owner draft and retry explicitly.
  await page.locator('#members-close').click();
  await adminPage.locator('#members-close').click();
  await page.locator('#room-announcement-edit').click();
  const announcementDraft='群主公告草稿：周日 11:00 集合。';
  await page.locator('#announcement-input').fill(announcementDraft);
  await adminPage.locator('#room-announcement-edit').click();
  const adminAnnouncement='管理员先行公告：周日 10:30 集合。';
  await adminPage.locator('#announcement-input').fill(adminAnnouncement);
  await adminPage.locator('#announcement-save').click();
  await adminPage.locator('#announcement-modal').waitFor({state:'hidden'});
  await page.locator('#announcement-save').click();
  await waitContains(page,'#announcement-error','草稿已保留');
  const announcementDraftPreserved=(await page.locator('#announcement-input').inputValue())===announcementDraft;
  const announcementRetryLabel=await page.locator('#announcement-save').innerText();
  const announcementRetryExplicit=announcementRetryLabel==='确认覆盖并重试';
  const latestAnnouncementVisible=(await page.locator('#announcement-error').innerText()).includes(adminAnnouncement);
  let announcementRetrySaved=false;
  if(announcementDraftPreserved&&announcementRetryExplicit){
    await page.locator('#announcement-save').click();
    await page.locator('#announcement-modal').waitFor({state:'hidden'});
    await waitContains(page,'#room-announcement',announcementDraft);
    announcementRetrySaved=(await page.locator('#room-announcement').innerText())===announcementDraft;
  }
  record('U07','公告 CAS 冲突保留草稿并明确重试',['群主输入公告草稿但暂不保存','管理员先保存另一版公告','群主提交旧 revision 草稿','核对草稿、完整最新版本说明和确认重试按钮','确认覆盖并重试'],
    '检测 VERSION_CONFLICT；显示完整最新公告，保留草稿并由用户明确覆盖重试',announcementDraftPreserved&&announcementRetryExplicit&&latestAnnouncementVisible&&announcementRetrySaved?'公告冲突后草稿保留；完整展示最新公告与确认按钮；确认后草稿版本成功发布。':'公告冲突、草稿保留、最新公告查看、显式重试或保存未完整通过。',announcementDraftPreserved&&announcementRetryExplicit&&latestAnnouncementVisible&&announcementRetrySaved?'PASS':'BUG',
    ['管理员先行公告保存成功=true','冲突后草稿保留='+announcementDraftPreserved,'最新公告完整展示='+latestAnnouncementVisible,'显式重试按钮='+announcementRetryLabel,'确认重试保存成功='+announcementRetrySaved]);

  // Async room-switch boundary: the response may finish after the user leaves the edit UI.
  await page.locator('#announcement-edit-close').click().catch(()=>{});
  await page.locator('#add-members').click();
  await page.locator('#members-modal').waitFor({state:'visible'});
  const delayed=await delayTool(page,'network_room_rename',(args:any)=>args.title==='异步切换守卫名');
  await page.locator('#group-name-input').fill('异步切换守卫名');
  await page.locator('#group-name-save').click();
  await delayed.seen;
  await page.keyboard.press('Escape');
  await page.locator('#members-modal').waitFor({state:'hidden'});
  const statusAfterClose=await page.locator('#group-profile-status').innerText();
  await page.locator('#room-filter-friend').click();
  await page.locator('#room-list a[href="/c/'+data.rooms.directLi.room_id+'"]').click();
  await page.waitForFunction((id:string)=>location.pathname==='/c/'+encodeURIComponent(id),data.rooms.directLi.room_id);
  delayed.release();
  await delayed.finished;
  await page.waitForTimeout(180);
  await delayed.remove();
  await waitContains(page,'#title','小李');
  const asyncRoomStayed=page.url().endsWith(data.rooms.directLi.room_id);
  const asyncStatusStayed=(await page.locator('#group-profile-status').innerText())===statusAfterClose;
  record('U09','群名保存响应晚到时的房间切换',['提交群名并在请求抵达服务端前暂缓响应','按 Escape 关闭群设置','切换到小李单聊','放行群名响应'],
    '迟到的群名响应不能更新新会话界面或复开旧弹窗',asyncRoomStayed&&asyncStatusStayed?'响应完成后仍停留在小李单聊，群名编辑状态未写入新会话。':'迟到群名响应污染了当前会话状态。',asyncRoomStayed&&asyncStatusStayed?'PASS':'BUG',
    ['当前路由仍为小李 direct='+asyncRoomStayed,'关闭后群名状态保持='+asyncStatusStayed]);

  await openRoom(page,data.rooms.owned.room_id,'group');
  await page.locator('#room-announcement-edit').click();
  const asyncAnnouncement='异步公告响应不应影响新会话';
  const delayedAnnouncement=await delayTool(page,'network_room_announcement_set',(args:any)=>args.announcement===asyncAnnouncement);
  await page.locator('#announcement-input').fill(asyncAnnouncement);
  const announcementErrorBefore=await page.locator('#announcement-error').innerText();
  await page.locator('#announcement-save').click();
  await delayedAnnouncement.seen;
  await page.keyboard.press('Escape');
  await page.locator('#announcement-modal').waitFor({state:'hidden'});
  await page.locator('#room-filter-friend').click();
  await page.locator('#room-list a[href="/c/'+data.rooms.directLi.room_id+'"]').click();
  await page.waitForFunction((id:string)=>location.pathname==='/c/'+encodeURIComponent(id),data.rooms.directLi.room_id);
  delayedAnnouncement.release();
  await delayedAnnouncement.finished;
  await page.waitForTimeout(180);
  await delayedAnnouncement.remove();
  await waitContains(page,'#title','小李');
  const asyncAnnouncementRoomStayed=page.url().endsWith(data.rooms.directLi.room_id);
  const asyncAnnouncementErrorStayed=(await page.locator('#announcement-error').innerText())===announcementErrorBefore;
  record('U10','公告保存响应晚到时的房间切换',['提交公告并暂缓服务端响应','按 Escape 关闭公告编辑','切换到小李单聊','放行公告响应'],
    '迟到的公告响应不能复开旧弹窗或污染新会话状态',asyncAnnouncementRoomStayed&&asyncAnnouncementErrorStayed?'响应完成后仍停留在小李单聊，公告编辑状态未污染新会话。':'迟到公告响应污染了当前会话状态。',asyncAnnouncementRoomStayed&&asyncAnnouncementErrorStayed?'PASS':'BUG',
    ['当前路由仍为小李 direct='+asyncAnnouncementRoomStayed,'公告错误状态保持='+asyncAnnouncementErrorStayed]);
}catch(error:any){
  record('RUN','专项 UI 流程执行',[],'所有专项流程可跑完','阶段='+stage+'；'+String(error?.message||error).slice(0,500),'BLOCKED',['页面异常='+pageErrors.join(' | '),'执行器错误已截断，不含 token。']);
}finally{
  const order=['U05a','U05d','U05b','U05c','U08','U08b','U06','U07','U09','U10','RUN'];
  findings.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));
  summary={baseline:'e7a9af5',base:'本地自托管临时实例（不含地址或 token）',findings};
  await writeFile(outputDir+'/group-fixes.json',JSON.stringify(summary,null,2));
  await browser.close();
  await session.stop();
}
console.log(JSON.stringify({findings:findings.map(({id,status,observed})=>({id,status,observed})),file:outputDir+'/group-fixes.json'}));
if(findings.some(finding=>finding.status!=='PASS')) process.exitCode=1;
