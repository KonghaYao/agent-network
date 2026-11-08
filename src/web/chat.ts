import {
  announcementDialog,
  chatPane,
  contactRequestsDialog,
  emptyPane,
  filePreviewDialog,
  filesBackdrop,
  filesPane,
  groupDialog,
  membersDialog,
  monitorBackdrop,
  monitorPane,
  newAgentDialog,
  paneResizer,
  reportDialog,
  sidebarPane,
  taskDialogs,
  toastPane,
  transferDialog,
} from './chat-panels';
import { chatClientScript } from './chat-script';
import { DRAWBOARD_FALLBACK_STYLE } from './chat-drawboard-styles';
import { FILES_STYLE } from './chat-files-styles';
import { MONITOR_STYLE } from './chat-monitor-styles';
import { MARKDOWN_STYLE } from './chat-markdown-styles';
import { MESSAGE_FILES_STYLE } from './chat-message-files-styles';
import { APP_STYLE } from './chat-styles';
import { UPLOAD_STYLE } from './chat-upload-styles';
import {
  DEVICE_HANDOFF_STYLE,
  deviceHandoffDialog,
  logoutDialog,
  meRenameDialog,
} from './handoff';
import { layout } from './layout';

/**
 * 微信式双栏应用页：左侧会话列表，右侧聊天区（或空状态）。
 *
 * 壳同时渲染 `emptyPane()` 与 `chatPane()`，由 `<body>` 的
 * `page-home` / `page-room` 控制可见性。这样从首页导航到聊天时不需要
 * 重新请求文档，也不需要重新绑定监听器；服务端仍只输出空壳，
 * 不校验成员资格、不输出房间数据。
 *
 * 移动端（`< 760px`）沿用同一套 body class 切为单栏：
 * 首页只显示列表，聊天页只显示聊天区与返回箭头。
 */
export function renderAppPage(
  roomId: string | null,
  markdownVersion: string | null = null,
  resizerVersion: string | null = null,
  drawboardVersion: string | null = null,
): string {
  const isHome = roomId === null;
  return layout(
    isHome ? 'WeBots' : '聊天 · WeBots',
    `${sidebarPane()}
${emptyPane()}
${chatPane()}
${paneResizer()}
${filesBackdrop()}
${filesPane()}
${monitorBackdrop()}
${monitorPane()}
${filePreviewDialog()}
${contactRequestsDialog()}
${reportDialog()}
${groupDialog()}
${taskDialogs()}
${membersDialog()}
${announcementDialog()}
${newAgentDialog()}
${transferDialog()}
${deviceHandoffDialog()}
${logoutDialog()}
${meRenameDialog()}
${toastPane()}
${chatClientScript(roomId, markdownVersion, resizerVersion, drawboardVersion)}`,
    APP_STYLE + FILES_STYLE + UPLOAD_STYLE + MONITOR_STYLE + MESSAGE_FILES_STYLE + MARKDOWN_STYLE + DEVICE_HANDOFF_STYLE + DRAWBOARD_FALLBACK_STYLE,
    { wide: true, bodyClass: isHome ? 'page-home' : 'page-room' },
  );
}

export function renderChatPage(
  roomId: string,
  markdownVersion: string | null = null,
  resizerVersion: string | null = null,
  drawboardVersion: string | null = null,
): string {
  return renderAppPage(roomId, markdownVersion, resizerVersion, drawboardVersion);
}
