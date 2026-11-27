/**
 * 个人看板的前端视图存储。
 *
 * 内容与授权始终来自 MCP；这里只保存当前窗口的显示状态（开合、tab、列、
 * 选中项、快速跳转输入与滚动位置）和一次性的跳转目标。切换账号必须清空，
 * 避免把上一位用户的搜索词或返回断点带进新身份。
 */

import { useSyncExternalStore } from 'react';

import type { FocusColumnKey, FocusJumpTarget, FocusTab } from './focus-types';

export interface FocusNotice {
  id: number;
  text: string;
  error: boolean;
}

export interface FocusViewState {
  ownerId: string | null;
  open: boolean;
  tab: FocusTab;
  column: FocusColumnKey;
  selectedItemId: string | null;
  quickOpen: boolean;
  quickQuery: string;
  quickIndex: number;
  scrollTops: Partial<Record<FocusColumnKey, number>>;
  /** 从看板跳到聊天时保存；ChatPage 就绪后消费一次。 */
  pendingJump: FocusJumpTarget | null;
  /** 正在聊天区等待用户「返回看板」。 */
  jumpActive: boolean;
  /** 跳转来源：快速跳转返回时重新展开搜索词与选中结果。 */
  jumpOrigin: 'board' | 'quick';
  notice: FocusNotice | null;
}

const INITIAL: FocusViewState = {
  ownerId: null,
  open: false,
  tab: 'current',
  column: 'needs_me',
  selectedItemId: null,
  quickOpen: false,
  quickQuery: '',
  quickIndex: -1,
  scrollTops: {},
  pendingJump: null,
  jumpActive: false,
  jumpOrigin: 'board',
  notice: null,
};

let state = INITIAL;
const listeners = new Set<() => void>();
let noticeSeq = 0;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function update(patch: Partial<FocusViewState>): void {
  state = { ...state, ...patch };
  emit();
}

/** 身份变化时回到空视图；同一账号的重渲染不重置用户选择。 */
export function ensureFocusOwner(ownerId: string | null): void {
  if (state.ownerId === ownerId) return;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  state = { ...INITIAL, ownerId };
  emit();
}

export function openFocusBoard(options: { quick?: boolean } = {}): void {
  update({ open: true, quickOpen: options.quick === true, quickIndex: -1 });
}

export function closeFocusBoard(): void {
  update({ open: false, quickOpen: false });
}

export function setFocusTab(tab: FocusTab): void {
  update({ tab, selectedItemId: null });
}

export function setFocusColumn(column: FocusColumnKey): void {
  update({ column });
}

export function openFocusItem(itemId: string): void {
  update({ selectedItemId: itemId });
}

export function closeFocusItem(): void {
  update({ selectedItemId: null });
}

export function openFocusQuick(): void {
  update({ quickOpen: true, quickIndex: -1 });
}

export function closeFocusQuick(): void {
  update({ quickOpen: false });
}

export function setFocusQuickQuery(query: string): void {
  update({ quickQuery: query, quickIndex: -1 });
}

export function setFocusQuickIndex(index: number): void {
  update({ quickIndex: index });
}

export function setFocusScrollTop(column: FocusColumnKey, value: number): void {
  // 滚动只影响返回断点，不触发组件重渲染以免阻断原生滚动。
  state = {
    ...state,
    scrollTops: { ...state.scrollTops, [column]: Math.max(0, Math.round(value)) },
  };
}

/** 收起浮窗，把目标交给 ChatPage；保留当前视图供「返回看板」恢复。 */
export function jumpFromBoard(
  target: FocusJumpTarget,
  origin: 'board' | 'quick' = 'board',
): void {
  update({
    open: false,
    quickOpen: false,
    pendingJump: target,
    jumpActive: true,
    jumpOrigin: origin,
  });
}

export function takePendingJump(): FocusJumpTarget | null {
  const target = state.pendingJump;
  if (target) update({ pendingJump: null });
  return target;
}

export function returnToFocusBoard(): void {
  update({
    open: true,
    quickOpen: state.jumpOrigin === 'quick',
    jumpActive: false,
    pendingJump: null,
  });
}

export function clearFocusJump(): void {
  update({ pendingJump: null, jumpActive: false });
}

export function showFocusNotice(text: string, error = false): void {
  if (!text) return;
  if (noticeTimer) clearTimeout(noticeTimer);
  const notice = { id: ++noticeSeq, text, error };
  update({ notice });
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    if (state.notice?.id === notice.id) update({ notice: null });
  }, 4200);
}

export function clearFocusNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  update({ notice: null });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): FocusViewState {
  return state;
}

export function useFocusView(): FocusViewState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
