import {
  availabilityText,
  FACT_TYPE_LABEL,
  formatMemoryTime,
  type MemoryFailure,
  type MemoryFactType,
  type MemoryOverviewResult,
} from './memory-data';

const FACT_TYPES: MemoryFactType[] = ['world', 'experience', 'observation'];

function Stat({ id, label, value }: { id: string; label: string; value: number }) {
  return (
    <div className="memory-stat">
      <span className="memory-stat-value" id={id}>
        {value.toLocaleString('zh-CN')}
      </span>
      <span className="memory-stat-label">{label}</span>
    </div>
  );
}

/** 概览只展示服务端统计白名单；不渲染 bank/space/provider。 */
export function MemoryOverview({
  targetName,
  result,
  failure,
  loading,
}: {
  targetName: string;
  result: MemoryOverviewResult | null;
  failure: MemoryFailure | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <section className="memory-overview" aria-labelledby="memory-overview-title">
        <h3 id="memory-overview-title">概览</h3>
        <p className="memory-status" id="memory-overview-state" role="status">
          正在读取记忆统计…
        </p>
        <div className="memory-stat-grid" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <span className="memory-stat-skeleton" key={index} />
          ))}
        </div>
      </section>
    );
  }

  if (failure) {
    return (
      <section className="memory-overview" aria-labelledby="memory-overview-title">
        <h3 id="memory-overview-title">概览</h3>
        <div
          className="memory-empty"
          id="memory-overview-state"
          data-state={failure.kind}
          role="status"
        >
          <p>{failure.message}</p>
          {failure.kind === 'forbidden' ? (
            <p className="memory-hint">权限由服务端判断；这里不会显示任何记忆正文。</p>
          ) : null}
        </div>
      </section>
    );
  }

  if (!result || !result.stats || !result.available) {
    const reason = result?.reason ?? 'backend_not_configured';
    return (
      <section className="memory-overview" aria-labelledby="memory-overview-title">
        <h3 id="memory-overview-title">概览</h3>
        <div
          className="memory-empty"
          id="memory-overview-state"
          data-state={reason}
          role="status"
        >
          <p>{availabilityText(reason)}</p>
        </div>
      </section>
    );
  }

  const stats = result.stats;
  const typeTotal = FACT_TYPES.reduce((sum, type) => sum + (stats.by_fact_type[type] ?? 0), 0);
  const lastWrite = formatMemoryTime(stats.last_write_at);

  return (
    <section className="memory-overview" aria-labelledby="memory-overview-title">
      <div className="memory-section-head">
        <h3 id="memory-overview-title">概览</h3>
        <span className="memory-updated">读取于 {formatMemoryTime(new Date(result.fetched_at).toISOString())}</span>
      </div>
      <div className="memory-stat-grid">
        <Stat id="memory-stat-nodes" label="记忆" value={stats.total_nodes} />
        <Stat id="memory-stat-links" label="关系" value={stats.total_links} />
        <Stat id="memory-stat-docs" label="文档" value={stats.total_documents} />
      </div>
      <div className="memory-distribution" id="memory-overview-types" aria-label="按事实类型分布">
        {FACT_TYPES.map((type) => {
          const value = stats.by_fact_type[type] ?? 0;
          const ratio = typeTotal > 0 ? Math.round((value / typeTotal) * 100) : 0;
          return (
            <div className="memory-bar-row" key={type}>
              <span className="memory-bar-label">{FACT_TYPE_LABEL[type]}</span>
              <span className="memory-bar-track" aria-hidden="true">
                <span className={`memory-bar-fill type-${type}`} style={{ width: `${ratio}%` }} />
              </span>
              <span className="memory-bar-value">
                {value.toLocaleString('zh-CN')}
                <span className="memory-bar-ratio"> · {ratio}%</span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="memory-meta" id="memory-overview-jobs">
        <p className="memory-meta-line">
          <span>最近写入</span>
          <strong id="memory-overview-last-write">{lastWrite}</strong>
        </p>
        <p className="memory-meta-line">
          <span>最近整理</span>
          <strong>{formatMemoryTime(stats.last_consolidated_at)}</strong>
        </p>
        {stats.pending_operations > 0 ? (
          <p className="memory-chip warn" role="status">
            后台仍在整理 {stats.pending_operations.toLocaleString('zh-CN')} 条记忆
          </p>
        ) : null}
        {stats.failed_operations > 0 ? (
          <p className="memory-chip error" role="alert">
            有 {stats.failed_operations.toLocaleString('zh-CN')} 条整理失败，稍后会自动重试
          </p>
        ) : null}
        <p className="memory-hint">正在查看 {targetName} 的后端统计。</p>
      </div>
    </section>
  );
}
