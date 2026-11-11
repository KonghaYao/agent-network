/** Install the shipped consumer through DSH's official profile package manager. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import pluginSource from './dsh-plugin.mjs.txt' with { type: 'text' };
import { CliError } from '../mcp';
import { dshPaths } from './dsh-state';

export const DSH_MONITOR_PACKAGE = '@peri-code/dsh-webots-monitor';
interface Binding { session_id: string; home: string }
interface Bindings { version: 1; bindings: Binding[] }
export interface DshInstallOptions { profile?: string; session?: string; check?: boolean }

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = resolve(path, '..');
    if (parent === path) return path;
    return join(await canonicalPath(parent), basename(path));
  }
}

async function readBindings(path: string): Promise<Bindings> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > 64 * 1024) throw new Error('too_large');
    const value = JSON.parse(text) as Bindings;
    if (value.version !== 1 || !Array.isArray(value.bindings) || value.bindings.length > 64 ||
        value.bindings.some((binding) => typeof binding?.session_id !== 'string' || typeof binding?.home !== 'string')) throw new Error('invalid');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, bindings: [] };
    throw new CliError('DSH monitor 绑定文件无效；请修复原文件后重试，不会覆盖已有绑定。');
  }
}

async function runDsh(profile: string, packageDir: string): Promise<void> {
  const env = { ...process.env };
  delete env.AGENTNET_TOKEN;
  delete env.AGENTNET_URL;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('dsh', ['plugin', '--profile', profile, 'add', `file:${packageDir}`], {
      env, stdio: ['ignore', 2, 2], shell: false,
    });
    child.once('error', () => reject(new CliError('无法启动 dsh；请先安装 DSH 和 pnpm，并确认它们位于 PATH。')));
    child.once('exit', (code) => code === 0 ? resolvePromise()
      : reject(new CliError(`DSH 插件安装失败（exit=${code ?? 'signal'}），未修改会话绑定；修复 DSH/pnpm 后重试。`)));
  });
}

export async function installDshMonitor(options: DshInstallOptions): Promise<void> {
  const profile = options.profile ?? process.env.DSH_PROFILE;
  const sessionId = options.session ?? process.env.DSH_SESSION_ID;
  if (!profile || !/^[\w-]{1,100}$/.test(profile)) throw new CliError('安装需要有效 --profile <name> 或 DSH_PROFILE；不自动猜测目标 profile。');
  if (!sessionId || !/^[\w.-]{1,200}$/.test(sessionId)) throw new CliError('安装需要 --session <当前 DSH session-id> 或 DSH_SESSION_ID；不自动选择其他会话。');
  const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
  const profileDir = join(dshHome, 'profiles', profile);
  const bindingsFile = join(profileDir, 'webots-monitor.json');
  const home = await canonicalPath(resolve(dshPaths().home));
  const patch = JSON.stringify([{ insert: [{ id: 'webots-monitor', name: DSH_MONITOR_PACKAGE,
    config: { bindingsFile } }] }], null, 2) + '\n';
  const manifest = JSON.stringify({ name: DSH_MONITOR_PACKAGE, version: '1.0.0', type: 'module',
    main: 'index.mjs', files: ['index.mjs', 'cordis.patch.yml'],
    engines: { node: '>=24.9.0', dsh: '>=0.2.1-rc.5 <0.3.0' },
    peerDependencies: { '@deepseek-ai/dsh-llm': '>=0.2.1-rc.5 <0.3.0' },
    peerDependenciesMeta: { '@deepseek-ai/dsh-llm': { optional: true } },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n';
  const digest = createHash('sha256').update(manifest).update(patch).update(pluginSource).digest('hex');
  const packageDir = join(dshHome, 'webots-monitor', digest.slice(0, 16));
  const output = { status: options.check ? 'checked' : 'installed', package: DSH_MONITOR_PACKAGE,
    profile, session_id: sessionId, home, package_dir: packageDir, source_sha256: digest,
    restart_required: !options.check,
    next: '首次安装或升级后重启该 DSH profile 并恢复同一会话，再运行 agentnet monitor --harness dsh start；status 中 consumer.state=attached 才表示消费者已连接。',
  };
  if (options.check) { process.stdout.write(JSON.stringify(output) + '\n'); return; }

  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const lock = join(profileDir, '.webots-monitor-install.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new CliError('该 profile 正在安装 monitor，或上次安装异常留下锁；确认没有安装进程后再重试。'); }
  const temporary = `${bindingsFile}.${randomUUID()}.tmp`;
  const ownerPath = join(home, 'consumer-owner.json');
  const ownerLock = join(home, '.consumer-install.lock');
  let ownerLocked = false;
  try {
    const bindings = await readBindings(bindingsFile);
    for (const binding of bindings.bindings) {
      if ((binding.home === home && binding.session_id !== sessionId) ||
          (binding.session_id === sessionId && binding.home !== home)) {
        throw new CliError('已有会话/队列绑定冲突；为其他身份设置独立 WEBBOTS_HOME，勿把同一队列交给多个会话。');
      }
    }
    if (!bindings.bindings.some((binding) => binding.session_id === sessionId)) {
      if (bindings.bindings.length >= 64) throw new CliError('该 profile 的 monitor 绑定数量达到 64 上限。');
      bindings.bindings.push({ session_id: sessionId, home });
    }
    await mkdir(home, { recursive: true, mode: 0o700 });
    try { await mkdir(ownerLock, { mode: 0o700 }); ownerLocked = true; }
    catch { throw new CliError('该 wake.queue 正在绑定消费者；确认没有并发安装后重试。'); }
    const owner = JSON.stringify({ bindings_file: bindingsFile, session_id: sessionId }) + '\n';
    try {
      if (await readFile(ownerPath, 'utf8') !== owner) throw new CliError('该 WEBBOTS_HOME 已绑定其他 profile/会话，请为此身份使用独立目录。');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(packageDir, { recursive: true, mode: 0o700 });
    for (const [name, content] of [['package.json', manifest], ['cordis.patch.yml', patch], ['index.mjs', pluginSource]]) {
      const path = join(packageDir, name!);
      try { await writeFile(path, content!, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(path, 'utf8') !== content) {
          throw new CliError('固定插件包校验失败；未覆盖已有文件。');
        }
      }
    }
    await runDsh(profile, packageDir);
    await writeFile(ownerPath, owner, { mode: 0o600 });
    await writeFile(temporary, JSON.stringify(bindings, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, bindingsFile);
    process.stdout.write(JSON.stringify(output) + '\n');
  } finally {
    await rm(temporary, { force: true });
    if (ownerLocked) await rm(ownerLock, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
