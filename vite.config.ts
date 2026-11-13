import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 4B-1 产出 React Home 的构建产物；服务端默认仍渲染 legacy 页面。
 *
 * - 产物写入 `dist/web`，由 `GET /static/*` 只读服务；
 * - manifest 交给 `src/web/spa-manifest.ts` 在启动时解析；
 * - 只有 `WEB_SPA_ROUTES`（含 cookie 灰度）显式开启 `home` 时才接管 `/`。
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
