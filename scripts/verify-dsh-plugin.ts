/** Isolated CLI install + the exact shipped consumer, without model calls or real credentials. */
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliBuildConfig } from '../src/bun/cli-bundle';
import { check, checkEqual, checksPassed, sleep, waitUntil } from './lib/harness';

const root = resolve(import.meta.dir, '..');
const directory = await mkdtemp(join(tmpdir(), 'webots dsh plugin '));
const dshHome = join(directory, 'dsh home');
const queueHome = join(directory, 'queue home');
const bin = join(directory, 'bin');
const calls = join(directory, 'calls.jsonl');
const bundle = join(directory, 'agentnet.js');
const token = `test-secret-${crypto.randomUUID()}`;
const sessionId = 'session-owner';
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DSH_HOME: dshHome,
  DSH_PROFILE: 'web', DSH_SESSION_ID: sessionId, WEBBOTS_HOME: queueHome,
  AGENTNET_TOKEN: token, AGENTNET_URL: `https://example.invalid/mcp?token=${token}`, DSH_TEST_CALLS: calls };

async function cli(args: string[], extra: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, bundle, 'monitor', '--harness', 'dsh', ...args], {
    cwd: root, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
const event = (id: string) => ({ source: 'delivery.created', attention: 'action_required',
  room_id: 'rm_test', message_id: `msg_${id}`, delivery_id: `dlv_${id}`,
  sender_id: 'sender_test', seq: id, event_id: id, at: new Date().toISOString() });
type Notice = { id: string; source: { kind: string }; content: Array<{ text: string }> };
const notices: Notice[] = [];
const otherNotices: Notice[] = [];
let failNext = false;
const target = { status: 'idle', followup(message: Notice) {
  if (failNext) { failNext = false; throw new Error('temporary host rejection'); }
  notices.push(message); this.status = 'running';
} };
const unrelated = { status: 'idle', followup(message: Notice) { otherNotices.push(message); } };
let dispose: (() => Promise<void>) | undefined;

try {
  await mkdir(bin);
  await writeFile(join(bin, 'dsh'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.DSH_TEST_CALLS, JSON.stringify({ args: process.argv.slice(2), tokenPresent: Boolean(process.env.AGENTNET_TOKEN), urlPresent: Boolean(process.env.AGENTNET_URL) }) + '\\n');
process.exit(process.env.DSH_TEST_INSTALL_FAIL === '1' ? 17 : 0);
`);
  await chmod(join(bin, 'dsh'), 0o755);
  const built = await Bun.build(cliBuildConfig());
  check('包含插件源码的单文件 CLI 构建成功', built.success, built.logs);
  await writeFile(bundle, await built.outputs.find((item) => item.kind === 'entry-point')!.text());
  const dryRun = await cli(['install', '--check']);
  checkEqual('安装预检退出 0', dryRun.code, 0);
  check('预检不写文件也不调用 DSH', !existsSync(dshHome) && !existsSync(calls));
  const missing = await cli(['install'], { DSH_PROFILE: undefined, DSH_SESSION_ID: undefined });
  check('缺少目标会话/profile 时拒绝猜测', missing.code !== 0 && !existsSync(dshHome));
  const unsafeProfile = await cli(['install', '--profile', '../other']);
  check('拒绝 profile 路径穿越', unsafeProfile.code !== 0 && !existsSync(dshHome));
  const installed = await cli(['install']);
  checkEqual('初始化自动安装成功', installed.code, 0);
  const result = JSON.parse(installed.stdout) as { package_dir: string; restart_required: boolean; source_sha256: string };
  check('安装成功明确提示首次重启', result.restart_required);
  const record = JSON.parse((await readFile(calls, 'utf8')).trim()) as { args: string[]; tokenPresent: boolean; urlPresent: boolean };
  checkEqual('调用官方 DSH profile 安装命令', record.args.slice(0, 4).join(' '), 'plugin --profile web add');
  checkEqual('含空格目录作为一个参数传递', record.args[4], `file:${result.package_dir}`);
  check('子进程不接收 WeBots token', !record.tokenPresent);
  check('子进程不接收带凭据的 WeBots URL', !record.urlPresent);
  const bindingsFile = join(dshHome, 'profiles/web/webots-monitor.json');
  const bindingBefore = await readFile(bindingsFile, 'utf8');
  const manifest = JSON.parse(await readFile(join(result.package_dir, 'package.json'), 'utf8'));
  check('包声明可安装 bundle 和兼容性', manifest.dsh.bundle.patch === './cordis.patch.yml' && Boolean(manifest.engines.dsh));
  check('插件没有安装脚本', manifest.scripts === undefined);
  const source = await readFile(join(result.package_dir, 'index.mjs'), 'utf8');
  checkEqual('安装固定源码而非模型生成代码', source, await readFile(join(root, 'client/monitor/dsh-plugin.mjs.txt'), 'utf8'));
  check('产物及绑定不包含凭据', !(source + bindingBefore + JSON.stringify(manifest) + installed.stdout).includes(token));
  const repeated = await cli(['install']);
  checkEqual('重复安装成功', repeated.code, 0);
  checkEqual('重复安装保持内容摘要', JSON.parse(repeated.stdout).source_sha256, result.source_sha256);
  checkEqual('重复安装不新增绑定', await readFile(bindingsFile, 'utf8'), bindingBefore);
  const conflict = await cli(['install', '--session', 'another-session']);
  check('拒绝把同一队列交给另一会话', conflict.code !== 0);
  const crossProfile = await cli(['install', '--profile', 'other-profile']);
  check('拒绝跨 profile 复用同一队列', crossProfile.code !== 0);
  checkEqual('冲突不覆盖绑定', await readFile(bindingsFile, 'utf8'), bindingBefore);
  const failedHome = join(directory, 'failed queue');
  const failed = await cli(['install', '--session', 'failed-session'], {
    WEBBOTS_HOME: failedHome, DSH_TEST_INSTALL_FAIL: '1',
  });
  check('DSH 安装失败返回非零', failed.code !== 0);
  checkEqual('失败不提交绑定', await readFile(bindingsFile, 'utf8'), bindingBefore);
  check('失败不占用队列', !existsSync(join(failedHome, 'consumer-owner.json')));

  // CI uses a shape-compatible message constructor. The same checks can use the
  // actual DSH package by setting DSH_TEST_NODE_MODULES to its isolated install.
  if (process.env.DSH_TEST_NODE_MODULES) {
    await symlink(resolve(process.env.DSH_TEST_NODE_MODULES), join(result.package_dir, 'node_modules'), 'dir');
  } else {
    const mock = join(result.package_dir, 'node_modules/@deepseek-ai/dsh-llm');
    await mkdir(mock, { recursive: true });
    await writeFile(join(mock, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
    await writeFile(join(mock, 'index.js'), 'export const createUserMessage = value => ({ id: crypto.randomUUID(), role: "user", ...value });\n');
  }
  const plugin = await import(pathToFileURL(join(result.package_dir, 'index.mjs')).href);
  const queue = join(queueHome, 'wake.queue');
  await writeFile(queue, JSON.stringify(event('history')) + '\n');
  const agents = new Map<string, typeof target | typeof unrelated>([[sessionId, target], ['unrelated', unrelated]]);
  dispose = plugin.startMonitor({ agents: { get: (id: string) => agents.get(id) } }, { bindingsFile }, 15);
  await waitUntil('初次连接的 catchup 通知', () => notices.length === 1, 3_000, 10);
  check('初次连接提示 inbox 而不重放旧队列', notices[0]!.content[0]!.text.includes('inbox') && !notices[0]!.content[0]!.text.includes('msg_history'));
  check('通知使用带 ID 的宿主消息', Boolean(notices[0]!.id) && notices[0]!.source.kind === 'webots-monitor');
  target.status = 'idle';
  const full = JSON.stringify({ ...event('one'), body: 'DO_NOT_FORWARD_BODY', token });
  await appendFile(queue, full.slice(0, 25));
  await sleep(60);
  checkEqual('不消费半行', notices.length, 1);
  await appendFile(queue, full.slice(25) + '\n');
  await waitUntil('完整行唤醒', () => notices.length === 2, 3_000, 10);
  check('只传定位字段，不转发额外正文/凭据', !JSON.stringify(notices).includes(token) && !JSON.stringify(notices).includes('DO_NOT_FORWARD_BODY'));
  await appendFile(queue, full + '\n' + JSON.stringify(event('two')) + '\n');
  await sleep(60);
  checkEqual('忙时不堆积 followup', notices.length, 2);
  target.status = 'idle';
  await waitUntil('空闲时消费持久队列', () => notices.length === 3, 3_000, 10);
  check('重复事件不再次通知', !notices[2]!.content[0]!.text.includes('msg_one') && notices[2]!.content[0]!.text.includes('msg_two'));
  failNext = true;
  target.status = 'idle';
  await appendFile(queue, JSON.stringify(event('retry')) + '\n');
  await waitUntil('宿主暂时拒绝后重试同一批次', () => notices.length === 4, 3_000, 10);
  check('失败后批次仍保留', notices[3]!.content[0]!.text.includes('msg_retry'));
  target.status = 'idle';
  await writeFile(queue, JSON.stringify(event('truncate')) + '\n');
  await waitUntil('截断后继续消费', () => notices.length === 5, 3_000, 10);
  target.status = 'idle';
  await rename(queue, `${queue}.old`);
  await writeFile(queue, JSON.stringify(event('one')) + '\n' + JSON.stringify(event('rotate')) + '\n');
  await waitUntil('轮转后继续消费', () => notices.length === 6, 3_000, 10);
  check('轮转后仍去重', !notices[5]!.content[0]!.text.includes('msg_one'));
  target.status = 'idle';
  await appendFile(queue, 'x'.repeat(150_000) + '\nnot json\n' + JSON.stringify(event('after_large')) + '\n');
  await waitUntil('跳过超长和损坏行后恢复', () => notices.length === 7, 3_000, 10);
  check('超长输入不进入上下文', notices[6]!.content[0]!.text.length < 2_000);
  checkEqual('不唤醒其他会话', otherNotices.length, 0);
  const health = JSON.parse(await readFile(join(queueHome, 'consumer.json'), 'utf8'));
  checkEqual('消费者状态绑定确切 session', health.session_id, sessionId);
  const status = await cli(['status']);
  checkEqual('status 区分消费者已连接', JSON.parse(status.stdout).consumer.state, 'attached');
  checkEqual('其他会话不能把心跳当作自己的接入', JSON.parse((await cli(['status'], { DSH_SESSION_ID: 'wrong-session' })).stdout).consumer.state, 'session_mismatch');
  await dispose!(); dispose = undefined;
  target.status = 'idle';
  await appendFile(queue, JSON.stringify(event('after_dispose')) + '\n');
  await sleep(60);
  checkEqual('卸载后没有新通知', notices.length, 7);
  await writeFile(join(queueHome, 'consumer.json'), JSON.stringify({ ...health, updated_at: '2000-01-01T00:00:00Z' }));
  checkEqual('过期心跳不误报接入', JSON.parse((await cli(['status'])).stdout).consumer.state, 'stale');
  const cleanups: Array<() => Promise<void>> = [];
  plugin.apply({ agents: { get: () => undefined }, effect: (fn: () => () => Promise<void>) => cleanups.push(fn()) }, { bindingsFile });
  checkEqual('通过 ctx.effect 注册清理', cleanups.length, 1);
  await cleanups[0]!();
  console.log(`DSH plugin acceptance: ${checksPassed()} checks passed`);
} finally {
  await dispose?.();
  await rm(directory, { recursive: true, force: true });
}
