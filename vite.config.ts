import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 4B-0 只负责产出 React 壳的构建产物；服务端默认仍渲染 legacy 页面。
 *
 * - 产物写入 `dist/web`，由 `GET /static/*` 只读服务；
 * - manifest 交给 `src/web/spa-manifest.ts` 在启动时解析；
 * - 不接管现有 `/`、`/c`、`/a`、`/j`、`/pair` 路由。
 */
export default defineConfig({
  base: '/static/',
  plugins: [react()],
  build: {
    outDir: 'dist/web',
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
