import { useCallback, useState } from 'react';

import { useWebSession } from '../hooks/useWebSession';
import { dismissInstallGuide, isInstallGuideDismissed } from './install';
import { closeInstallGuide, useInstallGuideOpen } from './install-guide-store';
import { InstallGuideDialog } from './InstallGuideDialog';

/**
 * 应用页（`/`、`/c/*`）的安装引导挂载点。
 *
 * 只有 `pairing-required` 且本地未关闭时自动展开；手动入口通过
 * `openInstallGuide()` 打开，不受已关闭偏好影响。卡片页（分享/邀请/配对）
 * 不自动弹层，由各自业务按钮显式打开。
 */
export function InstallGuideHost({ appRoute }: { appRoute: boolean }) {
  const session = useWebSession();
  const manual = useInstallGuideOpen();
  const [dismissed, setDismissed] = useState(() => isInstallGuideDismissed());
  const automatic = appRoute && session.status === 'pairing-required' && !dismissed;
  const open = automatic || manual;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) return;
      if (automatic) {
        dismissInstallGuide();
        setDismissed(true);
      }
      closeInstallGuide();
    },
    [automatic],
  );

  return <InstallGuideDialog open={open} onOpenChange={handleOpenChange} />;
}
