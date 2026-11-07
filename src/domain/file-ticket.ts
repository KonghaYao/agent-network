import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { BusinessError } from '../contracts/errors';

/**
 * 房间文件下载票据。
 *
 * `/f/:fileId` 是浏览器 `<img>`、Range 与下载链接的入口，不能依赖
 * `Authorization` 头。绑定到房间的文件因此使用短时票据，而不是把长期
 * Bearer 放进 URL：
 *
 * - 票据只证明“某成员代次在某个到期时间前请求过该文件”，不携带消息正文；
 * - 每次使用票据仍重新检查成员是否 active、代次是否一致、当前历史策略是否
 *   允许该文件；移出、重新加入或策略收紧后旧票据立即失效；
 * - 未绑定到任何房间的上传文件没有 `room_files` 行，仍按 MCPP Files 的公开
 *   语义直接访问；私有的完整授权由 M07 收敛。
 *
 * 密钥优先取部署方提供的 `FILE_TICKET_SECRET`；缺省时使用进程级随机密钥。
 * 进程重启后旧票据全部失效，这与短时票据的语义一致。
 */
const DEFAULT_SECRET = randomBytes(32).toString('hex');
const MAX_TICKET_LENGTH = 2048;

export interface FileTicketPayload {
  fileId: string;
  roomId: string;
  actorId: string;
  memberGeneration: number;
  expiresAt: number;
}

interface EncodedTicket extends FileTicketPayload {
  v: 1;
}

export function fileTicketSecret(configured?: string): string {
  const value = configured?.trim();
  return value && value.length > 0 ? value : DEFAULT_SECRET;
}

function signingInput(payload: FileTicketPayload): string {
  return [
    'agent-network/file-ticket/v1',
    payload.fileId,
    payload.roomId,
    payload.actorId,
    String(payload.memberGeneration),
    String(payload.expiresAt),
  ].join('\n');
}

function sign(secret: string, payload: FileTicketPayload): string {
  return createHmac('sha256', secret).update(signingInput(payload)).digest('base64url');
}

/** 票据放在 query 的 `t` 参数；`download=1` 等既有参数保持原样。 */
export function issueFileTicket(secret: string, payload: FileTicketPayload): string {
  const body: EncodedTicket = { v: 1, ...payload };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${encoded}.${sign(secret, payload)}`;
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
  if (
    body.v !== 1 ||
    typeof body.fileId !== 'string' ||
    typeof body.roomId !== 'string' ||
    typeof body.actorId !== 'string' ||
    !Number.isSafeInteger(body.memberGeneration) ||
    !Number.isSafeInteger(body.expiresAt)
  ) {
    return null;
  }
  const payload: FileTicketPayload = {
    fileId: body.fileId,
    roomId: body.roomId,
    actorId: body.actorId,
    memberGeneration: body.memberGeneration as number,
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
