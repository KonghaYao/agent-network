import { Button, Pagination, Select } from '../../app/lenso-controls';
import { CONTEXT_KIND_OPTIONS } from './memory-select-options';
import { MemoryChip } from './memory-row';
import { MemoryList } from './MemoryPanelList';
import { text, time } from './memory-format';
import type { MemoryPanelController } from './useMemoryPanelController';

type Props = Pick<
  MemoryPanelController,
  | 'contextKind'
  | 'setContextKind'
  | 'contexts'
  | 'contextStatus'
  | 'contextMore'
  | 'contextDetail'
  | 'loadContexts'
  | 'openContext'
>;

export function MemoryContextPanel({
  contextKind,
  setContextKind,
  contexts,
  contextStatus,
  contextMore,
  contextDetail,
  loadContexts,
  openContext,
}: Props) {
  return (
    <>
      <div className="memory-toolbar">
        <div className="memory-field">
          <span>类型</span>
          <Select
            id="memory-context-kind"
            aria-label="上下文类型"
            value={contextKind}
            options={CONTEXT_KIND_OPTIONS}
            onChange={setContextKind}
          />
        </div>
        <Button className="memory-small-btn" type="button" onClick={() => void loadContexts(true)}>
          刷新
        </Button>
      </div>
      <p id="memory-context-status" className="memory-state" role="status">
        {contextStatus}
      </p>
      <MemoryList id="memory-context-list">
        {contexts.map((item, index) => (
          <div className="memory-list-item" role="listitem" key={text(item.context_id, String(index))}>
            <Button
              className="memory-row"
              style={{ minHeight: 44, justifyContent: 'flex-start' }}
              type="button"
              onClick={() => void openContext(text(item.context_id))}
            >
              <span className="memory-row-title">{text(item.context_id, '上下文')}</span>
              <MemoryChip>{text(item.kind, '类型未知')}</MemoryChip>
              <span className="memory-row-meta">
                有效性 {text(item.validity, '未知')} · 创建 {time(item.created_at)}
              </span>
            </Button>
          </div>
        ))}
      </MemoryList>
      {contextMore ? (
        <Pagination style={{ display: 'flex', justifyContent: 'center', width: '100%', marginTop: 8 }} aria-label="上下文分页">
          <Button
            id="memory-context-more"
            className="memory-page-btn"
            type="button"
            onClick={() => void loadContexts(false)}
          >
            加载更多
          </Button>
        </Pagination>
      ) : null}
      {contextDetail ? (
        <div id="memory-context-detail" className="memory-detail">
          <h3>上下文详情</h3>
          {contextDetail.available === false ? (
            <p className="memory-note">当前不可读：{contextDetail.reason || '原因未知'}</p>
          ) : (
            <>
              <p className="memory-detail-meta">
                {contextDetail.kind ?? '类型未知'} · 有效性 {contextDetail.validity ?? '未知'}
              </p>
              <pre className="memory-body-text">{contextDetail.body}</pre>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
