import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFixture } from './fixture';

const OUT=resolve(process.env.UX_OUTPUT || `${process.cwd()}/reports/evidence`);
await mkdir(OUT,{recursive:true});
const fixture=await createFixture(['mobile']);
const d=fixture.scenarios.mobile;
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1280,height:900},isMobile:false,hasTouch:true,acceptDownloads:true});
await context.addInitScript(token=>localStorage.setItem('agent-network-token',token),d.me.token);
const page=await context.newPage();page.setDefaultTimeout(9000);
type Result={id:string;goal:string;steps:string[];expected:string;observed:string;status:'PASS'|'UX_GAP'|'BUG'|'BLOCKED';severity?:'P0'|'P1'|'P2';evidence:string[]};
const results:Result[]=[];
async function caseOf(id:string,goal:string,steps:string[],expected:string,action:()=>Promise<Partial<Result>&{observed:string}>){
  try{const r=await action();const x={id,goal,steps,expected,observed:r.observed,status:r.status||'PASS',...(r.severity?{severity:r.severity}:{}),evidence:r.evidence||[]} as Result;results.push(x);console.log(`${id} ${x.status}: ${x.observed}`);}
  catch(e){const x={id,goal,steps,expected,observed:`操作中断：${String(e).slice(0,350)}`,status:'BLOCKED' as const,evidence:['界面交互未完成；没有产品数据凭据写入报告。']};results.push(x);console.log(`${id} BLOCKED: ${x.observed}`);}
}
const box=async(locator:any)=>{const r=await locator.boundingBox();return r?{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}:null;};
const openGroup=async()=>{
  await page.getByRole('tab',{name:'群聊',exact:true}).tap();
  await page.locator(`#room-list a[href="/c/${d.rooms.owned.room_id}"]`).tap();
  await page.waitForFunction(()=>document.body.classList.contains('page-room')&&document.querySelector('#title')?.textContent==='周末活动讨论群');
  await page.waitForFunction(()=>document.querySelector('#chat-body')?.getAttribute('aria-busy')==='false');
};
const openMembers=async()=>{const btn=page.locator('#add-members');await btn.tap();await page.getByRole('dialog',{name:'群组设置'}).waitFor({state:'visible'});};
const closeMembers=async()=>{const btn=page.getByRole('button',{name:'关闭群组设置'});if(await btn.isVisible().catch(()=>false))await btn.tap();};
const longName=d.longName.name as string;
const inspectLongName=async(width:number)=>{
  await page.setViewportSize({width,height:844});await openMembers();
  const search=page.getByRole('searchbox',{name:'搜索好友名称'});await search.fill(longName);
  const name=page.locator('#members-contacts .contact-name').filter({hasText:longName}).first();await name.waitFor({state:'visible'});
  await page.waitForFunction((wanted:string)=>Array.from(document.querySelectorAll('#members-contacts .contact-name')).some(raw=>{const e=raw as HTMLElement;return e.innerText===wanted&&e.getBoundingClientRect().height>0;}),longName);
  const candidate=page.locator('#members-contacts .contact-choice').filter({hasText:longName}).first();
  const geometry=await name.evaluate((e:any)=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow,overflow:s.overflow,text:e.innerText};});
  const labelVisible=await candidate.isVisible();
  const fullText=geometry.text===longName;
  const select=candidate.locator('input[type=checkbox]');await select.check();const selected=await select.isChecked();
  const selectionText=await page.locator('#members-selection').innerText().catch(()=> '');await select.uncheck();
  const widths=await page.evaluate(()=>({viewport:innerWidth,doc:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
  await closeMembers();
  return {labelVisible,fullText,geometry,selected,selectionText,widths};
};
const inspectGroupPicker=async(width:number)=>{
  await page.setViewportSize({width,height:844});
  const button=page.locator('#new-group');await button.waitFor({state:'visible'});await button.tap();
  const dialog=page.getByRole('dialog',{name:'新建群聊'});await dialog.waitFor({state:'visible'});
  const search=page.getByRole('searchbox',{name:'搜索好友名称'});await search.fill(longName);
  const name=page.locator('#group-contacts .contact-name').filter({hasText:longName}).first();await name.waitFor({state:'visible'});
  await page.waitForFunction((wanted:string)=>Array.from(document.querySelectorAll('#group-contacts .contact-name')).some(raw=>{const e=raw as HTMLElement;return e.innerText===wanted&&e.getBoundingClientRect().height>0;}),longName);
  const geometry=await name.evaluate((e:any)=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow,text:e.innerText};});
  const candidate=page.locator('#group-contacts .contact-choice').filter({hasText:longName}).first();
  const visible=await candidate.isVisible();const checkbox=candidate.locator('input[type=checkbox]');await checkbox.check();const selected=await checkbox.isChecked();const selectionText=await page.locator('#group-selection').innerText();
  const widths=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
  await page.locator('#group-cancel').tap();await dialog.waitFor({state:'hidden'});
  return{geometry,visible,selected,selectionText,widths};
};
try{
  await page.goto(fixture.base);await page.locator('#room-filter').waitFor({state:'visible'});await openGroup();
  await caseOf('U08','桌面 1280px 打开文件栏时标题仍可读',['1280×900 打开群聊','点“文件”打开右栏','检查聊天标题/右栏尺寸与整页溢出'],
    '文件栏保留；聊天标题不被压成短片段，聊天区与整页不横向溢出',async()=>{
      const open=page.locator('#files-toggle');await page.waitForFunction(()=>{const e=document.querySelector('#files-toggle') as HTMLElement|null;const r=e?.getBoundingClientRect();return Boolean(r&&r.width>0&&r.height>0);});const before=await open.evaluate((e:any)=>{const r=e.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}});const initialExpanded=await open.getAttribute('aria-expanded');const initialVisible=await page.locator('#files-pane').isVisible().catch(()=>false);if(!initialVisible)await open.tap();await page.waitForTimeout(500);
      const filePaneVisible=await page.locator('#files-pane').isVisible().catch(()=>false);
      if(!filePaneVisible){const diagnostic=await page.evaluate(()=>{const e=document.querySelector('#files-toggle') as HTMLElement|null;const r=e?.getBoundingClientRect();return{viewport:{width:innerWidth,height:innerHeight},rect:r&&{x:r.x,y:r.y,width:r.width,height:r.height},text:e?.innerText,display:e&&getComputedStyle(e).display,bodyClass:document.body.className,roomId:document.querySelector('#title')?.textContent};});return {observed:`文件栏未显示（点击前可见=${initialVisible}，aria-expanded=${initialExpanded}）；按钮坐标=${JSON.stringify(before)}，页面诊断=${JSON.stringify(diagnostic)}。`,status:'UX_GAP',severity:'P1',evidence:[`按钮=${JSON.stringify(before)}`,`点击前可见=${initialVisible}; aria-expanded=${initialExpanded}; 点击后=${await open.getAttribute('aria-expanded')}`,`诊断=${JSON.stringify(diagnostic)}`]};}
      const title=page.locator('#title');const info=await title.evaluate((e:any)=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return{text:e.textContent,width:Math.round(r.width),height:Math.round(r.height),clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,clipped:e.scrollWidth>e.clientWidth+1,whiteSpace:s.whiteSpace,textOverflow:s.textOverflow};});
      const widths=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
      const panes=await Promise.all([box(page.locator('.chat-pane:not(.empty-pane)')),box(page.locator('#files-pane')),box(page.locator('.chat-head')),box(title)]);
      const ok=info.width>=120&&!info.clipped&&widths.document<=widths.viewport+1&&widths.body<=widths.viewport+1;
      if(initialVisible){await open.tap();await page.waitForFunction(()=>document.querySelector('#files-pane')?.hasAttribute('hidden'));}
      return {observed:`文件栏保持可见；标题宽 ${info.width}px / 文字裁切=${info.clipped}；视口/文档宽 ${widths.viewport}/${widths.document}px。`,status:ok?'PASS':'UX_GAP',severity:ok?undefined:'P1',evidence:[`标题计算样式=${JSON.stringify(info)}`,`视口尺寸=${JSON.stringify(widths)}`,`面板/聊天头坐标=${JSON.stringify(panes)}`]};
    });
  await caseOf('U08-monitor','桌面监控栏打开时聊天标题仍保留工作宽度',['1280×900 点“网页”打开监控栏','核对聊天标题和横向溢出'],
    '监控功能可用，聊天标题保留足够宽度',async()=>{
      await page.getByRole('button',{name:'打开网页监控'}).tap();await page.locator('#monitor-pane').waitFor({state:'visible'});
      const title=page.locator('#title');const info=await title.evaluate((e:any)=>{const r=e.getBoundingClientRect();return{width:Math.round(r.width),client:e.clientWidth,scroll:e.scrollWidth,clipped:e.scrollWidth>e.clientWidth+1,text:e.textContent};});
      const widths=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
      const ok=info.width>=120&&!info.clipped&&widths.document<=widths.viewport+1;
      await page.locator('#monitor-toggle').tap().catch(()=>{});
      return {observed:`监控栏可见；标题宽 ${info.width}px / 裁切=${info.clipped}；页面宽 ${widths.document}/${widths.viewport}px。`,status:ok?'PASS':'UX_GAP',severity:ok?undefined:'P2',evidence:[`标题=${JSON.stringify(info)}`,`页面宽=${JSON.stringify(widths)}`]};
    });
  await page.emulateMedia({colorScheme:'dark'});
  await caseOf('U09','手机上群设置触区达到44px且能打开',['切到390×844暗色视口','点群设置','测量按钮并确认设置弹窗可见'],
    '群设置按钮的宽高至少44px，触摸后打开设置',async()=>{
      await page.setViewportSize({width:390,height:844});await openMembers();
      const target=page.locator('#add-members');const rect=await box(target);const dialog=await page.getByRole('dialog',{name:'群组设置'}).isVisible();
      const bg=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--wx-bg').trim());
      const ok=Boolean(rect&&rect.width>=44&&rect.height>=44&&dialog);
      await closeMembers();
      return {observed:`390px 暗色下群设置触区 ${rect?.width}×${rect?.height}px，弹窗可见=${dialog}。`,status:ok?'PASS':'UX_GAP',severity:ok?undefined:'P2',evidence:[`按钮框=${JSON.stringify(rect)}; 弹窗=${dialog}; 暗色背景变量=${bg}`]};
    });
  await caseOf('U12-390','390px 手机设置里可读和选择完整长姓名',['打开群设置','搜索已加好友的完整长姓名','确认可见名字全文、换行不裁切','勾选后取消'],
    '完整姓名可见并能点击选择，无需 hover 提示',async()=>{
      const r=await inspectLongName(390);const noClip=r.geometry.scrollWidth<=r.geometry.clientWidth+1&&r.geometry.scrollHeight<=r.geometry.clientHeight+1;
      const ok=r.labelVisible&&r.fullText&&noClip&&r.selected;
      return {observed:`390px 下候选姓名完整=${r.fullText}，可见=${r.labelVisible}，换行高度=${r.geometry.height}px，可选择=${r.selected}。`,status:ok?'PASS':'UX_GAP',severity:ok?undefined:'P2',evidence:[`名字几何/换行=${JSON.stringify(r.geometry)}`,`候选框/选择=${r.labelVisible}/${r.selected}; 选择提示=${r.selectionText}`,`视口宽度=${JSON.stringify(r.widths)}`]};
    });
  await caseOf('U12-320','320px 更窄手机上可读和选择完整长姓名',['切到320×844','打开群设置并搜索完整长姓名','检查候选名布局、横向溢出和选择'],
    '名字可读、可选择；弹窗和整页没有横向溢出',async()=>{
      const r=await inspectLongName(320);const noClip=r.geometry.scrollWidth<=r.geometry.clientWidth+1&&r.geometry.scrollHeight<=r.geometry.clientHeight+1;
      const ok=r.labelVisible&&r.fullText&&noClip&&r.selected&&r.widths.doc<=r.widths.viewport+1&&r.widths.body<=r.widths.viewport+1;
      return {observed:`320px 下长姓名完整=${r.fullText}，候选可见=${r.labelVisible}，换行高 ${r.geometry.height}px，可选择=${r.selected}；页面横向溢出=${r.widths.doc>r.widths.viewport||r.widths.body>r.widths.viewport}。`,status:ok?'PASS':'UX_GAP',severity:ok?undefined:'P2',evidence:[`名字布局=${JSON.stringify(r.geometry)}`,`选择=${r.selected}; 选择提示=${r.selectionText}`,`视口=${JSON.stringify(r.widths)}`]};
    });
  await caseOf('U12-dark','暗色手机显示长姓名与触区不变',['390×844 暗色模式再次打开群设置','核对长姓名/设置控件与可读性'],
    '深色模式下长名仍可见，触区仍不小于44px',async()=>{
      await page.setViewportSize({width:390,height:844});await openMembers();const target=page.locator('#add-members');const rect=await box(target);
      await page.getByRole('searchbox',{name:'搜索好友名称'}).fill(longName);
      const name=page.locator('#members-contacts .contact-name').filter({hasText:longName}).first();await name.waitFor({state:'visible'});await page.waitForFunction((wanted:string)=>Array.from(document.querySelectorAll('#members-contacts .contact-name')).some(raw=>{const e=raw as HTMLElement;return e.innerText===wanted&&e.getBoundingClientRect().height>0;}),longName);
      const info=await name.evaluate(async(e:any)=>{for(let i=0;i<20&&e.getBoundingClientRect().height<=18;i++)await new Promise(requestAnimationFrame);return{text:e.innerText,height:Math.round(e.getBoundingClientRect().height),whiteSpace:getComputedStyle(e).whiteSpace,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor};});
      const ok=info.text===longName&&info.whiteSpace!=='nowrap'&&Boolean(rect&&rect.width>=44&&rect.height>=44);
      await closeMembers();
      return {observed:`暗色下长姓名全文=${info.text===longName}、姓名行高 ${info.height}px、white-space=${info.whiteSpace}；设置触区 ${rect?.width}×${rect?.height}px。`,status:ok?'PASS':'UX_GAP',severity:ok?undefined:'P2',evidence:[`名字样式=${JSON.stringify(info)}`,`设置触区=${JSON.stringify(rect)}`]};
    });
  await caseOf('U12-group-desktop','桌面建群选择器显示完整长姓名并可选择',['切到1280px桌面视口','点击新建群聊','搜索长姓名并核对换行、完整性与选择状态'],
    '桌面建群选择器中长姓名不截断，能勾选成员',async()=>{
      await page.emulateMedia({colorScheme:'light'});const r=await inspectGroupPicker(1280);
      const noClip=r.geometry.scrollWidth<=r.geometry.clientWidth+1&&r.geometry.height>0;
      const ok=r.visible&&r.geometry.text===longName&&noClip&&r.selected;
      return{observed:`1280px建群候选长姓名全文=${r.geometry.text===longName}，行高=${r.geometry.height}px，可见=${r.visible}，可选择=${r.selected}。`,status:ok?'PASS':'UX_GAP',severity:ok?undefined:'P2',evidence:[`姓名布局=${JSON.stringify(r.geometry)}`,`可见/选择=${r.visible}/${r.selected}; 提示=${r.selectionText}`,`视口=${JSON.stringify(r.widths)}`]};
    });
  await caseOf('U12-group-mobile','手机建群选择器显示完整长姓名并可选择',['点击返回会话列表','切到390px手机视口','新建群聊并搜索长姓名、勾选'],
    '手机建群选择器中长姓名完整可读且能勾选',async()=>{
      await page.setViewportSize({width:390,height:844});if(!await page.evaluate(()=>document.body.classList.contains('page-home'))){await page.locator('#back').tap();await page.waitForFunction(()=>document.body.classList.contains('page-home'));}
      await page.emulateMedia({colorScheme:'dark'});const r=await inspectGroupPicker(390);
      const noClip=r.geometry.scrollWidth<=r.geometry.clientWidth+1&&r.geometry.height>0;
      const ok=r.visible&&r.geometry.text===longName&&noClip&&r.selected&&r.widths.document<=r.widths.viewport+1;
      return{observed:`390px手机建群候选长姓名全文=${r.geometry.text===longName}，行高=${r.geometry.height}px，可见=${r.visible}，可选择=${r.selected}；横向溢出=${r.widths.document>r.widths.viewport}。`,status:ok?'PASS':'UX_GAP',severity:ok?undefined:'P2',evidence:[`姓名布局=${JSON.stringify(r.geometry)}`,`可见/选择=${r.visible}/${r.selected}; 提示=${r.selectionText}`,`视口=${JSON.stringify(r.widths)}`]};
    });
  await caseOf('U12-members-mobile','手机群设置仍能识别并勾选完整长姓名',['从列表返回测试群聊','打开群组设置','搜索并勾选长姓名'],
    '原有群成员选择器中长姓名完整显示且可选择',async()=>{
      await page.setViewportSize({width:390,height:844});if(!await page.evaluate(()=>document.body.classList.contains('page-home'))){await page.locator('#back').tap();await page.waitForFunction(()=>document.body.classList.contains('page-home'));}
      await openGroup();const r=await inspectLongName(390);const ok=r.labelVisible&&r.fullText&&r.geometry.scrollWidth<=r.geometry.clientWidth+1&&r.selected;
      return{observed:`390px群设置候选长姓名全文=${r.fullText}，行高=${r.geometry.height}px，可见=${r.labelVisible}，可选择=${r.selected}。`,status:ok?'PASS':'UX_GAP',severity:ok?undefined:'P2',evidence:[`姓名布局=${JSON.stringify(r.geometry)}`,`候选可见/选择=${r.labelVisible}/${r.selected}; 提示=${r.selectionText}`]};
    });
}finally{await context.close();await browser.close();await fixture.stop();}
const report={environment:'Chromium headless with touch-enabled responsive viewport emulation; not a physical iOS/Android device',viewports:['1280×900','390×844','320×844'],darkMode:true,scenarios:results};
await writeFile(`${OUT}/results.json`,JSON.stringify(report,null,2));
const md=['# Mobile / desktop UX fixes verification','',`Environment: ${report.environment}`,'','Run summary: '+results.length+' checks; '+results.filter(x=>x.status==='PASS').length+' PASS, '+results.filter(x=>x.status!=='PASS').length+' non-pass.','',...results.map(r=>`## ${r.id} — ${r.status}${r.severity?` (${r.severity})`:''}\n\nGoal: ${r.goal}\n\nSteps: ${r.steps.join('; ')}\n\nExpected: ${r.expected}\n\nObserved: ${r.observed}\n\nEvidence: ${r.evidence.join('; ')||'—'}`),''].join('\n');
await writeFile(`${OUT}/report.md`,md);
const summary=Object.fromEntries(['PASS','UX_GAP','BUG','BLOCKED'].map(s=>[s,results.filter(x=>x.status===s).length]));
console.log(JSON.stringify({count:results.length,summary,files:[`${OUT}/results.json`,`${OUT}/report.md`]},null,2));
if(results.some(x=>x.status!=='PASS'))process.exitCode=1;
