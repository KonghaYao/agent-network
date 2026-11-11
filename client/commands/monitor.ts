/**
 * `monitor --harness <name>`：宿主监听入口。
 *
 * claude / other / peri 已迁到 `client/monitor/` 的 TypeScript 引擎；codex / dsh
 * 仍执行 public/skills/*-watch.sh（后续迁移），命令形状保持不变。
 * 这里不内嵌 shell 文本，也不为旧脚本生成新的包装。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { CliArgs } from '../args';
import { assertKnownFlags, booleanFlag, flagValue } from '../args';
import { CliError } from '../mcp';
import { line } from '../output';
import { runClaudeMonitor } from '../monitor/claude';
import { runOtherHarness } from '../monitor/other';
import { runPeriMonitor } from '../monitor/peri';

/** 仍由旧脚本承载的 harness；迁移完成后逐个删除。 */
const LEGACY_SCRIPTS: Record<string, string> = {
  codex: 'codex-watch.sh',
  dsh: 'dsh-watch.sh',
};

const TS_HARNESSES = new Set(['claude', 'other', 'peri']);
const SUPPORTED = [...TS_HARNESSES, ...Object.keys(LEGACY_SCRIPTS)];

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

function checkTsHarness(harness: string, args: CliArgs): number {
  if (harness === 'claude') {
    const scriptArgs = args.positionals.slice(1);
    line(`harness=claude engine=ts args=${scriptArgs.join(' ') || '-'}`);
    return 0;
  }
  if (harness === 'peri') {
    line('harness=peri engine=ts auto_claim=1 read_body=0 output=alert stream=agentnet://stream');
    return 0;
  }
  const logPath =
    flagValue(args, 'log') ?? process.env.LOG ?? join(homedir(), '.agentnet', 'watch.log');
  const maxWait = flagValue(args, 'max-wait') ?? process.env.MAX_WAIT ?? '360';
  const poll = flagValue(args, 'poll') ?? process.env.POLL ?? '3';
  line(`harness=other engine=ts log=${logPath} max_wait=${maxWait} poll=${poll}`);
  return 0;
}

async function legacyMonitor(
  harness: string,
  context: MonitorContext,
  args: CliArgs,
): Promise<number> {
  const file = LEGACY_SCRIPTS[harness];
  if (!file) throw new CliError(`未知 harness：${harness}`);
  // positionals[0] 是 monitor；其余作为脚本参数。
  const scriptArgs = [...args.positionals.slice(1), ...args.rest];
  const checkOnly = booleanFlag(args, 'check') || booleanFlag(args, 'dry-run');

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

export async function monitor(context: MonitorContext, args: CliArgs): Promise<number> {
  assertKnownFlags(args, [
    'harness',
    'check',
    'dry-run',
    'url',
    'token',
    'json',
    'help',
    'log',
    'max-wait',
    'poll',
    'state-dir',
  ]);
  const harness = flagValue(args, 'harness');
  if (!harness) {
    throw new CliError(`缺少 --harness（支持：${SUPPORTED.join('|')}）`);
  }
  if (!TS_HARNESSES.has(harness) && !LEGACY_SCRIPTS[harness]) {
    throw new CliError(`未知 harness：${harness}（支持：${SUPPORTED.join('|')}）`);
  }
  const checkOnly = booleanFlag(args, 'check') || booleanFlag(args, 'dry-run');

  if (TS_HARNESSES.has(harness)) {
    const extra = [...args.positionals.slice(1), ...args.rest];
    if (extra.length > 0) {
      throw new CliError(
        `monitor --harness ${harness} 不接受位置参数：${extra.join(' ')}（使用 --log/--max-wait/--poll 等选项）`,
      );
    }
    if (checkOnly) return checkTsHarness(harness, args);
    if (harness === 'claude') return runClaudeMonitor(context, args);
    if (harness === 'peri') return runPeriMonitor(context, args);
    return runOtherHarness(args);
  }
  return legacyMonitor(harness, context, args);
}
