/**
 * 极简参数解析：不引入框架，保持 CLI 可在 Bun 单文件打包。
 *
 * 约定：
 * - `--flag value` 与 `--flag=value` 等价；
 * - `--json`、`--help` 等布尔开关不吞下一个参数；
 * - `--` 之后的全部参数原样保留（monitor 透传给宿主脚本）。
 */

export interface CliArgs {
  positionals: string[];
  flags: Record<string, string | true>;
  rest: string[];
}

const BOOLEAN_FLAGS = new Set([
  'json',
  'help',
  'version',
  'timeline',
  'check',
  'dry-run',
]);

export function parseArgs(argv: readonly string[]): CliArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equal = body.indexOf('=');
      if (equal >= 0) {
        flags[body.slice(0, equal)] = body.slice(equal + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && (next === '-' || !next.startsWith('-'))) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new Error(`未知选项：${token}（使用 --help 查看用法）`);
    }
    positionals.push(token);
  }
  return { positionals, flags, rest };
}

export function flagValue(args: CliArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function flagEnabled(args: CliArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}

export function booleanFlag(args: CliArgs, name: string): boolean {
  const value = args.flags[name];
  if (value === undefined) return false;
  if (value === true) return true;
  return value === '1' || value === 'true' || value === 'yes';
}

/** 校验命令允许的选项，避免拼写错误被静默忽略。 */
export function assertKnownFlags(
  args: CliArgs,
  allowed: readonly string[],
  globals: readonly string[] = ['url', 'token', 'json', 'help'],
): void {
  const known = new Set([...allowed, ...globals]);
  for (const name of Object.keys(args.flags)) {
    if (!known.has(name)) {
      throw new Error(`未知选项：--${name}（使用 --help 查看用法）`);
    }
  }
}

export function requireFlag(args: CliArgs, name: string, suggestion?: string): string {
  const value = flagValue(args, name);
  if (value === undefined || value === '') {
    throw new Error(`缺少 --${name}${suggestion ? `（${suggestion}）` : ''}`);
  }
  return value;
}

/** 逗号分隔的 actor_id 列表；空字符串表示显式空数组。 */
export function commaList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function integerFlag(args: CliArgs, name: string, options: { min?: number } = {}): number {
  const raw = requireFlag(args, name);
  if (!/^\d+$/u.test(raw)) throw new Error(`--${name} 必须是非负整数`);
  const value = Number(raw);
  if (options.min !== undefined && value < options.min) {
    throw new Error(`--${name} 不能小于 ${options.min}`);
  }
  return value;
}

export function optionalIntegerFlag(
  args: CliArgs,
  name: string,
  options: { min?: number } = {},
): number | undefined {
  const raw = flagValue(args, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/u.test(raw)) throw new Error(`--${name} 必须是非负整数`);
  const value = Number(raw);
  if (options.min !== undefined && value < options.min) {
    throw new Error(`--${name} 不能小于 ${options.min}`);
  }
  return value;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}
