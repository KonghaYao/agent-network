/**
 * PWA 阶段 3a 单元验收：版本比较/节流、忙碌判定、一次性草稿快照与重载熔断。
 *
 * 浏览器行为（提示出现、阻止刷新、快照恢复、错误页）由
 * `tests/e2e/pwa-update.spec.ts` 的隔离 A/B 实例覆盖。
 */

import { LIMITS } from '../src/contracts/limits';
import {
  clearUpdateBusyForTests,
  composerUpdateBusy,
  friendInviteUpdateBusy,
  friendRedeemUpdateBusy,
  getUpdateBusyReasons,
  handoffUpdateBusy,
  outboxUpdateBusy,
  pairingUpdateBusy,
  setUpdateBusy,
} from '../src/web/pwa/update-busy';
import {
  claimUpdateReload,
  getUpdateTabId,
  readUpdateReloadClaim,
  readUpdateSnapshot,
  removeUpdateSnapshot,
  updateSnapshotKey,
  writeUpdateSnapshot,
  type SnapshotStorage,
} from '../src/web/pwa/update-snapshot';
import {
  decideVersionCheck,
  fetchWebVersion,
  parseWebVersion,
  readPageRelease,
  versionRelation,
  type PageRelease,
  type VersionFetch,
  type WebVersionInfo,
} from '../src/web/pwa/version';
import {
  UPDATE_WRITE_BLOCKED_MESSAGE,
  isUpdateWriteBlocked,
  resetUpdateWriteBlockForTests,
  setUpdateWriteBlocked,
  updateWriteBlockReason,
} from '../src/web/pwa/update-write-guard';
import { contractIncompatibleAfter } from '../src/web/pwa/update-store';
import { BOOT_ERROR_MARKUP, BOOT_ERROR_SCRIPT, renderSpaShell } from '../src/web/spa-shell';
import { check, checkEqual, checksPassed } from './lib/harness';

class MemoryStorage implements SnapshotStorage {
  readonly map = new Map<string, string>();
  failWrites = false;
  failReads = false;

  getItem(key: string): string | null {
    if (this.failReads) throw new Error('storage disabled');
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota exceeded');
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const PAGE: PageRelease = { buildId: 'sha256:page', webContract: 1 };
const TARGET: WebVersionInfo = {
  deploymentId: 'r200',
  buildId: 'sha256:target',
  minWebContract: 1,
  maxWebContract: 1,
};

function verifyParsingAndRelation(): void {
  const parsed = parseWebVersion({
    deploymentId: 'r200',
    buildId: 'sha256:target',
    minWebContract: 1,
    maxWebContract: 2,
  });
  checkEqual('解析合法版本公告', parsed?.buildId, 'sha256:target');
  check('拒绝缺少 deploymentId', parseWebVersion({ buildId: 'x', minWebContract: 1, maxWebContract: 1 }) === null);
  check('拒绝无效 buildId', parseWebVersion({ deploymentId: 'r1', buildId: '', minWebContract: 1, maxWebContract: 1 }) === null);
  check('拒绝倒置契约区间', parseWebVersion({ deploymentId: 'r1', buildId: 'x', minWebContract: 2, maxWebContract: 1 }) === null);
  check('拒绝非整数契约', parseWebVersion({ deploymentId: 'r1', buildId: 'x', minWebContract: 1.5, maxWebContract: 2 }) === null);

  checkEqual('同 buildId 即使部署号不同也视为同一版本', versionRelation(PAGE, TARGET), 'update');
  checkEqual(
    '同 buildId 同一版本',
    versionRelation(PAGE, { ...TARGET, buildId: PAGE.buildId, deploymentId: 'r999' }),
    'same',
  );
  checkEqual('兼容新版本', versionRelation(PAGE, TARGET), 'update');
  checkEqual(
    '页面契约低于目标最低值不兼容',
    versionRelation(PAGE, { ...TARGET, minWebContract: 2, maxWebContract: 2 }),
    'incompatible',
  );
  checkEqual(
    '页面契约高于目标最高值不兼容',
    versionRelation(PAGE, { ...TARGET, minWebContract: 0, maxWebContract: 0 }),
    'incompatible',
  );

  const fakeDoc = {
    getElementById: () =>
      ({
        textContent: JSON.stringify({ buildId: 'sha256:page', webContract: 1 }),
      }) as unknown as HTMLElement,
  } as unknown as Document;
  checkEqual('读取 #web-release', readPageRelease(fakeDoc)?.buildId, 'sha256:page');
  check(
    '损坏的 #web-release 返回 null',
    readPageRelease({
      getElementById: () => ({ textContent: '{' }) as unknown as HTMLElement,
    } as unknown as Document) === null,
  );
  check('缺少 #web-release 返回 null', readPageRelease(null) === null);
}

function verifyDecision(): void {
  const now = 1_800_000;
  checkEqual(
    '后台暂停',
    decideVersionCheck({ trigger: 'foreground', visible: false, inFlight: false, now, lastCheckAt: null }),
    'paused',
  );
  checkEqual(
    '进行中合并',
    decideVersionCheck({ trigger: 'foreground', visible: true, inFlight: true, now, lastCheckAt: null }),
    'in-flight',
  );
  checkEqual(
    '启动首查',
    decideVersionCheck({ trigger: 'startup', visible: true, inFlight: false, now, lastCheckAt: null }),
    'run',
  );
  checkEqual(
    '相邻事件 60 秒内节流',
    decideVersionCheck({
      trigger: 'foreground',
      visible: true,
      inFlight: false,
      now,
      lastCheckAt: now - (LIMITS.webVersionCheckThrottleMs - 1),
    }),
    'throttled',
  );
  checkEqual(
    '超过 60 秒允许检查',
    decideVersionCheck({
      trigger: 'foreground',
      visible: true,
      inFlight: false,
      now,
      lastCheckAt: now - LIMITS.webVersionCheckThrottleMs,
    }),
    'run',
  );
  checkEqual(
    '强制检查绕过节流',
    decideVersionCheck({
      trigger: 'forced',
      visible: true,
      inFlight: false,
      now,
      lastCheckAt: now - 1,
    }),
    'run',
  );
  checkEqual('前台周期为 15 分钟', LIMITS.webVersionForegroundIntervalMs, 15 * 60_000);
}

async function verifyFetch(): Promise<void> {
  const valid: VersionFetch = async () => ({
    ok: true,
    async json() {
      return {
        deploymentId: 'r1',
        buildId: 'sha256:x',
        minWebContract: 1,
        maxWebContract: 1,
      };
    },
  });
  checkEqual('读取版本接口', (await fetchWebVersion({ fetchImpl: valid }))?.buildId, 'sha256:x');

  const notFound: VersionFetch = async () => ({
    ok: false,
    async json() {
      return {};
    },
  });
  check('503 返回 null', (await fetchWebVersion({ fetchImpl: notFound })) === null);

  const invalid: VersionFetch = async () => ({
    ok: true,
    async json() {
      return { buildId: '' };
    },
  });
  check('字段损坏返回 null', (await fetchWebVersion({ fetchImpl: invalid })) === null);

  const hanging: VersionFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  const started = Date.now();
  const timedOut = await fetchWebVersion({ fetchImpl: hanging, timeoutMs: 5 });
  check('超时返回 null', timedOut === null);
  check('超时在预算内结束', Date.now() - started < 250);
}

function verifyBusy(): void {
  clearUpdateBusyForTests();
  const idle = composerUpdateBusy({
    composing: false,
    selections: 0,
    reply: false,
    files: [],
    sending: false,
    drawboardLoading: false,
    drawboardOpen: false,
  });
  check('空闲 Composer 不阻止更新', idle.length === 0, JSON.stringify(idle));
  check(
    '纯文字草稿不在忙碌列表中',
    !idle.some((label) => label.includes('草稿')),
  );

  checkEqual(
    '中文输入法组合中',
    composerUpdateBusy({ composing: true, selections: 0, reply: false, files: [], sending: false, drawboardLoading: false, drawboardOpen: false })[0],
    '请先完成中文输入',
  );
  check(
    '已选 @ 阻止更新',
    composerUpdateBusy({ composing: false, selections: 1, reply: false, files: [], sending: false, drawboardLoading: false, drawboardOpen: false }).includes('请先发送或清除已选择的 @ 成员'),
  );
  check(
    '引用阻止更新',
    composerUpdateBusy({ composing: false, selections: 0, reply: true, files: [], sending: false, drawboardLoading: false, drawboardOpen: false }).includes('请先取消当前引用'),
  );
  for (const [status, label] of [
    ['uploading', '请等待附件上传完成'],
    ['failed', '请先移除上传失败的附件'],
    ['ready', '请先发送或移除已添加的附件'],
  ] as const) {
    check(
      `附件 ${status} 阻止更新`,
      composerUpdateBusy({ composing: false, selections: 0, reply: false, files: [{ status }], sending: false, drawboardLoading: false, drawboardOpen: false }).includes(label),
    );
  }
  check(
    '发送在途阻止更新',
    composerUpdateBusy({ composing: false, selections: 0, reply: false, files: [], sending: true, drawboardLoading: false, drawboardOpen: false }).includes('请等待消息发送结果确认'),
  );
  check(
    '画板加载/打开阻止更新',
    composerUpdateBusy({ composing: false, selections: 0, reply: false, files: [], sending: false, drawboardLoading: true, drawboardOpen: true }).join('|').includes('画板'),
  );

  check('配对 joining', pairingUpdateBusy('joining', false, false).length === 1);
  check('配对 awaiting', pairingUpdateBusy('awaiting', false, false).length === 1);
  check('配对 redeeming', pairingUpdateBusy('redeeming', false, false).length === 1);
  check('配对 ready', pairingUpdateBusy('ready', false, false).length === 1);
  check('配对切换账号', pairingUpdateBusy('idle', true, false).includes('正在切换账号'));
  check('扫码中', pairingUpdateBusy('idle', false, true).includes('请先关闭扫码'));
  check('空闲配对不阻止更新', pairingUpdateBusy('idle', false, false).length === 0);
  check('配对码弹窗', handoffUpdateBusy(true).length === 1);
  check('好友兑换', friendRedeemUpdateBusy(true).length === 1);
  check('好友邀请', friendInviteUpdateBusy(true).length === 1);
  check('outbox 发送在途', outboxUpdateBusy(true).length === 1);

  setUpdateBusy('unit:a', '原因 A');
  setUpdateBusy('unit:b', '原因 B');
  checkEqual('忙碌来源聚合数量', getUpdateBusyReasons().length, 2);
  setUpdateBusy('unit:a', null);
  checkEqual('清理一个来源', getUpdateBusyReasons().length, 1);
  clearUpdateBusyForTests();
  checkEqual('清理全部来源', getUpdateBusyReasons().length, 0);
}

function verifySnapshots(): void {
  const storage = new MemoryStorage();
  const tabId = getUpdateTabId(storage);
  check('生成并持久化 tabId', typeof tabId === 'string' && tabId.length > 0);
  checkEqual('tabId 稳定', getUpdateTabId(storage), tabId);

  const source = {
    actorId: 'act_a',
    roomId: 'rm_a',
    text: '更新前的草稿',
    selectionStart: 2,
    selectionEnd: 5,
  };
  check(
    '写入快照',
    writeUpdateSnapshot({
      storage,
      tabId,
      source,
      sourceBuildId: 'sha256:a',
      targetBuildId: 'sha256:b',
      now: 1_000,
    }),
  );
  const raw = storage.map.get(updateSnapshotKey('act_a', 'rm_a', tabId!)) ?? '';
  check('快照不包含 token', !/token|cookie|authorization|challenge/iu.test(raw));
  check('快照不包含文件票据', !/file_ticket|ticket/iu.test(raw));

  const exact = readUpdateSnapshot({
    storage,
    tabId,
    actorId: 'act_a',
    roomId: 'rm_a',
    now: 1_100,
  });
  checkEqual('恢复正文', exact?.text, '更新前的草稿');
  checkEqual('恢复选择起点', exact?.selectionStart, 2);
  checkEqual('恢复选择终点', exact?.selectionEnd, 5);
  checkEqual('记录来源 buildId', exact?.sourceBuildId, 'sha256:a');
  checkEqual('记录目标 buildId', exact?.targetBuildId, 'sha256:b');

  check('账号不一致不恢复', readUpdateSnapshot({ storage, tabId, actorId: 'act_b', roomId: 'rm_a', now: 1_100 }) === null);
  check('房间不一致不恢复', readUpdateSnapshot({ storage, tabId, actorId: 'act_a', roomId: 'rm_b', now: 1_100 }) === null);
  check('标签不一致不恢复', readUpdateSnapshot({ storage, tabId: 'other-tab', actorId: 'act_a', roomId: 'rm_a', now: 1_100 }) === null);
  checkEqual(
    '串号读取不影响正确标签的快照',
    readUpdateSnapshot({ storage, tabId, actorId: 'act_a', roomId: 'rm_a', now: 1_100 })?.text,
    '更新前的草稿',
  );

  removeUpdateSnapshot({ storage, tabId, actorId: 'act_a', roomId: 'rm_a' });
  check('删除后不再恢复', readUpdateSnapshot({ storage, tabId, actorId: 'act_a', roomId: 'rm_a', now: 1_100 }) === null);

  writeUpdateSnapshot({ storage, tabId, source, sourceBuildId: 'a', targetBuildId: 'b', now: 0 });
  check(
    '过期快照不恢复并清理',
    readUpdateSnapshot({
      storage,
      tabId,
      actorId: 'act_a',
      roomId: 'rm_a',
      now: LIMITS.webUpdateSnapshotTtlMs + 1,
    }) === null,
  );
  check('过期快照已删除', !storage.map.has(updateSnapshotKey('act_a', 'rm_a', tabId!)));

  const failing = new MemoryStorage();
  failing.failWrites = true;
  check(
    '写入失败可报告',
    !writeUpdateSnapshot({
      storage: failing,
      tabId: getUpdateTabId(new MemoryStorage()),
      source,
      sourceBuildId: 'a',
      targetBuildId: 'b',
    }),
  );

  const claims = new MemoryStorage();
  const claimTab = getUpdateTabId(claims)!;
  checkEqual(
    '首次重载获得配额',
    claimUpdateReload({ storage: claims, tabId: claimTab, targetBuildId: 'build-b', now: 1 }),
    'claimed',
  );
  checkEqual(
    '同标签同目标第二次拒绝',
    claimUpdateReload({ storage: claims, tabId: claimTab, targetBuildId: 'build-b', now: 2 }),
    'already',
  );
  checkEqual(
    '目标变化重新获得一次',
    claimUpdateReload({ storage: claims, tabId: claimTab, targetBuildId: 'build-c', now: 3 }),
    'claimed',
  );
  checkEqual('记录目标 buildId', readUpdateReloadClaim(claims, claimTab)?.targetBuildId, 'build-c');
  checkEqual(
    '存储不可用不能程序性重载',
    claimUpdateReload({ storage: null, tabId: claimTab, targetBuildId: 'build-c' }),
    'unavailable',
  );
}

function verifyWriteGuard(): void {
  resetUpdateWriteBlockForTests();
  check('默认不拦截写工具', updateWriteBlockReason('network_message_send') === null);
  setUpdateWriteBlocked(true);
  for (const tool of [
    'network_message_send',
    'network_room_file_bind',
    'network_room_file_delete',
    'network_room_create',
    'network_contact_request',
    'network_contact_link_redeem',
  ]) {
    check(`不兼容时拦截 ${tool}`, updateWriteBlockReason(tool) === UPDATE_WRITE_BLOCKED_MESSAGE);
  }
  for (const tool of [
    'network_message_send_status',
    'network_message_read',
    'network_room_mark_read',
    'network_room_file_list',
    'network_me',
  ]) {
    check(`不兼容时仍允许读 ${tool}`, updateWriteBlockReason(tool) === null);
  }
  check('写保护为同步布尔值', isUpdateWriteBlocked());
  resetUpdateWriteBlockForTests();
  check('重置后恢复写入', updateWriteBlockReason('network_message_send') === null);

  check('不兼容后遇到兼容更新仍保持锁定', contractIncompatibleAfter(true, 'update'));
  check('不兼容持续', contractIncompatibleAfter(true, 'incompatible'));
  check('页面等于当前发布才解除', !contractIncompatibleAfter(true, 'same'));
  check('兼容更新不主动加锁', !contractIncompatibleAfter(false, 'update'));
  check('首次不兼容立即加锁', contractIncompatibleAfter(false, 'incompatible'));

  clearUpdateBusyForTests();
  setUpdateBusy('composer', '请等待消息发送结果确认');
  setUpdateBusy('outbox', '请等待消息发送结果确认');
  checkEqual('发送在途原因按文案去重', getUpdateBusyReasons().length, 1);
  setUpdateBusy('outbox', '另一条原因');
  checkEqual('不同原因仍然保留', getUpdateBusyReasons().length, 2);
  clearUpdateBusyForTests();
}

async function main(): Promise<void> {
  verifyParsingAndRelation();
  verifyDecision();
  await verifyFetch();
  verifyBusy();
  verifyWriteGuard();
  verifySnapshots();
  verifyBootShell();
  if (!checksPassed()) process.exit(1);
}

function verifyBootShell(): void {
  check('壳级错误页有独立容器', BOOT_ERROR_MARKUP.includes('id="web-boot-error"'));
  check('壳级错误页有重试按钮', BOOT_ERROR_MARKUP.includes('id="web-boot-retry"'));
  check('壳级错误页默认隐藏', BOOT_ERROR_MARKUP.includes('hidden'));
  check('壳级脚本不读取 localStorage', !BOOT_ERROR_SCRIPT.includes('localStorage'));
  check('壳级脚本不读取 sessionStorage', !BOOT_ERROR_SCRIPT.includes('sessionStorage'));
  check('壳级脚本不请求网络', !BOOT_ERROR_SCRIPT.includes('fetch('));
  check('壳级脚本不自动刷新', !/setTimeout|setInterval/u.test(BOOT_ERROR_SCRIPT));
  check('壳级脚本保留手动重试', BOOT_ERROR_SCRIPT.includes('location.reload()'));

  const html = renderSpaShell('home', {
    entry: '/static/assets/main-test.js',
    css: [],
    buildId: 'sha256:page',
    webContract: 1,
  });
  const root = html.indexOf('<div id="root">');
  const rootEnd = html.indexOf('</div>', root);
  const boot = html.indexOf('id="web-boot-error"');
  const bootScript = html.indexOf('window.__webBootOk');
  const moduleScript = html.indexOf('<script type="module"');
  check('错误页在 #root 外', rootEnd > 0 && boot > rootEnd);
  check('错误脚本先于入口模块', bootScript > 0 && bootScript < moduleScript);
  check('壳内包含独立错误样式', html.includes('.web-boot-error'));
  check('入口模块仍由服务端输出', html.includes('src="/static/assets/main-test.js"'));
  check('错误页不占用 #spa-bootstrap', !BOOT_ERROR_MARKUP.includes('spa-bootstrap'));
}

await main();
