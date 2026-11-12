/** Isolated DSH auto-install + the exact shipped consumer, without model calls or real credentials. */
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliBuildConfig } from '../src/bun/cli-bundle';
import { isSupportedDshVersion } from '../client/monitor/dsh-install';
import { check, checkEqual, checksPassed, sleep, waitUntil } from './lib/harness';

const root = resolve(import.meta.dir, '..');
const directory = await mkdtemp(join(tmpdir(), 'webots dsh plugin '));
const dshHome = join(directory, 'dsh home');
const queueHome = join(directory, 'queue home');
const bin = join(directory, 'bin');
const calls = join(directory, 'calls.jsonl');
const pluginState = join(directory, 'plugin-state');
const bundle = join(directory, 'agentnet.js');
const token = `test-secret-${crypto.randomUUID()}`;
const sessionId = 'session-owner';
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DSH_HOME: dshHome,
  DSH_PROFILE: 'web', DSH_SESSION_ID: sessionId, WEBBOTS_HOME: queueHome,
  AGENTNET_TOKEN: token, AGENTNET_URL: `https://example.invalid/mcp?token=${token}`,
  DSH_TEST_CALLS: calls, DSH_TEST_PLUGIN_STATE: pluginState, DSH_TEST_VERSION: '0.2.2-rc.1' };

async function cli(args: string[], extra: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, bundle, 'monitor', '--harness', 'dsh', ...args], {
    cwd: root, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
type DshCall = { args: string[]; tokenPresent: boolean; urlPresent: boolean };
async function dshCalls(): Promise<DshCall[]> {
  try {
    return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as DshCall);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
const addCalls = (items: DshCall[]): DshCall[] =>
  items.filter((item) => item.args[0] === 'plugin' && item.args.includes('add'));

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
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.DSH_TEST_CALLS, JSON.stringify({ args, tokenPresent: Boolean(process.env.AGENTNET_TOKEN), urlPresent: Boolean(process.env.AGENTNET_URL) }) + '\\n');
if (args[0] === '--version') {
  process.stdout.write((process.env.DSH_TEST_VERSION || '0.2.2-rc.1') + '\\n');
  process.exit(0);
}
if (args.includes('list')) {
  const dependencies = existsSync(process.env.DSH_TEST_PLUGIN_STATE)
    ? { '@peri-code/dsh-webots-monitor': { version: 'link:test-package' } }
    : {};
  process.stdout.write(JSON.stringify([{ name: 'dsh-profile-test', dependencies }]) + '\\n');
  process.exit(0);
}
if (args.includes('add')) {
  if (process.env.DSH_TEST_INSTALL_FAIL === '1') process.exit(17);
  writeFileSync(process.env.DSH_TEST_PLUGIN_STATE, 'installed\\n');
  process.exit(0);
}
process.exit(2);
`);
  await chmod(join(bin, 'dsh'), 0o755);
  const built = await Bun.build(cliBuildConfig());
  check('包含插件源码的单文件 CLI 构建成功', built.success, built.logs);
  await writeFile(bundle, await built.outputs.find((item) => item.kind === 'entry-point')!.text());
  const checkOnly = await cli(['--check-config']);
  checkEqual('静态预检退出 0', checkOnly.code, 0);
  check('静态预检不检测或安装插件', !existsSync(dshHome) && !existsSync(calls));
  check('semver 接受 0.2.1-rc.5', isSupportedDshVersion('0.2.1-rc.5'));
  check('semver 拒绝 0.2.2-beta', !isSupportedDshVersion('0.2.2-beta'));
  check('semver 接受 0.2.2-rc.1', isSupportedDshVersion('0.2.2-rc.1'));
  check('semver 拒绝 0.3.0', !isSupportedDshVersion('0.3.0'));
  check('semver 拒绝 0.1.5-rc.2', !isSupportedDshVersion('0.1.5-rc.2'));
  const removedInstallCommand = await cli(['install']);
  check('不再暴露单独 install 子命令', removedInstallCommand.code !== 0 && !existsSync(calls));
  const missing = await cli(['start'], { DSH_PROFILE: undefined, DSH_SESSION_ID: undefined });
  check('启动缺少当前 profile/session 时拒绝猜测', missing.code !== 0 && !existsSync(dshHome));
  const unsupported = await cli(['start'], { DSH_TEST_VERSION: '0.1.5-rc.2' });
  check('启动自动检测并拒绝不兼容 DSH 版本', unsupported.code !== 0 && !existsSync(dshHome));

  const started = await cli(['start']);
  check('首次启动 monitor 路径执行插件自检', started.stderr.includes('DSH_PLUGIN status=installed'), started);
  check('插件缺失时自动添加', started.stderr.includes('DSH_PLUGIN status=installed'));
  check('启动时自动检测输出 DSH 版本', started.stderr.includes('dsh_version=0.2.2-rc.1'));
  let records = await dshCalls();
  let installs = addCalls(records);
  checkEqual('缺失插件只调用一次官方 DSH add', installs.length, 1);
  const record = installs[0]!;
  checkEqual('调用官方 DSH profile 安装命令', record.args.slice(0, 4).join(' '), 'plugin --profile web add');
  const packageArgument = record.args[4] ?? '';
  check('含空格目录作为一个参数传递', packageArgument.startsWith('file:'));
  const packageDir = packageArgument.slice('file:'.length);
  check('所有 DSH 探测/安装子进程都不接收 WeBots token', records.every((item) => !item.tokenPresent));
  check('所有 DSH 探测/安装子进程都不接收带凭据 URL', records.every((item) => !item.urlPresent));

  const bindingsFile = join(dshHome, 'profiles/web/webots-monitor.json');
  const bindingBefore = await readFile(bindingsFile, 'utf8');
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  check('包声明可安装 bundle 和兼容性', manifest.dsh.bundle.patch === './cordis.patch.yml' && Boolean(manifest.engines.dsh));
  check('插件没有安装脚本', manifest.scripts === undefined);
  const source = await readFile(join(packageDir, 'index.mjs'), 'utf8');
  checkEqual('安装固定源码而非模型生成代码', source, await readFile(join(root, 'client/monitor/dsh-plugin.mjs.txt'), 'utf8'));
  check('产物及绑定不包含凭据', !(source + bindingBefore + JSON.stringify(manifest) + started.stdout + started.stderr).includes(token));

  const repeated = await cli(['start']);
  check('插件已存在时启动路径报告 present', repeated.stderr.includes('DSH_PLUGIN status=present'), repeated);
  checkEqual('已存在时不重复安装', addCalls(await dshCalls()).length, 1);
  checkEqual('已存在时不新增绑定', await readFile(bindingsFile, 'utf8'), bindingBefore);

  // 模拟崩溃遗留的安装锁：mtime 超过 stale 窗口后应恢复，而不是永久锁死 profile。
  const staleLock = join(dshHome, 'profiles/web.lock');
  await mkdir(staleLock, { recursive: true });
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(staleLock, old, old);
  const staleRecovered = await cli(['start']);
  check(
    '崩溃遗留锁在 stale 后恢复',
    staleRecovered.stderr.includes('DSH_PLUGIN status=present') &&
      !staleRecovered.stderr.includes('正在检查/安装'),
    staleRecovered,
  );

  await rm(pluginState, { force: true });
  const repaired = await cli(['start']);
  check('插件记录缺失时启动路径自动补装', repaired.stderr.includes('DSH_PLUGIN status=installed'), repaired);
  checkEqual('缺失后只增加一次安装', addCalls(await dshCalls()).length, 2);

  const conflict = await cli(['start'], { DSH_SESSION_ID: 'another-session' });
  check('拒绝把同一队列交给另一会话', conflict.code !== 0);
  const crossProfile = await cli(['start'], { DSH_PROFILE: 'other-profile' });
  check('拒绝跨 profile 复用同一队列', crossProfile.code !== 0);
  checkEqual('冲突不覆盖绑定', await readFile(bindingsFile, 'utf8'), bindingBefore);

  const failedHome = join(directory, 'failed queue');
  const failedDshHome = join(directory, 'failed dsh');
  const failedState = join(directory, 'failed plugin-state');
  const failed = await cli(['start'], {
    WEBBOTS_HOME: failedHome,
    DSH_HOME: failedDshHome,
    DSH_PROFILE: 'failed',
    DSH_SESSION_ID: 'failed-session',
    DSH_TEST_PLUGIN_STATE: failedState,
    DSH_TEST_INSTALL_FAIL: '1',
  });
  check('DSH 自动安装失败返回非零', failed.code !== 0);
  check('失败不提交绑定', !existsSync(join(failedDshHome, 'profiles/failed/webots-monitor.json')));
  check('失败不占用队列', !existsSync(join(failedHome, 'consumer-owner.json')));

  records = await dshCalls();
  installs = addCalls(records);
  check('版本检测发生在每次 monitor 启动前', records.filter((item) => item.args[0] === '--version').length >= 3);
  check('自动安装只在插件缺失时发生', installs.length >= 3);

  // CI uses a shape-compatible message constructor. The same checks can use the
  // actual DSH package by setting DSH_TEST_NODE_MODULES to its isolated install.
  if (process.env.DSH_TEST_NODE_MODULES) {
    await symlink(resolve(process.env.DSH_TEST_NODE_MODULES), join(packageDir, 'node_modules'), 'dir');
  } else {
    const mock = join(packageDir, 'node_modules/@deepseek-ai/dsh-llm');
    await mkdir(mock, { recursive: true });
    await writeFile(join(mock, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
    await writeFile(join(mock, 'index.js'), 'export const createUserMessage = value => ({ id: crypto.randomUUID(), role: "user", ...value });\n');
  }
  const plugin = await import(pathToFileURL(join(packageDir, 'index.mjs')).href);
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
