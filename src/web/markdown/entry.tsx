/**
 * AI 消息 Markdown 岛：React + Streamdown，只接管 `.bubble` 内的正文。
 *
 * - 不使用 `dangerouslySetInnerHTML`，不引入 `rehype-raw`；
 * - 先 `rehype-sanitize` 再 `rehype-harden`，链接协议白名单只留 http/https/mailto；
 * - 图片一律不渲染，文件预览由气泡外的文件卡片负责；
 * - `@名字` 只在非代码/非链接文本节点中高亮；
 * - 渲染异常由错误边界回退为纯文本，不记录消息正文。
 */

import {
  Children,
  Component,
  createContext,
  createElement,
  isValidElement,
  useContext,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { harden } from 'rehype-harden';
import type { PluggableList } from 'unified';
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type Components,
  type ExtraProps,
} from 'streamdown';

export interface MarkdownOptions {
  /** 已知成员名；按最长优先匹配 `@名字`。 */
  mentions?: string[];
}

export interface MarkdownHandle {
  update(text: string, options?: MarkdownOptions): void;
  destroy(): void;
}

type NodeProps = ExtraProps;
type AnchorProps = ComponentPropsWithoutRef<'a'> & NodeProps;
type ParagraphProps = ComponentPropsWithoutRef<'p'> & NodeProps;
type ListItemProps = ComponentPropsWithoutRef<'li'> & NodeProps;
type CellProps = ComponentPropsWithoutRef<'td'> & NodeProps;
type HeaderCellProps = ComponentPropsWithoutRef<'th'> & NodeProps;
type QuoteProps = ComponentPropsWithoutRef<'blockquote'> & NodeProps;
type StrongProps = ComponentPropsWithoutRef<'strong'> & NodeProps;
type EmphasisProps = ComponentPropsWithoutRef<'em'> & NodeProps;
type DeleteProps = ComponentPropsWithoutRef<'del'> & NodeProps;
type PreProps = ComponentPropsWithoutRef<'pre'> & NodeProps;
type CodeProps = ComponentPropsWithoutRef<'code'> & NodeProps;
type TableProps = ComponentPropsWithoutRef<'table'> & NodeProps;
type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

const MentionContext = createContext<string[]>([]);

/** 只允许无凭据的 http/https、mailto、同源路径与页内片段。 */
function safeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (!href) return null;
  if (href.startsWith('#')) return href;
  if (href.startsWith('/')) {
    try {
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin) return null;
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return null;
    }
  }
  try {
    const url = new URL(href, location.origin);
    if (url.protocol === 'mailto:') return href;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return href;
  } catch {
    return null;
  }
}

function normalizeMentions(options: MarkdownOptions | undefined): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of options?.mentions ?? []) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.sort((a, b) => b.length - a.length);
}

/** 把纯文本按已知成员名切分为文本节点与 mention span。 */
function mentionText(text: string, names: string[]): ReactNode {
  if (names.length === 0 || text.indexOf('@') < 0) return text;
  const parts: ReactNode[] = [];
  let index = 0;
  let key = 0;
  while (index < text.length) {
    const at = text.indexOf('@', index);
    if (at < 0) break;
    let matched: string | null = null;
    for (const name of names) {
      if (text.startsWith(name, at + 1)) {
        matched = name;
        break;
      }
    }
    if (!matched) {
      index = at + 1;
      continue;
    }
    if (at > index) parts.push(text.slice(index, at));
    parts.push(
      <span className="mention" key={`mention-${key}`}>
        @{matched}
      </span>,
    );
    key += 1;
    index = at + 1 + matched.length;
  }
  if (parts.length === 0) return text;
  if (index < text.length) parts.push(text.slice(index));
  return parts;
}

function isSkippedElement(type: unknown): boolean {
  return type === Anchor || type === MarkdownPre || type === MarkdownCode || type === InlineCode;
}

/** 递归处理 React 子节点；代码块、行内代码与链接保持原样。 */
function applyMentions(children: ReactNode, names: string[]): ReactNode {
  if (names.length === 0) return children;
  return Children.map(children, (child) => {
    if (typeof child === 'string') return mentionText(child, names);
    if (!isValidElement(child)) return child;
    if (isSkippedElement(child.type)) return child;
    const props = child.props as { children?: ReactNode; className?: string };
    if (typeof props.className === 'string' && props.className.includes('mention')) {
      return child;
    }
    if (props.children === undefined) return child;
    return cloneWithChildren(child, applyMentions(props.children, names));
  });
}

function cloneWithChildren(element: ReactElement, children: ReactNode): ReactElement {
  return createElement(
    element.type as ComponentType<Record<string, unknown>>,
    { ...(element.props as Record<string, unknown>), children },
  );
}

function MentionedParagraph({ node: _node, children, ...rest }: ParagraphProps) {
  return <p {...rest}>{applyMentions(children, useContext(MentionContext))}</p>;
}

function MentionedListItem({ node: _node, children, ...rest }: ListItemProps) {
  return <li {...rest}>{applyMentions(children, useContext(MentionContext))}</li>;
}

function MentionedCell({ node: _node, children, ...rest }: CellProps) {
  return <td {...rest}>{applyMentions(children, useContext(MentionContext))}</td>;
}

function MentionedHeaderCell({ node: _node, children, ...rest }: HeaderCellProps) {
  return <th {...rest}>{applyMentions(children, useContext(MentionContext))}</th>;
}

function MentionedQuote({ node: _node, children, ...rest }: QuoteProps) {
  return <blockquote {...rest}>{applyMentions(children, useContext(MentionContext))}</blockquote>;
}

function MentionedStrong({ node: _node, children, ...rest }: StrongProps) {
  return <strong {...rest}>{applyMentions(children, useContext(MentionContext))}</strong>;
}

function MentionedEmphasis({ node: _node, children, ...rest }: EmphasisProps) {
  return <em {...rest}>{applyMentions(children, useContext(MentionContext))}</em>;
}

function MentionedDelete({ node: _node, children, ...rest }: DeleteProps) {
  return <del {...rest}>{applyMentions(children, useContext(MentionContext))}</del>;
}

function headingComponent(
  tag: HeadingTag,
): ComponentType<ComponentPropsWithoutRef<'h1'> & NodeProps> {
  function MentionedHeading({
    node: _node,
    children,
    ...rest
  }: ComponentPropsWithoutRef<'h1'> & NodeProps) {
    return createElement(tag, rest, applyMentions(children, useContext(MentionContext)));
  }
  return MentionedHeading;
}

/** 危险协议不生成 href，只保留文本。 */
function Anchor({ node: _node, href, children, ...rest }: AnchorProps) {
  const safe = safeHref(href);
  if (!safe) return <span className="md-link-blocked">{children}</span>;
  return (
    <a
      {...rest}
      href={safe}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
    >
      {children}
    </a>
  );
}

/** Markdown 图片不加载；文件预览统一走气泡外的文件卡片。 */
function BlockedImage(_props: ComponentPropsWithoutRef<'img'> & NodeProps) {
  return null;
}

function MarkdownPre({ node: _node, className, children, ...rest }: PreProps) {
  return (
    <pre {...rest} className={className ? `md-pre ${className}` : 'md-pre'}>
      {children}
    </pre>
  );
}

function MarkdownCode({ node: _node, className, children, ...rest }: CodeProps) {
  return (
    <code {...rest} className={className ? `md-code ${className}` : 'md-code'}>
      {children}
    </code>
  );
}

function InlineCode({ node: _node, className, children, ...rest }: CodeProps) {
  return (
    <code {...rest} className={className ? `md-code-inline ${className}` : 'md-code-inline'}>
      {children}
    </code>
  );
}

function MarkdownTable({ node: _node, className, children, ...rest }: TableProps) {
  return (
    <div className="md-table-wrap">
      <table {...rest} className={className ? `md-table ${className}` : 'md-table'}>
        {children}
      </table>
    </div>
  );
}

const components: Components = {
  a: Anchor,
  img: BlockedImage,
  p: MentionedParagraph,
  li: MentionedListItem,
  td: MentionedCell,
  th: MentionedHeaderCell,
  blockquote: MentionedQuote,
  strong: MentionedStrong,
  em: MentionedEmphasis,
  del: MentionedDelete,
  h1: headingComponent('h1'),
  h2: headingComponent('h2'),
  h3: headingComponent('h3'),
  h4: headingComponent('h4'),
  h5: headingComponent('h5'),
  h6: headingComponent('h6'),
  pre: MarkdownPre,
  code: MarkdownCode,
  inlineCode: InlineCode,
  table: MarkdownTable,
};

const remarkPlugins: PluggableList = [
  defaultRemarkPlugins.gfm!,
  defaultRemarkPlugins.codeMeta!,
];

/** sanitize 在前、harden 在后；刻意省略 `defaultRehypePlugins.raw`。 */
const rehypePlugins: PluggableList = [
  defaultRehypePlugins.sanitize!,
  [
    harden,
    {
      allowedProtocols: ['http', 'https', 'mailto'],
      allowedLinkPrefixes: ['*'],
      allowedImagePrefixes: [],
      allowDataImages: false,
      defaultOrigin: location.origin,
    },
  ],
];

function MarkdownBody({ text, options }: { text: string; options: MarkdownOptions }) {
  const mentions = normalizeMentions(options);
  return (
    <MentionContext.Provider value={mentions}>
      <Streamdown
        mode="static"
        parseIncompleteMarkdown={false}
        animated={false}
        controls={false}
        lineNumbers={false}
        linkSafety={{ enabled: false }}
        tableMaxHeight={0}
        codeBlockMaxHeight={0}
        components={components}
        remarkPlugins={[...remarkPlugins]}
        rehypePlugins={[...rehypePlugins]}
      >
        {text}
      </Streamdown>
    </MentionContext.Provider>
  );
}

interface BoundaryProps {
  text: string;
  children: ReactNode;
}

class MarkdownErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    // 只回退纯文本，不输出正文、凭据或成员名。
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <div className="md-fallback">{this.props.text}</div>;
    }
    return this.props.children;
  }
}

function MarkdownRoot({ text, options }: { text: string; options: MarkdownOptions }) {
  return (
    <MarkdownErrorBoundary text={text}>
      <MarkdownBody text={text} options={options} />
    </MarkdownErrorBoundary>
  );
}

/**
 * 在气泡内挂载 Markdown；成功后移除调用方预先写入的纯文本回退。
 * 返回 null 表示挂载失败，调用方继续保留纯文本。
 */
export function mountMarkdown(
  element: HTMLElement,
  text: string,
  options: MarkdownOptions = {},
): MarkdownHandle | null {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-markdown';
  element.append(wrapper);
  const root = createRoot(wrapper);
  let active = true;
  let currentText = text;
  let currentOptions = options;

  const render = (): void => {
    flushSync(() => {
      root.render(<MarkdownRoot text={currentText} options={currentOptions} />);
    });
  };

  try {
    render();
  } catch {
    active = false;
    try {
      root.unmount();
    } catch {
      // 挂载失败时按未挂载处理。
    }
    wrapper.remove();
    return null;
  }

  for (const child of Array.from(element.childNodes)) {
    if (child !== wrapper) child.remove();
  }

  return {
    update(nextText: string, nextOptions?: MarkdownOptions): void {
      if (!active) return;
      currentText = nextText;
      if (nextOptions) currentOptions = nextOptions;
      try {
        render();
      } catch {
        // 更新失败保留上一帧，不影响消息与文件卡片。
      }
    },
    destroy(): void {
      if (!active) return;
      active = false;
      try {
        root.unmount();
      } catch {
        // 已卸载或随气泡一起移除。
      }
      wrapper.remove();
    },
  };
}
