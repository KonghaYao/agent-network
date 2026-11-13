import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';

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
import type { SendOutcome } from '../../hooks/useSendQueue';

const DRAFT_PREFIX = 'agent-network-draft-v1:';
const MAX_TEXTAREA_HEIGHT = 96;
const MENTION_LIMIT = 20;

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

interface MentionState {
  start: number;
  end: number;
  items: RoomMember[];
  active: number;
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
  const [mention, setMention] = useState<MentionState | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [localSending, setLocalSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);

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

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const height = Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT);
    element.style.height = `${height}px`;
    element.style.overflowY = element.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  const uploading = files.some((file) => file.status === 'uploading');
  const busy = sending || localSending;
  const readyFiles = files.filter((file) => file.status === 'ready' && file.publicUrl);
  const canSend = !busy && !uploading && !room.read_only && (text.trim().length > 0 || readyFiles.length > 0);

  const candidateMembers = useCallback(
    (query: string) => {
      const lower = query.toLowerCase();
      const items: RoomMember[] = [];
      for (const member of members.values()) {
        if (member.actor_id === identity.actor_id) continue;
        if (lower && !member.name.toLowerCase().includes(lower)) continue;
        items.push(member);
        if (items.length >= MENTION_LIMIT) break;
      }
      return items;
    },
    [members, identity.actor_id],
  );

  const refreshMention = useCallback(
    (value: string, caret: number) => {
      if (room.kind !== 'group') {
        setMention(null);
        return;
      }
      const before = value.slice(0, caret);
      const match = /@([^\s@]*)$/u.exec(before);
      if (!match) {
        setMention(null);
        return;
      }
      const query = match[1] ?? '';
      const items = candidateMembers(query);
      const start = caret - query.length - 1;
      setMention((previous) => ({
        start,
        end: caret,
        items,
        active: previous && previous.start === start ? Math.min(previous.active, items.length - 1) : 0,
      }));
    },
    [candidateMembers, room.kind],
  );

  const insertMention = (member: RoomMember) => {
    if (!mention) return;
    const value = `${text.slice(0, mention.start)}@${member.name} ${text.slice(mention.end)}`;
    const caret = mention.start + member.name.length + 2;
    setText(value);
    setSelections((previous) => {
      const next = previous.filter((item) => item.actor_id !== member.actor_id);
      next.push({ actor_id: member.actor_id, name: member.name, kind: member.kind });
      return next;
    });
    setMention(null);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  const updateFile = (fileKey: string, patch: Partial<ComposerFile>) => {
    setFiles((previous) =>
      previous.map((file) => (file.key === fileKey ? { ...file, ...patch } : file)),
    );
  };

  const addFiles = (fileList: FileList | File[]) => {
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
  };

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
    const native = event.nativeEvent;
    const composing = composingRef.current || native.isComposing || native.keyCode === 229;
    if (composing) return;
    if (event.key === 'Enter' && Date.now() - compositionEndedAtRef.current < 80) {
      event.preventDefault();
      return;
    }
    if (mention) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setMention((previous) => {
          if (!previous || previous.items.length === 0) return previous;
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          return {
            ...previous,
            active:
              (previous.active + direction + previous.items.length) % previous.items.length,
          };
        });
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const target = mention.items[mention.active];
        if (target) insertMention(target);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setText(value);
    const caret = event.target.selectionStart ?? value.length;
    if (!composingRef.current) refreshMention(value, caret);
  };

  const mentionOptions = mention?.items ?? [];

  return (
    <>
      <div
        id="mention-picker"
        className="mention-picker"
        role="listbox"
        aria-label="选择要 @ 的成员"
        hidden={mention === null}
      >
        {mention && mentionOptions.length === 0 ? (
          <p className="list-hint">
            {(mention ? text.slice(mention.start + 1, mention.end) : '') ? '没有匹配成员' : '房间还没有其他成员'}
          </p>
        ) : null}
        {mentionOptions.map((member, index) => (
          <button
            key={member.actor_id}
            type="button"
            className={`mention-item${index === mention?.active ? ' keyboard-active' : ''}`}
            role="option"
            id={`mention-option-${member.actor_id.replace(/[^a-zA-Z0-9_-]/gu, '-')}`}
            data-actor-id={member.actor_id}
            aria-selected={index === mention?.active}
            style={{ backgroundColor: index === mention?.active ? 'var(--wx-hover)' : undefined }}
            onMouseDown={(event) => {
              event.preventDefault();
              insertMention(member);
            }}
          >
            <span>{member.name}</span>
            <span className="mention-kind">{member.kind === 'agent' ? 'Agent' : '人'}</span>
          </button>
        ))}
      </div>
      <form
        id="composer"
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <button
          className="attach-btn"
          id="attach-file"
          type="button"
          aria-label="添加附件"
          aria-haspopup="menu"
          aria-controls="attach-menu"
          aria-expanded={attachOpen}
          title="添加附件"
          disabled={room.read_only}
          onClick={() => setAttachOpen((value) => !value)}
        >
          +
        </button>
        <div className="attach-menu" id="attach-menu" role="menu" aria-label="添加附件" hidden={!attachOpen}>
          <button
            className="attach-menu-item"
            id="attach-menu-file"
            type="button"
            role="menuitem"
            onClick={() => {
              setAttachOpen(false);
              fileInputRef.current?.click();
            }}
          >
            上传文件
          </button>
        </div>
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
          <textarea
            id="body"
            ref={textareaRef}
            rows={1}
            maxLength={LIMITS.messageBodyBytes}
            placeholder="输入消息…"
            aria-label="消息正文"
            aria-controls="mention-picker"
            aria-expanded={mention !== null}
            aria-activedescendant={
              mention && mention.items[mention.active]
                ? `mention-option-${mention.items[mention.active]!.actor_id.replace(/[^a-zA-Z0-9_-]/gu, '-')}`
                : undefined
            }
            value={text}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => {
              if (composingRef.current) return;
              const caret = event.currentTarget.selectionStart ?? text.length;
              refreshMention(text, caret);
            }}
            onClick={(event) => {
              if (composingRef.current) return;
              refreshMention(text, event.currentTarget.selectionStart ?? text.length);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              compositionEndedAtRef.current = Date.now();
              const element = textareaRef.current;
              if (element) {
                refreshMention(element.value, element.selectionStart ?? element.value.length);
              }
            }}
          />
        </div>
        <button className="send-btn primary" id="send" type="submit" disabled={!canSend}>
          发送
        </button>
      </form>
    </>
  );
}
