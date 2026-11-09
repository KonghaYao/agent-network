import { startServer, rawTool } from '../verify-web';


export async function createFixture(personas: string[] = ['chat','groups','mobile']) {
const server = await startServer();
process.env.AGENTNET_URL = server.base;
const id = () => crypto.randomUUID();
const tool = (token:string,name:string,args:Record<string,unknown>={}) => rawTool<any>(token,name,args);
async function person(name:string) {
  const token=id();
  return { token, ...await tool(token,'network_register',{request_id:id(),kind:'human',name}) };
}
async function friend(a:any,b:any) {
  const result=await tool(a.token,'network_contact_request',{request_id:id(),actor_id:b.actor_id});
  if(result.request) await tool(b.token,'network_contact_request_respond',{request_id:id(),contact_request_id:result.request.contact_request_id,action:'accept'});
}
async function group(owner:any,title:string,members:any[]) {
  const detail=await tool(owner.token,'network_room_create',{request_id:id(),kind:'group',title,members:members.map(m=>m.actor_id)});
  for(const invite of detail.invited || []) {
    const member=members.find(m=>m.actor_id===invite.actor_id);
    if(member) await tool(member.token,'network_room_invite_respond',{request_id:id(),invitation_id:invite.invitation_id,action:'accept'});
  }
  return detail.room;
}
const data:any={base:server.base,scenarios:{},baseline:'e7a9af5'};
for(const key of personas) {
  const me=await person(key==='chat'?'日常聊天用户':key==='groups'?'群主小陈':'手机用户小周');
  const wang=await person('小王');
  const li=await person('小李');
  const longName=await person('设计同事小林（负责本周交付验收与设计评审）');
  for(const peer of [wang,li,longName]) await friend(me,peer);
  const created=await tool(me.token,'network_agent_create',{request_id:id(),name:'项目助手'});
  const agent={...created.actor,token:created.token};
  if(!agent.actor_id) Object.assign(agent,created);
  if(!agent.token && created.mcp_url) agent.token=new URL(created.mcp_url).searchParams.get('token');
  const directWang=(await tool(me.token,'network_room_create',{request_id:id(),kind:'direct',members:[wang.actor_id]})).room;
  const directLi=(await tool(me.token,'network_room_create',{request_id:id(),kind:'direct',members:[li.actor_id]})).room;
  const owned=await group(me,'周末活动讨论群',[wang,li,agent]);
  const joined=await group(wang,'同事通知群',[me]);
  const history=await group(me,'项目交付讨论群',[wang,agent]);
  for(let i=1;i<=160;i++) {
    const sender=i%3===0 ? agent : wang;
    let body=i===23 ? '老消息检索标记：周五青柠会议室 15:30，预算 8600 元。' : '项目讨论第 '+i+' 条：今天先确认进度，再安排下一步。';
    if(i===159) body='长消息验收 '+('请确认需求、负责人和截止日期。'.repeat(900));
    if(i===160) body='**本周交付摘要**\n\n| 事项 | 状态 |\n|---|---|\n| 设计评审 | 待确认 |\n\n```ts\nconst ready = true;\n```';
    await tool(sender.token,'network_message_send',{request_id:id(),client_message_id:id(),room_id:history.room_id,body,invoke:[]});
  }
  for(const [room,sender,body] of [[directWang,wang,'明天下午三点见，记得带上资料。'],[directLi,li,'我发你的文档看到了吗？'],[owned,wang,'周末大家几点出发？'],[joined,wang,'群公告稍后更新，请大家留意。']] as any[]) {
    await tool(sender.token,'network_message_send',{request_id:id(),client_message_id:id(),room_id:room.room_id,body,invoke:[]});
  }
  data.scenarios[key]={me,wang,li,longName,agent,rooms:{directWang,directLi,owned,joined,history}};
}
return {...data, dataDir:server.dataDir, stop:server.stop};
}
