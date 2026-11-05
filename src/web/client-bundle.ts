/**
 * 浏览器小岛 bundle 的共用构建器。
 *
 * 入口必须是浏览器可执行的 TSX/TS；产物只放内存，由 `src/app.ts`
 * 以带内容版本的 `/assets/*.js` 提供。构建失败返回 null，调用方自行降级。
 */

export interface ClientBundleAsset {
  /** 完整 JS 文本；内存缓存，不在这里写文件。 */
  code: string;
  /** 内容哈希前 12 位，用于页面引用带版本 URL，绕过旧 bundle 缓存。 */
  version: string;
}

export async function buildClientBundle(
  entry: string,
  label: string,
): Promise<ClientBundleAsset | null> {
  try {
    // bun-types 1.4.2 的 BuildConfig 尚未声明 `write`，运行时支持 write:false。
    const config = {
      entrypoints: [entry],
      target: 'browser',
      format: 'esm',
      minify: true,
      write: false,
      splitting: false,
      define: {
        'process.env.NODE_ENV': '"production"',
      },
    } as unknown as Bun.BuildConfig;
    const result = await Bun.build(config);
    if (!result.success) {
      const messages = result.logs
        .map((log) => log.message)
        .filter((message) => message.length > 0)
        .slice(0, 5);
      console.warn(`${label} bundle disabled:`, messages.join(' | '));
      return null;
    }
    const entryOutput = result.outputs.find((output) => output.kind === 'entry-point');
    if (!entryOutput) {
      console.warn(`${label} bundle disabled: entry output missing`);
      return null;
    }
    const text = await entryOutput.text();
    if (!text || text.length === 0) {
      console.warn(`${label} bundle disabled: empty entry output`);
      return null;
    }
    return { code: text, version: bundleVersion(text) };
  } catch (error) {
    // 只记录错误类型/路径，不输出消息正文或凭据。
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`${label} bundle disabled:`, reason.slice(0, 300));
    return null;
  }
}

/** 内容哈希前 12 位；URL 与 ETag 共用，部署后 HTML 自然引用新资源。 */
function bundleVersion(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 12);
}
