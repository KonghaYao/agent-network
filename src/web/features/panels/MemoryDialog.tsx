import { Button } from '../../app/lenso-controls';
import { Tabs } from '../../app/lenso-tabs';
import * as DialogPrimitive from '@radix-ui/react-dialog';

import { MemoryCapabilitySection } from './MemoryCapabilitySection';
import { MemoryContextPanel } from './MemoryContextPanel';
import { MemoryExperiencePanel } from './MemoryExperiencePanel';
import { MemoryGovernancePanel } from './MemoryGovernancePanel';
import { MemoryHostPanel } from './MemoryHostPanel';
import { MemoryRecallPanel } from './MemoryRecallPanel';
import { useMemoryPanelController } from './useMemoryPanelController';
import type { TabName } from './memory-panel-types';

const TAB_LABELS: readonly (readonly [TabName, string])[] = [
  ['recall', '召回'],
  ['context', '上下文'],
  ['experience', '经历'],
  ['host', '宿主'],
  ['governance', '治理'],
];

/**
 * Memory 抽屉。
 *
 * 人类身份只显示能力与不支持项；Agent 自身凭据才读取状态和内容工具。
 * 所有正文使用 React 文本节点，召回/上下文/经历与治理数据都以服务端
 * 返回为准，不在前端推断“已注入”或“已清除”。
 */
export function MemoryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const controller = useMemoryPanelController({ open });
  const { me, status, loading, error, tab, setTab, catalog, agentReady, load } = controller;

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
              <Button
                id="memory-refresh"
                className="memory-icon-btn"
                type="button"
                aria-label="刷新记忆状态"
                title="刷新"
                style={{ width: 44, height: 44, padding: 0, borderRadius: 8, fontSize: 20 }}
                onClick={() => void load()}
              >
                ↻
              </Button>
              <Button
                id="memory-close"
                className="memory-icon-btn"
                type="button"
                aria-label="关闭记忆面板"
                title="关闭"
                style={{ width: 44, height: 44, padding: 0, borderRadius: 8, fontSize: 20 }}
                onClick={() => onOpenChange(false)}
              >
                ×
              </Button>
            </header>
            <p id="memory-status" className="memory-state" role="status" aria-live="polite">
              {loading ? '正在读取身份与 Memory 状态…' : error}
            </p>
            {me ? (
              <div id="memory-body" className="memory-body">
                <MemoryCapabilitySection me={me} catalog={catalog} status={status} />
                {agentReady ? (
                  <Tabs value={tab} onValueChange={(next) => setTab(next as TabName)}>
                    <div id="memory-tabs" className="memory-tabs">
                      <Tabs.List
                        aria-label="Memory 视图"
                        xstyle={{
                          display: 'flex',
                          width: '100%',
                          flexWrap: 'wrap',
                          gap: 4,
                          padding: 0,
                          borderRadius: 0,
                          background: 'transparent',
                        }}
                      >
                        {TAB_LABELS.map(([name, label]) => (
                          <Tabs.Tab
                            key={name}
                            value={name}
                            className="memory-tab"
                            data-memory-tab={name}
                          >
                            {label}
                          </Tabs.Tab>
                        ))}
                      </Tabs.List>
                    </div>
                    <div id="memory-panels" className="memory-panels">
                      <Tabs.Panel value="recall" id="memory-panel-recall" className="memory-panel" style={{ padding: '12px 14px calc(22px + env(safe-area-inset-bottom))' }}>
                        <MemoryRecallPanel
                          recallMode={controller.recallMode}
                          setRecallMode={controller.setRecallMode}
                          recallQuery={controller.recallQuery}
                          setRecallQuery={controller.setRecallQuery}
                          recallEvidence={controller.recallEvidence}
                          setRecallEvidence={controller.setRecallEvidence}
                          recall={controller.recall}
                          recallStatus={controller.recallStatus}
                          submitRecall={controller.submitRecall}
                        />
                      </Tabs.Panel>

                      <Tabs.Panel value="context" id="memory-panel-context" className="memory-panel" style={{ padding: '12px 14px calc(22px + env(safe-area-inset-bottom))' }}>
                        <MemoryContextPanel
                          contextKind={controller.contextKind}
                          setContextKind={controller.setContextKind}
                          contexts={controller.contexts}
                          contextStatus={controller.contextStatus}
                          contextMore={controller.contextMore}
                          contextDetail={controller.contextDetail}
                          loadContexts={controller.loadContexts}
                          openContext={controller.openContext}
                        />
                      </Tabs.Panel>

                      <Tabs.Panel value="experience" id="memory-panel-experience" className="memory-panel" style={{ padding: '12px 14px calc(22px + env(safe-area-inset-bottom))' }}>
                        <MemoryExperiencePanel
                          experiences={controller.experiences}
                          experienceStatus={controller.experienceStatus}
                          experienceMore={controller.experienceMore}
                          experienceDetail={controller.experienceDetail}
                          loadExperiences={controller.loadExperiences}
                          openExperience={controller.openExperience}
                        />
                      </Tabs.Panel>

                      <Tabs.Panel value="host" id="memory-panel-host" className="memory-panel" style={{ padding: '12px 14px calc(22px + env(safe-area-inset-bottom))' }}>
                        <MemoryHostPanel
                          manifestId={controller.manifestId}
                          setManifestId={controller.setManifestId}
                          manifest={controller.manifest}
                          manifestStatus={controller.manifestStatus}
                          submitManifest={controller.submitManifest}
                        />
                      </Tabs.Panel>

                      <Tabs.Panel value="governance" id="memory-panel-governance" className="memory-panel" style={{ padding: '12px 14px calc(22px + env(safe-area-inset-bottom))' }}>
                        <MemoryGovernancePanel
                          governanceStatus={controller.governanceStatus}
                          forgetTarget={controller.forgetTarget}
                          setForgetTarget={controller.setForgetTarget}
                          operation={controller.operation}
                          curated={controller.curated}
                          sources={controller.sources}
                          sourceMore={controller.sourceMore}
                          loadGovernance={controller.loadGovernance}
                          confirmForget={controller.confirmForget}
                        />
                      </Tabs.Panel>
                    </div>
                  </Tabs>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
