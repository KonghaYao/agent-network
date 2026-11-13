import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 基础设施在 4B-0 接入，但默认不跑 SPA 用例：
 * `test:e2e` 需要显式执行；`E2E_SPA=1` 才运行壳占位用例。
 *
 * globalSetup 用 Node 兼容的方式启动隔离 Bun 实例，测试通过
 * `.e2e/server.json` 读取实际基址（端口由内核分配）。
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
