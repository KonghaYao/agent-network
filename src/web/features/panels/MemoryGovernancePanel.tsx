import { Button, Pagination } from '../../app/lenso-controls';
import { MemoryChip } from './memory-row';
import { MemoryList } from './MemoryPanelList';
import { excerpt, num, text, time } from './memory-format';
import type { MemoryPanelController } from './useMemoryPanelController';

type Props = Pick<
  MemoryPanelController,
  | 'governanceStatus'
  | 'forgetTarget'
  | 'setForgetTarget'
  | 'operation'
  | 'curated'
  | 'sources'
  | 'sourceMore'
  | 'loadGovernance'
  | 'confirmForget'
>;

export function MemoryGovernancePanel({
  governanceStatus,
  forgetTarget,
  setForgetTarget,
  operation,
  curated,
  sources,
  sourceMore,
  loadGovernance,
  confirmForget,
}: Props) {
  return (
    <>
      <p id="memory-governance-status" className="memory-state" role="status">
        {governanceStatus}
      </p>
      <div id="memory-governance-confirm">
        {forgetTarget ? (
          <div className="memory-confirm">
            <p>
              确认遗忘「{forgetTarget.label}」？遗忘会先在本地排除，再异步清理后端；
              无法确认后端副本清除时会保持“清除状态未知”。
            </p>
            <div className="memory-confirm-actions">
              <Button className="memory-action" type="button" onClick={() => setForgetTarget(null)}>
                取消
              </Button>
              <Button className="memory-action danger" type="button" onClick={() => void confirmForget()}>
                确认遗忘
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <section className="memory-block" aria-labelledby="memory-curated-title">
        <div className="memory-block-head">
          <h3 id="memory-curated-title">人工记忆</h3>
          <Button className="memory-small-btn" type="button" onClick={() => void loadGovernance()}>
            刷新
          </Button>
        </div>
        <p className="memory-note">人工保存只代表明确写入，不是群消息阅读证明。</p>
        <MemoryList id="memory-curated-list">
          {curated.map((item, index) => (
            <div className="memory-list-item" role="listitem" key={text(item.curated_id, String(index))}>
              <div className="memory-row memory-row-static">
                <span className="memory-row-title">{text(item.title, '未命名人工记忆')}</span>
                <MemoryChip>修订 {num(item.revision)}</MemoryChip>
                <p className="memory-row-meta">
                  {text(item.origin, '人工保存')} · 更新 {time(item.updated_at)}
                </p>
                <p className="memory-row-preview">{excerpt(item.content)}</p>
                <div className="memory-row-actions">
                  <Button
                    className="memory-action danger"
                    type="button"
                    onClick={() =>
                      setForgetTarget({
                        kind: 'curated',
                        id: text(item.curated_id),
                        revision: num(item.revision),
                        label: text(item.title, '人工记忆'),
                      })
                    }
                  >
                    遗忘/移除
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </MemoryList>
      </section>
      <section className="memory-block" aria-labelledby="memory-source-title">
        <div className="memory-block-head">
          <h3 id="memory-source-title">来源</h3>
        </div>
        <p className="memory-note">
          来源只包含该 Agent 实际获得过的消息/文件；遗忘会先从本地排除，
          后端清除无法确认时保持未知。
        </p>
        <MemoryList id="memory-source-list">
          {sources.map((item, index) => (
            <div className="memory-list-item" role="listitem" key={text(item.source_id, String(index))}>
              <div className="memory-row memory-row-static">
                <span className="memory-row-title">
                  来源 · {text(item.source_kind, '未知')}
                </span>
                <MemoryChip>修订 {num(item.revision)}</MemoryChip>
                <MemoryChip tone={item.state === 'active' ? 'good' : 'warn'}>
                  {text(item.state, '未知')}
                </MemoryChip>
                <p className="memory-row-meta">
                  {text(item.origin_room_id, '无房间')} · 创建 {time(item.created_at)}
                </p>
                {item.available === true ? (
                  <div className="memory-row-actions">
                    <Button
                      className="memory-action danger"
                      type="button"
                      onClick={() =>
                        setForgetTarget({
                          kind: 'source',
                          id: text(item.source_id),
                          revision: num(item.revision),
                          label: text(item.source_kind, '来源'),
                        })
                      }
                    >
                      遗忘/移除来源
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </MemoryList>
        {sourceMore ? (
          <Pagination style={{ display: 'flex', justifyContent: 'center', width: '100%', marginTop: 8 }} aria-label="来源分页">
            <Button
              id="memory-source-more"
              className="memory-page-btn"
              type="button"
              onClick={() => void loadGovernance(true)}
            >
              加载更多来源
            </Button>
          </Pagination>
        ) : null}
      </section>
      {operation ? (
        <div id="memory-operation" className="memory-operation">
          <h3>治理操作状态</h3>
          <p className="memory-row-meta">
            状态 {text(operation.status, '未知')} · 清除状态{' '}
            {text(operation.purge, '清除状态未知')}
          </p>
        </div>
      ) : null}
    </>
  );
}
