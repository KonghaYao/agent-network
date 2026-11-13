import * as Ariakit from '@ariakit/react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';

import { LIMITS } from '../../../contracts/limits';
import {
  composeMessageBody,
  messageBodyBytes,
  type MentionSelection,
  type RoomMember,
  type RoomView,
} from '../../lib/chat';
import {
  bindFileToRoom,
  fileBadge,
  formatFileSize,
  uploadFileToDrive,
} from '../../lib/files';
import { callTool } from '../../lib/mcp-client';
import type { WebIdentity } from '../../lib/identity';
import {
  findMentionQuery,
  insertMention,
  mentionCandidates,
  pruneSelections,
  upsertSelection,
  type MentionQuery,
} from '../../lib/mentions';
import type { SendOutcome } from '../../hooks/useSendQueue';

const DRAFT_PREFIX = 'agent-network-draft-v1:';
const MAX_TEXTAREA_HEIGHT = 96;

interface ComposerFile {
  key: string;
  name: string;
  size: number;
  mime: string;
  status: 'uploading' | 'ready' | 'failed';
  percent: number;
  phase: 'upload' | 'join';
  fileId: string | null;
  publicUrl: string | null;
  error: string;
}

export interface ComposerSendInput {
  text: string;
  urls: string[];
  selections: MentionSelection[];
}

interface ComposerProps {
  room: RoomView;
  members: Map<string, RoomMember>;
  identity: WebIdentity;
  token: string;
  reply: { messageId: string; label: string } | null;
  sending: boolean;
  onCancelReply: () => void;
  onSend: (input: ComposerSendInput) => Promise<SendOutcome>;
  onStatus: (message: string) => void;
}

function draftKey(actorId: string, roomId: string): string {
  return `${DRAFT_PREFIX}${actorId}:${roomId}`;
}

function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function saveDraft(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // 隐私模式只影响草稿记忆。
  }
}

function fileMeta(file: ComposerFile): string {
  if (file.status === 'uploading') {
    return file.phase === 'join' ? '正在加入房间…' : `上传中 ${file.percent}%`;
  }
  if (file.status === 'failed') return file.error || '上传失败';
  return formatFileSize(file.size);
}

/**
 * 输入区：IME、1–4 行自适应、@ 提及、附件上传与拖放。
 *
 * - 提及用 Ariakit Combobox，textarea 不替换；组合输入期间不打开候选；
 * - 附件仍走 XHR 上传进度与 `network_room_file_bind`；
 * - react-dropzone 只接管拖拽/粘贴入口，点击上传保持原按钮。
 */
export function Composer({
  room,
  members,
  identity,
  token,
  reply,
  sending,
  onCancelReply,
  onSend,
  onStatus,
}: ComposerProps) {
  const key = draftKey(identity.actor_id, room.room_id);
  const [text, setText] = useState(() => readDraft(key));
  const [files, setFiles] = useState<ComposerFile[]>([]);
  const [selections, setSelections] = useState<MentionSelection[]>([]);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [localSending, setLocalSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const suppressEnterRef = useRef(false);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);

  const combobox = Ariakit.useComboboxStore({ defaultOpen: false });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setText(readDraft(key));
    setFiles([]);
    setSelections([]);
    setMention(null);
  }, [key]);

  useEffect(() => {
    saveDraft(key, text);
  }, [key, text]);

  // 插入提及后必须在本帧内把光标放到尾随空格之后；rAF 会晚于快速键入。
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(caret, caret);
    pendingCaretRef.current = null;
  }, [text]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const height = Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT);
    element.style.height = `${height}px`;
    element.style.overflowY = element.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  const comboboxOpen = Ariakit.useStoreState(combobox, 'open');
  const wasOpenRef = useRef(false);
  useEffect(() => {
    // 点击外部/焦点离开时 Ariakit 会自行关闭；同步清掉触发查询，避免
    // `hidden={mention === null}` 把已经关闭的浮层重新显示出来。
    if (wasOpenRef.current && !comboboxOpen) setMention(null);
    wasOpenRef.current = comboboxOpen;
  }, [comboboxOpen]);

  // 候选列表由 Ariakit 管 open/active id；这里只同步触发查询。
  useEffect(() => {
    if (mention) {
      combobox.setInputValue(mention.query);
      combobox.setOpen(true);
    } else {
      combobox.setOpen(false);
    }
  }, [combobox, mention]);

  const candidates = useMemo(
    () => (mention ? mentionCandidates(members, identity.actor_id, mention.query) : []),
    [mention, members, identity.actor_id],
  );

  const uploading = files.some((file) => file.status === 'uploading');
  const busy = sending || localSending;
  const readyFiles = files.filter((file) => file.status === 'ready' && file.publicUrl);
  const canSend = !busy && !uploading && !room.read_only && (text.trim().length > 0 || readyFiles.length > 0);

  const refreshMention = useCallback(
    (value: string, caret: number) => {
      if (room.kind !== 'group') {
        setMention(null);
        return;
      }
      setMention(findMentionQuery(value, caret));
    },
    [room.kind],
  );

  const pickMention = (member: RoomMember) => {
    if (!mention) return;
    const insertion = insertMention(text, mention, member);
    /*
     * Ariakit 可能在同一次 Enter 事件里先完成选择，再轮到我们的 keydown；
     * 如果此时 mention 已变成 null，就会把“选择”当成“发送”。用一次性
     * 标记挡住同一事件里的 Enter，宏任务结束后自动失效，不影响下一次。
     */
    suppressEnterRef.current = true;
    pendingCaretRef.current = insertion.caret;
    setText(insertion.text);
    setSelections((previous) => upsertSelection(previous, insertion.selection));
    setMention(null);
    combobox.setInputValue('');
    combobox.hide();
  };

  const updateFile = (fileKey: string, patch: Partial<ComposerFile>) => {
    setFiles((previous) =>
      previous.map((file) => (file.key === fileKey ? { ...file, ...patch } : file)),
    );
  };

  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      for (const file of incoming) {
        const fileKey = `cf_${crypto.randomUUID()}`;
        const entry: ComposerFile = {
          key: fileKey,
          name: file.name,
          size: file.size,
          mime: file.type,
          status: 'uploading',
          percent: 0,
          phase: 'upload',
          fileId: null,
          publicUrl: null,
          error: '',
        };
        setFiles((previous) => [...previous, entry]);
        void (async () => {
          try {
            const uploaded = await uploadFileToDrive(file, token, (percent) => {
              if (mountedRef.current) updateFile(fileKey, { percent });
            });
            if (mountedRef.current) updateFile(fileKey, { percent: 100, phase: 'join' });
            const bound = await bindFileToRoom(room.room_id, uploaded.file_id, token);
            if (!mountedRef.current) return;
            updateFile(fileKey, {
              status: 'ready',
              percent: 100,
              fileId: bound.file_id,
              publicUrl: bound.public_url,
              mime: bound.mime_type || file.type,
            });
          } catch (error) {
            if (!mountedRef.current) return;
            const message = (error as Error).message || '上传失败';
            updateFile(fileKey, { status: 'failed', error: message });
            onStatus(`上传「${file.name}」失败：${message}`);
          }
        })();
      }
    },
    [onStatus, room.room_id, token],
  );

  const { getRootProps, isDragActive } = useDropzone({
    noClick: true,
    noKeyboard: true,
    multiple: true,
    onDrop: addFiles,
  });

  const removeFile = async (file: ComposerFile) => {
    if (file.status === 'ready' && file.fileId) {
      try {
        await callTool(
          'network_room_file_delete',
          {
            request_id: `file_chip_delete_${crypto.randomUUID().replaceAll('-', '')}`,
            room_id: room.room_id,
            file_id: file.fileId,
          },
          { token },
        );
      } catch (error) {
        onStatus(`删除「${file.name}」失败：${(error as Error).message}`);
        return;
      }
    }
    setFiles((previous) => previous.filter((entry) => entry.key !== file.key));
  };

  const submit = async () => {
    if (sendingRef.current || !canSend) return;
    if (text.trim().length === 0 && readyFiles.length === 0) return;
    const urls = readyFiles.map((file) => file.publicUrl!).filter(Boolean);
    const body = composeMessageBody(text, urls);
    if (body.length === 0) return;
    if (messageBodyBytes(body) > LIMITS.messageBodyBytes) {
      onStatus('消息过长，请缩短后再发送');
      return;
    }
    const sentKeys = new Set(readyFiles.map((file) => file.key));
    sendingRef.current = true;
    setLocalSending(true);
    try {
      const result = await onSend({ text: text.trim(), urls, selections });
      if (!result.ok) {
        onStatus(result.error || '发送失败');
        return;
      }
      setText('');
      setSelections([]);
      setMention(null);
      setFiles((previous) => previous.filter((file) => !sentKeys.has(file.key)));
      saveDraft(key, '');
    } finally {
      sendingRef.current = false;
      setLocalSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 非 Enter 的按键说明已离开选择动作，清掉一次性标记。
    if (event.key !== 'Enter') suppressEnterRef.current = false;
    if (event.key === 'Enter' && suppressEnterRef.current) {
      event.preventDefault();
      return;
    }
    const native = event.nativeEvent;
    const composing = composingRef.current || native.isComposing || native.keyCode === 229;
    if (composing) return;
    if (event.key === 'Enter' && Date.now() - compositionEndedAtRef.current < 80) {
      event.preventDefault();
      return;
    }
    if (mention) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        combobox.hide();
        return;
      }
      // 方向键与 Enter 交给 Ariakit 选择候选；不要在打开候选时发送。
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setText(value);
    setSelections((previous) => pruneSelections(previous, value, members));
    const caret = event.target.selectionStart ?? value.length;
    if (!composingRef.current) refreshMention(value, caret);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files ?? []);
    if (pasted.length === 0) return;
    event.preventDefault();
    addFiles(pasted);
  };

  return (
    <>
      <Ariakit.ComboboxPopover
        store={combobox}
        id="mention-picker"
        className="mention-picker spa-floating"
        aria-label="选择要 @ 的成员"
        hidden={mention === null}
        unmountOnHide
        fitViewport
        getAnchorRect={() => textareaRef.current?.getBoundingClientRect() ?? null}
      >
        {mention && candidates.length === 0 ? (
          <p className="list-hint">{mention.query ? '没有匹配成员' : '房间还没有其他成员'}</p>
        ) : null}
        {candidates.map((member) => (
          <Ariakit.ComboboxItem
            key={member.actor_id}
            className="mention-item"
            value={member.name}
            id={`mention-option-${member.actor_id.replace(/[^a-zA-Z0-9_-]/gu, '-')}`}
            data-actor-id={member.actor_id}
            focusOnHover
            onClick={() => pickMention(member)}
          >
            <span>{member.name}</span>
            <span className="mention-kind">{member.kind === 'agent' ? 'Agent' : '人'}</span>
          </Ariakit.ComboboxItem>
        ))}
      </Ariakit.ComboboxPopover>
      <form
        {...getRootProps({
          id: 'composer',
          className: 'composer',
          onSubmit: (event) => {
            event.preventDefault();
            void submit();
          },
        })}
      >
        <div id="composer-drop" className="composer-drop" hidden={!isDragActive}>
          <span className="composer-drop-title">松开上传附件</span>
          <span className="composer-drop-hint">支持拖拽多个文件，上传后随消息发送</span>
        </div>
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <button
              className="attach-btn"
              id="attach-file"
              type="button"
              aria-label="添加附件"
              aria-haspopup="menu"
              aria-controls="attach-menu"
              title="添加附件"
              disabled={room.read_only}
            >
              +
            </button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              id="attach-menu"
              className="attach-menu spa-menu"
              aria-label="添加附件"
              sideOffset={6}
              align="start"
            >
              <DropdownMenuPrimitive.Item
                className="attach-menu-item"
                id="attach-menu-file"
                onSelect={() => fileInputRef.current?.click()}
              >
                上传文件
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
        <input
          id="composer-file-input"
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <div className="composer-main">
          {reply ? (
            <div id="composer-reply" className="composer-reply">
              <span>引用 {reply.label}</span>
              <button type="button" aria-label="取消引用" onClick={onCancelReply}>
                ×
              </button>
            </div>
          ) : null}
          <div
            id="composer-files"
            className="composer-files"
            role="list"
            aria-label="待发送文件"
            hidden={files.length === 0}
          >
            {files.map((file) => (
              <div className="composer-file" role="listitem" key={file.key} data-file-id={file.fileId ?? ''}>
                <span className="composer-file-badge" aria-hidden="true">
                  {fileBadge(file.name)}
                </span>
                <span className="composer-file-main">
                  <span className="composer-file-name" title={file.name}>
                    {file.name}
                  </span>
                  <span className="composer-file-meta">{fileMeta(file)}</span>
                </span>
                <button
                  type="button"
                  className="composer-file-remove"
                  aria-label={`移除 ${file.name}`}
                  title={`移除 ${file.name}`}
                  disabled={file.status === 'uploading'}
                  onClick={() => void removeFile(file)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <Ariakit.Combobox
            store={combobox}
            value={text}
            setValueOnChange={false}
            showOnChange={false}
            showOnKeyPress={false}
            showOnClick={false}
            autoSelect
            render={
              <textarea
                id="body"
                ref={textareaRef}
                rows={1}
                maxLength={LIMITS.messageBodyBytes}
                placeholder="输入消息…"
                aria-label="消息正文"
                aria-controls="mention-picker"
                onChange={onChange}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onKeyUp={(event) => {
                  if (event.key === 'Enter' && suppressEnterRef.current) {
                    suppressEnterRef.current = false;
                    return;
                  }
                  if (composingRef.current) return;
                  const caret = event.currentTarget.selectionStart ?? text.length;
                  refreshMention(event.currentTarget.value, caret);
                }}
                onClick={(event) => {
                  if (composingRef.current) return;
                  refreshMention(
                    event.currentTarget.value,
                    event.currentTarget.selectionStart ?? text.length,
                  );
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={(event) => {
                  composingRef.current = false;
                  compositionEndedAtRef.current = Date.now();
                  const element = event.currentTarget;
                  refreshMention(element.value, element.selectionStart ?? element.value.length);
                }}
              />
            }
          />
        </div>
        <button className="send-btn primary" id="send" type="submit" disabled={!canSend}>
          发送
        </button>
      </form>
    </>
  );
}
