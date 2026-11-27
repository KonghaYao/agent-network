import { callTool, connectClient, newRequestId, newToken, sleep } from './lib/harness';
import { registerIdentity, sendMessage } from './lib/acceptance-helpers';
import { reservePort, startTestServer } from './lib/test-server';

const SWARM_KEY = process.env.PERI_SWARM_API_KEY!;
const token = `focus_delivery_service_${crypto.randomUUID().replaceAll('-', '')}`;
const port = reservePort(); const base = `http://127.0.0.1:${port}`;
const server = await startTestServer({ port, tag: 'focus-delivery', env: {
  PUBLIC_ORIGIN: base, WEBOTS_SWARM_BASE_URL: process.env.PERI_SWARM_URL ?? 'http://127.0.0.1:8080/v1',
  WEBOTS_SWARM_API_KEY: SWARM_KEY, WEBOTS_FOCUS_MODEL: 'deepseek-v4-flash',
  WEBOTS_FOCUS_MCP_URL: `http://host.docker.internal:${port}/mcp`, WEBOTS_FOCUS_SERVICE_TOKEN: token,
}});
process.env.AGENTNET_URL = base;
const lin = await connectClient(newToken());
try {
  const linId = await registerIdentity(lin, { kind: 'human', name: '交付林舟' });
  const agent = await callTool<{ actor_id: string; token: string }>(lin.client, 'network_agent_create', { request_id: newRequestId('a'), name: '交付构建 Agent' });
  const room = await callTool<{ room: { room_id: string } }>(lin.client, 'network_room_create', { request_id: newRequestId('r'), kind: 'group', members: [agent.actor_id], title: '交付联调群' });
  await callTool(lin.client, 'network_focus_enable', { request_id: newRequestId('e') });
  for (let i = 0; i < 60; i += 1) {
    const s = await callTool<{ status: string }>(lin.client, 'network_focus_status', {});
    if (s.status === 'active') break; await sleep(1000);
  }
  const sent = await sendMessage(lin, room.room.room_id, '构建 Agent，请整理 RC2 安装包并交付，完成后回复结果；林舟验收。', { invoke: [agent.actor_id] });
  console.log('delivery_ids', sent.delivery_ids);
  const agentConn = await connectClient(agent.token);
  const claimed = await callTool<{ delivery_id: string; attempt: number; claim_id: string }>(agentConn.client, 'network_delivery_claim', { request_id: newRequestId('claim'), delivery_id: sent.delivery_ids[0] });
  console.log('claimed', claimed.delivery_id, claimed.attempt);
  let list: { items: { item_id: string; title: string; column_key: string; version: number; source_count: number }[] } = { items: [] };
  for (let i = 0; i < 90; i += 1) {
    list = await callTool(lin.client, 'network_focus_list', {});
    if (list.items.length > 0) break; await sleep(1000);
  }
  console.log('CARD_AFTER_CLAIM', JSON.stringify(list.items, null, 2));
  await callTool(agentConn.client, 'network_delivery_complete', {
    request_id: newRequestId('done'), delivery_id: claimed.delivery_id,
    attempt: claimed.attempt, claim_id: claimed.claim_id,
  });
  await sendMessage(agentConn, room.room.room_id, 'RC2 安装包已交付，版本 rc2，请验收。');
  await agentConn.close();
  const first = list.items[0];
  for (let i = 0; i < 90; i += 1) {
    const now = await callTool<{ items: typeof list.items }>(lin.client, 'network_focus_list', {});
    const found = first ? now.items.find((x) => x.item_id === first.item_id) : undefined;
    if (first && found && (found.version > first.version || found.source_count > first.source_count || found.column_key !== first.column_key)) {
      console.log('CARD_AFTER_COMPLETE', JSON.stringify(found, null, 2)); break;
    }
    if (i % 10 === 0) console.log('waiting-update', i);
    await sleep(1000);
  }
} finally { await lin.close(); await server.dispose(); }
