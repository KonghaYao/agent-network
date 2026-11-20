/**
 * 模块级身份代次。
 *
 * 切号/撤权时恢复遮罩会把 RoomTaskDock、ChatDialogsMount 等组件卸载；
 * 组件内 `useRef` 随闭包冻结在旧身份，晚到的 mutation 回调仍会通过旧 ref
 * 校验，把旧身份的结果写进新身份的 React Query 缓存。代次必须存放在模块
 * 作用域：组件卸载不重置，页面刷新自然回到 0。
 *
 * 请求发起时记录 `currentIdentityEpoch()`，回调执行时再读一次；不相等即
 * 丢弃，不写任何 queryClient 缓存或本地状态。
 */

let epoch = 0;
let observed: { actorId: string | null; token: string | null } = {
  actorId: null,
  token: null,
};

/** 身份边界变化（切号、撤权、auth 信号、恢复轮发现不一致）时推进。 */
export function bumpIdentityEpoch(): void {
  epoch += 1;
}

/** 回调执行时读取当前代次。 */
export function currentIdentityEpoch(): number {
  return epoch;
}

/**
 * 观测当前浏览器身份：token 或 actor 变化时推进代次。
 *
 * 同一身份重复观测无副作用，允许在多个挂载点调用；它只作为显式 bump
 * 的兜底，不保存 token 到日志或持久化存储。
 */
export function observeIdentity(actorId: string | null, token: string | null): number {
  if (observed.actorId === actorId && observed.token === token) return epoch;
  observed = { actorId, token };
  epoch += 1;
  return epoch;
}
