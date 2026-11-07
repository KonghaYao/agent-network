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
  previewUrl: string;
  downloadUrl: string;
  state: string;
  visibility: string;
  retained: boolean;
}

async function uploadFile(
  token: string,
  input: { name: string; mimeType: string; body: string | Uint8Array },
): Promise<UploadResponse> {
  const bodyBytes =
    typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body;
  const response = await fetch(`${baseUrl()}/mcp-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'MCPP-Files-Version': '1',
      'content-type': input.mimeType,
      'MCPP-File-Name': input.name,
      'MCPP-File-Size': String(bodyBytes.length),
    },
    body: bodyBytes as unknown as BodyInit,
  });
  checkEqual(`MCPP 上传 ${input.name} 返回 201`, response.status, 201);
  return (await response.json()) as UploadResponse;
}

async function upload(token: string): Promise<UploadResponse> {
  return uploadFile(token, {
    name: 'drive-check.txt',
    mimeType: 'text/plain',
    body: BODY,
  });
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
    checkEqual('返回文件身份 URL', info.publicUrl, `${baseUrl()}/f/${info.fileId}`);
    checkEqual('上传默认为私有草稿', info.state, 'draft');
    checkEqual('上传默认不公开', info.visibility, 'private');
    check(
      '预览与下载地址携带票据',
      new URL(info.previewUrl).searchParams.get('t') !== null &&
        new URL(info.downloadUrl).searchParams.get('t') !== null,
      info,
    );
    checkEqual(
      '裸 publicUrl 不携带票据返回 404',
      (await fetch(info.publicUrl)).status,
      404,
    );
    checkEqual('返回文件大小', info.size, new TextEncoder().encode(BODY).length);

    const download = await fetch(info.previewUrl);
    checkEqual('公开下载无需凭据返回 200', download.status, 200);
    checkEqual('公开下载内容一致', await download.text(), BODY);
    const textHeaders = download.headers;
    check(
      '普通文本公开下载保持 inline',
      (textHeaders.get('content-disposition') ?? '').startsWith('inline'),
      textHeaders.get('content-disposition'),
    );
    checkEqual(
      '普通文本声明 utf-8 charset',
      textHeaders.get('content-type'),
      'text/plain; charset=utf-8',
    );
    checkEqual('公开下载不长期缓存', textHeaders.get('cache-control'), 'private, no-store, max-age=0');
    checkEqual('公开下载声明支持 Range', textHeaders.get('accept-ranges'), 'bytes');

    const head = await fetch(info.previewUrl, { method: 'HEAD' });
    checkEqual('HEAD 公开文件返回 200', head.status, 200);
    checkEqual(
      'HEAD 返回完整 content-length',
      head.headers.get('content-length'),
      String(new TextEncoder().encode(BODY).length),
    );
    checkEqual('HEAD 不返回正文', (await head.text()).length, 0);

    const ranged = await fetch(info.previewUrl, { headers: { range: 'bytes=0-4' } });
    checkEqual('Range 请求返回 206', ranged.status, 206);
    checkEqual('Range 响应正文按区间截取', await ranged.text(), BODY.slice(0, 5));
    checkEqual(
      'Range 响应声明 content-range',
      ranged.headers.get('content-range'),
      `bytes 0-4/${new TextEncoder().encode(BODY).length}`,
    );
    const unsatisfiable = await fetch(info.previewUrl, {
      headers: { range: `bytes=${new TextEncoder().encode(BODY).length}-` },
    });
    checkEqual('越界 Range 返回 416', unsatisfiable.status, 416);

    const etag = textHeaders.get('etag') ?? '';
    const notModified = await fetch(info.previewUrl, { headers: { 'if-none-match': etag } });
    checkEqual('If-None-Match 命中返回 304', notModified.status, 304);
    const forcedUrl = new URL(info.previewUrl);
    forcedUrl.searchParams.set('download', '1');
    const forced = await fetch(forcedUrl);
    check(
      '?download=1 对可内联类型也强制 attachment',
      (forced.headers.get('content-disposition') ?? '').startsWith('attachment'),
      forced.headers.get('content-disposition'),
    );

    const html = await uploadFile(token, {
      name: 'danger.html',
      mimeType: 'text/html',
      body: '<script>fetch("/mcp")</script>',
    });
    const htmlHeaders = (await fetch(html.previewUrl)).headers;
    check(
      'HTML 公开下载强制 attachment',
      (htmlHeaders.get('content-disposition') ?? '').startsWith('attachment'),
      htmlHeaders.get('content-disposition'),
    );
    checkEqual(
      'HTML 主动内容加 sandbox CSP',
      htmlHeaders.get('content-security-policy'),
      "default-src 'none'; sandbox",
    );
    checkEqual('HTML 禁止被嵌入', htmlHeaders.get('x-frame-options'), 'DENY');

    const svg = await uploadFile(token, {
      name: 'danger.svg',
      mimeType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    const svgHeaders = (await fetch(svg.previewUrl)).headers;
    check(
      'SVG 公开下载强制 attachment',
      (svgHeaders.get('content-disposition') ?? '').startsWith('attachment'),
      svgHeaders.get('content-disposition'),
    );
    checkEqual(
      'SVG 主动内容加 sandbox CSP',
      svgHeaders.get('content-security-policy'),
      "default-src 'none'; sandbox",
    );

    const pngBytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      ),
      (character) => character.charCodeAt(0),
    );
    const png = await uploadFile(token, {
      name: 'pixel.png',
      mimeType: 'image/png',
      body: pngBytes,
    });
    const pngHeaders = (await fetch(png.previewUrl)).headers;
    check(
      '光栅图片保持 inline',
      (pngHeaders.get('content-disposition') ?? '').startsWith('inline'),
      pngHeaders.get('content-disposition'),
    );
    checkEqual('光栅图片保留 image/png', pngHeaders.get('content-type'), 'image/png');
    checkEqual('公开下载保留 nosniff', pngHeaders.get('x-content-type-options'), 'nosniff');
    checkEqual('公开下载不泄露 referrer', pngHeaders.get('referrer-policy'), 'no-referrer');
    checkEqual(
      '公开下载限制跨站读取',
      pngHeaders.get('cross-origin-resource-policy'),
      'same-site',
    );

    const pdf = await uploadFile(token, {
      name: 'document.pdf',
      mimeType: 'application/pdf',
      body: '%PDF-1.4\n%%EOF\n',
    });
    const pdfHeaders = (await fetch(pdf.previewUrl)).headers;
    check(
      'PDF 保持 inline',
      (pdfHeaders.get('content-disposition') ?? '').startsWith('inline'),
      pdfHeaders.get('content-disposition'),
    );
    checkEqual(
      'PDF 只允许本站嵌入',
      pdfHeaders.get('content-security-policy'),
      "frame-ancestors 'self'",
    );
    checkEqual('PDF 加 SAMEORIGIN', pdfHeaders.get('x-frame-options'), 'SAMEORIGIN');

    const unknown = await uploadFile(token, {
      name: 'blob.bin',
      mimeType: 'application/octet-stream',
      body: 'binary-ish',
    });
    const unknownHeaders = (await fetch(unknown.previewUrl)).headers;
    check(
      '未知类型公开下载强制 attachment',
      (unknownHeaders.get('content-disposition') ?? '').startsWith('attachment'),
      unknownHeaders.get('content-disposition'),
    );
    checkEqual(
      '未知类型也加 sandbox CSP',
      unknownHeaders.get('content-security-policy'),
      "default-src 'none'; sandbox",
    );

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
      structuredContent?: { publicUrl?: string; previewUrl?: string; fileId?: string };
    };
    check('drive_file_info 不是错误', result.isError !== true, result);
    checkEqual('工具返回文件身份 URL', result.structuredContent?.publicUrl, info.publicUrl);
    check(
      '工具返回带票据预览地址',
      typeof result.structuredContent?.previewUrl === 'string' &&
        new URL(result.structuredContent.previewUrl).searchParams.get('t') !== null,
      result.structuredContent?.previewUrl,
    );
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
