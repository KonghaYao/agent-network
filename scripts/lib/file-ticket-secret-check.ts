import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  FILE_TICKET_KEY_FILE,
  resolveFileTicketSecret,
} from '../../src/bun/file-ticket-secret';
import { check, checkEqual } from './harness';

const WORKTREE_ROOT = resolve(import.meta.dir, '../..');
const HEX_SECRET = /^[0-9a-f]{64}$/u;

/**
 * 服务端票据密钥持久化验收：
 * - 同一 DATA_DIR 重复解析稳定，不同 DATA_DIR 互不相同；
 * - 配置值优先且不落盘；
 * - 密钥文件 0600，内容与解析结果一致；
 * - 真实启动/重启复用同一密钥，启动日志不包含密钥。
 */
export async function runFileTicketSecretChecks(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agentnet-ticket-secret-'));
  try {
    const dataDir = join(root, 'data');
    const first = resolveFileTicketSecret({ dataDir });
    const second = resolveFileTicketSecret({ dataDir });
    check('同一 DATA_DIR 两次解析得到同一密钥', first === second);
    check('持久化密钥为 64 位 hex', HEX_SECRET.test(first));

    const keyPath = join(dataDir, FILE_TICKET_KEY_FILE);
    check('密钥写入 DATA_DIR/file-ticket.key', readFileSync(keyPath, 'utf8').trim() === first);
    if (process.platform !== 'win32') {
      checkEqual(
        '密钥文件权限 0600',
        (statSync(keyPath).mode & 0o777).toString(8),
        '600',
      );
    }

    const other = resolveFileTicketSecret({ dataDir: join(root, 'other') });
    check('不同 DATA_DIR 生成不同密钥', other !== first);

    const configuredDir = join(root, 'configured');
    const configured = 'configured-file-ticket-secret';
    checkEqual(
      '配置值优先于持久化密钥',
      resolveFileTicketSecret({ configured, dataDir: configuredDir }),
      configured,
    );
    check('配置值不创建目录、不落盘', !existsSync(configuredDir));

    // 真实启动两次：验证跨重启复用同一密钥，且日志不输出密钥。
    const firstLogs = await runServerOnce(dataDir);
    const persisted = readFileSync(keyPath, 'utf8').trim();
    check('首次启动日志不包含密钥', !firstLogs.includes(persisted));
    const restartLogs = await runServerOnce(dataDir);
    check('重启后密钥文件内容不变', readFileSync(keyPath, 'utf8').trim() === persisted);
    check('重启日志不包含密钥', !restartLogs.includes(persisted));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 启动一个最小实例，等待 /health 后停止，返回合并的 stdout/stderr。 */
async function runServerOnce(dataDir: string): Promise<string> {
  const port = 20200 + Math.floor(Math.random() * 600);
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(['bun', resolve(WORKTREE_ROOT, 'src/bun/main.ts')], {
    cwd: WORKTREE_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PUBLIC_ORIGIN: base,
      ENVIRONMENT: 'test',
      DRIVE_DISABLED: '1',
      EVENTS_ENABLED: '0',
      // 显式清空，避免外部环境影响“未配置”分支。
      FILE_TICKET_SECRET: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const response = await fetch(`${base}/health`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // 服务尚未监听。
      }
      await Bun.sleep(50);
    }
    if (!ready) throw new Error('票据密钥验收实例未在 10s 内就绪');
  } finally {
    proc.kill();
    await proc.exited.catch(() => undefined);
  }
  return `${await stdout}\n${await stderr}`;
}
