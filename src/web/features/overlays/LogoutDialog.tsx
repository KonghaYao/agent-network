import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';

import { clearQueryCache } from '../../app/query';
import { resetWebSession } from '../../lib/identity';

const TOKEN_KEY = 'agent-network-token';
const LOGGED_OUT_KEY = 'agent-network-logged-out';

/**
 * 退出登录：只改本机状态，不撤销服务端凭据。
 *
 * 与 legacy 一致：写入非敏感退出标记、移除浏览器 token、清理当前
 * sessionStorage 的页面缓存，然后整页回到 `/`；不调用任何工具。
 */
export function LogoutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const logout = () => {
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
              退出只清除本机登录状态，不会撤销服务端凭据。其他设备上的同一身份仍可继续使用。
            </p>
          </AlertDialogPrimitive.Description>
          <div className="row modal-actions">
            <AlertDialogPrimitive.Cancel id="logout-cancel" className="spa-dialog-button">
              取消
            </AlertDialogPrimitive.Cancel>
            <button id="logout-confirm" type="button" className="spa-dialog-button danger" onClick={logout}>
              退出登录
            </button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
