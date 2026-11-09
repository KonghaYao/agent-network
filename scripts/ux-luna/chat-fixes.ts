import { chromium, type Page } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixture } from './fixture';
import { rawTool } from '../verify-web';
const out=process.env.UX_OUTPUT || resolve(import.meta.dir,'reports');
await mkdir(out,{recursive:true});
let baseline:any[]=[];try{baseline=JSON.parse(await readFile(out+'/baseline.json','utf8'))}catch{}
const fixture=await createFixture(['chat']);const d=fixture.scenarios.chat;
const browserOptions:any={headless:true,args:['--no-sandbox']};
if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)browserOptions.executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser=await chromium.launch(browserOptions);
const context=await browser.newContext({viewport:{width:1280,height:900}});await context.addInitScript(token=>localStorage.setItem('agent-network-token',token),d.me.token);const page=await context.newPage();page.setDefaultTimeout(7000);
const id=()=>crypto.randomUUID();const results:any[]=[];const pageErrors:string[]=[];page.on('pageerror',(e)=>pageErrors.push(e.message));page.on('console',(m)=>{if(m.type()==='error')console.log('CONSOLE',m.text())});
async function open(page:Page,tab:'单聊'|'群聊',roomId:string){await page.getByRole('tab',{name:tab,exact:true}).click();await page.locator('#room-list a[href="/c/'+roomId+'"]').click();await page.locator('#chat-body').waitFor();await page.waitForFunction(()=>document.querySelector('#chat-body')?.getAttribute('aria-busy')==='false');}
async function position(){return page.locator('#messages').evaluate((el:any)=>{const rect=el.getBoundingClientRect();const row=[...el.querySelectorAll('[data-message-id]')].find((node:any)=>{const r=node.getBoundingClientRect();return r.bottom>rect.top&&r.top<rect.bottom});return {top:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,first:row?.getAttribute('data-message-id'),offset:row?row.getBoundingClientRect().top-rect.top:null,text:(row?.textContent||'').slice(0,100)};});}
async function menu(roomId:string){await page.locator('#room-list a[href="/c/'+roomId+'"]').click({button:'right'});await page.locator('#room-menu').waitFor({state:'visible'});}
try {
 await page.goto(fixture.base);await page.locator('#room-filter').waitFor();await page.locator('#room-list a').first().waitFor();
 // U01: one Enter chooses an option; a second, intentional Enter sends it.
 await open(page,'群聊',d.rooms.history.room_id);
 // Grow the history cache past ROOM_CACHE_RENDER_MAX using the visible older-history control.
 let loadedCount=await page.locator('#messages .msg[data-message-id]').count();let olderClicks=0;
 while(loadedCount<=80&&olderClicks<4&&await page.locator('#older').isVisible().catch(()=>false)){await page.locator('#older').click();await page.waitForTimeout(550);loadedCount=await page.locator('#messages .msg[data-message-id]').count();olderClicks+=1;}
 const composer=page.locator('#body');await composer.fill('@');await page.locator('#mention-picker').waitFor({state:'visible'});
 const options=await page.locator('#mention-picker .mention-item').allTextContents();
 const prior=await page.locator('#messages [data-message-id]').last().innerText();
 await composer.press('ArrowDown');const activeBeforeEnter=await page.locator('#mention-picker .mention-item[aria-selected="true"]').allTextContents();
 await composer.press('Enter');await page.waitForTimeout(200);
 const inserted=await composer.inputValue();const afterSelection=await page.locator('#messages [data-message-id]').last().innerText();
 const selectionSafe=inserted.startsWith('@')&&inserted.trim().length>1&&afterSelection===prior;
 await composer.press('Enter');await page.waitForTimeout(900);
 const afterSend=await page.locator('#messages [data-message-id]').last().innerText();
 results.push({id:'U01',status:selectionSafe&&afterSend.includes(inserted.trim())?'PASS':'FAIL',options,activeBeforeEnter,inserted,priorLastMessage:prior,lastAfterSelection:afterSelection,lastAfterSecondEnter:afterSend,selectionDidNotSend:selectionSafe});

 // U02: restore the visible history item/offset, then keep it stable for an inbound message and older-page load.
 await page.locator('#body').fill('');await page.locator('#messages').hover();await page.mouse.wheel(0,-900);await page.waitForTimeout(350);const before=await position();const domBefore=await page.locator('#messages .msg[data-message-id]').count();
 const reopenStarted=Date.now();await open(page,'单聊',d.rooms.directWang.room_id);await open(page,'群聊',d.rooms.history.room_id);await page.waitForTimeout(450);const reopenMs=Date.now()-reopenStarted;const after=await position();const domAfter=await page.locator('#messages .msg[data-message-id]').count();
 const restored=before.first===after.first&&Math.abs(Number(before.offset)-Number(after.offset))<3;
 let historyLoaded=false;let historyBefore:any=null;let afterAutoOlder:any=null;let historyLoadAttempts=0;
 let messageCount=await page.locator('#messages .msg[data-message-id]').count();
 while(!historyLoaded&&historyLoadAttempts<4){
   historyBefore=await position();const countBefore=messageCount;
   await page.locator('#messages').hover();await page.mouse.wheel(0,-6000);await page.waitForTimeout(850);
   messageCount=await page.locator('#messages .msg[data-message-id]').count();afterAutoOlder=await position();
   historyLoaded=messageCount>countBefore;historyLoadAttempts+=1;
 }
 const olderLoadedWithoutJump=historyLoaded&&afterAutoOlder.top<afterAutoOlder.scrollHeight-afterAutoOlder.clientHeight-500&&afterAutoOlder.first!==null;
 const beforeInbound=await position();
 await rawTool(d.wang.token,'network_message_send',{request_id:id(),client_message_id:id(),room_id:d.rooms.history.room_id,body:'修复验证：阅读历史时收到新消息',invoke:[]});await page.waitForTimeout(800);const afterInbound=await position();const jumpVisible=await page.locator('#jump-latest').isVisible().catch(()=>false);
 const noJumpBottom=beforeInbound.first===afterInbound.first&&Math.abs(beforeInbound.top-afterInbound.top)<3;
 results.push({id:'U02',status:loadedCount>80&&domAfter===domBefore&&restored&&olderLoadedWithoutJump&&noJumpBottom&&jumpVisible?'PASS':'FAIL',loadedHistoryDomBeforeSwitch:domBefore,loadedHistoryDomAfterReturn:domAfter,reopenMs,olderClicks,cacheOverRenderMax:loadedCount>80,beforeSwitch:before,afterReturn:after,restored,historyLoaded,historyLoadAttempts,historyBefore,afterAutoOlder,olderLoadedWithoutJump,afterOlderLoad:beforeInbound,afterInboundMessage:afterInbound,jumpLatestVisible:jumpVisible,noForcedBottom:noJumpBottom});

 // U03: while a direct chat remains selected, an unread group message must be discoverable cross-tab.
 await open(page,'单聊',d.rooms.directWang.room_id);const directTabUnread=await page.locator('#room-filter-direct .room-filter-unread').innerText().catch(()=>null);
 await rawTool(d.wang.token,'network_message_send',{request_id:id(),client_message_id:id(),room_id:d.rooms.joined.room_id,body:'跨分类未读提示修复验证',invoke:[]});await page.waitForTimeout(800);
 const groupBadge=await page.locator('#room-filter-group .room-filter-unread').innerText().catch(()=>null);
 const groupDescription=await page.locator('#room-filter-group').getAttribute('aria-describedby');
 const descriptionText=groupDescription?await page.locator('#'+groupDescription).innerText():'';
 const currentRoom=await page.locator('#title').innerText();
 const crossTabShown=Boolean(groupBadge)&&Number(groupBadge)>0&&currentRoom==='小王';
 await page.getByRole('tab',{name:'群聊',exact:true}).click();const joinedRow=page.locator('#room-list a[href="/c/'+d.rooms.joined.room_id+'"]').first();
 const unreadDot=await joinedRow.locator('.unread').count();const unreadDotColor=await joinedRow.locator('.unread').evaluate((el:any)=>getComputedStyle(el).backgroundColor).catch(()=>null);
 // Muting removes attention from the tab count while retaining a gray unread marker.
 await menu(d.rooms.joined.room_id);await page.getByRole('menuitem',{name:'消息免打扰',exact:true}).click();await page.waitForTimeout(200);
 const mutedBadge=await page.locator('#room-filter-group .room-filter-unread').innerText().catch(()=>null);const mutedDotColor=await page.locator('#room-list a[href="/c/'+d.rooms.joined.room_id+'"] .unread').evaluate((el:any)=>getComputedStyle(el).backgroundColor).catch(()=>null);
 // Pin an older group and verify it sorts ahead of the most recently active group.
 const beforePin=await page.locator('#room-list a').evaluateAll((es:any[])=>es.map(e=>e.getAttribute('href')));
 await menu(d.rooms.owned.room_id);await page.getByRole('menuitem',{name:'置顶聊天',exact:true}).click();await page.waitForTimeout(200);
 const afterPin=await page.locator('#room-list a').evaluateAll((es:any[])=>es.map(e=>e.getAttribute('href')));
 const pinFirst=afterPin[0]==='/c/'+d.rooms.owned.room_id;
 results.push({id:'U03',status:crossTabShown&&unreadDot>0&&Number(mutedBadge||0)===Number(groupBadge||0)-1&&mutedDotColor!==unreadDotColor&&pinFirst?'PASS':'FAIL',currentRoom,groupBadge,directTabUnread,groupDescription,descriptionText,crossTabShown,joinedUnreadDotCount:unreadDot,unreadDotColor,mutedTabBadgeCount:mutedBadge,mutedUnreadDotColor:mutedDotColor,roomsBeforePin:beforePin,roomsAfterPin:afterPin,pinnedRoomFirst:pinFirst});
 results.push({id:'console',status:pageErrors.length===0?'PASS':'FAIL',pageErrors});
 console.log(JSON.stringify({baseline,results},null,2));
} finally {await browser.close();await fixture.stop();}
await writeFile(out+'/after.json',JSON.stringify({baseline,results},null,2));
await writeFile(out+'/after.md',['# Chat UX fix verification','','Baseline: e7a9af5. Browser driven through visible UI controls; synthetic fixture only.','',...results.map(r=>'## '+r.id+' — '+r.status+'\n\n'+JSON.stringify(r,null,2)),'','Native OS IME and mobile device input were not exercised.'].join('\n'));
if(results.some(result=>result.status!=='PASS'))throw new Error('Chat fix UI verification failed: '+results.filter(result=>result.status!=='PASS').map(result=>result.id).join(', '));
