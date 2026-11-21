import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as lockfile from 'proper-lockfile';

import { WEB_RELEASE_BUILD_ID, WEB_RELEASE_SCHEMA_VERSION, writeJsonAtomic } from '../../src/web/web-release';

/** Local release writers share the same lock directory, including earlier release tools. */
export async function withReleaseLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const lockPath = join(root, '.release-lock');
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(root, {
      lockfilePath: lockPath,
      realpath: false,
      retries: 0,
      stale: 15 * 60_000,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
    throw new Error(`另一个发布/清理进程正在运行（锁: ${lockPath}）`, { cause: error });
  }
  try {
    return await run();
  } finally {
    await release();
  }
}

export interface Pins {
  readonly schemaVersion: number;
  readonly builds: readonly string[];
  readonly legacyBaseline?: string;
}

export async function readPins(root: string): Promise<Pins> {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'pins.json'), 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('pins.json 必须是对象');
    }
    const record = parsed as Record<string, unknown>;
    const builds = Array.isArray(record.builds)
      ? record.builds.filter((item): item is string => typeof item === 'string' && WEB_RELEASE_BUILD_ID.test(item))
      : [];
    const legacyBaseline =
      typeof record.legacyBaseline === 'string' && WEB_RELEASE_BUILD_ID.test(record.legacyBaseline)
        ? record.legacyBaseline
        : undefined;
    return { schemaVersion: WEB_RELEASE_SCHEMA_VERSION, builds, ...(legacyBaseline ? { legacyBaseline } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: WEB_RELEASE_SCHEMA_VERSION, builds: [] };
    }
    throw error;
  }
}

/** Called by a writer that already owns the release lock. */
export async function writeReleasePin(root: string, buildId: string, baseline: boolean): Promise<Pins> {
  const pins = await readPins(root);
  const builds = [...new Set([...pins.builds, buildId])];
  const next: Pins = { ...pins, builds, ...(baseline ? { legacyBaseline: buildId } : {}) };
  await writeJsonAtomic(join(root, 'pins.json'), next);
  return next;
}

export async function addPin(root: string, buildId: string): Promise<Pins> {
  return withReleaseLock(root, () => writeReleasePin(root, buildId, false));
}
