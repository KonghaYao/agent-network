import { Button, Input, Label } from '../app/lenso-controls';
import { useEffect, useRef, useState } from 'react';

import { LIMITS } from '../../contracts/limits';
import { PairScanner } from '../features/pairing/PairScanner';
import { callTool, type McpError } from '../lib/mcp-client';
import { resolvePairingAttempt, type PairingAttempt } from '../lib/pairing-attempt';
import { isPairingChallenge, parsePairingQr } from '../lib/pairing-qr';
import {
  IDENTITY_PREFIX,
  LOGGED_OUT_KEY,
  PAIR_TOKEN_PREFIX,
  TOKEN_KEY,
  currentToken,
  deviceId,
  deviceLabel,
  hasLoggedOutState,
  newRequestId,
  normalizeChallenge,
  pairSessionToken,
  rememberedIdentityCount,
  rememberIdentity,
  sessionRemove,
  storageGet,
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

type PairingPhase = 'idle' | 'joining' | 'awaiting' | 'redeeming' | 'ready' | 'error';

type AccountBaseline = 'empty' | 'existing' | 'unknown';

interface AccountSnapshot {
  token: string | null;
  loggedOut: boolean;
  identityCount: number;
}

let cachedChallenge: string | null = null;

/** 只在 PairPage 首次渲染时读取并清除 `#c=`，StrictMode 双调用也得到同一值。 */
function initialPairingChallenge(): string {
  if (cachedChallenge === null) cachedChallenge = takePairingChallenge();
  return cachedChallenge;
}

/** standalone 安装引导主按钮进入 `/pair?scan=1`，首次挂载直接打开扫描。 */
function initialScanRequested(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('scan') === '1';
  } catch {
    return false;
  }
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
 * 短码输入、`/pair#c=` 深链与 App 内扫码共用同一套状态机和请求上下文：
 * 同一挑战只 join 一次，等待批准与网络重试复用原 join/redeem request_id。
 * challenge 只在 `#c=` 或扫码结果中出现，读取后立即清除 fragment；本地
 * token 在配对成功前不注册。
 *
 * 兑换成功后先用兑换 token 调 `network_me` 核对目标 actor。只有开始时
 * 确认“从未有账号”、期间 token/退出状态/身份列表未变化（含跨标签页
 * storage 事件与瞬时变化），且落盘与读回全部成功时才自动进入；其余
 * 情况保留显式切换，绝不覆盖晚到的新身份。原身份只在 token 未变或能用
 * `network_me` 核对为同一 actor 时写入身份列表。
 */
export function PairPage() {
  const [challenge, setChallenge] = useState(() => initialPairingChallenge().toUpperCase());
  const [currentLabel, setCurrentLabel] = useState('正在读取当前身份…');
  const [originalLabel, setOriginalLabel] = useState('未登录');
  const [targetLabel, setTargetLabel] = useState('尚未验证');
  const [confirmCode, setConfirmCode] = useState('—');
  const [status, setStatusState] = useState('');
  const [error, setError] = useState(false);
  const [phase, setPhaseState] = useState<PairingPhase>('idle');
  const [scanOpen, setScanOpen] = useState(false);
  const [switchVisible, setSwitchVisible] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);

  const mounted = useRef(true);
  const phaseRef = useRef<PairingPhase>('idle');
  const generation = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joiningRef = useRef(false);
  const redeemingRef = useRef(false);
  const switchingRef = useRef(false);
  const attemptRef = useRef<PairingAttempt | null>(null);
  const targetIdentity = useRef<PairingIdentity | null>(null);
  const currentIdentity = useRef<PairingMe | null>(null);
  const credentialReady = useRef(false);
  const accountBaseline = useRef<AccountBaseline>('unknown');
  const baselineReady = useRef(false);
  const baselineToken = useRef<string | null>(null);
  const baselineLoggedOut = useRef(false);
  const baselineIdentityCount = useRef(0);
  const pairingSnapshot = useRef<AccountSnapshot | null>(null);
  const accountChangedDuringPairing = useRef(false);
  const watchingAccountChanges = useRef(false);
  const initialChallenge = useRef(challenge);
  const scanRequested = useRef(initialScanRequested());

  const busy = phase === 'joining' || phase === 'redeeming';
  const startDisabled =
    busy || phase === 'awaiting' || phase === 'ready' || switchBusy;
  const scanDisabled =
    scanOpen || busy || phase === 'awaiting' || phase === 'ready' || switchBusy;

  function changePhase(next: PairingPhase) {
    phaseRef.current = next;
    if (mounted.current) setPhaseState(next);
  }

  function setStatus(text: string, isError: boolean) {
    if (!mounted.current) return;
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
      const loggedOut = hasLoggedOutState();
      const identityCount = rememberedIdentityCount();
      baselineToken.current = token;
      baselineLoggedOut.current = loggedOut;
      baselineIdentityCount.current = identityCount;

      if (!token) {
        baselineReady.current = true;
        if (loggedOut || identityCount > 0) {
          accountBaseline.current = 'existing';
          setOriginalLabel(
            loggedOut
              ? '已退出登录；配对成功后需确认切换'
              : '本机已有登录记录；配对成功后需确认切换',
          );
          setCurrentLabel(loggedOut ? '这台设备已退出登录' : '这台设备已有登录记录');
        } else {
          accountBaseline.current = 'empty';
          setOriginalLabel('未登录（配对成功后将自动进入）');
          setCurrentLabel('这台设备尚未登录');
        }
        return;
      }

      try {
        const me = await callTool<PairingMe>('network_me', {}, { token });
        if (!mounted.current) return;
        currentIdentity.current = me;
        accountBaseline.current = 'existing';
        baselineReady.current = true;
        setOriginalLabel(`${me.name || '未命名'}（${me.actor_id}）`);
        setCurrentLabel(`当前身份：${me.name || '未命名'}`);
        rememberIdentity(me, token);
      } catch (failure) {
        if (!mounted.current) return;
        currentIdentity.current = null;
        baselineReady.current = true;
        const code = (failure as McpError).code;
        if (code === 'CREDENTIAL_INVALID' || code === 'UNAUTHORIZED') {
          accountBaseline.current = 'existing';
          setOriginalLabel('当前身份凭据已失效');
          setCurrentLabel('当前身份凭据已失效；不会自动创建替代身份');
          setStatus('当前 token 已失效；仍可完成配对，但成功后需确认切换。', true);
        } else {
          accountBaseline.current = 'unknown';
          setOriginalLabel('暂时无法核对当前身份');
          setCurrentLabel('暂时无法核对当前身份；配对完成后需确认切换');
          setStatus('读取当前身份失败；配对完成后不会自动切换，请手动确认。', true);
        }
      }
    }
    void loadCurrentIdentity();
    if (scanRequested.current && !initialChallenge.current) setScanOpen(true);
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

  // 跨标签页的 token/退出标记/身份列表变化不会反映在首尾比较里：另一个
  // 标签页可能短暂写入再删除 token。配对期间只要收到相关 storage 事件就
  // 记为“账号状态已变化”，后续只能走显式确认。
  useEffect(() => {
    const storagePrototype = Storage.prototype;
    const originalSetItem = storagePrototype.setItem;
    const originalRemoveItem = storagePrototype.removeItem;
    const originalClear = storagePrototype.clear;
    let patchedSetItem = false;
    let patchedRemoveItem = false;
    let patchedClear = false;

    function noteKey(key: string | null) {
      if (!watchingAccountChanges.current) return;
      if (
        key === null ||
        key === TOKEN_KEY ||
        key === LOGGED_OUT_KEY ||
        key.startsWith(IDENTITY_PREFIX)
      ) {
        accountChangedDuringPairing.current = true;
      }
    }

    function onStorage(event: StorageEvent) {
      noteKey(event.key);
    }

    // 同标签页的写入不会触发 `storage` 事件；短暂写入再删除的 token 只能
    // 在 Storage 方法上打标记才能发现。包装只做观测，不改变存储语义。
    try {
      storagePrototype.setItem = function (key: string, value: string) {
        noteKey(String(key));
        return originalSetItem.call(this, key, value);
      };
      patchedSetItem = true;
    } catch {
      // 不允许包装时退回 storage 事件监听。
    }
    try {
      storagePrototype.removeItem = function (key: string) {
        noteKey(String(key));
        return originalRemoveItem.call(this, key);
      };
      patchedRemoveItem = true;
    } catch {
      // 同上。
    }
    try {
      storagePrototype.clear = function () {
        noteKey(null);
        return originalClear.call(this);
      };
      patchedClear = true;
    } catch {
      // 同上。
    }

    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      if (patchedSetItem) storagePrototype.setItem = originalSetItem;
      if (patchedRemoveItem) storagePrototype.removeItem = originalRemoveItem;
      if (patchedClear) storagePrototype.clear = originalClear;
    };
  }, []);

  function captureAccountSnapshot(): AccountSnapshot {
    return {
      token: currentToken(),
      loggedOut: hasLoggedOutState(),
      identityCount: rememberedIdentityCount(),
    };
  }

  /** 配对开始时的快照；同一挑战重试不会重置，避免漏掉等待期间的变化。 */
  function beginPairingAccountWatch(): void {
    pairingSnapshot.current = captureAccountSnapshot();
    accountChangedDuringPairing.current = false;
    watchingAccountChanges.current = true;
  }

  /**
   * 配对期间是否出现过 token/退出标记/身份数变化。除 storage 事件标记外，
   * 还在兑换完成时与配对开始快照比较，覆盖同标签页里持续存在的变化。
   */
  function pairingAccountChanged(): boolean {
    if (accountChangedDuringPairing.current) return true;
    const snapshot = pairingSnapshot.current;
    if (!snapshot) return true;
    if (
      currentToken() !== snapshot.token ||
      hasLoggedOutState() !== snapshot.loggedOut ||
      rememberedIdentityCount() !== snapshot.identityCount
    ) {
      accountChangedDuringPairing.current = true;
      return true;
    }
    return false;
  }

  /** 让已排队的 storage 事件先派发，再决定是否自动进入。 */
  function flushStorageEvents(): Promise<void> {
    return new Promise((resolveFlush) => {
      setTimeout(resolveFlush, 0);
    });
  }

  function accountStateUnchanged(): boolean {
    return (
      currentToken() === baselineToken.current &&
      hasLoggedOutState() === baselineLoggedOut.current &&
      rememberedIdentityCount() === baselineIdentityCount.current
    );
  }

  function restorePreviousToken(previousToken: string | null): void {
    if (previousToken) storageSet(TOKEN_KEY, previousToken);
    else storageRemove(TOKEN_KEY);
  }

  /**
   * 切换到配对身份前保存原身份。仅当 token 仍是页面挂载时读取的那个、
   * 或换号后能用 `network_me` 核对为同一 actor 时才写入；unknown 基线
   * （`currentIdentity` 为空）不凭空配对 actor 与 token。
   */
  async function preservePreviousIdentity(previousToken: string | null): Promise<void> {
    const expected = currentIdentity.current;
    if (!expected || !previousToken) return;
    if (previousToken === baselineToken.current) {
      rememberIdentity(expected, previousToken);
      return;
    }
    try {
      const observed = await callTool<PairingMe>('network_me', {}, { token: previousToken });
      if (observed.actor_id === expected.actor_id) {
        rememberIdentity(observed, previousToken);
      }
    } catch {
      // 配对期间换号后无法核对旧 token：不写入，避免 actor 与 token 错配。
    }
  }

  /**
   * 写入 token 与身份列表并逐项读回。任何一步失败都恢复原 token 与退出
   * 标记，移除本次写入的身份，不留下半初始化状态。
   */
  async function persistIdentity(identity: PairingMe, attempt: PairingAttempt): Promise<boolean> {
    const previousToken = currentToken();
    const previousLoggedOut = storageGet(LOGGED_OUT_KEY);
    await preservePreviousIdentity(previousToken);
    if (!mounted.current) return false;
    if (!storageSet(TOKEN_KEY, attempt.token) || currentToken() !== attempt.token) {
      restorePreviousToken(previousToken);
      setStatus('浏览器无法保存身份；请允许本地存储后重试。', true);
      return false;
    }
    const savedTarget =
      rememberIdentity(identity, attempt.token) &&
      storageGet(IDENTITY_PREFIX + identity.actor_id) !== null;
    storageRemove(LOGGED_OUT_KEY);
    const clearedLoggedOut = storageGet(LOGGED_OUT_KEY) === null;
    if (!savedTarget || !clearedLoggedOut) {
      storageRemove(IDENTITY_PREFIX + identity.actor_id);
      restorePreviousToken(previousToken);
      if (previousLoggedOut !== null) storageSet(LOGGED_OUT_KEY, previousLoggedOut);
      setStatus('浏览器无法保存身份列表；请允许本地存储后重试。', true);
      return false;
    }
    sessionRemove(PAIR_TOKEN_PREFIX + attempt.challenge);
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      // 忽略地址栏清理失败。
    }
    return true;
  }

  function enterHome(): void {
    window.location.replace('/');
  }

  /** 显式切换前如实说明原身份能否保留，不再无条件承诺。 */
  function previousIdentityHint(): string {
    const token = currentToken();
    if (!currentIdentity.current) {
      return token ? '当前身份未能核对，不会写入本机身份列表。' : '本机当前没有已登录身份。';
    }
    if (token && token === baselineToken.current) {
      return '当前身份会保存在本机身份列表。';
    }
    return '配对期间账号状态已变化；原身份仅在切换时核对一致才会保存。';
  }

  async function finishRedemption(
    redeemed: PairingRedeemResult,
    attempt: PairingAttempt,
    requestGeneration: number,
  ): Promise<void> {
    let me: PairingMe;
    try {
      me = await callTool<PairingMe>('network_me', {}, { token: attempt.token });
    } catch (failure) {
      if (requestGeneration !== generation.current || !mounted.current) return;
      credentialReady.current = true;
      targetIdentity.current = redeemed;
      changePhase('ready');
      setSwitchVisible(true);
      setStatus(
        `已获得独立凭据，但暂时无法核对目标身份：${failureText(failure)}。请点击“切换到此身份并进入”重试。`,
        true,
      );
      return;
    }
    if (requestGeneration !== generation.current || !mounted.current) return;
    if (me.actor_id !== redeemed.actor_id) {
      credentialReady.current = false;
      stopPolling();
      changePhase('error');
      setStatus('目标身份核对失败：兑换结果与当前凭据不一致。请重新扫码或换码。', true);
      setSwitchVisible(false);
      return;
    }

    credentialReady.current = true;
    targetIdentity.current = me;
    setTargetLabel(`${me.name || '未命名'}（${me.actor_id}）`);
    await flushStorageEvents();
    if (requestGeneration !== generation.current || !mounted.current) return;
    const autoEnter =
      baselineReady.current &&
      accountBaseline.current === 'empty' &&
      accountStateUnchanged() &&
      !pairingAccountChanged();
    if (autoEnter) {
      const saved = await persistIdentity(me, attempt);
      if (!mounted.current) return;
      if (saved) {
        enterHome();
        return;
      }
      changePhase('ready');
      setSwitchVisible(true);
      return;
    }

    changePhase('ready');
    setSwitchVisible(true);
    setStatus(`已获得独立凭据。确认后切换到此身份并进入；${previousIdentityHint()}`, false);
  }

  async function redeem(requestGeneration = generation.current) {
    const attempt = attemptRef.current;
    if (
      !attempt ||
      !attempt.joined ||
      credentialReady.current ||
      redeemingRef.current ||
      requestGeneration !== generation.current
    ) {
      return;
    }
    redeemingRef.current = true;
    if (phaseRef.current !== 'awaiting') {
      changePhase('redeeming');
      setStatus('正在兑换独立凭据；若电脑尚未确认，会继续等待。', false);
    }
    try {
      const redeemed = await callTool<PairingRedeemResult>(
        'network_device_pairing_redeem',
        {
          request_id: attempt.redeemRequestId,
          challenge: attempt.challenge,
          device_id: attempt.deviceId,
        },
        { token: attempt.token },
      );
      if (requestGeneration !== generation.current || !mounted.current) return;
      stopPolling();
      await finishRedemption(redeemed, attempt, requestGeneration);
    } catch (failure) {
      if (requestGeneration !== generation.current || !mounted.current) return;
      const reason = failureReason(failure);
      if (reason === 'not_approved') {
        setStatus('等待已登录设备确认。请在另一台设备打开“配对设备”并核对确认码。', false);
        changePhase('awaiting');
        scheduleRedeem(requestGeneration);
        return;
      }
      stopPolling();
      changePhase('error');
      setStatus(`兑换失败：${failureText(failure)} ${nextStepFor(reason)}`, true);
      setSwitchVisible(false);
    } finally {
      redeemingRef.current = false;
    }
  }

  function scheduleRedeem(requestGeneration: number) {
    stopPolling();
    pollTimer.current = setTimeout(() => {
      pollTimer.current = null;
      void redeem(requestGeneration);
    }, LIMITS.webPairingRedeemPollMs);
  }

  function resetAttemptView(): void {
    credentialReady.current = false;
    targetIdentity.current = null;
    setConfirmCode('—');
    setTargetLabel('尚未验证');
    setSwitchVisible(false);
  }

  async function startPairing(parsedChallenge?: string) {
    const normalized = normalizeChallenge(parsedChallenge ?? challenge);
    if (
      phaseRef.current === 'joining' ||
      phaseRef.current === 'redeeming' ||
      phaseRef.current === 'awaiting' ||
      phaseRef.current === 'ready' ||
      joiningRef.current ||
      redeemingRef.current ||
      switchingRef.current
    ) {
      return;
    }
    if (!isPairingChallenge(normalized)) {
      setStatus(
        '配对码必须是 12 位（不含 I/L/O/U）；请扫描二维码或让已登录设备重新生成。',
        true,
      );
      return;
    }

    const resolved = resolvePairingAttempt(attemptRef.current, normalized, () => ({
      token: pairSessionToken(normalized),
      joinRequestId: newRequestId('pair_join'),
      redeemRequestId: newRequestId('pair_redeem'),
      deviceId: deviceId(),
      deviceLabel: deviceLabel(),
      platform: (navigator.platform || 'web').slice(0, 60),
    }));
    const attempt = resolved.attempt;
    attemptRef.current = attempt;
    const requestGeneration = ++generation.current;
    stopPolling();
    setChallenge(attempt.challenge);
    setScanOpen(false);
    if (!resolved.reused) {
      resetAttemptView();
      beginPairingAccountWatch();
    }

    if (attempt.joined) {
      changePhase('awaiting');
      setStatus('正在向已登录设备重试兑换…', false);
      await redeem(requestGeneration);
      return;
    }

    joiningRef.current = true;
    changePhase('joining');
    setStatus('正在向已登录设备发起配对请求…', false);
    try {
      const joined = await callTool<PairingJoinResult>(
        'network_device_pairing_join',
        {
          request_id: attempt.joinRequestId,
          challenge: attempt.challenge,
          device_id: attempt.deviceId,
          device_label: attempt.deviceLabel,
          platform: attempt.platform,
        },
        { token: attempt.token },
      );
      if (requestGeneration !== generation.current || !mounted.current) return;
      attempt.joined = true;
      targetIdentity.current = joined.actor;
      setConfirmCode(joined.pairing.confirm_code || '—');
      setTargetLabel(`${joined.actor.name || '未命名'}（${joined.actor.actor_id}）`);
      setCurrentLabel(
        currentIdentity.current
          ? `当前身份：${currentIdentity.current.name || '未命名'}`
          : '这台设备尚未登录',
      );
      setStatus('已发起配对。请让已登录设备核对设备名称与确认码后点击“确认新设备”。', false);
      changePhase('awaiting');
      scheduleRedeem(requestGeneration);
    } catch (failure) {
      if (requestGeneration !== generation.current || !mounted.current) return;
      changePhase('error');
      setStatus(`配对失败：${failureText(failure)} ${nextStepFor(failureReason(failure))}`, true);
    } finally {
      joiningRef.current = false;
    }
  }

  function handleScanned(rawValue: string): void {
    setScanOpen(false);
    const parsed = parsePairingQr(rawValue, window.location.origin);
    if (!parsed.ok) {
      changePhase('error');
      setStatus(`无法使用这个二维码：${parsed.message} 请重新扫描。`, true);
      return;
    }
    setChallenge(parsed.challenge);
    void startPairing(parsed.challenge);
  }

  async function switchIdentity() {
    const attempt = attemptRef.current;
    const target = targetIdentity.current;
    if (
      !credentialReady.current ||
      !attempt ||
      !target ||
      switchingRef.current
    ) {
      return;
    }
    switchingRef.current = true;
    setSwitchBusy(true);
    setStatus('正在核对目标身份并保存凭据…', false);
    try {
      const me = await callTool<PairingMe>('network_me', {}, { token: attempt.token });
      if (!mounted.current) return;
      if (me.actor_id !== target.actor_id) {
        setStatus('目标身份核对失败：当前凭据与配对目标不一致，请重新配对。', true);
        return;
      }
      targetIdentity.current = me;
      const saved = await persistIdentity(me, attempt);
      if (!mounted.current || !saved) return;
      enterHome();
    } catch (failure) {
      if (!mounted.current) return;
      setStatus(`切换失败：${failureText(failure)}`, true);
    } finally {
      switchingRef.current = false;
      if (mounted.current) setSwitchBusy(false);
    }
  }

  const startLabel = busy
    ? phase === 'redeeming'
      ? '正在兑换…'
      : '正在配对…'
    : phase === 'awaiting'
      ? '等待电脑确认…'
      : phase === 'ready'
        ? '已获得凭据'
        : phase === 'error' && confirmCode !== '—'
          ? '重试兑换'
          : '开始配对';

  return (
    <main data-pair-phase={phase}>
      <div className="share-head">
        <div className="share-avatar" aria-hidden="true">
          链
        </div>
        <h1 id="pair-title">配对设备</h1>
        <p className="muted" id="pair-current">
          {currentLabel}
        </p>
      </div>
      <p className="share-lead">
        扫描电脑上的二维码，或输入 12 位配对码，然后在已登录设备上确认。
      </p>
      <div className="pair-scan-actions">
        <Button
          className="primary"
          id="pair-scan"
          type="button"
          disabled={scanDisabled}
          onClick={() => setScanOpen(true)}
        >
          扫描电脑二维码
        </Button>
      </div>
      {scanOpen ? (
        <PairScanner
          onDecoded={handleScanned}
          onCancel={() => {
            setScanOpen(false);
          }}
        />
      ) : null}
      <div className="field">
        <Label htmlFor="pair-challenge">12 位配对码</Label>
        <Input
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
            if (switchVisible) void switchIdentity();
            else void startPairing();
          }}
        />
      </div>
      <p className="pair-hint" id="pair-hint">
        挑战 5 分钟内有效，用后即失效。相机权限被拒绝时仍可使用短码。
      </p>
      <div className="row share-actions">
        <Button
          className="primary"
          id="pair-start"
          type="button"
          disabled={startDisabled}
          onClick={() => {
            void startPairing();
          }}
        >
          {startLabel}
        </Button>
        <Button
          id="pair-switch"
          type="button"
          hidden={!switchVisible}
          disabled={switchBusy}
          onClick={() => {
            void switchIdentity();
          }}
        >
          {switchBusy ? '正在切换…' : '切换到此身份并进入'}
        </Button>
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
          新设备使用本地生成的独立 token；已登录设备必须核对设备名称、平台与确认码后批准。配对期间账号状态未变化时，原身份会保存在本机身份列表；账号已切换时仅在核对一致后保存。
        </p>
      </details>
    </main>
  );
}
