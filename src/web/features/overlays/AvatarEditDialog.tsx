import { Button } from '../../app/lenso-controls';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';

import { LIMITS } from '../../../contracts/limits';
import { useWebSession } from '../../hooks/useWebSession';
import {
  patchActorAvatarCaches,
  rememberActorAvatars,
} from '../../lib/actor-avatars';
import { uploadFileToDrive } from '../../lib/files';
import {
  patchCachedIdentity,
  type WebIdentity,
  type WebSession,
} from '../../lib/identity';
import { callTool, type McpError } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';
import { ActorAvatar } from '../avatar/ActorAvatar';
import '../avatar/avatar-edit.css';
import { Modal } from './Modal';

const AVATAR_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

interface PreparedAvatar {
  blob: Blob;
  name: string;
}

function failureMessage(error: unknown): string {
  return (error as McpError).message || String(error);
}

/**
 * 居中裁剪为正方形并缩放到 512×512。
 *
 * 有透明通道的来源（PNG/GIF/WebP）输出 PNG，JPEG 输出质量 0.9；GIF 只取
 * 首帧，不生成动画头像。解码、绘制都在浏览器完成，原始文件不上传两次。
 */
async function prepareAvatarFile(file: File): Promise<PreparedAvatar> {
  if (!AVATAR_MIME_TYPES.has(file.type)) {
    throw new Error('只支持 PNG、JPEG、WebP 或 GIF 图片。');
  }
  if (file.size > LIMITS.webAvatarSourceMaxBytes) {
    throw new Error('图片不能超过 8 MB。');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('无法读取这张图片，请换一张重试。');
  }

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new Error('图片尺寸无效。');
    const size = LIMITS.webAvatarOutputSize;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理图片。');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
    const mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, mime, 0.9);
    });
    if (!blob) throw new Error('图片编码失败，请换一张重试。');
    return { blob, name: mime === 'image/jpeg' ? 'avatar.jpg' : 'avatar.png' };
  } finally {
    bitmap.close();
  }
}

/**
 * 修改头像：本地裁剪预览、上传、保存或移除。
 *
 * 关闭不保存不会改动服务端；上传成功后不绑定房间，也不调用
 * `network_file_publish`（头像本身不属于房间文件）。失败时保留预览与已上传
 * 的 file_id，用户可以直接重试保存。
 */
export function AvatarEditDialog({
  open,
  onOpenChange,
  identity,
  token,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  identity: WebIdentity;
  token: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const session = useWebSession();
  const actorId = session.session?.identity.actor_id ?? identity.actor_id;
  const [payload, setPayload] = useState<PreparedAvatar | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadedFileId, setUploadedFileId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const previewRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);

  const replacePreview = useCallback((next: string | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = next;
    setPreviewUrl(next);
  }, []);

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  useEffect(() => {
    replacePreview(null);
    setPayload(null);
    setUploadedFileId(null);
    setProcessing(false);
    setSaving(false);
    setStatus('');
    setError('');
  }, [open, replacePreview]);

  const applyAvatar = async (fileId: string | null): Promise<void> => {
    const updated = await callTool<WebIdentity>(
      'network_profile_update',
      {
        request_id: newRequestId('web_avatar_update'),
        ...(fileId === null ? { avatar_file_id: null } : { avatar_file_id: fileId }),
      },
      { token },
    );
    const avatarUrl = updated.avatar_url ?? null;
    const name = updated.name || identity.name;
    patchActorAvatarCaches(queryClient, actorId, avatarUrl);
    rememberActorAvatars([{ actor_id: actorId, name, avatar_url: avatarUrl }]);
    queryClient.setQueryData<WebSession>(queryKeys.session(), (current) =>
      current
        ? {
            ...current,
            identity: { ...current.identity, name, avatar_url: avatarUrl },
          }
        : current,
    );
    patchCachedIdentity({ name, avatar_url: avatarUrl });
    void queryClient.invalidateQueries({ queryKey: queryKeys.rooms(actorId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.contacts(actorId) });
    // 成员与历史 sender_avatar_url 在 'room' 前缀下；头像变化后按需重读。
    void queryClient.invalidateQueries({ queryKey: ['room'] });
  };

  const onChoose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || saving) return;
    setProcessing(true);
    setError('');
    setStatus('正在处理图片…');
    setUploadedFileId(null);
    try {
      const prepared = await prepareAvatarFile(file);
      replacePreview(URL.createObjectURL(prepared.blob));
      setPayload(prepared);
      setStatus('图片已裁剪为 512×512，保存后生效。');
    } catch (failure) {
      replacePreview(null);
      setPayload(null);
      setStatus('');
      setError(failureMessage(failure));
    } finally {
      setProcessing(false);
    }
  };

  const save = async () => {
    if (!payload || saving || processing) return;
    setSaving(true);
    setError('');
    let fileId = uploadedFileId;
    if (!fileId) {
      setStatus('正在上传…');
      try {
        const uploaded = await uploadFileToDrive(
          new File([payload.blob], payload.name, { type: payload.blob.type }),
          token,
          (percent) => setStatus(`正在上传… ${percent}%`),
        );
        fileId = uploaded.file_id;
        setUploadedFileId(fileId);
      } catch (failure) {
        setStatus('');
        setError(`上传失败：${failureMessage(failure)}`);
        setSaving(false);
        return;
      }
    }
    setStatus('正在保存…');
    try {
      await applyAvatar(fileId);
      setStatus('头像已更新。');
      onOpenChange(false);
    } catch (failure) {
      setStatus('');
      setError(`保存失败：${failureMessage(failure)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    setStatus('正在移除头像…');
    try {
      await applyAvatar(null);
      setStatus('头像已移除。');
      onOpenChange(false);
    } catch (failure) {
      setStatus('');
      setError(`保存失败：${failureMessage(failure)}`);
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || processing;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="修改头像"
      titleId="avatar-edit-title"
      contentId="avatar-edit-dialog"
      closeId="avatar-edit-close"
      className="avatar-edit-card"
      initialFocusRef={chooseRef}
      returnFocusRef={returnFocusRef}
      footer={
        <div className="row modal-actions avatar-edit-actions">
          <Button
            id="avatar-edit-remove"
            type="button"
            variant="borderless"
            className="avatar-edit-remove"
            disabled={!identity.avatar_url || busy}
            onClick={() => void remove()}
          >
            移除头像
          </Button>
          <Button
            id="avatar-edit-cancel"
            type="button"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            id="avatar-edit-save"
            type="button"
            className="primary"
            disabled={!payload || busy}
            onClick={() => void save()}
          >
            {saving ? '正在保存…' : '保存'}
          </Button>
        </div>
      }
    >
      <div className="avatar-edit-layout">
        <div className="avatar-edit-preview">
          {previewUrl ? (
            <img id="avatar-edit-preview" src={previewUrl} alt="新头像预览" />
          ) : (
            <ActorAvatar
              name={identity.name}
              avatarUrl={identity.avatar_url}
              kind={identity.kind}
              brandFallback
            />
          )}
        </div>
        <div className="avatar-edit-copy">
          <p className="avatar-edit-hint">
            选择一张图片，自动居中裁剪为正方形并缩放至 512×512。支持 PNG、JPEG、WebP、GIF，最大 8 MB。
          </p>
          <div className="avatar-edit-buttons">
            <Button
              ref={chooseRef}
              id="avatar-edit-choose"
              type="button"
              disabled={saving}
              onClick={() => inputRef.current?.click()}
            >
              {processing ? '正在处理…' : '选择图片'}
            </Button>
            <input
              ref={inputRef}
              id="avatar-edit-input"
              className="visually-hidden"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              tabIndex={-1}
              aria-label="选择头像图片"
              onChange={(event) => void onChoose(event)}
            />
          </div>
          {payload ? <p className="avatar-edit-file">{payload.name}</p> : null}
        </div>
      </div>
      <p
        id="avatar-edit-status"
        className="avatar-edit-status"
        role="status"
        data-error={error ? '1' : undefined}
      >
        {error || status}
      </p>
    </Modal>
  );
}
