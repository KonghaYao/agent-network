import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createFileMount,
  createFileService,
  FileError,
  type FileMount,
  type FileScope,
  type FileService,
} from '@peri-code/mcpp/files';
import { Disk } from 'flydrive';
import { FSDriver } from 'flydrive/drivers/fs';

import type { Env } from '../env';
import { authenticate } from '../mcp/auth';

export interface DriveOptions {
  directory: string;
  namespace: string;
  maxFileBytes: number;
  ttlSeconds: number;
  allowedOrigins: string[];
}

export interface DriveRuntime {
  fileService: FileService;
  mount: FileMount;
}

/**
 * 创建 MCPP Files v1 的本地磁盘实现。
 *
 * 上传与 MCP 共用 authenticate() 的凭据解析：
 * - 已注册 actor 使用 actor scope，工具读取与上传落在同一身份；
 * - 未注册但有凭据的客户端使用凭据摘要 scope（不保存原始 token）；
 * - 无凭据的 MCP bootstrap 请求显式使用 anonymous scope，上传则拒绝。
 */
export function createDrive(env: Env, options: DriveOptions): DriveRuntime {
  mkdirSync(options.directory, { recursive: true });
  const fileService = createFileService({
    disk: new Disk(
      new FSDriver({
        location: resolve(options.directory),
        visibility: 'private',
      }),
    ),
    namespace: options.namespace,
    uploadPath: '/mcp-upload',
    maxFileBytes: options.maxFileBytes,
    ttlSeconds: options.ttlSeconds,
  });
  const mount = createFileMount(fileService, {
    endpointPath: '/mcp',
    uploadPath: '/mcp-upload',
    allowedOrigins: options.allowedOrigins,
    resolveScope: async (request, operation): Promise<FileScope> => {
      let principal: Awaited<ReturnType<typeof authenticate>>;
      try {
        principal = await authenticate(env.DB, request);
      } catch {
        throw new FileError('UNAUTHENTICATED');
      }
      if (principal.actor) return { key: `actor:${principal.actor.actor_id}` };
      if (principal.credentialHash) return { key: `credential:${principal.credentialHash}` };
      if (operation === 'mcp') return { key: 'anonymous' };
      throw new FileError('UNAUTHENTICATED');
    },
  });
  env.FILES = fileService;
  return { fileService, mount };
}

/** 上传成功响应追加公开下载地址；不改变 MCPP Files 的既有字段。 */
export async function attachPublicUrl(response: Response, publicOrigin: string): Promise<Response> {
  if (response.status !== 201) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return response;
  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    return response;
  }
  if (typeof payload.fileId !== 'string') return response;
  payload.publicUrl = `${publicOrigin.replace(/\/+$/u, '')}/f/${payload.fileId}`;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(payload), { status: 201, headers });
}
