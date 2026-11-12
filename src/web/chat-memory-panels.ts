/**
 * Memory 面板的静态骨架。
 *
 * 服务端只输出空壳；能力、召回、上下文、经历、宿主与治理内容全部由
 * 客户端按当前身份调用 `network_memory_*` 后填充。所有列表和正文都使用
 * `textContent` 写入，避免把记忆正文当成 HTML 执行。
 */
export function memoryDrawer(): string {
  return `<dialog id="memory-drawer" class="memory-drawer" aria-labelledby="memory-title">
  <div class="memory-card">
    <header class="memory-head">
      <div class="memory-heading">
        <h2 id="memory-title">记忆</h2>
        <p id="memory-subtitle" class="memory-subtitle">正在读取身份…</p>
      </div>
      <button id="memory-refresh" class="memory-icon-btn" type="button"
        aria-label="刷新记忆状态" title="刷新">↻</button>
      <button id="memory-close" class="memory-icon-btn" type="button"
        aria-label="关闭记忆面板" title="关闭">×</button>
    </header>
    <p id="memory-status" class="memory-state" role="status" aria-live="polite">正在读取…</p>
    <div id="memory-body" class="memory-body" hidden>
      <section id="memory-capability" class="memory-capability" aria-label="Memory 能力与状态"></section>
      <nav id="memory-tabs" class="memory-tabs" aria-label="Memory 视图" hidden>
        <button class="memory-tab" type="button" data-memory-tab="recall" aria-pressed="true">召回</button>
        <button class="memory-tab" type="button" data-memory-tab="context" aria-pressed="false">上下文</button>
        <button class="memory-tab" type="button" data-memory-tab="experience" aria-pressed="false">经历</button>
        <button class="memory-tab" type="button" data-memory-tab="host" aria-pressed="false">宿主</button>
        <button class="memory-tab" type="button" data-memory-tab="governance" aria-pressed="false">治理</button>
      </nav>
      <div id="memory-panels" class="memory-panels">
        <section id="memory-panel-recall" class="memory-panel" data-memory-panel="recall"
          aria-label="召回">
          <form id="memory-recall-form" class="memory-form">
            <label class="memory-field">模式
              <select id="memory-recall-mode">
                <option value="lookup">lookup · 显式查询</option>
                <option value="reflect">reflect · 综合分析</option>
              </select>
            </label>
            <label class="memory-field">查询
              <input id="memory-recall-query" type="text" maxlength="2000"
                autocomplete="off" placeholder="例如：发布流程或最近的偏好">
            </label>
            <label class="memory-field">最低证据
              <select id="memory-recall-evidence">
                <option value="">不限</option>
                <option value="host_reported_submitted">宿主报告已提交</option>
                <option value="gateway_observed_submitted">网关观察已提交</option>
              </select>
            </label>
            <button class="primary memory-submit" type="submit">召回</button>
          </form>
          <p id="memory-recall-status" class="memory-state" role="status" aria-live="polite"></p>
          <div id="memory-recall-result" class="memory-result"></div>
        </section>

        <section id="memory-panel-context" class="memory-panel" data-memory-panel="context"
          aria-label="记忆上下文" hidden>
          <div class="memory-toolbar">
            <label class="memory-field">类型
              <select id="memory-context-kind">
                <option value="">全部</option>
                <option value="lookup">lookup</option>
                <option value="bound">bound</option>
              </select>
            </label>
            <button id="memory-context-refresh" class="memory-small-btn" type="button">刷新</button>
          </div>
          <p id="memory-context-status" class="memory-state" role="status" aria-live="polite"></p>
          <div id="memory-context-list" class="memory-list" role="list"></div>
          <button id="memory-context-more" class="memory-page-btn" type="button" hidden>加载更多</button>
          <div id="memory-context-detail" class="memory-detail" hidden></div>
        </section>

        <section id="memory-panel-experience" class="memory-panel" data-memory-panel="experience"
          aria-label="输入经历" hidden>
          <div class="memory-toolbar">
            <label class="memory-field">来源房间
              <select id="memory-experience-room"><option value="">全部房间</option></select>
            </label>
            <button id="memory-experience-refresh" class="memory-small-btn" type="button">刷新</button>
          </div>
          <p id="memory-experience-status" class="memory-state" role="status" aria-live="polite"></p>
          <div id="memory-experience-list" class="memory-list" role="list"></div>
          <button id="memory-experience-more" class="memory-page-btn" type="button" hidden>加载更多</button>
          <div id="memory-experience-detail" class="memory-detail" hidden></div>
        </section>

        <section id="memory-panel-host" class="memory-panel" data-memory-panel="host"
          aria-label="宿主与输入" hidden>
          <div id="memory-host-info" class="memory-host-info"></div>
          <p class="memory-note">宿主绑定由已鉴权宿主会话创建；本面板只展示服务端等级与清单状态，
            不会代替宿主声明可信、已注入或已提交。</p>
          <form id="memory-manifest-form" class="memory-form">
            <label class="memory-field">manifest_id
              <input id="memory-manifest-id" type="text" maxlength="128"
                autocomplete="off" placeholder="宿主提交清单后返回的 manifest_id">
            </label>
            <button class="primary memory-submit" type="submit">查询清单状态</button>
          </form>
          <p id="memory-manifest-status" class="memory-state" role="status" aria-live="polite"></p>
          <div id="memory-manifest-result" class="memory-result"></div>
        </section>

        <section id="memory-panel-governance" class="memory-panel" data-memory-panel="governance"
          aria-label="记忆治理" hidden>
          <p id="memory-governance-status" class="memory-state" role="status" aria-live="polite"></p>
          <div id="memory-governance-confirm"></div>
          <section class="memory-block" aria-labelledby="memory-curated-title">
            <div class="memory-block-head">
              <h3 id="memory-curated-title">人工记忆</h3>
              <button id="memory-governance-refresh" class="memory-small-btn" type="button">刷新</button>
            </div>
            <p class="memory-note">人工保存只代表明确写入，不是群消息阅读证明。</p>
            <div id="memory-curated-list" class="memory-list" role="list"></div>
          </section>
          <section class="memory-block" aria-labelledby="memory-source-title">
            <div class="memory-block-head">
              <h3 id="memory-source-title">来源</h3>
            </div>
            <p class="memory-note">来源只包含该 Agent 实际获得过的消息/文件；遗忘会先从本地排除，
              后端清除无法确认时保持未知。</p>
            <div id="memory-source-list" class="memory-list" role="list"></div>
            <button id="memory-source-more" class="memory-page-btn" type="button" hidden>加载更多来源</button>
          </section>
          <div id="memory-operation" class="memory-operation" hidden></div>
        </section>
      </div>
    </div>
  </div>
</dialog>`;
}
