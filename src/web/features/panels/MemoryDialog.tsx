import { Tooltip } from '../../app/lenso-tooltip';
import { Button } from '../../app/lenso-controls';
import { Tabs } from '../../app/lenso-tabs';
import {
  LensoBackendProvider,
  useBackendLease,
  useLenso,
  useLensoBackendScope,
} from '../../app/lenso-runtime';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, useRef, type MutableRefObject, type ReactNode } from 'react';

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

type MemoryShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
};

function MemoryShell({ open, onOpenChange, children }: MemoryShellProps) {
  const backend = useBackendLease(open);
  const lenso = useLenso();
  const restoreFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  if (open && !wasOpen.current) {
    const active = document.activeElement;
    restoreFocus.current = active instanceof HTMLElement ? active : null;
  }
  wasOpen.current = open;

  useEffect(() => {
    if (open) return;
    const target = restoreFocus.current;
    if (!target?.isConnected) return;
    queueMicrotask(() => {
      if (!document.querySelector('[role="dialog"], [role="alertdialog"]')) target.focus();
    });
  }, [open]);

  return (
    <LensoBackendProvider backend={backend}>
      {backend === 'lenso' && lenso ? (
        <LensoMemoryShell
          open={open}
          onOpenChange={onOpenChange}
          children={children}
          drawer={lenso.Drawer}
          restoreFocus={restoreFocus}
        />
      ) : (
        <RadixMemoryShell
          open={open}
          onOpenChange={onOpenChange}
          restoreFocus={restoreFocus}
        >
          {children}
        </RadixMemoryShell>
      )}
    </LensoBackendProvider>
  );
}

function RadixMemoryShell({ open, onOpenChange, children, restoreFocus }: MemoryShellProps & {
  restoreFocus: MutableRefObject<HTMLElement | null>;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-drawer-overlay" />
        <DialogPrimitive.Content
          id="memory-drawer"
          className="memory-drawer"
          aria-labelledby="memory-title"
          aria-describedby={undefined}
          data-memory-shell="radix"
          onOpenAutoFocus={(event) => {
            restoreFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : restoreFocus.current;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus.current?.focus();
          }}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function LensoMemoryShell({
  open,
  onOpenChange,
  children,
  drawer: Drawer,
  restoreFocus,
}: MemoryShellProps & {
  drawer: NonNullable<ReturnType<typeof useLenso>>['Drawer'];
  restoreFocus: MutableRefObject<HTMLElement | null>;
}) {
  return (
    <Drawer.Root
      open={open}
      modal
      side="end"
      closeOnOutsidePress
      onOpenChange={(next) => onOpenChange(next)}
    >
      <Drawer.Backdrop
        variant="opaque"
        render={(props) => <div {...props} className={`${String(props.className ?? '')} spa-drawer-overlay`.trim()} />}
      />
      <Drawer.Content
        id="memory-drawer"
        aria-labelledby="memory-title"
        aria-describedby={undefined}
        data-memory-shell="lenso"
        initialFocus="auto"
        finalFocus={() => restoreFocus.current}
        style={{ width: 'min(480px, 100vw)', maxWidth: '100vw' }}
        render={(props) => <div {...props} className={`${String(props.className ?? '')} memory-drawer`.trim()} />}
      >
        {children}
      </Drawer.Content>
    </Drawer.Root>
  );
}

function MemoryTitle({ children }: { children: ReactNode }) {
  const lenso = useLenso();
  const backend = useLensoBackendScope();
  return lenso && backend === 'lenso' ? (
    <lenso.Drawer.Title id="memory-title" render={(props) => <h2 {...props}>{children}</h2>} />
  ) : (
    <DialogPrimitive.Title asChild>
      <h2 id="memory-title">{children}</h2>
    </DialogPrimitive.Title>
  );
}

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
    <MemoryShell open={open} onOpenChange={onOpenChange}>
      <div className="memory-card">
        <header className="memory-head">
          <div className="memory-heading">
            <MemoryTitle>记忆</MemoryTitle>
            <p id="memory-subtitle" className="memory-subtitle">
              {me ? `${me.name} · ${me.kind === 'agent' ? 'Agent' : '人类'}` : '正在读取身份…'}
            </p>
          </div>
          <Tooltip as={Button}
            id="memory-refresh"
            className="memory-icon-btn"
            type="button"
            aria-label="刷新记忆状态"
            hint="刷新"
            style={{ width: 44, height: 44, padding: 0, borderRadius: 8, fontSize: 20 }}
            onClick={() => void load()}
          >
            ↻
          </Tooltip>
          <Tooltip as={Button}
            id="memory-close"
            className="memory-icon-btn"
            type="button"
            aria-label="关闭记忆面板"
            hint="关闭"
            style={{ width: 44, height: 44, padding: 0, borderRadius: 8, fontSize: 20 }}
            onClick={() => onOpenChange(false)}
          >
            ×
          </Tooltip>
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
        </MemoryShell>
  );
}
