/**
 * 原生 `<dialog>` 共享帮助函数：统一打开、关闭、Esc、背板点击与焦点恢复。
 *
 * 所有片段拼进应用页同一个 `<script>` 作用域；不引入框架，也不读取凭据。
 * `showModal()` 自带焦点陷阱与背景 inert，关闭时浏览器把焦点还给触发元素；
 * 这里只补 Esc/背板统一走业务清理，避免只关闭 DOM 而留下过期内存状态。
 */
export const CHAT_DIALOG_SCRIPT = `
/**
 * 打开模态对话框，并登记 Esc/背板关闭时的业务清理函数。
 * 已打开的对话框保持原状，避免重复 showModal() 抛错或叠加遮罩。
 */
function openNativeDialog(dialog, onRequestClose) {
  if (!dialog || typeof dialog.showModal !== 'function' || dialog.open) return;
  if (typeof onRequestClose === 'function') dialog.__closeRequest = onRequestClose;
  dialog.showModal();
}

/** 关闭对话框；业务清理由调用方在 close() 之后执行，避免递归。 */
function closeNativeDialog(dialog) {
  if (!dialog || !dialog.open) return;
  dialog.__closeRequest = null;
  dialog.close();
}

/** Esc 或点击背板时优先走业务清理，保证 DOM 与页面状态同步。 */
function requestNativeDialogClose(dialog) {
  if (!dialog || !dialog.open) return;
  const handler = dialog.__closeRequest;
  if (typeof handler === 'function') handler();
  else dialog.close();
}

/** 存在模态对话框时，背景浮层不得响应点击/Esc，否则会抢走顶层交互。 */
function nativeDialogOpen() {
  return Boolean(document.querySelector('dialog[open]'));
}

document.addEventListener('cancel', function (event) {
  const dialog = event.target;
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return;
  event.preventDefault();
  requestNativeDialogClose(dialog);
}, true);

document.addEventListener('click', function (event) {
  const dialog = event.target;
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return;
  if (dialog.dataset.backdropClose === 'false') return;
  requestNativeDialogClose(dialog);
}, true);

// 中文输入法组合期间 Esc 只结束候选窗，不关闭对话框。
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape' || (!event.isComposing && event.keyCode !== 229)) return;
  event.preventDefault();
  event.stopPropagation();
}, true);
`;
