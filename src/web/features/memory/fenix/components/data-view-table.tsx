/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/resources/memory/web/pages/hindsight/components/data-view-table.tsx
 * Modified for Agent Network: 平台导入替换；渲染结构不变。
 * 阶段 4：发生时间列优先用服务端行里的 `occurred_at`（= occurred_start ?? mentioned_at），
 * 避免只有 `occurred_at` 的行被显示成空；实体/标签胶囊用更深的文字色满足 WCAG AA。
 */

import { Tooltip } from '../../../../app/lenso-tooltip';
import { EmptyState } from "../ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { NS } from "../i18n";
import { useTranslation } from "../i18n";
import { maskSecrets } from '../../mask';
import type { MemoryTableRow } from "../types";
import type { FactType } from "./data-view-model";
import { MemoryPagination } from "./MemoryPagination";

/**
 * `DataView` 的表格视图：固定列宽的记忆表格 + 分页。
 *
 * 从 `DataView` 抽出：它是三条视图里唯一按行渲染的（图谱与时间线各有一套坐标），
 * 每行还要现算展示用的日期、实体与标签切片，与页面的取数三态、视图切换没有耦合。
 *
 * 分页状态**留在 `DataView`**：切到别的视图时本组件会卸载，状态若放在这里就会重置回第 1 页——
 * 那是有意的行为约束，不是遗漏。
 */
const ITEMS_PER_PAGE = 100;

/** 表格里的日期列：短格式（月 日 年）；没有值时调用处回落成 `-`。 */
function formatDate(value?: string | null): string | null {
  return value
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
}

export interface DataViewTableProps {
  factType: FactType;
  rows: MemoryTableRow[];
  currentPage: number;
  onPageChange: (page: number) => void;
  /** 点行打开记忆详情弹窗（弹窗由 `DataView` 持有）。 */
  onRowClick: (memoryId: string) => void;
}

export function DataViewTable({ factType, rows, currentPage, onPageChange, onRowClick }: DataViewTableProps) {
  const { t } = useTranslation(NS.HINDSIGHT);

  return (
    <div
      className="min-h-0 min-w-0 flex-1 overflow-auto"
      tabIndex={0}
      aria-label={t("dataView.tableScrollRegion")}
    >
      <div className="min-w-256">
        <div className="pb-4">
          {rows.length > 0 ? (
            (() => {
              const totalPages = Math.ceil(rows.length / ITEMS_PER_PAGE);
              const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
              const endIndex = startIndex + ITEMS_PER_PAGE;
              const paginatedRows = rows.slice(startIndex, endIndex);

              return (
                <>
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className={factType === "observation" ? "w-[35%]" : "w-[38%]"}>
                          {factType === "observation" ? t("dataView.columnObservation") : t("dataView.columnMemory")}
                        </TableHead>
                        <TableHead className="w-[15%]">{t("dataView.columnEntities")}</TableHead>
                        <TableHead className="w-[15%]">{t("dataView.columnTags")}</TableHead>
                        {factType === "observation" && (
                          <TableHead className="w-[10%]">{t("dataView.columnSources")}</TableHead>
                        )}
                        <TableHead className={factType === "observation" ? "w-[12%]" : "w-[16%]"}>
                          {t("dataView.columnOccurred")}
                        </TableHead>
                        <TableHead className={factType === "observation" ? "w-[13%]" : "w-[16%]"}>
                          {t("dataView.columnMentioned")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedRows.map((row: MemoryTableRow, idx: number) => {
                        const occurredDisplay = formatDate(
                          row.occurred_start ?? row.occurred_at ?? row.mentioned_at,
                        );
                        const mentionedDisplay = formatDate(row.mentioned_at);
                        const entities = row.entities
                          ? typeof row.entities === "string"
                            ? row.entities
                                .split(",")
                                .map((entity) => entity.trim())
                                .filter(Boolean)
                            : row.entities
                          : [];
                        const tags = (row.tags ?? []).map((tag) => maskSecrets(tag));

                        return (
                          <TableRow
                            key={row.id || idx}
                            onClick={() => onRowClick(row.id)}
                            className="h-15 cursor-pointer hover:bg-muted/50"
                          >
                            <TableCell className="py-2 align-middle">
                              <div className="line-clamp-2 break-words text-sm leading-snug text-foreground">
                                {maskSecrets(row.text)}
                              </div>
                            </TableCell>
                            <TableCell className="py-2 align-middle">
                              {entities.length > 0 ? (
                                <div className="flex min-w-0 items-center overflow-hidden">
                                  <Tooltip as="span"
                                    hint={maskSecrets(entities[0] ?? "")}
                                    className="block min-w-0 max-w-full truncate rounded-full bg-primary/10 px-1.5 py-0.5 text-3xs font-medium text-emerald-800 dark:text-emerald-300"
                                  >
                                    {maskSecrets(entities[0] ?? "")}
                                  </Tooltip>
                                  {entities.length > 1 && (
                                    <span className="ml-1 shrink-0 text-3xs text-muted-foreground">
                                      +{entities.length - 1}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell className="py-2 align-middle">
                              {tags.length > 0 ? (
                                <div className="flex min-w-0 items-center overflow-hidden">
                                  <Tooltip as="span"
                                    hint={maskSecrets(tags[0] ?? "")}
                                    className="block min-w-0 max-w-full truncate rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 font-mono text-3xs font-medium text-amber-800 dark:text-amber-300"
                                  >
                                    #{tags[0]}
                                  </Tooltip>
                                  {tags.length > 1 && (
                                    <span className="ml-1 shrink-0 text-3xs text-muted-foreground">
                                      +{tags.length - 1}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            {factType === "observation" && (
                              <TableCell className="text-xs py-2 text-foreground">{row.proof_count ?? 1}</TableCell>
                            )}
                            <TableCell className="text-xs py-2 text-foreground">
                              {occurredDisplay || <span className="text-muted-foreground">-</span>}
                            </TableCell>
                            <TableCell className="text-xs py-2 text-foreground">
                              {mentionedDisplay || <span className="text-muted-foreground">-</span>}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>

                  {/* 分页 */}
                  <MemoryPagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={onPageChange}
                    rangeLabel={`${startIndex + 1}-${Math.min(endIndex, rows.length)} ${t("dataView.of")} ${rows.length}`}
                  />
                </>
              );
            })()
          ) : (
            <EmptyState
              className="py-12"
              title={rows.length > 0 ? t("dataView.noMemoriesMatchFilter") : t("dataView.noMemoriesFound")}
            />
          )}
        </div>
      </div>
    </div>
  );
}
