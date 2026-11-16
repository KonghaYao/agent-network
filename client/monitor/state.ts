/**
 * 监听器的本地状态目录：seen 去重、event_file、房间游标与退出清理。
 *
 * 显式 `--state-dir` 与 claude/peri 的默认持久目录会保留 `seen` 与
 * `stream-state.json`，使重启后可以按已保存的房间游标补读，而不是只取 head 基线。
 * 未开启 persistent 的调用方（如 DSH 临时去重目录）仍在退出时整体删除。
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeAtomicFile } from './atomic';
import {
  cleanupOldAttachments,
  ensureAttachmentDirectory,
  startAttachmentCleanup,
} from './attachments';
import type { JsonObject } from './rpc';

export interface MonitorStateOptions {
  directory?: string | undefined;
  keep?: boolean | undefined;
  /** 临时目录前缀；每个 harness 保留旧脚本的目录名，便于排查。 */
  tempPrefix?: string | undefined;
  /** 退出时保留 seen 与游标；false 时删除临时目录。 */
  persistent?: boolean | undefined;
}

interface PersistedStreamState {
  v: number;
  cursors: Record<string, string>;
  last_seq: string;
}

/**
 * 默认持久目录按 harness + endpoint + token 摘要隔离：不写入 token 原文，
 * 但同一服务、同一凭据重启后会命中同一目录。
 */
export function defaultMonitorStateDirectory(
  harness: string,
  endpoint: string,
  token: string,
): string {
  const digest = createHash('sha256')
    .update(endpoint)
    .update('\0')
    .update(token)
    .digest('hex')
    .slice(0, 16);
  return join(homedir(), '.agentnet', 'monitor', `${harness}-${digest}`);
}

function parseStreamState(raw: string): PersistedStreamState {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { v: 1, cursors: {}, last_seq: '' };
    }
    const record = parsed as Record<string, unknown>;
    const cursors: Record<string, string> = {};
    const source = record.cursors;
    if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
      for (const [roomId, cursor] of Object.entries(source as Record<string, unknown>)) {
        if (roomId.length > 0 && typeof cursor === 'string' && cursor.length > 0) {
          cursors[roomId] = cursor;
        }
      }
    }
    return {
      v: 1,
      cursors,
      last_seq: typeof record.last_seq === 'string' ? record.last_seq : '',
    };
  } catch {
    return { v: 1, cursors: {}, last_seq: '' };
  }
}

export class MonitorState {
  private readonly seen = new Set<string>();
  private readonly cursors = new Map<string, string>();
  private lastSeq = '';
  private persistChain: Promise<void> = Promise.resolve();

  private constructor(
    readonly directory: string,
    readonly eventDir: string,
    readonly attachmentsDir: string,
    readonly seenPath: string,
    private readonly statePath: string,
    private readonly keep: boolean,
    private readonly persistent: boolean,
    private readonly stopAttachmentCleanup: () => void,
  ) {}

  static async create(options: MonitorStateOptions = {}): Promise<MonitorState> {
    const directory = options.directory
      ? await mkdir(options.directory, { recursive: true, mode: 0o700 }).then(
          () => options.directory as string,
        )
      : await mkdtemp(join(tmpdir(), options.tempPrefix ?? 'claude-watch.'));

    await chmod(directory, 0o700);
    const eventDir = join(directory, 'events');
    await mkdir(eventDir, { recursive: true, mode: 0o700 });
    await chmod(eventDir, 0o700);
    // 附件目录跨重启保留（Agent 可能在下一轮才读取）；启动、退出与长进程
    // 周期任务按保留期清理过期文件。
    const attachmentsDir = join(directory, 'attachments');
    await ensureAttachmentDirectory(attachmentsDir);
    await cleanupOldAttachments(attachmentsDir);
    const stopAttachmentCleanup = startAttachmentCleanup(attachmentsDir);
    const seenPath = join(directory, 'seen');
    const statePath = join(directory, 'stream-state.json');

    let existing = '';
    try {
      existing = await readFile(seenPath, 'utf8');
    } catch {
      await writeFile(seenPath, '', { mode: 0o600 });
    }
    await chmod(seenPath, 0o600);

    let stored = '';
    try {
      stored = await readFile(statePath, 'utf8');
    } catch {
      // 首次启动没有持久状态。
    }
    const persisted = parseStreamState(stored);

    const state = new MonitorState(
      directory,
      eventDir,
      attachmentsDir,
      seenPath,
      statePath,
      options.keep === true,
      options.persistent === true,
      stopAttachmentCleanup,
    );
    for (const key of existing.split('\n')) {
      if (key.length > 0) state.seen.add(key);
    }
    for (const [roomId, cursor] of Object.entries(persisted.cursors)) {
      state.cursors.set(roomId, cursor);
    }
    state.lastSeq = persisted.last_seq;
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

  getRoomCursor(roomId: string): string | undefined {
    return this.cursors.get(roomId);
  }

  roomCursors(): Array<[string, string]> {
    return [...this.cursors.entries()];
  }

  async setRoomCursor(roomId: string, cursor: string): Promise<void> {
    if (roomId.length === 0 || cursor.length === 0) return;
    if (this.cursors.get(roomId) === cursor) return;
    this.cursors.set(roomId, cursor);
    await this.persist();
  }

  async deleteRoomCursor(roomId: string): Promise<void> {
    if (!this.cursors.delete(roomId)) return;
    await this.persist();
  }

  lastSeqValue(): string {
    return this.lastSeq;
  }

  async setLastSeq(seq: string): Promise<void> {
    if (seq.length === 0 || seq === this.lastSeq) return;
    this.lastSeq = seq;
    await this.persist();
  }

  private persist(): Promise<void> {
    const payload: PersistedStreamState = {
      v: 1,
      cursors: Object.fromEntries(this.cursors),
      last_seq: this.lastSeq,
    };
    this.persistChain = this.persistChain
      .then(() => writeAtomicFile(this.statePath, `${JSON.stringify(payload)}\n`))
      .catch(() => undefined);
    return this.persistChain;
  }

  /** 写入完整正文事件文件；原子替换，避免宿主读到半截 JSON。 */
  async writeEventFile(deliveryId: string, event: JsonObject): Promise<string> {
    const path = join(this.eventDir, `${deliveryId}.json`);
    await writeAtomicFile(path, `${JSON.stringify(event)}\n`);
    return path;
  }

  async cleanup(): Promise<void> {
    await this.persistChain.catch(() => undefined);
    this.stopAttachmentCleanup();
    // 附件按保留期清理；keep/persistent 只影响 seen、游标与事件文件。
    await cleanupOldAttachments(this.attachmentsDir).catch(() => undefined);
    if (this.keep) return;
    if (this.persistent) {
      // 保留 seen 与 stream-state.json 供重启续读；正文事件文件仍按旧语义清理。
      await rm(this.eventDir, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
