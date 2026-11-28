/**
 * 三列渲染：桌面并排；手机上只渲染 store 中的当前列。
 *
 * 列内独立滚动，滚动位置写回 focus-store，供「返回看板」恢复断点。
 */

import type { FocusCounts, FocusItem, FocusColumnKey } from './focus-types';
import { FOCUS_COLUMNS } from './focus-types';
import { setFocusScrollTop } from './focus-store';
import { FocusCard } from './FocusCard';

export function FocusLanes({
  items,
  counts,
  column,
  desktop,
  archivingId,
  laneRef,
  onOpen,
  onJump,
  onArchive,
}: {
  items: FocusItem[];
  counts: FocusCounts | undefined;
  column: FocusColumnKey;
  desktop: boolean;
  archivingId: string | null;
  laneRef: (key: FocusColumnKey, node: HTMLDivElement | null) => void;
  onOpen: (item: FocusItem) => void;
  onJump: (item: FocusItem) => void;
  onArchive: (item: FocusItem) => void;
}) {
  const grouped: Record<FocusColumnKey, FocusItem[]> = {
    needs_me: [],
    tracking: [],
    done: [],
  };
  for (const item of items) grouped[item.column_key].push(item);

  return (
    <div className="focus-lanes" role="group" aria-label="看板三列">
      {FOCUS_COLUMNS.map((entry) => {
        if (!desktop && column !== entry.key) return null;
        const laneItems = grouped[entry.key];
        const laneCount = counts?.[entry.key] ?? laneItems.length;
        return (
          <section
            key={entry.key}
            className="focus-lane"
            data-lane={entry.key}
            aria-label={entry.label}
          >
            <header className="focus-lane-head">
              <span className="focus-lane-dot" aria-hidden="true" />
              <h3>{entry.label}</h3>
              <span className="focus-lane-count">{laneCount}</span>
            </header>
            <div
              className="focus-lane-cards"
              ref={(node) => laneRef(entry.key, node)}
              onScroll={(event) =>
                setFocusScrollTop(entry.key, event.currentTarget.scrollTop)
              }
            >
              {laneItems.length > 0 ? (
                laneItems.map((item) => (
                  <FocusCard
                    key={item.item_id}
                    item={item}
                    column={entry.key}
                    busy={archivingId === item.item_id}
                    onOpen={() => onOpen(item)}
                    onJump={() => onJump(item)}
                    onArchive={() => onArchive(item)}
                  />
                ))
              ) : (
                <p className="focus-lane-empty">{entry.empty}</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function FocusSkeleton() {
  return (
    <div className="focus-lanes focus-lanes--skeleton" aria-hidden="true">
      {FOCUS_COLUMNS.map((column) => (
        <section key={column.key} className="focus-lane" data-lane={column.key}>
          <header className="focus-lane-head">
            <span className="focus-lane-dot" />
            <h3>{column.label}</h3>
          </header>
          <div className="focus-lane-cards">
            {[0, 1].map((row) => (
              <span key={row} className="focus-card-skeleton" />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
