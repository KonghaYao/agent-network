import { Button } from '../../app/lenso-controls';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { requestSafeUpdate, useUpdateState } from '../../pwa/update-store';
import { BodyPendingContext } from './body-pending';

/**
 * AI 消息 Markdown 岛：复用 legacy `/assets/chat-markdown.js`。
 *
 * 不把 Streamdown 再打一份进聊天 chunk；该 bundle 已包含 sanitize、
 * rehype-harden、base64 折叠与安全链接属性。加载失败时回退纯文本并显示
 * 可见提示，不影响消息与文件卡片。
 */

/**
 * 发布构建注入本版本自己的哈希 URL；开发构建为空，回退到固定别名。
 * 固定别名在迁移时冻结到基线，不会跟随新发布改变。
 */
const MARKDOWN_URL =
  typeof __WEB_MARKDOWN_URL__ === 'string' && __WEB_MARKDOWN_URL__.length > 0
    ? __WEB_MARKDOWN_URL__
    : '/assets/chat-markdown.js';

interface MarkdownHandle {
  update(text: string, options?: { mentions?: string[]; preview?: boolean }): void;
  destroy(): void;
}

interface MarkdownModule {
  mountMarkdown(
    element: HTMLElement,
    text: string,
    options?: { mentions?: string[]; preview?: boolean },
  ): MarkdownHandle | null;
}

let loadPromise: Promise<MarkdownModule | null> | null = null;
let loadRetry = 0;

function loadMarkdown(forceRetry: boolean): Promise<MarkdownModule | null> {
  if (!loadPromise || forceRetry) {
    if (forceRetry) loadRetry += 1;
    const url = forceRetry ? `${MARKDOWN_URL}?r=${loadRetry}` : MARKDOWN_URL;
    loadPromise = import(/* @vite-ignore */ url)
      .then((module) => {
        const candidate = module as Partial<MarkdownModule>;
        return typeof candidate.mountMarkdown === 'function'
          ? (candidate as MarkdownModule)
          : null;
      })
      .catch(() => {
        // 只记录资源路径，不输出正文、成员名或 token。
        console.warn(`markdown bundle unavailable: ${MARKDOWN_URL}`);
        loadPromise = null;
        return null;
      });
  }
  return loadPromise;
}

export function MarkdownIsland({
  text,
  mentions,
  preview,
}: {
  text: string;
  mentions: string[];
  preview: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<MarkdownHandle | null>(null);
  const textRef = useRef(text);
  const optionsRef = useRef({ mentions, preview });
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pendingRegistry = useContext(BodyPendingContext);
  const update = useUpdateState();
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const canUpdate =
    online && (update.phase === 'available' || update.phase === 'incompatible');
  textRef.current = text;
  optionsRef.current = { mentions, preview };

  // 注册必须发生在绘制前：入口 reveal 的 rAF 采样在同一帧读取计数，
  // 若用 passive effect 注册会留下一帧“已挂载但计数为 0”的窗口。
  useLayoutEffect(() => {
    let cancelled = false;
    const releasePending = pendingRegistry?.begin();
    let released = false;
    const finishPending = () => {
      if (released) return;
      released = true;
      releasePending?.();
    };
    void loadMarkdown(attempt > 0).then((module) => {
      if (cancelled || !hostRef.current) {
        finishPending();
        return;
      }
      if (!module) {
        setFailed(true);
        finishPending();
        return;
      }
      const handle = module.mountMarkdown(hostRef.current, textRef.current, optionsRef.current);
      if (!handle) {
        setFailed(true);
        finishPending();
        return;
      }
      setFailed(false);
      handleRef.current = handle;
      // Markdown 已同步挂载到 DOM；高度测量与贴底交给 ResizeObserver
      // 和 layout effect，pending 只表示“正文尚未出现”。
      finishPending();
    });
    return () => {
      cancelled = true;
      handleRef.current?.destroy();
      handleRef.current = null;
      finishPending();
    };
  }, [attempt, pendingRegistry]);

  useEffect(() => {
    handleRef.current?.update(text, { mentions, preview });
  }, [text, mentions, preview]);

  if (failed) {
    return (
      <div className="msg-markdown">
        <span className="md-unavailable" role="status">
          Markdown 渲染不可用，已显示纯文本
        </span>
        <div className="md-fallback">{text}</div>
        <div className="md-unavailable-actions">
          <Button
            type="button"
            id="markdown-retry"
            size="sm"
            variant="bordered"
            onClick={() => {
              setFailed(false);
              setAttempt((value) => value + 1);
            }}
          >
            重试
          </Button>
          {canUpdate ? (
            <Button
              type="button"
              id="markdown-update-retry"
              size="sm"
              variant="borderless"
              onClick={() => void requestSafeUpdate()}
            >
              更新后重试
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  return <div className="msg-markdown" ref={hostRef} />;
}
