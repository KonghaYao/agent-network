import { Button, Input, Label, Select } from '../../app/lenso-controls';
import { RECALL_EVIDENCE_OPTIONS, RECALL_MODE_OPTIONS } from './memory-select-options';
import { MemoryChip, MemoryRow } from './memory-row';
import { bytes } from './memory-format';
import type { MemoryPanelController } from './useMemoryPanelController';

const RECALL_STATUS: Record<string, string> = {
  ready: '已返回',
  empty: '本次无候选',
  pending: '准备中',
  unavailable: '暂不可用',
  unsupported: '当前不支持',
  disabled: '未启用',
  skipped_no_boundary: '未赶上运行边界',
};

type Props = Pick<
  MemoryPanelController,
  | 'recallMode'
  | 'setRecallMode'
  | 'recallQuery'
  | 'setRecallQuery'
  | 'recallEvidence'
  | 'setRecallEvidence'
  | 'recall'
  | 'recallStatus'
  | 'submitRecall'
>;

export function MemoryRecallPanel({
  recallMode,
  setRecallMode,
  recallQuery,
  setRecallQuery,
  recallEvidence,
  setRecallEvidence,
  recall,
  recallStatus,
  submitRecall,
}: Props) {
  return (
    <>
      <form id="memory-recall-form" className="memory-form" onSubmit={(event) => void submitRecall(event)}>
        <div className="memory-field">
          <span>模式</span>
          <Select
            id="memory-recall-mode"
            aria-label="召回模式"
            value={recallMode}
            options={RECALL_MODE_OPTIONS}
            onChange={setRecallMode}
          />
        </div>
        <div className="memory-field">
          <Label htmlFor="memory-recall-query">查询</Label>
          <Input
            id="memory-recall-query"
            type="text"
            maxLength={2000}
            autoComplete="off"
            placeholder="例如：发布流程或最近的偏好"
            value={recallQuery}
            onChange={(event) => setRecallQuery(event.target.value)}
          />
        </div>
        <div className="memory-field">
          <span>最低证据</span>
          <Select
            id="memory-recall-evidence"
            aria-label="最低证据"
            value={recallEvidence}
            options={RECALL_EVIDENCE_OPTIONS}
            onChange={setRecallEvidence}
          />
        </div>
        <Button className="primary memory-submit" type="submit">
          召回
        </Button>
      </form>
      <p id="memory-recall-status" className="memory-state" role="status">
        {recallStatus}
      </p>
      <div id="memory-recall-result" className="memory-result">
        {recall ? (
          <>
            <div className="memory-chip-row">
              <MemoryChip tone={recall.status === 'ready' ? 'good' : 'warn'}>
                {RECALL_STATUS[recall.status ?? ''] ?? recall.status}
              </MemoryChip>
              <MemoryChip>覆盖 {recall.coverage ?? '未知'}</MemoryChip>
              <MemoryChip tone={recall.evidence_complete ? 'good' : 'warn'}>
                {recall.evidence_complete ? '证据完整' : '证据不完整'}
              </MemoryChip>
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
    </>
  );
}
