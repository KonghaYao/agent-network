import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { BusinessError } from '../contracts/errors';

/**
 * 同源文件下载票据（`/f/<fileId>?t=...`）。
 *
 * 浏览器 `<img>`、`<video>`、Range 与下载链接不能携带 Authorization，因此
 * 私有字节使用短时票据。票据只证明“某个身份在某个到期时间前请求过该文件”，
 * 每次使用仍重新校验：
 *
 * - `scope: 'room'`：票据发给房间成员的某一成员代次，使用时检查成员仍 active、
 *   代次一致、房间策略版本一致、当前历史边界仍允许该文件；移出、退群、重新
 *   加入或策略收紧后旧票据立即失效。
 * - `scope: 'file'`：票据发给上传身份（MCPP ownerScope），用于私有草稿、
 *   旧公开文件收紧后的授权客户端访问，以及正式成果绑定前的预览。
 *
 * 票据不携带长期 Bearer；密钥优先取部署方提供的 `FILE_TICKET_SECRET`，缺省
 * 使用进程级随机密钥。进程重启后旧票据全部失效，与短时票据语义一致。
 */
const DEFAULT_SECRET = randomBytes(32).toString('hex');
const MAX_TICKET_LENGTH = 4096;

export type FileTicketScope = 'room' | 'file';

export interface FileTicketPayload {
  fileId: string;
  scope: FileTicketScope;
  /** room scope 为 actor_id；file scope 为 MCPP Files 的 ownerScope。 */
  subject: string;
  roomId: string | null;
  memberGeneration: number | null;
  policyRevision: number | null;
  expiresAt: number;
}

export interface RoomFileTicketInput {
  fileId: string;
  roomId: string;
  actorId: string;
  memberGeneration: number;
  policyRevision: number;
  expiresAt: number;
}

export interface PrivateFileTicketInput {
  fileId: string;
  ownerScope: string;
  expiresAt: number;
}

interface EncodedTicket extends FileTicketPayload {
  v: 2;
}

export function fileTicketSecret(configured?: string): string {
  const value = configured?.trim();
  return value && value.length > 0 ? value : DEFAULT_SECRET;
}

function signingInput(payload: FileTicketPayload): string {
  return [
    'agent-network/file-ticket/v2',
    payload.scope,
    payload.fileId,
    payload.subject,
    payload.roomId ?? '',
    payload.memberGeneration === null ? '' : String(payload.memberGeneration),
    payload.policyRevision === null ? '' : String(payload.policyRevision),
    String(payload.expiresAt),
  ].join('\n');
}

function sign(secret: string, payload: FileTicketPayload): string {
  return createHmac('sha256', secret).update(signingInput(payload)).digest('base64url');
}

/** 票据放在 query 的 `t` 参数；`download=1` 等既有参数保持原样。 */
export function issueFileTicket(secret: string, payload: FileTicketPayload): string {
  const body: EncodedTicket = { v: 2, ...payload };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${encoded}.${sign(secret, payload)}`;
}

export function issueRoomFileTicket(secret: string, input: RoomFileTicketInput): string {
  return issueFileTicket(secret, {
    fileId: input.fileId,
    scope: 'room',
    subject: input.actorId,
    roomId: input.roomId,
    memberGeneration: input.memberGeneration,
    policyRevision: input.policyRevision,
    expiresAt: input.expiresAt,
  });
}

export function issuePrivateFileTicket(secret: string, input: PrivateFileTicketInput): string {
  return issueFileTicket(secret, {
    fileId: input.fileId,
    scope: 'file',
    subject: input.ownerScope,
    roomId: null,
    memberGeneration: null,
    policyRevision: null,
    expiresAt: input.expiresAt,
  });
}

export function appendFileTicket(url: string, ticket: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(ticket)}`;
}

/** 校验失败统一按不可下载处理，不向调用方区分“票据错/权限过期”。 */
export function verifyFileTicket(
  secret: string,
  ticket: string,
  at = Date.now(),
): FileTicketPayload | null {
  if (!ticket || ticket.length > MAX_TICKET_LENGTH) return null;
  const dot = ticket.lastIndexOf('.');
  if (dot <= 0 || dot === ticket.length - 1) return null;
  const encoded = ticket.slice(0, dot);
  const signature = ticket.slice(dot + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as Partial<EncodedTicket>;
  if (body.v !== 2 || (body.scope !== 'room' && body.scope !== 'file')) return null;
  if (
    typeof body.fileId !== 'string' ||
    typeof body.subject !== 'string' ||
    body.subject.length === 0 ||
    !Number.isSafeInteger(body.expiresAt)
  ) {
    return null;
  }
  const roomScoped = body.scope === 'room';
  if (
    roomScoped
      ? typeof body.roomId !== 'string' ||
        body.roomId.length === 0 ||
        !Number.isSafeInteger(body.memberGeneration) ||
        !Number.isSafeInteger(body.policyRevision)
      : body.roomId !== null ||
        body.memberGeneration !== null ||
        body.policyRevision !== null
  ) {
    return null;
  }
  const payload: FileTicketPayload = {
    fileId: body.fileId,
    scope: body.scope,
    subject: body.subject,
    roomId: roomScoped ? (body.roomId as string) : null,
    memberGeneration: roomScoped ? (body.memberGeneration as number) : null,
    policyRevision: roomScoped ? (body.policyRevision as number) : null,
    expiresAt: body.expiresAt as number,
  };
  const expected = sign(secret, payload);
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  if (payload.expiresAt <= at) return null;
  return payload;
}

export function requireFileTicket(
  secret: string,
  ticket: string | null,
  at = Date.now(),
): FileTicketPayload {
  const payload = ticket ? verifyFileTicket(secret, ticket, at) : null;
  if (!payload) throw new BusinessError('FILE_UNAVAILABLE', '文件下载票据无效或已过期');
  return payload;
}
