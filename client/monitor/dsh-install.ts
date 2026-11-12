/** Ensure the shipped DSH consumer exists before the DSH monitor starts. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { CliError } from '../mcp';
import { writeAtomicFile } from './atomic';
import { dshPaths } from './dsh-state';
import pluginSource from './dsh-plugin.mjs.txt' with { type: 'text' };

export const DSH_MONITOR_PACKAGE = '@peri-code/dsh-webots-monitor';
export const DSH_MONITOR_PLUGIN_VERSION = '1.0.0';
export const DSH_SUPPORTED_RANGE = '>=0.2.1-rc.5 <0.3.0';

const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_OUTPUT_MAX = 16 * 1024;
const RECORD_BYTES_MAX = 64 * 1024;

interface Binding {
  session_id: string;
  home: string;
}

interface Bindings {
  version: 1;
  bindings: Binding[];
}

interface Target {
  profile: string;
  sessionId: string;
  dshHome: string;
  profileDir: string;
  bindingsFile: string;
  home: string;
}

interface Artifacts {
  packageDir: string;
  digest: string;
  files: ReadonlyArray<readonly [string, string]>;
}

interface BindingPlan {
  bindings: Bindings;
  ownerPath: string;
  owner: string;
}

export interface DshPluginEnsureResult {
  installed: boolean;
  dshVersion: string;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = resolve(path, '..');
    if (parent === path) return path;
    return join(await canonicalPath(parent), basename(path));
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > RECORD_BYTES_MAX) throw new Error('too_large');
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readBindings(path: string): Promise<Bindings> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > RECORD_BYTES_MAX) throw new Error('too_large');
    const value = JSON.parse(text) as Bindings;
    if (
      value.version !== 1 ||
      !Array.isArray(value.bindings) ||
      value.bindings.length > 64 ||
      value.bindings.some(
        (binding) =>
          typeof binding?.session_id !== 'string' || typeof binding?.home !== 'string',
      )
    ) {
      throw new Error('invalid');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, bindings: [] };
    }
    throw new CliError('DSH monitor 绑定文件无效；请修复原文件后重试，不会覆盖已有绑定。');
  }
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENTNET_TOKEN;
  delete env.AGENTNET_URL;
  return env;
}

async function runDsh(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child;
    try {
      child = spawn('dsh', args, {
        env: sanitizedEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch {
      reject(new CliError('未检测到 dsh；请先安装受支持版本并确认 dsh 位于 PATH。'));
      return;
    }
    const append = (current: string, chunk: Buffer | string): string => {
      if (current.length >= COMMAND_OUTPUT_MAX) return current;
      return current + String(chunk).slice(0, COMMAND_OUTPUT_MAX - current.length);
    };
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, COMMAND_TIMEOUT_MS);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.once('error', () =>
      finish(() => reject(new CliError('未检测到 dsh；请先安装受支持版本并确认 dsh 位于 PATH。'))),
    );
    child.once('exit', (code) =>
      finish(() => {
        if (timedOut) {
          reject(new CliError('检测 DSH 超时；请确认 dsh 命令可正常运行。'));
        } else {
          resolvePromise({ code, stdout, stderr });
        }
      }),
    );
  });
}

function parseVersion(text: string): {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
} | null {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\s|$)/u.exec(
    text.trim(),
  );
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * 受支持的 DSH 版本。
 *
 * 基础区间交给 `Bun.semver`；Bun 对 `<0.3.0` 的预发布一律返回 false，
 * 因此 rc 版本再用同一条区间校验核心版本，只允许 `rc.N`：
 * `0.2.1-rc.5` 起、`0.2.2-rc.*` 放行，`0.2.2-beta` 拒绝。
 */
export function isSupportedDshVersion(raw: string): boolean {
  const version = parseVersion(raw);
  if (!version) return false;
  if (Bun.semver.satisfies(version.raw, DSH_SUPPORTED_RANGE)) return true;
  if (version.prerelease === null) return false;
  const rc = /^rc\.(\d+)$/u.exec(version.prerelease);
  if (!rc) return false;
  const core = `${version.major}.${version.minor}.${version.patch}`;
  if (!Bun.semver.satisfies(core, DSH_SUPPORTED_RANGE)) return false;
  return version.patch > 1 || (version.patch === 1 && Number(rc[1]) >= 5);
}

async function detectDshVersion(): Promise<string> {
  const result = await runDsh(['--version']);
  if (result.code !== 0) {
    throw new CliError('无法读取 DSH 版本；请确认 dsh --version 可正常运行。');
  }
  const version = parseVersion(`${result.stdout}\n${result.stderr}`);
  if (!version) throw new CliError('无法识别 DSH 版本输出；请升级到受支持版本。');
  if (!isSupportedDshVersion(version.raw)) {
    throw new CliError(
      `DSH ${version.raw} 不受支持；需要 ${DSH_SUPPORTED_RANGE}，请先升级或切换版本。`,
    );
  }
  return version.raw;
}

function packageListed(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(packageListed);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.name === DSH_MONITOR_PACKAGE) return true;
  return Object.entries(record).some(
    ([key, child]) => key === DSH_MONITOR_PACKAGE || packageListed(child),
  );
}

async function pluginExists(profile: string): Promise<boolean> {
  const result = await runDsh([
    'plugin',
    '--profile',
    profile,
    'list',
    '--depth',
    '0',
    '--json',
  ]);
  if (result.code !== 0) {
    throw new CliError('无法读取 DSH profile 插件列表；不会自动修改该 profile。');
  }
  try {
    return packageListed(JSON.parse(result.stdout));
  } catch {
    throw new CliError('DSH profile 插件列表不是有效 JSON；不会自动修改该 profile。');
  }
}

async function addPlugin(profile: string, packageDir: string): Promise<void> {
  const result = await runDsh([
    'plugin',
    '--profile',
    profile,
    'add',
    `file:${packageDir}`,
  ]);
  if (result.code !== 0) {
    throw new CliError(
      `DSH 插件安装失败（exit=${result.code ?? 'signal'}）；修复 DSH/pnpm 后重试。`,
    );
  }
}

async function target(): Promise<Target> {
  const profile = process.env.DSH_PROFILE;
  const sessionId = process.env.DSH_SESSION_ID;
  if (!profile || !/^[\w-]{1,100}$/u.test(profile)) {
    throw new CliError('启动 DSH monitor 需要有效 DSH_PROFILE；不自动猜测其他 profile。');
  }
  if (!sessionId || !/^[\w.-]{1,200}$/u.test(sessionId)) {
    throw new CliError('启动 DSH monitor 需要有效 DSH_SESSION_ID；不自动选择其他会话。');
  }
  const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
  const profileDir = join(dshHome, 'profiles', profile);
  return {
    profile,
    sessionId,
    dshHome,
    profileDir,
    bindingsFile: join(profileDir, 'webots-monitor.json'),
    home: await canonicalPath(resolve(dshPaths().home)),
  };
}

function artifacts(value: Target): Artifacts {
  const patch = `${JSON.stringify(
    [
      {
        insert: [
          {
            id: 'webots-monitor',
            name: DSH_MONITOR_PACKAGE,
            config: { bindingsFile: value.bindingsFile },
          },
        ],
      },
    ],
    null,
    2,
  )}\n`;
  const manifest = `${JSON.stringify(
    {
      name: DSH_MONITOR_PACKAGE,
      version: DSH_MONITOR_PLUGIN_VERSION,
      type: 'module',
      main: 'index.mjs',
      files: ['index.mjs', 'cordis.patch.yml'],
      engines: { node: '>=24.9.0', dsh: DSH_SUPPORTED_RANGE },
      peerDependencies: { '@deepseek-ai/dsh-llm': DSH_SUPPORTED_RANGE },
      peerDependenciesMeta: { '@deepseek-ai/dsh-llm': { optional: true } },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    },
    null,
    2,
  )}\n`;
  const digest = createHash('sha256')
    .update(manifest)
    .update(patch)
    .update(pluginSource)
    .digest('hex');
  const packageDir = join(value.dshHome, 'webots-monitor', digest.slice(0, 16));
  return {
    packageDir,
    digest,
    files: [
      ['package.json', manifest],
      ['cordis.patch.yml', patch],
      ['index.mjs', pluginSource],
    ],
  };
}

async function preparePackage(value: Artifacts): Promise<void> {
  await mkdir(value.packageDir, { recursive: true, mode: 0o700 });
  for (const [name, content] of value.files) {
    const path = join(value.packageDir, name);
    try {
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await readFile(path, 'utf8')) !== content
      ) {
        throw new CliError('固定插件包校验失败；未覆盖已有文件。');
      }
    }
  }
}

async function planBinding(value: Target): Promise<BindingPlan> {
  const bindings = await readBindings(value.bindingsFile);
  for (const binding of bindings.bindings) {
    if (
      (binding.home === value.home && binding.session_id !== value.sessionId) ||
      (binding.session_id === value.sessionId && binding.home !== value.home)
    ) {
      throw new CliError(
        '已有会话/队列绑定冲突；为其他身份设置独立 WEBBOTS_HOME，勿把同一队列交给多个会话。',
      );
    }
  }
  if (!bindings.bindings.some((binding) => binding.session_id === value.sessionId)) {
    if (bindings.bindings.length >= 64) {
      throw new CliError('该 profile 的 monitor 绑定数量达到 64 上限。');
    }
    bindings.bindings.push({ session_id: value.sessionId, home: value.home });
  }

  const ownerPath = join(value.home, 'consumer-owner.json');
  const owner = `${JSON.stringify({
    bindings_file: value.bindingsFile,
    session_id: value.sessionId,
  })}\n`;
  const existingOwner = await readOptional(ownerPath);
  if (existingOwner !== null && existingOwner !== owner) {
    throw new CliError('该 WEBBOTS_HOME 已绑定其他 profile/会话，请为此身份使用独立目录。');
  }
  return { bindings, ownerPath, owner };
}

async function commitBinding(value: Target, plan: BindingPlan): Promise<void> {
  await mkdir(value.home, { recursive: true, mode: 0o700 });
  await writeAtomicFile(plan.ownerPath, plan.owner);
  await writeAtomicFile(value.bindingsFile, `${JSON.stringify(plan.bindings, null, 2)}\n`);
}

export async function ensureDshMonitorPlugin(): Promise<DshPluginEnsureResult> {
  const value = await target();
  const dshVersion = await detectDshVersion();
  await mkdir(value.profileDir, { recursive: true, mode: 0o700 });
  const lock = join(value.profileDir, '.webots-monitor-install.lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new CliError('该 profile 正在检查/安装 monitor；确认没有并发启动后重试。');
  }
  try {
    const binding = await planBinding(value);
    const present = await pluginExists(value.profile);
    if (!present) {
      const packageFiles = artifacts(value);
      await preparePackage(packageFiles);
      await addPlugin(value.profile, packageFiles.packageDir);
    }
    await commitBinding(value, binding);
    return { installed: !present, dshVersion };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
