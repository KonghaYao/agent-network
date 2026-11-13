import { lazy, Suspense, useState } from 'react';

import { useWebSession } from '../../hooks/useWebSession';
import { accountAvatarFor } from '../../lib/agent-avatar';
import type { WebIdentity } from '../../lib/identity';
import { avatarColor, firstChar } from '../../lib/rooms';
import { ArchiveAgentsDialog } from '../overlays/ArchiveAgentsDialog';
import { DeviceHandoffDialog } from '../overlays/DeviceHandoffDialog';
import { LogoutDialog } from '../overlays/LogoutDialog';
import { MeRenameDialog } from '../overlays/MeRenameDialog';
import { NewAgentDialog } from '../overlays/NewAgentDialog';
import { ARCHIVE_INNER, LOGOUT_INNER, PENCIL_INNER } from './account-icons';

const MemoryDialog = lazy(() =>
  import('../panels/MemoryDialog').then((module) => ({ default: module.MemoryDialog })),
);

function PencilIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 -3 31 31"
      width="14"
      height="14"
      fill="none"
      overflow="visible"
      className="kubai-icon kubai-icon-pencil"
      aria-hidden="true"
      focusable="false"
      data-kubai-icon="account-edit"
      dangerouslySetInnerHTML={{ __html: PENCIL_INNER }}
    />
  );
}

function ArchiveIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 -3 31 31"
      width="16"
      height="16"
      fill="none"
      overflow="visible"
      className="kubai-icon kubai-icon-archive"
      aria-hidden="true"
      focusable="false"
      data-kubai-icon="archived-agents"
      style={{ color: '#c47a00' }}
      dangerouslySetInnerHTML={{ __html: ARCHIVE_INNER }}
    />
  );
}

function LogoutIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 -3 31 31"
      width="16"
      height="16"
      fill="none"
      overflow="visible"
      className="kubai-icon kubai-icon-log-out"
      aria-hidden="true"
      focusable="false"
      data-kubai-icon="logout"
      style={{ color: '#e5484d' }}
      dangerouslySetInnerHTML={{ __html: LOGOUT_INNER }}
    />
  );
}

/**
 * 账号头像：首字 + 名称色，命中本地品牌规则时叠加图片。
 *
 * 与 legacy 一致，图片加载失败时回退首字，不显示破图。
 */
function AccountAvatar({ me }: { me: WebIdentity | null }) {
  const [failedName, setFailedName] = useState<string | null>(null);
  const spec = me ? accountAvatarFor(me.name, me.kind) : null;
  const showImage = spec !== null && failedName !== me?.name;
  const className = [
    'account-avatar',
    showImage ? 'avatar-icon' : '',
    showImage && spec.mono ? 'avatar-mono' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={className}
      id="account-avatar"
      aria-hidden="true"
      data-brand={showImage ? spec.brand : undefined}
      style={me && !showImage ? { background: avatarColor(me.name) } : undefined}
    >
      {me ? firstChar(me.name) : '?'}
      {showImage ? (
        <img
          className="avatar-img"
          src={spec.src}
          alt=""
          decoding="async"
          onError={() => setFailedName(me?.name ?? null)}
        />
      ) : null}
    </span>
  );
}

/**
 * 侧栏左下角账号区（legacy 外观）。
 *
 * 结构固定为「首字头像 + 名称行（改名铅笔）+ 横向操作行」：新建 Agent、
 * 配对设备、记忆三个文字入口，以及已归档与退出两个图标入口。登录后才
 * 显示名称编辑与操作行；移动端列表页沿用同一套 CSS 自动换行。
 *
 * 移动端聊天头部仍使用 `AccountMenu`；两个入口不会在同一页面出现。
 * 凭据只从 session 读取，不写入 DOM 或日志。
 */
export function SidebarAccount({ me }: { me: WebIdentity | null }) {
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
    triggerId: string,
  ): ((open: boolean) => void) => {
    return (open) => {
      setter(open);
      if (open) return;
      requestAnimationFrame(() => {
        document.getElementById(triggerId)?.focus();
      });
    };
  };

  return (
    <>
      <div className="account" id="account">
        <AccountAvatar me={me} />
        <div className="account-main">
          <div className="account-name-row">
            <span className="account-name" id="account-name">
              {me ? me.name : '未登录'}
            </span>
            {me ? (
              <button
                className="account-edit"
                id="account-rename"
                type="button"
                aria-label="编辑姓名"
                title="编辑姓名"
                aria-haspopup="dialog"
                aria-controls="me-rename-dialog"
                aria-expanded={renameOpen}
                onClick={() => setRenameOpen(true)}
              >
                <PencilIcon />
              </button>
            ) : null}
          </div>
          {me ? (
            <div className="account-actions">
              <button
                className="account-scan"
                id="new-agent"
                type="button"
                disabled={me.kind !== 'human'}
                aria-haspopup="dialog"
                aria-controls="new-agent-modal"
                aria-expanded={newAgentOpen}
                onClick={() => setNewAgentOpen(true)}
              >
                新建 Agent
              </button>
              <button
                className="account-scan"
                id="device-handoff"
                type="button"
                aria-haspopup="dialog"
                aria-controls="handoff-modal"
                aria-expanded={handoffOpen}
                onClick={() => setHandoffOpen(true)}
              >
                配对设备
              </button>
              <button
                className="account-scan"
                id="memory-open"
                type="button"
                aria-haspopup="dialog"
                aria-controls="memory-drawer"
                aria-expanded={memoryOpen}
                onClick={() => setMemoryOpen(true)}
              >
                记忆
              </button>
              <button
                className="account-icon"
                id="archived-agents"
                type="button"
                aria-label="已归档 Agents"
                title="已归档 Agents"
                disabled={me.kind !== 'human'}
                aria-haspopup="dialog"
                aria-controls="archive-popover"
                aria-expanded={archiveOpen}
                onClick={() => setArchiveOpen(true)}
              >
                <ArchiveIcon />
              </button>
              <button
                className="account-icon"
                id="logout"
                type="button"
                aria-label="退出登录"
                title="退出登录"
                aria-haspopup="dialog"
                aria-controls="logout-modal"
                aria-expanded={logoutOpen}
                onClick={() => setLogoutOpen(true)}
              >
                <LogoutIcon />
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {token && me ? (
        <MeRenameDialog
          open={renameOpen}
          onOpenChange={closeAndReturnFocus(setRenameOpen, 'account-rename')}
          currentName={me.name}
          token={token}
        />
      ) : null}
      <NewAgentDialog
        open={newAgentOpen}
        onOpenChange={closeAndReturnFocus(setNewAgentOpen, 'new-agent')}
        identity={me}
        token={token}
      />
      <DeviceHandoffDialog
        open={handoffOpen}
        onOpenChange={closeAndReturnFocus(setHandoffOpen, 'device-handoff')}
        token={token}
      />
      <ArchiveAgentsDialog
        open={archiveOpen}
        onOpenChange={closeAndReturnFocus(setArchiveOpen, 'archived-agents')}
      />
      {memoryOpen ? (
        <Suspense fallback={null}>
          <MemoryDialog
            open={memoryOpen}
            onOpenChange={closeAndReturnFocus(setMemoryOpen, 'memory-open')}
          />
        </Suspense>
      ) : null}
      <LogoutDialog
        open={logoutOpen}
        onOpenChange={closeAndReturnFocus(setLogoutOpen, 'logout')}
      />
    </>
  );
}
