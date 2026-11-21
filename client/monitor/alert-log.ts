/** Byte cursor for an append-only Peri watch log. Only complete lines are committed. */
import { createHash } from 'node:crypto';
import { open, readFile, type FileHandle } from 'node:fs/promises';

export interface AlertCursor {
  identity: string;
  offset: number;
  total: number;
  anchor: string;
}

export async function readAlertCursor(path: string): Promise<AlertCursor | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const cursor = JSON.parse(text) as AlertCursor;
  if (
    typeof cursor.identity !== 'string' || typeof cursor.anchor !== 'string' ||
    !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 ||
    !Number.isSafeInteger(cursor.total) || cursor.total < 0
  ) throw new Error('invalid alert cursor');
  return cursor;
}

/** Detect copy-truncate even when the replacement has grown past the old offset. */
async function anchorAt(file: FileHandle, offset: number): Promise<string> {
  const size = Math.min(offset, 64);
  const buffer = Buffer.alloc(size);
  const { bytesRead } = await file.read(buffer, 0, size, offset - size);
  return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
}

/** First use counts the existing backlog for the legacy total, without replaying it. */
export async function scanAlertLog(path: string, previous: AlertCursor | null) {
  const file = await open(path, 'r');
  try {
    const { dev, ino, size } = await file.stat();
    const identity = `${dev}:${ino}`;
    const resume = previous && previous.identity === identity && previous.offset <= size &&
      previous.anchor === await anchorAt(file, previous.offset);
    let offset = resume ? previous.offset : 0;
    let total = resume ? previous.total : 0;
    const lines: string[] = [];
    // Snapshot size bounds the read. Commit complete lines only; re-read a partial
    // line on the next pass. Cap wake batches so a restarted host can catch up in steps.
    let position = offset;
    const parts: Buffer[] = [];
    while (position < size && lines.length < 64) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
        parts.push(chunk.subarray(start, end));
        const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
        offset += line.length + 1;
        if (line.subarray(0, 5).toString() === 'ALERT') {
          total++;
          if (previous) lines.push(line.toString('utf8').replace(/\r$/u, ''));
        }
        parts.length = 0;
        start = end + 1;
        if (lines.length === 64) break;
      }
      if (start < chunk.length) parts.push(chunk.subarray(start));
    }
    return { cursor: { identity, offset, total, anchor: await anchorAt(file, offset) }, lines };
  } finally {
    await file.close();
  }
}
