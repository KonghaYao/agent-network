import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { useWebSession } from '../../hooks/useWebSession';
import { callTool } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';
import { failureText, type MemoryRecord } from './memory-format';
import type {
  ContextDetail,
  ContextPage,
  ExperienceDetail,
  ExperiencePage,
  ManifestResult,
  MemoryListPage,
  MemoryMe,
  MemoryStatus,
  RecallResult,
  TabName,
} from './memory-panel-types';

/**
 * Memory 抽屉的状态、查询与表单动作的唯一 owner。
 *
 * 拆分自 `MemoryDialog`，请求时机、分页游标、重置范围与 tab 懒加载条件
 * 保持原样；展示组件只读取这里的状态并调用动作。
 */
export function useMemoryPanelController({ open }: { open: boolean }) {
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

  return {
    me,
    status,
    loading,
    error,
    tab,
    setTab,
    catalog,
    agentReady,
    recallMode,
    setRecallMode,
    recallQuery,
    setRecallQuery,
    recallEvidence,
    setRecallEvidence,
    recall,
    recallStatus,
    submitRecall,
    contextKind,
    setContextKind,
    contexts,
    contextStatus,
    contextMore,
    contextDetail,
    loadContexts,
    openContext,
    experiences,
    experienceStatus,
    experienceMore,
    experienceDetail,
    loadExperiences,
    openExperience,
    manifestId,
    setManifestId,
    manifest,
    manifestStatus,
    submitManifest,
    curated,
    sources,
    sourceMore,
    governanceStatus,
    forgetTarget,
    setForgetTarget,
    operation,
    loadGovernance,
    confirmForget,
    load,
  };
}

export type MemoryPanelController = ReturnType<typeof useMemoryPanelController>;
