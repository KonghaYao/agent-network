/**
 * 网页记忆面板复用服务端同一份掩码实现，避免两套规则漂移。
 *
 * 该函数只降低凭据进入 DOM 的风险，不是 DLP。
 */
export { maskSecrets } from '../../../contracts/redaction';
