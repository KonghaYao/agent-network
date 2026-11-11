/**
 * 监听器的本地状态目录：seen 去重、event_file 与退出清理。
 *
 * 默认使用与 claude-watch.sh 相同的临时目录模型（每次启动全新、退出删除）；
 * 测试或排查时可指定固定目录并保留，便于观察 event_file。
 */

import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonObject } from './rpc';

export interface MonitorStateOptions {
  directory?: string | undefined;
  keep?: boolean | undefined;
}

function randomTag(): string {
  return `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

export class MonitorState {
  private readonly seen = new Set<string>();

  private constructor(
    readonly directory: string,
    readonly eventDir: string,
    readonly seenPath: string,
    private readonly keep: boolean,
  ) {}

  static async create(options: MonitorStateOptions = {}): Promise<MonitorState> {
    const directory = options.directory
      ? await mkdir(options.directory, { recursive: true, mode: 0o700 }).then(
          () => options.directory as string,
        )
      : await mkdtemp(join(tmpdir(), 'claude-watch.'));

    await chmod(directory, 0o700);
    const eventDir = join(directory, 'events');
    await mkdir(eventDir, { recursive: true, mode: 0o700 });
    await chmod(eventDir, 0o700);
    const seenPath = join(directory, 'seen');

    let existing = '';
    try {
      existing = await readFile(seenPath, 'utf8');
    } catch {
      await writeFile(seenPath, '', { mode: 0o600 });
    }
    await chmod(seenPath, 0o600);

    const state = new MonitorState(directory, eventDir, seenPath, options.keep === true);
    for (const key of existing.split('\n')) {
      if (key.length > 0) state.seen.add(key);
    }
    return state;
  }

  hasSeen(key: string): boolean {
    return this.seen.has(key);
  }

  async markSeen(key: string): Promise<void> {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    try {
      await writeFile(this.seenPath, `${key}\n`, { flag: 'a', mode: 0o600 });
    } catch {
      // 去重仍由内存 Set 保证；seen 文件只是跨重启的辅助记录。
    }
  }

  /** 写入完整正文事件文件；先写临时文件再 rename，避免宿主读到半截 JSON。 */
  async writeEventFile(deliveryId: string, event: JsonObject): Promise<string> {
    const path = join(this.eventDir, `${deliveryId}.json`);
    const temp = join(this.eventDir, `.event-${deliveryId}-${randomTag()}`);
    await writeFile(temp, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
    return path;
  }

  async cleanup(): Promise<void> {
    if (this.keep) return;
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
