/**
 * `agentnet.sh feedback` 的离线 CLI 测试。
 *
 * 使用本机临时 MCP mock，不访问默认生产地址；canary 只在进程内生成，
 * 断言失败不打印 token、正文或完整请求。
 */

import { resolve } from 'node:path';

import { check, checkEqual } from './harness';

const SCRIPT = resolve(import.meta.dir, '../../public/skills/agentnet.sh');

interface CapturedCall {
  method?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  authorization?: string | null;
  clientInfo?: { name?: string; version?: string };
}

function tokenCanary(): string {
  return `ank_${crypto.randomUUID().replaceAll('-', '')}`;
}

function startMock(): {
  url: string;
  calls: CapturedCall[];
  stop(): void;
} {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/mcp') {
        return new Response('not found', { status: 404 });
      }
      const body = (await request.json()) as {
        id?: unknown;
        method?: string;
        params?: {
          name?: string;
          arguments?: Record<string, unknown>;
          _meta?: Record<string, unknown>;
        };
      };
      const params = body.params;
      const clientInfo = params?._meta?.['io.modelcontextprotocol/clientInfo'] as
        | { name?: string; version?: string }
        | undefined;
      calls.push({
        method: body.method,
        tool: params?.name,
        arguments: params?.arguments,
        authorization: request.headers.get('authorization'),
        clientInfo,
      });
      const requestId = String(params?.arguments?.request_id ?? '');
      if (params?.name === 'network_feedback_create' && requestId.startsWith('fail_')) {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            isError: true,
            content: [
              { type: 'text', text: JSON.stringify({ code: 'INVALID_ARGUMENT', message: 'bad' }) },
            ],
          },
        });
      }
      const result = { feedback_id: 'fb_mock', created_at: '1700000000000' };
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop() {
      server.stop(true);
    },
  };
}

async function runCli(
  url: string,
  token: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bash', SCRIPT, ...args], {
    env: { ...process.env, AGENTNET_URL: url, AGENTNET_TOKEN: token },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function runFeedbackCliChecks(): Promise<void> {
  const mock = startMock();
  const token = tokenCanary();
  try {
    const problem = [
      'CLI 反馈测试',
      `AGENTNET_TOKEN=${token}`,
      `URL https://example.test/private?token=${token}`,
      `Authorization: Bearer ${token}`,
    ].join('\n');

    const ok = await runCli(mock.url, token, [
      'feedback',
      '--problem',
      problem,
      '--request-id',
      'req_cli_ok',
    ]);
    checkEqual('CLI feedback 成功退出 0', ok.code, 0);
    check('CLI 成功输出不含 token', !ok.stdout.includes(token) && !ok.stderr.includes(token));
    check('CLI 成功输出不回显正文', !ok.stdout.includes('CLI 反馈测试'));
    const parsed = JSON.parse(ok.stdout) as Record<string, unknown>;
    checkEqual(
      'CLI 成功只输出 feedback_id/created_at',
      Object.keys(parsed).sort().join(','),
      'created_at,feedback_id',
    );
    checkEqual('CLI 解析 feedback_id', parsed.feedback_id, 'fb_mock');

    const call = mock.calls.find((item) => item.tool === 'network_feedback_create');
    if (!call) throw new Error('CLI 未调用 network_feedback_create');
    checkEqual('CLI 调用 tools/call', call.method, 'tools/call');
    checkEqual('CLI 使用 Bearer 认证', call.authorization === `Bearer ${token}`, true);
    checkEqual('CLI clientInfo 名称', call.clientInfo?.name, 'agentnet-cli');
    checkEqual('CLI clientInfo 版本', call.clientInfo?.version, '1.0.0');
    checkEqual('CLI 默认 harness 为 unknown', call.arguments?.harness, 'unknown');
    const sentProblem = String(call.arguments?.problem ?? '');
    check(
      'CLI 移除当前 token、URL 与 Bearer 值',
      !sentProblem.includes(token) &&
        !sentProblem.includes('https://example.test/private') &&
        sentProblem.includes('[REDACTED]') &&
        sentProblem.includes('[REDACTED_URL]'),
    );
    const sentEnvironment = String(call.arguments?.environment ?? '');
    check(
      'CLI 默认环境只含白名单字段',
      sentEnvironment.includes('os=') &&
        sentEnvironment.includes('kernel=') &&
        sentEnvironment.includes('arch=') &&
        sentEnvironment.includes('bash=') &&
        sentEnvironment.includes('cli=1.0.0') &&
        !sentEnvironment.includes(token) &&
        !sentEnvironment.includes(mock.url) &&
        !sentEnvironment.includes(process.cwd()),
    );

    mock.calls.splice(0);
    const explicit = await runCli(mock.url, token, [
      'feedback',
      '--problem',
      '显式环境',
      '--environment',
      'os=Explicit host=NotCollected',
      '--harness',
      'codex',
      '--request-id',
      'req_cli_explicit',
    ]);
    checkEqual('CLI 显式环境成功退出 0', explicit.code, 0);
    const explicitCall = mock.calls.find((item) => item.tool === 'network_feedback_create');
    checkEqual('CLI 显式环境整体覆盖默认采集', explicitCall?.arguments?.environment, 'os=Explicit host=NotCollected');
    checkEqual('CLI 显式 harness 生效', explicitCall?.arguments?.harness, 'codex');

    mock.calls.splice(0);
    const failed = await runCli(mock.url, token, [
      'feedback',
      '--problem',
      '失败时不要回显这段正文',
      '--request-id',
      'fail_cli',
    ]);
    check('CLI 服务端错误返回非零', failed.code !== 0);
    check('CLI 服务端错误显示安全错误码', failed.stderr.includes('INVALID_ARGUMENT'));
    check(
      'CLI 服务端错误不回显正文或 token',
      !failed.stdout.includes('失败时不要回显这段正文') &&
        !failed.stderr.includes('失败时不要回显这段正文') &&
        !failed.stdout.includes(token) &&
        !failed.stderr.includes(token),
    );

    mock.calls.splice(0);
    const missing = await runCli(mock.url, token, ['feedback', '--problem']);
    check('CLI 缺值返回非零', missing.code !== 0);
    check('CLI 缺值只提示选项名', missing.stderr.includes('--problem'));
    checkEqual('CLI 缺值不请求 MCP', mock.calls.length, 0);

    const duplicate = await runCli(mock.url, token, ['feedback', '--problem', 'a', '--problem', 'b']);
    check('CLI 重复选项返回非零', duplicate.code !== 0);
    check('CLI 重复选项提示选项名', duplicate.stderr.includes('--problem'));
    checkEqual('CLI 重复选项不请求 MCP', mock.calls.length, 0);

    const unknown = await runCli(mock.url, token, [
      'feedback',
      '--problem',
      'ok',
      '--not-an-option',
      'super-secret-value',
    ]);
    check('CLI 未知选项返回非零', unknown.code !== 0);
    check('CLI 未知选项不回显参数值', !unknown.stderr.includes('super-secret-value'));
    checkEqual('CLI 未知选项不请求 MCP', mock.calls.length, 0);

    const noProblem = await runCli(mock.url, token, ['feedback', '--harness', 'codex']);
    check('CLI 缺少 --problem 返回非零', noProblem.code !== 0);
    check('CLI 缺少 --problem 有可读错误', noProblem.stderr.includes('--problem'));
    checkEqual('CLI 缺少 --problem 不请求 MCP', mock.calls.length, 0);

    const credentialRequestId = await runCli(mock.url, token, [
      'feedback',
      '--problem',
      'ok',
      '--request-id',
      token,
    ]);
    check('CLI request_id 含当前 token 返回非零', credentialRequestId.code !== 0);
    check(
      'CLI request_id 错误不回显 token',
      !credentialRequestId.stdout.includes(token) && !credentialRequestId.stderr.includes(token),
    );
    checkEqual('CLI request_id 错误不请求 MCP', mock.calls.length, 0);
  } finally {
    mock.stop();
  }
}
