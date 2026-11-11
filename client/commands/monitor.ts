/**
 * `monitor --harness <name>`：3.0 迁移桥。
 *
 * 本里程碑不重写 4.6k 行宿主监听脚本，只负责解析 harness、定位对应
 * `public/skills/*-watch.sh`（本地仓库或从当前服务下载），并把参数与
 * AGENTNET_URL / AGENTNET_TOKEN 透传过去。后续阶段会把监听循环迁成 TS，
 * 此命令的 CLI 形状保持不变。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { CliError } from '../mcp';
import { line } from '../output';

const HARNESS_SCRIPTS: Record<string, string> = {
  claude: 'claude-watch.sh',
  codex: 'codex-watch.sh',
  peri: 'peri-watch.sh',
  dsh: 'dsh-watch.sh',
  other: 'other-sentinel.sh',
};

function localCandidates(file: string): string[] {
  const fromEnv = process.env.AGENTNET_SKILLS_DIR;
  const roots = [
    ...(fromEnv ? [resolve(fromEnv)] : []),
    resolve(process.cwd(), 'public/skills'),
    resolve(process.cwd(), 'skills'),
    resolve(import.meta.dir, '..', '..', 'public/skills'),
    resolve(import.meta.dir, '..', '..', '..', 'public/skills'),
  ];
  return roots.map((root) => join(root, file));
}

function findLocalScript(file: string): string | null {
  for (const candidate of localCandidates(file)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface MonitorContext {
  baseUrl: string | null;
  token: string | null;
}

async function downloadScript(baseUrl: string, file: string): Promise<string> {
  const url = `${baseUrl}/skills/${file}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new CliError(`无法下载 ${file}：HTTP ${response.status}`);
  }
  const source = await response.text();
  if (source.trim().length === 0) {
    throw new CliError(`下载的 ${file} 为空`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'agentnet-monitor-'));
  const path = join(directory, file);
  await writeFile(path, source, { mode: 0o600 });
  return path;
}

export interface MonitorOptions {
  harness?: string;
  check?: boolean;
  dryRun?: boolean;
}

/**
 * 本地存在脚本时不要求服务地址（脚本自己从环境变量读取）；
 * 远端下载仍然要求 baseUrl。
 */
export async function monitor(
  context: MonitorContext,
  options: MonitorOptions,
  scriptArgs: readonly string[] = [],
): Promise<number> {
  const harness = options.harness;
  if (!harness) {
    throw new CliError(
      `缺少 --harness（支持：${Object.keys(HARNESS_SCRIPTS).join('|')}；运行 agentnet monitor --help 查看示例）`,
    );
  }
  const file = HARNESS_SCRIPTS[harness];
  if (!file) {
    throw new CliError(
      `未知 harness：${harness}（支持：${Object.keys(HARNESS_SCRIPTS).join('|')}；运行 agentnet skills --harness ${harness} 查看说明）`,
    );
  }
  const checkOnly = options.check === true || options.dryRun === true;

  const local = findLocalScript(file);
  let scriptPath = local;
  let source = 'local';
  if (!scriptPath) {
    if (context.baseUrl === null) {
      throw new CliError(
        `本地未找到 ${file}，且缺少服务地址：使用 --url 或设置 AGENTNET_URL 以便从 /skills 下载`,
      );
    }
    if (checkOnly) {
      // 仅校验远端可下载；不落盘、不执行。
      const url = `${context.baseUrl}/skills/${file}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        throw new CliError(`无法下载 ${file}：HTTP ${response.status}`);
      }
      line(`harness=${harness} script=${url} source=remote args=${scriptArgs.join(' ') || '-'}`);
      return 0;
    }
    scriptPath = await downloadScript(context.baseUrl, file);
    source = 'downloaded';
  }

  if (checkOnly) {
    line(
      `harness=${harness} script=${scriptPath} source=${source} args=${
        scriptArgs.join(' ') || '-'
      }`,
    );
    return 0;
  }

  const child = Bun.spawn(['bash', scriptPath, ...scriptArgs], {
    env: {
      ...process.env,
      ...(context.baseUrl ? { AGENTNET_URL: context.baseUrl } : {}),
      ...(context.token ? { AGENTNET_TOKEN: context.token } : {}),
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (source === 'downloaded') {
    await rm(scriptPath, { force: true }).catch(() => undefined);
  }
  return exitCode;
}
