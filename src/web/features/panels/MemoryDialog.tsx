import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { useWebSession } from '../../hooks/useWebSession';
import { callTool, type McpError } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';
import type { WebIdentity } from '../../lib/identity';

type MemoryRecord = Record<string, unknown>;
type TabName = 'recall' | 'context' | 'experience' | 'host' | 'governance';

interface MemoryCatalog {
  enabled?: boolean;
  capture?: boolean;
  host_modes?: string[];
  recall_modes?: string[];
  supported?: string[];
  unsupported?: string[];
  reason?: string | null;
}

interface MemoryMe extends WebIdentity {
  service?: { memory?: MemoryCatalog };
}

interface MemoryStatus {
  enabled?: boolean;
  capture?: boolean;
  host_level?: string;
  counts?: Record<string, number>;
  unsupported?: string[];
  supported_host_modes?: string[];
}

interface RecallResult {
  status?: string;
  coverage?: string;
  evidence_complete?: boolean;
  context_ref?: string | null;
  budget_used?: { candidates?: number; packaged_bytes?: number; truncated?: boolean };
  items?: MemoryRecord[];
  freshness?: { as_of?: string };
}

interface ContextPage {
  items?: MemoryRecord[];
  next_cursor?: string | null;
  has_more?: boolean;
}

interface ContextDetail {
  available?: boolean;
  reason?: string | null;
  context_id?: string;
  kind?: string;
  body?: string;
  items?: MemoryRecord[];
  validity?: string;
  injection?: { eligible?: boolean; reason?: string };
}

interface ExperiencePage extends ContextPage {}
interface ExperienceDetail {
  available?: boolean;
  reason?: string | null;
  experience_id?: string;
  item?: MemoryRecord;
  text?: string;
}

interface ManifestResult {
  manifest_id?: string;
  status?: string;
  submitted_evidence?: string | null;
  retain_eligible?: boolean;
  retain_ids?: string[];
  receipt_disposition?: string | null;
  manifest_sha256?: string;
  payload_sha256?: string;
  created_at?: number;
}

interface MemoryListPage {
  items?: MemoryRecord[];
  next_cursor?: string | null;
  has_more?: boolean;
}

const RECALL_STATUS: Record<string, string> = {
  ready: '已返回',
  empty: '本次无候选',
  pending: '准备中',
  unavailable: '暂不可用',
  unsupported: '当前不支持',
  disabled: '未启用',
  skipped_no_boundary: '未赶上运行边界',
};

const EVIDENCE: Record<string, string> = {
  host_reported_submitted: '宿主报告已提交',
  gateway_observed_submitted: '网关观察已提交',
  served: '已交付',
};

const HOST_LEVEL: Record<string, string> = {
  tool_only: '仅工具调用',
  api_tool_only: '仅工具调用',
  adapted_host: '已适配宿主',
  controlled_gateway: '受控网关',
};

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bytes(value: unknown): string {
  const size = num(value, 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function time(value: unknown): string {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString('zh-CN') : '';
}

function excerpt(value: unknown, max = 160): string {
  const raw = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

function shortHash(value: unknown): string {
  const raw = text(value);
  return raw.length > 16 ? `${raw.slice(0, 8)}…${raw.slice(-4)}` : raw;
}

function failureText(failure: unknown): string {
  return (failure as McpError)?.message || String(failure);
}

/**
 * Memory 抽屉。
 *
 * 人类身份只显示能力与不支持项；Agent 自身凭据才读取状态和内容工具。
 * 所有正文使用 React 文本节点，召回/上下文/经历与治理数据都以服务端
 * 返回为准，不在前端推断“已注入”或“已清除”。
 */
export function MemoryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useWebSession();
  const token = session.session?.token ?? null;
  const [me, setMe] = useState<MemoryMe | null>(null);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<TabName>('recall');

  const [recallMode, setRecallMode] = useState('lookup');
  const [recallQuery, setRecallQuery] = useState('');
  const [recallEvidence, setRecallEvidence] = useState('');
  const [recall, setRecall] = useState<RecallResult | null>(null);
  const [recallStatus, setRecallStatus] = useState('');

  const [contextKind, setContextKind] = useState('');
  const [contexts, setContexts] = useState<MemoryRecord[]>([]);
  const [contextCursor, setContextCursor] = useState<string | null>(null);
  const [contextMore, setContextMore] = useState(false);
  const [contextDetail, setContextDetail] = useState<(ContextDetail & { id: string }) | null>(null);
  const [contextStatus, setContextStatus] = useState('');

  const [experiences, setExperiences] = useState<MemoryRecord[]>([]);
  const [experienceCursor, setExperienceCursor] = useState<string | null>(null);
  const [experienceMore, setExperienceMore] = useState(false);
  const [experienceDetail, setExperienceDetail] = useState<(ExperienceDetail & { id: string }) | null>(null);
  const [experienceStatus, setExperienceStatus] = useState('');

  const [manifestId, setManifestId] = useState('');
  const [manifest, setManifest] = useState<ManifestResult | null>(null);
  const [manifestStatus, setManifestStatus] = useState('');

  const [curated, setCurated] = useState<MemoryRecord[]>([]);
  const [sources, setSources] = useState<MemoryRecord[]>([]);
  const [sourceCursor, setSourceCursor] = useState<string | null>(null);
  const [sourceMore, setSourceMore] = useState(false);
  const [governanceStatus, setGovernanceStatus] = useState('');
  const [forgetTarget, setForgetTarget] = useState<{
    kind: 'curated' | 'source';
    id: string;
    revision: number;
    label: string;
  } | null>(null);
  const [operation, setOperation] = useState<MemoryRecord | null>(null);

  const catalog = me?.service?.memory ?? null;
  const agentReady = me?.kind === 'agent' && status?.enabled === true;

  const reset = useCallback(() => {
    setMe(null);
    setStatus(null);
    setError('');
    setLoading(false);
    setTab('recall');
    setRecall(null);
    setRecallStatus('');
    setRecallQuery('');
    setRecallEvidence('');
    setContexts([]);
    setContextCursor(null);
    setContextMore(false);
    setContextDetail(null);
    setContextStatus('');
    setExperiences([]);
    setExperienceCursor(null);
    setExperienceMore(false);
    setExperienceDetail(null);
    setExperienceStatus('');
    setManifest(null);
    setManifestId('');
    setManifestStatus('');
    setCurated([]);
    setSources([]);
    setSourceCursor(null);
    setSourceMore(false);
    setGovernanceStatus('');
    setForgetTarget(null);
    setOperation(null);
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const identity = await callTool<MemoryMe>('network_me', {}, { token });
      setMe(identity);
      const memory = identity.service?.memory;
      if (!memory?.enabled || identity.kind !== 'agent') {
        setStatus(null);
        return;
      }
      try {
        const snapshot = await callTool<MemoryStatus>('network_memory_status', {}, { token });
        setStatus(snapshot);
      } catch (failure) {
        setStatus(null);
        setError(failureText(failure));
      }
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    void load();
  }, [load, open, reset]);

  useEffect(() => {
    if (!open || !agentReady) return;
    if (tab === 'context' && contexts.length === 0) void loadContexts(true);
    if (tab === 'experience' && experiences.length === 0) void loadExperiences(true);
    if (tab === 'governance' && curated.length === 0 && sources.length === 0) {
      void loadGovernance();
    }
  }, [open, agentReady, tab]);

  async function loadContexts(resetList: boolean) {
    if (!token) return;
    setContextStatus('正在读取上下文…');
    try {
      const page = await callTool<ContextPage>(
        'network_memory_context_list',
        {
          limit: 20,
          ...(contextKind ? { kind: contextKind } : {}),
          ...(!resetList && contextCursor ? { cursor: contextCursor } : {}),
        },
        { token },
      );
      setContexts((current) => (resetList ? (page.items ?? []) : [...current, ...(page.items ?? [])]));
      setContextCursor(page.next_cursor ?? null);
      setContextMore(Boolean(page.has_more && page.next_cursor));
      setContextStatus('');
    } catch (failure) {
      setContextStatus(`读取上下文失败：${failureText(failure)}`);
    }
  }

  async function openContext(id: string) {
    if (!token) return;
    setContextDetail({ id });
    try {
      const detail = await callTool<ContextDetail>(
        'network_memory_context_get',
        { context_id: id },
        { token },
      );
      setContextDetail({ ...detail, id });
    } catch (failure) {
      setContextDetail({ id, available: false, reason: failureText(failure) });
    }
  }

  async function loadExperiences(resetList: boolean) {
    if (!token) return;
    setExperienceStatus('正在读取经历…');
    try {
      const page = await callTool<ExperiencePage>(
        'network_memory_experience_list',
        {
          limit: 20,
          ...(!resetList && experienceCursor ? { cursor: experienceCursor } : {}),
        },
        { token },
      );
      setExperiences((current) => (resetList ? (page.items ?? []) : [...current, ...(page.items ?? [])]));
      setExperienceCursor(page.next_cursor ?? null);
      setExperienceMore(Boolean(page.has_more && page.next_cursor));
      setExperienceStatus('');
    } catch (failure) {
      setExperienceStatus(`读取经历失败：${failureText(failure)}`);
    }
  }

  async function openExperience(id: string) {
    if (!token) return;
    setExperienceDetail({ id });
    try {
      const detail = await callTool<ExperienceDetail>(
        'network_memory_experience_get',
        { experience_id: id },
        { token },
      );
      setExperienceDetail({ ...detail, id });
    } catch (failure) {
      setExperienceDetail({ id, available: false, reason: failureText(failure) });
    }
  }

  async function submitRecall(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    const query = recallQuery.trim();
    if (!query) {
      setRecallStatus('请输入查询内容。');
      return;
    }
    setRecallStatus('正在召回…');
    try {
      const result = await callTool<RecallResult>(
        'network_memory_recall',
        {
          mode: recallMode,
          query,
          ...(recallEvidence ? { minimum_evidence: recallEvidence } : {}),
        },
        { token },
      );
      setRecall(result);
      setRecallStatus('');
    } catch (failure) {
      setRecallStatus(`召回失败：${failureText(failure)}`);
    }
  }

  async function submitManifest(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    const id = manifestId.trim();
    if (!id) {
      setManifestStatus('请输入 manifest_id。');
      return;
    }
    setManifestStatus('正在读取清单状态…');
    try {
      const result = await callTool<ManifestResult>(
        'network_memory_input_status',
        { manifest_id: id },
        { token },
      );
      setManifest(result);
      setManifestStatus('');
    } catch (failure) {
      setManifestStatus(`读取清单失败：${failureText(failure)}`);
    }
  }

  async function loadGovernance(appendSources = false) {
    if (!token) return;
    setGovernanceStatus('正在读取治理数据…');
    try {
      if (!appendSources) {
        const curatedPage = await callTool<MemoryListPage>(
          'network_memory_list',
          { object_kind: 'curated', limit: 50 },
          { token },
        );
        setCurated(curatedPage.items ?? []);
      }
      const sourcePage = await callTool<MemoryListPage>(
        'network_memory_list',
        {
          object_kind: 'source',
          limit: 20,
          ...(appendSources && sourceCursor ? { cursor: sourceCursor } : {}),
        },
        { token },
      );
      setSources((current) => (appendSources ? [...current, ...(sourcePage.items ?? [])] : (sourcePage.items ?? [])));
      setSourceCursor(sourcePage.next_cursor ?? null);
      setSourceMore(Boolean(sourcePage.has_more && sourcePage.next_cursor));
      setGovernanceStatus('');
    } catch (failure) {
      setGovernanceStatus(`读取治理数据失败：${failureText(failure)}`);
    }
  }

  async function confirmForget() {
    if (!token || !forgetTarget) return;
    setGovernanceStatus('正在提交遗忘请求…');
    try {
      const result = await callTool<MemoryRecord>(
        'network_memory_forget',
        {
          request_id: newRequestId('mem_forget'),
          target:
            forgetTarget.kind === 'curated'
              ? {
                  kind: 'curated',
                  curated_id: forgetTarget.id,
                  revision: forgetTarget.revision,
                }
              : {
                  kind: 'source',
                  source_id: forgetTarget.id,
                  source_revision: forgetTarget.revision,
                },
        },
        { token },
      );
      setOperation(result);
      setForgetTarget(null);
      setGovernanceStatus('遗忘请求已提交；后端清除状态仍需单独确认。');
      await loadGovernance();
    } catch (failure) {
      setGovernanceStatus(`遗忘失败：${failureText(failure)}`);
    }
  }

  const titleCounts = useMemo(() => {
    const counts = status?.counts ?? {};
    return [
      ['待处理作业', counts.jobs_pending ?? 0],
      ['失败作业', counts.jobs_failed ?? 0],
      ['待提炼', counts.retain_pending ?? 0],
      ['就绪上下文', counts.contexts_ready ?? 0],
    ] as const;
  }, [status]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-drawer-overlay" />
        <DialogPrimitive.Content
          id="memory-drawer"
          className="memory-drawer"
          aria-describedby={undefined}
        >
          <div className="memory-card">
            <header className="memory-head">
              <div className="memory-heading">
                <DialogPrimitive.Title asChild>
                  <h2 id="memory-title">记忆</h2>
                </DialogPrimitive.Title>
                <p id="memory-subtitle" className="memory-subtitle">
                  {me ? `${me.name} · ${me.kind === 'agent' ? 'Agent' : '人类'}` : '正在读取身份…'}
                </p>
              </div>
              <button
                id="memory-refresh"
                className="memory-icon-btn"
                type="button"
                aria-label="刷新记忆状态"
                title="刷新"
                onClick={() => void load()}
              >
                ↻
              </button>
              <button
                id="memory-close"
                className="memory-icon-btn"
                type="button"
                aria-label="关闭记忆面板"
                title="关闭"
                onClick={() => onOpenChange(false)}
              >
                ×
              </button>
            </header>
            <p id="memory-status" className="memory-state" role="status" aria-live="polite">
              {loading ? '正在读取身份与 Memory 状态…' : error}
            </p>
            {me ? (
              <div id="memory-body" className="memory-body">
                <section id="memory-capability" className="memory-capability" aria-label="Memory 能力与状态">
                  <div className="memory-capability-head">
                    <h3>Memory 能力</h3>
                    <span className={`memory-chip ${catalog?.enabled ? 'good' : 'danger'}`}>
                      {catalog?.enabled ? '已启用' : '未启用'}
                    </span>
                    {status ? (
                      <span className="memory-chip info">
                        {HOST_LEVEL[status.host_level ?? ''] ?? status.host_level ?? '等级未知'}
                      </span>
                    ) : null}
                  </div>
                  {catalog ? (
                    <>
                      <p>
                        {catalog.reason ||
                          'Memory 结果只是参考数据；lookup 没有注入许可，不能自报 verified/trusted。'}
                      </p>
                      <div className="memory-chip-row">
                        {(catalog.recall_modes ?? []).map((mode) => (
                          <span className="memory-chip info" key={mode}>
                            {mode}
                          </span>
                        ))}
                        {(catalog.unsupported ?? []).map((item) => (
                          <span className="memory-chip warn" key={item}>
                            不支持 · {item}
                          </span>
                        ))}
                      </div>
                      {status ? (
                        <div className="memory-stat-grid">
                          {titleCounts.map(([label, value]) => (
                            <div className="memory-stat" key={label}>
                              <strong>{value}</strong>
                              <span>{label}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {me.kind !== 'agent' ? (
                    <p className="memory-note">Memory 内容工具只对 Agent 自身凭据开放。</p>
                  ) : null}
                </section>
                {agentReady ? (
                  <>
                    <nav id="memory-tabs" className="memory-tabs" aria-label="Memory 视图">
                      {(['recall', 'context', 'experience', 'host', 'governance'] as const).map((name) => (
                        <button
                          key={name}
                          className="memory-tab"
                          type="button"
                          data-memory-tab={name}
                          aria-pressed={tab === name}
                          onClick={() => setTab(name)}
                        >
                          {name === 'recall'
                            ? '召回'
                            : name === 'context'
                              ? '上下文'
                              : name === 'experience'
                                ? '经历'
                                : name === 'host'
                                  ? '宿主'
                                  : '治理'}
                        </button>
                      ))}
                    </nav>
                    <div id="memory-panels" className="memory-panels">
                      <section id="memory-panel-recall" className="memory-panel" hidden={tab !== 'recall'}>
                        <form id="memory-recall-form" className="memory-form" onSubmit={(event) => void submitRecall(event)}>
                          <label className="memory-field">
                            模式
                            <select
                              id="memory-recall-mode"
                              value={recallMode}
                              onChange={(event) => setRecallMode(event.target.value)}
                            >
                              <option value="lookup">lookup · 显式查询</option>
                              <option value="reflect">reflect · 综合分析</option>
                            </select>
                          </label>
                          <label className="memory-field">
                            查询
                            <input
                              id="memory-recall-query"
                              type="text"
                              maxLength={2000}
                              autoComplete="off"
                              placeholder="例如：发布流程或最近的偏好"
                              value={recallQuery}
                              onChange={(event) => setRecallQuery(event.target.value)}
                            />
                          </label>
                          <label className="memory-field">
                            最低证据
                            <select
                              id="memory-recall-evidence"
                              value={recallEvidence}
                              onChange={(event) => setRecallEvidence(event.target.value)}
                            >
                              <option value="">不限</option>
                              <option value="host_reported_submitted">宿主报告已提交</option>
                              <option value="gateway_observed_submitted">网关观察已提交</option>
                            </select>
                          </label>
                          <button className="primary memory-submit" type="submit">
                            召回
                          </button>
                        </form>
                        <p id="memory-recall-status" className="memory-state" role="status">
                          {recallStatus}
                        </p>
                        <div id="memory-recall-result" className="memory-result">
                          {recall ? (
                            <>
                              <div className="memory-chip-row">
                                <span className={`memory-chip ${recall.status === 'ready' ? 'good' : 'warn'}`}>
                                  {RECALL_STATUS[recall.status ?? ''] ?? recall.status}
                                </span>
                                <span className="memory-chip info">覆盖 {recall.coverage ?? '未知'}</span>
                                <span className={`memory-chip ${recall.evidence_complete ? 'good' : 'warn'}`}>
                                  {recall.evidence_complete ? '证据完整' : '证据不完整'}
                                </span>
                              </div>
                              {recall.budget_used ? (
                                <p className="memory-detail-meta">
                                  候选 {recall.budget_used.candidates ?? 0} 条 · 打包{' '}
                                  {bytes(recall.budget_used.packaged_bytes)}
                                  {recall.budget_used.truncated ? ' · 已截断' : ''}
                                </p>
                              ) : null}
                              {(recall.items ?? []).map((item, index) => (
                                <MemoryRow key={`recall-${index}`} item={item} />
                              ))}
                            </>
                          ) : null}
                        </div>
                      </section>

                      <section id="memory-panel-context" className="memory-panel" hidden={tab !== 'context'}>
                        <div className="memory-toolbar">
                          <label className="memory-field">
                            类型
                            <select value={contextKind} onChange={(event) => setContextKind(event.target.value)}>
                              <option value="">全部</option>
                              <option value="lookup">lookup</option>
                              <option value="bound">bound</option>
                            </select>
                          </label>
                          <button className="memory-small-btn" type="button" onClick={() => void loadContexts(true)}>
                            刷新
                          </button>
                        </div>
                        <p id="memory-context-status" className="memory-state" role="status">
                          {contextStatus}
                        </p>
                        <div id="memory-context-list" className="memory-list" role="list">
                          {contexts.map((item, index) => (
                            <div className="memory-list-item" role="listitem" key={text(item.context_id, String(index))}>
                              <button
                                className="memory-row"
                                type="button"
                                onClick={() => void openContext(text(item.context_id))}
                              >
                                <span className="memory-row-title">
                                  {text(item.context_id, '上下文')}
                                </span>
                                <span className="memory-chip info">{text(item.kind, '类型未知')}</span>
                                <span className="memory-row-meta">
                                  有效性 {text(item.validity, '未知')} · 创建 {time(item.created_at)}
                                </span>
                              </button>
                            </div>
                          ))}
                        </div>
                        {contextMore ? (
                          <button
                            id="memory-context-more"
                            className="memory-page-btn"
                            type="button"
                            onClick={() => void loadContexts(false)}
                          >
                            加载更多
                          </button>
                        ) : null}
                        {contextDetail ? (
                          <div id="memory-context-detail" className="memory-detail">
                            <h3>上下文详情</h3>
                            {contextDetail.available === false ? (
                              <p className="memory-note">
                                当前不可读：{contextDetail.reason || '原因未知'}
                              </p>
                            ) : (
                              <>
                                <p className="memory-detail-meta">
                                  {contextDetail.kind ?? '类型未知'} · 有效性{' '}
                                  {contextDetail.validity ?? '未知'}
                                </p>
                                <pre className="memory-body-text">{contextDetail.body}</pre>
                              </>
                            )}
                          </div>
                        ) : null}
                      </section>

                      <section id="memory-panel-experience" className="memory-panel" hidden={tab !== 'experience'}>
                        <div className="memory-toolbar">
                          <button
                            id="memory-experience-refresh"
                            className="memory-small-btn"
                            type="button"
                            onClick={() => void loadExperiences(true)}
                          >
                            刷新
                          </button>
                        </div>
                        <p id="memory-experience-status" className="memory-state" role="status">
                          {experienceStatus}
                        </p>
                        <div id="memory-experience-list" className="memory-list" role="list">
                          {experiences.map((item, index) => (
                            <div className="memory-list-item" role="listitem" key={text(item.experience_id, String(index))}>
                              <button
                                className="memory-row"
                                type="button"
                                onClick={() => void openExperience(text(item.experience_id))}
                              >
                                <span className="memory-row-title">
                                  {text(item.summary, text(item.experience_id, '经历'))}
                                </span>
                                <span className="memory-row-meta">
                                  {text(item.origin_kind, '来源未知')} · {time(item.created_at)}
                                </span>
                              </button>
                            </div>
                          ))}
                        </div>
                        {experienceMore ? (
                          <button
                            id="memory-experience-more"
                            className="memory-page-btn"
                            type="button"
                            onClick={() => void loadExperiences(false)}
                          >
                            加载更多
                          </button>
                        ) : null}
                        {experienceDetail ? (
                          <div id="memory-experience-detail" className="memory-detail">
                            <h3>经历详情</h3>
                            {experienceDetail.available === false ? (
                              <p className="memory-note">
                                当前不可读：{experienceDetail.reason || '原因未知'}
                              </p>
                            ) : (
                              <pre className="memory-body-text">{experienceDetail.text}</pre>
                            )}
                          </div>
                        ) : null}
                      </section>

                      <section id="memory-panel-host" className="memory-panel" hidden={tab !== 'host'}>
                        <div id="memory-host-info" className="memory-host-info">
                          <p className="memory-note">
                            宿主绑定由已鉴权宿主会话创建；本面板只展示服务端等级与清单状态，
                            不会代替宿主声明可信、已注入或已提交。
                          </p>
                        </div>
                        <form id="memory-manifest-form" className="memory-form" onSubmit={(event) => void submitManifest(event)}>
                          <label className="memory-field">
                            manifest_id
                            <input
                              id="memory-manifest-id"
                              type="text"
                              maxLength={128}
                              autoComplete="off"
                              placeholder="宿主提交清单后返回的 manifest_id"
                              value={manifestId}
                              onChange={(event) => setManifestId(event.target.value)}
                            />
                          </label>
                          <button className="primary memory-submit" type="submit">
                            查询清单状态
                          </button>
                        </form>
                        <p id="memory-manifest-status" className="memory-state" role="status">
                          {manifestStatus}
                        </p>
                        <div id="memory-manifest-result" className="memory-result">
                          {manifest ? (
                            <div className="memory-detail">
                              <div className="memory-detail-head">
                                <h3>提交清单状态</h3>
                                <span className="memory-chip info">{manifest.status}</span>
                              </div>
                              <dl>
                                <dt>提交证据</dt>
                                <dd>{manifest.submitted_evidence ?? '无'}</dd>
                                <dt>可提炼资格</dt>
                                <dd>{manifest.retain_eligible ? '是' : '否'}</dd>
                                <dt>清单 hash</dt>
                                <dd>{shortHash(manifest.manifest_sha256)}</dd>
                                <dt>payload hash</dt>
                                <dd>{shortHash(manifest.payload_sha256)}</dd>
                                <dt>创建时间</dt>
                                <dd>{time(manifest.created_at)}</dd>
                              </dl>
                              <p className="memory-note">
                                prepared 与宿主排队不是提交证据；retain_eligible 只由服务端采纳合格回执后更新。
                              </p>
                            </div>
                          ) : null}
                        </div>
                      </section>

                      <section id="memory-panel-governance" className="memory-panel" hidden={tab !== 'governance'}>
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
                                <button className="memory-action" type="button" onClick={() => setForgetTarget(null)}>
                                  取消
                                </button>
                                <button className="memory-action danger" type="button" onClick={() => void confirmForget()}>
                                  确认遗忘
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                        <section className="memory-block" aria-labelledby="memory-curated-title">
                          <div className="memory-block-head">
                            <h3 id="memory-curated-title">人工记忆</h3>
                            <button className="memory-small-btn" type="button" onClick={() => void loadGovernance()}>
                              刷新
                            </button>
                          </div>
                          <p className="memory-note">人工保存只代表明确写入，不是群消息阅读证明。</p>
                          <div id="memory-curated-list" className="memory-list" role="list">
                            {curated.map((item, index) => (
                              <div className="memory-list-item" role="listitem" key={text(item.curated_id, String(index))}>
                                <div className="memory-row memory-row-static">
                                  <span className="memory-row-title">{text(item.title, '未命名人工记忆')}</span>
                                  <span className="memory-chip info">修订 {num(item.revision)}</span>
                                  <p className="memory-row-meta">
                                    {text(item.origin, '人工保存')} · 更新 {time(item.updated_at)}
                                  </p>
                                  <p className="memory-row-preview">{excerpt(item.content)}</p>
                                  <div className="memory-row-actions">
                                    <button
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
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </section>
                        <section className="memory-block" aria-labelledby="memory-source-title">
                          <div className="memory-block-head">
                            <h3 id="memory-source-title">来源</h3>
                          </div>
                          <p className="memory-note">
                            来源只包含该 Agent 实际获得过的消息/文件；遗忘会先从本地排除，
                            后端清除无法确认时保持未知。
                          </p>
                          <div id="memory-source-list" className="memory-list" role="list">
                            {sources.map((item, index) => (
                              <div className="memory-list-item" role="listitem" key={text(item.source_id, String(index))}>
                                <div className="memory-row memory-row-static">
                                  <span className="memory-row-title">
                                    来源 · {text(item.source_kind, '未知')}
                                  </span>
                                  <span className="memory-chip info">修订 {num(item.revision)}</span>
                                  <span className={`memory-chip ${item.state === 'active' ? 'good' : 'warn'}`}>
                                    {text(item.state, '未知')}
                                  </span>
                                  <p className="memory-row-meta">
                                    {text(item.origin_room_id, '无房间')} · 创建 {time(item.created_at)}
                                  </p>
                                  {item.available === true ? (
                                    <div className="memory-row-actions">
                                      <button
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
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>
                          {sourceMore ? (
                            <button
                              id="memory-source-more"
                              className="memory-page-btn"
                              type="button"
                              onClick={() => void loadGovernance(true)}
                            >
                              加载更多来源
                            </button>
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
                      </section>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** 召回候选的通用行：只渲染服务端返回的字段，不推断可信度。 */
function MemoryRow({ item }: { item: MemoryRecord }) {
  const representation = (item.representation ?? {}) as MemoryRecord;
  const source = (item.source ?? {}) as MemoryRecord;
  return (
    <div className="memory-row memory-row-static">
      <div className="memory-row-top">
        <span className="memory-chip info">{text(item.origin_kind, '来源未知')}</span>
        <span className="memory-chip info">{text(representation.kind, '表示未知')}</span>
        {text(item.evidence) ? (
          <span className="memory-chip good">{EVIDENCE[text(item.evidence)] ?? text(item.evidence)}</span>
        ) : null}
      </div>
      <p className="memory-row-meta">
        {representation.text_bytes !== undefined ? bytes(representation.text_bytes) : ''}
        {source.source_revision !== undefined ? ` · 来源修订 ${num(source.source_revision)}` : ''}
        {typeof item.score === 'number' ? ` · 排序分 ${item.score.toFixed(3)}（非可信度）` : ''}
      </p>
      {item.preview || item.text ? (
        <p className="memory-row-preview">{excerpt(item.preview ?? item.text)}</p>
      ) : null}
    </div>
  );
}
