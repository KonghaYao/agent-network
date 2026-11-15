/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/resources/memory/web/pages/hindsight/MemoriesPage.tsx
 * Modified for Agent Network: 移除 mental-models 视角（本仓库无该后端契约）；主从壳改用本地 shim；平台导入替换为 fenix 本地模块。
 */

import "./MemoriesPage.css";

import { AgentMasterDetailWorkspace } from "./components/agent-master-detail-workspace";
import { EmptyState } from "./ui/empty-state";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./ui/spinner";
import { NS } from "./i18n";
import { useRequest } from "./hooks/use-request";
import { Eye, Fingerprint, Globe, Network, Search } from "lucide-react";
import { lazy, Suspense, useState, type KeyboardEvent } from "react";
import { useTranslation } from "./i18n";
import { useFenixMemoryApi } from "./api";
import { HindsightFailureNotice } from "./components/HindsightFailureNotice";
import { toHindsightFailure } from "./failure";
import { logFenixError } from "./log-error";
import { LIMITS } from "../../../../contracts/limits";

/**
 * 两个内容视图保持动态 import：`MemoriesPage` 本身已由弹窗懒加载，但实体视图
 * 不应在默认世界视角下被一起拉取（e2e 断言 `EntitiesView-*.js` 只在切到实体时出现）。
 * `DataView` 同样保留独立 chunk，避免弹窗壳与图表代码绑在一起。
 */
const DataView = lazy(() =>
  import("./components/DataView").then((module) => ({ default: module.DataView })),
);
const EntitiesView = lazy(() =>
  import("./components/EntitiesView").then((module) => ({ default: module.EntitiesView })),
);

type MemoryPerspective = "world" | "experience" | "observation" | "entities";
type FactPerspective = Extract<MemoryPerspective, "world" | "experience" | "observation">;

const PERSPECTIVES = [
  {
    id: "world",
    icon: Globe,
    labelKey: "tabs.worldFacts",
    descriptionKey: "perspectives.worldDescription",
    markClass: "bg-sky-500",
  },
  {
    id: "experience",
    icon: Fingerprint,
    labelKey: "tabs.experience",
    descriptionKey: "perspectives.experienceDescription",
    markClass: "bg-violet-500",
  },
  {
    id: "observation",
    icon: Eye,
    labelKey: "tabs.observations",
    descriptionKey: "perspectives.observationDescription",
    markClass: "bg-amber-500",
  },
  {
    id: "entities",
    icon: Network,
    labelKey: "tabs.entities",
    descriptionKey: "perspectives.entitiesDescription",
    markClass: "bg-rose-500",
  },
] as const;

function isFactPerspective(perspective: MemoryPerspective): perspective is FactPerspective {
  return perspective === "world" || perspective === "experience" || perspective === "observation";
}

/**
 * Fenix memories page used as the Agent memory dialog's only shell.
 *
 * `showHeader` is false in the dialog: the dialog already renders the product title,
 * target and read-only badges. DOM/class names stay upstream so the page remains a
 * faithful vendor port; tests target stable `data-*` hooks instead of the removed
 * self-written shell classes.
 */
export function MemoriesPage({ showHeader = true }: { showHeader?: boolean } = {}) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const api = useFenixMemoryApi();
  const [perspective, setPerspective] = useState<MemoryPerspective>("world");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // 状态取数交给 `useRequest`（§3.4）：失败抛 `FenixApiError`，因此 `error` 分支能真正接到
  // 4xx/5xx——手写的 `try/catch` + 三个 `setState` 不再需要。provider 切换时重新取状态。
  const {
    data: status,
    loading,
    error: statusError,
    refresh: refreshStatus,
  } = useRequest(() => api.getStatus(), {
    onError: (err) => logFenixError("Failed to get Hindsight status:", err),
    refreshDeps: [api],
  });

  // 失败态由 `error` 派生，而不是另存一份 state：`data` 在失败时保持 undefined，`enabled` 会落到 false。
  // 若失败没有独立分支，界面会走下面的「未配置」空态——即把取数失败伪装成产品未配置（§3.4 禁止）。
  const statusFailure = statusError ? toHindsightFailure(statusError) : null;
  const enabled = status?.enabled ?? false;

  if (loading) {
    return (
      // 骨架屏没有可朗读文本，故用 `aria-busy` 表达「区域正在取数」而不是空挂 role="status"。
      <div
        className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7"
        aria-busy="true"
      >
        <div className="mb-4 shrink-0 space-y-2">
          <Skeleton className="h-7 w-28 rounded-md" />
          <Skeleton className="h-3 w-56 rounded-md" />
        </div>
        {/* 骨架两列：基态单列上下均分、md 起「15rem 索引列 + 剩余详情列」。曾写作
            `md:grid-cols-[15rem_minmax(0,1fr)]` 并因此下沉到 `MemoriesPage.css`，实际可用扁平工具类等价表达：
            列宽 15rem 就是 `w-60`（15 ÷ 0.25），`repeat(auto)` 行的均分就是 `flex-1`，md 的固定/弹性分工
            由 `md:w-60 md:flex-none` 与 `md:min-w-0` 承担（`md:flex-none` 抵消基态的 `flex-1`）。 */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
          <Skeleton className="flex-1 rounded-xl md:w-60 md:flex-none" />
          <Skeleton className="flex-1 rounded-xl md:min-w-0" />
        </div>
      </div>
    );
  }

  if (statusFailure) {
    return (
      <div className="grid h-full min-h-0 place-items-center overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
        <HindsightFailureNotice
          failure={statusFailure}
          titleKey="status.loadFailed"
          retryKey="status.retry"
          onRetry={refreshStatus}
          className="py-16"
        />
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="grid h-full min-h-0 place-items-center overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
        <EmptyState className="py-16" title={t("status.notConfigured")} />
      </div>
    );
  }

  /**
   * Roving focus over the perspective tabs. Upstream renders a plain button list;
   * the dialog's previous shell added Arrow/Home/End navigation, and keeping it here
   * avoids the self-written shell while preserving keyboard parity.
   */
  const onPerspectiveKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-fenix-perspective]"),
    );
    const index = buttons.findIndex((button) => button.dataset.fenixPerspective === perspective);
    let nextIndex = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % buttons.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + buttons.length) % buttons.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = buttons.length - 1;
    }
    if (nextIndex < 0) return;
    const next = buttons[nextIndex];
    if (!next) return;
    event.preventDefault();
    setPerspective(next.dataset.fenixPerspective as MemoryPerspective);
    next.focus({ preventScroll: true });
  };

  return (
    <div
      className="fenix-memory-root flex h-full min-h-0 flex-col overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7"
      data-fenix-memory-page
    >
      {showHeader ? (
        <header className="mb-4 shrink-0" data-fenix-memory-header>
          <h1 className="text-xl font-bold tracking-tight">{t("title")}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
        </header>
      ) : null}

      {/*
        左栏是**视角切换 tab**（`aria-pressed` + 图标 / 标题 / 描述 / 状态色点），不是「N 条实体的目录」，
        因此只把它放进共享主从壳的 `index` 槽，不套 `AgentCatalogIndex` 一族（那族的列模板与
        `aria-current="page"` 表达的是「当前打开的那一条」，套上来会把 tab 的选中语义改写成目录语义）。
        左列的竖分隔线由壳画（`shadow-[inset_-1px_0_var(--color-border)]`），窄屏横向分隔线由下面 `border-b` 提供。

        本仓库的 workspace shim 不写死上游页面高度（`calc(100dvh - 210px)`）：弹窗 body 提供
        `flex-1 min-h-0`，这里 `flex-1` 填满剩余空间；短视口靠 `min-h-0` 让左列/详情内部滚动，
        不会在 390×600 或横屏下撑出 480px 的强制高度。
      */}
      <AgentMasterDetailWorkspace
        className="memories-page-workspace flex flex-1"
        index={
          <aside
            className="flex min-h-0 min-w-0 flex-col border-b p-2 md:border-b-0 md:p-3"
            data-fenix-memory-index
          >
            <div className="hidden px-2 pb-3 md:block">
              <strong className="block text-sm">{t("perspectives.title")}</strong>
              <span className="mt-1 block text-xs text-muted-foreground">{t("perspectives.description")}</span>
            </div>

            {isFactPerspective(perspective) && (
              <form
                className="relative mb-2 md:mb-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSearchQuery(searchInput.trim());
                }}
              >
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onInput={(event) => setSearchInput(event.currentTarget.value)}
                  placeholder={t("workspace.searchPlaceholder")}
                  aria-label={t("workspace.searchPlaceholder")}
                  maxLength={LIMITS.memoryPanelSearchMax}
                  data-fenix-memory-search
                  className="bg-background pl-9"
                />
              </form>
            )}

            <nav
              className="flex min-w-0 gap-1 overflow-x-auto pb-1 md:grid md:overflow-visible md:pb-0"
              aria-label={t("perspectives.title")}
              onKeyDown={onPerspectiveKeyDown}
            >
              {PERSPECTIVES.map(({ id, icon: Icon, labelKey, descriptionKey, markClass }) => {
                const selected = perspective === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={selected}
                    data-fenix-perspective={id}
                    onClick={() => setPerspective(id)}
                    className={`flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors md:min-h-14 md:w-auto md:px-2.5 md:py-2 ${
                      selected
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-background hover:text-foreground"
                    }`}
                  >
                    <span
                      className={`relative grid size-9 shrink-0 place-items-center rounded-full border ring-2 ring-inset transition-colors ${
                        selected
                          ? "border-primary/40 bg-primary/10 text-primary ring-primary/25"
                          : "border-border bg-background text-muted-foreground ring-muted"
                      }`}
                      aria-hidden="true"
                    >
                      <Icon className="size-4" />
                      <span
                        className={`absolute right-0.5 bottom-0.5 size-2 rounded-full border border-background ${markClass}`}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block text-sm text-foreground">{t(labelKey)}</strong>
                      <small className="hidden truncate text-3xs text-muted-foreground md:block">
                        {t(descriptionKey)}
                      </small>
                    </span>
                  </button>
                );
              })}
            </nav>
          </aside>
        }
      >
        <main
          className="h-full min-h-0 min-w-0 overflow-hidden p-3 sm:p-5"
          data-fenix-memory-content
        >
          {isFactPerspective(perspective) ? (
            <Suspense fallback={<Spinner className="flex py-16" label={t("dataView.loadingMemories")} />}>
              <DataView
                key={`${perspective}:${searchQuery}`}
                factType={perspective}
                initialQuery={searchQuery}
              />
            </Suspense>
          ) : (
            <Suspense fallback={<Spinner className="flex py-16" label={t("entitiesView.loadingEntities")} />}>
              <EntitiesView />
            </Suspense>
          )}
        </main>
      </AgentMasterDetailWorkspace>
    </div>
  );
}
