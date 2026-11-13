import { useEffect, useRef, useState } from 'react';

/**
 * AI 消息 Markdown 岛：复用 legacy `/assets/chat-markdown.js`。
 *
 * 不把 Streamdown 再打一份进聊天 chunk；该 bundle 已包含 sanitize、
 * rehype-harden、base64 折叠与安全链接属性。加载失败时回退纯文本并显示
 * 可见提示，不影响消息与文件卡片。
 */

const MARKDOWN_URL = '/assets/chat-markdown.js';

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

function loadMarkdown(): Promise<MarkdownModule | null> {
  if (!loadPromise) {
    loadPromise = import(/* @vite-ignore */ MARKDOWN_URL)
      .then((module) => {
        const candidate = module as Partial<MarkdownModule>;
        return typeof candidate.mountMarkdown === 'function'
          ? (candidate as MarkdownModule)
          : null;
      })
      .catch(() => {
        // 只记录资源路径，不输出正文、成员名或 token。
        console.warn(`markdown bundle unavailable: ${MARKDOWN_URL}`);
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
  textRef.current = text;
  optionsRef.current = { mentions, preview };

  useEffect(() => {
    let cancelled = false;
    void loadMarkdown().then((module) => {
      if (cancelled || !hostRef.current) return;
      if (!module) {
        setFailed(true);
        return;
      }
      const handle = module.mountMarkdown(hostRef.current, textRef.current, optionsRef.current);
      if (!handle) {
        setFailed(true);
        return;
      }
      handleRef.current = handle;
    });
    return () => {
      cancelled = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    handleRef.current?.update(text, { mentions, preview });
  }, [text, mentions, preview]);

  if (failed) {
    return (
      <div className="msg-markdown">
        <span className="md-unavailable">Markdown 渲染不可用，已显示纯文本</span>
        <div className="md-fallback">{text}</div>
      </div>
    );
  }
  return <div className="msg-markdown" ref={hostRef} />;
}
