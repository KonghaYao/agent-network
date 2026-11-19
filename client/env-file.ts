/** CLI 专用 env 文件：只解析赋值，不执行 shell、变量展开或命令替换。 */
import { readFileSync, statSync } from 'node:fs';

export class EnvFileError extends Error {
  constructor(path: string) {
    // 只保留路径，不携带底层错误或文件内容；转义换行避免日志注入。
    super(`ERROR env_file=${JSON.stringify(path)}`);
    this.name = 'EnvFileError';
  }
}

export function parseEnvFile(text: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const raw = match[2]!.trim();
    let value: string;
    if (raw.startsWith('"')) {
      const quoted = /^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/u.exec(raw);
      if (!quoted) continue;
      value = quoted[1]!.replace(/\\([\\"nrt])/gu, (_match, char: string) => {
        return ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[char] ?? char;
      });
    } else if (raw.startsWith("'")) {
      const quoted = /^'([^']*)'\s*(?:#.*)?$/u.exec(raw);
      if (!quoted) continue;
      value = quoted[1]!;
    } else {
      value = raw.split('#', 1)[0]!.trim();
      if (/["']/u.test(value)) continue;
    }
    if (!value.includes('\0')) entries.push([key, value]);
  }
  return entries;
}

/** 先加载再交给 commander；已存在（包括空串）的环境变量始终优先。 */
export function loadEnvFiles(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const remaining: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      remaining.push(...argv.slice(index));
      break;
    }
    if (arg !== '--env-file' && !arg.startsWith('--env-file=')) {
      remaining.push(arg);
      continue;
    }
    const path = arg === '--env-file' ? argv[++index] : arg.slice('--env-file='.length);
    if (!path || path.startsWith('--')) throw new EnvFileError('<missing>');
    let text: string;
    try {
      if (!statSync(path).isFile()) throw new EnvFileError(path);
      text = readFileSync(path, 'utf8');
    } catch {
      throw new EnvFileError(path);
    }
    for (const [key, value] of parseEnvFile(text)) env[key] ??= value;
  }
  return remaining;
}
