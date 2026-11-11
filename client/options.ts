/**
 * 命令选项的取值校验。
 *
 * argv 解析、全局选项、子命令与帮助全部交给 commander；这里只做业务层校验，
 * 让每个命令用同一套错误文案，并把缺参数提示指回对应示例。
 */

import { CliError } from './mcp';

export interface GlobalOptions {
  url?: string;
  token?: string;
  json?: boolean;
}

interface ValueHint {
  suggestion?: string;
  command?: string;
}

function helpHint(command: string | undefined): string {
  return command ? `；运行 agentnet ${command} --help 查看示例` : '；运行 agentnet --help 查看示例';
}

export function required(
  value: string | undefined,
  flag: string,
  hint: ValueHint = {},
): string {
  if (value === undefined || value === '') {
    throw new CliError(
      `缺少 --${flag}${hint.suggestion ? `（${hint.suggestion}）` : ''}${helpHint(hint.command)}`,
    );
  }
  return value;
}

export function integer(
  value: string | undefined,
  flag: string,
  hint: ValueHint & { min?: number } = {},
): number {
  const raw = required(value, flag, hint);
  if (!/^\d+$/u.test(raw)) {
    throw new CliError(`--${flag} 必须是非负整数${helpHint(hint.command)}`);
  }
  const parsed = Number(raw);
  if (hint.min !== undefined && parsed < hint.min) {
    throw new CliError(`--${flag} 不能小于 ${hint.min}${helpHint(hint.command)}`);
  }
  return parsed;
}

export function optionalInteger(
  value: string | undefined,
  flag: string,
  hint: ValueHint & { min?: number } = {},
): number | undefined {
  if (value === undefined) return undefined;
  return integer(value, flag, hint);
}

/** 逗号分隔列表；空字符串表示显式空数组（`--invoke ""`）。 */
export function commaList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}
