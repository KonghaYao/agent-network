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
      <button class="icon-btn" id="new-group" type="button" aria-label="新建群聊" title="新建群聊">+</button>
    </div>
    <label class="search-box">
      <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="11" cy="11" r="6.5"></circle>
        <path d="M16 16l4 4"></path>
      </svg>
      <input id="room-search" type="search" placeholder="搜索" autocomplete="off" aria-label="搜索会话">
    </label>
  </header>
  <div class="sidebar-list">
    <ol id="room-list" class="room-list" aria-label="单聊">
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
    <button id="room-list-retry" class="list-retry" type="button" hidden>重试</button>
    <button id="logged-out-start" class="list-retry" type="button" hidden>创建新身份并继续</button>
  </div>
  <footer class="sidebar-foot">
    <p id="stream-banner" class="stream-banner" role="status" hidden></p>
    ${deviceHandoffAccount()}
    <details class="service-info">
      <summary>服务信息</summary>
      <p>MCP 端点 <code>/mcp</code></p>
      <p>分享链接 <code>/a/&lt;agent_session_id&gt;</code></p>
      <p>单聊页面 <code>/c/&lt;room_id&gt;</code></p>
    </details>
  </footer>
  <div class="room-menu" id="room-menu" role="menu" aria-label="会话操作" hidden>
    <button class="room-menu-item" id="room-menu-copy-prompt" type="button"
      role="menuitem">复制 Agent 连接提示词</button>
    <button class="room-menu-item" id="room-menu-archive" type="button"
      role="menuitem" hidden>归档</button>
    <button class="room-menu-item danger" id="room-menu-reissue-token" type="button"
      role="menuitem" hidden>注销并重发 token</button>
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
        <button class="link-btn" id="add-members" type="button" hidden>添加成员</button>
      </div>
      <p class="muted" id="subtitle">正在加载…</p>
    </div>
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
  </header>
  <form id="rename-form" class="rename-form" hidden>
    <input id="rename-input" maxlength="${LIMITS.actorNameMax}" aria-label="Agent 新名称"
      placeholder="新的 Agent 名称">
    <button class="primary" type="submit">保存</button>
    <button type="button" id="rename-cancel">取消</button>
  </form>
  <div class="chat-body" id="chat-body" aria-busy="false">
    <div id="chat-loading" class="chat-loading" role="status" hidden>正在加载会话…</div>
    <div id="chat-skeleton" class="chat-skeleton" aria-hidden="true" hidden>
      <div class="skeleton-row"><span class="skeleton-avatar"></span><span class="skeleton-bubble"></span></div>
      <div class="skeleton-row mine"><span class="skeleton-avatar"></span><span class="skeleton-bubble"></span></div>
      <div class="skeleton-row"><span class="skeleton-avatar"></span><span class="skeleton-bubble"></span></div>
    </div>
    <button id="older" type="button" hidden>加载更早</button>
    <div id="chat-error" class="chat-error" role="alert" hidden>
      <p id="chat-error-text"></p>
      <div class="chat-error-actions">
        <button id="chat-error-retry" type="button">重试</button>
        <a id="chat-error-back" href="/">返回会话列表</a>
      </div>
    </div>
    <p id="stream-status" class="stream-status" role="status" hidden></p>
    <ol id="messages" class="messages" aria-live="polite"></ol>
    <p id="status" role="status"></p>
    <div id="mention-picker" class="mention-picker" hidden role="listbox" aria-label="选择要 @ 的成员"></div>
    <form id="composer" class="composer">
      <textarea id="body" rows="1" maxlength="262144" placeholder="输入消息…" aria-label="消息正文"></textarea>
      <button class="send-btn primary" id="send" type="submit">发送</button>
    </form>
    <div id="composer-drop" class="composer-drop" hidden aria-hidden="true">
      <span class="composer-drop-title">松开即可上传文件</span>
      <span class="composer-drop-hint">文件会加入当前会话，公开链接插入输入框</span>
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
        <input id="group-title" maxlength="160" placeholder="留空显示为“群聊”">
      </label>
      <p class="muted picker-label">选择好友成员</p>
      <div id="group-contacts" class="contact-list"></div>
      <p id="group-error" class="form-error" role="status"></p>
      <div class="row modal-actions">
        <button id="group-cancel" type="button">取消</button>
        <button class="primary" id="group-create" type="submit">创建</button>
      </div>
    </form>
  </div>
</div>`;
}

/**
 * 群聊添加成员弹窗：上方只读展示当前成员，下方分页好友多选。
 *
 * 只有群 owner 能提交；非 owner 打开时显示明确提示并禁用“添加”。
 * 好友列表在客户端排除自己与当前成员，服务端仍会再次校验所有权与好友关系。
 */
export function membersDialog(): string {
  return `<div class="modal" id="members-modal" hidden>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="members-modal-title">
    <h2 id="members-modal-title">添加成员</h2>
    <form id="members-form">
      <p class="muted picker-label">当前成员</p>
      <ul id="members-current" class="member-roster" aria-label="当前群成员"></ul>
      <p class="muted picker-label">选择好友加入</p>
      <div id="members-contacts" class="contact-list"></div>
      <p id="members-error" class="form-error" role="status"></p>
      <div class="row modal-actions">
        <button id="members-cancel" type="button">取消</button>
        <button class="primary" id="members-add" type="submit">添加</button>
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
 * 网页监控面板：桌面右侧第三栏、平板抽屉与移动端全屏页共用同一份 DOM。
 *
 * URL 只通过 DOM property 写入 iframe/链接，不使用 innerHTML/srcdoc。
 * 按产品选择不设置 sandbox；完整风险保留在 README/CLAUDE，界面不显示
 * 长段说明，只在“新标签页打开”的 title/aria-label 保留精简提示。
 * iframe 初始为 about:blank，关闭/切房后也回到该地址以卸载文档。
 */
export function monitorPane(): string {
  return `<aside class="monitor-pane" id="monitor-pane" aria-labelledby="monitor-title" hidden>
  <header class="monitor-head">
    <h2 id="monitor-title">网页监控</h2>
    <div class="monitor-head-actions">
      <button class="monitor-refresh" id="monitor-refresh" type="button"
        aria-label="重新读取网页地址" title="重新读取网页地址">刷新</button>
      <button class="monitor-close" id="monitor-close" type="button"
        aria-label="关闭网页监控" title="关闭网页监控">关闭</button>
    </div>
  </header>
  <form id="monitor-form" class="monitor-form">
    <label class="monitor-field">
      <span class="monitor-label">网页地址</span>
      <input id="monitor-url" type="text" inputmode="url" autocomplete="off" spellcheck="false"
        maxlength="${LIMITS.roomMonitorUrlMax}" placeholder="https://…">
    </label>
    <div class="monitor-form-actions">
      <button class="primary" id="monitor-save" type="submit">保存</button>
      <button id="monitor-clear" type="button">清除</button>
    </div>
  </form>
  <p id="monitor-status" class="monitor-status" role="status" aria-live="polite"></p>
  <div id="monitor-error" class="monitor-error" role="alert" hidden>
    <p id="monitor-error-text"></p>
    <button id="monitor-retry" type="button">重试</button>
  </div>
  <div id="monitor-frame-wrap" class="monitor-frame-wrap">
    <p id="monitor-empty" class="monitor-empty">暂无网页</p>
    <iframe id="monitor-frame" class="monitor-frame" title="网页内容" src="about:blank" hidden></iframe>
  </div>
  <footer class="monitor-foot">
    <a id="monitor-external" class="monitor-external" href="#" target="_blank" rel="noopener"
      aria-disabled="true"
      title="仅打开可信网页；目标站点可能拒绝嵌入（X-Frame-Options/CSP），HTTPS 可能阻止 HTTP 目标；iframe 未加 sandbox，同源页面可读取本页登录凭据。"
      aria-label="新标签页打开网页；仅限可信地址，iframe 未加 sandbox，同源页面可读取本页登录凭据">新标签页打开</a>
    <p id="monitor-mixed" class="monitor-hint" hidden>HTTPS 页面可能阻止 HTTP 目标。</p>
  </footer>
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
