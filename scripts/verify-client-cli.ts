/**
 * agentnet CLI 验收：本地 mock MCP，不访问生产、不使用真实凭据。
 *
 * 覆盖：--help、skills list/get、send（含显式空 invoke）、inbox、
 * 通用 call、token 脱敏、monitor 迁移桥 --check、构建产物与可重复构建。
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { check, checkEqual, checksPassed } from './lib/harness';

const ROOT = resolve(import.meta.dir, '..');
const CLI = resolve(ROOT, 'client/cli.ts');
const BUNDLE = resolve(ROOT, 'public/skills/agentnet.js');
const PROTOCOL_VERSION = '2026-07-28';
const CLIENT_NAME = 'agentnet-cli';
const TOKEN = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
const SKILL_URI = 'skill://agent-network/agent-network/SKILL.md';
const SKILL_BODY = '# Agent Network\n\nmock skill body\n';
const SKILL_ENTRY = {
  uri: SKILL_URI,
  frontmatter: { name: 'agent-network', description: 'mock skill' },
  resources: [{ uri: SKILL_URI, digest: `sha256:${'0'.repeat(64)}` }],
};

const MOCK_MESSAGE = {
  message_id: 'msg_mock',
  sender_id: 'actor_mock',
  sender_name: 'Mock Sender',
  sender_kind: 'agent',
  created_seq: '42',
  preview: 'hello',
  body_bytes: 5,
  created_at: '2026-11-04T00:00:00.000Z',
};

const PENDING_DELIVERY = {
  delivery_id: 'dlv_mock',
  recipient_id: 'actor_mock',
  message_id: 'msg_mock',
  room_id: 'rm_mock',
  state: 'pending',
  attempt: 0,
  claim_id: null,
  claimed_at: null,
  progress_at: null,
  result_message_id: null,
  error: null,
  created_seq: '7',
  created_at: '2026-11-04T00:00:00.000Z',
  updated_at: '2026-11-04T00:00:00.000Z',
  message: MOCK_MESSAGE,
};

const CLAIMED_DELIVERY = {
  ...PENDING_DELIVERY,
  state: 'claimed',
  attempt: 1,
  claim_id: 'clm_mock',
  claimed_at: '2026-11-04T00:01:00.000Z',
};

const COMPLETED_DELIVERY = {
  ...CLAIMED_DELIVERY,
  state: 'completed',
  result_message_id: 'msg_reply',
  updated_at: '2026-11-04T00:02:00.000Z',
};

const REPLY_MESSAGE = {
  ...MOCK_MESSAGE,
  message_id: 'msg_reply',
  preview: 'completed',
  created_seq: '43',
};

interface MockState {
  inbox: 'pending' | 'claimed';
}

interface Captured {
  method: string;
  tool: string | null;
  arguments: Record<string, unknown> | null;
  protocolVersion: string | null;
  methodHeader: string | null;
  nameHeader: string | null;
  authorization: string | null;
  meta: Record<string, unknown> | null;
}

function startMock(): {
  baseUrl: string;
  calls: Captured[];
  state: MockState;
  stop(): void;
} {
  const calls: Captured[] = [];
  const state: MockState = { inbox: 'pending' };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/mcp') {
        return new Response('not found', { status: 404 });
      }
      const body = (await request.json()) as {
        id?: string | number | null;
        method?: string;
        params?: {
          name?: string;
          arguments?: Record<string, unknown>;
          uri?: string;
          _meta?: Record<string, unknown>;
        };
      };
      const params = body.params ?? {};
      const meta = params._meta ?? null;
      const captured: Captured = {
        method: String(body.method ?? ''),
        tool: params.name ?? null,
        arguments: params.arguments ?? null,
        protocolVersion: request.headers.get('mcp-protocol-version'),
        methodHeader: request.headers.get('mcp-method'),
        nameHeader: request.headers.get('mcp-name'),
        authorization: request.headers.get('authorization'),
        meta,
      };
      calls.push(captured);

      const fail = (status: number, message: string) =>
        Response.json(
          {
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: { code: -32600, message },
          },
          { status },
        );

      if (captured.protocolVersion !== PROTOCOL_VERSION) {
        return fail(400, 'missing MCP-Protocol-Version');
      }
      if (captured.methodHeader !== body.method) {
        return fail(400, 'MCP-Method header mismatch');
      }
      if (!meta || meta['io.modelcontextprotocol/protocolVersion'] !== PROTOCOL_VERSION) {
        return fail(400, 'missing namespaced protocolVersion');
      }
      const clientInfo = meta['io.modelcontextprotocol/clientInfo'] as
        | { name?: string }
        | undefined;
      if (clientInfo?.name !== CLIENT_NAME) {
        return fail(400, 'unexpected clientInfo');
      }
      if (!('io.modelcontextprotocol/clientCapabilities' in meta)) {
        return fail(400, 'missing clientCapabilities');
      }

      const ok = (result: unknown) =>
        Response.json({ jsonrpc: '2.0', id: body.id ?? null, result });

      if (body.method === 'skills/list') {
        return ok({ skills: [SKILL_ENTRY], ttlMs: 0, cacheScope: 'private' });
      }
      if (body.method === 'skills/get') {
        if (params.uri !== SKILL_URI) {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: { code: -32602, message: 'unknown skill' },
          });
        }
        return ok({ skill: SKILL_ENTRY });
      }
      if (body.method === 'resources/read') {
        if (captured.nameHeader !== params.uri) {
          return fail(400, 'MCP-Name header mismatch');
        }
        return ok({ contents: [{ uri: params.uri, mimeType: 'text/markdown', text: SKILL_BODY }] });
      }
      if (body.method === 'tools/call') {
        if (captured.nameHeader !== params.name) {
          return fail(400, 'MCP-Name header mismatch');
        }
        if (params.name === 'network_fail_echo') {
          return ok({
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  code: 'INVALID_ARGUMENT',
                  message: `mock failure ${captured.authorization ?? ''}`,
                  details: {
                    echoed: captured.authorization ?? '',
                    nested: { token: TOKEN },
                    retryable: false,
                  },
                }),
              },
            ],
          });
        }
        if (params.name === 'network_drivefail') {
          const error = {
            code: 'FILE_UNAVAILABLE',
            parameter: 'fileId',
            retryable: false,
          };
          return ok({
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(error) }],
            structuredContent: { error },
          });
        }
        let result: Record<string, unknown>;
        if (params.name === 'network_message_send') {
          result = {
            message: {
              message_id: 'msg_mock',
              created_seq: '42',
              preview: String(params.arguments?.body ?? ''),
            },
            delivery_ids: ['dlv_mock'],
          };
        } else if (params.name === 'network_inbox_list') {
          result = {
            items: [state.inbox === 'claimed' ? CLAIMED_DELIVERY : PENDING_DELIVERY],
            next_cursor: 'cursor_inbox_1',
            has_more: true,
            pending_count: 1,
            claimed_delivery_id: state.inbox === 'claimed' ? 'dlv_mock' : null,
          };
        } else if (params.name === 'network_delivery_claim') {
          result = CLAIMED_DELIVERY;
        } else if (params.name === 'network_delivery_complete') {
          result = { delivery: COMPLETED_DELIVERY, message: REPLY_MESSAGE };
        } else if (params.name === 'network_rooms_list') {
          result = {
            items: [
              {
                room_id: 'rm_mock',
                kind: 'group',
                title: 'Mock Room',
                head_seq: '9',
                my_last_read_seq: '8',
                member_count: 2,
                status: 'active',
                last_message: { preview: 'hello' },
              },
            ],
            next_cursor: 'room_cursor',
            has_more: true,
          };
        } else if (params.name === 'network_history_list') {
          if (params.arguments?.view === 'timeline') {
            result = {
              items: [],
              next_cursor: null,
              has_more: false,
              snapshot: 'snap',
              head_seq: '9',
              view: 'timeline',
              timeline_items: [
                {
                  ...MOCK_MESSAGE,
                  kind: 'message',
                  room_id: 'rm_mock',
                  reply_to: null,
                  root_id: null,
                  task_root_id: null,
                  hop: 0,
                  delivery_states: {},
                  mentions: [],
                  delivery_claimed_at: null,
                  delivery_updated_at: null,
                  timeline_seq: '10',
                },
                {
                  kind: 'presence',
                  presence_event_id: 'pe_mock',
                  room_id: 'rm_mock',
                  agent_id: 'actor_mock',
                  transition: 'online',
                  occurred_at: '2026-11-04T00:00:00.000Z',
                  recorded_at: '2026-11-04T00:00:01.000Z',
                  timeline_seq: '11',
                  time_basis: 'observed',
                },
              ],
              timeline_next_cursor: 'tl_cursor',
              timeline_has_more: true,
              timeline_snapshot: 'tl_snap',
              timeline_resume_cursor: 'tl_cursor',
            };
          } else {
            result = {
              items: [
                {
                  ...MOCK_MESSAGE,
                  sender_kind: 'agent',
                  room_id: 'rm_mock',
                  reply_to: null,
                  root_id: null,
                  task_root_id: null,
                  hop: 0,
                  delivery_states: {},
                  mentions: [],
                  delivery_claimed_at: null,
                  delivery_updated_at: null,
                },
              ],
              next_cursor: 'hist_cursor',
              has_more: true,
              snapshot: 'snap',
              head_seq: '9',
            };
          }
        } else if (params.name === 'network_task_trace') {
          result = {
            root_message_id: 'msg_root',
            items: [
              {
                message_id: 'msg_root',
                sender_id: 'actor_mock',
                sender_name: 'Mock Sender',
                sender_kind: 'agent',
                created_seq: '7',
                created_at: '2026-11-04T00:00:00.000Z',
                preview: 'root task',
                body_bytes: 9,
                recalled: false,
                role: 'root',
                reply_to: null,
                referenced_by: null,
                has_unavailable_reference: false,
              },
            ],
            next_cursor: 'trace_next',
            prev_cursor: 'trace_prev',
            has_more_before: true,
            has_more_after: false,
            message_count: 1,
            focus_message_id: null,
            authorization: {},
          };
        } else if (params.name === 'network_task_search') {
          result = {
            items: [
              {
                task: {
                  root_message_id: 'msg_root',
                  room_id: 'rm_mock',
                  preview: 'root task',
                  root_sender_id: 'actor_mock',
                  root_sender_name: 'Mock Sender',
                  root_sender_kind: 'agent',
                  root_created_at: '2026-11-04T00:00:00.000Z',
                  root_created_seq: '7',
                  participants: [],
                  participant_count: 0,
                  message_count: 1,
                  can_unmark: true,
                },
                hit_count: 1,
                matches: [
                  { message_id: 'msg_mock', snippet: 'hello', created_seq: '42' },
                ],
              },
            ],
            next_cursor: 'search_next',
            has_more: true,
            snapshot: 'snap',
            authorization: {},
            truncated: false,
          };
        } else if (params.name === 'network_message_read') {
          const cursor = params.arguments?.chunk_cursor;
          result =
            cursor === undefined
              ? {
                  message_id: 'msg_mock',
                  room_id: 'rm_mock',
                  chunk: 'Hello ',
                  chunk_cursor: 'c1',
                  next_cursor: 'c1',
                  eof: false,
                  body_bytes: 11,
                  created_seq: '42',
                }
              : {
                  message_id: 'msg_mock',
                  room_id: 'rm_mock',
                  chunk: '世界',
                  chunk_cursor: 'c2',
                  next_cursor: null,
                  eof: true,
                  body_bytes: 11,
                  created_seq: '42',
                };
        } else if (params.name === 'network_message_send_status') {
          const ids = Array.isArray(params.arguments?.client_message_ids)
            ? (params.arguments?.client_message_ids as unknown[]).map(String)
            : [];
          result = {
            items: ids.map((id) =>
              id === 'msg_known'
                ? {
                    client_message_id: id,
                    found: true,
                    message_id: 'msg_mock',
                    room_id: 'rm_mock',
                    created_seq: '42',
                    delivery_ids: ['dlv_mock'],
                    body_bytes: 5,
                    created_at: '2026-11-04T00:00:00.000Z',
                  }
                : {
                    client_message_id: id,
                    found: false,
                    message_id: null,
                    room_id: null,
                    created_seq: null,
                    delivery_ids: [],
                    body_bytes: null,
                    created_at: null,
                  },
            ),
          };
        } else if (params.name === 'network_issue_token') {
          result = {
            token: 'ank_issued_mock',
            url: 'https://example.test/mcp?token=ank_issued_mock',
          };
        } else if (params.name === 'network_register') {
          result = {
            actor_id: 'actor_registered',
            kind: 'agent',
            agent_session_id: 'sess_mock',
            name: 'Mock Agent',
            metadata: {},
            pending_count: 0,
            inbox_head_seq: '0',
            created_at: '2026-11-04T00:00:00.000Z',
            share_url: null,
            resources: [],
          };
        } else {
          result = { echo: params.arguments ?? {} };
        }
        return ok({
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        });
      }
      return Response.json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32601, message: 'method not found' },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls,
    state,
    stop() {
      server.stop(true);
    },
  };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runProcess(
  command: string[],
  options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const proc = Bun.spawn(command, {
    cwd: ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 30_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function runCli(
  baseUrl: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<RunResult> {
  return runProcess([process.execPath, CLI, ...args], {
    env: { AGENTNET_URL: baseUrl, AGENTNET_TOKEN: TOKEN, ...extraEnv },
  });
}

async function fileHash(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await Bun.file(path).bytes()).digest('hex');
}

async function main(): Promise<void> {
  const mock = startMock();
  try {
    const help = await runCli(mock.baseUrl, ['--help']);
    checkEqual('agentnet --help 退出 0', help.code, 0);
    for (const marker of ['skills', 'agentnet', 'monitor', 'login', 'call']) {
      check(`--help 列出 ${marker}`, help.stdout.includes(marker));
    }

    const list = await runCli(mock.baseUrl, ['skills', 'list', '--json']);
    checkEqual('skills list 退出 0', list.code, 0);
    check('skills list 输出不含 token', !list.stdout.includes(TOKEN) && !list.stderr.includes(TOKEN));
    const listed = JSON.parse(list.stdout) as {
      skills?: { frontmatter?: { name?: string } }[];
    };
    checkEqual('skills list 返回 agent-network', listed.skills?.[0]?.frontmatter?.name, 'agent-network');
    const listCall = mock.calls.filter((call) => call.method === 'skills/list').at(-1);
    checkEqual('skills list 使用 MCP-Protocol-Version', listCall?.protocolVersion, PROTOCOL_VERSION);
    checkEqual('skills list 的 MCP-Method 正确', listCall?.methodHeader, 'skills/list');

    const humanList = await runCli(mock.baseUrl, ['skills', 'list']);
    check('skills list 人类输出包含技能名', humanList.stdout.includes('agent-network'));

    const get = await runCli(mock.baseUrl, ['skills', 'get', 'agent-network', '--json']);
    checkEqual('skills get 退出 0', get.code, 0);
    const got = JSON.parse(get.stdout) as { skill?: { uri?: string }; text?: string };
    checkEqual('skills get 解析 name 到 URI', got.skill?.uri, SKILL_URI);
    check('skills get 返回 SKILL.md 正文', got.text === SKILL_BODY);
    const readCall = mock.calls.filter((call) => call.method === 'resources/read').at(-1);
    checkEqual('resources/read 携带 MCP-Name', readCall?.nameHeader, SKILL_URI);

    const send = await runCli(mock.baseUrl, [
      'send',
      '--room',
      'rm_mock',
      '--body',
      'hello 世界',
      '--json',
    ]);
    checkEqual('send 退出 0', send.code, 0);
    const sent = JSON.parse(send.stdout) as { delivery_ids?: string[] };
    checkEqual('send 返回 delivery_ids', sent.delivery_ids?.join(','), 'dlv_mock');
    const sendCall = mock.calls.filter((call) => call.tool === 'network_message_send').at(-1);
    check('send 自动生成 request_id', typeof sendCall?.arguments?.request_id === 'string');
    check('send 自动生成 client_message_id', typeof sendCall?.arguments?.client_message_id === 'string');
    checkEqual('send 透传 room_id', sendCall?.arguments?.room_id, 'rm_mock');
    checkEqual('send 透传正文', sendCall?.arguments?.body, 'hello 世界');
    check('未传 --invoke 时省略 invoke', sendCall?.arguments?.invoke === undefined);
    checkEqual('send 使用 Bearer token', sendCall?.authorization, `Bearer ${TOKEN}`);

    const explicitEmpty = await runCli(mock.baseUrl, [
      'send',
      '--room',
      'rm_mock',
      '--body',
      'noop',
      '--invoke',
      '',
      '--json',
    ]);
    checkEqual('显式空 invoke 退出 0', explicitEmpty.code, 0);
    const emptyInvokeCall = mock.calls
      .filter((call) => call.tool === 'network_message_send')
      .at(-1);
    check(
      '--invoke 空串发送 invoke: []',
      Array.isArray(emptyInvokeCall?.arguments?.invoke) &&
        (emptyInvokeCall?.arguments?.invoke as unknown[]).length === 0,
      emptyInvokeCall?.arguments,
    );

    const inbox = await runCli(mock.baseUrl, ['inbox', '--json']);
    checkEqual('inbox 退出 0', inbox.code, 0);
    const inboxPage = JSON.parse(inbox.stdout) as {
      items?: { delivery_id?: string }[];
      pending_count?: number;
    };
    checkEqual('inbox 返回投递', inboxPage.items?.[0]?.delivery_id, 'dlv_mock');
    checkEqual('inbox 返回 pending_count', inboxPage.pending_count, 1);

    const call = await runCli(mock.baseUrl, ['call', 'network_echo', '{"n":1,"s":"x"}', '--json']);
    checkEqual('call 退出 0', call.code, 0);
    const echoed = JSON.parse(call.stdout) as { echo?: { n?: number; s?: string } };
    checkEqual('call 透传 JSON 参数', echoed.echo?.n, 1);
    checkEqual('call 透传字符串参数', echoed.echo?.s, 'x');

    const failed = await runCli(mock.baseUrl, ['call', 'network_fail_echo', '{}', '--json']);
    check('工具错误退出非 0', failed.code !== 0);
    check(
      '错误输出不含 token',
      !failed.stdout.includes(TOKEN) && !failed.stderr.includes(TOKEN),
      failed.stderr,
    );
    check('错误输出经过脱敏', failed.stderr.includes('[REDACTED]'), failed.stderr);

    const monitor = await runCli(mock.baseUrl, ['monitor', '--harness', 'peri', '--check'], {
      AGENTNET_URL: undefined,
    });
    checkEqual('monitor --check 退出 0', monitor.code, 0);
    check('monitor 定位 peri-watch.sh', monitor.stdout.includes('peri-watch.sh'));
    check('monitor --check 输出不含 token', !monitor.stdout.includes(TOKEN));

    const monitorArgs = await runCli(
      mock.baseUrl,
      ['monitor', '--harness', 'peri', '--check', '--', '--interval', '5'],
      { AGENTNET_URL: undefined },
    );
    checkEqual('monitor 透传参数退出 0', monitorArgs.code, 0);
    check('monitor 透传 -- 后的参数', monitorArgs.stdout.includes('--interval 5'));

    const badHarness = await runCli(mock.baseUrl, ['monitor', '--harness', 'unknown', '--check'], {
      AGENTNET_URL: undefined,
    });
    check('未知 harness 退出非 0', badHarness.code !== 0);
    check('未知 harness 给出可读错误', badHarness.stderr.includes('未知 harness'));

    // ---- 输出契约：分页、timeline、嵌套 delivery ----
    const roomsHuman = await runCli(mock.baseUrl, ['rooms']);
    checkEqual('rooms 人类输出退出 0', roomsHuman.code, 0);
    check(
      'rooms 人类输出 next_cursor/has_more',
      roomsHuman.stdout.includes('next_cursor=room_cursor') &&
        roomsHuman.stdout.includes('has_more=true'),
      roomsHuman.stdout,
    );

    const inboxHuman = await runCli(mock.baseUrl, ['inbox']);
    checkEqual('inbox 人类输出退出 0', inboxHuman.code, 0);
    check('inbox 人类输出 message_id', inboxHuman.stdout.includes('message_id=msg_mock'), inboxHuman.stdout);
    check('inbox 人类输出 claim_id', inboxHuman.stdout.includes('claim_id=-'), inboxHuman.stdout);
    check(
      'inbox 人类输出分页与 claimed_delivery_id',
      inboxHuman.stdout.includes('next_cursor=cursor_inbox_1') &&
        inboxHuman.stdout.includes('has_more=true') &&
        inboxHuman.stdout.includes('claimed_delivery_id=-'),
      inboxHuman.stdout,
    );

    const claimHuman = await runCli(mock.baseUrl, ['claim', 'dlv_mock']);
    checkEqual('claim 人类输出退出 0', claimHuman.code, 0);
    check(
      'claim 输出 message_id/room_id',
      claimHuman.stdout.includes('message_id=msg_mock') &&
        claimHuman.stdout.includes('room_id=rm_mock'),
      claimHuman.stdout,
    );
    check(
      'claim 输出 claim_id/state',
      claimHuman.stdout.includes('claim_id=clm_mock') &&
        claimHuman.stdout.includes('state=claimed'),
      claimHuman.stdout,
    );

    const completeJson = await runCli(mock.baseUrl, [
      'complete',
      'dlv_mock',
      '--attempt',
      '1',
      '--claim-id',
      'clm_mock',
      '--json',
    ]);
    checkEqual('complete 退出 0', completeJson.code, 0);
    const completed = JSON.parse(completeJson.stdout) as {
      delivery?: { delivery_id?: string; state?: string };
      message?: { message_id?: string };
    };
    checkEqual('complete JSON 保留嵌套 delivery', completed.delivery?.delivery_id, 'dlv_mock');
    checkEqual('complete JSON delivery state', completed.delivery?.state, 'completed');
    checkEqual('complete JSON 保留最终 message', completed.message?.message_id, 'msg_reply');

    const completeHuman = await runCli(mock.baseUrl, [
      'complete',
      'dlv_mock',
      '--attempt',
      '1',
      '--claim-id',
      'clm_mock',
    ]);
    check(
      'complete 人类输出读取嵌套 delivery',
      completeHuman.stdout.includes('delivery_id=dlv_mock') &&
        completeHuman.stdout.includes('state=completed') &&
        completeHuman.stdout.includes('attempt=1') &&
        completeHuman.stdout.includes('claim_id=clm_mock'),
      completeHuman.stdout,
    );
    check(
      'complete 人类输出 message_id/final_message_id',
      completeHuman.stdout.includes('message_id=msg_mock') &&
        completeHuman.stdout.includes('final_message_id=msg_reply'),
      completeHuman.stdout,
    );

    const historyHuman = await runCli(mock.baseUrl, ['history', '--room', 'rm_mock']);
    check(
      'history 人类输出分页游标',
      historyHuman.stdout.includes('next_cursor=hist_cursor') &&
        historyHuman.stdout.includes('has_more=true'),
      historyHuman.stdout,
    );
    const timelineHuman = await runCli(mock.baseUrl, [
      'history',
      '--room',
      'rm_mock',
      '--timeline',
    ]);
    check(
      'history --timeline 读取 timeline_items',
      timelineHuman.stdout.includes('TIMELINE') && timelineHuman.stdout.includes('msg_mock'),
      timelineHuman.stdout,
    );
    check(
      'history --timeline 输出上下线系统项',
      timelineHuman.stdout.includes('[presence] online') &&
        timelineHuman.stdout.includes('actor_mock'),
      timelineHuman.stdout,
    );
    check(
      'history --timeline 使用 timeline 游标',
      timelineHuman.stdout.includes('next_cursor=tl_cursor') &&
        timelineHuman.stdout.includes('has_more=true'),
      timelineHuman.stdout,
    );

    const traceHuman = await runCli(mock.baseUrl, [
      'task',
      'trace',
      '--room',
      'rm_mock',
      '--root',
      'msg_root',
    ]);
    check(
      'task trace 输出 next/prev 游标',
      traceHuman.stdout.includes('next_cursor=trace_next') &&
        traceHuman.stdout.includes('prev_cursor=trace_prev') &&
        traceHuman.stdout.includes('has_more_before=true'),
      traceHuman.stdout,
    );
    const searchHuman = await runCli(mock.baseUrl, [
      'task',
      'search',
      '--room',
      'rm_mock',
      '--query',
      'hello',
    ]);
    check(
      'task search 输出分页游标',
      searchHuman.stdout.includes('next_cursor=search_next') &&
        searchHuman.stdout.includes('has_more=true'),
      searchHuman.stdout,
    );

    // ---- 结构化错误、details 与 Drive 兜底 ----
    const failedJson = await runCli(mock.baseUrl, [
      'call',
      'network_fail_echo',
      '{}',
      '--json',
    ]);
    check('--json 错误退出非 0', failedJson.code !== 0);
    const errorPayload = JSON.parse(failedJson.stderr) as {
      error?: {
        code?: string;
        message?: string;
        details?: { echoed?: string; nested?: { token?: string } };
      };
    };
    checkEqual('--json 错误 code 保留', errorPayload.error?.code, 'INVALID_ARGUMENT');
    check(
      '--json 错误 message 脱敏',
      errorPayload.error?.message?.includes('[REDACTED]') === true,
      errorPayload.error?.message,
    );
    checkEqual(
      '--json 错误 details 递归脱敏并保留',
      errorPayload.error?.details?.nested?.token,
      '[REDACTED]',
    );
    checkEqual(
      '--json 错误 details 中的 Bearer 脱敏',
      errorPayload.error?.details?.echoed,
      'Bearer [REDACTED]',
    );
    check(
      '--json 错误输出不含 token',
      !failedJson.stderr.includes(TOKEN) && !failedJson.stdout.includes(TOKEN),
      failedJson.stderr,
    );

    const driveJson = await runCli(mock.baseUrl, [
      'call',
      'network_drivefail',
      '{}',
      '--json',
    ]);
    check('Drive 错误退出非 0', driveJson.code !== 0);
    const driveError = JSON.parse(driveJson.stderr) as {
      error?: { code?: string; message?: string; details?: { parameter?: string } };
    };
    checkEqual('Drive 错误无 message 时用 code 兜底', driveError.error?.message, 'FILE_UNAVAILABLE');
    checkEqual('Drive 错误 code 保留', driveError.error?.code, 'FILE_UNAVAILABLE');
    checkEqual('Drive 错误 details 保留附加字段', driveError.error?.details?.parameter, 'fileId');
    const driveHuman = await runCli(mock.baseUrl, ['call', 'network_drivefail', '{}']);
    check(
      'Drive 错误人类输出 code 兜底',
      driveHuman.stderr.includes('ERROR [FILE_UNAVAILABLE] FILE_UNAVAILABLE'),
      driveHuman.stderr,
    );

    // ---- read / reply / send --claim / send-status ----
    const readFirst = await runCli(mock.baseUrl, ['read', '--message', 'msg_mock']);
    checkEqual('read 退出 0', readFirst.code, 0);
    check('read 人类输出正文块', readFirst.stdout.includes('Hello'), readFirst.stdout);
    check(
      'read 人类输出 eof/next_cursor',
      readFirst.stdout.includes('eof=false') && readFirst.stdout.includes('next_cursor=c1'),
      readFirst.stdout,
    );
    const messageReadCall = mock.calls
      .filter((call) => call.tool === 'network_message_read')
      .at(-1);
    checkEqual('read 透传 message_id', messageReadCall?.arguments?.message_id, 'msg_mock');

    const readSecond = await runCli(mock.baseUrl, [
      'read',
      '--message',
      'msg_mock',
      '--cursor',
      'c1',
    ]);
    checkEqual('read 第二块退出 0', readSecond.code, 0);
    check('read 第二块正文', readSecond.stdout.includes('世界'), readSecond.stdout);
    check(
      'read 到 eof 清空 next_cursor',
      readSecond.stdout.includes('eof=true') && readSecond.stdout.includes('next_cursor=-'),
      readSecond.stdout,
    );
    const readSecondCall = mock.calls
      .filter((call) => call.tool === 'network_message_read')
      .at(-1);
    checkEqual('read 透传 chunk_cursor', readSecondCall?.arguments?.chunk_cursor, 'c1');

    const replyJson = await runCli(mock.baseUrl, [
      'reply',
      '--delivery',
      'dlv_mock',
      '--body',
      '完成 @Bob',
      '--json',
    ]);
    checkEqual('reply pending 退出 0', replyJson.code, 0);
    const replyPayload = JSON.parse(replyJson.stdout) as {
      message?: { message_id?: string };
      delivery?: { state?: string; claim_id?: string };
      request_id?: string;
      client_message_id?: string;
    };
    checkEqual('reply pending 发送 message_id', replyPayload.message?.message_id, 'msg_mock');
    checkEqual('reply pending complete 后状态', replyPayload.delivery?.state, 'completed');
    check(
      'reply 输出 request_id/client_message_id',
      typeof replyPayload.request_id === 'string' &&
        typeof replyPayload.client_message_id === 'string',
      replyPayload,
    );
    const replySend = mock.calls.filter((call) => call.tool === 'network_message_send').at(-1);
    checkEqual(
      'reply send 携带 claim',
      JSON.stringify(replySend?.arguments?.claim),
      JSON.stringify({ delivery_id: 'dlv_mock', attempt: 1, claim_id: 'clm_mock' }),
    );
    check('reply send 不显式派活', replySend?.arguments?.invoke === undefined);
    checkEqual('reply send 正文保留 @', replySend?.arguments?.body, '完成 @Bob');
    const replyComplete = mock.calls
      .filter((call) => call.tool === 'network_delivery_complete')
      .at(-1);
    check('reply complete 不带 final_body', replyComplete?.arguments?.final_body === undefined);
    checkEqual(
      'reply complete 使用现有 claim',
      `${replyComplete?.arguments?.attempt}/${replyComplete?.arguments?.claim_id}`,
      '1/clm_mock',
    );

    mock.state.inbox = 'claimed';
    const claimCountBefore = mock.calls.filter(
      (call) => call.tool === 'network_delivery_claim',
    ).length;
    const replyClaimed = await runCli(mock.baseUrl, [
      'reply',
      '--delivery',
      'dlv_mock',
      '--body',
      'claimed 分支',
      '--json',
    ]);
    checkEqual('reply claimed 退出 0', replyClaimed.code, 0);
    const claimCountAfter = mock.calls.filter(
      (call) => call.tool === 'network_delivery_claim',
    ).length;
    checkEqual('reply claimed 不重复 claim', claimCountAfter, claimCountBefore);
    const claimedSend = mock.calls.filter((call) => call.tool === 'network_message_send').at(-1);
    checkEqual(
      'reply claimed 复用 claim_id/attempt',
      JSON.stringify(claimedSend?.arguments?.claim),
      JSON.stringify({ delivery_id: 'dlv_mock', attempt: 1, claim_id: 'clm_mock' }),
    );
    mock.state.inbox = 'pending';

    const sendClaim = await runCli(mock.baseUrl, [
      'send',
      '--room',
      'rm_mock',
      '--body',
      '回执',
      '--claim',
      'dlv_mock:1:clm_mock',
      '--no-invoke',
      '--mention',
      'actor_human',
      '--json',
    ]);
    checkEqual('send --claim 退出 0', sendClaim.code, 0);
    const sendClaimCall = mock.calls
      .filter((call) => call.tool === 'network_message_send')
      .at(-1);
    checkEqual(
      'send --claim 解析 delivery:attempt:claim_id',
      JSON.stringify(sendClaimCall?.arguments?.claim),
      JSON.stringify({ delivery_id: 'dlv_mock', attempt: 1, claim_id: 'clm_mock' }),
    );
    check(
      'send --no-invoke 发送空 invoke',
      Array.isArray(sendClaimCall?.arguments?.invoke) &&
        (sendClaimCall?.arguments?.invoke as unknown[]).length === 0,
      sendClaimCall?.arguments,
    );
    checkEqual(
      'send --mention 作为 mentions',
      JSON.stringify(sendClaimCall?.arguments?.mentions),
      JSON.stringify(['actor_human']),
    );
    const sendClaimPayload = JSON.parse(sendClaim.stdout) as {
      request_id?: string;
      client_message_id?: string;
    };
    check(
      'send JSON 输出生成的 request_id/client_message_id',
      typeof sendClaimPayload.request_id === 'string' &&
        typeof sendClaimPayload.client_message_id === 'string',
      sendClaimPayload,
    );
    const sendHuman = await runCli(mock.baseUrl, ['send', '--room', 'rm_mock', '--body', 'hello']);
    check(
      'send 人类输出 request_id/client_message_id',
      sendHuman.stdout.includes('request_id=req_') &&
        sendHuman.stdout.includes('client_message_id=msg_'),
      sendHuman.stdout,
    );

    const statusJson = await runCli(mock.baseUrl, [
      'send-status',
      '--client-message-id',
      'msg_known,msg_missing',
      '--json',
    ]);
    checkEqual('send-status 退出 0', statusJson.code, 0);
    const statusPayload = JSON.parse(statusJson.stdout) as {
      items?: { client_message_id?: string; found?: boolean; message_id?: string | null }[];
    };
    checkEqual('send-status 返回两项', statusPayload.items?.length, 2);
    checkEqual('send-status found true', statusPayload.items?.[0]?.found, true);
    checkEqual('send-status found false', statusPayload.items?.[1]?.found, false);
    const statusCall = mock.calls
      .filter((call) => call.tool === 'network_message_send_status')
      .at(-1);
    checkEqual(
      'send-status 按 client_message_id 对账',
      JSON.stringify(statusCall?.arguments?.client_message_ids),
      JSON.stringify(['msg_known', 'msg_missing']),
    );
    const statusHuman = await runCli(mock.baseUrl, ['send', 'status', 'msg_known']);
    checkEqual('send status 别名退出 0', statusHuman.code, 0);
    check('send status 别名输出 found', statusHuman.stdout.includes('found=true'));

    // ---- 首次上线：issue 无 token，register 自动 request_id ----
    const issued = await runCli(mock.baseUrl, ['issue', '--json'], {
      AGENTNET_TOKEN: undefined,
    });
    checkEqual('issue 无 token 退出 0', issued.code, 0);
    const issuedPayload = JSON.parse(issued.stdout) as { token?: string; url?: string };
    checkEqual('issue 返回 token', issuedPayload.token, 'ank_issued_mock');
    checkEqual(
      'issue 返回 MCP URL',
      issuedPayload.url,
      'https://example.test/mcp?token=ank_issued_mock',
    );
    const issueCall = mock.calls.filter((call) => call.tool === 'network_issue_token').at(-1);
    checkEqual('issue 不携带 Authorization', issueCall?.authorization, null);
    const issueHuman = await runCli(mock.baseUrl, ['issue'], { AGENTNET_TOKEN: undefined });
    check(
      'issue 人类输出凭据与安全提示',
      issueHuman.stdout.includes('ank_issued_mock') &&
        issueHuman.stdout.includes('勿发群'),
      issueHuman.stdout,
    );

    const registered = await runCli(mock.baseUrl, [
      'register',
      '--name',
      'Mock Agent',
      '--session',
      'sess_mock',
      '--json',
    ]);
    checkEqual('register 退出 0', registered.code, 0);
    const registeredPayload = JSON.parse(registered.stdout) as {
      actor_id?: string;
      request_id?: string;
    };
    checkEqual('register 返回 actor_id', registeredPayload.actor_id, 'actor_registered');
    const registerCall = mock.calls.filter((call) => call.tool === 'network_register').at(-1);
    check(
      'register 自动生成 request_id',
      typeof registerCall?.arguments?.request_id === 'string' &&
        String(registerCall?.arguments?.request_id).startsWith('req_'),
      registerCall?.arguments,
    );
    checkEqual('register 默认 kind agent', registerCall?.arguments?.kind, 'agent');
    checkEqual(
      'register 透传 agent_session_id',
      registerCall?.arguments?.agent_session_id,
      'sess_mock',
    );

    const version = await runCli(mock.baseUrl, ['--version']);
    checkEqual('CLI 版本与 README 3.0 对齐', version.stdout.trim(), '3.0.0');
    for (const marker of ['issue', 'register', 'read --message', 'reply --delivery', 'send-status']) {
      check(`--help 列出 ${marker}`, help.stdout.includes(marker), help.stdout);
    }

    // 构建产物不入库：先构建，再验收产物与可重复构建。
    const build = await runProcess([process.execPath, 'scripts/build-client.ts'], {
      timeoutMs: 60_000,
    });
    checkEqual('build:client 退出 0', build.code, 0);
    check('构建产物存在', statSync(BUNDLE).isFile());
    check('构建产物可执行', (statSync(BUNDLE).mode & 0o111) !== 0);
    const firstHash = await fileHash(BUNDLE);
    const rebuild = await runProcess([process.execPath, 'scripts/build-client.ts'], {
      timeoutMs: 60_000,
    });
    checkEqual('重复构建退出 0', rebuild.code, 0);
    checkEqual('重复构建输出稳定', await fileHash(BUNDLE), firstHash);
    const bundledHelp = await runProcess([process.execPath, BUNDLE, '--help']);
    checkEqual('打包产物可运行 --help', bundledHelp.code, 0);
    check('打包产物帮助包含 monitor', bundledHelp.stdout.includes('monitor'));
  } finally {
    mock.stop();
  }
  console.log(`\n${checksPassed()} checks passed`);
}

await main();
