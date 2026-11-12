/**
 * MF08 Memory UI 浏览器验收。
 *
 * 使用独立的临时 Bun 实例（MEMORY_ENABLED=1 + stub 适配器）验证：
 * - 部署关闭时只显示降级说明，不暴露不可用入口；
 * - 人类身份只看到能力目录，不读取 Agent 私有记忆；
 * - Agent 身份可召回、读取上下文与经历、查询宿主清单、确认遗忘；
 * - 移动端/暗色无横向溢出，正文不写入 localStorage。
 *
 * 经历与 Context 通过真实 Memory 服务模块写入同一 SQLite，再经 MCP 工具
 * 读取；不替换成功响应，也不接触真实 Hindsight。
 */
import { Database } from 'bun:sqlite';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Browser, BrowserContext, Page } from 'playwright';

import { createD1 } from '../../src/bun/d1';
import { sha256Hex } from '../../src/storage/db';
import { MemoryHostBridge } from '../../src/memory/host-bridge';
import { MEMORY_HOST_PROTOCOL_VERSION } from '../../src/memory/host-protocol';
import { createSourceSelections } from '../../src/memory/experience-source';
import { resolveRoomTargetScope } from '../../src/memory/target';
import { createLookupMemoryContext } from '../../src/memory/context';
import { sourceOriginScope } from '../../src/memory/access';
import type { MemorySourceRow } from '../../src/memory/rows';
import type { MemorySpaceRef } from '../../src/memory/contracts';
import { rawRepresentation, summaryRepresentation } from './memory-unit';
import { check, checkEqual, newToken, rawRpc, sleep } from './harness';

const INSTANCE_ID = 'mni_mf08_web';

interface MemoryWebOptions {
  browser: Browser;
  disabledBase: string;
  allErrors: string[];
}

interface PageHandle {
  context: BrowserContext;
  page: Page;
}

interface Fixture {
  humanToken: string;
  agentToken: string;
  human: { actor_id: string; name: string };
  agent: { actor_id: string; name: string };
  roomId: string;
  messageId: string;
  deliveryId: string;
  attempt: number;
  claimId: string;
  binding: {
    binding_id: string;
    generation: number;
    session_incarnation: string;
    level: string;
  };
  space: MemorySpaceRef;
  secret: string;
}

interface SeedResult {
  manifestId: string;
  manifestSha256: string;
  payloadSha256: string;
  contextId: string;
  expiredContextId: string;
  rawExperienceId: string;
  summaryExperienceId: string;
  summaryText: string;
  curatedId: string;
  curatedTitle: string;
}

interface MemoryServer {
  base: string;
  dataDir: string;
  stop: () => Promise<void>;
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function startMemoryServer(): Promise<MemoryServer> {
  const port = 19700 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const dataDir = `/tmp/agentnet-memory-web-${process.pid}-${Date.now()}`;
  const proc = Bun.spawn([Bun.which('bun') ?? 'bun', resolve(import.meta.dir, '../../src/bun/main.ts')], {
    cwd: resolve(import.meta.dir, '../..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DATABASE_PATH: `${dataDir}/agent-network.sqlite`,
      PUBLIC_ORIGIN: base,
      ENVIRONMENT: 'test',
      MEMORY_ENABLED: '1',
      MEMORY_ADAPTER: 'stub',
      MEMORY_INSTANCE_ID: INSTANCE_ID,
      MEMORY_HOST_TRUST: 'adapted_host',
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`${base}/health`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // 服务尚未监听
      }
      await sleep(100);
    }
    if (!ready) throw new Error('Memory 验收实例未在 10s 内就绪');
  } catch (error) {
    proc.kill();
    throw error;
  }
  return {
    base,
    dataDir,
    async stop() {
      proc.kill();
      await proc.exited.catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function memoryTool<T>(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await rawRpc('tools/call', { name, arguments: args }, {
    token,
    url: new URL(`${base}/mcp`),
  });
  const result = response.body.result as
    | {
        isError?: boolean;
        structuredContent?: T;
        content?: { type: string; text?: string }[];
      }
    | undefined;
  if (!result) throw new Error(`工具 ${name} 无结果: ${JSON.stringify(response.body)}`);
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (result.isError) {
    let detail: { code?: string; message?: string } = {};
    if (text) {
      try {
        detail = JSON.parse(text) as { code?: string; message?: string };
      } catch {
        detail = { message: text };
      }
    }
    throw new Error(`${detail.code ?? 'UNKNOWN'}: ${detail.message ?? ''}`);
  }
  if (result.structuredContent) return result.structuredContent;
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function pageInitScript(token: string): string {
  return `(() => {
  try { localStorage.setItem('agent-network-token', ${JSON.stringify(token)}); } catch (error) {}
  window.__memoryPageMarker = 'mem-' + Date.now() + '-' + Math.random();
  window.__calledTools = [];
  window.__memoryCalls = [];
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const headers = (init && init.headers) || {};
    let name = '';
    try {
      if (typeof headers.get === 'function') name = headers.get('mcp-name') || '';
      else name = headers['mcp-name'] || headers['MCP-Name'] || '';
    } catch (error) {}
    if (name) {
      window.__calledTools.push(name);
      window.__memoryCalls.push(name);
    }
    return originalFetch(input, init);
  };
})();`;
}

async function makePage(
  browser: Browser,
  token: string,
  allErrors: string[],
  options: { viewport: { width: number; height: number }; colorScheme?: 'light' | 'dark' },
): Promise<PageHandle> {
  const context = await browser.newContext({
    viewport: options.viewport,
    colorScheme: options.colorScheme ?? 'light',
  });
  await context.addInitScript({ content: pageInitScript(token) });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => {
    allErrors.push(`memory pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('Failed to load resource')) return;
    allErrors.push(`memory console: ${text}`);
  });
  return { context, page };
}

async function createFixture(base: string): Promise<Fixture> {
  const humanToken = newToken();
  const agentToken = newToken();
  const human = await memoryTool<{ actor_id: string; name: string }>(base, humanToken, 'network_register', {
    request_id: requestId('mem_reg_human'),
    kind: 'human',
    name: '记忆验收人类',
  });
  const agent = await memoryTool<{ actor_id: string; name: string }>(base, agentToken, 'network_register', {
    request_id: requestId('mem_reg_agent'),
    kind: 'agent',
    name: '记忆验收 Agent',
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  const requested = await memoryTool<{
    status: string;
    request: { contact_request_id: string } | null;
  }>(base, humanToken, 'network_contact_request', {
    request_id: requestId('mem_contact'),
    actor_id: agent.actor_id,
  });
  if (requested.status !== 'accepted') {
    if (!requested.request) throw new Error(`好友申请未进入 pending: ${requested.status}`);
    await memoryTool(base, agentToken, 'network_contact_request_respond', {
      request_id: requestId('mem_contact_accept'),
      contact_request_id: requested.request.contact_request_id,
      action: 'accept',
    });
  }
  const room = await memoryTool<{ room: { room_id: string } }>(base, humanToken, 'network_room_create', {
    request_id: requestId('mem_room'),
    kind: 'direct',
    members: [agent.actor_id],
  });
  const roomId = room.room.room_id;
  const secret = `MF08-UI-SECRET-${crypto.randomUUID()}-记忆🙂`;
  const sent = await memoryTool<{ message: { message_id: string }; delivery_ids: string[] }>(
    base,
    humanToken,
    'network_message_send',
    {
      request_id: requestId('mem_message'),
      client_message_id: crypto.randomUUID(),
      room_id: roomId,
      body: secret,
      invoke: [agent.actor_id],
    },
  );
  const deliveryId = sent.delivery_ids[0];
  if (!deliveryId) throw new Error('消息没有生成 Agent 投递');
  const claim = await memoryTool<{ attempt: number; claim_id: string }>(
    base,
    agentToken,
    'network_delivery_claim',
    { request_id: requestId('mem_claim'), delivery_id: deliveryId },
  );
  const status = await memoryTool<{
    enabled: boolean;
    space_id: string;
    ownership_epoch: number;
    backend_binding_epoch: number;
  }>(base, agentToken, 'network_memory_status', {});
  if (!status.enabled) throw new Error('Memory 验收实例未启用 Memory');
  const binding = await memoryTool<{
    binding_id: string;
    generation: number;
    session_incarnation: string;
    level: string;
  }>(base, agentToken, 'network_memory_host_bind', {
    request_id: requestId('mem_bind'),
    session_incarnation: `host_${crypto.randomUUID().replaceAll('-', '')}`,
    declared_capabilities: [
      'explicit_lookup',
      'run_binding',
      'async_supplement',
      'final_manifest_report',
      'submission_evidence',
      'history_isolation',
    ],
  });
  return {
    humanToken,
    agentToken,
    human: { actor_id: human.actor_id, name: human.name },
    agent: { actor_id: agent.actor_id, name: agent.name },
    roomId,
    messageId: sent.message.message_id,
    deliveryId,
    attempt: claim.attempt,
    claimId: claim.claim_id,
    binding,
    space: {
      space_id: status.space_id,
      ownership_epoch: status.ownership_epoch,
      backend_binding_epoch: status.backend_binding_epoch,
    },
    secret,
  };
}

async function seedMemoryData(
  base: string,
  dataDir: string,
  fixture: Fixture,
): Promise<SeedResult> {
  const sqlite = new Database(join(dataDir, 'agent-network.sqlite'));
  sqlite.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const d1 = createD1(sqlite);
  try {
    const source = sqlite
      .prepare(
        `SELECT * FROM memory_sources
          WHERE instance_id = ? AND source_key = ?
          ORDER BY revision DESC LIMIT 1`,
      )
      .get(INSTANCE_ID, `message:${fixture.messageId}`) as MemorySourceRow | null;
    if (!source || !source.content_text) {
      throw new Error('消息没有登记可读 Memory 来源正文');
    }
    const origin = sourceOriginScope(source);
    if (!origin) throw new Error('Memory 来源缺少 origin scope');
    const credential = sqlite
      .prepare(
        `SELECT credential_id FROM credentials
          WHERE actor_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(fixture.agent.actor_id) as { credential_id: string } | null;
    if (!credential) throw new Error('Agent 缺少有效凭据');
    const targetScope = await resolveRoomTargetScope(d1, fixture.roomId, fixture.agent.actor_id);
    const raw = await rawRepresentation({
      sourceId: source.source_id,
      sourceRevision: source.revision,
      text: source.content_text,
    });
    const [rawSelection] = await createSourceSelections(d1, {
      instanceId: INSTANCE_ID,
      agentId: fixture.agent.actor_id,
      space: fixture.space,
      targetScope,
      representations: [raw],
      now: Date.now(),
    });
    if (!rawSelection) throw new Error('raw selection 创建失败');
    const bridge = new MemoryHostBridge({
      db: d1,
      instanceId: INSTANCE_ID,
      agentId: fixture.agent.actor_id,
      credentialId: credential.credential_id,
      space: fixture.space,
      policy: { trust_level: 'adapted_host' },
      now: () => Date.now(),
    });
    const target = {
      kind: 'message' as const,
      host_binding_id: fixture.binding.binding_id,
      host_generation: fixture.binding.generation,
      session_incarnation: fixture.binding.session_incarnation,
      run_id: `run_${requestId('raw')}`,
      input_id: `input_${requestId('raw')}`,
      input_revision: 1,
      message: {
        message_id: fixture.messageId,
        delivery_id: fixture.deliveryId,
        attempt: fixture.attempt,
        claim_id: fixture.claimId,
      },
    };
    const prepared = await bridge.prepareInput({
      request_id: requestId('mem_prepare'),
      target,
      selection_ids: [rawSelection.selection_id],
      budget: { candidate_limit: 10, output_bytes: 64 * 1024, deadline_at: null },
    });
    if (prepared.status !== 'prepared') throw new Error(`raw prepare: ${prepared.status}`);
    const rawInvocationId = `inv_${requestId('raw')}`;
    const payload = `SYSTEM\n${source.content_text}\nTAIL`;
    const manifest = await bridge.submitManifest({
      protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
      host_binding_id: fixture.binding.binding_id,
      host_generation: fixture.binding.generation,
      invocation: {
        host_binding_id: fixture.binding.binding_id,
        host_generation: fixture.binding.generation,
        session_incarnation: fixture.binding.session_incarnation,
        run_id: target.run_id,
        input_id: target.input_id,
        input_revision: 1,
        invocation_id: rawInvocationId,
      },
      target: prepared.target,
      payload,
      payload_sha256: await sha256Hex(payload),
      items: [{
        selection_id: rawSelection.selection_id,
        representation_id: raw.representation.representation_id,
        text_sha256: raw.representation.text_sha256,
      }],
    });
    const admitted = await memoryTool<{
      disposition: string;
      experience_ids?: string[];
    }>(base, fixture.agentToken, 'network_memory_admit', {
      request_id: requestId('mem_admit'),
      kind: 'input_exposure',
      manifest_id: manifest.manifest.manifest_id,
      manifest_sha256: manifest.manifest.manifest_sha256,
      payload_sha256: manifest.manifest.payload_sha256,
      invocation_id: rawInvocationId,
      proof_id: `proof_${requestId('raw')}`,
      submitted_at: Date.now(),
    });
    if (admitted.disposition !== 'applied' || !admitted.experience_ids?.[0]) {
      throw new Error(`raw exposure 未接纳: ${admitted.disposition}`);
    }
    const rawExperienceId = admitted.experience_ids[0];

    const summaryText = `MF08-UI-SUMMARY-${crypto.randomUUID()}-仅摘要`;
    const summary = await summaryRepresentation({
      summaryId: `msum_${requestId('ui')}`,
      revision: 1,
      text: summaryText,
      dependencies: [{ source_id: source.source_id, source_revision: source.revision }],
    });
    const [summarySelection] = await createSourceSelections(d1, {
      instanceId: INSTANCE_ID,
      agentId: fixture.agent.actor_id,
      space: fixture.space,
      targetScope,
      representations: [summary],
      now: Date.now(),
    });
    if (!summarySelection) throw new Error('summary selection 创建失败');
    const summaryTarget = {
      ...target,
      run_id: `run_${requestId('summary')}`,
      input_id: `input_${requestId('summary')}`,
    };
    const summaryPrepared = await bridge.prepareInput({
      request_id: requestId('mem_prepare_summary'),
      target: summaryTarget,
      selection_ids: [summarySelection.selection_id],
      budget: { candidate_limit: 10, output_bytes: 64 * 1024, deadline_at: null },
    });
    if (summaryPrepared.status !== 'prepared') {
      throw new Error(`summary prepare: ${summaryPrepared.status}`);
    }
    const summaryInvocationId = `inv_${requestId('summary')}`;
    const summaryPayload = `SYSTEM\n${summaryText}\nTAIL`;
    const summaryManifest = await bridge.submitManifest({
      protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
      host_binding_id: fixture.binding.binding_id,
      host_generation: fixture.binding.generation,
      invocation: {
        host_binding_id: fixture.binding.binding_id,
        host_generation: fixture.binding.generation,
        session_incarnation: fixture.binding.session_incarnation,
        run_id: summaryTarget.run_id,
        input_id: summaryTarget.input_id,
        input_revision: 1,
        invocation_id: summaryInvocationId,
      },
      target: summaryPrepared.target,
      payload: summaryPayload,
      payload_sha256: await sha256Hex(summaryPayload),
      items: [{
        selection_id: summarySelection.selection_id,
        representation_id: summary.representation.representation_id,
        text_sha256: summary.representation.text_sha256,
      }],
    });
    const summaryAdmitted = await memoryTool<{
      disposition: string;
      experience_ids?: string[];
    }>(base, fixture.agentToken, 'network_memory_admit', {
      request_id: requestId('mem_admit_summary'),
      kind: 'input_exposure',
      manifest_id: summaryManifest.manifest.manifest_id,
      manifest_sha256: summaryManifest.manifest.manifest_sha256,
      payload_sha256: summaryManifest.manifest.payload_sha256,
      invocation_id: summaryInvocationId,
      proof_id: `proof_${requestId('summary')}`,
      submitted_at: Date.now(),
    });
    if (summaryAdmitted.disposition !== 'applied' || !summaryAdmitted.experience_ids?.[0]) {
      throw new Error(`summary exposure 未接纳: ${summaryAdmitted.disposition}`);
    }
    const summaryExperienceId = summaryAdmitted.experience_ids[0];

    const contextId = `mctx_${requestId('active')}`;
    const activeContext = await createLookupMemoryContext(d1, {
      instanceId: INSTANCE_ID,
      agentId: fixture.agent.actor_id,
      space: fixture.space,
      recallId: `mr_${requestId('active')}`,
      targetScope,
      items: [{ exact: raw, origin_scope: origin, evidence: 'host_reported_submitted' }],
      coverage: 'bounded',
      evidenceComplete: true,
      contextId,
      now: Date.now(),
    });
    if (!activeContext) throw new Error('active context 创建失败');
    const expiredContextId = `mctx_${requestId('expired')}`;
    const expiredContext = await createLookupMemoryContext(d1, {
      instanceId: INSTANCE_ID,
      agentId: fixture.agent.actor_id,
      space: fixture.space,
      recallId: `mr_${requestId('expired')}`,
      targetScope,
      items: [{ exact: raw, origin_scope: origin, evidence: 'host_reported_submitted' }],
      coverage: 'bounded',
      evidenceComplete: true,
      contextId: expiredContextId,
      now: Date.now(),
    });
    if (!expiredContext) throw new Error('expired context 创建失败');
    sqlite
      .prepare('UPDATE memory_contexts SET expires_at = ? WHERE context_id = ?')
      .run(Date.now() - 60_000, expiredContextId);

    const curatedTitle = `MF08 人工记忆 ${crypto.randomUUID().slice(0, 8)}`;
    const curated = await memoryTool<{ curated_id: string }>(base, fixture.agentToken, 'network_memory_put', {
      request_id: requestId('mem_curated'),
      title: curatedTitle,
      content: `MF08-UI-CURATED-${crypto.randomUUID()}`,
    });
    return {
      manifestId: manifest.manifest.manifest_id,
      manifestSha256: manifest.manifest.manifest_sha256,
      payloadSha256: manifest.manifest.payload_sha256,
      contextId,
      expiredContextId,
      rawExperienceId,
      summaryExperienceId,
      summaryText,
      curatedId: curated.curated_id,
      curatedTitle,
    };
  } finally {
    sqlite.close();
  }
}

async function openMemoryPanel(page: Page): Promise<void> {
  await page.locator('#memory-open').click();
  await page.waitForSelector('#memory-drawer[open]');
  await page.waitForFunction(
    `(document.getElementById('memory-capability') || {}).textContent.length > 0`,
  );
}

async function closeMemoryPanel(page: Page): Promise<void> {
  if (await page.locator('#memory-drawer[open]').count()) {
    await page.locator('#memory-close').click();
    await page.waitForFunction(`!document.getElementById('memory-drawer').open`);
  }
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const metrics = await page.evaluate(`(() => {
    const doc = document.documentElement;
    const body = document.body;
    const card = document.querySelector('.memory-card');
    return {
      doc: doc.scrollWidth - doc.clientWidth,
      body: body.scrollWidth - body.clientWidth,
      card: card ? card.scrollWidth - card.clientWidth : 0
    };
  })()`) as { doc: number; body: number; card: number };
  check(label, metrics.doc <= 1 && metrics.body <= 1 && metrics.card <= 1, metrics);
}

async function calledTools(page: Page): Promise<string[]> {
  return (await page.evaluate('window.__calledTools || []')) as string[];
}

async function runDisabledChecks(browser: Browser, base: string, allErrors: string[]): Promise<void> {
  const token = newToken();
  await memoryTool(base, token, 'network_register', {
    request_id: requestId('mem_disabled_human'),
    kind: 'human',
    name: '记忆禁用验收人类',
  });
  const { context, page } = await makePage(browser, token, allErrors, {
    viewport: { width: 1280, height: 900 },
  });
  try {
    await page.goto(`${base}/`);
    await openMemoryPanel(page);
    await page.waitForFunction(
      `(document.getElementById('memory-capability').textContent || '').includes('Memory 未启用')`,
    );
    const capability = (await page.locator('#memory-capability').textContent()) || '';
    check('部署禁用显示降级说明', capability.includes('Memory 未启用') && capability.includes('聊天、群聊、任务与文件仍照常可用'), capability);
    checkEqual('部署禁用隐藏 Memory 视图', await page.locator('#memory-tabs').isHidden(), true);
    checkEqual('部署禁用隐藏面板内容', await page.locator('#memory-panels').isHidden(), true);
    const tools = await calledTools(page);
    check(
      '部署禁用不调用 Memory 内容工具',
      tools.every((name) => !name.startsWith('network_memory_')),
      tools,
    );
  } finally {
    await context.close();
  }
}

async function runHumanChecks(
  browser: Browser,
  base: string,
  humanToken: string,
  allErrors: string[],
): Promise<void> {
  const { context, page } = await makePage(browser, humanToken, allErrors, {
    viewport: { width: 1280, height: 900 },
  });
  try {
    await page.goto(`${base}/`);
    await openMemoryPanel(page);
    await page.waitForFunction(
      `(document.getElementById('memory-capability').textContent || '').includes('当前身份是人类')`,
    );
    const capability = (await page.locator('#memory-capability').textContent()) || '';
    check('人类身份展示能力目录', capability.includes('Memory 已启用') && capability.includes('已适配宿主'), capability);
    check('人类身份说明正文不可读', capability.includes('管理者不能通过此面板读取其他 Agent 的记忆'), capability);
    checkEqual('人类身份隐藏 Memory 视图', await page.locator('#memory-tabs').isHidden(), true);
    const tools = await calledTools(page);
    check(
      '人类身份不调用 Memory 内容工具',
      tools.every((name) => !name.startsWith('network_memory_')),
      tools,
    );
  } finally {
    await context.close();
  }
}

async function runAgentChecks(
  browser: Browser,
  base: string,
  dataDir: string,
  fixture: Fixture,
  allErrors: string[],
): Promise<void> {
  const { context, page } = await makePage(browser, fixture.agentToken, allErrors, {
    viewport: { width: 1280, height: 900 },
  });
  try {
    await page.goto(`${base}/`);
    await openMemoryPanel(page);
    await page.waitForFunction(`!document.getElementById('memory-tabs').hidden`);
    const pageMarker = await page.evaluate('window.__memoryPageMarker');
    const capability = (await page.locator('#memory-capability').textContent()) || '';
    check('Agent 状态展示启用与宿主等级',
      capability.includes('Memory 已启用') && capability.includes('当前宿主等级') &&
        capability.includes('已适配宿主'), capability);
    check('Agent 状态展示采集与召回模式',
      capability.includes('capture=true') && capability.includes('召回模式') &&
        capability.includes('显式查询'), capability);
    check('Agent 状态展示支持与不支持项',
      capability.includes('支持能力') && capability.includes('明确不支持') &&
        capability.includes('自动注入'), capability);
    check('Agent 状态展示作业计数',
      capability.includes('待处理作业') && capability.includes('可用上下文'), capability);

    await page.locator('#memory-recall-query').fill('MF08 验收查询');
    await page.locator('#memory-recall-form button[type=submit]').click();
    await page.waitForFunction(
      `(document.getElementById('memory-recall-result').textContent || '').includes('当前不支持')`,
    );
    const recallText = (await page.locator('#memory-recall-result').textContent()) || '';
    check('真实召回展示 unsupported 状态', recallText.includes('当前不支持') && recallText.includes('不会伪造空库'), recallText);

    const synthetic = {
      recall_id: 'mr_mf08_ui',
      status: 'ready',
      coverage: 'bounded',
      evidence_complete: true,
      freshness: { as_of: Date.now(), backend_revision: 'rev_ui' },
      items: [{
        origin_kind: 'experienced',
        representation: { kind: 'summary', text_bytes: 42, text_sha256: 'a'.repeat(64) },
        evidence: 'host_reported_submitted',
        source: { source_id: 'msrc_ui', source_revision: 1 },
        score: 0.5,
        trust: 'reference_data',
      }],
      context: null,
      exclusions: [{ reason: 'budget', source_id: null, detail: '预算裁剪' }],
      context_ref: null,
      injection: { eligible: false, admit_required: true, reason: 'lookup_only' },
      budget_used: { candidates: 1, packaged_bytes: 42, truncated: false },
    };
    const rendered = await page.evaluate(`(() => {
      if (typeof memoryRenderRecall !== 'function') return false;
      memoryRenderRecall(${JSON.stringify(synthetic)});
      return true;
    })()`) as boolean;
    check('召回条目渲染器可调用', rendered);
    if (rendered) {
      const renderedText = (await page.locator('#memory-recall-result').textContent()) || '';
      check('召回结果渲染条目与排除原因',
        renderedText.includes('已返回') && renderedText.includes('摘要') &&
          renderedText.includes('宿主报告已提交') && renderedText.includes('排除原因'),
        renderedText);
      check('召回结果强调参考数据',
        renderedText.includes('未获得注入许可') && renderedText.includes('自动进入模型输入'), renderedText);
    }

    await page.locator('[data-memory-tab="context"]').click();
    await page.waitForFunction(
      `(document.getElementById('memory-context-list').textContent || '').includes('还没有记忆上下文')`,
    );
    const emptyContexts = (await page.locator('#memory-context-list').textContent()) || '';
    check('上下文空态说明来源', emptyContexts.includes('还没有记忆上下文'), emptyContexts);

    await page.locator('[data-memory-tab="experience"]').click();
    await page.waitForFunction(
      `(document.getElementById('memory-experience-list').textContent || '').includes('还没有实际提交形成的输入经历')`,
    );
    const emptyExperiences = (await page.locator('#memory-experience-list').textContent()) || '';
    check('经历空态不把未消费显示为待办',
      emptyExperiences.includes('不会显示为待办') && emptyExperiences.includes('伪报为已读'),
      emptyExperiences);

    await page.locator('[data-memory-tab="governance"]').click();
    await page.waitForFunction(
      `(document.getElementById('memory-curated-list').textContent || '').includes('还没有人工保存的记忆')`,
    );
    await page.waitForFunction(
      `(document.getElementById('memory-source-list').textContent || '').includes('还没有该 Agent 实际获得过的来源')`,
    );
    checkEqual('治理初始来源为空态',
      ((await page.locator('#memory-source-list').textContent()) || '').includes('还没有该 Agent 实际获得过的来源'),
      true);

    const seeded = await seedMemoryData(base, dataDir, fixture);

    await page.locator('[data-memory-tab="context"]').click();
    await page.locator('#memory-context-refresh').click();
    await page.waitForSelector(`[data-memory-context-id="${seeded.contextId}"]`);
    const contextRows = await page.locator('#memory-context-list [data-memory-context-id]').count();
    check('上下文列表渲染 active 与 expired', contextRows >= 2, contextRows);
    await page.locator(`[data-memory-context-id="${seeded.contextId}"]`).click();
    await page.waitForFunction(
      `(document.getElementById('memory-context-detail').textContent || '').includes(${JSON.stringify(fixture.secret)})`,
    );
    const contextDetail = (await page.locator('#memory-context-detail').textContent()) || '';
    check('上下文正文展示来源与证据',
      contextDetail.includes('当前有效') && contextDetail.includes('宿主报告已提交') &&
        contextDetail.includes('来源房间'), contextDetail);
    check('上下文正文不显示 provider/bank',
      !/provider|bank|hindsight|space_id|backend_binding/i.test(contextDetail), contextDetail);
    await page.locator(`[data-memory-context-id="${seeded.expiredContextId}"]`).click();
    await page.waitForFunction(
      `(document.getElementById('memory-context-detail').textContent || '').includes('当前不可读取')`,
    );
    const expiredDetail = (await page.locator('#memory-context-detail').textContent()) || '';
    check('过期上下文展示 unavailable 且不返回正文',
      expiredDetail.includes('已过期') && !expiredDetail.includes(fixture.secret), expiredDetail);

    await page.locator('[data-memory-tab="experience"]').click();
    await page.locator('#memory-experience-refresh').click();
    await page.waitForSelector(`[data-memory-experience-id="${seeded.rawExperienceId}"]`);
    const experienceList = (await page.locator('#memory-experience-list').textContent()) || '';
    check('经历列表渲染摘要与原文等级',
      experienceList.includes('摘要') && experienceList.includes('原文') &&
        experienceList.includes('宿主报告已提交'), experienceList);
    check('经历列表展示空间边界',
      experienceList.includes('成员代次') && experienceList.includes('记忆验收人类'), experienceList);
    await page.locator(`[data-memory-experience-id="${seeded.rawExperienceId}"]`).click();
    await page.waitForFunction(
      `(document.getElementById('memory-experience-detail').textContent || '').includes(${JSON.stringify(fixture.secret)})`,
    );
    const experienceDetail = (await page.locator('#memory-experience-detail').textContent()) || '';
    check('经历详情展示正文与来源修订',
      experienceDetail.includes('来源房间') && experienceDetail.includes('来源修订'),
      experienceDetail);
    check('经历详情不显示 provider/bank',
      !/provider|bank|hindsight|space_id|backend_binding/i.test(experienceDetail), experienceDetail);
    await page.locator(`[data-memory-experience-id="${seeded.summaryExperienceId}"]`).click();
    await page.waitForFunction(
      `(document.getElementById('memory-experience-detail').textContent || '').includes(${JSON.stringify(seeded.summaryText)})`,
    );
    const summaryDetail = (await page.locator('#memory-experience-detail').textContent()) || '';
    check('摘要经历说明不代表原文全部读取',
      summaryDetail.includes('摘要经历') && summaryDetail.includes('不代表原文已全部读取'),
      summaryDetail);

    await page.locator('[data-memory-tab="host"]').click();
    await page.waitForFunction(
      `(document.getElementById('memory-host-info').textContent || '').includes('宿主与输入')`,
    );
    const hostInfo = (await page.locator('#memory-host-info').textContent()) || '';
    check('宿主页展示绑定与清单流程',
      hostInfo.includes('network_memory_host_bind') && hostInfo.includes('SubmittedInputManifest') &&
        hostInfo.includes('input_exposure'), hostInfo);
    await page.locator('#memory-manifest-id').fill(seeded.manifestId);
    await page.locator('#memory-manifest-form button[type=submit]').click();
    await page.waitForFunction(
      `(document.getElementById('memory-manifest-result').textContent || '').includes('宿主报告已提交')`,
    );
    const manifestText = (await page.locator('#memory-manifest-result').textContent()) || '';
    check('清单状态展示证据与提炼资格',
      manifestText.includes('宿主报告已提交') && manifestText.includes('是（已有合格回执）'),
      manifestText);
    check('清单状态不声称模型已采用',
      manifestText.includes('不是提交证据'), manifestText);

    await page.locator('[data-memory-tab="governance"]').click();
    await page.locator('#memory-governance-refresh').click();
    await page.waitForFunction(
      `(document.getElementById('memory-curated-list').textContent || '').includes(${JSON.stringify(seeded.curatedTitle)})`,
    );
    const beforeForget = (await calledTools(page)).filter((name) => name === 'network_memory_forget').length;
    await page.locator(`[data-memory-forget-kind="curated"][data-memory-forget-id="${seeded.curatedId}"]`).click();
    await page.waitForSelector('#memory-confirm-apply');
    const confirmText = (await page.locator('#memory-confirm-text, .memory-confirm').textContent()) || '';
    check('遗忘前展示确认与影响范围',
      confirmText.includes('确认遗忘') && confirmText.includes('不会因此自动撤回'), confirmText);
    const duringConfirm = (await calledTools(page)).filter((name) => name === 'network_memory_forget').length;
    checkEqual('确认前不调用遗忘工具', duringConfirm, beforeForget);
    await page.locator('#memory-confirm-cancel').click();
    await page.waitForFunction(`!document.getElementById('memory-confirm-apply')`);
    const afterCancel = (await calledTools(page)).filter((name) => name === 'network_memory_forget').length;
    checkEqual('取消后仍不调用遗忘工具', afterCancel, beforeForget);
    await page.locator(`[data-memory-forget-kind="curated"][data-memory-forget-id="${seeded.curatedId}"]`).click();
    await page.locator('#memory-confirm-apply').click();
    await page.waitForFunction(
      `(document.getElementById('memory-operation').textContent || '').includes('治理操作状态')`,
    );
    const operationText = (await page.locator('#memory-operation').textContent()) || '';
    check('遗忘后展示 pending 与清除未知',
      operationText.includes('处理中') && operationText.includes('清除状态未知'),
      operationText);
    const afterForget = (await calledTools(page)).filter((name) => name === 'network_memory_forget').length;
    checkEqual('确认后只调用一次遗忘工具', afterForget, beforeForget + 1);
    await page.waitForFunction(
      `(document.getElementById('memory-curated-list').textContent || '').includes('还没有人工保存的记忆')`,
    );
    check('遗忘后人工记忆列表刷新', true);

    await page.waitForSelector('[data-memory-forget-kind="source"]');
    const sourceForget = page.locator('[data-memory-forget-kind="source"]').first();
    const sourceId = await sourceForget.getAttribute('data-memory-forget-id');
    await sourceForget.click();
    await page.waitForSelector('#memory-confirm-apply');
    await page.locator('#memory-confirm-apply').click();
    await page.waitForFunction(
      `(document.getElementById('memory-source-list').textContent || '').includes('当前不可读')`,
    );
    check('来源移除后标记不可读',
      ((await page.locator('#memory-source-list').textContent()) || '').includes('当前不可读'),
      await page.locator('#memory-source-list').textContent());
    checkEqual('来源移除后不再提供可读遗忘入口',
      sourceId ? await page.locator(`[data-memory-forget-id="${sourceId}"]`).count() : -1,
      0);

    await page.locator('[data-memory-tab="recall"]').click();
    await page.locator('#memory-recall-query').fill('MF08 二次查询');
    await page.locator('#memory-recall-form button[type=submit]').click();
    await page.waitForFunction(
      `(document.getElementById('memory-recall-result').textContent || '').includes('当前不支持')`,
    );
    checkEqual(
      'Memory 更新只刷新局部，不跳整页',
      await page.evaluate('window.__memoryPageMarker'),
      pageMarker,
    );

    await assertNoHorizontalOverflow(page, '桌面端 Memory 抽屉无横向溢出');
  } finally {
    await context.close();
  }
}

async function runMobileChecks(
  browser: Browser,
  base: string,
  fixture: Fixture,
  allErrors: string[],
): Promise<void> {
  const { context, page } = await makePage(browser, fixture.agentToken, allErrors, {
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  });
  try {
    await page.goto(`${base}/`);
    await openMemoryPanel(page);
    await page.waitForFunction(`!document.getElementById('memory-tabs').hidden`);
    checkEqual('移动端使用暗色偏好',
      await page.evaluate(`matchMedia('(prefers-color-scheme: dark)').matches`), true);
    const background = await page.evaluate(
      `getComputedStyle(document.querySelector('.memory-card')).backgroundColor`,
    );
    const rgb = String(background).match(/\d+/gu)?.map(Number) ?? [255, 255, 255];
    const average = ((rgb[0] ?? 255) + (rgb[1] ?? 255) + (rgb[2] ?? 255)) / 3;
    check('暗色面板使用深色背景', average < 110, background);
    const cardWidth = await page.evaluate(
      `document.querySelector('.memory-card').getBoundingClientRect().width`,
    );
    check('移动端 Memory 面板为单栏全宽', Number(cardWidth) >= 388, cardWidth);
    await assertNoHorizontalOverflow(page, '移动端 Memory 抽屉无横向溢出');
    await page.locator('[data-memory-tab="experience"]').click();
    await page.waitForFunction(
      `(document.getElementById('memory-experience-list').textContent || '').length > 0`,
    );
    await assertNoHorizontalOverflow(page, '移动端经历列表无横向溢出');
    await closeMemoryPanel(page);

    await page.locator('#memory-open').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#memory-drawer[open]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(`!document.getElementById('memory-drawer').open`);
    check('键盘 Enter 打开、Escape 关闭', true);

    const storage = await page.evaluate(`(() => {
      const values = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        values.push(key + '=' + String(localStorage.getItem(key) || ''));
      }
      return values.join('\\n');
    })()`) as string;
    check('localStorage 不含记忆正文', !storage.includes(fixture.secret), storage);
  } finally {
    await context.close();
  }
}

export async function runMemoryWebAcceptance(options: MemoryWebOptions): Promise<void> {
  const { browser, disabledBase, allErrors } = options;
  await runDisabledChecks(browser, disabledBase, allErrors);
  const server = await startMemoryServer();
  try {
    const fixture = await createFixture(server.base);
    await runHumanChecks(browser, server.base, fixture.humanToken, allErrors);
    await runAgentChecks(browser, server.base, server.dataDir, fixture, allErrors);
    await runMobileChecks(browser, server.base, fixture, allErrors);
  } finally {
    await server.stop();
  }
}
