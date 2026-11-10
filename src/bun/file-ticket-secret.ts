import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 下载票据密钥的启动解析。
 *
 * 生产未显式配置 `FILE_TICKET_SECRET` 时，密钥必须跨进程重启保持稳定：
 * 首次启动生成 32 字节随机密钥写入 `DATA_DIR/file-ticket.key`（0600），
 * 之后重启读取同一文件。配置值优先，且不落盘。
 *
 * 并发首启使用“临时文件 + 硬链接”原子创建：目标文件只会出现完整内容，
 * 先创建者获胜，后启动的实例读取磁盘上的同一密钥，不会各自持有不同密钥。
 * 若目录不可写则抛错，由启动流程明确失败，不静默退回进程级随机密钥。
 */
export const FILE_TICKET_KEY_FILE = 'file-ticket.key';

const SECRET_BYTES = 32;
const SECRET_PATTERN = /^[0-9a-f]{64}$/u;

export interface FileTicketSecretOptions {
  /** 部署方显式配置的 `FILE_TICKET_SECRET`。 */
  configured?: string;
  /** 已解析的 `DATA_DIR`。 */
  dataDir: string;
}

export function resolveFileTicketSecret(options: FileTicketSecretOptions): string {
  const configured = options.configured?.trim();
  if (configured) return configured;

  const directory = resolve(options.dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, FILE_TICKET_KEY_FILE);
  const existing = readSecret(keyPath);
  if (existing) return existing;

  const secret = randomBytes(SECRET_BYTES).toString('hex');
  writeSecret(directory, keyPath, secret);
  // 并发首启时目标可能已被其他实例创建：一律以磁盘内容为准。
  return readSecret(keyPath) ?? secret;
}

function readSecret(keyPath: string): string | null {
  let value: string;
  try {
    value = readFileSync(keyPath, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`file ticket key is unreadable: ${keyPath}`, { cause: error });
  }
  if (!SECRET_PATTERN.test(value)) {
    throw new Error(`file ticket key is invalid: ${keyPath}`);
  }
  return value;
}

function writeSecret(directory: string, keyPath: string, secret: string): void {
  const tempPath = join(
    directory,
    `.${FILE_TICKET_KEY_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(tempPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(tempPath, 0o600);
    try {
      // 硬链接原子创建目标：已存在时 EEXIST，保留先创建者的密钥。
      linkSync(tempPath, keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件已不存在时忽略。
    }
  }
}
