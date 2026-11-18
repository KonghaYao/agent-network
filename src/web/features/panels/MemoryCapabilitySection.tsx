import { Badge, Card } from '../../app/lenso-controls';
import { useMemo } from 'react';

import { MemoryChip } from './memory-row';
import type { MemoryCatalog, MemoryMe, MemoryStatus } from './memory-panel-types';

const HOST_LEVEL: Record<string, string> = {
  tool_only: '仅工具调用',
  api_tool_only: '仅工具调用',
  adapted_host: '已适配宿主',
  controlled_gateway: '受控网关',
};

export function MemoryCapabilitySection({
  me,
  catalog,
  status,
}: {
  me: MemoryMe;
  catalog: MemoryCatalog | null;
  status: MemoryStatus | null;
}) {
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
    <section id="memory-capability" className="memory-capability" aria-label="Memory 能力与状态">
      <div className="memory-capability-head">
        <h3>Memory 能力</h3>
        {/* Lenso Badge 的 className 会被 StyleX 覆盖，且默认 placement 是绝对定位；
            用原生 chip 承载本地样式，内联 style 取消 top-right 定位。 */}
        <span
          className={`memory-chip ${catalog?.enabled ? 'good' : 'danger'}`}
          style={{ position: 'relative' }}
        >
          <Badge
            size="sm"
            variant="soft"
            color={catalog?.enabled ? 'success' : 'danger'}
            style={{ position: 'static', top: 'auto', right: 'auto', transform: 'none' }}
          >
            {catalog?.enabled ? '已启用' : '未启用'}
          </Badge>
        </span>
        {status ? (
          <MemoryChip>
            {HOST_LEVEL[status.host_level ?? ''] ?? status.host_level ?? '等级未知'}
          </MemoryChip>
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
              <MemoryChip key={mode}>{mode}</MemoryChip>
            ))}
            {(catalog.unsupported ?? []).map((item) => (
              <MemoryChip key={item} tone="warn">
                不支持 · {item}
              </MemoryChip>
            ))}
          </div>
          {status ? (
            <div className="memory-stat-grid">
              {titleCounts.map(([label, value]) => (
                <div className="memory-stat" key={label}>
                  <Card
                    variant="transparent"
                    style={{ padding: 0, gap: 0, borderRadius: 0, boxShadow: 'none', minWidth: 0 }}
                  >
                    <strong>{value}</strong>
                    <span>{label}</span>
                  </Card>
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
  );
}
