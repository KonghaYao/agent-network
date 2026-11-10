/** Isolated HTTP/MCP acceptance: no production credentials, rooms or files. */
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';

import { CLIENT_INSTRUCTIONS, toolsetDigest } from '../src/mcp/client-contract';
import { issueUploadTicket, verifyUploadTicket, UPLOAD_TICKET_HEADER, UPLOAD_TICKET_TTL_MS } from '../src/drive/upload-ticket';
import { createD1 } from '../src/bun/d1';
import { hashToken } from '../src/storage/db';
import { getActor, getCredentialByHash } from '../src/storage/queries';
import { LIMITS } from '../src/contracts/limits';
import { Q05Server } from './lib/q05-harness';
import { callTool, check, checkEqual, checksPassed, connectClient, expectToolError, newRequestId, newToken, rawRpc } from './lib/harness';

interface ServiceInfo { toolset_sha256: string; tool_count: number; files_enabled: boolean; events_enabled: boolean }
interface Guide { mode: string; service: ServiceInfo; tool_names: string[]; missing_tools: string[]; steps: string[] }
interface Prepared { actor_id: string; upload_url: string; method: 'POST'; headers: Record<string, string>; expires_at: string; max_file_bytes: number }
interface Uploaded { fileId: string; name: string; size: number; sha256: string; state: string; visibility: string; publicUrl: string; downloadUrl: string }
type ListedTool = Parameters<typeof toolsetDigest>[0][number];

const digest = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
const bytes = new TextEncoder().encode('中文 patch\n+ fix 🦋\n');
const metadata = { name: '修复.patch', mime_type: 'text/plain', size: bytes.length, sha256: digest(bytes) };

async function upload(prepared: Prepared, body: Uint8Array = bytes, headers: Record<string, string> = {}) {
  return fetch(prepared.upload_url, { method: prepared.method, headers: { ...prepared.headers, ...headers }, body: body as unknown as BodyInit });
}

async function main() {
  const previousDisabled = process.env.DRIVE_DISABLED;
  const previousEvents = process.env.EVENTS_ENABLED;
  process.env.DRIVE_DISABLED = '0';
  process.env.EVENTS_ENABLED = '0';
  const server = await Q05Server.start();
  const ownerToken = newToken();
  const otherToken = newToken();
  const owner = await connectClient(ownerToken);
  const other = await connectClient(otherToken);
  let db: Database | undefined;
  try {
    const actor = await callTool<{ actor_id: string }>(owner.client, 'network_register', {
      request_id: newRequestId('reg'), kind: 'agent', name: 'Contract owner',
      agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const otherActor = await callTool<{ actor_id: string }>(other.client, 'network_register', {
      request_id: newRequestId('reg'), kind: 'agent', name: 'Contract other',
      agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const listed = (await rawRpc('tools/list')).body.result as { tools: ListedTool[] };
    const guide = await callTool<Guide>(owner.client, 'network_client_guide', { client_tool_names: ['network_me'] });
    const me = await callTool<{ service: ServiceInfo; pending_count: number }>(owner.client, 'network_me');
    checkEqual('default guide is one-shot', guide.mode, 'one_shot');
    checkEqual('catalog names match live tools/list', guide.tool_names.join(','), listed.tools.map((tool) => tool.name).sort().join(','));
    checkEqual('catalog hash matches live schemas and descriptions', guide.service.toolset_sha256, toolsetDigest(listed.tools));
    checkEqual('network_me exposes the same contract digest', me.service.toolset_sha256, guide.service.toolset_sha256);
    checkEqual('manifest count is actual registered tool count', me.service.tool_count, listed.tools.length);
    check('missing task/send/upload tools diagnosed', ['network_task_mark', 'network_message_send_status', 'network_file_upload_prepare'].every((name) => guide.missing_tools.includes(name)));
    check('present tool is not reported missing', !guide.missing_tools.includes('network_me'));
    check('bootstrap fits observed 512-character connector prefix', CLIENT_INSTRUCTIONS.length <= 512);
    for (const mode of ['one_shot', 'webhook', 'persistent']) {
      const modeGuide = await callTool<Guide>(owner.client, 'network_client_guide', { mode });
      checkEqual(`${mode} mode is preserved`, modeGuide.mode, mode);
      check(`${mode} has actionable steps`, modeGuide.steps.length >= 5);
      if (mode === 'webhook') check('disabled webhook is explicit', modeGuide.steps.some((step) => step.includes('未启用 MCP Events')));
    }
    const changed = listed.tools.map((tool) => tool.name === 'network_message_send' ? { ...tool, description: 'changed' } : tool);
    check('description drift changes digest', toolsetDigest(changed) !== guide.service.toolset_sha256);
    const changedSchema = listed.tools.map((tool) => tool.name === 'network_message_send' ? { ...tool, inputSchema: { type: 'object', properties: {} } } : tool);
    check('schema drift changes digest', toolsetDigest(changedSchema) !== guide.service.toolset_sha256);
    const forbidden = ['普通回复不要填写 invoke', '公开 URL 即下载权限', '后加入的成员可见历史文件', '任何已注册身份都可调用', '只在 D1 排队'];
    for (const text of forbidden) check(`live descriptions exclude stale rule: ${text}`, !listed.tools.some((tool) => tool.description?.includes(text)));

    const prepared = await callTool<Prepared>(owner.client, 'network_file_upload_prepare', metadata);
    checkEqual('ticket belongs to connected actor', prepared.actor_id, actor.actor_id);
    checkEqual('upload endpoint is same origin', prepared.upload_url, `${server.base}/mcp-upload`);
    check('upload preparation never exposes long-lived token', !JSON.stringify(prepared).includes(ownerToken));
    check('upload needs no Bearer', !('Authorization' in prepared.headers));
    checkEqual('filename is percent-encoded', prepared.headers['MCPP-File-Name'], encodeURIComponent(metadata.name));
    checkEqual('SHA-256 supplied to byte receiver', prepared.headers['MCPP-File-Sha256'], metadata.sha256);
    check('short expiration', Date.parse(prepared.expires_at) > Date.now() && Date.parse(prepared.expires_at) <= Date.now() + UPLOAD_TICKET_TTL_MS);
    const beforeUpload = await callTool<{ pending_count: number }>(owner.client, 'network_me');
    const response = await upload(prepared);
    checkEqual('ticket-only raw upload succeeds', response.status, 201);
    const file = await response.json() as Uploaded;
    checkEqual('content hash matches local bytes', file.sha256, metadata.sha256);
    checkEqual('byte size matches Unicode content', file.size, bytes.length);
    checkEqual('unicode name survives transport', file.name, metadata.name);
    checkEqual('upload defaults to private draft', `${file.state}/${file.visibility}`, 'draft/private');
    checkEqual('bare file URL is not authorization', (await fetch(file.publicUrl)).status, 404);
    const downloaded = new Uint8Array(await (await fetch(file.downloadUrl)).arrayBuffer());
    checkEqual('private ticket downloads original bytes', digest(downloaded), metadata.sha256);
    const info = await callTool<Uploaded>(owner.client, 'drive_file_info', { fileId: file.fileId });
    checkEqual('same actor can read upload through MCP', info.fileId, file.fileId);
    await expectToolError('other actor cannot read private draft', callTool(other.client, 'drive_file_info', { fileId: file.fileId }), 'FILE_UNAVAILABLE');
    checkEqual('upload does not create delivery', (await callTool<{ pending_count: number }>(owner.client, 'network_me')).pending_count, beforeUpload.pending_count);
    const preflight = await fetch(prepared.upload_url, { method: 'OPTIONS', headers: { Origin: 'https://client.test', 'Access-Control-Request-Headers': UPLOAD_TICKET_HEADER } });
    checkEqual('ticket CORS preflight', preflight.status, 204);
    check('ticket header accepted by browser', (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase().includes(UPLOAD_TICKET_HEADER.toLowerCase()));

    for (const [name, value] of Object.entries({ 'MCPP-File-Name': 'other.txt', 'MCPP-File-Size': String(bytes.length + 1), 'MCPP-File-Sha256': '0'.repeat(64), 'Content-Type': 'image/png' })) {
      checkEqual(`ticket rejects changed ${name}`, (await upload(prepared, bytes, { [name]: value })).status, 400);
    }
    checkEqual('ticket rejects changed bytes with original headers', (await upload(prepared, new Uint8Array(bytes.length))).status, 422);
    checkEqual('tampered signature rejected even with valid alternate Bearer', (await upload(prepared, bytes, { [UPLOAD_TICKET_HEADER]: 'invalid', Authorization: `Bearer ${otherToken}` })).status, 401);
    checkEqual('missing ticket and missing Bearer rejected', (await upload(prepared, bytes, { [UPLOAD_TICKET_HEADER]: '' })).status, 401);
    const asBearer = await rawRpc('tools/call', { name: 'network_me', arguments: {} }, { token: prepared.headers[UPLOAD_TICKET_HEADER]! });
    check('upload ticket cannot log in as actor', !(asBearer.body.result as { structuredContent?: { actor_id?: string } })?.structuredContent?.actor_id);
    const anonymous = await rawRpc('tools/call', { name: 'network_file_upload_prepare', arguments: metadata });
    check('anonymous cannot prepare upload', (anonymous.body.result as { isError?: boolean })?.isError === true);
    const tooLarge = await rawRpc('tools/call', { name: 'network_file_upload_prepare', arguments: { ...metadata, size: prepared.max_file_bytes + 1 } }, { token: ownerToken });
    check('prepare rejects oversized upload', !!tooLarge.body.error || (tooLarge.body.result as { isError?: boolean })?.isError === true);
    const wrongPath = await rawRpc('tools/call', { name: 'network_file_upload_prepare', arguments: { ...metadata, name: '../bad.patch' } }, { token: ownerToken });
    check('prepare rejects path-like filename', !!wrongPath.body.error || (wrongPath.body.result as { isError?: boolean })?.isError === true);

    const room = await callTool<{ room: { room_id: string } }>(owner.client, 'network_room_create', { request_id: newRequestId('room'), kind: 'group', title: 'Upload handoff', members: [otherActor.actor_id] });
    const bound = await callTool<{ file: { room_file_id: string; uploader_id: string } }>(owner.client, 'network_room_file_bind', { request_id: newRequestId('bind'), room_id: room.room.room_id, file_id: file.fileId });
    checkEqual('uploader identity survives bind', bound.file.uploader_id, actor.actor_id);
    const recipientFile = await callTool<{ file: { download_url: string } }>(other.client, 'network_room_file_get', { room_id: room.room.room_id, file_id: file.fileId });
    checkEqual('recipient gets own fresh ticket and exact bytes', digest(new Uint8Array(await (await fetch(recipientFile.file.download_url)).arrayBuffer())), metadata.sha256);

    db = new Database(server.dbPath);
    const d1 = createD1(db);
    const credential = await getCredentialByHash(d1, await hashToken(ownerToken));
    const principal = { actor: await getActor(d1, actor.actor_id), credential: credential!, credentialHash: await hashToken(ownerToken) };
    const local = issueUploadTicket('local-test-secret', principal, metadata, 1_000_000);
    check('ticket verifies before expiry', !!verifyUploadTicket('local-test-secret', local.ticket, 1_000_001));
    check('ticket expires at boundary', verifyUploadTicket('local-test-secret', local.ticket, 1_000_000 + UPLOAD_TICKET_TTL_MS) === null);
    check('different signing key rejected', verifyUploadTicket('other-key', local.ticket, 1_000_001) === null);
    check('malformed ticket fails closed', verifyUploadTicket('local-test-secret', 'x.y.z') === null);
    check('oversized ticket fails closed', verifyUploadTicket('local-test-secret', 'x'.repeat(4097)) === null);
    db.close(); db = undefined;

    await server.restart();
    const afterRestart = await upload(prepared);
    checkEqual('prepared upload survives restart with configured secret', afterRestart.status, 201);
    const replay = await afterRestart.json() as Uploaded;
    check('reupload is explicitly non-idempotent', replay.fileId !== file.fileId);
    const ownerAfterRestart = await connectClient(ownerToken);
    try {
      const afterGuide = await callTool<Guide>(ownerAfterRestart.client, 'network_client_guide');
      checkEqual('contract digest stable across restart', afterGuide.service.toolset_sha256, guide.service.toolset_sha256);
    } finally { await ownerAfterRestart.close(); }
    db = new Database(server.dbPath);
    db.query('UPDATE drive_files SET size = ? WHERE file_id = ?').run(LIMITS.draftBytesPerActor, replay.fileId);
    const overQuota = await upload(prepared);
    checkEqual('ticket upload obeys draft quota', overQuota.status, 507);
    const quotaPayload = await overQuota.json() as { error: string };
    checkEqual('quota failure is explicit', quotaPayload.error, 'QUOTA_EXCEEDED');
    db.query('UPDATE actors SET disabled_at = ? WHERE actor_id = ?').run(Date.now(), actor.actor_id);
    checkEqual('disabled actor ticket rejected', (await upload(prepared)).status, 401);
    db.query('UPDATE actors SET disabled_at = NULL WHERE actor_id = ?').run(actor.actor_id);
    db.query('UPDATE credentials SET revoked_at = ? WHERE token_hash = ?').run(Date.now(), await hashToken(ownerToken));
    checkEqual('revoked issuing credential invalidates ticket', (await upload(prepared)).status, 401);
  } finally {
    db?.close();
    await owner.close(); await other.close(); await server.destroy();
    process.env.DRIVE_DISABLED = previousDisabled;
    process.env.EVENTS_ENABLED = previousEvents;
  }

  process.env.DRIVE_DISABLED = '1';
  const noFiles = await Q05Server.start();
  try {
    const result = await rawRpc('tools/call', { name: 'network_client_guide', arguments: {} });
    const guide = (result.body.result as { structuredContent: Guide }).structuredContent;
    check('files-disabled capability is truthful', !guide.service.files_enabled);
    check('files-disabled omits upload tool', !guide.tool_names.includes('network_file_upload_prepare'));
    check('files-disabled guide does not promise upload', guide.steps.some((step) => step.includes('未启用文件存储')));
  } finally { await noFiles.destroy(); process.env.DRIVE_DISABLED = previousDisabled; }
  console.log(`client contract acceptance: ${checksPassed()} checks passed`);
}

await main();
