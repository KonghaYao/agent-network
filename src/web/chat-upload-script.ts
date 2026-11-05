/**
 * 输入框附件入口：左侧“+”按钮、隐藏文件选择器与粘贴图片上传。
 *
 * 与 `CHAT_FILES_ACTIONS_SCRIPT` 拼进同一个内联 `<script>` 共享作用域；
 * 上传本身完全复用 `enqueueDroppedFiles`（`POST /mcp-upload` → bind → 插入公开 URL），
 * 不复制上传逻辑，也不自动发送。
 */
export const CHAT_UPLOAD_SCRIPT = `
const attachFileButton = document.getElementById('attach-file');
const attachFileInput = document.getElementById('composer-file-input');

/** 上传队列忙碌时只做视觉提示，不禁用按钮或输入框；输入仍可继续排队。 */
function updateAttachBusy() {
  if (!attachFileButton) return;
  const busy = filesUploadRunning || filesUploadTasks.length > 0;
  attachFileButton.classList.toggle('busy', busy);
  attachFileButton.setAttribute('aria-busy', busy ? 'true' : 'false');
  attachFileButton.title = busy ? '正在上传文件…' : '上传文件';
}

function composerUploadReady() {
  return Boolean(activeRoomId) && document.body.classList.contains('page-room');
}

function insertAttachFiles(fileList) {
  const files = Array.prototype.slice.call(fileList || []).filter(function (file) {
    return file && typeof file.name === 'string' && file.name.length > 0;
  });
  if (files.length === 0) return;
  if (!composerUploadReady()) {
    setDropStatus('请先打开一个会话再上传文件。');
    return;
  }
  enqueueDroppedFiles(files);
}

/** 只收集剪贴板中的 image/*；纯文本或其他类型保持浏览器默认行为。 */
function clipboardImageFiles(event) {
  const data = event.clipboardData;
  if (!data) return [];
  const files = [];
  const seen = new Set();
  function push(file) {
    if (!file || !file.name || !file.type || file.type.indexOf('image/') !== 0) return;
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
  }
  const direct = Array.prototype.slice.call(data.files || []);
  direct.forEach(push);
  if (files.length === 0) {
    const items = Array.prototype.slice.call(data.items || []);
    for (let index = 0; index < items.length; index += 1) {
      if (items[index].kind !== 'file') continue;
      push(items[index].getAsFile ? items[index].getAsFile() : null);
    }
  }
  return files;
}

if (attachFileButton && attachFileInput) {
  attachFileButton.addEventListener('click', function () {
    if (!composerUploadReady()) {
      setDropStatus('请先打开一个会话再上传文件。');
      return;
    }
    attachFileInput.click();
  });
  attachFileInput.addEventListener('change', function () {
    const picked = Array.prototype.slice.call(attachFileInput.files || []);
    // 先复制 FileList 再清空，允许再次选择同一文件；失败后也可直接重选。
    attachFileInput.value = '';
    insertAttachFiles(picked);
  });
  updateAttachBusy();
}

if (bodyInput) {
  bodyInput.addEventListener('paste', function (event) {
    const images = clipboardImageFiles(event);
    if (images.length === 0) return;
    event.preventDefault();
    insertAttachFiles(images);
  });
}
`;
