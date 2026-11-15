/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/ui-components/web/ui/skeleton.tsx
 * Modified for Agent Network: 平台原语本地副本；只替换内部导入路径。
 */

import type * as React from "react";

import { cn } from "./cn";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("animate-pulse rounded-md bg-accent", className)} {...props} />;
}

export { Skeleton };
