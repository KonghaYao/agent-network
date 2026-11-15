/**
 * Ported from FenixAgent (Apache-2.0), commit 72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9
 * Upstream: packages/resources/memory/web/pages/hindsight/components/MemoryViewSwitcher.tsx
 * Modified for Agent Network: 平台导入替换；分段控件结构与 aria-pressed 不变。
 */

import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import type { LucideIcon } from "lucide-react";

export interface MemoryViewOption<T extends string> {
  value: T;
  label: string;
  icon: LucideIcon;
}

interface MemoryViewSwitcherProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly MemoryViewOption<T>[];
  ariaLabel: string;
  className?: string;
}

/** 记忆模块通用的分段视图切换器。 */
export function MemoryViewSwitcher<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  className,
}: MemoryViewSwitcherProps<T>) {
  return (
    <div
      className={cn("flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1", className)}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map(({ value: optionValue, label, icon: Icon }) => (
        <Button
          key={optionValue}
          variant="ghost"
          size="xs"
          aria-pressed={value === optionValue}
          onClick={() => onValueChange(optionValue)}
          className={cn(
            "h-8 shrink-0 px-3",
            value === optionValue
              ? "bg-background text-foreground shadow-sm hover:bg-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-4" />
          {label}
        </Button>
      ))}
    </div>
  );
}
