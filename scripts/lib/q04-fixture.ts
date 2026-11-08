/**
 * Q04 夹具：合成身份、好友关系、Agent 管理关系与 direct 会话。
 *
 * 唯一需要真实浏览器的是“新建 Agent”入口；其余用 rawRpc 建立前置关系，
 * 后续操作仍由 Playwright 操作真实控件。所有 token 仅存在内存。
 */

import type { Browser, Page } from 'playwright';

import {
  befriend,
  check,
  checkEqual,
  createManagedAgent,
  findDirectRoom,
  makeContext,
  newRequestId,
  rawTool,
  sleep,
  type Actor,
  type ManagedAgentView,
  type RoomView,
} from './q04-harness';

export interface Q04State {
  base: string;
  dataDir: string;
  dbPath: string;
  errors: string[];
  tokens: {
    u1: string;
    u2: string;
    u3: string;
    u4: string;
    u5: string;
    b1: string;
    b2: string;
    b3: string;
    b4: string;
  };
  actors: {
    u1: Actor;
    u2: Actor;
    u3: Actor;
    u4: Actor;
    u5: Actor;
    b1: Actor;
    b2: Actor;
    b3: Actor;
    b4: Actor;
  };
  rooms: {
    directU1U2: string;
    directU1U3: string;
    directU1U5: string;
    directU1B1: string;
    directU1B2: string;
    directU1B3: string;
    main: string;
    leave: string;
    invite: string;
    handoff: string;
    ownerless: string;
  };
}

async function registerHuman(token: string, name: string): Promise<Actor> {
  return rawTool<Actor>(token, 'network_register', {
    request_id: newRequestId('q04_register'),
    kind: 'human',
    name,
  });
}

function parseMcpToken(mcpUrl: string): string {
  try {
    const token = new URL(mcpUrl).searchParams.get('token');
    if (token) return token;
  } catch {
    // 兼容相对 URL
  }
  const match = mcpUrl.match(/[?&]token=([^&]+)/u);
  if (!match) throw new Error('新建 Agent 未返回 token');
  return decodeURIComponent(match[1]!);
}

/** 通过真实“新建 Agent”弹窗创建 B1，并读取一次性 MCP URL 中本机使用的 token。 */
async function createB1ViaUi(browser: Browser, base: string, u1Token: string): Promise<ManagedAgentView> {
  const { context, page } = await makeContext(browser, u1Token, { width: 1280, height: 900 }, []);
  try {
    await page.goto(`${base}/`);
    await page.locator('#new-agent').waitFor();
    await page.locator('#new-agent').click();
    await page.locator('#new-agent-modal').waitFor({ state: 'visible' });
    await page.fill('#new-agent-name', '同名验收助手');
    await page.locator('#new-agent-create').click();
    await page.locator('#new-agent-result').waitFor({ state: 'visible' });
    const mcpUrl = await page.locator('#new-agent-url').inputValue();
    const token = parseMcpToken(mcpUrl);
    check('新建 Agent 弹窗返回一次性 MCP URL', mcpUrl.includes('/mcp'), true);
    await page.locator('#new-agent-close').click();
    const managed = await rawTool<{ items: { actor_id: string; name: string; status?: string }[] }>(
      u1Token,
      'network_agents_managed_list',
      { limit: 100 },
    );
    const created = managed.items.find((item) => item.name === '同名验收助手');
    if (!created) throw new Error('新建 Agent 未出现在管理列表');
    checkEqual('新建 Agent 管理列表可见', created.name, '同名验收助手');
    await context.close();
    return {
      ...created,
      kind: 'agent',
      token,
      agent_session_id: null,
      name: created.name,
    } as ManagedAgentView;
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function directRoom(token: string, actorId: string): Promise<string> {
  const created = await rawTool<RoomView>(token, 'network_room_create', {
    request_id: newRequestId('q04_direct'),
    kind: 'direct',
    members: [actorId],
  });
  return created.room.room_id;
}

export async function setupQ04Fixture(
  browser: Browser,
  base: string,
  dataDir: string,
  dbPath: string,
): Promise<{ state: Q04State; directPage: Page }> {
  const errors: string[] = [];
  const tokens = {
    u1: crypto.randomUUID(),
    u2: crypto.randomUUID(),
    u3: crypto.randomUUID(),
    u4: crypto.randomUUID(),
    u5: crypto.randomUUID(),
    b1: '',
    b2: '',
    b3: '',
    b4: `ank_${crypto.randomUUID().replaceAll('-', '')}`,
  };
  const u1 = await registerHuman(tokens.u1, 'Q04 群主');
  const u2 = await registerHuman(tokens.u2, 'Q04 成员');
  const u3 = await registerHuman(tokens.u3, 'Q04 验收人');
  const u4 = await registerHuman(tokens.u4, 'Q04 外部受邀者');
  const u5 = await registerHuman(tokens.u5, 'Q04 拉黑对象');

  for (const [token, target] of [
    [tokens.u2, u2],
    [tokens.u3, u3],
    [tokens.u4, u4],
    [tokens.u5, u5],
  ] as const) {
    await befriend(tokens.u1, token, { actor_id: target.actor_id });
  }

  const b1Created = await createB1ViaUi(browser, base, tokens.u1);
  tokens.b1 = b1Created.token;
  const b2Created = await createManagedAgent(tokens.u1, '同名验收助手');
  tokens.b2 = b2Created.token;
  const b3Created = await createManagedAgent(tokens.u1, '停用归档 Agent');
  tokens.b3 = b3Created.token;

  const b4 = await rawTool<Actor>(tokens.b4, 'network_register', {
    request_id: newRequestId('q04_register'),
    kind: 'agent',
    name: '待认领 Agent',
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  const claim = await rawTool<{ claim_id: string; code: string }>(tokens.b4, 'network_agent_claim_start', {
    request_id: newRequestId('q04_claim'),
  });
  await rawTool(tokens.u1, 'network_agent_claim_confirm', {
    request_id: newRequestId('q04_claim_confirm'),
    claim_id: claim.claim_id,
    code: claim.code,
  });
  const claimedManagement = await rawTool<{ my_role: string }>(
    tokens.u1,
    'network_agent_management_get',
    { actor_id: b4.actor_id },
  );
  checkEqual('Agent 认领后管理者绑定', claimedManagement.my_role, 'manager');

  const directU1U2 = await directRoom(tokens.u1, u2.actor_id);
  const directU1U3 = await directRoom(tokens.u1, u3.actor_id);
  const directU1U5 = await directRoom(tokens.u1, u5.actor_id);
  const directU1B1 = (await findDirectRoom(tokens.u1, b1Created.actor_id)).room.room_id;
  const directU1B2 = await directRoom(tokens.u1, b2Created.actor_id);
  const directU1B3 = await directRoom(tokens.u1, b3Created.actor_id);

  // 每个 direct 初始化后在列表里可见；标记已读，避免初始红点干扰后续未读断言。
  for (const roomId of [directU1U2, directU1U3, directU1U5, directU1B1, directU1B2, directU1B3]) {
    const detail = await rawTool<RoomView>(tokens.u1, 'network_room_get', { room_id: roomId });
    await rawTool(tokens.u1, 'network_room_mark_read', {
      room_id: roomId,
      through_seq: detail.room.head_seq,
    });
  }
  await sleep(50);

  const state: Q04State = {
    base,
    dataDir,
    dbPath,
    errors,
    tokens,
    actors: { u1, u2, u3, u4, u5, b1: b1Created, b2: b2Created, b3: b3Created, b4 },
    rooms: {
      directU1U2,
      directU1U3,
      directU1U5,
      directU1B1,
      directU1B2,
      directU1B3,
      main: '',
      leave: '',
      invite: '',
      handoff: '',
      ownerless: '',
    },
  };

  // 返回一个已登录 U1 的页面，调用方负责关闭。
  const { page } = await makeContext(browser, tokens.u1, { width: 1280, height: 900 }, errors);
  await page.goto(`${base}/`);
  await page.locator('#room-list .room-item').first().waitFor();
  return { state, directPage: page };
}

export { registerHuman };
