/**
 * Task Focus 公共 Swarm 客户端与官方 SDK 请求形状验收。
 *
 * 使用 Bun.serve 假 Swarm 捕获真实 `openai@7.60.0` 发出的 HTTP 请求；
 * 断言创建配置、MCP 工具声明、幂等键、订阅续读、202 收据、items 分页、
 * turn 查询与取消，以及错误分类不泄露 token/正文。不访问真实 Swarm。
 */

import { createFocusSwarmClient, FocusSwarmError } from '../src/focus/swarm-client';
import type { FocusRuntimeConfig } from '../src/env';
import { check, checkEqual, CheckFailure, checksPassed } from './lib/harness';
import { lastRequest, startFocusFakeSwarm } from './lib/focus-fake-swarm';

const SERVICE_TOKEN = 'svc-token-do-not-log-9f3a';
const API_KEY = 'swarm-api-key-do-not-log-77b1';
const PROVISIONING_KEY = 'focus_provisioning_key_1';

async function expectCategory(
  label: string,
  promise: Promise<unknown>,
  category: string,
): Promise<FocusSwarmError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof FocusSwarmError)) throw error;
    checkEqual(label, error.category, category);
    const text = `${error.message} ${JSON.stringify(error)}`;
    check(`${label} 不泄露 token`, !text.includes(SERVICE_TOKEN) && !text.includes(API_KEY));
    return error;
  }
  throw new CheckFailure(label, `期望 ${category}，但调用成功`);
}

function configFor(url: string): FocusRuntimeConfig {
  return {
    baseUrl: url,
    apiKey: API_KEY,
    model: 'webots-focus-model',
    mcpUrl: 'https://webots.example.test/mcp',
    serviceToken: SERVICE_TOKEN,
  };
}

async function run(): Promise<void> {
  const fake = startFocusFakeSwarm({ rootSessionId: 'root_fake_fixed' });
  const config = configFor(fake.url);
  const client = createFocusSwarmClient(config);
  try {
    console.log('  · 首次开通');
    const handle = await client.ensureSession({
      sessionId: null,
      rootSessionId: null,
      provisioningKey: PROVISIONING_KEY,
    });
    checkEqual('返回逻辑会话 ID', handle.sessionId, 'sess_fake_1');
    checkEqual('读取扩展根 ID', handle.rootSessionId, 'root_fake_fixed');

    const create = lastRequest(fake, '/agents/sessions');
    check('记录了创建请求', create !== undefined);
    const body = create?.body as Record<string, unknown>;
    checkEqual('environment.type=none', (body.environment as Record<string, unknown>)?.type, 'none');
    const agent = body.agent as Record<string, unknown>;
    checkEqual('agent.model 来自配置', agent.model, 'webots-focus-model');
    check('agent.instructions 非空', typeof agent.instructions === 'string' && (agent.instructions as string).length > 0);
    const tools = agent.tools as Array<Record<string, unknown>>;
    checkEqual('只声明一个 MCP 服务', tools.length, 1);
    const tool = tools[0] as Record<string, unknown>;
    checkEqual('工具类型 mcp', tool.type, 'mcp');
    checkEqual('服务标签', tool.server_label, 'webots_focus');
    checkEqual('required=true', tool.required, true);
    checkEqual(
      'allowed_tools 只含四项',
      JSON.stringify(tool.allowed_tools),
      JSON.stringify([
        'network_focus_job_get',
        'network_focus_evidence_read',
        'network_focus_items_find',
        'network_focus_commit',
      ]),
    );
    const transport = tool.transport as Record<string, unknown>;
    checkEqual('transport.type=http', transport.type, 'http');
    checkEqual('transport.server_url', transport.server_url, config.mcpUrl);
    const headers = transport.headers as Record<string, string>;
    checkEqual('MCP 回调使用服务 token', headers.Authorization, `Bearer ${SERVICE_TOKEN}`);
    checkEqual('幂等键复用 provisioning_key', create?.idempotencyKey, PROVISIONING_KEY);
    checkEqual('Swarm Bearer 使用部署凭据', create?.headers.authorization, `Bearer ${API_KEY}`);
    check('metadata 标记秘书角色', (body.metadata as Record<string, string>)?.webots_role === 'task_focus_secretary');

    console.log('  · 同键重试与恢复');
    const retried = await client.ensureSession({
      sessionId: null,
      rootSessionId: null,
      provisioningKey: PROVISIONING_KEY,
    });
    checkEqual('同键返回同一逻辑会话', retried.sessionId, handle.sessionId);
    const creates = fake.requests.filter((request) => request.path === '/agents/sessions');
    checkEqual('假 Swarm 收到两次 create（幂等由远端收敛）', creates.length, 2);
    check('两次请求幂等键一致', creates.every((request) => request.idempotencyKey === PROVISIONING_KEY));

    const resumed = await client.ensureSession({
      sessionId: handle.sessionId,
      rootSessionId: handle.rootSessionId,
      provisioningKey: PROVISIONING_KEY,
    });
    checkEqual('已存 ID 走 retrieve', resumed.sessionId, handle.sessionId);
    const retrieve = lastRequest(fake, `/agents/sessions/${handle.sessionId}`, 'GET');
    check('记录了 retrieve', retrieve !== undefined);

    fake.behavior.rootOverride = 'root_other';
    await expectCategory(
      '根 ID 不符归类 focus_session_missing',
      client.ensureSession({
        sessionId: handle.sessionId,
        rootSessionId: handle.rootSessionId,
        provisioningKey: PROVISIONING_KEY,
      }),
      'focus_session_missing',
    );
    fake.behavior.rootOverride = null;
    fake.behavior.retrieveStatus = 404;
    await expectCategory(
      'retrieve 404 归类 focus_session_missing',
      client.ensureSession({
        sessionId: handle.sessionId,
        rootSessionId: handle.rootSessionId,
        provisioningKey: PROVISIONING_KEY,
      }),
      'focus_session_missing',
    );
    fake.behavior.retrieveStatus = null;

    console.log('  · 输入、观察与取消');
    const receipt = await client.submitInput(
      handle.sessionId,
      'job_id: fjob_1\nattempt_ref: fat_1',
      'focus_input_key_1',
    );
    checkEqual('202 inputId 被解析', receipt.inputId.startsWith('inp_fake_'), true);
    checkEqual('202 accepted', receipt.accepted, true);
    checkEqual('202 lastItemSeq', receipt.lastItemSeq, 7);
    const submit = lastRequest(fake, `/agents/sessions/${handle.sessionId}/events`);
    checkEqual('提交幂等键', submit?.idempotencyKey, 'focus_input_key_1');
    const submitBody = submit?.body as Record<string, unknown>;
    const events = submitBody.events as Array<Record<string, unknown>>;
    checkEqual('输入事件类型', events[0]?.type, 'agent.session.input.message');
    const input = (events[0]?.input as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    checkEqual('输入角色 user', input.role, 'user');
    const content = (input.content as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    checkEqual('输入内容 input_text', content.type, 'input_text');
    check('输入正文含 job_id/attempt_ref', String(content.text).includes('job_id: fjob_1') && String(content.text).includes('attempt_ref: fat_1'));

    const observation = await client.observe(handle.sessionId, 7);
    checkEqual('observe 保留 after', observation.after, 7);
    const streamRequest = lastRequest(fake, `/agents/sessions/${handle.sessionId}/events`, 'GET');
    checkEqual('stream 使用 after 续读', streamRequest?.query.after, '7');
    for await (const _event of observation.events) {
      // 消费终态事件；客户端只透传，不解析正文。
    }
    observation.close();

    const cancel = await client.cancelActive(handle.sessionId, 'focus_cancel_key_1');
    checkEqual('取消受理 receipt', cancel.accepted, true);
    const cancelRequest = fake.requests.find(
      (request) =>
        request.path === `/agents/sessions/${handle.sessionId}/events` &&
        request.idempotencyKey === 'focus_cancel_key_1',
    );
    const cancelEvents = (cancelRequest?.body as Record<string, unknown>)?.events as Array<
      Record<string, unknown>
    >;
    checkEqual('取消事件类型', cancelEvents[0]?.type, 'agent.session.input.cancel');

    console.log('  · items 与 turn');
    const page = await client.listItems(handle.sessionId, { after: 'item_fake_1', limit: 2 });
    checkEqual('items 返回两行', page.items.length, 2);
    checkEqual('items nextCursor 来自原始页', page.nextCursor, 'item_fake_2');
    const itemsRequest = lastRequest(fake, `/agents/sessions/${handle.sessionId}/items`, 'GET');
    checkEqual('items after', itemsRequest?.query.after, 'item_fake_1');
    checkEqual('items limit', itemsRequest?.query.limit, '2');

    const turn = await client.retrieveTurn(handle.sessionId, 'turn_fake_1');
    checkEqual('turn 终态', turn.status, 'completed');
    const turnRequest = lastRequest(
      fake,
      `/agents/sessions/${handle.sessionId}/turns/turn_fake_1`,
      'GET',
    );
    check('记录了 turn 查询', turnRequest !== undefined);

    console.log('  · 错误分类不泄露');
    fake.behavior.submitStatus = 500;
    await expectCategory(
      '5xx 归类 focus_swarm_unavailable',
      client.submitInput(handle.sessionId, '正文不得进入错误', 'focus_input_key_2'),
      'focus_swarm_unavailable',
    );
    const afterFailure = fake.requests.filter(
      (request) => request.idempotencyKey === 'focus_input_key_2',
    );
    checkEqual('SDK 不隐式重试（maxRetries=0）', afterFailure.length, 1);
    fake.behavior.submitStatus = null;

    fake.behavior.createStatus = 401;
    await expectCategory(
      '401 归类 focus_swarm_unauthorized',
      client.ensureSession({
        sessionId: null,
        rootSessionId: null,
        provisioningKey: 'focus_provisioning_key_401',
      }),
      'focus_swarm_unauthorized',
    );
    fake.behavior.createStatus = 400;
    await expectCategory(
      '4xx 归类 focus_swarm_rejected',
      client.ensureSession({
        sessionId: null,
        rootSessionId: null,
        provisioningKey: 'focus_provisioning_key_400',
      }),
      'focus_swarm_rejected',
    );
    fake.behavior.createStatus = null;
  } finally {
    await fake.close();
  }

  console.log(`Swarm 客户端验收通过：${checksPassed()} 项检查`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
