/**
 * Fabric.js 画板：全屏覆盖层、画笔/橡皮、颜色/粗细、形状、文本与撤销/重做。
 *
 * 浏览器按需加载的独立 bundle；关闭时销毁 Fabric canvas、覆盖层、样式与键盘监听，
 * 再次打开重新创建，避免跨次打开残留对象或监听器。导出始终是白底 PNG，
 * 通过 `onInsert(File)` 交给现有上传/chip 链路；本模块不读取凭据、不请求网络。
 */

import {
  Canvas,
  Ellipse,
  IText,
  Line,
  PencilBrush,
  Rect,
  type FabricObject,
} from 'fabric';

import { DRAWBOARD_STYLE } from './styles';

export interface DrawboardOptions {
  /** 导出成功并关闭画板后回调；调用方负责加入待发送 chips。 */
  onInsert(file: File): void;
}

export interface DrawboardHandle {
  close(): void;
}

type DrawTool = 'pen' | 'eraser' | 'rect' | 'ellipse' | 'line' | 'text';

interface Point {
  x: number;
  y: number;
}

const COLORS = [
  { value: '#1f2329', label: '黑色' },
  { value: '#e5484d', label: '红色' },
  { value: '#2f6fed', label: '蓝色' },
  { value: '#2f9e44', label: '绿色' },
  { value: '#f5b301', label: '黄色' },
] as const;

const TOOLS: { value: DrawTool; label: string }[] = [
  { value: 'pen', label: '画笔' },
  { value: 'eraser', label: '橡皮' },
  { value: 'rect', label: '矩形' },
  { value: 'ellipse', label: '椭圆' },
  { value: 'line', label: '直线' },
  { value: 'text', label: '文本' },
];

const TEMPLATE = `<div class="db-shell" role="dialog" aria-modal="true" aria-label="画板">
  <div class="db-toolbar" role="toolbar" aria-label="画板工具">
    <div class="db-group" role="group" aria-label="绘图工具">${TOOLS.map(
      (tool) =>
        `<button type="button" class="db-btn" data-db-tool="${tool.value}" aria-pressed="false">${tool.label}</button>`,
    ).join('')}</div>
    <div class="db-group" role="group" aria-label="颜色">${COLORS.map(
      (color) =>
        `<button type="button" class="db-swatch" data-db-color="${color.value}" ` +
        `style="--db-color:${color.value}" aria-label="${color.label}" aria-pressed="false" ` +
        `title="${color.label}"></button>`,
    ).join('')}</div>
    <label class="db-width">粗细
      <input type="range" id="db-width" min="1" max="16" step="1" value="4"
        aria-label="画笔粗细" data-db-width="4">
    </label>
    <div class="db-spacer"></div>
    <div class="db-group db-actions" role="group" aria-label="画板操作">
      <button type="button" class="db-btn" id="db-undo" disabled>撤销</button>
      <button type="button" class="db-btn" id="db-redo" disabled>重做</button>
      <button type="button" class="db-btn db-danger" id="db-clear">清空</button>
      <button type="button" class="db-btn" id="db-cancel">取消</button>
      <button type="button" class="db-btn db-primary" id="db-insert" disabled>插入</button>
    </div>
  </div>
  <div class="db-stage" id="db-stage"><canvas id="db-canvas" aria-label="绘图画布"></canvas></div>
  <p class="db-status" id="db-status" role="status" hidden></p>
</div>`;

let activeClose: (() => void) | null = null;

/**
 * 打开画板。重复调用返回当前实例的关闭句柄，不叠加覆盖层。
 */
export function openDrawboard(options: DrawboardOptions): DrawboardHandle {
  if (activeClose) return { close: activeClose };

  const previousFocus = document.activeElement as HTMLElement | null;
  const previousOverflow = document.body.style.overflow;
  const style = document.createElement('style');
  style.setAttribute('data-drawboard-style', '1');
  style.textContent = DRAWBOARD_STYLE;
  document.head.append(style);

  const overlay = document.createElement('div');
  overlay.className = 'db-overlay';
  overlay.setAttribute('data-drawboard-overlay', '1');
  overlay.innerHTML = TEMPLATE;
  document.body.append(overlay);
  document.body.style.overflow = 'hidden';

  const stage = must<HTMLElement>(overlay, '#db-stage');
  const canvasElement = must<HTMLCanvasElement>(overlay, '#db-canvas');
  const statusElement = must<HTMLElement>(overlay, '#db-status');
  const undoButton = must<HTMLButtonElement>(overlay, '#db-undo');
  const redoButton = must<HTMLButtonElement>(overlay, '#db-redo');
  const clearButton = must<HTMLButtonElement>(overlay, '#db-clear');
  const cancelButton = must<HTMLButtonElement>(overlay, '#db-cancel');
  const insertButton = must<HTMLButtonElement>(overlay, '#db-insert');
  const widthInput = must<HTMLInputElement>(overlay, '#db-width');

  // 画布按初始可用空间定尺寸；窗口变化时由 CSS 等比缩放，Fabric 自行换算指针坐标。
  const canvasWidth = Math.max(240, Math.min(1100, Math.round(stage.clientWidth - 24)));
  const canvasHeight = Math.max(240, Math.min(700, Math.round(stage.clientHeight - 24)));
  const canvas = new Canvas(canvasElement, {
    width: canvasWidth,
    height: canvasHeight,
    backgroundColor: '#ffffff',
    preserveObjectStacking: true,
    selection: false,
    skipTargetFind: true,
    renderOnAddRemove: true,
  });

  const brush = new PencilBrush(canvas);
  canvas.freeDrawingBrush = brush;

  let tool: DrawTool = 'pen';
  let color: string = COLORS[0].value;
  let strokeWidth = 4;
  let shape: Rect | Ellipse | Line | null = null;
  let shapeStart: Point = { x: 0, y: 0 };
  let history: string[] = [];
  let historyIndex = -1;
  let restoring = false;
  let closed = false;

  const pick = <T extends Element>(selector: string): T =>
    must<T>(overlay, selector);

  function setStatus(message: string): void {
    statusElement.textContent = message;
    statusElement.hidden = false;
  }

  function clearStatus(): void {
    statusElement.textContent = '';
    statusElement.hidden = true;
  }

  function updateActions(): void {
    const objectCount = canvas.getObjects().length;
    undoButton.disabled = historyIndex <= 0;
    redoButton.disabled = historyIndex >= history.length - 1;
    insertButton.disabled = objectCount === 0;
    // 只暴露对象数量，便于验收判断历史/形状是否生效，不写任何内容或凭据。
    overlay.dataset.dbObjects = String(objectCount);
  }

  function serialize(): string {
    return JSON.stringify(canvas.toJSON());
  }

  function snapshot(): void {
    if (restoring) return;
    const next = serialize();
    if (history[historyIndex] === next) return;
    history = history.slice(0, historyIndex + 1);
    history.push(next);
    if (history.length > 50) history.shift();
    historyIndex = history.length - 1;
    updateActions();
  }

  function applyTool(): void {
    canvas.isDrawingMode = tool === 'pen' || tool === 'eraser';
    canvas.selection = false;
    canvas.skipTargetFind = true;
    canvas.defaultCursor = tool === 'pen' || tool === 'eraser' ? 'crosshair' : 'crosshair';
    if (tool === 'eraser') {
      // Fabric v6 不含 EraserBrush；白色画布上用白色画笔实现可撤销的擦除。
      brush.color = '#ffffff';
      brush.width = Math.max(6, strokeWidth * 2.5);
    } else {
      brush.color = color;
      brush.width = strokeWidth;
    }
    for (const button of overlay.querySelectorAll<HTMLButtonElement>('[data-db-tool]')) {
      const active = button.dataset.dbTool === tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    for (const swatch of overlay.querySelectorAll<HTMLButtonElement>('[data-db-color]')) {
      const active = swatch.dataset.dbColor === color;
      swatch.setAttribute('aria-pressed', active ? 'true' : 'false');
      swatch.classList.toggle('is-active', active);
    }
    widthInput.value = String(strokeWidth);
    widthInput.dataset.dbWidth = String(strokeWidth);
    canvas.requestRenderAll();
  }

  function setTool(next: DrawTool): void {
    if (tool === next) return;
    exitTextEditing(true);
    cancelShape();
    tool = next;
    applyTool();
  }

  function setColor(next: string): void {
    color = next;
    if (tool === 'eraser') tool = 'pen';
    applyTool();
  }

  function cancelShape(): void {
    if (!shape) return;
    canvas.remove(shape);
    shape = null;
    canvas.requestRenderAll();
  }

  function exitTextEditing(removeEmpty: boolean): void {
    const active = canvas.getActiveObject();
    if (!(active instanceof IText)) return;
    if (active.isEditing) active.exitEditing();
    if (removeEmpty && active.text.trim() === '') canvas.remove(active);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }

  function removeEmptyTexts(): void {
    for (const object of canvas.getObjects()) {
      if (object instanceof IText && object.text.trim() === '') canvas.remove(object);
    }
  }

  function isTooSmall(object: FabricObject): boolean {
    if (object instanceof Rect) {
      return (object.width ?? 0) < 3 || (object.height ?? 0) < 3;
    }
    if (object instanceof Ellipse) {
      return (object.rx ?? 0) < 1.5 || (object.ry ?? 0) < 1.5;
    }
    if (object instanceof Line) {
      return Math.hypot(object.x2 - object.x1, object.y2 - object.y1) < 4;
    }
    return false;
  }

  function scenePoint(event: Event): Point {
    const point = canvas.getScenePoint(event as MouseEvent);
    return { x: point.x, y: point.y };
  }

  function beginShape(point: Point): void {
    const common = {
      left: point.x,
      top: point.y,
      stroke: color,
      strokeWidth,
      fill: '',
      selectable: false,
      evented: false,
      objectCaching: false,
    };
    if (tool === 'rect') {
      shape = new Rect({ ...common, width: 0, height: 0 });
    } else if (tool === 'ellipse') {
      shape = new Ellipse({ ...common, rx: 0, ry: 0 });
    } else if (tool === 'line') {
      shape = new Line([point.x, point.y, point.x, point.y], common);
    }
    if (!shape) return;
    shapeStart = point;
    canvas.add(shape);
    canvas.requestRenderAll();
  }

  function updateShape(point: Point): void {
    if (!shape) return;
    const left = Math.min(shapeStart.x, point.x);
    const top = Math.min(shapeStart.y, point.y);
    const width = Math.abs(point.x - shapeStart.x);
    const height = Math.abs(point.y - shapeStart.y);
    if (shape instanceof Rect) {
      shape.set({ left, top, width, height });
    } else if (shape instanceof Ellipse) {
      shape.set({ left, top, rx: width / 2, ry: height / 2 });
    } else if (shape instanceof Line) {
      shape.set({ x2: point.x, y2: point.y });
    }
    canvas.requestRenderAll();
  }

  function finishShape(): void {
    if (!shape) return;
    const finished = shape;
    shape = null;
    if (isTooSmall(finished)) {
      canvas.remove(finished);
      canvas.requestRenderAll();
      return;
    }
    finished.setCoords();
    snapshot();
    updateActions();
    canvas.requestRenderAll();
  }

  function beginText(point: Point): void {
    const text = new IText('', {
      left: point.x,
      top: point.y,
      fill: color,
      fontSize: 28,
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif',
      selectable: true,
      evented: true,
      editable: true,
      objectCaching: false,
    });
    canvas.add(text);
    canvas.setActiveObject(text);
    text.enterEditing();
    text.selectAll();
    canvas.requestRenderAll();
  }

  async function restore(snapshotText: string): Promise<void> {
    if (restoring) return;
    restoring = true;
    try {
      await canvas.loadFromJSON(snapshotText);
      canvas.backgroundColor = '#ffffff';
      canvas.renderAll();
    } catch {
      setStatus('恢复画板历史失败，请重试。');
    } finally {
      restoring = false;
      applyTool();
      updateActions();
    }
  }

  function undo(): void {
    if (restoring || historyIndex <= 0) return;
    exitTextEditing(true);
    historyIndex -= 1;
    void restore(history[historyIndex] ?? '');
  }

  function redo(): void {
    if (restoring || historyIndex >= history.length - 1) return;
    exitTextEditing(true);
    historyIndex += 1;
    void restore(history[historyIndex] ?? '');
  }

  function clearAll(): void {
    if (canvas.getObjects().length === 0) return;
    exitTextEditing(false);
    for (const object of canvas.getObjects()) canvas.remove(object);
    canvas.discardActiveObject();
    canvas.backgroundColor = '#ffffff';
    canvas.requestRenderAll();
    snapshot();
    updateActions();
    clearStatus();
  }

  async function insert(): Promise<void> {
    if (closed || insertButton.disabled) return;
    exitTextEditing(true);
    removeEmptyTexts();
    if (canvas.getObjects().length === 0) {
      setStatus('画板还是空的，请先画点什么。');
      updateActions();
      return;
    }
    insertButton.disabled = true;
    clearStatus();
    try {
      const blob = await canvas.toBlob({
        format: 'png',
        multiplier: 1,
        enableRetinaScaling: true,
      });
      if (!blob) throw new Error('empty png');
      const file = new File([blob], `drawing-${Date.now()}.png`, { type: 'image/png' });
      close();
      options.onInsert(file);
    } catch {
      insertButton.disabled = false;
      setStatus('生成图片失败，请重试。');
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const active = canvas.getActiveObject();
      if (active instanceof IText && active.isEditing) {
        active.exitEditing();
        return;
      }
      close();
      return;
    }
    const modifier = event.metaKey || event.ctrlKey;
    if (!modifier || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) redo();
      else undo();
    } else if (key === 'y') {
      event.preventDefault();
      event.stopPropagation();
      redo();
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    activeClose = null;
    window.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    style.remove();
    document.body.style.overflow = previousOverflow;
    void canvas.dispose().catch(() => undefined);
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
  }

  canvas.on('mouse:down', (event) => {
    if (canvas.isDrawingMode) return;
    if (tool === 'text') {
      const active = canvas.getActiveObject();
      if (active instanceof IText && active.isEditing) {
        active.exitEditing();
        return;
      }
      beginText(scenePoint(event.e));
      return;
    }
    beginShape(scenePoint(event.e));
  });
  canvas.on('mouse:move', (event) => {
    if (!shape) return;
    updateShape(scenePoint(event.e));
  });
  canvas.on('mouse:up', () => {
    finishShape();
  });
  canvas.on('path:created', () => {
    snapshot();
    updateActions();
  });
  canvas.on('text:editing:exited', (event) => {
    const target = event.target;
    if (!(target instanceof IText)) return;
    if (target.text.trim() === '') {
      canvas.remove(target);
      canvas.requestRenderAll();
      return;
    }
    target.setCoords();
    snapshot();
    updateActions();
  });

  for (const button of overlay.querySelectorAll<HTMLButtonElement>('[data-db-tool]')) {
    button.addEventListener('click', () => {
      const next = button.dataset.dbTool as DrawTool | undefined;
      if (next) setTool(next);
    });
  }
  for (const swatch of overlay.querySelectorAll<HTMLButtonElement>('[data-db-color]')) {
    swatch.addEventListener('click', () => {
      const next = swatch.dataset.dbColor;
      if (next) setColor(next);
    });
  }
  widthInput.addEventListener('input', () => {
    strokeWidth = Math.max(1, Math.min(16, Number(widthInput.value) || 4));
    if (tool === 'pen' || tool === 'eraser') applyTool();
  });
  undoButton.addEventListener('click', undo);
  redoButton.addEventListener('click', redo);
  clearButton.addEventListener('click', clearAll);
  cancelButton.addEventListener('click', close);
  insertButton.addEventListener('click', () => {
    void insert();
  });
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener('keydown', onKeyDown, true);

  applyTool();
  snapshot();
  updateActions();
  pick<HTMLButtonElement>('[data-db-tool="pen"]').focus();
  activeClose = close;
  return { close };
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`drawboard missing ${selector}`);
  return element;
}
