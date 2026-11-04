/**
 * 启动时构建 AI 消息 Markdown 岛，失败只禁用 Markdown，不影响聊天服务。
 *
 * Streamdown 是 ESM + React，不能用页面内联的 vanilla 脚本直接渲染；
 * 这里把 `src/web/markdown/entry.tsx` 打成单个浏览器 bundle，
 * `src/app.ts` 以 `/assets/chat-markdown.js` 提供，页面按需动态导入。
 */

import { resolve } from 'node:path';

const ENTRY = resolve(import.meta.dir, 'markdown/entry.tsx');

/**
 * 返回值是完整 JS 文本；构建失败或没有入口产物时返回 null。
 * 不在这里写文件：开发、测试与生产都复用同一份内存产物。
 */
export async function buildMarkdownBundle(): Promise<string | null> {
  try {
    // bun-types 1.4.2 的 BuildConfig 尚未声明 `write`，运行时支持 write:false。
    const config = {
      entrypoints: [ENTRY],
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
      console.warn('markdown bundle disabled:', messages.join(' | '));
      return null;
    }
    const entry = result.outputs.find((output) => output.kind === 'entry-point');
    if (!entry) {
      console.warn('markdown bundle disabled: entry output missing');
      return null;
    }
    const text = await entry.text();
    if (!text || text.length === 0) {
      console.warn('markdown bundle disabled: empty entry output');
      return null;
    }
    return text;
  } catch (error) {
    // 只记录错误类型/路径，不输出消息正文或凭据。
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('markdown bundle disabled:', reason.slice(0, 300));
    return null;
  }
}
