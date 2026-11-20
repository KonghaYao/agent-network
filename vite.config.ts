import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { unplugin as stylex } from '@stylexjs/unplugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * React 应用构建。
 *
 * - 默认 `outDir=dist/web`，由 `GET /static/*` 只读服务，兼容本地开发与旧流程；
 * - 发布构建通过 `WEB_BUILD_OUT_DIR` 写入独立候选目录，绝不清理正在服务的目录；
 * - `WEB_RELEASE_MODULES_FILE` 在 Vite 构建前生成，把两个 Bun 模块的哈希 URL
 *   注入客户端，生产页面不读取“服务器最新 URL”；
 * - 发布构建不复制 `public/`，避免未哈希文件进入 append-only immutable 索引。
 */
function releaseModuleUrls(): { markdown: string; drawboard: string } {
  const file = process.env.WEB_RELEASE_MODULES_FILE?.trim();
  if (!file) return { markdown: '', drawboard: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`WEB_RELEASE_MODULES_FILE 不可读: ${reason.slice(0, 200)}`);
  }
  const record = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const markdown = typeof record.markdown === 'string' ? record.markdown : '';
  const drawboard = typeof record.drawboard === 'string' ? record.drawboard : '';
  if (markdown !== '' && !markdown.startsWith('/static/')) {
    throw new Error('markdown 模块 URL 必须是 /static/ URL');
  }
  if (drawboard !== '' && !drawboard.startsWith('/static/')) {
    throw new Error('drawboard 模块 URL 必须是 /static/ URL');
  }
  return { markdown, drawboard };
}

const modules = releaseModuleUrls();
const releaseOutDir = process.env.WEB_BUILD_OUT_DIR?.trim();
const releaseBuild = Boolean(releaseOutDir);

export default defineConfig({
  base: '/static/',
  ...(releaseBuild ? { publicDir: false as const } : {}),
  define: {
    __WEB_MARKDOWN_URL__: JSON.stringify(modules.markdown),
    __WEB_DRAWBOARD_URL__: JSON.stringify(modules.drawboard),
    // 仅用于支持诊断；每次发布不同，保证 A/B 真实构建的字节有差异。
    __WEB_BUILD_NONCE__: JSON.stringify(process.env.WEB_BUILD_NONCE ?? ''),
    // 开发服务器与生产构建的显式区分；不依赖 import.meta.env 的全局类型。
    __WEB_PRODUCTION__: JSON.stringify(process.env.NODE_ENV === 'production'),
  },
  optimizeDeps: {
    exclude: ['@lenso/ui', '@lenso/tokens', '@lenso/glass'],
    include: ['use-sync-external-store/shim', 'use-sync-external-store/shim/with-selector'],
  },
  plugins: [
    stylex.vite({
      dev: false,
      runtimeInjection: false,
      useCSSLayers: false,
      lightningcssOptions: { exclude: 4 },
      unstable_moduleResolution: { type: 'commonJS', rootDir: import.meta.dirname },
    }),
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: releaseOutDir || 'dist/web',
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input: 'src/web/app/main.tsx',
    },
  },
  server: {
    proxy: {
      '/mcp': 'http://127.0.0.1:8792',
      '/mcp-upload': 'http://127.0.0.1:8792',
    },
  },
});
