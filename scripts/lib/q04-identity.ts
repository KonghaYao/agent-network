/**
 * Q04 身份与设备：真实配对弹窗 → 新设备 /pair → 已登录设备核对确认码 →
 * 新设备兑换独立 token；单设备撤销后旧凭据失效且页面给出重新配对下一步；
 * 本机退出与身份切换不吊销服务端 token、不串号。
 */

import type { Browser } from 'playwright';

import {
  check,
  checkEqual,
  makeContext,
  rawTool,
  rawToolError,
  screenshot,
  waitText,
  type Actor,
} from './q04-harness';
import type { Q04State } from './q04-fixture';

interface DeviceView {
  device_id: string;
  current: boolean;
  active_credentials: number;
  status: string;
}

export async function runIdentityAcceptance(state: Q04State, browser: Browser): Promise<void> {
  console.log('· Q04 身份：配对、独立设备、单设备撤销、退出与切换');
  const { context: desktopContext, page: desktop } = await makeContext(
    browser,
    state.tokens.u1,
    { width: 1280, height: 900 },
    state.errors,
  );
  const deviceContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const device = await deviceContext.newPage();
  device.setDefaultTimeout(15_000);
  device.on('pageerror', (error) => state.errors.push(`pair pageerror: ${error.message}`));
  try {
    await desktop.goto(`${state.base}/`);
    await desktop.locator('#room-list .room-item').first().waitFor();
    await desktop.locator('#device-handoff').click();
    await desktop.locator('#handoff-modal').waitFor({ state: 'visible' });
    await desktop.waitForFunction(
      `(document.getElementById('pairing-code').textContent || '').replaceAll('-', '').length === 12`,
    );
    const challenge = ((await desktop.locator('#pairing-code').textContent()) ?? '').replaceAll('-', '');
    check('配对弹窗生成 12 位一次性挑战', challenge.length === 12);
    await screenshot(desktop, 'q04-device-pairing-light-1280', {
      mask: ['#pairing-code', '#handoff-qr', '#pairing-list'],
    });

    await device.goto(`${state.base}/pair#c=${encodeURIComponent(challenge)}`);
    await device.waitForFunction(`location.hash === ''`);
    checkEqual('新设备从 fragment 带入挑战', await device.inputValue('#pair-challenge'), challenge);
    check(
      '配对页不在状态文本输出挑战',
      !((await device.locator('#status').textContent()) ?? '').includes(challenge),
    );
    await device.locator('#pair-start').tap();
    await device.waitForFunction(
      `(document.getElementById('pair-target').textContent || '').includes(${JSON.stringify(state.actors.u1.name)})`,
    );
    const confirmCode = (await device.locator('#pair-confirm').textContent()) ?? '';
    check('新设备显示确认码', /^[0-9A-F]{4}-[0-9A-F]{4}$/u.test(confirmCode), confirmCode);
    check(
      '配对页区分当前身份与目标身份',
      ((await device.locator('#pair-original').textContent()) ?? '').includes('未登录') &&
        ((await device.locator('#pair-target').textContent()) ?? '').includes(state.actors.u1.name),
    );

    await desktop.locator('#pairing-refresh').click();
    await desktop.waitForFunction(
      `(document.body.innerText || '').includes(${JSON.stringify(confirmCode)})`,
    );
    const pairingItem = desktop.locator('#pairing-list .pairing-item').filter({ hasText: confirmCode });
    check(
      '已登录设备核对设备名称与确认码',
      ((await pairingItem.innerText()) ?? '').includes('确认码'),
      await pairingItem.innerText(),
    );
    await pairingItem.locator('button', { hasText: '确认新设备' }).click();
    await waitText(desktop, '#pairing-status', '已确认');
    await device.waitForFunction(`document.getElementById('pair-switch').hidden === false`, undefined, {
      timeout: 15_000,
    });
    check('新设备兑换后需要显式切换', await device.locator('#pair-switch').isVisible());
    await device.locator('#pair-switch').tap();
    await device.waitForURL(`${state.base}/`);
    await device.waitForFunction(
      `document.getElementById('account-name').textContent === ${JSON.stringify(state.actors.u1.name)}`,
    );
    const desktopToken = state.tokens.u1;
    const deviceToken = (await device.evaluate(`localStorage.getItem('agent-network-token')`)) as string;
    check('新设备获得独立 token', Boolean(deviceToken) && deviceToken !== desktopToken);
    const deviceIdentity = await rawTool<Actor>(deviceToken, 'network_me', {});
    checkEqual('新设备仍是同一 actor', deviceIdentity.actor_id, state.actors.u1.actor_id);
    const replayChallenge = await rawToolError(crypto.randomUUID(), 'network_device_pairing_join', {
      request_id: `q04_pair_replay_${Date.now()}`,
      challenge,
      device_id: 'q04-replay-device',
      device_label: '重放设备',
      platform: 'web',
    });
    check(
      '已兑换挑战不能重放',
      ['PAIRING_INVALID', 'CONFLICT', 'NOT_FOUND'].includes(replayChallenge.code),
      replayChallenge,
    );
    await screenshot(device, 'q04-paired-mobile-light');

    // 单设备撤销：只撤销新设备，桌面 token 仍可用；新设备刷新显示重新配对入口。
    const devices = await rawTool<{ items: DeviceView[]; current_device_id: string | null }>(
      desktopToken,
      'network_device_list',
      {},
    );
    const target = devices.items.find(
      (item) => !item.current && item.active_credentials > 0 && item.status === 'active',
    );
    if (!target) throw new Error('未找到新配对设备');
    const revoked = await rawTool<{ device_id: string; revoked_credentials: number }>(
      desktopToken,
      'network_device_revoke',
      { request_id: `q04_device_revoke_${Date.now()}`, device_id: target.device_id },
    );
    checkEqual('撤销只作用于目标设备', revoked.device_id, target.device_id);
    check('撤销至少一条有效凭据', revoked.revoked_credentials >= 1, revoked);
    const revokedDevice = await rawToolError(deviceToken, 'network_me', {});
    checkEqual('被撤销设备旧 token 失效', revokedDevice.code, 'CREDENTIAL_INVALID');
    const desktopStillValid = await rawTool<Actor>(desktopToken, 'network_me', {});
    checkEqual('桌面设备 token 不受影响', desktopStillValid.actor_id, state.actors.u1.actor_id);

    await device.reload();
    await device.waitForFunction(
      `document.getElementById('credential-invalid-pair') &&
        document.getElementById('credential-invalid-pair').hidden === false`,
      undefined,
      { timeout: 15_000 },
    );
    check('失效设备显示重新配对入口', true);
    await device.locator('#credential-invalid-pair').waitFor({ state: 'visible' });
    await screenshot(device, 'q04-device-revoked-mobile');

    // 本机退出与身份切换：切换到第二个身份后退出，再切回原身份。
    if (await desktop.locator('#handoff-modal').isVisible()) {
      await desktop.locator('#handoff-close').click();
      await desktop.locator('#handoff-modal').waitFor({ state: 'hidden' });
    }
    // 第二身份已存在于本机注册表：退出后可从列表显式切换，不依赖旧 #t=。
    await desktop.evaluate(`(() => {
      const record = {
        v: 1,
        actor_id: ${JSON.stringify(state.actors.u2.actor_id)},
        name: ${JSON.stringify(state.actors.u2.name)},
        kind: 'human',
        token: ${JSON.stringify(state.tokens.u2)},
        last_used_at: Date.now()
      };
      localStorage.setItem(
        'agent-network-identity-v1:' + record.actor_id,
        JSON.stringify(record)
      );
    })()`);
    await desktop.locator('#logout').click();
    await desktop.locator('#logout-modal').waitFor({ state: 'visible' });
    await desktop.locator('#logout-confirm').click();
    await desktop.waitForURL(`${state.base}/`);
    await desktop.locator('#logged-out-start').waitFor({ state: 'visible' });
    await desktop.waitForFunction(
      `document.querySelectorAll('#logged-out-identities .local-identity').length >= 1`,
    );
    const identitiesText = (await desktop.locator('#logged-out-identities').innerText()) ?? '';
    check(
      '退出页保留本机第二身份',
      identitiesText.includes(state.actors.u2.name),
      identitiesText,
    );
    await desktop
      .locator('#logged-out-identities .local-identity')
      .filter({ hasText: state.actors.u2.name })
      .click();
    await desktop.waitForFunction(
      `document.getElementById('account-name').textContent === ${JSON.stringify(state.actors.u2.name)}`,
    );
    checkEqual(
      '切换身份后本地 token 为目标身份',
      await desktop.evaluate(`localStorage.getItem('agent-network-token')`),
      state.tokens.u2,
    );

    await desktop.evaluate(`(() => {
      const record = {
        v: 1,
        actor_id: ${JSON.stringify(state.actors.u1.actor_id)},
        name: ${JSON.stringify(state.actors.u1.name)},
        kind: 'human',
        token: ${JSON.stringify(state.tokens.u1)},
        last_used_at: Date.now()
      };
      localStorage.setItem(
        'agent-network-identity-v1:' + record.actor_id,
        JSON.stringify(record)
      );
    })()`);
    await desktop.locator('#logout').click();
    await desktop.locator('#logout-modal').waitFor({ state: 'visible' });
    await desktop.locator('#logout-confirm').click();
    await desktop.waitForURL(`${state.base}/`);
    await desktop.locator('#logged-out-start').waitFor({ state: 'visible' });
    await desktop.waitForFunction(
      `document.querySelectorAll('#logged-out-identities .local-identity').length > 0`,
    );
    const afterLogoutText = (await desktop.locator('#logged-out-identities').innerText()) ?? '';
    check(
      '再次退出后显示本机原身份',
      afterLogoutText.includes(state.actors.u1.name),
      afterLogoutText,
    );
    await desktop
      .locator('#logged-out-identities .local-identity')
      .filter({ hasText: state.actors.u1.name })
      .click();
    await desktop.waitForFunction(
      `document.getElementById('account-name').textContent === ${JSON.stringify(state.actors.u1.name)}`,
    );
    checkEqual(
      '切换回身份后本地 token 恢复',
      await desktop.evaluate(`localStorage.getItem('agent-network-token')`),
      desktopToken,
    );
    const u2StillValid = await rawTool<Actor>(state.tokens.u2, 'network_me', {});
    checkEqual('退出不吊销其他身份凭据', u2StillValid.actor_id, state.actors.u2.actor_id);
  } finally {
    await deviceContext.close();
    await desktopContext.close();
  }
}
