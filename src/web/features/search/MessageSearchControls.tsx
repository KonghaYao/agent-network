import { SegmentedControl } from '../../app/lenso-controls';
import type { MessageSearchMode, MessageSearchScope } from './message-search-types';

/**
 * 两个正交维度：模式（精确/模糊）与范围（当前会话/全部会话）。
 *
 * 任务搜索沿用关键词规则，因此勾选“只看任务”时模式控件禁用；
 * 全部会话不支持只看任务，由弹窗在切到 all 时清空并禁用该开关。
 */
export function MessageSearchControls({
  mode,
  scope,
  taskOnly,
  onModeChange,
  onScopeChange,
}: {
  mode: MessageSearchMode;
  scope: MessageSearchScope;
  taskOnly: boolean;
  onModeChange: (mode: MessageSearchMode) => void;
  onScopeChange: (scope: MessageSearchScope) => void;
}) {
  const modeDisabled = taskOnly;
  return (
    <div id="message-search-controls" className="message-search-controls">
      <div className="message-search-control-row">
        <span className="message-search-control-label" id="message-search-mode-label">
          模式
        </span>
        <div
          id="message-search-mode"
          className={`message-search-segment${modeDisabled ? ' is-disabled' : ''}`}
        >
          <SegmentedControl
            aria-label="搜索模式"
            items={[
              { value: 'exact', label: '精确' },
              { value: 'fuzzy', label: '模糊', disabled: modeDisabled },
            ]}
            value={mode}
            disabled={modeDisabled}
            onValueChange={(value) => {
              if (modeDisabled) return;
              if (value === 'exact' || value === 'fuzzy') onModeChange(value);
            }}
          />
        </div>
      </div>
      <div className="message-search-control-row">
        <span className="message-search-control-label" id="message-search-scope-label">
          范围
        </span>
        <div id="message-search-scope" className="message-search-segment">
          <SegmentedControl
            aria-label="搜索范围"
            items={[
              { value: 'room', label: '当前会话' },
              { value: 'all', label: '全部会话' },
            ]}
            value={scope}
            onValueChange={(value) => {
              if (value === 'room' || value === 'all') onScopeChange(value);
            }}
          />
        </div>
      </div>
    </div>
  );
}
