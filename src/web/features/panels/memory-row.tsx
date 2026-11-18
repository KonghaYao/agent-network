import { Chip } from '../../app/lenso-controls';
import type { ReactNode } from 'react';

import {
  bytes,
  EVIDENCE,
  excerpt,
  num,
  text,
  type MemoryRecord,
} from './memory-format';

const CHIP_TONE = { good: 'success', warn: 'warning', danger: 'danger', info: 'accent' } as const;

export function MemoryChip({
  tone = 'info',
  children,
}: {
  tone?: keyof typeof CHIP_TONE;
  children: ReactNode;
}) {
  return (
    <span className={`memory-chip ${tone}`}>
      <Chip variant="soft" color={CHIP_TONE[tone]}>
        {children}
      </Chip>
    </span>
  );
}

/** 召回候选的通用行：只渲染服务端返回的字段，不推断可信度。 */
export function MemoryRow({ item }: { item: MemoryRecord }) {
  const representation = (item.representation ?? {}) as MemoryRecord;
  const source = (item.source ?? {}) as MemoryRecord;
  return (
    <div className="memory-row memory-row-static">
      <div className="memory-row-top">
        <MemoryChip>{text(item.origin_kind, '来源未知')}</MemoryChip>
        <MemoryChip>{text(representation.kind, '表示未知')}</MemoryChip>
        {text(item.evidence) ? (
          <MemoryChip tone="good">{EVIDENCE[text(item.evidence)] ?? text(item.evidence)}</MemoryChip>
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
