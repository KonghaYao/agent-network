import { useState, type CSSProperties, type HTMLAttributes } from 'react';

import { accountAvatarFor } from '../../lib/agent-avatar';
import { safeAvatarUrl } from '../../lib/avatar-url';
import { avatarColor, firstChar } from '../../lib/rooms';
import './avatar.css';

export interface ActorAvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  actorId?: string | null;
  name: string;
  avatarUrl?: string | null;
  kind?: 'human' | 'agent';
  /** 没有上传头像时继续使用原有品牌图标（账号、成员入口）。 */
  brandFallback?: boolean;
  /** 省略时由调用方 CSS 决定尺寸（账号 32/44、成员 24 等）。 */
  size?: number;
  radius?: number | string;
  shape?: 'circle' | 'square';
  fontSize?: number;
  initialClassName?: string;
  /** 保持 Lenso AvatarGroup 内部的既有选择器契约。 */
  'data-lenso-slot'?: string;
  /** Agent 明确离线时只灰化头像本身，不影响未读点/状态点。 */
  offline?: boolean;
}

/**
 * 统一头像：上传图片优先，其次品牌图标或名称首字。
 *
 * 图片只接受同源 `/f/` 地址；加载失败后移除 `<img>` 并回到名称色首字，
 * 不留下白块。容器尺寸/圆角默认沿用调用方现有 class，只有显式传入
 * `size`/`radius`/`shape` 时才输出内联样式。
 */
export function ActorAvatar({
  actorId,
  name,
  avatarUrl,
  kind,
  brandFallback = false,
  size,
  radius,
  shape,
  fontSize,
  offline = false,
  className,
  style,
  initialClassName,
  ...rest
}: ActorAvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const safeSrc = safeAvatarUrl(avatarUrl);
  // 上传地址存在但被安全函数拒绝时仍回退首字，不再展示品牌图标。
  const brand = !avatarUrl && brandFallback && kind ? accountAvatarFor(name, kind) : null;
  const src = safeSrc ?? brand?.src ?? null;
  const showImage = Boolean(src) && failedSrc !== src;

  const avatarStyle: CSSProperties = {
    ...(size
      ? {
          width: size,
          height: size,
          boxSizing: 'border-box',
          fontSize: fontSize ?? Math.max(10, Math.round(size * 0.45)),
        }
      : fontSize
        ? { fontSize }
        : null),
    ...(radius !== undefined ? { borderRadius: radius } : null),
    ...(shape ? { borderRadius: shape === 'circle' ? '50%' : 6 } : null),
    ...(showImage ? null : { background: avatarColor(name) }),
    ...style,
  };

  const classes = [
    'actor-avatar',
    className,
    showImage ? 'avatar-icon' : '',
    showImage && brand?.mono ? 'avatar-mono' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      {...rest}
      className={classes}
      style={avatarStyle}
      data-actor-id={actorId ?? undefined}
      data-avatar-state={showImage ? 'image' : 'fallback'}
      data-brand={showImage && brand ? brand.brand : undefined}
      data-presence={offline ? 'offline' : undefined}
      aria-hidden={rest['aria-hidden'] ?? true}
    >
      <span
        className={['actor-avatar-initial', initialClassName].filter(Boolean).join(' ')}
        style={{ opacity: showImage ? 0 : 1 }}
      >
        {firstChar(name)}
      </span>
      {showImage && src ? (
        <img
          className="avatar-img"
          src={src}
          alt=""
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
        />
      ) : null}
    </span>
  );
}
