import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { lazy, Suspense, useState } from 'react';

import type { WebIdentity } from '../../lib/identity';
import { useWebSession } from '../../hooks/useWebSession';
import { ArchiveAgentsDialog } from '../overlays/ArchiveAgentsDialog';
import { DeviceHandoffDialog } from '../overlays/DeviceHandoffDialog';
import { LogoutDialog } from '../overlays/LogoutDialog';
import { MeRenameDialog } from '../overlays/MeRenameDialog';
import { NewAgentDialog } from '../overlays/NewAgentDialog';

const MemoryDialog = lazy(() =>
  import('../panels/MemoryDialog').then((module) => ({ default: module.MemoryDialog })),
);

/**
 * 侧栏/聊天头部账号菜单：改名、新建 Agent、记忆与退出。
 *
 * 菜单本身不读写服务端；记忆抽屉按需加载，避免把 Memory 工具代码带进
 * 首屏。退出只清本机状态，保留 `#account-name` 与头像的既有 DOM。
 */
export function AccountMenu({ me }: { me: WebIdentity | null }) {
  const session = useWebSession();
  const token = session.session?.token ?? null;
  const [renameOpen, setRenameOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const closeAndReturnFocus = (
    setter: (open: boolean) => void,
  ): ((open: boolean) => void) => {
    return (open) => {
      setter(open);
      if (open) return;
      // 入口在 DropdownMenu 中，菜单关闭后会卸载；把焦点还给稳定的触发按钮。
      requestAnimationFrame(() => {
        document.getElementById('account-menu-toggle')?.focus();
      });
    };
  };

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
            className="room-menu spa-menu"
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
            <DropdownMenuPrimitive.Item
              id="new-agent"
              className="room-menu-item"
              disabled={!token || me?.kind !== 'human'}
              onSelect={() => setNewAgentOpen(true)}
            >
              新建 Agent
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item
              id="device-handoff"
              className="room-menu-item"
              disabled={!token}
              onSelect={() => setHandoffOpen(true)}
            >
              配对设备
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item
              id="archived-agents"
              className="room-menu-item"
              disabled={!token || me?.kind !== 'human'}
              onSelect={() => setArchiveOpen(true)}
            >
              已归档 Agents
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item
              id="memory-open"
              className="room-menu-item"
              disabled={!token}
              onSelect={() => setMemoryOpen(true)}
            >
              记忆
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
      <NewAgentDialog
        open={newAgentOpen}
        onOpenChange={setNewAgentOpen}
        identity={me}
        token={token}
      />
      <DeviceHandoffDialog
        open={handoffOpen}
        onOpenChange={closeAndReturnFocus(setHandoffOpen)}
        token={token}
      />
      <ArchiveAgentsDialog
        open={archiveOpen}
        onOpenChange={closeAndReturnFocus(setArchiveOpen)}
      />
      {memoryOpen ? (
        <Suspense fallback={null}>
          <MemoryDialog open={memoryOpen} onOpenChange={setMemoryOpen} />
        </Suspense>
      ) : null}
      <LogoutDialog open={logoutOpen} onOpenChange={setLogoutOpen} />
    </>
  );
}
