import { createHmac, timingSafeEqual } from 'node:crypto';
import { FileError } from '@peri-code/mcpp/files';
import { z } from 'zod';

import type { Principal } from '../domain/principal';
import { getActor, getCredentialByHash } from '../storage/queries';

export const UPLOAD_TICKET_HEADER = 'X-WeBots-Upload-Ticket';
export const UPLOAD_TICKET_TTL_MS = 5 * 60_000;
const DOMAIN = 'webots/upload-ticket/v1\n';

export const uploadMetadataSchema = z.object({
  name: z.string().min(1).max(255).refine((name) =>
    Buffer.byteLength(name, 'utf8') <= 255 && name !== '.' && name !== '..' &&
    !/[\x00-\x1f\x7f-\x9f/\\]/u.test(name), 'Invalid filename'),
  mime_type: z.string().max(255).regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u)
    .refine((value) => value.toLowerCase() !== 'multipart/form-data'),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const ticketSchema = uploadMetadataSchema.extend({
  v: z.literal(1),
  actor_id: z.string().min(1).max(128),
  credential_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  expires_at: z.number().int().positive(),
}).strict();
type UploadTicket = z.infer<typeof ticketSchema>;

function signature(secret: string, encoded: string): Buffer {
  return createHmac('sha256', secret).update(DOMAIN).update(encoded).digest();
}

export function issueUploadTicket(
  secret: string,
  principal: Principal,
  metadata: z.infer<typeof uploadMetadataSchema>,
  at = Date.now(),
): { ticket: string; expires_at: number } {
  if (!principal.actor || !principal.credential || !principal.credentialHash) {
    throw new FileError('UNAUTHENTICATED');
  }
  const payload = ticketSchema.parse({
    ...metadata,
    mime_type: metadata.mime_type.toLowerCase(),
    v: 1,
    actor_id: principal.actor.actor_id,
    credential_hash: principal.credentialHash,
    expires_at: at + UPLOAD_TICKET_TTL_MS,
  });
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { ticket: `${encoded}.${signature(secret, encoded).toString('base64url')}`, expires_at: payload.expires_at };
}

export function verifyUploadTicket(secret: string, ticket: string, at = Date.now()): UploadTicket | null {
  if (!ticket || ticket.length > 4096) return null;
  const parts = ticket.split('.');
  const [encoded, digest] = parts;
  if (parts.length !== 2 || !encoded || !digest || !/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[A-Za-z0-9_-]{43}$/u.test(digest)) return null;
  try {
    const expected = signature(secret, encoded);
    const supplied = Buffer.from(digest, 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const parsed = ticketSchema.safeParse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    if (!parsed.success || parsed.data.expires_at <= at || parsed.data.expires_at > at + UPLOAD_TICKET_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Ticket authentication is upload-only. It never becomes a Bearer credential. */
export async function authorizeTicketUpload(
  db: D1Database,
  secret: string,
  request: Request,
  at = Date.now(),
): Promise<string> {
  const ticket = verifyUploadTicket(secret, request.headers.get(UPLOAD_TICKET_HEADER) ?? '', at);
  if (!ticket) throw new FileError('UNAUTHENTICATED');
  let name: string;
  try { name = decodeURIComponent(request.headers.get('MCPP-File-Name') ?? ''); }
  catch { throw new FileError('INVALID_UPLOAD_REQUEST'); }
  const mime = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (request.method !== 'POST' || name !== ticket.name || mime !== ticket.mime_type ||
      request.headers.get('MCPP-File-Size') !== String(ticket.size) ||
      request.headers.get('MCPP-File-Sha256') !== ticket.sha256) {
    throw new FileError('INVALID_UPLOAD_REQUEST');
  }
  const credential = await getCredentialByHash(db, ticket.credential_hash);
  if (!credential || credential.revoked_at !== null || credential.actor_id !== ticket.actor_id) {
    throw new FileError('UNAUTHENTICATED');
  }
  const actor = await getActor(db, ticket.actor_id);
  if (!actor || actor.disabled_at !== null) throw new FileError('UNAUTHENTICATED');
  return ticket.actor_id;
}
