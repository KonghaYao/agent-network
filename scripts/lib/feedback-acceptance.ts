/**
 * 问题反馈端到端验收。
 *
 * 覆盖认证提交、形状、幂等、并发收敛、不同 actor 隔离，以及不产生
 * inbox pending 变化或 stream 通知；迁移/事务/日志安全由 feedback-unit 覆盖。
 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
  sleep,
  type McpConnection,
} from './harness';
import {
  inbox,
  registerIdentity,
  type Identity,
  type LoginResult,
} from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

interface FeedbackResult {
  feedback_id: string;
  created_at: string;
}

interface StreamItemView {
  source?: string;
  kind?: string;
}

function feedbackArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: newRequestId('feedback'),
    environment: 'os=Acceptance kernel=test arch=test bash=5 cli=1.0.0',
    harness: 'acceptance',
    problem: '多行中文反馈\n特殊字符 <>&"` 以及最小复现',
    ...overrides,
  };
}

export async function runFeedbackAcceptance(): Promise<void> {
  const agentConn: McpConnection = await connectClient(newToken());
  const humanConn: McpConnection = await connectClient(newToken());

  try {
    const agent: Identity = await registerIdentity(agentConn, {
      kind: 'agent',
      name: '反馈验收 Agent',
      sessionId: `feedback_agent_${crypto.randomUUID()}`,
    });
    const human: Identity = await registerIdentity(humanConn, {
      kind: 'human',
      name: '反馈验收人类',
    });

    const collector = notificationCollector(agentConn.client);
    const subscription = await openSubscription(agentConn.client, [STREAM_URI]);
    try {
      const login = await callTool<LoginResult>(agentConn.client, 'network_login');
      checkEqual('反馈验收 Agent 可上线', login.online, true);
      await collector.waitFor(
        (event) => {
          if (event.params.uri !== STREAM_URI) return false;
          const meta = event.params._meta as Record<string, unknown> | undefined;
          const payload = meta?.[STREAM_EVENT_META] as
            | { items?: StreamItemView[] }
            | undefined;
          return (payload?.items ?? []).some((item) => item.source === 'session.login');
        },
        '等待反馈验收 login 通知',
      );
      await sleep(300);
      collector.reset();

      const beforeInbox = await inbox(agentConn, 'all');
      const requestId = newRequestId('feedback_e2e');
      const args = feedbackArgs({ request_id: requestId });
      const first = await callTool<FeedbackResult>(
        agentConn.client,
        'network_feedback_create',
        args,
      );
      checkEqual('反馈结果只含 feedback_id/created_at', Object.keys(first).sort().join(','), 'created_at,feedback_id');
      check('反馈返回 fb_ 前缀 ID', first.feedback_id.startsWith('fb_'), first.feedback_id);
      check('反馈 created_at 为毫秒字符串', Number.isInteger(Number(first.created_at)), first.created_at);
      check('反馈响应不回显正文', !JSON.stringify(first).includes('多行中文反馈'));

      const replay = await callTool<FeedbackResult>(
        agentConn.client,
        'network_feedback_create',
        args,
      );
      checkEqual('同参重放返回原 feedback_id', replay.feedback_id, first.feedback_id);
      checkEqual('同参重放返回原 created_at', replay.created_at, first.created_at);

      await expectToolError(
        '同 request_id 改正文返回 IDEMPOTENCY_CONFLICT',
        callTool(agentConn.client, 'network_feedback_create', {
          ...args,
          problem: '另一个问题描述',
        }),
        'IDEMPOTENCY_CONFLICT',
      );

      const afterInbox = await inbox(agentConn, 'all');
      checkEqual('反馈不改变 pending_count', afterInbox.pending_count, beforeInbox.pending_count);
      checkEqual('反馈不新增 inbox 条目', afterInbox.items.length, beforeInbox.items.length);
      await sleep(600);
      checkEqual('反馈不产生 stream 通知', collector.events.length, 0);

      const humanFeedback = await callTool<FeedbackResult>(
        humanConn.client,
        'network_feedback_create',
        feedbackArgs({ harness: 'human-acceptance' }),
      );
      check('人类身份可提交反馈', humanFeedback.feedback_id.startsWith('fb_'));
      check('不同身份反馈 ID 独立', humanFeedback.feedback_id !== first.feedback_id);

      const sharedRequest = newRequestId('feedback_shared');
      const sharedAgent = await callTool<FeedbackResult>(
        agentConn.client,
        'network_feedback_create',
        feedbackArgs({ request_id: sharedRequest, problem: '同 request_id 的 agent 反馈' }),
      );
      const sharedHuman = await callTool<FeedbackResult>(
        humanConn.client,
        'network_feedback_create',
        feedbackArgs({ request_id: sharedRequest, problem: '同 request_id 的 human 反馈' }),
      );
      check('不同 actor 的相同 request_id 独立', sharedAgent.feedback_id !== sharedHuman.feedback_id);

      const concurrentRequest = newRequestId('feedback_concurrent');
      const concurrentArgs = feedbackArgs({ request_id: concurrentRequest });
      const settled = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          callTool<FeedbackResult>(
            agentConn.client,
            'network_feedback_create',
            concurrentArgs,
          ),
        ),
      );
      check(
        '并发同 request_id 全部成功',
        settled.every((item) => item.status === 'fulfilled'),
        settled.map((item) => item.status),
      );
      const ids = settled
        .filter((item): item is PromiseFulfilledResult<FeedbackResult> => item.status === 'fulfilled')
        .map((item) => item.value.feedback_id);
      checkEqual('并发同 request_id 收敛为一个结果', new Set(ids).size, 1);

      checkEqual('身份 ID 未混入反馈结果', Object.hasOwn(first, 'actor_id'), false);
      check('验收人类与 Agent 都有反馈权限', human.actor_id !== agent.actor_id);
    } finally {
      await subscription.close();
    }
  } finally {
    await Promise.all([agentConn.close(), humanConn.close()]);
  }
}
