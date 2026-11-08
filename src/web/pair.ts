import { layout } from './layout';

/**
 * `/pair` 新设备配对页。
 *
 * 页面只接收一次性 challenge（`#c=` 或手动输入），在本地生成独立 token；
 * challenge 与 token 都不出现在 DOM、URL 或服务端日志。新设备先 join，
 * 等待已登录设备明确 approve，再 redeem 属于同一 actor 的独立 credential。
 *
 * 若本机已有另一个身份，页面明确显示原身份与目标身份；只有用户点击
 * “切换到此身份并进入”后才写入当前 token，并把原身份保留在本地身份列表。
 */
export function renderPairPage(): string {
  return layout(
    '配对设备 · WeBots',
    `<div class="share-head">
  <div class="share-avatar" aria-hidden="true">链</div>
  <h1 id="pair-title">配对设备</h1>
  <p class="muted" id="pair-current">正在读取当前身份…</p>
</div>
<p class="share-lead">二维码/短码只包含 5 分钟一次性的配对挑战，不包含长期 token。你需要在另一台已登录设备上确认这台新设备。</p>
<label class="field">12 位配对码
  <input id="pair-challenge" maxlength="32" autocomplete="off" spellcheck="false"
    placeholder="XXXX-XXXX-XXXX" aria-describedby="pair-hint">
</label>
<p class="pair-hint" id="pair-hint">可以扫描二维码自动带入，也可以手动输入。挑战过期、已用、已撤销或尝试超限都会失败。</p>
<div class="row share-actions">
  <button class="primary" id="pair-start" type="button">开始配对</button>
  <button id="pair-switch" type="button" hidden>切换到此身份并进入</button>
</div>
<dl class="pair-identities">
  <dt>当前身份</dt><dd id="pair-original">未登录</dd>
  <dt>目标身份</dt><dd id="pair-target">尚未验证</dd>
  <dt>确认码</dt><dd id="pair-confirm">—</dd>
</dl>
<p id="status" role="status"></p>
<details>
  <summary>安全说明</summary>
  <p>新设备在本地生成独立 token，服务端只保存 SHA-256 摘要；已登录设备必须核对设备名称、平台与确认码后批准。</p>
  <p>配对成功后，这台设备获得与原设备相同的 actor 权限，但使用不同 credential。撤销任一台设备只影响该设备的凭据与实时连接。</p>
  <p>如果本机已经登录另一个身份，配对不会自动覆盖它；确认后原身份仍保存在本机身份列表，可再次显式切回。</p>
</details>
<script>
(function () {
  'use strict';
  var TOKEN_KEY = 'agent-network-token';
  var IDENTITY_PREFIX = 'agent-network-identity-v1:';
  var DEVICE_ID_KEY = 'agent-network-device-id-v1';
  var PAIR_TOKEN_PREFIX = 'agent-network-pair-token:';
  var challengeInput = document.getElementById('pair-challenge');
  var startButton = document.getElementById('pair-start');
  var switchButton = document.getElementById('pair-switch');
  var currentElement = document.getElementById('pair-current');
  var originalElement = document.getElementById('pair-original');
  var targetElement = document.getElementById('pair-target');
  var confirmElement = document.getElementById('pair-confirm');
  var statusElement = document.getElementById('status');
  var localToken = null;
  var pairing = null;
  var targetIdentity = null;
  var currentIdentity = null;
  var redeemRequestId = null;
  var pollTimer = null;
  var busy = false;

  function setStatus(text, error) {
    statusElement.textContent = text || '';
    if (error) statusElement.setAttribute('data-error', '1');
    else statusElement.removeAttribute('data-error');
  }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (error) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (error) { return false; }
  }
  function sessionGet(key) {
    try { return window.sessionStorage.getItem(key); } catch (error) { return null; }
  }
  function sessionSet(key, value) {
    try { window.sessionStorage.setItem(key, value); return true; } catch (error) { return false; }
  }
  function sessionRemove(key) {
    try { window.sessionStorage.removeItem(key); } catch (error) {}
  }

  function normalizeChallenge(value) {
    return String(value || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '')
      .replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
  }

  function challengeFromHash() {
    var hash = window.location.hash || '';
    if (hash.indexOf('#c=') !== 0) return '';
    try {
      return decodeURIComponent(hash.slice(3));
    } catch (error) {
      return '';
    }
  }

  function currentToken() {
    return storageGet(TOKEN_KEY);
  }

  function rememberIdentity(me, token) {
    if (!me || !me.actor_id || !token) return false;
    var record = {
      v: 1,
      actor_id: me.actor_id,
      name: me.name || '未命名',
      kind: me.kind === 'agent' ? 'agent' : 'human',
      token: token,
      last_used_at: Date.now()
    };
    return storageSet(IDENTITY_PREFIX + me.actor_id, JSON.stringify(record));
  }

  function deviceId() {
    var value = storageGet(DEVICE_ID_KEY);
    if (value && /^[A-Za-z0-9._:-]{1,256}$/.test(value)) return value;
    value = crypto.randomUUID();
    if (!storageSet(DEVICE_ID_KEY, value)) {
      value = sessionGet('agent-network-pair-device-id');
      if (!value) {
        value = crypto.randomUUID();
        sessionSet('agent-network-pair-device-id', value);
      }
    }
    return value;
  }

  function deviceLabel() {
    var ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone/iPad';
    if (/Android/i.test(ua)) return 'Android 设备';
    if (/Macintosh/i.test(ua)) return 'Mac';
    if (/Windows/i.test(ua)) return 'Windows 设备';
    return '浏览器设备';
  }

  function requestId(prefix) {
    return prefix + '_' + crypto.randomUUID().replace(/-/g, '');
  }

  async function rpc(method, params, token) {
    var authToken = token === undefined ? currentToken() : token;
    var headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method
    };
    if (authToken) headers.authorization = 'Bearer ' + authToken;
    if (params && params.name) headers['mcp-name'] = params.name;
    var response = await fetch('/mcp', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: method,
        params: Object.assign({}, params, {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'agent-network-pair', version: '0.1.0' },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        })
      })
    });
    var payload = await response.json().catch(function () { return null; });
    if (!payload) throw new Error('服务无响应');
    if (payload.error) {
      var failure = new Error(payload.error.message || '请求失败');
      if (payload.error.data && payload.error.data.code) failure.code = payload.error.data.code;
      if (payload.error.data && payload.error.data.details) failure.details = payload.error.data.details;
      throw failure;
    }
    return payload.result;
  }

  async function callTool(name, args, token) {
    var result = await rpc('tools/call', { name: name, arguments: args }, token);
    if (result.isError) {
      var item = (result.content || []).find(function (entry) { return entry.type === 'text'; });
      var detail = null;
      if (item) {
        try { detail = JSON.parse(item.text); } catch (error) { detail = { message: item.text }; }
      }
      var failure = new Error((detail && detail.message) || '请求失败');
      if (detail && detail.code) failure.code = detail.code;
      if (detail && detail.details) failure.details = detail.details;
      throw failure;
    }
    if (result.structuredContent) return result.structuredContent;
    var text = (result.content || []).find(function (entry) { return entry.type === 'text'; });
    return text ? JSON.parse(text.text) : {};
  }

  async function loadCurrentIdentity() {
    var token = currentToken();
    if (!token) {
      originalElement.textContent = '未登录（配对成功后将新建当前身份）';
      currentElement.textContent = '这台设备尚未登录';
      return;
    }
    try {
      currentIdentity = await callTool('network_me', {}, token);
      originalElement.textContent = (currentIdentity.name || '未命名') +
        '（' + currentIdentity.actor_id + '）';
      currentElement.textContent = '当前身份：' + (currentIdentity.name || '未命名');
      rememberIdentity(currentIdentity, token);
    } catch (error) {
      currentIdentity = null;
      originalElement.textContent = '当前身份凭据已失效';
      currentElement.textContent = '当前身份凭据已失效；不会自动创建替代身份';
      if (error && (error.code === 'CREDENTIAL_INVALID' || error.code === 'UNAUTHORIZED')) {
        setStatus('当前 token 已失效；仍可完成配对，但成功后会用新身份替换失效凭据。', true);
      }
    }
  }

  function localPairToken() {
    var challenge = normalizeChallenge(challengeInput.value);
    var key = PAIR_TOKEN_PREFIX + challenge;
    var value = sessionGet(key);
    if (value) return value;
    value = crypto.randomUUID();
    sessionSet(key, value);
    return value;
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function nextStepFor(reason) {
    if (reason === 'expired') return '挑战已过期；请让已登录设备重新生成二维码或短码。';
    if (reason === 'cancelled') return '挑战已被拒绝或撤销；请让已登录设备重新生成。';
    if (reason === 'already_redeemed') return '挑战已被使用；请让已登录设备重新生成。';
    if (reason === 'attempts_exceeded') return '尝试次数已用尽；请让已登录设备重新生成挑战。';
    if (reason === 'device_mismatch') return '当前 token 不是该挑战绑定的设备；请重新开始配对。';
    if (reason === 'revoked_device') return '该设备已被撤销；请联系已登录设备撤销旧设备后重新配对。';
    if (reason === 'not_approved') return '已登录设备尚未确认；请等待后重试，或让已登录设备在“配对设备”里确认。';
    return '请检查配对码后重试，或让已登录设备重新生成挑战。';
  }

  async function startPairing() {
    if (busy) return;
    var challenge = normalizeChallenge(challengeInput.value);
    if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(challenge)) {
      setStatus('配对码必须是 12 位（不含 I/L/O/U）；请扫描二维码或让已登录设备重新生成。', true);
      return;
    }
    busy = true;
    startButton.disabled = true;
    switchButton.hidden = true;
    targetIdentity = null;
    pairing = null;
    stopPolling();
    setStatus('正在向已登录设备发起配对请求…', false);
    localToken = localPairToken();
    try {
      var joined = await callTool('network_device_pairing_join', {
        request_id: requestId('pair_join'),
        challenge: challenge,
        device_id: deviceId(),
        device_label: deviceLabel(),
        platform: (navigator.platform || 'web').slice(0, 60)
      }, localToken);
      pairing = joined.pairing;
      targetIdentity = joined.actor;
      confirmElement.textContent = joined.pairing.confirm_code || '—';
      targetElement.textContent = (joined.actor.name || '未命名') +
        '（' + joined.actor.actor_id + '）';
      currentElement.textContent = currentIdentity
        ? '当前身份：' + (currentIdentity.name || '未命名')
        : '这台设备尚未登录';
      setStatus('已发起配对。请让已登录设备核对设备名称与确认码后点击“确认新设备”。', false);
      redeemRequestId = requestId('pair_redeem');
      scheduleRedeem();
    } catch (error) {
      var reason = error && error.details ? error.details.reason : '';
      setStatus('配对失败：' + (error && error.message ? error.message : String(error)) +
        ' ' + nextStepFor(reason), true);
    } finally {
      busy = false;
      startButton.disabled = false;
    }
  }

  function scheduleRedeem() {
    stopPolling();
    pollTimer = setTimeout(redeem, 2000);
  }

  async function redeem() {
    if (!pairing || !localToken || !redeemRequestId) return;
    try {
      var redeemed = await callTool('network_device_pairing_redeem', {
        request_id: redeemRequestId,
        challenge: normalizeChallenge(challengeInput.value),
        device_id: deviceId()
      }, localToken);
      targetIdentity = redeemed;
      stopPolling();
      setStatus('已获得独立凭据。确认后切换到此身份并进入；原身份会保留在本机身份列表。', false);
      switchButton.hidden = false;
      startButton.disabled = true;
      return;
    } catch (error) {
      var reason = error && error.details ? error.details.reason : '';
      if (reason === 'not_approved') {
        setStatus('等待已登录设备确认。请在另一台设备打开“配对设备”并核对确认码。', false);
        scheduleRedeem();
        return;
      }
      stopPolling();
      setStatus('兑换失败：' + (error && error.message ? error.message : String(error)) +
        ' ' + nextStepFor(reason), true);
      startButton.disabled = false;
      switchButton.hidden = true;
    }
  }

  async function switchIdentity() {
    if (!targetIdentity || !localToken) return;
    var previousToken = currentToken();
    if (!storageSet('agent-network-token', localToken)) {
      setStatus('浏览器无法保存身份；请允许本地存储后重新配对。', true);
      return;
    }
    if (currentIdentity && previousToken) {
      rememberIdentity(currentIdentity, previousToken);
    }
    if (!rememberIdentity(targetIdentity, localToken)) {
      if (previousToken) storageSet('agent-network-token', previousToken);
      else {
        try { window.localStorage.removeItem('agent-network-token'); } catch (error) {}
      }
      setStatus('浏览器无法保存身份列表；请允许本地存储后重试。', true);
      return;
    }
    try { window.localStorage.removeItem('agent-network-logged-out'); } catch (error) {}
    sessionRemove(PAIR_TOKEN_PREFIX + normalizeChallenge(challengeInput.value));
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (error) {}
    window.location.replace('/');
  }

  startButton.addEventListener('click', startPairing);
  switchButton.addEventListener('click', switchIdentity);
  challengeInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (switchButton.hidden) startPairing();
      else switchIdentity();
    }
  });

  var initial = challengeFromHash();
  if (initial) {
    challengeInput.value = initial.toUpperCase();
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (error) {}
  }
  loadCurrentIdentity();
})();
</script>`,
    `
  .field { display: block; margin: 0 0 10px; font-size: 13px; }
  .field input { width: 100%; height: 42px; margin-top: 6px; border: 1px solid #dcdcdc;
    border-radius: 4px; padding: 0 10px; background: #fff; color: #1a1a1a; font: inherit; }
  .pair-hint { margin: 0 0 14px; font-size: 12px; color: #666; line-height: 1.6; }
  .pair-identities { margin: 16px 0 4px; }
  .pair-identities dd { overflow-wrap: anywhere; }
  #status[data-error] { color: #fa5151; }
  @media (prefers-color-scheme: dark) {
    .field input { background: #2b2b2b; border-color: #3a3a3a; color: #e5e5e5; }
    .pair-hint { color: #a3a3a3; }
  }
`,
  );
}
