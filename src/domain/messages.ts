/**
 * messages 领域 barrel。
 *
 * 纯移动拆分：`view`（消息视图与写入语句）、`mentions`（提及解析与自动提及）、
 * `send`（发送与幂等结果）、`history`（历史与已读）。对外导出面与拆分前一致。
 */

export type {
  DeliverySeed,
  HistoryMessageView,
  MentionReminderSeed,
  MentionSeed,
  MessageCore,
  MessagePage,
  MessageView,
} from './messages/view';
export type { AgentAutoMention } from './messages/mentions';
export type { MessageSendStatusItem, SendResult } from './messages/send';
export type { ReadChunk } from './messages/history';
export {
  messageCoreStatements,
  messageGuardStatements,
  messageView,
} from './messages/view';
export { instructionText } from './messages/mentions';
export {
  finalMessagePlan,
  messageSend,
  messageSendStatus,
  sendResultByClientId,
} from './messages/send';
export {
  historyList,
  messageRead,
  roomMarkRead,
} from './messages/history';
