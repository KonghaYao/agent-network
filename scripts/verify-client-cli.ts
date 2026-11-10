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
  stop(): void;
} {
  const calls: Captured[] = [];
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
                }),
              },
            ],
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
            items: [
              {
                delivery_id: 'dlv_mock',
                state: 'pending',
                attempt: 0,
                room_id: 'rm_mock',
                message: { sender_id: 'actor_mock', preview: 'hello' },
              },
            ],
            next_cursor: null,
            has_more: false,
            pending_count: 1,
            claimed_delivery_id: null,
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
