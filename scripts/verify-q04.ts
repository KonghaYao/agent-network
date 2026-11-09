/**
 * Q04 桌面/移动端正向验收。
 *
 * 自托管临时 Bun 实例（随机端口 + 临时 DATA_DIR + 短 presence 窗口），
 * 用 Playwright Chromium 在 1280×900、768×1024、390×844 三档与浅色/暗色下
 * 操作真实控件，并通过 MCP/SQLite 对账服务端权威状态。
 *
 * 运行：bun scripts/verify-q04.ts
 * 证据：reports/evidence/q04/
 */

import { checksPassed } from './lib/harness';
import { setupQ04Fixture } from './lib/q04-fixture';
import { runContactAcceptance, runGroupFinaleAcceptance, runGroupSetupAcceptance } from './lib/q04-groups';
import { runChatAcceptance } from './lib/q04-chat';
import { runTaskUiHiddenAcceptance } from './lib/q04-tasks';
import { runAgentAcceptance } from './lib/q04-agents';
import { runResponsiveAcceptance } from './lib/q04-responsive';
import { runIdentityAcceptance } from './lib/q04-identity';
import { launchBrowser, startQ04Server } from './lib/q04-harness';
import type { Browser } from 'playwright';

async function main(): Promise<void> {
  const server = await startQ04Server();
  process.env.AGENTNET_URL = server.base;
  console.log(`Q04 浏览器验收: ${server.base}`);
  let browser: Browser | null = null;
  const errors: string[] = [];
  try {
    browser = await launchBrowser();
    const { state, directPage } = await setupQ04Fixture(
      browser,
      server.base,
      server.dataDir,
      server.dbPath,
    );
    errors.push(...state.errors);
    try {
      await runContactAcceptance(state, browser);
      await runGroupSetupAcceptance(state, browser);
      await runChatAcceptance(state, browser);
      await runTaskUiHiddenAcceptance(state, browser);
      await runAgentAcceptance(state, browser);
      await runResponsiveAcceptance(state, browser);
      await runGroupFinaleAcceptance(state, browser);
      await runIdentityAcceptance(state, browser);
    } finally {
      await directPage.context().close().catch(() => undefined);
    }
    errors.push(...state.errors);
    if (errors.length > 0) {
      console.error('Q04 浏览器错误：');
      for (const error of errors) console.error(`  - ${error}`);
      throw new Error(`Q04 发现 ${errors.length} 个浏览器错误`);
    }
    console.log(`Q04 PASS checks=${checksPassed()}`);
  } finally {
    await browser?.close().catch(() => undefined);
    await server.stop();
  }
}

main().catch((error) => {
  console.error(`Q04 FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
});
