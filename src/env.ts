import type { FileService } from '@peri-code/mcpp/files';

import type { NotificationHub } from './realtime/hub';

export interface Env {
  DB: D1Database;
  NOTIFICATION_HUB: NotificationHub;
  ENVIRONMENT: string;
  PUBLIC_ORIGIN: string;
  /** 启用 MCPP Files 时存在；关闭后 drive 工具与上传路由不注册。 */
  FILES?: FileService;
}
