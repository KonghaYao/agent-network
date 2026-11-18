/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/resources/memory/web/pages/hindsight/components/MemoryDetailModal.tsx
 * Modified for Agent Network: 平台导入替换；弹窗外壳与取数依赖不变。
 * 阶段 4：嵌套在 Agent 记忆弹窗内时用 `z-[70]` 保证详情在上层；正文默认掩码，
 * 揭示入口在 `MemoryDetailBody`。
 */

import { useLayoutEffect, useRef } from "react";

import { EmptyState } from "../ui/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { NS } from "../i18n";
import { useRequest } from "../hooks/use-request";
import { useTranslation } from "../i18n";
import { useFenixMemoryApi } from "../api";
import { toHindsightFailure } from "../failure";
import { logFenixError } from "../log-error";
import { memoryTypeTitle } from "../memory-type-title";
import { HindsightFailureNotice } from "./HindsightFailureNotice";
import { MemoryDetailBody } from "./MemoryDetailBody";
import { useMemoryDetailBinding } from "../../memory-detail-context";

interface MemoryDetailModalProps {
  memoryId: string | null;
  onClose: () => void;
}

/** 内存详情弹窗 — 简化版，点击表格行/时间线条目时弹出 */
export function MemoryDetailModal({ memoryId, onClose }: MemoryDetailModalProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const api = useFenixMemoryApi();

  // 加载记忆详情。`memoryId` 既是参数也是刷新依赖：换一条记忆即重取，弹窗关闭（null）时不发请求——
  // `ready: false` 会让 ahooks 在 `onBefore` 直接拦下请求（含 `refresh()`），无需自己判空。
  // 非空断言与 `AgentOrganizationsPage` 的 `ready` + `unwrap(api.get(id!))` 同形。
  const {
    data: memory = null,
    loading,
    error: loadError,
  } = useRequest(() => api.getMemory(memoryId!), {
    ready: !!memoryId,
    refreshDeps: [memoryId, api],
    onError: (err) => logFenixError("Error loading memory:", err),
  });
  const failure = loadError ? toHindsightFailure(loadError) : null;

  const isOpen = memoryId !== null;
  const contentRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const detailBinding = useMemoryDetailBinding();

  // 详情开合登记给记忆外壳：父层的 Esc 门控依赖状态而不是 DOM 查询。
  // 用布局阶段登记，保证详情首次可交互前父层已经知道它存在。
  useLayoutEffect(() => {
    if (!isOpen) return;
    detailBinding?.setDetailOpen(true, () => closeRef.current());
    return () => detailBinding?.setDetailOpen(false);
  }, [detailBinding, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    // Lenso top layer 会吞掉 body 的 pointer-events；点击弹窗空白角落时
    // 事件目标可能是 html，Radix 收不到 outside 交互。这里按详情内容节点
    // 判断内外，只负责关闭详情，父层由自己的 backdrop 门控保持打开。
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && contentRef.current?.contains(event.target)) return;
      closeRef.current();
    };
    window.addEventListener('pointerdown', closeOutside, true);
    return () => window.removeEventListener('pointerdown', closeOutside, true);
  }, [isOpen]);
  // Lenso 外壳的内容位于 top layer；详情若继续 portal 到 body 会落在父层下方，
  // 被内容区拦截点击。收进记忆内容容器后仍在父层 stacking context 内，遮罩与
  // 关闭按钮都可达；Radix fallback 下容器同样存在，行为不变。
  const portalContainer =
    typeof document === 'undefined' ? null : document.getElementById('agent-memory-content');

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        ref={contentRef}
        className="z-[70] max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
        overlayClassName="z-[70]"
        portalContainer={portalContainer}
        data-memory-detail-dialog=""
      >
        <DialogHeader>
          <DialogTitle>{memory ? memoryTypeTitle(t, memory.type) : t("memoryDetail.defaultTitle")}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <Spinner className="flex py-20" />
        ) : failure ? (
          failure.kind === "forbidden" ? (
            // 授权失败不给「Error: Cannot resolve bank ID」这类回显，改走统一的无权限文案（无重试）。
            <HindsightFailureNotice failure={failure} className="py-20" />
          ) : (
            // 通用失败：单行原因 + `role="alert"`，与其它失败块同走库的 EmptyState 骨架。
            <EmptyState
              tone="danger"
              role="alert"
              className="py-20"
              title={t("memoryDetailModal.errorPrefix", { message: failure.detail })}
            />
          )
        ) : memory ? (
          <MemoryDetailBody
            memory={memory}
            variant="modal"
            labels={{
              text: t("memoryDetailModal.sectionText"),
              context: t("memoryDetailModal.sectionContext"),
              occurred: t("memoryDetailModal.sectionOccurred"),
              mentioned: t("memoryDetailModal.sectionMentioned"),
              entities: t("memoryDetailModal.sectionEntities"),
              tags: t("memoryDetailModal.sectionTags"),
              memoryId: t("memoryDetailModal.sectionMemoryId"),
              revealText: t("memoryDetail.revealText"),
              hideText: t("memoryDetail.hideText"),
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
