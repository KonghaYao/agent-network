/**
 * 发布构建注入本版本自己的哈希 URL；开发构建为空，回退到固定别名。
 * 绝不在打开画板时读取服务器“最新”模块，避免旧页混用新 API。
 */
const DRAWBOARD_ASSET_URL =
  typeof __WEB_DRAWBOARD_URL__ === 'string' && __WEB_DRAWBOARD_URL__.length > 0
    ? __WEB_DRAWBOARD_URL__
    : '/assets/chat-drawboard.js';

interface DrawboardModule {
  openDrawboard(options: {
    onInsert: (file: File) => void;
    onClose?: () => void;
  }): void;
}

let drawboardPromise: Promise<DrawboardModule> | null = null;
let drawboardRetry = 0;

/** 成功只请求一次；重试加 query 绕过浏览器失败缓存。 */
export function loadDrawboard(forceRetry: boolean): Promise<DrawboardModule> {
  if (!drawboardPromise || forceRetry) {
    if (forceRetry) drawboardRetry += 1;
    const url = forceRetry ? `${DRAWBOARD_ASSET_URL}?r=${drawboardRetry}` : DRAWBOARD_ASSET_URL;
    drawboardPromise = import(/* @vite-ignore */ url)
      .then((module: unknown) => {
        const candidate = module as Partial<DrawboardModule>;
        if (typeof candidate.openDrawboard !== 'function') {
          throw new Error('invalid drawboard bundle');
        }
        return candidate as DrawboardModule;
      })
      .catch((error: unknown) => {
        drawboardPromise = null;
        throw error;
      });
  }
  return drawboardPromise;
}
