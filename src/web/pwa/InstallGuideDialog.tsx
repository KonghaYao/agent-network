import { Button } from '../app/lenso-controls';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Link, navigate } from '../app/router';
import { Modal } from '../features/overlays/Modal';
import {
  consumeInstallPrompt,
  getInstallPrompt,
  isAppInstalled,
  isIosDevice,
  isStandaloneDisplay,
  subscribeInstallPrompt,
} from './install';

interface InstallGuideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type MessageKind = '' | 'info' | 'error';

/**
 * 手机安装/连接引导。
 *
 * - Android Chrome 有 `beforeinstallprompt`：用户点击主按钮后才唤起系统确认；
 * - iOS Safari/Chrome：展示分享菜单 → 添加到主屏幕步骤；
 * - 其他浏览器：提示用系统浏览器打开，仍可显式连接已有账号；
 * - 独立窗口且无账号：主按钮直接打开 `/pair?scan=1` 启动扫码，
 *   下方保留“输入配对码”进入同一配对页。
 */
export function InstallGuideDialog({ open, onOpenChange }: InstallGuideDialogProps) {
  const prompt = useSyncExternalStore(
    subscribeInstallPrompt,
    getInstallPrompt,
    () => null,
  );
  const installed = useSyncExternalStore(
    subscribeInstallPrompt,
    isAppInstalled,
    () => false,
  );
  const [message, setMessage] = useState('');
  const [messageKind, setMessageKind] = useState<MessageKind>('');
  const [steps, setSteps] = useState<'ios' | 'other' | null>(null);
  const [busy, setBusy] = useState(false);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const standalone = isStandaloneDisplay();
  const ios = isIosDevice();

  useEffect(() => {
    if (!open) {
      setMessage('');
      setMessageKind('');
      setSteps(null);
      setBusy(false);
    }
  }, [open]);

  const primary = async () => {
    if (busy) return;
    if (standalone) {
      onOpenChange(false);
      navigate('/pair?scan=1');
      return;
    }
    if (installed) {
      setMessage('已安装。请打开主屏幕上的 WeBots，再扫描电脑上的二维码。');
      setMessageKind('info');
      return;
    }
    // iOS 不存在可靠的安装事件；无论浏览器 UA 如何都展示分享菜单步骤。
    if (ios) {
      setSteps('ios');
      setMessage('');
      setMessageKind('');
      return;
    }
    if (prompt) {
      setBusy(true);
      setMessage('');
      setSteps(null);
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        consumeInstallPrompt();
        if (choice.outcome === 'accepted') {
          setMessage('已提交安装。打开主屏幕上的 WeBots，再扫描电脑上的二维码。');
          setMessageKind('info');
        } else {
          setMessage('已取消系统安装。你仍可以稍后重试，或先连接已有账号。');
          setMessageKind('info');
        }
      } catch {
        setMessage('无法唤起系统安装，请用系统浏览器打开本页后重试。');
        setMessageKind('error');
      } finally {
        setBusy(false);
      }
      return;
    }
    setSteps(ios ? 'ios' : 'other');
    setMessage('');
    setMessageKind('');
  };

  const primaryLabel = standalone
    ? '扫描电脑二维码'
    : installed
      ? '已安装'
      : ios
        ? '查看安装步骤'
        : prompt
          ? '安装 WeBots'
          : '如何安装';

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="在手机上使用 WeBots"
      titleId="install-guide-title"
      contentId="install-guide"
      className="install-guide-card"
      closeId="install-guide-close"
      initialFocusRef={primaryRef}
    >
      <p id="install-guide-lead" className="install-guide-lead">
        {standalone
          ? '已从主屏幕打开。扫描电脑上的二维码，就能使用已有账号和会话。'
          : '安装后，扫描电脑上的二维码，就能使用已有账号和会话。'}
      </p>
      {steps === 'ios' ? (
        <ol id="install-guide-ios-steps" className="install-guide-steps">
          <li>点浏览器底部的“分享”按钮。</li>
          <li>选择“添加到主屏幕”。</li>
          <li>从主屏幕打开 WeBots，再扫描电脑上的二维码。</li>
        </ol>
      ) : null}
      {steps === 'other' ? (
        <p id="install-guide-other" className="install-guide-status" data-kind="info">
          当前浏览器没有直接安装入口。请用系统 Safari 或 Chrome 打开本页，
          再通过浏览器菜单“添加到主屏幕”。
        </p>
      ) : null}
      {message ? (
        <p
          id="install-guide-status"
          className="install-guide-status"
          data-kind={messageKind === 'error' ? 'error' : 'info'}
          role={messageKind === 'error' ? 'alert' : 'status'}
        >
          {message}
        </p>
      ) : null}
      <div className="install-guide-actions">
        <Button
          ref={primaryRef}
          id="install-guide-primary"
          className="primary"
          type="button"
          variant="prominent"
          disabled={busy || (installed && !standalone)}
          onClick={() => {
            void primary();
          }}
        >
          {busy ? '正在唤起…' : primaryLabel}
        </Button>
        <Button
          id="install-guide-later"
          className="install-guide-secondary"
          type="button"
          onClick={() => onOpenChange(false)}
        >
          稍后
        </Button>
      </div>
      {standalone ? (
        <Link
          id="install-guide-code"
          className="install-guide-link"
          to="/pair"
          onClick={() => onOpenChange(false)}
        >
          输入配对码
        </Link>
      ) : (
        <Link
          id="install-guide-pair"
          className="install-guide-link"
          to="/pair"
          onClick={() => onOpenChange(false)}
        >
          连接已有账号
        </Link>
      )}
    </Modal>
  );
}
