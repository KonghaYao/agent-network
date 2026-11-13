import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { useState } from 'react';

import type { WebIdentity } from '../../lib/identity';
import { useWebSession } from '../../hooks/useWebSession';
import { LogoutDialog } from '../overlays/LogoutDialog';
import { MeRenameDialog } from '../overlays/MeRenameDialog';

/**
 * 侧栏账号菜单：改名与退出。
 *
 * 菜单本身不读写服务端；改名弹窗提交后才失效 session/rooms。退出只清
 * 本机状态，保留 `#account-name` 与头像的既有 DOM。
 */
export function AccountMenu({ me }: { me: WebIdentity | null }) {
  const session = useWebSession();
  const token = session.session?.token ?? null;
  const [renameOpen, setRenameOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);

  return (
    <>
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger asChild>
          <button
            id="account-menu-toggle"
            className="icon-btn account-more"
            type="button"
            aria-label="账号操作"
            title="账号操作"
            disabled={!me}
          >
            ···
          </button>
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            id="account-menu"
            className="room-menu"
            aria-label="账号操作"
            sideOffset={6}
            align="start"
          >
            <DropdownMenuPrimitive.Item
              id="account-rename"
              className="room-menu-item"
              disabled={!token}
              onSelect={() => setRenameOpen(true)}
            >
              修改我的名称
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Separator className="room-menu-sep" />
            <DropdownMenuPrimitive.Item
              id="account-logout"
              className="room-menu-item danger"
              onSelect={() => setLogoutOpen(true)}
            >
              退出登录
            </DropdownMenuPrimitive.Item>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
      {token && me ? (
        <MeRenameDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          currentName={me.name}
          token={token}
        />
      ) : null}
      <LogoutDialog open={logoutOpen} onOpenChange={setLogoutOpen} />
    </>
  );
}
