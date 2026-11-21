/** CLI 身份防误用轻量测试：临时 env 文件 + 本地 mock，不启动业务服务。 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadEnvFiles } from '../client/env-file';
import { assertExpectedActor } from '../client/expect-actor';
import { check, checkEqual, checksPassed } from './lib/harness';

const directory = mkdtempSync(join(tmpdir(), 'agentnet-cli-identity-'));
const cli = resolve(import.meta.dir, '../client/cli.ts');
const token = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
const calls: string[] = [];
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = await request.json() as {
      id: string; method: string; params?: { name?: string };
    };
    const name = body.params?.name ?? body.method;
    calls.push(name);
    if (body.method === 'subscriptions/listen') {
      let current: ReadableStreamDefaultController<Uint8Array>;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          current = controller;
          streams.add(controller);
          controller.enqueue(new TextEncoder().encode(
            'data: {"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{}}\n\n',
          ));
        },
        cancel() { streams.delete(current); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const data: Record<string, unknown> = name === 'network_me'
      ? { actor_id: 'agt_actual', kind: 'agent' }
      : name === 'network_login'
        ? { pending_count: 0, inbox_head_seq: '0', online: true }
        : { deliveries: [], has_more: false };
    return Response.json({
      jsonrpc: '2.0', id: body.id,
      result: body.method === 'server/discover'
        ? { supportedVersions: ['2026-07-28'] }
        : { structuredContent: data },
    });
  },
});

async function run(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
) {
  const env = { ...process.env };
  // 不继承操作者的身份/服务配置；测试凭据只在内存中随机生成。
  delete env.AGENTNET_TOKEN;
  delete env.AGENTNET_TOKEN_FILE;
  delete env.AGENTNET_URL;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const deadline = setTimeout(() => child.kill(), 10_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    check('输出不包含凭据', !`${stdout}${stderr}`.includes(token));
    return { stdout, stderr, code };
  } finally {
    clearTimeout(deadline);
  }
}

try {
  const envFile = join(directory, 'identity env');
  writeFileSync(envFile, [
    '# 注释', '', 'export FIRST=one # 行尾注释', 'PLAIN = value',
    'DOUBLE="two words # literal" # 注释', "SINGLE='literal $HOME # text'",
    'ESCAPED="a\\nb\\"c"', 'EMPTY=', 'PRESENT=file', 'SET_EMPTY=file',
    'FIRST=ignored', 'invalid line', '1INVALID=value', 'BAD-KEY=value',
    'BROKEN="unclosed', 'TRAIL="ok" junk', 'export NO_EQUALS',
    'LITERAL=$(not-executed)',
  ].join('\r\n'), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { PRESENT: 'explicit', SET_EMPTY: '' };
  const args = loadEnvFiles(['--env-file', envFile, 'monitor', '--json'], env);
  checkEqual('移除分隔形式参数', JSON.stringify(args), '["monitor","--json"]');
  checkEqual('export 与行尾注释', env.FIRST, 'one');
  checkEqual('普通赋值', env.PLAIN, 'value');
  checkEqual('双引号保留空格与 #', env.DOUBLE, 'two words # literal');
  checkEqual('单引号不展开', env.SINGLE, 'literal $HOME # text');
  checkEqual('双引号转义', env.ESCAPED, 'a\nb"c');
  checkEqual('允许空值', env.EMPTY, '');
  checkEqual('显式环境优先', env.PRESENT, 'explicit');
  checkEqual('已设置空串优先', env.SET_EMPTY, '');
  checkEqual('不执行命令替换', env.LITERAL, '$(not-executed)');
  check('非法行被忽略', !['1INVALID', 'BAD-KEY', 'BROKEN', 'TRAIL', 'NO_EQUALS'].some(key => key in env));
  checkEqual('支持等号形式', loadEnvFiles([`--env-file=${envFile}`, 'me'], {}).join(), 'me');
  checkEqual('-- 后不消费选项', loadEnvFiles(['--', '--env-file', envFile], {}).length, 3);

  let identityCalls = 0;
  await assertExpectedActor({ async verifyActor() { identityCalls += 1; return {}; } }, undefined);
  checkEqual('未传 expected 不增加身份请求', identityCalls, 0);

  const endpointFile = join(directory, 'agent.env');
  writeFileSync(endpointFile, `export AGENTNET_URL=${server.url.origin}\nAGENTNET_TOKEN='${token}'\n`, { mode: 0o600 });
  for (const flag of [['--env-file', endpointFile], [`--env-file=${endpointFile}`]]) {
    const result = await run([...flag, 'login', '--expect-actor', 'agt_actual', '--json']);
    checkEqual('env 参数经过真实 commander 入口', result.code, 0);
  }

  // 新版本：宿主环境变量不再是可用凭据来源。
  const noCredential = await run(['--url', server.url.origin, 'me']);
  checkEqual('缺少显式凭据退出 1', noCredential.code, 1);
  check(
    '缺少显式凭据报 credentials_required 且不含 token',
    noCredential.stderr.includes('credentials_required') &&
      noCredential.stderr.includes('--env-file') &&
      !noCredential.stderr.includes(token),
    noCredential.stderr,
  );

  const envOnly = await run(['--url', server.url.origin, 'me'], {
    AGENTNET_TOKEN: token,
  });
  checkEqual('仅环境变量 token 退出 1', envOnly.code, 1);
  check(
    '仅环境变量 token 报 credentials_required',
    envOnly.stderr.includes('credentials_required') && !envOnly.stderr.includes(token),
    envOnly.stderr,
  );

  const noActor = await run([
    '--env-file', endpointFile, 'me',
  ]);
  checkEqual('缺少显式身份退出 1', noActor.code, 1);
  check(
    '缺少显式身份报 actor_required',
    noActor.stderr.includes('actor_required') && noActor.stderr.includes('AGENTNET_EXPECT_ACTOR'),
    noActor.stderr,
  );

  calls.length = 0;
  const explicitToken = await run([
    '--url', server.url.origin, '--token', token, '--expect-actor', 'agt_actual', 'me',
  ]);
  checkEqual('显式 --token + 正确 actor 成功', explicitToken.code, 0);
  check('显式 --token 认证到实际 actor', explicitToken.stdout.includes('agt_actual'), explicitToken.stdout);

  const tokenFile = join(directory, 'explicit token');
  writeFileSync(tokenFile, `${token}\nignored\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  calls.length = 0;
  const explicitTokenFile = await run([
    '--url', server.url.origin, '--token-file', tokenFile, '--expect-actor', 'agt_actual', 'me',
  ]);
  checkEqual('显式 --token-file + 正确 actor 成功', explicitTokenFile.code, 0);
  check(
    '显式 --token-file 不泄露 token',
    !explicitTokenFile.stdout.includes(token) && !explicitTokenFile.stderr.includes(token),
  );

  chmodSync(tokenFile, 0o644);
  const tokenFileBadMode = await run([
    '--url', server.url.origin, '--token-file', tokenFile, '--expect-actor', 'agt_actual', 'me',
  ]);
  checkEqual('--token-file 权限非 600 退出 1', tokenFileBadMode.code, 1);
  check(
    '--token-file 权限错误不泄露 token',
    tokenFileBadMode.stderr.includes('权限必须是 600') &&
      !tokenFileBadMode.stderr.includes(token),
    tokenFileBadMode.stderr,
  );

  chmodSync(endpointFile, 0o644);
  const envFileBadMode = await run([
    '--env-file', endpointFile, '--expect-actor', 'agt_actual', 'me',
  ]);
  checkEqual('--env-file 权限非 600 退出 1', envFileBadMode.code, 1);
  check(
    '--env-file 权限错误只报告路径与 mode',
    envFileBadMode.stderr.includes('permission=644') &&
      envFileBadMode.stderr.includes('required=600') &&
      !envFileBadMode.stderr.includes(token),
    envFileBadMode.stderr,
  );
  chmodSync(endpointFile, 0o600);

  const actorEnvFile = join(directory, 'actor.env');
  writeFileSync(
    actorEnvFile,
    [
      `AGENTNET_URL=${server.url.origin}`,
      `AGENTNET_TOKEN='${token}'`,
      'AGENTNET_EXPECT_ACTOR=agt_actual',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(actorEnvFile, 0o600);
  const actorFromEnvFile = await run(['--env-file', actorEnvFile, 'login']);
  checkEqual('env 文件内 AGENTNET_EXPECT_ACTOR 成功', actorFromEnvFile.code, 0);

  for (const command of [
    ['send', '--room', 'rm_test', '--body', 'hello'],
    ['inbox'],
    ['claim', 'dlv_test'],
    ['call', 'network_rooms_list', '{}'],
    ['me'],
  ]) {
    calls.length = 0;
    const result = await run([
      '--env-file', endpointFile, '--expect-actor', 'agt_expected', ...command,
    ]);
    checkEqual(`${command[0]} 错身份退出 1`, result.code, 1);
    checkEqual(
      `${command[0]} 错身份精确错误输出`,
      result.stderr.trim(),
      'ERROR actor_mismatch expected=agt_expected actual=agt_actual',
    );
    checkEqual(`${command[0]} 错身份不调用业务工具`, calls.join(), 'network_me');
    check(`${command[0]} 错身份不输出 token`, !result.stderr.includes(token));
  }

  const businessTools: Record<string, string> = {
    send: 'network_message_send',
    inbox: 'network_inbox_list',
    claim: 'network_delivery_claim',
    call: 'network_rooms_list',
    me: 'network_me',
  };
  for (const command of [
    ['send', '--room', 'rm_test', '--body', 'hello'],
    ['inbox'],
    ['claim', 'dlv_test'],
    ['call', 'network_rooms_list', '{}'],
    ['me'],
  ]) {
    calls.length = 0;
    const result = await run([
      '--env-file', endpointFile, '--expect-actor', 'agt_actual', ...command,
    ]);
    checkEqual(`${command[0]} 正确身份退出 0`, result.code, 0);
    check(
      `${command[0]} 正确身份先校验再调用业务工具`,
      calls[0] === 'network_me' && calls.includes(businessTools[command[0]!]!),
      calls.join(),
    );
  }

  for (const harness of ['claude', 'peri', 'codex', 'dsh']) {
    calls.length = 0;
    const result = await run(['--env-file', endpointFile, 'monitor', '--harness', harness,
      '--expect-actor', 'agt_expected', '--json', '--no-room-events']);
    checkEqual(`${harness} 错身份退出 1`, result.code, 1);
    checkEqual(`${harness} 精确错误输出`, result.stderr.trim(),
      'ERROR actor_mismatch expected=agt_expected actual=agt_actual');
    checkEqual(`${harness} 不输出 READY/事件`, result.stdout, '');
    checkEqual(`${harness} 不 login/订阅/claim`, calls.join(), 'network_me');
  }
  for (const command of [['login'], ['up', '--harness', 'claude']]) {
    calls.length = 0;
    const result = await run(['--env-file', endpointFile, ...command, '--expect-actor', 'agt_expected']);
    checkEqual(`${command[0]} 错身份退出`, result.code, 1);
    checkEqual(`${command[0]} 错身份不 login`, calls.join(), 'network_me');
  }
  calls.length = 0;
  const matched = await run(['--env-file', endpointFile, 'monitor', '--harness', 'claude',
    '--expect-actor', 'agt_actual', '--json', '--no-room-events', '--max-runtime', '1',
    '--state-dir', join(directory, 'state')]);
  checkEqual('身份匹配正常退出', matched.code, 0);
  check('身份匹配输出实际 READY actor', matched.stdout.split('\n').some(line => {
    if (!line) return false;
    const event = JSON.parse(line);
    return event.type === 'ready' && event.actor === 'agt_actual';
  }));
  check('身份匹配正常订阅与 login', calls.includes('subscriptions/listen') && calls.includes('network_login'));
  check('身份检查先于订阅', calls.indexOf('network_me') < calls.indexOf('subscriptions/listen'));

  for (const path of [join(directory, 'missing'), directory]) {
    const result = await run(['--env-file', path, '--help']);
    checkEqual('不存在/非文件退出 1', result.code, 1);
    checkEqual('env 错误仅输出路径', result.stderr.trim(), `ERROR env_file=${JSON.stringify(path)}`);
    checkEqual('env 错误不继续 commander', result.stdout, '');
  }
  if (process.getuid?.() !== 0) {
    chmodSync(envFile, 0o000);
    const result = await run(['--env-file', envFile, '--help']);
    checkEqual('不可读文件退出 1', result.code, 1);
    checkEqual('不可读文件错误无内容', result.stderr.trim(), `ERROR env_file=${JSON.stringify(envFile)}`);
  }
  const missing = await run(['--env-file']);
  checkEqual('缺少路径退出 1', missing.code, 1);
  console.log(`\nCLI 身份防误用：${checksPassed()} 项通过`);
} finally {
  for (const controller of streams) {
    try { controller.close(); } catch { /* 客户端可能已关闭。 */ }
  }
  await server.stop(true);
  rmSync(directory, { recursive: true, force: true });
}
