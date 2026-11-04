/**
 * Drive 验收：注册身份 → MCPP Files v1 上传 → 公开下载 → MCP 文件工具。
 *
 * 运行：bun run test:drive
 * 需要服务端已启动（默认 http://127.0.0.1:8792，可用 AGENTNET_URL 覆盖）。
 */
import {
  baseUrl,
  callTool,
  check,
  checkEqual,
  checksPassed,
  connectClient,
  newRequestId,
  newToken,
  rawRpc,
} from './lib/harness';

const FILES_CAPABILITY = { 'io.mcpp/files': { version: 1 } };
const BODY = 'drive acceptance payload';

interface UploadResponse {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  publicUrl: string;
}

async function upload(token: string): Promise<UploadResponse> {
  const response = await fetch(`${baseUrl()}/mcp-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'MCPP-Files-Version': '1',
      'content-type': 'text/plain',
      'MCPP-File-Name': 'drive-check.txt',
      'MCPP-File-Size': String(new TextEncoder().encode(BODY).length),
    },
    body: BODY,
  });
  checkEqual('MCPP 上传返回 201', response.status, 201);
  return (await response.json()) as UploadResponse;
}

async function main(): Promise<void> {
  const token = newToken();
  const connection = await connectClient(token);
  try {
    await callTool(connection.client, 'network_register', {
      request_id: newRequestId('reg'),
      kind: 'agent',
      agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
      name: 'Drive 验收 Agent',
    });
    check('注册身份', true);

    const info = await upload(token);
    check('返回 fileId', /^f_[A-Za-z0-9_-]{22}$/u.test(info.fileId), info);
    checkEqual('返回公开 URL', info.publicUrl, `${baseUrl()}/f/${info.fileId}`);
    checkEqual('返回文件大小', info.size, new TextEncoder().encode(BODY).length);

    const download = await fetch(info.publicUrl);
    checkEqual('公开下载无需凭据返回 200', download.status, 200);
    checkEqual('公开下载内容一致', await download.text(), BODY);

    const unauth = await fetch(`${baseUrl()}/mcp-upload`, {
      method: 'POST',
      headers: {
        'MCPP-Files-Version': '1',
        'content-type': 'text/plain',
        'MCPP-File-Name': 'x.txt',
        'MCPP-File-Size': '1',
      },
      body: 'x',
    });
    checkEqual('无凭据上传返回 401', unauth.status, 401);

    const discovered = await rawRpc('server/discover', {}, { token, clientCapabilities: {} });
    const extensions = (
      discovered.body.result as
        | { capabilities?: { extensions?: Record<string, { version?: number }> } }
        | undefined
    )?.capabilities?.extensions;
    checkEqual('server/discover 声明 io.mcpp/files v1', extensions?.['io.mcpp/files']?.version, 1);

    const withoutCapability = await rawRpc(
      'tools/call',
      { name: 'drive_file_info', arguments: { fileId: info.fileId } },
      { token, clientCapabilities: {} },
    );
    check(
      '未声明扩展的客户端也能读取自己的文件',
      !withoutCapability.body.error &&
        (withoutCapability.body.result as { isError?: boolean } | undefined)?.isError !== true,
      withoutCapability.body,
    );

    const called = await rawRpc(
      'tools/call',
      { name: 'drive_file_info', arguments: { fileId: info.fileId } },
      { token, clientCapabilities: FILES_CAPABILITY },
    );
    check('drive_file_info 返回结果', !called.body.error && Boolean(called.body.result), called.body);
    const result = called.body.result as {
      isError?: boolean;
      structuredContent?: { publicUrl?: string; fileId?: string };
    };
    check('drive_file_info 不是错误', result.isError !== true, result);
    checkEqual('工具返回公开 URL', result.structuredContent?.publicUrl, info.publicUrl);
    checkEqual('工具返回 fileId', result.structuredContent?.fileId, info.fileId);

    console.log(`\ndrive checks passed: ${checksPassed()}`);
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
