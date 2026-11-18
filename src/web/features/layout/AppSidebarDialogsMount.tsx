import { Component, lazy, Suspense, type ReactNode } from 'react';

import type { AppSidebarDialogsProps } from './AppSidebarDialogs';

const AppSidebarDialogs = lazy(() =>
  import('./AppSidebarDialogs').then((module) => ({ default: module.AppSidebarDialogs })),
);

class AppSidebarDialogsBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export interface AppSidebarDialogsMountProps extends AppSidebarDialogsProps {
  /** chunk 加载失败时把错误显示在侧栏现有提示区。 */
  onError: () => void;
}

/**
 * 侧栏弹窗的懒加载宿主。
 *
 * 与 `ChatDialogsMount` 相同：加载成功后保持挂载，弹窗开关只改变 `open`，
 * 保证 Radix `onCloseAutoFocus` 仍能回到触发按钮。chunk 加载失败由边界
 * 降级为空，并通过 `onError` 在侧栏提示区给出可重试说明。
 */
export function AppSidebarDialogsMount({
  onError,
  ...dialogs
}: AppSidebarDialogsMountProps) {
  return (
    <AppSidebarDialogsBoundary onError={onError}>
      <Suspense
        fallback={
          dialogs.groupOpen || dialogs.contactsOpen ? (
            <p className="visually-hidden" role="status">
              正在打开弹窗…
            </p>
          ) : null
        }
      >
        <AppSidebarDialogs {...dialogs} />
      </Suspense>
    </AppSidebarDialogsBoundary>
  );
}
