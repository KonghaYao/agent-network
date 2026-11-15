/**
 * 星座图逐帧交互状态：字段口径与初值。
 *
 * 状态放在 ref 而不是 React state：平移/缩放/鼠标位置在指针移动时连续变化，
 * 进 state 会触发整棵组件树重渲染；真正需要重绘的只有画布与 tooltip 层。
 * 移植自 FenixAgent `constellation-state.ts`，保留 `zoom = 1` 作为适配视图的
 * 100% 基准（Fenix 原版以 0.5 起步并在挂载后自动适配）。
 */

export interface ConstellationViewState {
  W: number;
  H: number;
  dpr: number;
  zoom: number;
  panX: number;
  panY: number;
  /** 画布适配缩放：屏幕距离 = 世界距离 × fitScale × zoom。 */
  fitScale: number;
}

export function createConstellationViewState(): ConstellationViewState {
  return {
    W: 0,
    H: 0,
    dpr: 1,
    zoom: 1,
    panX: 0,
    panY: 0,
    fitScale: 1,
  };
}
