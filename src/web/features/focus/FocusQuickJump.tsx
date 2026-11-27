/**
 * 快速跳转：同时搜索本人事项（当前 + 已归档）与原消息。
 *
 * 输入 300ms 防抖；中文组合期间不发请求也不处理导航键。结果下标保存在
 * focus-store，收起面板再打开仍能回到同一项；主题与返回断点同样保留。
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { LIMITS } from '../../../contracts/limits';
import { callTool, type McpError } from '../../lib/mcp-client';
import type { MessageSearchHit, MessageSearchPage } from '../search/message-search-types';
import {
  closeFocusQuick,
  setFocusQuickIndex,
  setFocusQuickQuery,
  useFocusView,
} from './focus-store';
import type { FocusItem, FocusListPage } from './focus-types';
import { FOCUS_COLUMN_LABELS } from './focus-types';

interface Entry {
  key: string;
  kind: 'item' | 'message';
  item?: FocusItem;
  message?: MessageSearchHit;
}

function failureText(error: unknown): string {
  return (error as McpError).message || '搜索暂时不可用';
}

function snippet(hit: MessageSearchHit): string {
  const text = hit.snippet || hit.preview || '';
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export function FocusQuickJump({
  token,
  onOpenItem,
  onJumpMessage,
}: {
  token: string;
  onOpenItem: (item: FocusItem) => void;
  onJumpMessage: (hit: MessageSearchHit, query: string) => void;
}) {
  const view = useFocusView();
  const query = view.quickQuery;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const selected = view.quickIndex;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!view.quickOpen) return;
    const value = query.trim();
    if (!value || composing) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      generationRef.current += 1;
      setEntries([]);
      setLoading(false);
      setError('');
      return;
    }
    // 新查询立即清空旧结果，避免防抖窗口内 Enter 命中上一轮列表。
    setEntries([]);
    setFocusQuickIndex(-1);
    setLoading(true);
    setError('');
    const timer = window.setTimeout(() => {
      const generation = ++generationRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      void Promise.all([        callTool<FocusListPage>(
          'network_focus_list',
          { query: value, archived: false, limit: 20 },
          { token, signal: controller.signal },
        ),
        callTool<FocusListPage>(
          'network_focus_list',
          { query: value, archived: true, limit: 20 },
          { token, signal: controller.signal },
        ),
        callTool<MessageSearchPage>(
          'network_message_search',
          {
            scope: 'all',
            mode: 'fuzzy',
            query: value,
            limit: 8,
          },
          { token, signal: controller.signal },
        ),
      ])
        .then(([current, archived, messages]) => {
          if (generation !== generationRef.current) return;
          const next: Entry[] = [
            ...current.items.map((item) => ({
              key: `item:${item.item_id}`,
              kind: 'item' as const,
              item,
            })),
            ...archived.items.map((item) => ({
              key: `item:${item.item_id}`,
              kind: 'item' as const,
              item,
            })),
            ...messages.items.slice(0, 8).map((hit) => ({
              key: `message:${hit.room_id}:${hit.message_id}`,
              kind: 'message' as const,
              message: hit,
            })),
          ];
          setEntries(next);
          setFocusQuickIndex(
            next.length > 0
              ? Math.max(0, Math.min(selectedRef.current, next.length - 1))
              : -1,
          );
          setLoading(false);
        })
        .catch((failure) => {
          if (generation !== generationRef.current) return;
          if ((failure as Error).name === 'AbortError') return;
          setEntries([]);
          setError(failureText(failure));
          setLoading(false);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [composing, query, token, view.quickOpen]);

  // 结果变化后把选中行带入可视区，键盘与鼠标共用同一顺序。
  useEffect(() => {
    if (selected < 0) return;
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-quick-index="${selected}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }, [selected]);

  const activate = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    if (entry.kind === 'item' && entry.item) onOpenItem(entry.item);
    if (entry.kind === 'message' && entry.message) onJumpMessage(entry.message, query);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const native = event.nativeEvent;
    if (native.isComposing || event.keyCode === 229 || composingRef.current) {
      if (
        event.key === 'Escape' ||
        event.key === 'Enter' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp'
      ) {
        if (event.key === 'Escape' || event.key === 'Enter') event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFocusQuick();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (entries.length > 0 && selected >= 0) activate(selected);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (entries.length === 0) return;
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? selected + 1 : selected - 1;
      setFocusQuickIndex(Math.max(0, Math.min(entries.length - 1, next)));
    }
  };

  const itemEntries = entries.filter((entry) => entry.kind === 'item');
  const messageEntries = entries.filter((entry) => entry.kind === 'message');
  const indexOf = (entry: Entry) => entries.findIndex((candidate) => candidate.key === entry.key);
  const statusText = loading
    ? '正在搜索…'
    : error
      ? error
      : query.trim() && entries.length === 0
        ? '没有找到匹配的事项或原消息'
        : entries.length > 0
          ? `已找到 ${entries.length} 个结果`
          : '';

  return (
    <section className="focus-quick" aria-label="快速跳转">
      <div className="focus-quick-inputbar">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="focus-quick-icon">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        </svg>
        <input
          ref={inputRef}
          id="focus-quick-input"
          type="text"
          role="combobox"
          aria-expanded={entries.length > 0}
          aria-controls="focus-quick-results"
          aria-autocomplete="list"
          autoComplete="off"
          placeholder="搜事项、人名、会话或原话"
          aria-label="搜索事项或原消息"
          maxLength={LIMITS.focusQueryMax}
          value={query}
          onChange={(event) => setFocusQuickQuery(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
            setComposing(true);
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            setComposing(false);
          }}
          onKeyDown={onInputKeyDown}
        />
        <button
          type="button"
          className="focus-quick-close"
          aria-label="收起快速跳转"
          onClick={closeFocusQuick}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <p className="focus-quick-status" role="status">
        {statusText}
      </p>
      <div id="focus-quick-results" ref={listRef} className="focus-quick-results" role="listbox">
        {itemEntries.length > 0 ? (
          <>
            <p className="focus-quick-group" aria-hidden="true">
              事项
            </p>
            {itemEntries.map((entry) => {
              const item = entry.item;
              if (!item) return null;
              const index = indexOf(entry);
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  data-quick-index={index}
                  className={`focus-quick-row${index === selected ? ' is-selected' : ''}`}
                  onMouseEnter={() => setFocusQuickIndex(index)}
                  onClick={() => activate(index)}
                >
                  <span className="focus-quick-row-main">
                    <span className="focus-quick-row-title">
                      {item.restricted ? '来源已失效' : item.title || '未命名事项'}
                    </span>
                    <span className="focus-quick-row-sub">
                      {FOCUS_COLUMN_LABELS[item.column_key]}
                      {item.archived_at ? ' · 已归档' : ''}
                      {item.next_step ? ` · ${item.next_step}` : ''}
                    </span>
                  </span>
                </button>
              );
            })}
          </>
        ) : null}
        {messageEntries.length > 0 ? (
          <>
            <p className="focus-quick-group" aria-hidden="true">
              原消息
            </p>
            {messageEntries.map((entry) => {
              const hit = entry.message;
              if (!hit) return null;
              const index = indexOf(entry);
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  data-quick-index={index}
                  className={`focus-quick-row${index === selected ? ' is-selected' : ''}`}
                  onMouseEnter={() => setFocusQuickIndex(index)}
                  onClick={() => activate(index)}
                >
                  <span className="focus-quick-row-main">
                    <span className="focus-quick-row-title">{snippet(hit)}</span>
                    <span className="focus-quick-row-sub">
                      {hit.room_display_name} · {hit.sender_name}
                    </span>
                  </span>
                </button>
              );
            })}
          </>
        ) : null}
      </div>
      <p className="focus-quick-hint">↑↓ 选择 · Enter 打开 · Esc 返回</p>
    </section>
  );
}
