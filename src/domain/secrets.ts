/**
 * 凭据摘要的 domain 入口。
 *
 * 实现放在 `storage/db.ts`，避免 storage 反向依赖 domain；这里的 re-export 让
 * domain 模块只依赖本文件，便于后续统一迁移调用点。
 */

export { hashSecret, type SecretPurpose } from '../storage/db';
