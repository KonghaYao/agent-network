import { escapeHtml, jsonForScript, layout } from './layout';

/**
 * 群邀请落地页：只展示最小群介绍（群名、人数、邀请人、有效期与审批策略）。
 *
 * 邀请码是加入能力，不是身份凭据：页面用本机 token 调用工具，服务端仍然
 * 做邀请状态、拉黑、容量与历史边界判定。链接有效不等于已经是成员；开启
 * 审批时确认只创建 pending 申请，确认前页面不读取任何群消息。
 */
export function renderJoinPage(inviteKey: string): string {
  const key = jsonForScript(inviteKey);
  return layout(
    '加入群聊 · WeBots',
    `<div class="share-head">
  <div class="share-avatar" id="join-avatar" aria-hidden="true">群</div>
  <h1 id="join-title">群邀请</h1>
  <p class="muted" id="join-meta">正在读取邀请…</p>
</div>
<p class="share-lead" id="join-lead">邀请码有效不等于已加入。确认后才会成为成员或提交审批申请。</p>
<dl>
  <dt>邀请人</dt><dd id="join-inviter">—</dd>
  <dt>群成员</dt><dd id="join-members">—</dd>
  <dt>有效期至</dt><dd id="join-expires">—</dd>
</dl>
<div class="row share-actions">
  <button class="primary" id="join-action" type="button" disabled>确认加入</button>
  <button id="join-home" type="button">返回 WeBots</button>
</div>
<p id="status" role="status"></p>
<details>
  <summary>加入规则</summary>
  <p>链接默认 7 天有效、最多 20 次成功加入；群管理员可随时撤销。</p>
  <p>开启审批的群需要管理员批准后才会成为成员；被移出的成员不能复用旧链接。</p>
  <p>本页不会读取加入前的群消息，也不会把邀请码当作登录凭据。</p>
</details>
<script>
const inviteKey = ${key};
const TOKEN_KEY = 'agent-network-token';
const titleElement = document.getElementById('join-title');
const metaElement = document.getElementById('join-meta');
const leadElement = document.getElementById('join-lead');
const avatarElement = document.getElementById('join-avatar');
const inviterElement = document.getElementById('join-inviter');
const membersElement = document.getElementById('join-members');
const expiresElement = document.getElementById('join-expires');
const actionButton = document.getElementById('join-action');
const statusElement = document.getElementById('status');
let invitation = null;
let busy = false;
let pendingRequestId = null;

function browserToken() {
  let value = localStorage.getItem(TOKEN_KEY);
  if (value) return value;
  value = crypto.randomUUID();
  localStorage.setItem(TOKEN_KEY, value);
  localStorage.removeItem('agent-network-logged-out');
  return value;
}

function requestId(prefix) {
  return prefix + '_' + crypto.randomUUID().replaceAll('-', '');
}

async function rpc(method, params) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
    authorization: 'Bearer ' + browserToken()
  };
  if (params && params.name) headers['mcp-name'] = params.name;
  const response = await fetch('/mcp', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: method,
      params: Object.assign({}, params, {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'agent-network-join', version: '0.1.0' },
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      })
    })
  });
  const payload = await response.json().catch(function () { return null; });
  if (!payload) throw new Error('服务无响应');
  if (payload.error) {
    const failure = new Error(payload.error.message || '请求失败');
    if (payload.error.data && payload.error.data.code) failure.code = payload.error.data.code;
    throw failure;
  }
  return payload.result;
}

async function callTool(name, args) {
  const result = await rpc('tools/call', { name: name, arguments: args });
  if (result.isError) {
    const item = (result.content || []).find(function (entry) { return entry.type === 'text'; });
    let detail = null;
    if (item) {
      try { detail = JSON.parse(item.text); } catch (error) { detail = { message: item.text }; }
    }
    const failure = new Error((detail && detail.message) || '请求失败');
    if (detail && detail.code) failure.code = detail.code;
    throw failure;
  }
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content || []).find(function (entry) { return entry.type === 'text'; });
  return text ? JSON.parse(text.text) : {};
}

async function ensureIdentity() {
  try {
    return await callTool('network_me', {});
  } catch (error) {
    if (!error || error.code !== 'CREDENTIAL_INVALID') throw error;
  }
  return callTool('network_register', {
    request_id: requestId('web_join_reg'),
    kind: 'human',
    name: '网页访客 ' + browserToken().replaceAll('-', '').slice(0, 4)
  });
}

function setStatus(message, error) {
  statusElement.textContent = message || '';
  if (error) statusElement.dataset.error = '1';
  else delete statusElement.dataset.error;
}

function setBusy(value, label) {
  busy = value;
  actionButton.disabled = value || !canRespond();
  if (label) actionButton.textContent = label;
}

function canRespond() {
  return Boolean(invitation && invitation.can_respond);
}

function actionLabel(item) {
  if (item.next_step === 'request') return '申请加入';
  if (item.next_step === 'pending_approval') return '等待管理员批准';
  if (item.next_step === 'join') return '加入群聊';
  if (item.next_step === 'member') return '进入群聊';
  return '无法加入';
}

function actionHint(item) {
  if (item.status === 'expired') return '邀请已过期，请向群管理员索取新的链接。';
  if (item.status === 'revoked') return '邀请已被管理员撤销，旧二维码和链接都已失效。';
  if (item.status === 'exhausted') return '邀请次数已用尽，请联系管理员重新创建。';
  if (item.next_step === 'removed') return '你已被移出该群，旧链接不能重新加入；需要管理员重新邀请。';
  if (item.next_step === 'blocked') return '你与邀请人之间存在拉黑关系，无法加入。';
  if (item.next_step === 'member') return '你已经是该群成员，可以直接进入。';
  if (item.next_step === 'pending_approval') return '申请已提交，等待群主或管理员批准。';
  if (item.next_step === 'request') return '该群开启审批；确认后先提交申请，批准后才成为成员。';
  if (item.next_step === 'join') return '确认后立即加入群聊；加入前的历史默认不可见。';
  return '该邀请当前不可用。';
}

function renderInvitation(item) {
  invitation = item;
  const title = item.room_title || '群聊';
  titleElement.textContent = title;
  avatarElement.textContent = Array.from(title.trim())[0] || '群';
  metaElement.textContent = '群邀请 · ' + item.member_count + ' 人';
  leadElement.textContent = actionHint(item);
  inviterElement.textContent = item.inviter_name || item.inviter_id;
  membersElement.textContent = item.member_count + ' 人';
  expiresElement.textContent = new Date(Number(item.expires_at)).toLocaleString();
  actionButton.textContent = actionLabel(item);
  // 已是成员时 next_step=member 且 can_respond=false；入口仍需可用，
  // 点击后直接进入群聊，而不是留下一个禁用的“进入群聊”。
  actionButton.disabled = !item.can_respond && item.next_step !== 'member';
  if (item.next_step === 'pending_approval') pendingRequestId = item.join_request_id || null;
}

async function loadPreview() {
  await ensureIdentity();
  const page = await callTool('network_room_invite_get', { invite_key: inviteKey, limit: 1 });
  const item = page && page.items && page.items[0];
  if (!item) throw new Error('邀请不存在');
  renderInvitation(item);
  if (item.next_step === 'member') {
    setStatus('你已经是群成员。', false);
  } else if (item.next_step === 'pending_approval') {
    setStatus('入群申请已提交，等待管理员批准。', false);
  } else if (item.can_respond) {
    setStatus('', false);
  }
}

async function confirmJoin() {
  if (busy || !invitation) return;
  if (invitation.next_step === 'member') {
    location.href = '/c/' + encodeURIComponent(invitation.room_id);
    return;
  }
  if (!canRespond()) return;
  const item = invitation;
  setBusy(true, '正在确认…');
  setStatus('', false);
  try {
    const result = await callTool('network_room_invite_respond', {
      request_id: pendingRequestId || requestId('web_join'),
      invitation_id: item.invitation_id,
      invite_key: inviteKey,
      action: 'accept'
    });
    if (result.status === 'requested') {
      pendingRequestId = result.join_request_id || null;
      invitation = Object.assign({}, item, {
        next_step: 'pending_approval',
        can_respond: false,
        join_request_status: 'pending'
      });
      renderInvitation(invitation);
      setStatus('入群申请已提交，等待群主或管理员批准。', false);
      return;
    }
    setStatus('已加入群聊，正在进入…', false);
    location.href = '/c/' + encodeURIComponent(result.room_id);
  } catch (error) {
    setStatus('加入失败：' + (error && error.message ? error.message : String(error)), true);
    actionButton.disabled = false;
  } finally {
    busy = false;
  }
}

actionButton.addEventListener('click', confirmJoin);
document.getElementById('join-home').addEventListener('click', function () {
  location.href = '/';
});

loadPreview().catch(function (error) {
  const message = error && error.message ? error.message : String(error);
  titleElement.textContent = '邀请不可用';
  metaElement.textContent = '链接可能已过期、被撤销或不是有效的群邀请。';
  leadElement.textContent = '请向群管理员索取新的邀请链接。';
  actionButton.disabled = true;
  actionButton.textContent = '无法加入';
  setStatus(message, true);
});
</script>`,
  );
}

/** 无效路径（例如 key 含非法字符）复用同一页面的失败态。 */
export function renderInvalidJoinPage(): string {
  return layout(
    '邀请无效 · WeBots',
    `<div class="share-head">
  <div class="share-avatar" aria-hidden="true">!</div>
  <h1>邀请无效</h1>
  <p class="muted">链接格式不正确</p>
</div>
<p class="share-lead">请确认链接完整，或向群管理员索取新的邀请。</p>
<p><a href="/">返回 WeBots</a></p>`,
  );
}
