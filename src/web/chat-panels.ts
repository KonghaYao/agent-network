import { LIMITS } from '../contracts/limits';
import { deviceHandoffAccount } from './handoff';

/**
 * 微信式应用页的静态标记。
 *
 * 保留既有 DOM id/class（`room-list`、`composer`、`title`、`subtitle`、`status`），
 * 供协议测试、验收脚本与浏览器 E2E 复用；新增搜索框与消息头像不改变工具契约。
 */

/** 左侧栏：品牌、搜索、会话列表、用户区块。桌面与移动端列表页共用。 */
export function sidebarPane(): string {
  return `<aside class="sidebar" aria-label="会话列表">
  <header class="sidebar-head">
    <div class="brand-row">
      <h1>WeBots</h1>
      <button class="icon-btn" id="contact-requests" type="button" aria-label="好友申请" title="好友申请">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="9" cy="8" r="3.2"></circle>
          <path d="M3.6 19.2c0-3.1 2.4-5.2 5.4-5.2s5.4 2.1 5.4 5.2"></path>
          <path d="M15.6 5.6a3.2 3.2 0 0 1 0 5.8"></path>
          <path d="M17.8 14.5c1.6.7 2.6 2.3 2.6 4.7"></path>
        </svg>
        <span class="request-badge" id="contact-requests-badge" hidden>0</span>
      </button>
      <button class="icon-btn" id="my-tasks" type="button" aria-label="我的任务" title="我的任务">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="5" y="4.5" width="14" height="16" rx="2.5"></rect>
          <path d="M9.5 4.5V3.3c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7v1.2"></path>
          <path d="M8.6 11.2l1.1 1.1 2-2.2"></path>
          <path d="M14 11.4h2.2"></path>
          <path d="M8.6 15.6l1.1 1.1 2-2.2"></path>
          <path d="M14 15.8h2.2"></path>
        </svg>
      </button>
      <button class="icon-btn" id="new-group" type="button" aria-label="新建群聊" title="新建群聊">+</button>
    </div>
    <label class="search-box">
      <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="11" cy="11" r="6.5"></circle>
        <path d="M16 16l4 4"></path>
      </svg>
      <input id="room-search" type="search" placeholder="搜索" autocomplete="off" aria-label="搜索会话">
    </label>
    <div class="room-filter" id="room-filter" role="tablist" aria-label="会话类型">
      <button id="room-filter-friend" type="button" role="tab" data-room-filter="friend"
        aria-selected="true" aria-controls="room-list" tabindex="0">好友</button>
      <button id="room-filter-agent" type="button" role="tab" data-room-filter="agent"
        aria-selected="false" aria-controls="room-list" tabindex="-1">Agent</button>
      <button id="room-filter-group" type="button" role="tab" data-room-filter="group"
        aria-selected="false" aria-controls="room-list" tabindex="-1">群聊</button>
    </div>
  </header>
  <div class="sidebar-list">
    <p id="contact-link-banner" class="contact-link-banner" role="status" hidden></p>
    <ol id="room-list" class="room-list" aria-label="好友">
      <li class="room-skeleton" aria-hidden="true">
        <span class="skeleton-avatar"></span>
        <span class="skeleton-lines"><span></span><span></span></span>
      </li>
      <li class="room-skeleton" aria-hidden="true">
        <span class="skeleton-avatar"></span>
        <span class="skeleton-lines"><span></span><span></span></span>
      </li>
      <li class="room-skeleton" aria-hidden="true">
        <span class="skeleton-avatar"></span>
        <span class="skeleton-lines"><span></span><span></span></span>
      </li>
      <li class="room-skeleton" aria-hidden="true">
        <span class="skeleton-avatar"></span>
        <span class="skeleton-lines"><span></span><span></span></span>
      </li>
      <li class="room-skeleton" aria-hidden="true">
        <span class="skeleton-avatar"></span>
        <span class="skeleton-lines"><span></span><span></span></span>
      </li>
    </ol>
    <p id="room-list-status" class="list-hint" role="status">正在读取…</p>
    <button id="room-list-more" class="list-retry" type="button" hidden>加载更多会话</button>
    <button id="room-list-retry" class="list-retry" type="button" hidden>重试</button>
    <button id="logged-out-start" class="list-retry" type="button" hidden>创建新身份并继续</button>
    <button id="credential-invalid-pair" class="list-retry" type="button" hidden>用另一台设备配对</button>
    <div id="logged-out-identities" class="local-identities" hidden></div>
  </div>
  <footer class="sidebar-foot">
    <span id="stream-dot" class="stream-dot" role="status" title="" aria-label="" hidden></span>
    ${deviceHandoffAccount()}
  </footer>
  <div class="room-menu" id="room-menu" role="menu" aria-label="会话操作" hidden>
    <button class="room-menu-item" id="room-menu-copy-prompt" type="button"
      role="menuitem">复制 Agent 连接提示词</button>
    <button class="room-menu-item" id="room-menu-transfer" type="button"
      role="menuitem" hidden>交接管理权</button>
    <button class="room-menu-item" id="room-menu-archive" type="button"
      role="menuitem" hidden>归档</button>
    <button class="room-menu-item danger" id="room-menu-toggle-disabled" type="button"
      role="menuitem" hidden>停用 Agent</button>
    <button class="room-menu-item danger" id="room-menu-reissue-token" type="button"
      role="menuitem" hidden>注销并重发 token</button>
    <div class="room-menu-sep" id="room-menu-safety-sep" role="separator"></div>
    <button class="room-menu-item" id="room-menu-report" type="button"
      role="menuitem" hidden>举报</button>
    <button class="room-menu-item" id="room-menu-block" type="button"
      role="menuitem" hidden>拉黑</button>
    <button class="room-menu-item danger" id="room-menu-delete-friend" type="button"
      role="menuitem" hidden>删除好友</button>
    <button class="room-menu-item danger" id="room-menu-leave-group" type="button"
      role="menuitem" hidden>退出群聊</button>
    <button class="room-menu-item danger" id="room-menu-dissolve" type="button"
      role="menuitem" hidden>解散群聊</button>
    <p class="room-menu-status" id="room-menu-safety-hint" hidden>
      删除好友保留历史；拉黑拒绝新私聊/申请/邀请；退群不影响好友。
    </p>
    <div class="room-menu-stopped" id="room-menu-stopped" hidden>
      <p class="room-menu-stopped-summary" id="room-menu-stopped-summary" role="status"></p>
      <details class="room-menu-stopped-details" id="room-menu-stopped-details">
        <summary id="room-menu-stopped-toggle">未完成任务</summary>
        <ul class="room-menu-stopped-tasks" id="room-menu-stopped-tasks"></ul>
      </details>
      <p class="room-menu-stopped-empty" id="room-menu-stopped-empty" hidden>没有未完成任务</p>
    </div>
    <p class="room-menu-status" id="room-menu-status" role="status" aria-live="polite" hidden></p>
  </div>
  <div class="archive-popover" id="archive-popover" role="dialog"
    aria-label="已归档 Agents" hidden>
    <header class="archive-popover-head">
      <h2>已归档 Agents</h2>
      <button class="archive-popover-close" id="archive-popover-close" type="button"
        aria-label="关闭已归档 Agents" title="关闭">×</button>
    </header>
    <p class="archive-popover-status" id="archive-popover-status"
      role="status" aria-live="polite" hidden></p>
    <ul class="archive-popover-list" id="archive-popover-list" aria-label="已归档 Agent"></ul>
    <p class="archive-popover-empty" id="archive-popover-empty"
      role="status" hidden>暂无已归档 Agent</p>
  </div>
</aside>`;
}

/** 轻量 toast：归档/恢复反馈，不阻塞操作，也不承担错误详情。 */
export function toastPane(): string {
  return `<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>`;
}

/** 聊天区：56px 头部、可滚动消息、固定输入区。 */
export function chatPane(): string {
  return `<section class="chat-pane" aria-label="聊天区">
  <header class="chat-head">
    <a class="back" id="back" href="/" aria-label="返回会话列表">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M15 5l-7 7 7 7"></path>
      </svg>
    </a>
    <div class="chat-id">
      <div class="title-row">
        <h2 id="title">单聊</h2>
        <button class="link-btn" id="rename" type="button" hidden>改名</button>
        <button class="link-btn" id="add-members" type="button" hidden>群设置</button>
        <button class="link-btn" id="room-announcement-edit" type="button" hidden>公告</button>
      </div>
      <p class="muted" id="subtitle">正在加载…</p>
    </div>
    <button class="copy-group-info" id="copy-group-info" type="button" hidden
      aria-label="复制群信息" title="复制群信息">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="8" y="8" width="11" height="11" rx="2"></rect>
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
      </svg>
    </button>
    <button class="task-toggle" id="task-toggle" type="button" hidden
      aria-haspopup="dialog" aria-controls="task-popover" aria-expanded="false"
      title="查看房间任务">
      <span id="task-toggle-label">任务 0/0</span>
    </button>
    <button class="link-btn" id="task-create" type="button" hidden
      title="从消息或任务面板创建任务">新建任务</button>
    <button class="monitor-toggle" id="monitor-toggle" type="button"
      aria-controls="monitor-pane" aria-expanded="false"
      aria-label="打开网页监控" title="网页监控">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3" y="4" width="18" height="16" rx="2"></rect>
        <path d="M3 9h18M7 6.5h.01M10 6.5h.01"></path>
      </svg>
      <span>网页</span>
    </button>
    <button class="files-toggle" id="files-toggle" type="button"
      aria-controls="files-pane" aria-expanded="false">文件</button>
    <div class="task-popover" id="task-popover" role="dialog" aria-label="房间任务" hidden>
      <header class="task-popover-head">
        <h3>房间任务</h3>
        <button class="task-popover-close" id="task-popover-close" type="button"
          aria-label="关闭任务列表" title="关闭">×</button>
      </header>
      <ul class="task-list" id="task-list" aria-label="房间任务列表"></ul>
      <p class="task-popover-empty" id="task-popover-empty" role="status" hidden>暂无任务</p>
    </div>
  </header>
  <form id="rename-form" class="rename-form" hidden>
    <input id="rename-input" maxlength="${LIMITS.actorNameMax}" aria-label="Agent 新名称"
      placeholder="新的 Agent 名称">
    <button class="primary" type="submit">保存</button>
    <button type="button" id="rename-cancel">取消</button>
  </form>
  <div id="room-announcement" class="room-announcement" role="note" hidden></div>
  <div id="room-archive-banner" class="room-archive-banner" role="note" hidden></div>
  <div class="chat-body" id="chat-body" aria-busy="false">
    <div id="chat-loading" class="chat-loading" role="status" hidden>正在加载会话…</div>
    <div id="chat-skeleton" class="chat-skeleton" aria-hidden="true" hidden>
      <div class="skeleton-row"><span class="skeleton-avatar"></span><span class="skeleton-bubble"></span></div>
      <div class="skeleton-row mine"><span class="skeleton-avatar"></span><span class="skeleton-bubble"></span></div>
      <div class="skeleton-row"><span class="skeleton-avatar"></span><span class="skeleton-bubble"></span></div>
    </div>
    <div id="chat-error" class="chat-error" role="alert" hidden>
      <p id="chat-error-text"></p>
      <div class="chat-error-actions">
        <button id="chat-error-retry" type="button">重试</button>
        <a id="chat-error-back" href="/">返回会话列表</a>
      </div>
    </div>
    <ol id="messages" class="messages" aria-live="polite">
      <li id="history-pager" class="history-pager" hidden>
        <button id="older" type="button">加载更早</button>
        <span id="older-status" class="history-status" role="status" aria-live="polite" hidden></span>
      </li>
      <li id="messages-end" class="messages-end" aria-hidden="true"></li>
    </ol>
    <button id="jump-latest" class="jump-latest" type="button" hidden>
      <span id="jump-latest-label">回到最新</span>
    </button>
    <p id="status" role="status"></p>
    <div id="mention-picker" class="mention-picker" hidden role="listbox" aria-label="选择要 @ 的成员"></div>
    <form id="composer" class="composer">
      <button class="attach-btn" id="attach-file" type="button" aria-label="添加附件"
        aria-haspopup="menu" aria-controls="attach-menu" aria-expanded="false"
        title="添加附件">+</button>
      <div class="attach-menu" id="attach-menu" role="menu" aria-label="添加附件" hidden>
        <button class="attach-menu-item" id="attach-menu-file" type="button"
          role="menuitem">上传文件</button>
        <button class="attach-menu-item" id="attach-menu-draw" type="button"
          role="menuitem">画板</button>
      </div>
      <input id="composer-file-input" type="file" multiple hidden>
      <div class="composer-main">
        <div id="composer-files" class="composer-files" role="list" aria-label="待发送文件" hidden></div>
        <textarea id="body" rows="1" maxlength="262144" placeholder="输入消息…" aria-label="消息正文"></textarea>
      </div>
      <button class="send-btn primary" id="send" type="submit">发送</button>
    </form>
    <div id="composer-drop" class="composer-drop" hidden aria-hidden="true">
      <span class="composer-drop-title">松开即可上传文件</span>
      <span class="composer-drop-hint">文件会加入当前会话并在发送时附带公开链接</span>
    </div>
  </div>
</section>`;
}

/** 桌面右侧空状态：只保留选择提示，不重复页面说明。 */
export function emptyPane(): string {
  return `<section class="chat-pane empty-pane" aria-label="聊天区">
  <div class="empty" id="empty-state">
    <div class="empty-art" aria-hidden="true">
      <span class="empty-bubble left"></span>
      <span class="empty-bubble right"></span>
    </div>
    <p class="empty-title" id="empty-title">选择一个会话开始聊天</p>
    <p class="empty-hint" id="empty-hint">从左侧选择单聊或群聊，也可以新建群聊。</p>
  </div>
</section>`;
}

/** 新建群聊弹窗：保留 group-* 契约，视觉由 APP_STYLE 统一。 */
export function groupDialog(): string {
  return `<div class="modal" id="group-modal" hidden>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="group-modal-title">
    <h2 id="group-modal-title">新建群聊</h2>
    <form id="group-form">
      <label class="field">群名（可选）
        <input id="group-title" maxlength="${LIMITS.roomTitleMax}" placeholder="留空显示为“群聊”">
      </label>
      <p class="muted picker-label">选择好友成员</p>
      <div class="member-picker-toolbar">
        <input id="group-search" class="member-picker-search" type="search"
          placeholder="搜索好友名称" aria-label="搜索好友名称" autocomplete="off">
        <span id="group-contacts-count" class="members-count" aria-live="polite">0</span>
      </div>
      <div id="group-contacts" class="contact-list" role="group"
        aria-label="好友候选"></div>
      <button id="group-more" class="member-picker-more" type="button" hidden>加载更多</button>
      <p id="group-error" class="form-error" role="status"></p>
      <div class="row modal-actions">
        <span id="group-selection" class="members-selection" role="status"
          aria-live="polite">未选择</span>
        <button id="group-cancel" type="button">取消</button>
        <button class="primary" id="group-create" type="submit">创建</button>
      </div>
    </form>
  </div>
</div>`;
}

/**
 * 群组设置：群名、成员操作、邀请与生命周期入口。
 *
 * 按服务端 capabilities 展示操作；好友候选排除自己、当前成员与待确认邀请。
 */
export function membersDialog(): string {
  return `<div class="modal" id="members-modal" hidden>
  <div class="modal-card members-card" role="dialog" aria-modal="true"
    aria-labelledby="members-modal-title">
    <header class="members-head">
      <h2 id="members-modal-title">群组设置</h2>
      <button class="members-close" id="members-close" type="button"
        aria-label="关闭群组设置" title="关闭">×</button>
    </header>
    <section class="group-profile" aria-label="群资料">
      <label for="group-name-input">群名称</label>
      <div class="row">
        <input id="group-name-input" maxlength="${LIMITS.roomTitleMax}" autocomplete="off">
        <button id="group-name-save" type="button">保存群名</button>
      </div>
      <p id="group-profile-status" role="status" aria-live="polite"></p>
    </section>
    <form id="members-form">
      <div class="members-scroll">
      <div class="members-columns">
        <section class="members-column" aria-labelledby="members-current-title">
          <header class="members-column-head">
            <h3 id="members-current-title">已在群</h3>
            <span id="members-current-count" class="members-count" aria-live="polite">0</span>
          </header>
          <input id="members-current-search" class="member-picker-search" type="search"
            placeholder="搜索群成员" aria-label="搜索群成员" autocomplete="off">
          <ul id="members-current" class="member-roster" aria-label="当前群成员"></ul>
          <p id="members-current-empty" class="members-empty" role="status" hidden>群里还没有成员</p>
          <div id="members-transfer" class="members-transfer" aria-live="polite" hidden></div>
          <div id="members-invited-wrap" class="members-invited" hidden>
            <p class="members-invited-title">邀请中
              <span id="members-invited-count" class="members-count" aria-live="polite">0</span>
            </p>
            <ul id="members-invited" class="member-roster" aria-label="等待确认的邀请"></ul>
          </div>
        </section>
        <section class="members-column" aria-labelledby="members-candidates-title">
          <header class="members-column-head">
            <h3 id="members-candidates-title">未在群</h3>
            <span id="members-contacts-count" class="members-count" aria-live="polite">0</span>
          </header>
          <input id="members-search" class="member-picker-search" type="search"
            placeholder="搜索好友名称" aria-label="搜索好友名称" autocomplete="off">
          <div id="members-contacts" class="contact-list" aria-label="可添加的好友"></div>
          <button id="members-more" class="member-picker-more" type="button" hidden>加载更多</button>
        </section>
      </div>
      <section class="members-invites" id="members-invites" hidden>
        <header class="members-column-head">
          <h3>邀请链接</h3>
          <span id="members-invites-count" class="members-count" aria-live="polite">0</span>
        </header>
        <p class="members-invite-hint">默认 7 天、20 次成功加入；明文链接只显示一次，服务端不能恢复。</p>
        <div class="members-invite-form">
          <label>有效天数
            <input id="members-invite-days" type="number" min="1" max="30" value="7">
          </label>
          <label>可加入次数
            <input id="members-invite-uses" type="number" min="1" max="100" value="20">
          </label>
          <button id="members-invite-create" type="button">创建邀请链接</button>
        </div>
        <div id="members-invite-share" class="members-invite-share" hidden>
          <p id="members-invite-url" class="members-invite-url"></p>
          <div class="row">
            <button id="members-invite-copy" type="button">复制链接</button>
            <button id="members-invite-qr" type="button">显示二维码</button>
            <button id="members-invite-dismiss" type="button">收起</button>
          </div>
          <div id="members-invite-qr-wrap" class="members-invite-qr" hidden>
            <canvas id="members-invite-qr-canvas" aria-label="邀请二维码"></canvas>
            <p class="muted">二维码即加入链接，撤销后立即失效，请勿截图外传。</p>
          </div>
        </div>
        <ul id="members-invites-list" class="member-roster" aria-label="本群邀请链接"></ul>
      </section>
      <section class="members-requests" id="members-requests" hidden>
        <header class="members-column-head">
          <h3>入群申请</h3>
          <span id="members-requests-count" class="members-count" aria-live="polite">0</span>
        </header>
        <p class="members-invite-hint">申请 pending 不是成员，不计入成员数；批准时才复核容量与邀请状态。</p>
        <ul id="members-requests-list" class="member-roster" aria-label="待审批的入群申请"></ul>
        <p id="members-requests-empty" class="members-empty" hidden>没有待审批的申请</p>
      </section>
      </div>
      <p id="members-error" class="form-error" role="status" aria-live="polite"></p>
      <div class="row modal-actions members-actions">
        <span id="members-selection" class="members-selection" role="status"
          aria-live="polite">未选择</span>
        <button id="group-leave" class="danger" type="button" hidden>退出群聊</button>
        <button id="group-dissolve" class="danger" type="button" hidden>解散群聊</button>
        <button id="members-cancel" type="button">取消</button>
        <button class="primary" id="members-add" type="submit">添加</button>
      </div>
    </form>
  </div>
</div>`;
}

/**
 * 群公告弹窗：owner 与管理员可编辑，普通成员只读查看。
 *
 * 提交带 `expected_announcement_revision`，并发修改时服务端返回 VERSION_CONFLICT，
 * 页面保留草稿并提示刷新，不静默覆盖他人公告。
 */
export function announcementDialog(): string {
  return `<div class="modal" id="announcement-modal" hidden>
  <div class="modal-card announcement-card" role="dialog" aria-modal="true"
    aria-labelledby="announcement-modal-title">
    <header class="members-head">
      <h2 id="announcement-modal-title">群公告</h2>
      <button class="members-close" id="announcement-close" type="button"
        aria-label="关闭群公告" title="关闭">×</button>
    </header>
    <form id="announcement-form">
      <textarea id="announcement-input" class="announcement-input"
        maxlength="${LIMITS.roomAnnouncementBytes}" rows="6"
        placeholder="填写群公告，所有成员可见"></textarea>
      <p id="announcement-error" class="form-error" role="status" aria-live="polite"></p>
      <div class="row modal-actions">
        <span id="announcement-meta" class="members-selection" role="status"></span>
        <button id="announcement-cancel" type="button">取消</button>
        <button class="primary" id="announcement-save" type="submit">保存</button>
      </div>
    </form>
  </div>
</div>`;
}

/**
 * 新建 Agent 弹窗：名称输入与一次性 MCP URL。
 *
 * token 与 MCP URL 在创建时只存在于页面内存与只读输入框；注册成功后
 * 该 Agent 自己的 MCP URL 会写入当前 human 的本地 Agents 注册表，供会话
 * 右键提示词复用。提示词与 human token 不写入注册表。
 * 结果区默认隐藏，注册成功后才显示，避免把失败请求的 URL 当可用凭据。
 */
/** A06 管理权交接面板；打开时通过公开工具读取，不在 SSR 输出任何凭据。 */
export function transferDialog(): string {
  return `<div class="modal" id="transfer-modal" hidden>
  <div class="modal-card transfer-card" role="dialog" aria-modal="true"
    aria-labelledby="transfer-title">
    <h2 id="transfer-title">交接 Agent 管理权</h2>
    <p id="transfer-loading" class="muted">正在读取管理关系…</p>
    <p id="transfer-status" class="form-error" role="status" aria-live="polite" hidden></p>
    <div id="transfer-body" hidden>
      <p id="transfer-summary" class="muted"></p>
      <div id="transfer-propose-section" class="transfer-section" hidden>
        <h3>选择接任者</h3>
        <input id="transfer-successor-search" class="transfer-search" type="search"
          placeholder="搜索好友名称" autocomplete="off">
        <ul id="transfer-successors" class="transfer-list" aria-label="接任者候选"></ul>
        <p id="transfer-successors-empty" class="muted" hidden>没有可交接的好友</p>
        <p class="new-agent-warning">接任者必须是有有效凭据的真人；接受前管理权不变。</p>
        <div class="transfer-actions">
          <button class="primary" id="transfer-propose" type="button" disabled>发起交接</button>
        </div>
      </div>
      <div id="transfer-pending" class="transfer-section" hidden>
        <h3>交接状态</h3>
        <p id="transfer-pending-text"></p>
        <p id="transfer-pending-note" class="muted"></p>
        <div class="transfer-actions">
          <button class="primary" id="transfer-accept" type="button" hidden>接受</button>
          <button id="transfer-reject" type="button" hidden>拒绝</button>
          <button class="danger" id="transfer-cancel" type="button" hidden>取消交接</button>
        </div>
      </div>
      <div id="transfer-work" class="transfer-section">
        <h3>在途工作</h3>
        <p id="transfer-work-summary"></p>
        <ul id="transfer-work-tasks" class="transfer-list"></ul>
        <ul id="transfer-work-deliveries" class="transfer-list"></ul>
      </div>
      <div id="transfer-token-panel" class="transfer-section new-agent-result" hidden>
        <p class="new-agent-warning" id="transfer-token-warning"></p>
        <label class="field">新 MCP URL
          <input id="transfer-token" class="transfer-token" readonly>
        </label>
        <button class="new-agent-copy" id="transfer-token-copy" type="button">复制 MCP URL</button>
      </div>
    </div>
    <div class="row modal-actions">
      <button id="transfer-close" type="button">关闭</button>
    </div>
  </div>
</div>`;
}

export function newAgentDialog(): string {
  return `<div class="modal" id="new-agent-modal" hidden>
  <div class="modal-card new-agent-card" role="dialog" aria-modal="true" aria-labelledby="new-agent-title">
    <h2 id="new-agent-title">新建 Agent</h2>
    <form id="new-agent-form">
      <label class="field">Agent 名称
        <input id="new-agent-name" maxlength="${LIMITS.actorNameMax}" placeholder="例如：翻译助手"
          autocomplete="off" required>
      </label>
      <p class="new-agent-warning">MCP URL 含长期 token，创建成功后保存在此浏览器的 Agents 注册表，供会话右键提示词使用。localStorage 可被同源脚本读取：只在本机使用，不要截图、发群或写入日志；泄露需新建 Agent 或撤销。</p>
      <p id="new-agent-error" class="form-error" role="status"></p>
      <div id="new-agent-result" class="new-agent-result" hidden>
        <label class="field">MCP URL
          <input id="new-agent-url" readonly>
        </label>
        <button class="new-agent-copy" id="new-agent-copy" type="button">复制 MCP URL</button>
        <label class="field">分享链接
          <input id="new-agent-share" readonly>
        </label>
        <button class="new-agent-copy" id="new-agent-share-copy" type="button">复制分享链接</button>
        <p class="new-agent-hint">把分享链接发给对方，对方打开后可添加这个 Agent 为好友。</p>
        <div class="new-agent-prompt">
          <p class="new-agent-warning">提示词包含 MCP URL 凭据；不要发群、截图或写日志。关闭弹窗后仍可右键该 Agent 的会话重新生成。</p>
          <label class="field">技能 URL
            <input id="new-agent-skill-url" readonly>
          </label>
          <label class="field">纯 URL skill 提示词
            <textarea id="new-agent-prompt" class="new-agent-prompt-text" rows="9" readonly
              spellcheck="false" wrap="soft"></textarea>
          </label>
          <button class="new-agent-copy" id="new-agent-prompt-copy" type="button">复制提示词</button>
        </div>
      </div>
      <div class="row modal-actions">
        <button id="new-agent-close" type="button">关闭</button>
        <button class="primary" id="new-agent-create" type="submit">创建</button>
      </div>
    </form>
  </div>
</div>`;
}

/**
 * 房间文件面板：桌面右侧栏、平板抽屉与移动端全屏页共用同一份 DOM。
 *
 * `hidden` 由客户端根据断点与用户开关控制；服务端不输出任何文件数据。
 * 文件名、链接与预览内容只通过 textContent/DOM 属性写入，禁止 innerHTML。
 */
export function filesPane(): string {
  return `<aside class="files-pane" id="files-pane" aria-label="房间文件" hidden>
  <header class="files-head">
    <h2>文件</h2>
    <div class="files-head-actions">
      <button class="primary files-upload" id="files-upload" type="button">上传</button>
      <button class="files-close" id="files-close" type="button"
        aria-label="关闭文件栏" title="关闭文件栏">关闭</button>
    </div>
  </header>
  <input id="files-input" type="file" multiple hidden>
  <div id="files-drop" class="files-drop" role="button" tabindex="0"
    aria-label="拖拽文件到这里，或点击选择文件">
    <span class="files-drop-icon" aria-hidden="true">+</span>
    <span>拖拽文件到这里，或点击“上传”</span>
  </div>
  <div id="files-progress" class="files-progress" hidden>
    <p id="files-progress-text" class="files-progress-text"></p>
    <progress id="files-progress-bar" max="100" value="0"></progress>
  </div>
  <p id="files-status" class="files-status" role="status"></p>
  <button id="files-bind-retry" class="files-bind-retry" type="button" hidden>重试加入房间</button>
  <div id="files-error" class="files-error" role="alert" hidden>
    <p id="files-error-text"></p>
    <button id="files-retry" type="button">重试</button>
  </div>
  <ul id="files-list" class="files-list" aria-label="文件列表"></ul>
  <p id="files-empty" class="files-empty" hidden>这个房间还没有文件</p>
  <button id="files-more" class="files-more" type="button" hidden>加载更多</button>
</aside>`;
}

/** 文件面板的抽屉遮罩；只在 760–1199px 打开时显示。 */
export function filesBackdrop(): string {
  return '<div class="files-backdrop" id="files-backdrop" hidden></div>';
}

/**
 * 聊天区与右侧面板之间的可拖拽分隔条容器。
 *
 * React 岛挂载后渲染 `role="separator"` 的 handle；容器只在
 * `>=1200px` 且文件/监控面板打开时显示，移动端与平板抽屉完全隐藏。
 */
export function paneResizer(): string {
  return '<div class="pane-resizer" id="pane-resizer"></div>';
}

/**
 * 网页监控面板：桌面右侧第三栏、平板抽屉与移动端全屏页共用同一份 DOM。
 *
 * 顶部只有一行工具栏：标题、地址框、保存/清除/外链/刷新/关闭图标。
 * URL 只通过 DOM property 写入 iframe/链接，不使用 innerHTML/srcdoc。
 * 按产品选择不设置 sandbox；完整风险保留在 README/CLAUDE，界面不显示
 * 长段说明，只在“新标签页打开”图标的 title/aria-label 保留精简提示。
 * iframe 初始为 about:blank，关闭/切房后也回到该地址以卸载文档。
 */
export function monitorPane(): string {
  return `<aside class="monitor-pane" id="monitor-pane" aria-labelledby="monitor-title" hidden>
  <form id="monitor-form" class="monitor-toolbar">
    <h2 id="monitor-title" class="monitor-title">网页监控</h2>
    <input id="monitor-url" type="text" inputmode="url" enterkeyhint="go"
      autocomplete="off" spellcheck="false" aria-label="网页地址"
      maxlength="${LIMITS.roomMonitorUrlMax}" placeholder="https://…">
    <div class="monitor-actions">
      <button class="monitor-icon primary" id="monitor-save" type="submit"
        aria-label="保存网页地址" title="保存网页地址（Enter）">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12.5l4.2 4.2L19 7"></path></svg>
      </button>
      <button class="monitor-icon" id="monitor-clear" type="button"
        aria-label="清除网页地址" title="清除网页地址">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M9 7V5h6v2M6.5 7l.9 12h9.2l.9-12M10 11v4M14 11v4"></path></svg>
      </button>
      <a class="monitor-icon monitor-external" id="monitor-external" href="#"
        target="_blank" rel="noopener" aria-disabled="true"
        title="仅打开可信网页；目标站点可能拒绝嵌入（X-Frame-Options/CSP），HTTPS 可能阻止 HTTP 目标；iframe 未加 sandbox，同源页面可读取本页登录凭据。"
        aria-label="新标签页打开网页；仅限可信地址，iframe 未加 sandbox，同源页面可读取本页登录凭据">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 16L16 8M9.5 8H16v6.5"></path></svg>
      </a>
      <button class="monitor-icon" id="monitor-refresh" type="button"
        aria-label="刷新网页" title="刷新网页（重新读取地址）">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 12a7 7 0 1 1-2.05-4.95"></path><path d="M19 5v4h-4"></path></svg>
      </button>
      <button class="monitor-icon monitor-close" id="monitor-close" type="button"
        aria-label="关闭网页监控" title="关闭网页监控">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 7l10 10M17 7L7 17"></path></svg>
      </button>
    </div>
  </form>
  <p id="monitor-status" class="monitor-status" role="status" aria-live="polite"></p>
  <div id="monitor-error" class="monitor-error" role="alert" hidden>
    <p id="monitor-error-text"></p>
    <button id="monitor-retry" type="button">重试</button>
  </div>
  <p id="monitor-mixed" class="monitor-hint" hidden>HTTPS 页面可能阻止 HTTP 目标。</p>
  <div id="monitor-frame-wrap" class="monitor-frame-wrap">
    <p id="monitor-empty" class="monitor-empty">暂无网页</p>
    <iframe id="monitor-frame" class="monitor-frame" title="网页内容" src="about:blank" hidden></iframe>
  </div>
</aside>`;
}

/** 网页监控面板的抽屉遮罩；只在 760–1199px 打开时显示。 */
export function monitorBackdrop(): string {
  return '<div class="monitor-backdrop" id="monitor-backdrop" hidden></div>';
}

/**
 * 文件预览弹窗。
 *
 * 内容由客户端按 preview_kind 创建 DOM：图片、PDF iframe、文本 pre、
 * 音视频原生控件；未知类型只给下载入口，绝不写入 HTML/SVG。
 */
export function filePreviewDialog(): string {
  return `<div class="file-preview" id="file-preview" hidden>
  <div class="file-preview-card" role="dialog" aria-modal="true" aria-labelledby="file-preview-title">
    <header class="file-preview-head">
      <div class="file-preview-id">
        <h2 id="file-preview-title">文件预览</h2>
        <p id="file-preview-meta" class="file-preview-meta"></p>
      </div>
      <button id="file-preview-close" type="button" aria-label="关闭预览">关闭</button>
    </header>
    <div id="file-preview-body" class="file-preview-body"></div>
    <footer class="file-preview-foot">
      <a id="file-preview-download" href="#" download rel="noopener" hidden>下载文件</a>
    </footer>
  </div>
</div>`;
}

/** 好友申请弹窗：桌面左右两栏，窄屏单栏；待处理申请、好友链接与本人接收策略。 */
export function contactRequestsDialog(): string {
  return `<div class="modal" id="contact-modal" hidden>
  <div class="modal-card contact-modal-card" role="dialog" aria-modal="true" aria-labelledby="contact-modal-title">
    <h2 id="contact-modal-title">好友申请</h2>
    <p class="muted">申请只进入独立收件箱，不会直接创建单聊或写入房间消息。</p>
    <div class="contact-columns">
      <div class="contact-column contact-column-left">
        <section class="contact-policy" aria-label="我的接收策略">
          <label class="field">我的接收策略
            <select id="contact-policy-select">
              <option value="self_approval">本人确认</option>
              <option value="auto_accept">自动接受</option>
            </select>
          </label>
          <p id="contact-policy-status" class="muted" role="status"></p>
        </section>
        <section class="contact-requests-panel" aria-label="待处理好友申请">
          <h3>待处理申请</h3>
          <ul id="contact-request-list" class="contact-request-list" aria-label="待处理好友申请"></ul>
          <p id="contact-request-status" class="form-error" role="status"></p>
        </section>
      </div>
      <div class="contact-column contact-column-right">
        <section class="contact-link-panel" aria-label="好友链接">
          <h3>好友链接</h3>
          <p class="muted">生成一次性链接，24 小时内有效。对方打开并登录后会直接成为好友，无需审批；链接只能由你撤销。</p>
          <div class="contact-link-actions">
            <button id="contact-link-create" type="button">生成好友链接</button>
            <button id="contact-link-copy" type="button" hidden>复制链接</button>
          </div>
          <p id="contact-link-status" class="muted" role="status"></p>
          <ul id="contact-link-list" class="contact-link-list" aria-label="已生成的好友链接"></ul>
        </section>
        <section class="contact-friends-panel" aria-label="我的好友">
          <h3>我的好友</h3>
          <ul id="contact-friend-list" class="contact-request-list" aria-label="我的好友"></ul>
        </section>
      </div>
    </div>
    <div class="row modal-actions">
      <button id="contact-modal-close" type="button">关闭</button>
    </div>
  </div>
</div>`;
}

/** 举报弹窗：类别、可选备注与房间/消息定位；只进入受控管理流程。 */
export function reportDialog(): string {
  return `<div class="modal" id="report-modal" hidden>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="report-modal-title">
    <h2 id="report-modal-title">举报</h2>
    <p class="muted">举报只保存发送者、类别、短备注与消息定位，不复制消息正文，也不会自动对外发送。</p>
    <label class="field">被举报成员
      <select id="report-target"></select>
    </label>
    <label class="field">类别
      <select id="report-category">
        <option value="harassment">骚扰</option>
        <option value="spam">垃圾信息</option>
        <option value="fraud">诈骗</option>
        <option value="other">其他</option>
      </select>
    </label>
    <label class="field">补充说明（可选）
      <textarea id="report-note" rows="3" maxlength="1024"></textarea>
    </label>
    <p id="report-status" class="form-error" role="status"></p>
    <div class="row modal-actions">
      <button id="report-cancel" type="button">取消</button>
      <button id="report-submit" class="primary" type="button">提交举报</button>
    </div>
  </div>
</div>`;
}

/**
 * 任务弹窗：我的任务、任务详情与新建任务。
 *
 * 文本全部由客户端以 textContent 写入；详情里的长目标保留换行，
 * 卡片/来源消息按钮只滚动到同一条消息，不复制任务或生成新授权。
 */
export function taskDialogs(): string {
  return `<div class="modal" id="my-tasks-modal" hidden>
  <div class="modal-card task-modal-card" role="dialog" aria-modal="true"
    aria-labelledby="my-tasks-title">
    <header class="task-modal-head">
      <h2 id="my-tasks-title">我的任务</h2>
      <button class="task-popover-close" id="my-tasks-close" type="button"
        aria-label="关闭我的任务" title="关闭">×</button>
    </header>
    <ul class="task-list task-list-wide" id="my-tasks-list" aria-label="我的任务列表"></ul>
    <p class="task-popover-empty" id="my-tasks-empty" role="status" hidden>暂无任务</p>
  </div>
</div>
<div class="modal" id="task-detail-modal" hidden>
  <div class="modal-card task-modal-card" role="dialog" aria-modal="true"
    aria-labelledby="task-detail-title">
    <header class="task-modal-head">
      <h2 id="task-detail-title">任务详情</h2>
      <button class="task-popover-close" id="task-detail-close" type="button"
        aria-label="关闭任务详情" title="关闭">×</button>
    </header>
    <dl class="task-detail-grid" id="task-detail-body"></dl>
    <div class="task-detail-actions" id="task-detail-actions"></div>
  </div>
</div>
<div class="modal" id="task-create-modal" hidden>
  <div class="modal-card task-modal-card" role="dialog" aria-modal="true"
    aria-labelledby="task-create-title">
    <header class="task-modal-head">
      <h2 id="task-create-title">新建任务</h2>
    </header>
    <form id="task-create-form">
      <p class="muted task-source-hint" id="task-source-hint" hidden></p>
      <label class="field">短标题
        <input id="task-title" maxlength="${LIMITS.taskTitleMax}" required
          placeholder="列表展示用短标题">
      </label>
      <label class="field">详细目标
        <textarea id="task-description" rows="4"
          placeholder="交接背景、目标与约束；完整正文不会塞进短标题"></textarea>
      </label>
      <label class="field">验收条件
        <textarea id="task-acceptance" rows="3" placeholder="怎样算完成"></textarea>
      </label>
      <div class="task-form-row">
        <label class="field">负责人
          <select id="task-assignee"></select>
        </label>
        <label class="field">验收人
          <select id="task-reviewer"></select>
        </label>
      </div>
      <label class="field">期限（可选）
        <input id="task-due" type="datetime-local">
      </label>
      <p class="form-error" id="task-form-error" role="alert"></p>
      <div class="row modal-actions">
        <button id="task-create-cancel" type="button">取消</button>
        <button class="primary" type="submit">创建任务</button>
      </div>
    </form>
  </div>
</div>
<div class="modal" id="task-submit-modal" hidden>
  <div class="modal-card task-modal-card" role="dialog" aria-modal="true"
    aria-labelledby="task-submit-title">
    <header class="task-modal-head">
      <h2 id="task-submit-title">提交成果</h2>
      <button class="task-popover-close" id="task-submit-close" type="button"
        aria-label="关闭提交成果" title="关闭">×</button>
    </header>
    <form id="task-submit-form">
      <p class="muted task-source-hint">提交后生成不可原地改写的版本；退回后才能重新提交新版本。</p>
      <label class="field">成果摘要
        <textarea id="task-submit-summary" rows="4" required
          placeholder="完成了什么、如何核对；不要粘贴凭据或私密正文"></textarea>
      </label>
      <fieldset class="task-submit-section">
        <legend>材料（同一房间文件）</legend>
        <p class="muted" id="task-submit-materials-status" role="status">正在读取房间文件…</p>
        <ul class="task-submit-materials" id="task-submit-materials"></ul>
      </fieldset>
      <fieldset class="task-submit-section">
        <legend>外链</legend>
        <p class="muted">只记录目标版本/摘要与声明可用性；服务端不抓取外链，可访问不等于验收通过。</p>
        <div class="task-submit-links" id="task-submit-links"></div>
        <button class="link-btn" id="task-submit-add-link" type="button">添加外链</button>
      </fieldset>
      <label class="field">实现提交 SHA（可选，7–64 位十六进制）
        <input id="task-submit-commit-sha" maxlength="${LIMITS.taskSubmissionCommitShaMax}"
          placeholder="非代码任务可留空，但需提供其他可核对成果">
      </label>
      <label class="field">验证证据（每行一条）
        <textarea id="task-submit-evidence" rows="3"
          placeholder="测试命令、结果计数、截图说明或复核步骤"></textarea>
      </label>
      <label class="field">已知限制（可选）
        <textarea id="task-submit-known-limits" rows="2"
          placeholder="未覆盖的范围、已知问题或需要验收人注意的事项"></textarea>
      </label>
      <p class="form-error" id="task-submit-error" role="alert"></p>
      <div class="row modal-actions">
        <button id="task-submit-cancel" type="button">取消</button>
        <button class="primary" type="submit">提交成果</button>
      </div>
    </form>
  </div>
</div>
<div class="modal" id="task-review-modal" hidden>
  <div class="modal-card task-modal-card" role="dialog" aria-modal="true"
    aria-labelledby="task-review-title">
    <header class="task-modal-head">
      <h2 id="task-review-title">验收通过</h2>
      <button class="task-popover-close" id="task-review-close" type="button"
        aria-label="关闭验收" title="关闭">×</button>
    </header>
    <form id="task-review-form">
      <p class="muted task-source-hint" id="task-review-summary"></p>
      <fieldset class="task-submit-section">
        <legend>验收清单</legend>
        <p class="muted">逐项勾选验收条件；勾选结果随验收记录保存，有未通过项时请使用退回。</p>
        <ul class="task-review-checklist" id="task-review-checklist"></ul>
      </fieldset>
      <p class="form-error" id="task-review-error" role="alert"></p>
      <div class="row modal-actions">
        <button id="task-review-cancel" type="button">取消</button>
        <button class="primary" type="submit">确认验收通过</button>
      </div>
    </form>
  </div>
</div>`;
}
