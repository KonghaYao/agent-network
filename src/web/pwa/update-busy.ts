/**
 * 更新前的忙碌来源登记。
 *
 * 组件只登记“刷新会丢失且无法完整恢复”的状态；纯文字草稿不在此列，它由
 * 一次性快照恢复。判断逻辑抽成纯函数，便于逐分支验收，不依赖 DOM。
 */

export interface UpdateBusyReason {
  readonly source: string;
  readonly label: string;
}

type Listener = () => void;

const reasons = new Map<string, string>();
const listeners = new Set<Listener>();
let snapshot: readonly UpdateBusyReason[] = [];

function publish(): void {
  const next = [...reasons].map(([source, label]) => ({ source, label }));
  if (
    next.length === snapshot.length &&
    next.every(
      (item, index) =>
        item.source === snapshot[index]?.source && item.label === snapshot[index]?.label,
    )
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

export function setUpdateBusy(source: string, label: string | null): void {
  const next = label?.trim();
  if (next) reasons.set(source, next);
  else reasons.delete(source);
  publish();
}

export function getUpdateBusyReasons(): readonly UpdateBusyReason[] {
  return snapshot;
}

export function subscribeUpdateBusy(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 只用于单元测试；生产路径由各组件卸载时清理。 */
export function clearUpdateBusyForTests(): void {
  reasons.clear();
  publish();
}

export interface ComposerBusyInput {
  readonly composing: boolean;
  readonly selections: number;
  readonly reply: boolean;
  readonly files: readonly { readonly status: 'uploading' | 'ready' | 'failed' }[];
  readonly sending: boolean;
  readonly drawboardLoading: boolean;
  readonly drawboardOpen: boolean;
}

/** Composer 中无法由文字快照恢复的状态，按用户可执行的顺序排列。 */
export function composerUpdateBusy(input: ComposerBusyInput): string[] {
  const list: string[] = [];
  if (input.composing) list.push('请先完成中文输入');
  if (input.selections > 0) list.push('请先发送或清除已选择的 @ 成员');
  if (input.reply) list.push('请先取消当前引用');
  if (input.files.some((file) => file.status === 'uploading')) {
    list.push('请等待附件上传完成');
  }
  if (input.files.some((file) => file.status === 'failed')) {
    list.push('请先移除上传失败的附件');
  }
  if (input.files.some((file) => file.status === 'ready')) {
    list.push('请先发送或移除已添加的附件');
  }
  if (input.sending) list.push('请等待消息发送结果确认');
  if (input.drawboardLoading) list.push('请等待画板加载完成');
  if (input.drawboardOpen) list.push('请先保存或关闭画板');
  return list;
}

export function pairingUpdateBusy(
  phase: 'idle' | 'joining' | 'awaiting' | 'redeeming' | 'ready' | 'error',
  switchBusy: boolean,
  scanOpen: boolean,
): string[] {
  const list: string[] = [];
  if (phase === 'joining') list.push('设备配对正在加入，请先完成或取消');
  if (phase === 'awaiting') list.push('等待已登录设备确认配对');
  if (phase === 'redeeming') list.push('正在兑换配对凭据');
  if (phase === 'ready') list.push('配对已完成，请先确认切换');
  if (switchBusy) list.push('正在切换账号');
  if (scanOpen) list.push('请先关闭扫码');
  return list;
}

export function handoffUpdateBusy(open: boolean): string[] {
  return open ? ['请先关闭配对码弹窗'] : [];
}

export function friendRedeemUpdateBusy(redeeming: boolean): string[] {
  return redeeming ? ['好友兑换正在进行'] : [];
}

export function friendInviteUpdateBusy(sending: boolean): string[] {
  return sending ? ['好友邀请正在发送'] : [];
}

export function outboxUpdateBusy(sending: boolean): string[] {
  return sending ? ['请等待发送结果确认'] : [];
}
