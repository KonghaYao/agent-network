import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';

import { orm, schema, toD1 } from '../drizzle';
import type { D1Like } from '../queries';
import type {
  ArtifactRow,
  DriveFileRow,
  FileReferenceRow,
  RoomFileRow,
} from '../rows';

/** 按 file_id 读取绑定记录；同一 file_id 全局唯一，含墓碑。 */
export async function getRoomFile(db: D1Like, fileId: string): Promise<RoomFileRow | null> {
  const query = orm(db)
    .select()
    .from(schema.roomFiles)
    .where(eq(schema.roomFiles.file_id, fileId));
  return toD1(db, query).first<RoomFileRow>();
}

/** 按 file_id 读取应用层上传登记；旧库未登记的文件返回 null。 */
export async function getDriveFile(db: D1Like, fileId: string): Promise<DriveFileRow | null> {
  const query = orm(db)
    .select()
    .from(schema.driveFiles)
    .where(eq(schema.driveFiles.file_id, fileId));
  return toD1(db, query).first<DriveFileRow>();
}

/** 配额只统计仍有效（未过期或已保留）的行；字段顺序与 raw 聚合一致。 */
export interface FileQuotaUsageRow {
  files: number;
  bytes: number;
  retained: number;
}

/** 上传者草稿配额占用。 */
export async function driveFileQuotaUsage(
  db: D1Like,
  ownerScope: string,
  at: number,
): Promise<FileQuotaUsageRow> {
  const query = orm(db)
    .select({
      files: sql<number>`count(*)`.as('files'),
      bytes: sql<number>`coalesce(sum(${schema.driveFiles.size}), 0)`.as('bytes'),
      retained: sql<number>`coalesce(sum(case when ${schema.driveFiles.retained} = 1 then ${schema.driveFiles.size} else 0 end), 0)`.as(
        'retained',
      ),
    })
    .from(schema.driveFiles)
    .where(
      and(
        eq(schema.driveFiles.owner_scope, ownerScope),
        eq(schema.driveFiles.state, 'draft'),
        or(
          eq(schema.driveFiles.retained, 1),
          isNull(schema.driveFiles.expires_at),
          gt(schema.driveFiles.expires_at, at),
        ),
      ),
    );
  const row = await toD1(db, query).first<FileQuotaUsageRow>();
  return row ?? { files: 0, bytes: 0, retained: 0 };
}

/** 房间附件配额占用。 */
export async function roomFileQuotaUsage(
  db: D1Like,
  roomId: string,
  at: number,
): Promise<FileQuotaUsageRow> {
  const query = orm(db)
    .select({
      files: sql<number>`count(*)`.as('files'),
      bytes: sql<number>`coalesce(sum(${schema.roomFiles.size}), 0)`.as('bytes'),
      retained: sql<number>`coalesce(sum(case when ${schema.roomFiles.retained} = 1 then ${schema.roomFiles.size} else 0 end), 0)`.as(
        'retained',
      ),
    })
    .from(schema.roomFiles)
    .where(
      and(
        eq(schema.roomFiles.room_id, roomId),
        isNull(schema.roomFiles.deleted_at),
        or(eq(schema.roomFiles.retained, 1), gt(schema.roomFiles.expires_at, at)),
      ),
    );
  const row = await toD1(db, query).first<FileQuotaUsageRow>();
  return row ?? { files: 0, bytes: 0, retained: 0 };
}

/** 按 artifact_id 读取成果版本。 */
export async function getArtifact(db: D1Like, artifactId: string): Promise<ArtifactRow | null> {
  return db
    .prepare('SELECT * FROM artifacts WHERE artifact_id = ?')
    .bind(artifactId)
    .first<ArtifactRow>();
}

/** 按 file_id 读取成果版本；一个文件至多一个成果。 */
export async function getArtifactByFile(db: D1Like, fileId: string): Promise<ArtifactRow | null> {
  return db
    .prepare('SELECT * FROM artifacts WHERE file_id = ?')
    .bind(fileId)
    .first<ArtifactRow>();
}

/** 读取某文件的一条有效保留引用。 */
export async function getActiveFileReference(
  db: D1Like,
  fileId: string,
  kind: FileReferenceRow['kind'],
  refId: string,
): Promise<FileReferenceRow | null> {
  return db
    .prepare(
      "SELECT * FROM file_references WHERE file_id = ? AND kind = ? AND ref_id = ? AND state = 'active'",
    )
    .bind(fileId, kind, refId)
    .first<FileReferenceRow>();
}
