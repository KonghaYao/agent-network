/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/resources/memory/web/pages/hindsight/components/data-view-timeline.tsx
 * Modified for Agent Network: 平台导入替换；渲染结构不变。
 * 阶段 4：分组改为消费同一次 graph 响应里的 `timeline.groups`（year/month/week/day），
 * 粒度切换只切本地索引、不再按 `occurred_start` 重新分组；组顺序沿用服务端的倒序。
 */

import { Tooltip } from '../../../../app/lenso-tooltip';
import { EmptyState } from "../ui/empty-state";
import { Button } from "../ui/button";
import { NS } from "../i18n";
import { Calendar, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ZoomIn, ZoomOut } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "../i18n";
import { maskSecrets } from '../../mask';
import type { GraphApiData, MemoryTableRow, MemoryTimelineGroup } from "../types";

/**
 * `DataView` 的时间线视图：按粒度（年 / 月 / 周 / 日）分组的记忆条目流，带缩放与组间跳转。
 *
 * 分组由服务端在同一次 `network_agent_memory_graph` 响应里给出（`timeline.groups`），
 * `start_index`/`end_index` 指向 `table_rows`。粒度切换、组间导航都只读本地数据，不发请求。
 */
type Granularity = "year" | "month" | "week" | "day";

export interface DataViewTimelineProps {
  _data: GraphApiData;
  filteredRows: MemoryTableRow[];
  onMemoryClick: (id: string) => void;
}

function rowTime(row: MemoryTableRow): string | null {
  return row.occurred_start ?? row.occurred_at ?? row.mentioned_at ?? null;
}

export function DataViewTimeline({ _data, filteredRows, onMemoryClick }: DataViewTimelineProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [currentIndex, setCurrentIndex] = useState(0);

  const timeline = _data.timeline;
  const undated = timeline?.summary?.undated ?? 0;

  const timelineGroups = useMemo(() => {
    const groups: MemoryTimelineGroup[] = timeline?.groups?.[granularity] ?? [];
    return groups
      .map((group) => ({
        key: group.key,
        label: group.label,
        items: filteredRows.slice(group.start_index, group.end_index),
      }))
      .filter((group) => group.items.length > 0);
  }, [timeline, granularity, filteredRows]);

  const totalItems = timelineGroups.reduce((total, group) => total + group.items.length, 0);
  const activeIndex = Math.min(currentIndex, Math.max(timelineGroups.length - 1, 0));

  const scrollToGroup = (index: number) => {
    const clampedIndex = Math.max(0, Math.min(index, timelineGroups.length - 1));
    setCurrentIndex(clampedIndex);
    const element = document.getElementById(`timeline-group-${clampedIndex}`);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const changeGranularity = (next: Granularity) => {
    setGranularity(next);
    setCurrentIndex(0);
  };

  const zoomIn = () => {
    const levels: Granularity[] = ["year", "month", "week", "day"];
    const currentIdx = levels.indexOf(granularity);
    if (currentIdx < levels.length - 1) {
      changeGranularity(levels[currentIdx + 1]!);
    }
  };

  const zoomOut = () => {
    const levels: Granularity[] = ["year", "month", "week", "day"];
    const currentIdx = levels.indexOf(granularity);
    if (currentIdx > 0) {
      changeGranularity(levels[currentIdx - 1]!);
    }
  };

  if (timelineGroups.length === 0) {
    return (
      <EmptyState
        className="py-12"
        icon={<Calendar />}
        title={t("dataView.noTimelineData")}
        description={
          undated > 0
            ? t("dataView.memoriesWithoutDatesInTable", { count: undated })
            : t("dataView.noTimelineDataDescription")
        }
      />
    );
  }

  const granularityLabels: Record<Granularity, string> = {
    year: t("dataView.granularityYear"),
    month: t("dataView.granularityMonth"),
    week: t("dataView.granularityWeek"),
    day: t("dataView.granularityDay"),
  };

  return (
    <div className="flex h-full min-h-0 flex-col px-4">
      {/* 控制栏 */}
      <div className="flex shrink-0 items-center justify-between mb-3 gap-4">
        <div className="text-xs text-muted-foreground">
          {t("dataView.timelineMemoriesCount", { count: totalItems })}
          {undated > 0 && ` ${t("dataView.timelineWithoutDates", { count: undated })}`}
        </div>

        <div className="flex items-center gap-1">
          {/* 缩放 */}
          <div className="flex items-center border border-border rounded mr-2">
            <Tooltip as={Button}
              variant="secondary"
              size="sm"
              onClick={zoomOut}
              disabled={granularity === "year"}
              className="h-7 w-7 p-0"
              hint={t("dataView.zoomOut")}
              aria-label={t("dataView.zoomOut")}
            >
              <ZoomOut className="h-3 w-3" />
            </Tooltip>
            <span className="text-3xs px-2 min-w-12.5 text-center border-x border-border text-foreground">
              {granularityLabels[granularity]}
            </span>
            <Tooltip as={Button}
              variant="secondary"
              size="sm"
              onClick={zoomIn}
              disabled={granularity === "day"}
              className="h-7 w-7 p-0"
              hint={t("dataView.zoomIn")}
              aria-label={t("dataView.zoomIn")}
            >
              <ZoomIn className="h-3 w-3" />
            </Tooltip>
          </div>

          {/* 导航 */}
          <div className="flex items-center border border-border rounded">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(0)}
              disabled={timelineGroups.length <= 1}
              className="h-7 w-7 p-0"
              aria-label={t("dataView.first")}
            >
              <ChevronsLeft className="h-3 w-3" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(activeIndex - 1)}
              disabled={activeIndex === 0}
              className="h-7 w-7 p-0"
              aria-label={t("dataView.previous")}
            >
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <span className="text-3xs px-2 min-w-15 text-center border-x border-border text-foreground">
              {activeIndex + 1} / {timelineGroups.length}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(activeIndex + 1)}
              disabled={activeIndex >= timelineGroups.length - 1}
              className="h-7 w-7 p-0"
              aria-label={t("dataView.next")}
            >
              <ChevronRight className="h-3 w-3" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(timelineGroups.length - 1)}
              disabled={timelineGroups.length <= 1}
              className="h-7 w-7 p-0"
              aria-label={t("dataView.last")}
            >
              <ChevronsRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      {/* 时间线条目 */}
      <div className="relative min-h-0 flex-1 overflow-y-auto pr-2">
        <div className="absolute left-15 top-0 bottom-0 w-0.5 bg-border" />
        {timelineGroups.map((group, groupIdx) => (
          <div key={group.key} id={`timeline-group-${groupIdx}`} className="mb-4">
            {/* 分组头 */}
            <div
              className="flex items-center mb-2 cursor-pointer hover:opacity-80"
              onClick={() => setCurrentIndex(groupIdx)}
            >
              <div className="w-15 text-right pr-3">
                <span className="text-xs font-semibold text-primary">{group.label}</span>
              </div>
              <div className="w-2 h-2 rounded-full bg-primary z-10" />
              <span className="ml-2 text-3xs text-muted-foreground">
                {group.items.length}{" "}
                {group.items.length === 1 ? t("dataView.timelineItem") : t("dataView.timelineItems")}
              </span>
            </div>

            {/* 条目列表 */}
            <div className="space-y-1">
              {group.items.map((item: MemoryTableRow, idx: number) => (
                <div
                  key={item.id || idx}
                  onClick={() => onMemoryClick(item.id)}
                  className="flex items-start cursor-pointer group hover:opacity-80"
                >
                  <div className="w-15 text-right pr-3 pt-1 flex-shrink-0">
                    <div className="text-3xs text-muted-foreground">
                      {new Date(rowTime(item) ?? item.mentioned_at ?? "").toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </div>
                    <div className="text-3xs text-muted-foreground/70">
                      {new Date(rowTime(item) ?? item.mentioned_at ?? "").toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </div>
                  </div>
                  <div className="flex-shrink-0 pt-2">
                    <div className="w-1.5 h-1.5 rounded-full z-10 bg-muted-foreground/50 group-hover:bg-primary" />
                  </div>
                  <div className="ml-3 flex-1 p-2 rounded border transition-colors bg-card border-border hover:border-primary/50">
                    <p className="text-xs text-foreground line-clamp-2 leading-relaxed">{maskSecrets(item.text)}</p>
                    {item.entities && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {(typeof item.entities === "string" ? item.entities.split(", ") : item.entities)
                          .slice(0, 3)
                          .map((entity: string, _i: number) => (
                            <span
                              key={entity}
                              className="text-3xs px-1.5 py-0.5 rounded-full bg-primary/10 text-emerald-800 dark:text-emerald-300 font-medium"
                            >
                              {maskSecrets(entity)}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
