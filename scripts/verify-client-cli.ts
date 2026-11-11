/**
 * agentnet CLI 验收：本地 mock MCP，不访问生产、不使用真实凭据。
 *
 * 覆盖：--help、skills list/get、send（含显式空 invoke）、inbox、
 * 通用 call、token 脱敏、monitor 迁移桥 --check、构建产物与可重复构建。
 */

import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { check, checkEqual, checksPassed } from './lib/harness';

const ROOT = resolve(import.meta.dir, '..');
const CLI = resolve(ROOT, 'client/cli.ts');
const BUNDLE = resolve(ROOT, 'public/skills/agentnet.js');
const PROTOCOL_VERSION = '2026-07-28';
const CLIENT_NAME = 'agentnet-cli';
const TOKEN = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
const SKILL_URI = 'skill://agent-network/agent-network/SKILL.md';
const SKILL_BODY = '# Agent Network\n\nmock skill body\n';
const SKILL_ENTRY = {
  uri: SKILL_URI,
  frontmatter: { name: 'agent-network', description: 'mock skill' },
  resources: [{ uri: SKILL_URI, digest: `sha256:${'0'.repeat(64)}` }],
};

const UPLOAD_FILE_ID = `f_${'A'.repeat(22)}`;
const UPLOAD_BODY = 'hello upload\n';
const UPLOAD_SHA = new Bun.CryptoHasher('sha256').update(UPLOAD_BODY).digest('hex');
const DOWNLOAD_BODY = 'download body\n';
const DOWNLOAD_SHA = new Bun.CryptoHasher('sha256').update(DOWNLOAD_BODY).digest('hex');
const SIGNED_MARKER = 'signed-secret-marker';

const MOCK_MESSAGE = {
  message_id: 'msg_mock',
  sender_id: 'actor_mock',
  sender_name: 'Mock Sender',
  sender_kind: 'agent',
  created_seq: '42',
  preview: 'hello',
  body_bytes: 5,
  created_at: '2026-11-04T00:00:00.000Z',
};

const PENDING_DELIVERY = {
  delivery_id: 'dlv_mock',
  recipient_id: 'actor_mock',
  message_id: 'msg_mock',
  room_id: 'rm_mock',
  state: 'pending',
  attempt: 0,
  claim_id: null,
  claimed_at: null,
  progress_at: null,
  result_message_id: null,
  error: null,
  created_seq: '7',
  created_at: '2026-11-04T00:00:00.000Z',
  updated_at: '2026-11-04T00:00:00.000Z',
  message: MOCK_MESSAGE,
};

const CLAIMED_DELIVERY = {
  ...PENDING_DELIVERY,
  state: 'claimed',
  attempt: 1,
  claim_id: 'clm_mock',
  claimed_at: '2026-11-04T00:01:00.000Z',
};

const COMPLETED_DELIVERY = {
  ...CLAIMED_DELIVERY,
  state: 'completed',
  result_message_id: 'msg_reply',
  updated_at: '2026-11-04T00:02:00.000Z',
};

const REPLY_MESSAGE = {
  ...MOCK_MESSAGE,
  message_id: 'msg_reply',
  preview: 'completed',
  created_seq: '43',
};

interface MockState {
  inbox: 'pending' | 'claimed';
  upload: 'ok' | 'sha-mismatch' | 'expired' | 'too-large';
  prepare: 'ok' | 'too-large';
  download: 'ok' | '404' | '403';
  send: 'ok' | 'fail';
}

interface UploadRequest {
  ticket: string | null;
  authorization: string | null;
  name: string | null;
  size: string | null;
  sha256: string | null;
  contentType: string | null;
  bytes: number;
  actualSha256: string;
}

interface Captured {
  method: string;
  tool: string | null;
  arguments: Record<string, unknown> | null;
  protocolVersion: string | null;
  methodHeader: string | null;
  nameHeader: string | null;
  authorization: string | null;
  meta: Record<string, unknown> | null;
}

function mockRoomFile(
  origin: string,
  fileId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    room_file_id: 'rf_mock',
    room_id: 'rm_mock',
    file_id: fileId,
    name: 'report.txt',
    mime_type: 'text/plain',
    size: DOWNLOAD_BODY.length,
    sha256: DOWNLOAD_SHA,
    public_url: `${origin}/f/${fileId}`,
    preview_url: `${origin}/f/${fileId}?t=${SIGNED_MARKER}`,
    download_url: `${origin}/f/${fileId}?t=${SIGNED_MARKER}&download=1`,
    preview_kind: 'text',
    uploader_id: 'actor_mock',
    uploader_name: 'Mock Sender',
    can_delete: true,
    retained: false,
    created_at: '2026-11-04T00:00:00.000Z',
    expires_at: '2026-12-04T00:00:00.000Z',
    ...overrides,
  };
}

function startMock(): {
  baseUrl: string;
  calls: Captured[];
  uploads: UploadRequest[];
  state: MockState;
  stop(): void;
} {
  const calls: Captured[] = [];
  const uploads: UploadRequest[] = [];
  const state: MockState = {
    inbox: 'pending',
    upload: 'ok',
    prepare: 'ok',
    download: 'ok',
    send: 'ok',
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;
      if (url.pathname === '/mcp-upload') {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const actualSha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
        uploads.push({
          ticket: request.headers.get('x-webots-upload-ticket'),
          authorization: request.headers.get('authorization'),
          name: request.headers.get('mcpp-file-name'),
          size: request.headers.get('mcpp-file-size'),
          sha256: request.headers.get('mcpp-file-sha256'),
          contentType: request.headers.get('content-type'),
          bytes: bytes.length,
          actualSha256,
        });
        if (state.upload === 'expired') {
          return Response.json(
            { error: { code: 'UNAUTHENTICATED', message: 'upload ticket expired' } },
            { status: 401 },
          );
        }
        if (state.upload === 'too-large') {
          return Response.json(
            { error: { code: 'FILE_TOO_LARGE', message: 'file too large' } },
            { status: 413 },
          );
        }
        const name = decodeURIComponent(request.headers.get('mcpp-file-name') ?? 'file');
        return Response.json(
          {
            fileId: UPLOAD_FILE_ID,
            name,
            mimeType: (request.headers.get('content-type') ?? 'application/octet-stream')
              .split(';')[0]
              ?.trim(),
            size: bytes.length,
            sha256: state.upload === 'sha-mismatch' ? '0'.repeat(64) : actualSha256,
            createdAt: '2026-11-04T00:00:00.000Z',
            expiresAt: '2026-12-04T00:00:00.000Z',
            publicUrl: `${origin}/f/${UPLOAD_FILE_ID}`,
            previewUrl: `${origin}/f/${UPLOAD_FILE_ID}?t=${SIGNED_MARKER}`,
            downloadUrl: `${origin}/f/${UPLOAD_FILE_ID}?t=${SIGNED_MARKER}&download=1`,
            state: 'draft',
            visibility: 'private',
            retained: false,
            quota: { used_bytes: 13, limit_bytes: 1024, used_files: 1, limit_files: 10 },
          },
          { status: 201 },
        );
      }
      if (url.pathname.startsWith('/f/')) {
        if (state.download === '404') return new Response('Not Found', { status: 404 });
        if (state.download === '403') return new Response('Forbidden', { status: 403 });
        return new Response(DOWNLOAD_BODY, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      if (url.pathname !== '/mcp') {
        return new Response('not found', { status: 404 });
      }
      const body = (await request.json()) as {
        id?: string | number | null;
        method?: string;
        params?: {
          name?: string;
          arguments?: Record<string, unknown>;
          uri?: string;
          _meta?: Record<string, unknown>;
        };
      };
      const params = body.params ?? {};
      const meta = params._meta ?? null;
      const captured: Captured = {
        method: String(body.method ?? ''),
        tool: params.name ?? null,
        arguments: params.arguments ?? null,
        protocolVersion: request.headers.get('mcp-protocol-version'),
        methodHeader: request.headers.get('mcp-method'),
        nameHeader: request.headers.get('mcp-name'),
        authorization: request.headers.get('authorization'),
        meta,
      };
      calls.push(captured);

      const fail = (status: number, message: string) =>
        Response.json(
          {
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: { code: -32600, message },
          },
          { status },
        );

      if (captured.protocolVersion !== PROTOCOL_VERSION) {
        return fail(400, 'missing MCP-Protocol-Version');
      }
      if (captured.methodHeader !== body.method) {
        return fail(400, 'MCP-Method header mismatch');
      }
      if (!meta || meta['io.modelcontextprotocol/protocolVersion'] !== PROTOCOL_VERSION) {
        return fail(400, 'missing namespaced protocolVersion');
      }
      const clientInfo = meta['io.modelcontextprotocol/clientInfo'] as
        | { name?: string }
        | undefined;
      if (clientInfo?.name !== CLIENT_NAME) {
        return fail(400, 'unexpected clientInfo');
      }
      if (!('io.modelcontextprotocol/clientCapabilities' in meta)) {
        return fail(400, 'missing clientCapabilities');
      }

      const ok = (result: unknown) =>
        Response.json({ jsonrpc: '2.0', id: body.id ?? null, result });

      if (body.method === 'skills/list') {
        return ok({ skills: [SKILL_ENTRY], ttlMs: 0, cacheScope: 'private' });
      }
      if (body.method === 'skills/get') {
        if (params.uri !== SKILL_URI) {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: { code: -32602, message: 'unknown skill' },
          });
        }
        return ok({ skill: SKILL_ENTRY });
      }
      if (body.method === 'resources/read') {
        if (captured.nameHeader !== params.uri) {
          return fail(400, 'MCP-Name header mismatch');
        }
        return ok({ contents: [{ uri: params.uri, mimeType: 'text/markdown', text: SKILL_BODY }] });
      }
      if (body.method === 'tools/call') {
        if (captured.nameHeader !== params.name) {
          return fail(400, 'MCP-Name header mismatch');
        }
        if (params.name === 'network_fail_echo') {
          return ok({
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  code: 'INVALID_ARGUMENT',
                  message: `mock failure ${captured.authorization ?? ''}`,
                  details: {
                    echoed: captured.authorization ?? '',
                    nested: { token: TOKEN },
                    retryable: false,
                  },
                }),
              },
            ],
          });
        }
        if (params.name === 'network_drivefail') {
          const error = {
            code: 'FILE_UNAVAILABLE',
            parameter: 'fileId',
            retryable: false,
          };
          return ok({
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(error) }],
            structuredContent: { error },
          });
        }
        let result: Record<string, unknown>;
        if (params.name === 'network_message_send') {
          if (state.send === 'fail') {
            return ok({
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    code: 'ROOM_DISSOLVED',
                    message: 'room dissolved',
                  }),
                },
              ],
            });
          }
          result = {
            message: {
              message_id: 'msg_mock',
              created_seq: '42',
              preview: String(params.arguments?.body ?? ''),
            },
            delivery_ids: ['dlv_mock'],
          };
        } else if (params.name === 'network_inbox_list') {
          result = {
            items: [state.inbox === 'claimed' ? CLAIMED_DELIVERY : PENDING_DELIVERY],
            next_cursor: 'cursor_inbox_1',
            has_more: true,
            pending_count: 1,
            claimed_delivery_id: state.inbox === 'claimed' ? 'dlv_mock' : null,
          };
        } else if (params.name === 'network_delivery_claim') {
          result = CLAIMED_DELIVERY;
        } else if (params.name === 'network_delivery_complete') {
          result = { delivery: COMPLETED_DELIVERY, message: REPLY_MESSAGE };
        } else if (params.name === 'network_rooms_list') {
          result = {
            items: [
              {
                room_id: 'rm_mock',
                kind: 'group',
                title: 'Mock Room',
                head_seq: '9',
                my_last_read_seq: '8',
                member_count: 2,
                status: 'active',
                last_message: { preview: 'hello' },
              },
            ],
            next_cursor: 'room_cursor',
            has_more: true,
          };
        } else if (params.name === 'network_history_list') {
          if (params.arguments?.view === 'timeline') {
            result = {
              items: [],
              next_cursor: null,
              has_more: false,
              snapshot: 'snap',
              head_seq: '9',
              view: 'timeline',
              timeline_items: [
                {
                  ...MOCK_MESSAGE,
                  kind: 'message',
                  room_id: 'rm_mock',
                  reply_to: null,
                  root_id: null,
                  task_root_id: null,
                  hop: 0,
                  delivery_states: {},
                  mentions: [],
                  delivery_claimed_at: null,
                  delivery_updated_at: null,
                  timeline_seq: '10',
                },
                {
                  kind: 'presence',
                  presence_event_id: 'pe_mock',
                  room_id: 'rm_mock',
                  agent_id: 'actor_mock',
                  transition: 'online',
                  occurred_at: '2026-11-04T00:00:00.000Z',
                  recorded_at: '2026-11-04T00:00:01.000Z',
                  timeline_seq: '11',
                  time_basis: 'observed',
                },
              ],
              timeline_next_cursor: 'tl_cursor',
              timeline_has_more: true,
              timeline_snapshot: 'tl_snap',
              timeline_resume_cursor: 'tl_cursor',
            };
          } else {
            result = {
              items: [
                {
                  ...MOCK_MESSAGE,
                  sender_kind: 'agent',
                  room_id: 'rm_mock',
                  reply_to: null,
                  root_id: null,
                  task_root_id: null,
                  hop: 0,
                  delivery_states: {},
                  mentions: [],
                  delivery_claimed_at: null,
                  delivery_updated_at: null,
                },
              ],
              next_cursor: 'hist_cursor',
              has_more: true,
              snapshot: 'snap',
              head_seq: '9',
            };
          }
        } else if (params.name === 'network_task_trace') {
          result = {
            root_message_id: 'msg_root',
            items: [
              {
                message_id: 'msg_root',
                sender_id: 'actor_mock',
                sender_name: 'Mock Sender',
                sender_kind: 'agent',
                created_seq: '7',
                created_at: '2026-11-04T00:00:00.000Z',
                preview: 'root task',
                body_bytes: 9,
                recalled: false,
                role: 'root',
                reply_to: null,
                referenced_by: null,
                has_unavailable_reference: false,
              },
            ],
            next_cursor: 'trace_next',
            prev_cursor: 'trace_prev',
            has_more_before: true,
            has_more_after: false,
            message_count: 1,
            focus_message_id: null,
            authorization: {},
          };
        } else if (params.name === 'network_task_search') {
          result = {
            items: [
              {
                task: {
                  root_message_id: 'msg_root',
                  room_id: 'rm_mock',
                  preview: 'root task',
                  root_sender_id: 'actor_mock',
                  root_sender_name: 'Mock Sender',
                  root_sender_kind: 'agent',
                  root_created_at: '2026-11-04T00:00:00.000Z',
                  root_created_seq: '7',
                  participants: [],
                  participant_count: 0,
                  message_count: 1,
                  can_unmark: true,
                },
                hit_count: 1,
                matches: [
                  { message_id: 'msg_mock', snippet: 'hello', created_seq: '42' },
                ],
              },
            ],
            next_cursor: 'search_next',
            has_more: true,
            snapshot: 'snap',
            authorization: {},
            truncated: false,
          };
        } else if (params.name === 'network_message_read') {
          const cursor = params.arguments?.chunk_cursor;
          result =
            cursor === undefined
              ? {
                  message_id: 'msg_mock',
                  room_id: 'rm_mock',
                  chunk: 'Hello ',
                  chunk_cursor: 'c1',
                  next_cursor: 'c1',
                  eof: false,
                  body_bytes: 11,
                  created_seq: '42',
                }
              : {
                  message_id: 'msg_mock',
                  room_id: 'rm_mock',
                  chunk: '世界',
                  chunk_cursor: 'c2',
                  next_cursor: null,
                  eof: true,
                  body_bytes: 11,
                  created_seq: '42',
                };
        } else if (params.name === 'network_message_send_status') {
          const ids = Array.isArray(params.arguments?.client_message_ids)
            ? (params.arguments?.client_message_ids as unknown[]).map(String)
            : [];
          result = {
            items: ids.map((id) =>
              id === 'msg_known'
                ? {
                    client_message_id: id,
                    found: true,
                    message_id: 'msg_mock',
                    room_id: 'rm_mock',
                    created_seq: '42',
                    delivery_ids: ['dlv_mock'],
                    body_bytes: 5,
                    created_at: '2026-11-04T00:00:00.000Z',
                  }
                : {
                    client_message_id: id,
                    found: false,
                    message_id: null,
                    room_id: null,
                    created_seq: null,
                    delivery_ids: [],
                    body_bytes: null,
                    created_at: null,
                  },
            ),
          };
        } else if (params.name === 'network_issue_token') {
          result = {
            token: 'ank_issued_mock',
            url: 'https://example.test/mcp?token=ank_issued_mock',
          };
        } else if (params.name === 'network_register') {
          result = {
            actor_id: 'actor_registered',
            kind: 'agent',
            agent_session_id: 'sess_mock',
            name: 'Mock Agent',
            metadata: {},
            pending_count: 0,
            inbox_head_seq: '0',
            created_at: '2026-11-04T00:00:00.000Z',
            share_url: null,
            resources: [],
          };
        } else if (params.name === 'network_file_upload_prepare') {
          if (state.prepare === 'too-large') {
            return ok({
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    code: 'INVALID_ARGUMENT',
                    message: 'size: Too big: expected number to be <= 1048576',
                  }),
                },
              ],
            });
          }
          const input = params.arguments ?? {};
          const name = String(input.name ?? 'file');
          const mime = String(input.mime_type ?? 'application/octet-stream');
          result = {
            actor_id: 'actor_mock',
            upload_url: `${origin}/mcp-upload`,
            method: 'POST',
            headers: {
              'X-WeBots-Upload-Ticket': 'ticket-mock',
              'MCPP-Files-Version': '1',
              'Content-Type': mime,
              'MCPP-File-Name': encodeURIComponent(name),
              'MCPP-File-Size': String(input.size ?? 0),
              'MCPP-File-Sha256': String(input.sha256 ?? ''),
            },
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            max_file_bytes: 1024 * 1024,
          };
        } else if (params.name === 'network_room_file_bind') {
          const fileId = String(params.arguments?.file_id ?? UPLOAD_FILE_ID);
          result = {
            file: mockRoomFile(origin, fileId, {
              room_id: String(params.arguments?.room_id ?? 'rm_mock'),
              size: UPLOAD_BODY.length,
              sha256: UPLOAD_SHA,
            }),
            authorization: {},
          };
        } else if (params.name === 'network_room_file_get') {
          const fileId = String(params.arguments?.file_id ?? UPLOAD_FILE_ID);
          result = {
            file: mockRoomFile(origin, fileId, {
              room_id: String(params.arguments?.room_id ?? 'rm_mock'),
            }),
            authorization: {},
          };
        } else if (params.name === 'network_room_file_list') {
          result = {
            items: [
              mockRoomFile(origin, UPLOAD_FILE_ID),
              mockRoomFile(origin, `f_${'B'.repeat(22)}`, {
                room_file_id: 'rf_second',
                name: 'notes.md',
                mime_type: 'text/markdown',
              }),
            ],
            next_cursor: 'file_cursor',
            has_more: true,
            authorization: {},
            quota: {
              used_bytes: 26,
              limit_bytes: 1024,
              used_files: 2,
              limit_files: 10,
              retained_bytes: 0,
            },
          };
        } else if (params.name === 'network_room_file_delete') {
          result = {
            file_id: String(params.arguments?.file_id ?? UPLOAD_FILE_ID),
            deleted: true,
          };
        } else if (params.name === 'drive_file_info') {
          const fileId = String(params.arguments?.fileId ?? UPLOAD_FILE_ID);
          result = {
            fileId,
            name: 'report.txt',
            mimeType: 'text/plain',
            size: DOWNLOAD_BODY.length,
            sha256: DOWNLOAD_SHA,
            createdAt: '2026-11-04T00:00:00.000Z',
            expiresAt: '2026-12-04T00:00:00.000Z',
            state: 'draft',
            visibility: 'private',
            retained: false,
            publicUrl: `${origin}/f/${fileId}`,
            previewUrl: `${origin}/f/${fileId}?t=${SIGNED_MARKER}`,
            downloadUrl: `${origin}/f/${fileId}?t=${SIGNED_MARKER}&download=1`,
            quota: { used_bytes: 13, limit_bytes: 1024, used_files: 1, limit_files: 10 },
          };
        } else {
          result = { echo: params.arguments ?? {} };
        }
        return ok({
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        });
      }
      return Response.json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32601, message: 'method not found' },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls,
    uploads,
    state,
    stop() {
      server.stop(true);
    },
  };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runProcess(
  command: string[],
  options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const proc = Bun.spawn(command, {
    cwd: ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 30_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function runCli(
  baseUrl: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<RunResult> {
  return runProcess([process.execPath, CLI, ...args], {
    env: { AGENTNET_URL: baseUrl, AGENTNET_TOKEN: TOKEN, ...extraEnv },
  });
}

async function fileHash(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await Bun.file(path).bytes()).digest('hex');
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'agentnet-cli-'));
  const uploadPath = join(workDir, 'report.txt');
  await Bun.write(uploadPath, UPLOAD_BODY);
  const mock = startMock();
  try {
    const help = await runCli(mock.baseUrl, ['--help']);
    checkEqual('agentnet --help 退出 0', help.code, 0);
    for (const marker of ['skills', 'agentnet', 'monitor', 'login', 'call']) {
      check(`--help 列出 ${marker}`, help.stdout.includes(marker));
    }
    for (const section of [
      '首次初始化（没有 token）',
      '接入已有身份',
      '常用操作',
      '监控（宿主差异）',
      '调试/覆盖',
      '可复制示例',
      'token 等同密码',
    ]) {
      check(`--help 包含「${section}」`, help.stdout.includes(section), help.stdout);
    }
    check(
      '--help 首次初始化含 issue/register/login/me',
      help.stdout.includes('agentnet --url <mcp-url> issue') &&
        help.stdout.includes('register --name') &&
        help.stdout.includes('me\n'),
      help.stdout,
    );
    const initSection = help.stdout.slice(
      help.stdout.indexOf('首次初始化（没有 token）'),
      help.stdout.indexOf('接入已有身份'),
    );
    check(
      '--help 首次初始化示例不含 --room',
      initSection.length > 0 &&
        !initSection.includes('--room') &&
        initSection.includes('monitor --harness <claude|codex|peri|dsh|other>') &&
        initSection.includes('登录后立即启动监听'),
      initSection,
    );
    check(
      '--help 说明登录、me 与 monitor 不需要 room_id',
      help.stdout.includes('登录、me 与 monitor 不需要 room_id') &&
        help.stdout.includes('处理投递时用事件里的 room_id') &&
        help.stdout.includes('主动发消息再加 --room'),
      help.stdout,
    );
    check(
      '--help 提供 up 登录并监听入口',
      help.stdout.includes('agentnet up --harness <name>') &&
        help.stdout.includes('agentnet up --harness codex'),
      help.stdout,
    );
    check(
      '--help 监控示例含五种 harness 与 --check',
      help.stdout.includes('monitor --harness claude|codex|peri|dsh|other') &&
        help.stdout.includes('--check') &&
        help.stdout.includes('agentnet skills --harness <name>'),
      help.stdout,
    );
    check(
      '--help DSH 只说明启动时自动检测，不暴露 install 命令',
      help.stdout.includes('run/start 自动检测 DSH 版本') &&
        !help.stdout.includes('monitor --harness dsh install') &&
        !help.stdout.includes('--profile <name>') &&
        !help.stdout.includes('--session <id>'),
      help.stdout,
    );

    for (const command of ['send', 'inbox', 'reply', 'task', 'monitor', 'up', 'skills']) {
      const subHelp = await runCli(mock.baseUrl, [command, '--help']);
      checkEqual(`${command} --help 退出 0`, subHelp.code, 0);
      check(`${command} --help 含示例`, subHelp.stdout.includes('示例'), subHelp.stdout);
    }

    const skillsHarnessList = await runCli(mock.baseUrl, ['skills']);
    checkEqual('skills 无 --harness 退出 0', skillsHarnessList.code, 0);
    for (const harness of ['claude', 'codex', 'peri', 'dsh', 'other']) {
      check(`skills 列表包含 ${harness}`, skillsHarnessList.stdout.includes(harness));
    }
    const callsBeforeGuides = mock.calls.length;
    for (const harness of ['claude', 'codex', 'peri', 'dsh', 'other']) {
      const guide = await runCli(mock.baseUrl, ['skills', '--harness', harness]);
      checkEqual(`skills --harness ${harness} 退出 0`, guide.code, 0);
      check(
        `skills --harness ${harness} 输出本宿主指南`,
        guide.stdout.includes(`HARNESS ${harness}`) &&
          guide.stdout.includes(`monitor --harness ${harness}`) &&
          guide.stdout.includes('reply --delivery') &&
          guide.stdout.includes('群聊 @ 规则') &&
          guide.stdout.includes('CREDENTIAL_INVALID'),
        guide.stdout,
      );
      if (harness === 'dsh') {
        check(
          'DSH 指南只要求直接启动并自动检测插件',
          guide.stdout.includes('自动检测') &&
            guide.stdout.includes('缺失时自动添加') &&
            !guide.stdout.includes('dsh install'),
          guide.stdout,
        );
      }
      check(
        `skills --harness ${harness} 不输出 token`,
        !guide.stdout.includes(TOKEN) && !guide.stderr.includes(TOKEN),
      );
      const loginAndMonitor = guide.stdout.slice(
        guide.stdout.indexOf('2. 上线并确认身份'),
        guide.stdout.indexOf('4. 处理投递'),
      );
      check(
        `skills --harness ${harness} 登录后立即启动监听且不需要 room`,
        loginAndMonitor.length > 0 &&
          !loginAndMonitor.includes('--room') &&
          loginAndMonitor.includes('登录后立即启动监听') &&
          loginAndMonitor.includes('agentnet up --harness <name>') &&
          guide.stdout.includes('登录、me 与 monitor 只需要 URL 与 token，不需要 room_id。') &&
          guide.stdout.includes('room_id 来自投递事件'),
        guide.stdout,
      );
    }
    checkEqual(
      'skills --harness 是纯本地指南，不调用 MCP',
      mock.calls.length,
      callsBeforeGuides,
    );
    const skillsHarnessJson = await runCli(mock.baseUrl, [
      'skills',
      '--harness',
      'codex',
      '--json',
    ]);
    checkEqual('skills --harness --json 退出 0', skillsHarnessJson.code, 0);
    check(
      'skills --harness --json 带 harness 与简短指南',
      (() => {
        const payload = JSON.parse(skillsHarnessJson.stdout) as {
          harness?: string;
          text?: string;
        };
        return payload.harness === 'codex' && (payload.text ?? '').includes('HARNESS codex');
      })(),
      skillsHarnessJson.stdout,
    );
    const badSkillsHarness = await runCli(mock.baseUrl, ['skills', '--harness', 'nope']);
    check('未知 skills harness 退出非 0', badSkillsHarness.code !== 0);
    check(
      '未知 skills harness 给出可读错误',
      badSkillsHarness.stderr.includes('未知 harness') &&
        badSkillsHarness.stderr.includes('claude|codex|peri|dsh|other'),
      badSkillsHarness.stderr,
    );

    const missingSendBody = await runCli(mock.baseUrl, ['send', '--room', 'rm_mock']);
    check('缺少 --body 退出非 0', missingSendBody.code !== 0);
    check(
      '缺少 --body 指向 send 示例',
      missingSendBody.stderr.includes('agentnet send --help'),
      missingSendBody.stderr,
    );

    const list = await runCli(mock.baseUrl, ['skills', 'list', '--json']);
    checkEqual('skills list 退出 0', list.code, 0);
    check('skills list 输出不含 token', !list.stdout.includes(TOKEN) && !list.stderr.includes(TOKEN));
    const listed = JSON.parse(list.stdout) as {
      skills?: { frontmatter?: { name?: string } }[];
    };
    checkEqual('skills list 返回 agent-network', listed.skills?.[0]?.frontmatter?.name, 'agent-network');
    const listCall = mock.calls.filter((call) => call.method === 'skills/list').at(-1);
    checkEqual('skills list 使用 MCP-Protocol-Version', listCall?.protocolVersion, PROTOCOL_VERSION);
    checkEqual('skills list 的 MCP-Method 正确', listCall?.methodHeader, 'skills/list');

    const humanList = await runCli(mock.baseUrl, ['skills', 'list']);
    check('skills list 人类输出包含技能名', humanList.stdout.includes('agent-network'));

    const get = await runCli(mock.baseUrl, ['skills', 'get', 'agent-network', '--json']);
    checkEqual('skills get 退出 0', get.code, 0);
    const got = JSON.parse(get.stdout) as { skill?: { uri?: string }; text?: string };
    checkEqual('skills get 解析 name 到 URI', got.skill?.uri, SKILL_URI);
    check('skills get 返回 SKILL.md 正文', got.text === SKILL_BODY);
    const readCall = mock.calls.filter((call) => call.method === 'resources/read').at(-1);
    checkEqual('resources/read 携带 MCP-Name', readCall?.nameHeader, SKILL_URI);

    const send = await runCli(mock.baseUrl, [
      'send',
      '--room',
      'rm_mock',
      '--body',
      'hello 世界',
      '--json',
    ]);
    checkEqual('send 退出 0', send.code, 0);
    const sent = JSON.parse(send.stdout) as { delivery_ids?: string[] };
    checkEqual('send 返回 delivery_ids', sent.delivery_ids?.join(','), 'dlv_mock');
    const sendCall = mock.calls.filter((call) => call.tool === 'network_message_send').at(-1);
    check('send 自动生成 request_id', typeof sendCall?.arguments?.request_id === 'string');
    check('send 自动生成 client_message_id', typeof sendCall?.arguments?.client_message_id === 'string');
    checkEqual('send 透传 room_id', sendCall?.arguments?.room_id, 'rm_mock');
    checkEqual('send 透传正文', sendCall?.arguments?.body, 'hello 世界');
    check('未传 --invoke 时省略 invoke', sendCall?.arguments?.invoke === undefined);
    checkEqual('send 使用 Bearer token', sendCall?.authorization, `Bearer ${TOKEN}`);

    const explicitEmpty = await runCli(mock.baseUrl, [
      'send',
      '--room',
      'rm_mock',
      '--body',
      'noop',
      '--invoke',
      '',
      '--json',
    ]);
    checkEqual('显式空 invoke 退出 0', explicitEmpty.code, 0);
    const emptyInvokeCall = mock.calls
      .filter((call) => call.tool === 'network_message_send')
      .at(-1);
    check(
      '--invoke 空串发送 invoke: []',
      Array.isArray(emptyInvokeCall?.arguments?.invoke) &&
        (emptyInvokeCall?.arguments?.invoke as unknown[]).length === 0,
      emptyInvokeCall?.arguments,
    );

    const conflictingInvoke = await runCli(mock.baseUrl, [
      'send',
      '--room',
      'rm_mock',
      '--body',
      'conflict',
      '--invoke',
      'actor_worker',
      '--no-invoke',
    ]);
    check('--invoke 与 --no-invoke 同时出现退出非 0', conflictingInvoke.code !== 0);
    check(
      '--invoke 与 --no-invoke 冲突给出可读错误',
      conflictingInvoke.stderr.includes('--invoke 与 --no-invoke 不能同时使用'),
      conflictingInvoke.stderr,
    );

    const inbox = await runCli(mock.baseUrl, ['inbox', '--json']);
    checkEqual('inbox 退出 0', inbox.code, 0);
    const inboxPage = JSON.parse(inbox.stdout) as {
      items?: { delivery_id?: string }[];
      pending_count?: number;
    };
    checkEqual('inbox 返回投递', inboxPage.items?.[0]?.delivery_id, 'dlv_mock');
    checkEqual('inbox 返回 pending_count', inboxPage.pending_count, 1);

    const call = await runCli(mock.baseUrl, ['call', 'network_echo', '{"n":1,"s":"x"}', '--json']);
    checkEqual('call 退出 0', call.code, 0);
    const echoed = JSON.parse(call.stdout) as { echo?: { n?: number; s?: string } };
    checkEqual('call 透传 JSON 参数', echoed.echo?.n, 1);
    checkEqual('call 透传字符串参数', echoed.echo?.s, 'x');

    const failed = await runCli(mock.baseUrl, ['call', 'network_fail_echo', '{}', '--json']);
    check('工具错误退出非 0', failed.code !== 0);
    check(
      '错误输出不含 token',
      !failed.stdout.includes(TOKEN) && !failed.stderr.includes(TOKEN),
      failed.stderr,
    );
    check('错误输出经过脱敏', failed.stderr.includes('[REDACTED]'), failed.stderr);

    const monitor = await runCli(mock.baseUrl, ['monitor', '--harness', 'peri', '--check'], {
      AGENTNET_URL: undefined,
    });
    checkEqual('monitor peri --check 退出 0', monitor.code, 0);
    check('monitor peri --check 标记 TS 引擎', monitor.stdout.includes('engine=ts'));
    check('monitor peri --check 声明不读正文', monitor.stdout.includes('read_body=0'));
    check('monitor --check 输出不含 token', !monitor.stdout.includes(TOKEN));

    const monitorArgs = await runCli(
      mock.baseUrl,
      ['monitor', '--harness', 'peri', '--check', '--', '--interval', '5'],
      { AGENTNET_URL: undefined },
    );
    check('monitor peri 拒绝旧脚本参数', monitorArgs.code !== 0);
    check('monitor peri 提示位置参数', monitorArgs.stderr.includes('不接受位置参数'));

    const codexMonitor = await runCli(mock.baseUrl, ['monitor', '--harness', 'codex', '--check'], {
      AGENTNET_URL: undefined,
      AGENTNET_CODEX_SOCKET: '/tmp/agentnet-codex-check.sock',
    });
    checkEqual('monitor codex --check 退出 0', codexMonitor.code, 0);
    check('monitor codex 标记 TS 引擎', codexMonitor.stdout.includes('engine=ts'));
    check('monitor codex 声明 app-server 传输', codexMonitor.stdout.includes('transport=app-server-ws'));
    check('monitor codex 不再定位旧脚本', !codexMonitor.stdout.includes('codex-watch.sh'));

    const codexMonitorArgs = await runCli(
      mock.baseUrl,
      ['monitor', '--harness', 'codex', '--check', '--', '--interval', '5'],
      { AGENTNET_URL: undefined },
    );
    check('monitor codex 拒绝旧脚本参数', codexMonitorArgs.code !== 0);
    check('monitor codex 提示位置参数', codexMonitorArgs.stderr.includes('不接受位置参数'));

    const badHarness = await runCli(mock.baseUrl, ['monitor', '--harness', 'unknown', '--check'], {
      AGENTNET_URL: undefined,
    });
    check('未知 harness 退出非 0', badHarness.code !== 0);
    check('未知 harness 给出可读错误', badHarness.stderr.includes('未知 harness'));

    const login = await runCli(mock.baseUrl, ['login']);
    checkEqual('login 不传 room 退出 0', login.code, 0);
    check('login 输出上线结果', login.stdout.includes('已上线'), login.stdout);
    const loginCall = mock.calls.filter((call) => call.tool === 'network_login').at(-1);
    check(
      'login 不发送 room_id',
      Boolean(loginCall) && !('room_id' in (loginCall?.arguments ?? {})),
      loginCall?.arguments,
    );

    const me = await runCli(mock.baseUrl, ['me']);
    checkEqual('me 不传 room 退出 0', me.code, 0);
    const meCall = mock.calls.filter((call) => call.tool === 'network_me').at(-1);
    check(
      'me 不发送 room_id',
      Boolean(meCall) && !('room_id' in (meCall?.arguments ?? {})),
      meCall?.arguments,
    );

    const loginCallsBeforeUp = mock.calls.filter((call) => call.tool === 'network_login').length;
    const upCheck = await runCli(mock.baseUrl, ['up', '--harness', 'peri', '--check']);
    checkEqual('up --check 退出 0', upCheck.code, 0);
    check('up --check 校验 harness', upCheck.stdout.includes('engine=ts'), upCheck.stdout);
    checkEqual(
      'up --check 不登录',
      mock.calls.filter((call) => call.tool === 'network_login').length,
      loginCallsBeforeUp,
    );
    const upBadHarness = await runCli(mock.baseUrl, ['up', '--harness', 'unknown']);
    check('up 未知 harness 退出非 0', upBadHarness.code !== 0);
    check(
      'up 未知 harness 给出可读错误',
      upBadHarness.stderr.includes('未知 harness'),
      upBadHarness.stderr,
    );

    const upNoToken = await runCli(mock.baseUrl, ['up', '--harness', 'peri'], {
      AGENTNET_TOKEN: undefined,
    });
    check('up 缺少 token 退出非 0', upNoToken.code !== 0);
    check(
      'up 缺少 token 提示先 issue/register',
      upNoToken.stderr.includes('缺少 token') &&
        upNoToken.stderr.includes('issue') &&
        upNoToken.stderr.includes('register'),
      upNoToken.stderr,
    );

    const upLog = join(workDir, 'up-watch.log');
    await Bun.write(upLog, '');
    const upListen = await runCli(mock.baseUrl, [
      'up',
      '--harness',
      'other',
      '--log',
      upLog,
      '--max-wait',
      '1',
      '--poll',
      '1',
    ]);
    checkEqual('up 登录后启动监听退出 0', upListen.code, 0);
    check('up 先登录再监听', upListen.stdout.includes('已上线'), upListen.stdout);
    checkEqual(
      'up 实际调用 login',
      mock.calls.filter((call) => call.tool === 'network_login').length,
      loginCallsBeforeUp + 1,
    );
    check('up 启动监听后输出哨兵结果', upListen.stdout.includes('WAKE'), upListen.stdout);

    // ---- 输出契约：分页、timeline、嵌套 delivery ----
    const roomsHuman = await runCli(mock.baseUrl, ['rooms']);
    checkEqual('rooms 人类输出退出 0', roomsHuman.code, 0);
    check(
      'rooms 人类输出 next_cursor/has_more',
      roomsHuman.stdout.includes('next_cursor=room_cursor') &&
        roomsHuman.stdout.includes('has_more=true'),
      roomsHuman.stdout,
    );

    const inboxHuman = await runCli(mock.baseUrl, ['inbox']);
    checkEqual('inbox 人类输出退出 0', inboxHuman.code, 0);
    check('inbox 人类输出 message_id', inboxHuman.stdout.includes('message_id=msg_mock'), inboxHuman.stdout);
    check('inbox 人类输出 claim_id', inboxHuman.stdout.includes('claim_id=-'), inboxHuman.stdout);
    check(
      'inbox 人类输出分页与 claimed_delivery_id',
      inboxHuman.stdout.includes('next_cursor=cursor_inbox_1') &&
        inboxHuman.stdout.includes('has_more=true') &&
        inboxHuman.stdout.includes('claimed_delivery_id=-'),
      inboxHuman.stdout,
    );

    const claimHuman = await runCli(mock.baseUrl, ['claim', 'dlv_mock']);
    checkEqual('claim 人类输出退出 0', claimHuman.code, 0);
    check(
      'claim 输出 message_id/room_id',
      claimHuman.stdout.includes('message_id=msg_mock') &&
        claimHuman.stdout.includes('room_id=rm_mock'),
      claimHuman.stdout,
    );
    check(
      'claim 输出 claim_id/state',
      claimHuman.stdout.includes('claim_id=clm_mock') &&
        claimHuman.stdout.includes('state=claimed'),
      claimHuman.stdout,
    );

    const completeJson = await runCli(mock.baseUrl, [
      'complete',
      'dlv_mock',
      '--attempt',
      '1',
      '--claim-id',
      'clm_mock',
      '--json',
    ]);
    checkEqual('complete 退出 0', completeJson.code, 0);
    const completed = JSON.parse(completeJson.stdout) as {
      delivery?: { delivery_id?: string; state?: string };
      message?: { message_id?: string };
    };
    checkEqual('complete JSON 保留嵌套 delivery', completed.delivery?.delivery_id, 'dlv_mock');
    checkEqual('complete JSON delivery state', completed.delivery?.state, 'completed');
    checkEqual('complete JSON 保留最终 message', completed.message?.message_id, 'msg_reply');

    const completeHuman = await runCli(mock.baseUrl, [
      'complete',
      'dlv_mock',
      '--attempt',
      '1',
      '--claim-id',
      'clm_mock',
    ]);
    check(
      'complete 人类输出读取嵌套 delivery',
      completeHuman.stdout.includes('delivery_id=dlv_mock') &&
        completeHuman.stdout.includes('state=completed') &&
        completeHuman.stdout.includes('attempt=1') &&
        completeHuman.stdout.includes('claim_id=clm_mock'),
      completeHuman.stdout,
    );
    check(
      'complete 人类输出 message_id/final_message_id',
      completeHuman.stdout.includes('message_id=msg_mock') &&
        completeHuman.stdout.includes('final_message_id=msg_reply'),
      completeHuman.stdout,
    );

    const historyHuman = await runCli(mock.baseUrl, ['history', '--room', 'rm_mock']);
    check(
      'history 人类输出分页游标',
      historyHuman.stdout.includes('next_cursor=hist_cursor') &&
        historyHuman.stdout.includes('has_more=true'),
      historyHuman.stdout,
    );
    const timelineHuman = await runCli(mock.baseUrl, [
      'history',
      '--room',
      'rm_mock',
      '--timeline',
    ]);
    check(
      'history --timeline 读取 timeline_items',
      timelineHuman.stdout.includes('TIMELINE') && timelineHuman.stdout.includes('msg_mock'),
      timelineHuman.stdout,
    );
    check(
      'history --timeline 输出上下线系统项',
      timelineHuman.stdout.includes('[presence] online') &&
        timelineHuman.stdout.includes('actor_mock'),
      timelineHuman.stdout,
    );
    check(
      'history --timeline 使用 timeline 游标',
      timelineHuman.stdout.includes('next_cursor=tl_cursor') &&
        timelineHuman.stdout.includes('has_more=true'),
      timelineHuman.stdout,
    );

    const traceHuman = await runCli(mock.baseUrl, [
      'task',
      'trace',
      '--room',
      'rm_mock',
      '--root',
      'msg_root',
    ]);
    check(
      'task trace 输出 next/prev 游标',
      traceHuman.stdout.includes('next_cursor=trace_next') &&
        traceHuman.stdout.includes('prev_cursor=trace_prev') &&
        traceHuman.stdout.includes('has_more_before=true'),
      traceHuman.stdout,
    );
    const searchHuman = await runCli(mock.baseUrl, [
      'task',
      'search',
      '--room',
      'rm_mock',
      '--query',
      'hello',
    ]);
    check(
      'task search 输出分页游标',
      searchHuman.stdout.includes('next_cursor=search_next') &&
        searchHuman.stdout.includes('has_more=true'),
      searchHuman.stdout,
    );

    // ---- 结构化错误、details 与 Drive 兜底 ----
    const failedJson = await runCli(mock.baseUrl, [
      'call',
      'network_fail_echo',
      '{}',
      '--json',
    ]);
    check('--json 错误退出非 0', failedJson.code !== 0);
    const errorPayload = JSON.parse(failedJson.stderr) as {
      error?: {
        code?: string;
        message?: string;
        details?: { echoed?: string; nested?: { token?: string } };
      };
    };
    checkEqual('--json 错误 code 保留', errorPayload.error?.code, 'INVALID_ARGUMENT');
    check(
      '--json 错误 message 脱敏',
      errorPayload.error?.message?.includes('[REDACTED]') === true,
      errorPayload.error?.message,
    );
    checkEqual(
      '--json 错误 details 递归脱敏并保留',
      errorPayload.error?.details?.nested?.token,
      '[REDACTED]',
    );
    checkEqual(
      '--json 错误 details 中的 Bearer 脱敏',
      errorPayload.error?.details?.echoed,
      'Bearer [REDACTED]',
    );
    check(
      '--json 错误输出不含 token',
      !failedJson.stderr.includes(TOKEN) && !failedJson.stdout.includes(TOKEN),
      failedJson.stderr,
    );

    const driveJson = await runCli(mock.baseUrl, [
      'call',
      'network_drivefail',
      '{}',
      '--json',
    ]);
    check('Drive 错误退出非 0', driveJson.code !== 0);
    const driveError = JSON.parse(driveJson.stderr) as {
      error?: { code?: string; message?: string; details?: { parameter?: string } };
    };
    checkEqual('Drive 错误无 message 时用 code 兜底', driveError.error?.message, 'FILE_UNAVAILABLE');
    checkEqual('Drive 错误 code 保留', driveError.error?.code, 'FILE_UNAVAILABLE');
    checkEqual('Drive 错误 details 保留附加字段', driveError.error?.details?.parameter, 'fileId');
    const driveHuman = await runCli(mock.baseUrl, ['call', 'network_drivefail', '{}']);
    check(
      'Drive 错误人类输出 code 兜底',
      driveHuman.stderr.includes('ERROR [FILE_UNAVAILABLE] FILE_UNAVAILABLE'),
      driveHuman.stderr,
    );

    // ---- read / reply / send --claim / send-status ----
    const readFirst = await runCli(mock.baseUrl, ['read', '--message', 'msg_mock']);
    checkEqual('read 退出 0', readFirst.code, 0);
    check('read 人类输出正文块', readFirst.stdout.includes('Hello'), readFirst.stdout);
    check(
      'read 人类输出 eof/next_cursor',
      readFirst.stdout.includes('eof=false') && readFirst.stdout.includes('next_cursor=c1'),
      readFirst.stdout,
    );
    const messageReadCall = mock.calls
      .filter((call) => call.tool === 'network_message_read')
      .at(-1);
    checkEqual('read 透传 message_id', messageReadCall?.arguments?.message_id, 'msg_mock');

    const readSecond = await runCli(mock.baseUrl, [
      'read',
      '--message',
      'msg_mock',
      '--cursor',
      'c1',
    ]);
    checkEqual('read 第二块退出 0', readSecond.code, 0);
    check('read 第二块正文', readSecond.stdout.includes('世界'), readSecond.stdout);
    check(
      'read 到 eof 清空 next_cursor',
      readSecond.stdout.includes('eof=true') && readSecond.stdout.includes('next_cursor=-'),
      readSecond.stdout,
    );
    const readSecondCall = mock.calls
      .filter((call) => call.tool === 'network_message_read')
      .at(-1);
    checkEqual('read 透传 chunk_cursor', readSecondCall?.arguments?.chunk_cursor, 'c1');

    const replyJson = await runCli(mock.baseUrl, [
      'reply',
      '--delivery',
      'dlv_mock',
      '--body',
      '完成 @Bob',
      '--json',
    ]);
    checkEqual('reply pending 退出 0', replyJson.code, 0);
    const replyPayload = JSON.parse(replyJson.stdout) as {
      message?: { message_id?: string };
      delivery?: { state?: string; claim_id?: string };
      request_id?: string;
      client_message_id?: string;
    };
    checkEqual('reply pending 发送 message_id', replyPayload.message?.message_id, 'msg_mock');
    checkEqual('reply pending complete 后状态', replyPayload.delivery?.state, 'completed');
    check(
      'reply 输出 request_id/client_message_id',
      typeof replyPayload.request_id === 'string' &&
        typeof replyPayload.client_message_id === 'string',
      replyPayload,
    );
    const replySend = mock.calls.filter((call) => call.tool === 'network_message_send').at(-1);
    checkEqual(
      'reply send 携带 claim',
      JSON.stringify(replySend?.arguments?.claim),
      JSON.stringify({ delivery_id: 'dlv_mock', attempt: 1, claim_id: 'clm_mock' }),
    );
    check('reply send 不显式派活', replySend?.arguments?.invoke === undefined);
    checkEqual('reply send 正文保留 @', replySend?.arguments?.body, '完成 @Bob');
    const replyComplete = mock.calls
      .filter((call) => call.tool === 'network_delivery_complete')
      .at(-1);
    check('reply complete 不带 final_body', replyComplete?.arguments?.final_body === undefined);
    checkEqual(
      'reply complete 使用现有 claim',
      `${replyComplete?.arguments?.attempt}/${replyComplete?.arguments?.claim_id}`,
      '1/clm_mock',
    );

    mock.state.inbox = 'claimed';
    const claimCountBefore = mock.calls.filter(
      (call) => call.tool === 'network_delivery_claim',
    ).length;
    const replyClaimed = await runCli(mock.baseUrl, [
      'reply',
      '--delivery',
      'dlv_mock',
      '--body',
      'claimed 分支',
      '--json',
    ]);
    checkEqual('reply claimed 退出 0', replyClaimed.code, 0);
    const claimCountAfter = mock.calls.filter(
      (call) => call.tool === 'network_delivery_claim',
    ).length;
    checkEqual('reply claimed 不重复 claim', claimCountAfter, claimCountBefore);
    const claimedSend = mock.calls.filter((call) => call.tool === 'network_message_send').at(-1);
    checkEqual(
      'reply claimed 复用 claim_id/attempt',
      JSON.stringify(claimedSend?.arguments?.claim),
      JSON.stringify({ delivery_id: 'dlv_mock', attempt: 1, claim_id: 'clm_mock' }),
    );
    mock.state.inbox = 'pending';

    const sendClaim = await runCli(mock.baseUrl, [
      'send',
      '--room',
      'rm_mock',
      '--body',
      '回执',
      '--claim',
      'dlv_mock:1:clm_mock',
      '--no-invoke',
      '--mention',
      'actor_human',
      '--json',
    ]);
    checkEqual('send --claim 退出 0', sendClaim.code, 0);
    const sendClaimCall = mock.calls
      .filter((call) => call.tool === 'network_message_send')
      .at(-1);
    checkEqual(
      'send --claim 解析 delivery:attempt:claim_id',
      JSON.stringify(sendClaimCall?.arguments?.claim),
      JSON.stringify({ delivery_id: 'dlv_mock', attempt: 1, claim_id: 'clm_mock' }),
    );
    check(
      'send --no-invoke 发送空 invoke',
      Array.isArray(sendClaimCall?.arguments?.invoke) &&
        (sendClaimCall?.arguments?.invoke as unknown[]).length === 0,
      sendClaimCall?.arguments,
    );
    checkEqual(
      'send --mention 作为 mentions',
      JSON.stringify(sendClaimCall?.arguments?.mentions),
      JSON.stringify(['actor_human']),
    );
    const sendClaimPayload = JSON.parse(sendClaim.stdout) as {
      request_id?: string;
      client_message_id?: string;
    };
    check(
      'send JSON 输出生成的 request_id/client_message_id',
      typeof sendClaimPayload.request_id === 'string' &&
        typeof sendClaimPayload.client_message_id === 'string',
      sendClaimPayload,
    );
    const sendHuman = await runCli(mock.baseUrl, ['send', '--room', 'rm_mock', '--body', 'hello']);
    check(
      'send 人类输出 request_id/client_message_id',
      sendHuman.stdout.includes('request_id=req_') &&
        sendHuman.stdout.includes('client_message_id=msg_'),
      sendHuman.stdout,
    );

    const statusJson = await runCli(mock.baseUrl, [
      'send-status',
      '--client-message-id',
      'msg_known,msg_missing',
      '--json',
    ]);
    checkEqual('send-status 退出 0', statusJson.code, 0);
    const statusPayload = JSON.parse(statusJson.stdout) as {
      items?: { client_message_id?: string; found?: boolean; message_id?: string | null }[];
    };
    checkEqual('send-status 返回两项', statusPayload.items?.length, 2);
    checkEqual('send-status found true', statusPayload.items?.[0]?.found, true);
    checkEqual('send-status found false', statusPayload.items?.[1]?.found, false);
    const statusCall = mock.calls
      .filter((call) => call.tool === 'network_message_send_status')
      .at(-1);
    checkEqual(
      'send-status 按 client_message_id 对账',
      JSON.stringify(statusCall?.arguments?.client_message_ids),
      JSON.stringify(['msg_known', 'msg_missing']),
    );
    const statusHuman = await runCli(mock.baseUrl, ['send', 'status', 'msg_known']);
    checkEqual('send status 别名退出 0', statusHuman.code, 0);
    check('send status 别名输出 found', statusHuman.stdout.includes('found=true'));

    // ---- 首次上线：issue 无 token，register 自动 request_id ----
    const issued = await runCli(mock.baseUrl, ['issue', '--json'], {
      AGENTNET_TOKEN: undefined,
    });
    checkEqual('issue 无 token 退出 0', issued.code, 0);
    const issuedPayload = JSON.parse(issued.stdout) as { token?: string; url?: string };
    checkEqual('issue 返回 token', issuedPayload.token, 'ank_issued_mock');
    checkEqual(
      'issue 返回 MCP URL',
      issuedPayload.url,
      'https://example.test/mcp?token=ank_issued_mock',
    );
    const issueCall = mock.calls.filter((call) => call.tool === 'network_issue_token').at(-1);
    checkEqual('issue 不携带 Authorization', issueCall?.authorization, null);
    const issueHuman = await runCli(mock.baseUrl, ['issue'], { AGENTNET_TOKEN: undefined });
    check(
      'issue 人类输出凭据与安全提示',
      issueHuman.stdout.includes('ank_issued_mock') &&
        issueHuman.stdout.includes('勿发群'),
      issueHuman.stdout,
    );

    const registered = await runCli(mock.baseUrl, [
      'register',
      '--name',
      'Mock Agent',
      '--session',
      'sess_mock',
      '--json',
    ]);
    checkEqual('register 退出 0', registered.code, 0);
    const registeredPayload = JSON.parse(registered.stdout) as {
      actor_id?: string;
      request_id?: string;
    };
    checkEqual('register 返回 actor_id', registeredPayload.actor_id, 'actor_registered');
    const registerCall = mock.calls.filter((call) => call.tool === 'network_register').at(-1);
    check(
      'register 自动生成 request_id',
      typeof registerCall?.arguments?.request_id === 'string' &&
        String(registerCall?.arguments?.request_id).startsWith('req_'),
      registerCall?.arguments,
    );
    checkEqual('register 默认 kind agent', registerCall?.arguments?.kind, 'agent');
    checkEqual(
      'register 透传 agent_session_id',
      registerCall?.arguments?.agent_session_id,
      'sess_mock',
    );

    const version = await runCli(mock.baseUrl, ['--version']);
    checkEqual('CLI 版本与 README 3.0 对齐', version.stdout.trim(), '3.0.0');
    for (const marker of ['issue', 'register', 'read --message', 'reply --delivery', 'send-status']) {
      check(`--help 列出 ${marker}`, help.stdout.includes(marker), help.stdout);
    }
    for (const marker of [
      'upload --file',
      'send-file --room',
      'download --room',
      'file-bind',
      'file-info',
    ]) {
      check(`--help 列出 ${marker}`, help.stdout.includes(marker), help.stdout);
    }

    // ---- 文件端到端：upload / send-file / download ----
    const uploadJson = await runCli(mock.baseUrl, ['upload', '--file', uploadPath, '--json']);
    checkEqual('upload 退出 0', uploadJson.code, 0);
    const uploaded = JSON.parse(uploadJson.stdout) as {
      file_id?: string;
      size?: number;
      sha256?: string;
      mime_type?: string;
      bound?: boolean;
    };
    checkEqual('upload 返回 file_id', uploaded.file_id, UPLOAD_FILE_ID);
    checkEqual('upload 校验本地 size', uploaded.size, UPLOAD_BODY.length);
    checkEqual('upload 校验本地 sha256', uploaded.sha256, UPLOAD_SHA);
    checkEqual('upload 返回 mime', uploaded.mime_type, 'text/plain');
    checkEqual('upload 未传 --room 时不绑定', uploaded.bound, false);
    check(
      'upload 输出不含 token',
      !uploadJson.stdout.includes(TOKEN) && !uploadJson.stderr.includes(TOKEN),
    );
    const uploadRequest = mock.uploads.at(-1);
    checkEqual('upload 使用票据而非 Bearer', uploadRequest?.authorization, null);
    checkEqual('upload 原样携带 prepare 票据', uploadRequest?.ticket, 'ticket-mock');
    checkEqual('upload POST 原始字节', uploadRequest?.bytes, UPLOAD_BODY.length);
    checkEqual('upload 携带 size 请求头', uploadRequest?.size, String(UPLOAD_BODY.length));
    checkEqual('upload 携带 sha256 请求头', uploadRequest?.sha256, UPLOAD_SHA);
    const prepareCall = mock.calls
      .filter((call) => call.tool === 'network_file_upload_prepare')
      .at(-1);
    checkEqual('upload prepare 传本地 sha256', prepareCall?.arguments?.sha256, UPLOAD_SHA);
    checkEqual('upload prepare 传文件名', prepareCall?.arguments?.name, 'report.txt');

    const boundUpload = await runCli(mock.baseUrl, [
      'upload',
      '--file',
      uploadPath,
      '--room',
      'rm_mock',
      '--json',
    ]);
    checkEqual('upload --room 退出 0', boundUpload.code, 0);
    const boundPayload = JSON.parse(boundUpload.stdout) as {
      bound?: boolean;
      room_file_id?: string;
      room_id?: string;
      preview_url?: string;
      download_url?: string;
    };
    checkEqual('upload --room 返回绑定状态', boundPayload.bound, true);
    checkEqual('upload --room 返回 room_file_id', boundPayload.room_file_id, 'rf_mock');
    check(
      'upload --room 返回预览与下载地址',
      typeof boundPayload.preview_url === 'string' &&
        boundPayload.preview_url.includes('/f/') &&
        typeof boundPayload.download_url === 'string' &&
        boundPayload.download_url.includes('download=1'),
      boundPayload,
    );
    const bindCall = mock.calls.filter((call) => call.tool === 'network_room_file_bind').at(-1);
    check(
      'upload --room 自动生成绑定 request_id',
      typeof bindCall?.arguments?.request_id === 'string' &&
        String(bindCall?.arguments?.request_id).startsWith('req_'),
      bindCall?.arguments,
    );
    checkEqual('upload --room 绑定到指定房间', bindCall?.arguments?.room_id, 'rm_mock');
    checkEqual('upload --room 绑定上传的 file_id', bindCall?.arguments?.file_id, UPLOAD_FILE_ID);

    mock.state.upload = 'sha-mismatch';
    const mismatch = await runCli(mock.baseUrl, ['upload', '--file', uploadPath, '--json']);
    check('sha 不一致退出非 0', mismatch.code !== 0);
    const mismatchError = JSON.parse(mismatch.stderr) as { error?: { code?: string; message?: string } };
    checkEqual('sha 不一致错误码', mismatchError.error?.code, 'UPLOAD_VERIFY_FAILED');
    check(
      'sha 不一致提示重新上传',
      mismatchError.error?.message?.includes('重新上传') === true,
      mismatch.stderr,
    );
    check(
      'sha 不一致不泄露 token/签名 URL',
      !mismatch.stderr.includes(TOKEN) && !mismatch.stderr.includes(SIGNED_MARKER),
      mismatch.stderr,
    );

    mock.state.upload = 'expired';
    const expired = await runCli(mock.baseUrl, ['upload', '--file', uploadPath, '--json']);
    check('票据过期退出非 0', expired.code !== 0);
    const expiredError = JSON.parse(expired.stderr) as { error?: { code?: string; message?: string } };
    checkEqual('票据过期错误码', expiredError.error?.code, 'UPLOAD_TICKET_EXPIRED');
    check(
      '票据过期提示重新执行 upload',
      expiredError.error?.message?.includes('票据') === true &&
        expiredError.error?.message?.includes('重新执行 upload') === true,
      expired.stderr,
    );
    check(
      '票据过期不泄露 token/签名 URL',
      !expired.stderr.includes(TOKEN) && !expired.stderr.includes(SIGNED_MARKER),
      expired.stderr,
    );
    mock.state.upload = 'ok';

    mock.state.prepare = 'too-large';
    const tooLarge = await runCli(mock.baseUrl, ['upload', '--file', uploadPath, '--json']);
    check('大小超限退出非 0', tooLarge.code !== 0);
    const tooLargeError = JSON.parse(tooLarge.stderr) as {
      error?: { code?: string; message?: string };
    };
    checkEqual('大小超限错误码', tooLargeError.error?.code, 'FILE_TOO_LARGE');
    check(
      '大小超限提示压缩或拆分',
      tooLargeError.error?.message?.includes('上限') === true &&
        tooLargeError.error?.message?.includes('压缩') === true,
      tooLarge.stderr,
    );
    mock.state.prepare = 'ok';

    const uploadsBeforeSendFile = mock.uploads.length;
    const sendFilePath = await runCli(mock.baseUrl, [
      'send-file',
      '--room',
      'rm_mock',
      '--file',
      uploadPath,
      '--body',
      '报告',
      '--no-invoke',
      '--json',
    ]);
    checkEqual('send-file 路径退出 0', sendFilePath.code, 0);
    const sendFilePayload = JSON.parse(sendFilePath.stdout) as {
      file_id?: string;
      room_file_id?: string;
      message?: { message_id?: string; created_seq?: string };
      delivery_ids?: string[];
      request_id?: string;
    };
    checkEqual('send-file 返回 file_id', sendFilePayload.file_id, UPLOAD_FILE_ID);
    checkEqual('send-file 返回 room_file_id', sendFilePayload.room_file_id, 'rf_mock');
    checkEqual('send-file 返回 message_id', sendFilePayload.message?.message_id, 'msg_mock');
    checkEqual('send-file 返回 delivery_ids', sendFilePayload.delivery_ids?.join(','), 'dlv_mock');
    check('send-file 返回 request_id', typeof sendFilePayload.request_id === 'string');
    checkEqual('send-file 路径只上传一次', mock.uploads.length, uploadsBeforeSendFile + 1);
    check(
      'send-file 输出不含 token/签名 URL',
      !sendFilePath.stdout.includes(TOKEN) &&
        !sendFilePath.stderr.includes(TOKEN) &&
        !sendFilePath.stdout.includes(SIGNED_MARKER) &&
        !sendFilePath.stderr.includes(SIGNED_MARKER),
      sendFilePath.stdout,
    );
    const sendFileCall = mock.calls
      .filter((call) => call.tool === 'network_message_send')
      .at(-1);
    const sendFileBody = String(sendFileCall?.arguments?.body ?? '');
    check('send-file 正文保留用户文本', sendFileBody.includes('报告'), sendFileBody);
    check(
      'send-file 正文带文件链接',
      sendFileBody.includes('[report.txt](') && sendFileBody.includes('/f/'),
      sendFileBody,
    );
    check(
      'send-file --no-invoke 发送空 invoke',
      Array.isArray(sendFileCall?.arguments?.invoke) &&
        (sendFileCall?.arguments?.invoke as unknown[]).length === 0,
      sendFileCall?.arguments,
    );

    mock.state.send = 'fail';
    const failedSendFile = await runCli(mock.baseUrl, [
      'send-file',
      '--room',
      'rm_mock',
      '--file',
      uploadPath,
      '--body',
      '失败重试',
      '--json',
    ]);
    check('send-file 发送失败退出非 0', failedSendFile.code !== 0);
    const failedSendFileError = JSON.parse(failedSendFile.stderr) as {
      error?: { code?: string; message?: string; details?: { file_id?: string } };
    };
    checkEqual('send-file 发送失败保留 code', failedSendFileError.error?.code, 'ROOM_DISSOLVED');
    checkEqual(
      'send-file 发送失败保留 file_id',
      failedSendFileError.error?.details?.file_id,
      UPLOAD_FILE_ID,
    );
    check(
      'send-file 发送失败给出 file_id 重试命令',
      failedSendFileError.error?.message?.includes(`file_id=${UPLOAD_FILE_ID}`) === true &&
        failedSendFileError.error?.message?.includes(
          `send-file --room rm_mock --file ${UPLOAD_FILE_ID}`,
        ) === true,
      failedSendFile.stderr,
    );
    check(
      'send-file 发送失败不泄露 token/签名 URL',
      !failedSendFile.stderr.includes(TOKEN) &&
        !failedSendFile.stderr.includes(SIGNED_MARKER),
      failedSendFile.stderr,
    );
    mock.state.send = 'ok';

    const preparesBeforeSendById = mock.calls.filter(
      (call) => call.tool === 'network_file_upload_prepare',
    ).length;
    const sendById = await runCli(mock.baseUrl, [
      'send-file',
      '--room',
      'rm_mock',
      '--file',
      UPLOAD_FILE_ID,
      '--body',
      '复用文件',
      '--invoke',
      'actor_worker',
      '--json',
    ]);
    checkEqual('send-file file_id 退出 0', sendById.code, 0);
    checkEqual(
      'send-file file_id 不重新上传',
      mock.calls.filter((call) => call.tool === 'network_file_upload_prepare').length,
      preparesBeforeSendById,
    );
    const getFileCall = mock.calls
      .filter((call) => call.tool === 'network_room_file_get')
      .at(-1);
    checkEqual('send-file file_id 读取房间文件', getFileCall?.arguments?.file_id, UPLOAD_FILE_ID);
    checkEqual('send-file file_id 透传房间', getFileCall?.arguments?.room_id, 'rm_mock');
    const sendByIdCall = mock.calls
      .filter((call) => call.tool === 'network_message_send')
      .at(-1);
    checkEqual(
      'send-file --invoke 显式派活',
      JSON.stringify(sendByIdCall?.arguments?.invoke),
      JSON.stringify(['actor_worker']),
    );
    check(
      'send-file file_id 正文带链接',
      String(sendByIdCall?.arguments?.body ?? '').includes('[report.txt]('),
      sendByIdCall?.arguments?.body,
    );

    const downloadOut = join(workDir, 'downloaded.txt');
    const downloadJson = await runCli(mock.baseUrl, [
      'download',
      '--room',
      'rm_mock',
      '--file',
      UPLOAD_FILE_ID,
      '--out',
      downloadOut,
      '--json',
    ]);
    checkEqual('download 退出 0', downloadJson.code, 0);
    checkEqual('download 写入正确内容', await Bun.file(downloadOut).text(), DOWNLOAD_BODY);
    const downloadPayload = JSON.parse(downloadJson.stdout) as {
      file_id?: string;
      size?: number;
      sha256?: string;
      saved_to?: string;
    };
    checkEqual('download 返回 file_id', downloadPayload.file_id, UPLOAD_FILE_ID);
    checkEqual('download 返回校验后的 size', downloadPayload.size, DOWNLOAD_BODY.length);
    checkEqual('download 返回校验后的 sha256', downloadPayload.sha256, DOWNLOAD_SHA);
    checkEqual('download 返回保存路径', downloadPayload.saved_to, downloadOut);
    check(
      'download 不打印签名 URL 或 token',
      !downloadJson.stdout.includes(SIGNED_MARKER) &&
        !downloadJson.stderr.includes(SIGNED_MARKER) &&
        !downloadJson.stdout.includes(TOKEN) &&
        !downloadJson.stderr.includes(TOKEN),
      downloadJson.stdout,
    );

    mock.state.download = '404';
    const notFound = await runCli(mock.baseUrl, [
      'download',
      '--room',
      'rm_mock',
      '--file',
      UPLOAD_FILE_ID,
      '--out',
      join(workDir, 'missing.txt'),
      '--json',
    ]);
    check('download 404 退出非 0', notFound.code !== 0);
    const notFoundError = JSON.parse(notFound.stderr) as { error?: { code?: string; message?: string } };
    checkEqual('download 404 错误码', notFoundError.error?.code, 'FILE_UNAVAILABLE');
    check(
      'download 404 提示状态码与原因',
      notFoundError.error?.message?.includes('404') === true &&
        notFoundError.error?.message?.includes('不存在') === true,
      notFound.stderr,
    );
    check(
      'download 404 不打印签名 URL 或 token',
      !notFound.stderr.includes(SIGNED_MARKER) && !notFound.stderr.includes(TOKEN),
    );

    mock.state.download = '403';
    const forbidden = await runCli(mock.baseUrl, [
      'download',
      '--room',
      'rm_mock',
      '--file',
      UPLOAD_FILE_ID,
      '--out',
      join(workDir, 'forbidden.txt'),
      '--json',
    ]);
    check('download 403 退出非 0', forbidden.code !== 0);
    const forbiddenError = JSON.parse(forbidden.stderr) as {
      error?: { code?: string; message?: string };
    };
    checkEqual('download 403 错误码', forbiddenError.error?.code, 'DOWNLOAD_FORBIDDEN');
    check(
      'download 403 提示票据或权限',
      forbiddenError.error?.message?.includes('403') === true &&
        (forbiddenError.error?.message?.includes('票据') === true ||
          forbiddenError.error?.message?.includes('无权') === true),
      forbidden.stderr,
    );
    check(
      'download 403 不打印签名 URL 或 token',
      !forbidden.stderr.includes(SIGNED_MARKER) && !forbidden.stderr.includes(TOKEN),
    );
    mock.state.download = 'ok';

    const filesHuman = await runCli(mock.baseUrl, ['files', '--room', 'rm_mock']);
    checkEqual('files 退出 0', filesHuman.code, 0);
    check(
      'files 人类输出分页游标与文件',
      filesHuman.stdout.includes('next_cursor=file_cursor') &&
        filesHuman.stdout.includes('has_more=true') &&
        filesHuman.stdout.includes(UPLOAD_FILE_ID),
      filesHuman.stdout,
    );
    check(
      'files 人类输出不打印签名 URL',
      !filesHuman.stdout.includes(SIGNED_MARKER),
      filesHuman.stdout,
    );

    const fileHuman = await runCli(mock.baseUrl, [
      'file',
      '--room',
      'rm_mock',
      '--file',
      UPLOAD_FILE_ID,
    ]);
    checkEqual('file 退出 0', fileHuman.code, 0);
    check(
      'file 人类输出元数据',
      fileHuman.stdout.includes('report.txt') &&
        fileHuman.stdout.includes(DOWNLOAD_SHA) &&
        fileHuman.stdout.includes('preview_kind=text'),
      fileHuman.stdout,
    );
    check('file 人类输出不打印签名 URL', !fileHuman.stdout.includes(SIGNED_MARKER));

    const infoHuman = await runCli(mock.baseUrl, ['file-info', '--file', UPLOAD_FILE_ID]);
    checkEqual('file-info 退出 0', infoHuman.code, 0);
    check(
      'file-info 输出状态与可见性',
      infoHuman.stdout.includes('state=draft') && infoHuman.stdout.includes('visibility=private'),
      infoHuman.stdout,
    );

    const bindHuman = await runCli(mock.baseUrl, [
      'file-bind',
      '--room',
      'rm_mock',
      '--file',
      UPLOAD_FILE_ID,
    ]);
    checkEqual('file-bind 退出 0', bindHuman.code, 0);
    check(
      'file-bind 输出 room_file_id 与 request_id',
      bindHuman.stdout.includes('room_file_id=rf_mock') &&
        bindHuman.stdout.includes('request_id=req_'),
      bindHuman.stdout,
    );
    const fileBindCall = mock.calls
      .filter((call) => call.tool === 'network_room_file_bind')
      .at(-1);
    check(
      'file-bind 自动生成 request_id',
      String(fileBindCall?.arguments?.request_id).startsWith('req_'),
      fileBindCall?.arguments,
    );

    const deleteHuman = await runCli(mock.baseUrl, [
      'file-delete',
      '--room',
      'rm_mock',
      '--file',
      UPLOAD_FILE_ID,
    ]);
    checkEqual('file-delete 退出 0', deleteHuman.code, 0);
    check(
      'file-delete 输出 file_id 与 request_id',
      deleteHuman.stdout.includes(`deleted file_id=${UPLOAD_FILE_ID}`) &&
        deleteHuman.stdout.includes('request_id=req_'),
      deleteHuman.stdout,
    );

    // 构建产物不入库：先构建，再验收产物与可重复构建。
    const build = await runProcess([process.execPath, 'scripts/build-client.ts'], {
      timeoutMs: 60_000,
    });
    checkEqual('build:client 退出 0', build.code, 0);
    check('构建产物存在', statSync(BUNDLE).isFile());
    check('构建产物可执行', (statSync(BUNDLE).mode & 0o111) !== 0);
    const firstHash = await fileHash(BUNDLE);
    const rebuild = await runProcess([process.execPath, 'scripts/build-client.ts'], {
      timeoutMs: 60_000,
    });
    checkEqual('重复构建退出 0', rebuild.code, 0);
    checkEqual('重复构建输出稳定', await fileHash(BUNDLE), firstHash);
    const bundledHelp = await runProcess([process.execPath, BUNDLE, '--help']);
    checkEqual('打包产物可运行 --help', bundledHelp.code, 0);
    check('打包产物帮助包含 monitor', bundledHelp.stdout.includes('monitor'));
  } finally {
    mock.stop();
    await rm(workDir, { recursive: true, force: true });
  }
  console.log(`\n${checksPassed()} checks passed`);
}

await main();
