import { Button, Menu, type MenuEntry } from '../../app/lenso-controls';
import { lazy, Suspense, useRef, useState } from 'react';

import type { WebIdentity } from '../../lib/identity';
import { useWebSession } from '../../hooks/useWebSession';
import { openAgentMemory } from '../memory/memory-store';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // 菜单项会随关闭动画卸载；打开时记下当时的稳定入口，供 dialog 归还焦点。
  const toggleFocusRef = useRef<HTMLElement | null>(null);

  const closeAndReturnFocus = (
    setter: (open: boolean) => void,
  ): ((open: boolean) => void) => {
    return (open) => {
      setter(open);
      if (open) return;
      // 入口在菜单中，菜单关闭后会卸载；把焦点还给稳定的触发按钮。
      // 先抢在 Radix 的延时还焦点之前恢复，再补一帧兜底。
      const focusToggle = () => {
        document.getElementById('account-menu-toggle')?.focus();
      };
      queueMicrotask(focusToggle);
      requestAnimationFrame(focusToggle);
    };
  };

  const handleMenuOpenChange = (open: boolean, details?: { reason?: string }) => {
    setMenuOpen(open);
    // Lenso 就绪前后触发按钮可能被替换，打开时重新解析当前 DOM 节点。
    if (open) toggleFocusRef.current = document.getElementById('account-menu-toggle');
    if (open || details?.reason === 'item-press') return;
    // 外部点击/关闭按钮不保证由 SDK 还焦点；选中条目交给随后打开的对话框。
    requestAnimationFrame(() => {
      document.getElementById('account-menu-toggle')?.focus();
    });
  };

  const items: MenuEntry[] = [
    {
      id: 'account-rename',
      label: '修改我的名称',
      disabled: !token,
      onSelect: () => setRenameOpen(true),
    },
    {
      id: 'new-agent',
      label: '新建 Agent',
      disabled: !token || me?.kind !== 'human',
      onSelect: () => setNewAgentOpen(true),
    },
    {
      id: 'device-handoff',
      label: '配对设备',
      disabled: !token,
      onSelect: () => setHandoffOpen(true),
    },
    {
      id: 'archived-agents',
      label: '已归档 Agents',
      disabled: !token || me?.kind !== 'human',
      onSelect: () => setArchiveOpen(true),
    },
    {
      id: 'memory-open',
      label: '记忆',
      disabled: !token,
      onSelect: () => setMemoryOpen(true),
    },
  ];
  if (me?.kind === 'agent') {
    items.push({
      id: 'account-memory-self',
      label: '查看我的记忆',
      disabled: !token,
      onSelect: () =>
        openAgentMemory(
          { actor_id: me.actor_id, name: me.name },
          { returnFocus: () => document.getElementById('account-menu-toggle') },
        ),
    });
  }
  items.push(
    { id: 'account-menu-sep', separator: true },
    {
      id: 'account-logout',
      label: '退出登录',
      className: 'room-menu-item danger',
      variant: 'danger',
      onSelect: () => setLogoutOpen(true),
    },
  );

  return (
    <>
      <Menu
        id="account-menu"
        label="账号操作"
        className="room-menu account-menu"
        itemClassName="room-menu-item"
        open={menuOpen}
        onOpenChange={handleMenuOpenChange}
        fallbackAnchor
        instantCloseOnSelect
        sideOffset={6}
        align="start"
        trigger={
          <Button
            id="account-menu-toggle"
            className="icon-btn account-more"
            type="button"
            aria-label="账号操作"
            title="账号操作"
            disabled={!me}
          >
            ···
          </Button>
        }
        items={items}
      />
      {token && me ? (
        <MeRenameDialog
          open={renameOpen}
          onOpenChange={closeAndReturnFocus(setRenameOpen)}
          currentName={me.name}
          token={token}
          returnFocusRef={toggleFocusRef}
        />
      ) : null}
      <NewAgentDialog
        open={newAgentOpen}
        onOpenChange={closeAndReturnFocus(setNewAgentOpen)}
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
          <MemoryDialog
            open={memoryOpen}
            onOpenChange={closeAndReturnFocus(setMemoryOpen)}
          />
        </Suspense>
      ) : null}
      <LogoutDialog open={logoutOpen} onOpenChange={closeAndReturnFocus(setLogoutOpen)} />
    </>
  );
}
