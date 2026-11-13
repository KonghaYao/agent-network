import { Fragment, useMemo, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  base64SizeLabel,
  splitBase64Segments,
} from '../../lib/chat';
import { copyText } from '../../lib/files';

/**
 * 人类纯文本：@ 高亮 + base64 折叠，不使用 Markdown/HTML 注入。
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function MentionText({ text, mentions }: { text: string; mentions: string[] }) {
  const parts = useMemo(() => {
    if (!text) return [] as { text: string; mention: boolean }[];
    const names = mentions.filter(Boolean);
    if (names.length === 0) return [{ text, mention: false }];
    const pattern = new RegExp(`(@(?:${names.map(escapeRegExp).join('|')}))`, 'gu');
    const result: { text: string; mention: boolean }[] = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > last) result.push({ text: text.slice(last, index), mention: false });
      result.push({ text: match[0], mention: true });
      last = index + match[0].length;
    }
    if (last < text.length) result.push({ text: text.slice(last), mention: false });
    return result;
  }, [text, mentions]);

  return (
    <>
      {parts.map((part, index) =>
        part.mention ? (
          <span className="mention" key={`m-${index}`}>
            {part.text}
          </span>
        ) : (
          <span key={`t-${index}`}>{part.text}</span>
        ),
      )}
    </>
  );
}

function Base64Block({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const preview = text.slice(0, LIMITS.webBase64PreviewChars);
  const handleCopy = async () => {
    try {
      await copyText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  return (
    <div className={`msg-base64${expanded ? ' is-expanded' : ''}`} data-base64-length={text.length}>
      <div className="msg-base64-head">
        <span className="msg-base64-title">{base64SizeLabel(text)}</span>
        <span className="msg-base64-actions">
          <button
            type="button"
            className="msg-base64-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起' : '查看'}
          </button>
          <button type="button" className="msg-base64-copy" onClick={() => void handleCopy()}>
            复制
          </button>
          <span className="msg-base64-status" role="status" aria-live="polite">
            {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : ''}
          </span>
        </span>
      </div>
      <div className="msg-base64-body">
        <pre>{expanded ? text : preview}</pre>
      </div>
    </div>
  );
}

export function HumanBody({ text, mentions }: { text: string; mentions: string[] }) {
  const segments = useMemo(() => splitBase64Segments(text), [text]);
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={`seg-${index}`}>
          {segment.base64 ? (
            <Base64Block text={segment.text} />
          ) : (
            <MentionText text={segment.text} mentions={mentions} />
          )}
          {index < segments.length - 1 ? '\n' : null}
        </Fragment>
      ))}
    </>
  );
}
