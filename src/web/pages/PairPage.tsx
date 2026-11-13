import { useEffect, useRef, useState } from 'react';

import { callTool, type McpError } from '../lib/mcp-client';
import {
  LOGGED_OUT_KEY,
  PAIR_TOKEN_PREFIX,
  TOKEN_KEY,
  currentToken,
  deviceId,
  deviceLabel,
  newRequestId,
  normalizeChallenge,
  pairSessionToken,
  rememberIdentity,
  sessionRemove,
  storageRemove,
  storageSet,
  takePairingChallenge,
} from '../lib/token-handoff';

interface PairingView {
  pairing_id: string;
  confirm_code: string | null;
}

interface PairingIdentity {
  actor_id: string;
  name: string;
  kind: 'human' | 'agent';
}

interface PairingJoinResult {
  pairing: PairingView;
  actor: PairingIdentity;
}

interface PairingRedeemResult extends PairingIdentity {
  paired: true;
}

interface PairingMe extends PairingIdentity {
  name: string;
}

let cachedChallenge: string | null = null;

/** 只在 PairPage 首次渲染时读取并清除 `#c=`，StrictMode 双调用也得到同一值。 */
function initialPairingChallenge(): string {
  if (cachedChallenge === null) cachedChallenge = takePairingChallenge();
  return cachedChallenge;
}

function nextStepFor(reason: unknown): string {
  if (reason === 'expired') return '挑战已过期；请让已登录设备重新生成二维码或短码。';
  if (reason === 'cancelled') return '挑战已被拒绝或撤销；请让已登录设备重新生成。';
  if (reason === 'already_redeemed') return '挑战已被使用；请让已登录设备重新生成。';
  if (reason === 'attempts_exceeded') return '尝试次数已用尽；请让已登录设备重新生成挑战。';
  if (reason === 'device_mismatch') return '当前 token 不是该挑战绑定的设备；请重新开始配对。';
  if (reason === 'revoked_device') return '该设备已被撤销；请联系已登录设备撤销旧设备后重新配对。';
  if (reason === 'not_approved') return '已登录设备尚未确认；请等待后重试，或让已登录设备在“配对设备”里确认。';
  return '请检查配对码后重试，或让已登录设备重新生成挑战。';
}

function failureReason(error: unknown): unknown {
  return (error as McpError).details?.reason;
}

function failureText(error: unknown): string {
  return (error as McpError).message || String(error);
}

/**
 * `/pair` 新设备配对页。
 *
 * challenge 只在 `#c=` 中出现，读取后立即清除；本地 token 在配对成功前
 * 不注册。页面轮询 redeem 直到已登录设备 approve，成功后显式显示切换按钮，
 * 原身份保留在本机身份列表。token 与 challenge 都不写入 URL 文本或日志。
 */
export function PairPage() {
  const [challenge, setChallenge] = useState(() => initialPairingChallenge().toUpperCase());
  const [currentLabel, setCurrentLabel] = useState('正在读取当前身份…');
  const [originalLabel, setOriginalLabel] = useState('未登录');
  const [targetLabel, setTargetLabel] = useState('尚未验证');
  const [confirmCode, setConfirmCode] = useState('—');
  const [status, setStatusState] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startDisabled, setStartDisabled] = useState(false);
  const [switchVisible, setSwitchVisible] = useState(false);

  const mounted = useRef(true);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pairing = useRef<PairingView | null>(null);
  const targetIdentity = useRef<PairingIdentity | null>(null);
  const currentIdentity = useRef<PairingMe | null>(null);
  const redeemRequestId = useRef<string | null>(null);
  const localToken = useRef<string | null>(null);
  const credentialReady = useRef(false);
  const pairingChallenge = useRef<string | null>(null);

  function setStatus(text: string, isError: boolean) {
    setStatusState(text);
    setError(isError);
  }

  function stopPolling() {
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }

  useEffect(() => {
    mounted.current = true;
    async function loadCurrentIdentity() {
      const token = currentToken();
      if (!token) {
        if (!mounted.current) return;
        setOriginalLabel('未登录（配对成功后将新建当前身份）');
        setCurrentLabel('这台设备尚未登录');
        return;
      }
      try {
        const me = await callTool<PairingMe>('network_me', {}, { token });
        if (!mounted.current) return;
        currentIdentity.current = me;
        setOriginalLabel(`${me.name || '未命名'}（${me.actor_id}）`);
        setCurrentLabel(`当前身份：${me.name || '未命名'}`);
        rememberIdentity(me, token);
      } catch (failure) {
        if (!mounted.current) return;
        currentIdentity.current = null;
        setOriginalLabel('当前身份凭据已失效');
        setCurrentLabel('当前身份凭据已失效；不会自动创建替代身份');
        const code = (failure as McpError).code;
        if (code === 'CREDENTIAL_INVALID' || code === 'UNAUTHORIZED') {
          setStatus('当前 token 已失效；仍可完成配对，但成功后会用新身份替换失效凭据。', true);
        }
      }
    }
    void loadCurrentIdentity();
    return () => {
      mounted.current = false;
      // 允许下一次从新的 `#c=` 重新接管；StrictMode 的 effect 重放不会
      // 重跑 useState 初始化，因此不会丢失当前挑战。
      cachedChallenge = null;
      stopPolling();
    };
    // 只在页面首次挂载时读取当前身份；配对流程自行维护后续状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scheduleRedeem() {
    stopPolling();
    pollTimer.current = setTimeout(() => {
      void redeem();
    }, 2000);
  }

  async function redeem() {
    if (!pairing.current || !localToken.current || !redeemRequestId.current || credentialReady.current) {
      return;
    }
    const requestGeneration = generation.current;
    const token = localToken.current;
    const challengeValue = pairingChallenge.current;
    const request = redeemRequestId.current;
    try {
      const redeemed = await callTool<PairingRedeemResult>(
        'network_device_pairing_redeem',
        { request_id: request, challenge: challengeValue, device_id: deviceId() },
        { token },
      );
      if (requestGeneration !== generation.current || !mounted.current) return;
      targetIdentity.current = redeemed;
      credentialReady.current = true;
      stopPolling();
      setStatus('已获得独立凭据。确认后切换到此身份并进入；原身份会保留在本机身份列表。', false);
      setSwitchVisible(true);
      setStartDisabled(true);
    } catch (failure) {
      if (requestGeneration !== generation.current || !mounted.current) return;
      const reason = failureReason(failure);
      if (reason === 'not_approved') {
        setStatus('等待已登录设备确认。请在另一台设备打开“配对设备”并核对确认码。', false);
        scheduleRedeem();
        return;
      }
      stopPolling();
      setStatus(`兑换失败：${failureText(failure)} ${nextStepFor(reason)}`, true);
      setStartDisabled(false);
      setSwitchVisible(false);
    }
  }

  async function startPairing() {
    if (busyRef.current) return;
    const normalized = normalizeChallenge(challenge);
    if (!/^[0-9A-HJKMNP-TV-Z]{12}$/u.test(normalized)) {
      setStatus('配对码必须是 12 位（不含 I/L/O/U）；请扫描二维码或让已登录设备重新生成。', true);
      return;
    }
    const requestGeneration = ++generation.current;
    pairingChallenge.current = normalized;
    credentialReady.current = false;
    busyRef.current = true;
    setBusy(true);
    setStartDisabled(false);
    setSwitchVisible(false);
    targetIdentity.current = null;
    pairing.current = null;
    stopPolling();
    setStatus('正在向已登录设备发起配对请求…', false);
    const token = pairSessionToken(normalized);
    localToken.current = token;
    try {
      const joined = await callTool<PairingJoinResult>(
        'network_device_pairing_join',
        {
          request_id: newRequestId('pair_join'),
          challenge: normalized,
          device_id: deviceId(),
          device_label: deviceLabel(),
          platform: (navigator.platform || 'web').slice(0, 60),
        },
        { token },
      );
      if (requestGeneration !== generation.current || !mounted.current) return;
      pairing.current = joined.pairing;
      targetIdentity.current = joined.actor;
      setConfirmCode(joined.pairing.confirm_code || '—');
      setTargetLabel(`${joined.actor.name || '未命名'}（${joined.actor.actor_id}）`);
      setCurrentLabel(
        currentIdentity.current
          ? `当前身份：${currentIdentity.current.name || '未命名'}`
          : '这台设备尚未登录',
      );
      setStatus('已发起配对。请让已登录设备核对设备名称与确认码后点击“确认新设备”。', false);
      redeemRequestId.current = newRequestId('pair_redeem');
      scheduleRedeem();
    } catch (failure) {
      if (requestGeneration !== generation.current || !mounted.current) return;
      setStatus(`配对失败：${failureText(failure)} ${nextStepFor(failureReason(failure))}`, true);
    } finally {
      if (requestGeneration === generation.current) {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  function switchIdentity() {
    if (!credentialReady.current || !targetIdentity.current || !localToken.current) return;
    const previousToken = currentToken();
    const token = localToken.current;
    if (!storageSet(TOKEN_KEY, token)) {
      setStatus('浏览器无法保存身份；请允许本地存储后重新配对。', true);
      return;
    }
    if (currentIdentity.current && previousToken) {
      rememberIdentity(currentIdentity.current, previousToken);
    }
    if (!rememberIdentity(targetIdentity.current, token)) {
      if (previousToken) storageSet(TOKEN_KEY, previousToken);
      else storageRemove(TOKEN_KEY);
      setStatus('浏览器无法保存身份列表；请允许本地存储后重试。', true);
      return;
    }
    try {
      window.localStorage.removeItem(LOGGED_OUT_KEY);
    } catch {
      // 忽略；首页仍会按当前 token 读取身份。
    }
    if (pairingChallenge.current) sessionRemove(PAIR_TOKEN_PREFIX + pairingChallenge.current);
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      // 忽略。
    }
    window.location.replace('/');
  }

  return (
    <main>
      <div className="share-head">
        <div className="share-avatar" aria-hidden="true">
          链
        </div>
        <h1 id="pair-title">配对设备</h1>
        <p className="muted" id="pair-current">
          {currentLabel}
        </p>
      </div>
      <p className="share-lead">扫描二维码或输入 12 位配对码，然后在已登录设备上确认。</p>
      <label className="field">
        12 位配对码
        <input
          id="pair-challenge"
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX"
          aria-describedby="pair-hint"
          value={challenge}
          onChange={(event) => setChallenge(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (switchVisible) switchIdentity();
            else void startPairing();
          }}
        />
      </label>
      <p className="pair-hint" id="pair-hint">
        挑战 5 分钟内有效，用后即失效。
      </p>
      <div className="row share-actions">
        <button
          className="primary"
          id="pair-start"
          type="button"
          disabled={busy || startDisabled}
          onClick={() => {
            void startPairing();
          }}
        >
          开始配对
        </button>
        <button
          id="pair-switch"
          type="button"
          hidden={!switchVisible}
          onClick={switchIdentity}
        >
          切换到此身份并进入
        </button>
      </div>
      <dl className="pair-identities">
        <dt>当前身份</dt>
        <dd id="pair-original">{originalLabel}</dd>
        <dt>目标身份</dt>
        <dd id="pair-target">{targetLabel}</dd>
        <dt>确认码</dt>
        <dd id="pair-confirm">{confirmCode}</dd>
      </dl>
      <p id="status" role="status" data-error={error ? '1' : undefined}>
        {status}
      </p>
      <details>
        <summary>安全说明</summary>
        <p>
          新设备使用本地生成的独立 token；已登录设备必须核对设备名称、平台与确认码后批准。原身份会保留在本机身份列表。
        </p>
      </details>
    </main>
  );
}
