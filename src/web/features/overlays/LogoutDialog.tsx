import { Button } from '../../app/lenso-controls';
import * as AlertDialogPrimitive from './AlertDialog';

import { clearQueryCache } from '../../app/query';
import { cachedWebSession, resetWebSession } from '../../lib/identity';
import { clearActorDrafts } from '../../lib/drafts';
import { writeAuthSignal } from '../../pwa/recovery';

const TOKEN_KEY = 'agent-network-token';
const LOGGED_OUT_KEY = 'agent-network-logged-out';

/**
 * 退出登录：只改本机状态，不撤销服务端凭据。
 *
 * 与 legacy 一致：写入非敏感退出标记、移除浏览器 token、清理当前
 * sessionStorage 的页面缓存与本机未发送草稿，然后整页回到 `/`；不调用
 * 任何工具。草稿按 actor 精确清理，不影响同浏览器其他身份。
 */
export function LogoutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const logout = () => {
    // 退出后重新登录/切号都不应自动回填上一次未发送的正文。
    clearActorDrafts(cachedWebSession()?.identity.actor_id ?? null);
    // 同源其他标签页接收身份失效信号；本标签按原流程整页回首页。
    writeAuthSignal('logout');
    try {
      localStorage.setItem(LOGGED_OUT_KEY, '1');
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // 存储不可用时仍允许退出；下次打开可能重新自动注册。
    }
    try {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key && key.startsWith('agent-network-')) sessionStorage.removeItem(key);
      }
    } catch {
      // sessionStorage 不可用不影响退出。
    }
    resetWebSession();
    clearQueryCache();
    window.location.replace('/');
  };

  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="spa-dialog-overlay" />
        <AlertDialogPrimitive.Content
          id="logout-modal"
          className="modal-card spa-dialog-content confirm-card"
          aria-describedby="logout-message"
        >
          <AlertDialogPrimitive.Title asChild>
            <h2>退出登录</h2>
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description asChild>
            <p id="logout-message" className="confirm-message">
              退出只清除本机登录状态、页面会话数据与本机未发送草稿，当前 token 仍然有效且其他设备不受影响。
            </p>
          </AlertDialogPrimitive.Description>
          <div className="row modal-actions">
            <AlertDialogPrimitive.Cancel id="logout-cancel" className="spa-dialog-button">
              取消
            </AlertDialogPrimitive.Cancel>
            <Button id="logout-confirm" type="button" className="spa-dialog-button danger" onClick={logout}>
              退出登录
            </Button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
