import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';

import { callTool, type McpError } from '../../lib/mcp-client';
import { copyText } from '../../lib/files';
import { drawQrCanvas } from '../../lib/qr-canvas';
import { newRequestId } from '../../lib/request-id';

interface PairingCreated {
  pairing_id: string;
  /** 明文挑战只在 create 首次响应出现；过期或被兑换后不可复用。 */
  challenge: string;
  pair_url: string;
  expires_at: string;
  created_at: string;
}

interface PairingView {
  pairing_id: string;
  device_label: string;
  platform: string;
  status: 'pending' | 'approved' | 'redeemed' | 'cancelled' | 'expired';
  confirm_code: string | null;
  created_at: string;
  expires_at: string;
  created_by_current_device: boolean;
}

interface PairingList {
  items: PairingView[];
  pending_count: number;
}

type StatusKind = '' | 'error' | 'success';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(value: string): string {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString();
  } catch {
    return date.toISOString();
  }
}

function challengeDisplay(challenge: string): string {
  const value = String(challenge || '');
  if (value.length !== 12) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}

/**
 * 已登录设备的“配对设备”弹窗。
 *
 * 打开即生成 5 分钟一次性 challenge；二维码只包含
 * `location.origin + '/pair#c=' + challenge`，不含登录 token。新设备扫码后
 * 在 `/pair` 读取并立即清除 fragment，等待这里核对设备名称、平台与确认码
 * 后显式批准。二维码与短码都不写 URL、localStorage 或日志。
 */
export function DeviceHandoffDialog({
  open,
  onOpenChange,
  token,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string | null;
}) {
  const [created, setCreated] = useState<PairingCreated | null>(null);
  const [creating, setCreating] = useState(false);
  const [retryVisible, setRetryVisible] = useState(false);
  const [status, setStatus] = useState('');
  const [statusKind, setStatusKind] = useState<StatusKind>('');
  const [pairings, setPairings] = useState<PairingView[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [busyPairing, setBusyPairing] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);

  const generation = useRef(0);
  const listSeq = useRef(0);
  const creatingRef = useRef(false);
  const pendingCreateRef = useRef(false);
  const createdRef = useRef<PairingCreated | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const setMessage = useCallback((message: string, kind: StatusKind = '') => {
    setStatus(message);
    setStatusKind(kind);
  }, []);

  const refreshList = useCallback(async () => {
    const seq = ++listSeq.current;
    if (!token) {
      setPairings([]);
      setListError('当前没有已登录身份；请先在已登录设备生成配对码。');
      return;
    }
    setListLoading(true);
    setListError('');
    try {
      const page = await callTool<PairingList>(
        'network_device_pairing_list',
        { limit: 50 },
        { token },
      );
      if (seq !== listSeq.current) return;
      // confirm_code 只在有新设备 join 后产生；空值只代表左侧配对码等待扫描。
      setPairings(
        page.items.filter(
          (entry) =>
            (entry.status === 'pending' || entry.status === 'approved') &&
            Boolean(entry.confirm_code),
        ),
      );
    } catch (error) {
      if (seq !== listSeq.current) return;
      setListError(`读取配对请求失败：${errorText(error)}；请稍后重试。`);
    } finally {
      if (seq === listSeq.current) setListLoading(false);
    }
  }, [token]);

  const createChallenge = useCallback(async () => {
    if (creatingRef.current) {
      // StrictMode 会重放打开副作用；排队一次，等上一轮结束后用新代数重建。
      pendingCreateRef.current = true;
      return;
    }
    creatingRef.current = true;
    const current = generation.current;
    setCreating(true);
    setRetryVisible(false);
    setQrFailed(false);
    setMessage('正在生成 5 分钟一次性配对挑战…');
    if (!token) {
      setMessage('当前没有已登录身份；请先在另一台设备登录并生成配对码。', 'error');
      setRetryVisible(true);
      setCreating(false);
      creatingRef.current = false;
      if (pendingCreateRef.current) pendingCreateRef.current = false;
      return;
    }
    try {
      const previous = createdRef.current;
      if (previous) {
        try {
          await callTool(
            'network_device_pairing_cancel',
            {
              request_id: newRequestId('pair_cancel'),
              pairing_id: previous.pairing_id,
              reason: 'regenerated_in_browser',
            },
            { token },
          );
        } catch (error) {
          if ((error as McpError).code !== 'PAIRING_INVALID') {
            setMessage('旧配对码撤销失败；请检查网络后重试。', 'error');
            setRetryVisible(true);
            return;
          }
          // 已兑换的挑战没有可撤销状态；继续生成新挑战。
        }
      }
      setCreated(null);
      createdRef.current = null;
      const result = await callTool<PairingCreated>(
        'network_device_pairing_create',
        {
          request_id: newRequestId('pair_create'),
          device_label: '当前设备',
          platform: String(navigator.platform || 'web').slice(0, 32),
        },
        { token },
      );
      // 先记住结果，后续重建时能撤销刚生成但已因关闭/重放而不可见的挑战。
      createdRef.current = result;
      if (current !== generation.current) return;
      setCreated(result);
      setMessage('用另一台设备扫描二维码或输入短码，然后核对设备名称与确认码后批准。', 'success');
      void refreshList();
    } catch (error) {
      if (current !== generation.current) return;
      setMessage(`生成失败：${errorText(error)}；请检查网络后重试。`, 'error');
      setRetryVisible(true);
    } finally {
      setCreating(false);
      creatingRef.current = false;
      if (pendingCreateRef.current) {
        pendingCreateRef.current = false;
        void createChallenge();
      }
    }
  }, [refreshList, setMessage, token]);

  useEffect(() => {
    if (!open) return undefined;
    const current = ++generation.current;
    setCreated(null);
    setMessage('');
    setListError('');
    setPairings([]);
    setRetryVisible(false);
    setQrFailed(false);
    void refreshList();
    void createChallenge();
    return () => {
      pendingCreateRef.current = false;
      if (generation.current === current) generation.current += 1;
    };
    // createChallenge 只在当前 token 下重建；打开期间不重复生成。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!created || !canvasRef.current) return;
    try {
      drawQrCanvas(canvasRef.current, created.pair_url);
      setQrFailed(false);
    } catch (error) {
      setQrFailed(true);
      setMessage(
        `二维码生成失败：${errorText(error)}；仍可复制配对链接或手动输入短码。`,
        'error',
      );
    }
  }, [created, setMessage]);

  const copyLink = async () => {
    if (!created) return;
    try {
      await copyText(created.pair_url);
      setMessage('配对链接已复制。请勿截图或分享配对码。', 'success');
    } catch (error) {
      setMessage(`复制失败：${errorText(error)}`, 'error');
    }
  };

  const decide = async (pairingId: string, action: 'approve' | 'cancel') => {
    if (!token || busyPairing) return;
    setBusyPairing(pairingId);
    setMessage(action === 'approve' ? '正在确认新设备…' : '正在拒绝配对请求…');
    try {
      if (action === 'approve') {
        await callTool(
          'network_device_pairing_approve',
          { request_id: newRequestId('pair_ok'), pairing_id: pairingId },
          { token },
        );
        setMessage(
          '已确认。请让新设备点击“兑换并切换”；它的 token 仍只保存在新设备本地。',
          'success',
        );
      } else {
        await callTool(
          'network_device_pairing_cancel',
          {
            request_id: newRequestId('pair_cancel'),
            pairing_id: pairingId,
            reason: 'rejected_in_browser',
          },
          { token },
        );
        setMessage('已拒绝。新设备需要重新扫描新的配对码。', 'success');
      }
      await refreshList();
    } catch (error) {
      setMessage(`操作失败：${errorText(error)}；请刷新配对列表后重试。`, 'error');
    } finally {
      setBusyPairing(null);
    }
  };

  const challenge = created ? challengeDisplay(created.challenge) : '';
  const emptyText = listLoading
    ? '正在读取待确认设备…'
    : listError || '暂无待确认设备；左侧配对码正在等待新设备扫描。';

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-dialog-overlay" />
        <DialogPrimitive.Content
          id="handoff-modal"
          className="modal-card spa-dialog-content handoff-card"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeRef.current?.focus();
          }}
        >
          <DialogPrimitive.Title asChild>
            <h2 id="handoff-title">配对设备</h2>
          </DialogPrimitive.Title>
          <p className="handoff-hint" id="handoff-hint">
            用另一台设备扫描或输入 12 位配对码；挑战 5 分钟内有效、用后即失效。
          </p>
          <div className="handoff-columns">
            <section className="handoff-col handoff-col-code" aria-label="配对码">
              <div className="handoff-qr-wrap" id="pairing-qr-wrap" hidden={!created}>
                <canvas
                  ref={canvasRef}
                  id="handoff-qr"
                  role="img"
                  aria-label="一次性设备配对挑战二维码"
                  hidden={qrFailed}
                />
                <p className="pairing-code" id="pairing-code">
                  {challenge}
                </p>
                <p className="handoff-expiry" id="pairing-expiry">
                  {created ? `有效至 ${formatDate(created.expires_at)}` : ''}
                </p>
              </div>
              <div className="handoff-actions handoff-code-actions">
                <button
                  className="primary"
                  id="pairing-create"
                  type="button"
                  disabled={creating}
                  onClick={() => void createChallenge()}
                >
                  {creating ? '正在生成…' : '重新生成'}
                </button>
                <button
                  id="handoff-copy"
                  type="button"
                  disabled={!created}
                  onClick={() => void copyLink()}
                >
                  复制链接
                </button>
              </div>
              <button
                className="handoff-retry"
                id="pairing-retry"
                type="button"
                hidden={!retryVisible}
                onClick={() => void createChallenge()}
              >
                重试
              </button>
            </section>
            <section className="handoff-col handoff-col-status" aria-label="设备确认">
              <p
                className="pairing-status"
                id="pairing-status"
                role="status"
                data-error={statusKind === 'error' ? '1' : undefined}
                data-success={statusKind === 'success' ? '1' : undefined}
              >
                {status}
              </p>
              <section className="pairing-section" aria-labelledby="pairing-list-title">
                <div className="pairing-section-head">
                  <h3 id="pairing-list-title">待确认的新设备</h3>
                  <button
                    className="pairing-refresh"
                    id="pairing-refresh"
                    type="button"
                    onClick={() => void refreshList()}
                  >
                    刷新
                  </button>
                </div>
                <p
                  className="pairing-empty"
                  id="pairing-list-empty"
                  hidden={pairings.length > 0 && !listLoading && !listError}
                >
                  {emptyText}
                </p>
                <ul className="pairing-list" id="pairing-list">
                  {pairings.map((entry) => (
                    <li
                      className="pairing-item"
                      key={entry.pairing_id}
                      data-pairing-id={entry.pairing_id}
                    >
                      <div className="pairing-item-main">
                        {(entry.device_label || '未命名设备') +
                          (entry.platform ? ` · ${entry.platform}` : '')}
                      </div>
                      <div className="pairing-item-meta">
                        {`确认码 ${entry.confirm_code || '—'} · ${formatDate(entry.created_at)}` +
                          (entry.created_by_current_device ? ' · 由当前设备创建' : '') +
                          ` · ${
                            entry.status === 'approved'
                              ? '已批准，等待新设备兑换'
                              : '等待确认'
                          }`}
                      </div>
                      <div className="pairing-item-code">
                        {entry.status === 'approved' ? '已批准' : '待确认'}
                      </div>
                      <div className="pairing-item-actions">
                        {entry.status === 'pending' && entry.confirm_code ? (
                          <button
                            type="button"
                            className="primary"
                            disabled={busyPairing !== null}
                            onClick={() => void decide(entry.pairing_id, 'approve')}
                          >
                            确认新设备
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="danger"
                          disabled={busyPairing !== null}
                          onClick={() => void decide(entry.pairing_id, 'cancel')}
                        >
                          {entry.status === 'approved' ? '撤销批准' : '拒绝'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
              <p className="handoff-warning">
                只在核对设备名称/平台/确认码后批准；请勿截图或分享配对码。
              </p>
            </section>
          </div>
          <div className="handoff-actions handoff-footer">
            <button
              ref={closeRef}
              id="handoff-close"
              type="button"
              onClick={() => onOpenChange(false)}
            >
              关闭
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
