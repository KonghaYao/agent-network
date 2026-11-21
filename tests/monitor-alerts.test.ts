import { describe, expect, test } from 'bun:test';

import { HARNESS_GUIDES } from '../client/harness-guides';
import { ALERT_PATTERN, isAlertEvent } from '../client/monitor/alerts';
import type { JsonObject } from '../client/monitor/rpc';

/** 按 engine 的 JSON 输出方式构造一行，验证宿主 alert 正则的真实匹配结果。 */
function line(event: JsonObject): string {
  return JSON.stringify({ ...event, alert: isAlertEvent(event) });
}

function matches(event: JsonObject): boolean {
  return new RegExp(ALERT_PATTERN, 'u').test(line(event));
}

function matchesLine(text: string): boolean {
  return new RegExp(ALERT_PATTERN, 'u').test(text);
}

function check(event: JsonObject, expected: boolean): void {
  expect(isAlertEvent(event)).toBe(expected);
  expect(matches(event)).toBe(expected);
}

describe('monitor alert 分类', () => {
  test('reminder 只输出不告警', () => {
    check(
      {
        type: 'reminder',
        delivery_id: 'dlv_1',
        hint: '先调用 network_delivery_report 报告当前阶段进度',
      },
      false,
    );
  });

  test('delivery 告警', () => {
    check({ type: 'delivery', delivery_id: 'dlv_1', claim_state: 'claimed' }, true);
  });

  test('delivery_deferred 告警', () => {
    check(
      { type: 'delivery_deferred', delivery_id: 'dlv_2', claim_state: 'deferred' },
      true,
    );
  });

  test('session.login 告警（即使 attention 为 informational）', () => {
    check(
      { type: 'stream_event', source: 'session.login', attention: 'informational' },
      true,
    );
  });

  test('任意 attention=action_required 告警', () => {
    check(
      { type: 'stream_event', source: 'room.file', attention: 'action_required' },
      true,
    );
    check(
      {
        type: 'delivery_state',
        source: 'delivery.retried',
        attention: 'action_required',
        state: 'pending',
      },
      true,
    );
  });

  test('error 与解析失败告警', () => {
    check({ type: 'error', code: 'request_rejected' }, true);
    check(
      { type: 'delivery_claim_failed', code: 'READ_FAILED', claim_state: 'failed' },
      true,
    );
  });

  test('启动期 stderr ERROR 命中，RECONNECTING 不命中', () => {
    expect(matchesLine('ERROR type=credential message=missing_token')).toBe(true);
    expect(matchesLine('ERROR actor_mismatch expected=agt_a actual=agt_b')).toBe(true);
    expect(matchesLine('RECONNECTING reason=stream_closed attempt=1 delay=1')).toBe(false);
    expect(matchesLine('READY actor=agt_a pending=0 subscription=sub_1')).toBe(false);
  });

  test('monitor --json 的启动错误使用宿主唤醒规则', () => {
    const run = Bun.spawnSync([process.execPath, 'client/cli.ts', 'monitor', '--harness', 'peri', '--json'], {
      env: { ...process.env, AGENTNET_TOKEN: '', AGENTNET_TOKEN_FILE: '' },
    });
    expect(run.exitCode).toBe(1);
    const stderr = run.stderr.toString().trim();
    expect(JSON.parse(stderr).error.code).toBe('credentials_required');
    expect(matchesLine(stderr)).toBe(true);
  });

  test('普通 stream_event 不告警', () => {
    check(
      { type: 'stream_event', source: 'room.file', attention: 'informational' },
      false,
    );
    check(
      {
        type: 'delivery_state',
        source: 'delivery.completed',
        attention: 'informational',
      },
      false,
    );
  });

  test('delivery_conflict 不告警', () => {
    check(
      {
        type: 'delivery_conflict',
        delivery_id: 'dlv_3',
        claim_state: 'conflict',
        hint: '跳过，不要处理',
      },
      false,
    );
  });

  test('ready / reconnecting / 其它控制事件不告警', () => {
    check({ type: 'ready', pending: 0 }, false);
    check({ type: 'recovered', pending: 0 }, false);
    check({ type: 'reconnecting', attempt: 1 }, false);
    check({ type: 'degraded', attempts: 5 }, false);
    check({ type: 'deadline', remaining_ms: 86400000 }, false);
  });

  test('正文或 hint 里的 alert 文本不会误命中', () => {
    const event = {
      type: 'reminder',
      hint: '不要匹配 "alert":true 这串文本',
      body: '{"alert":true}',
    };
    expect(isAlertEvent(event)).toBe(false);
    expect(matches(event)).toBe(false);
  });

  test('CLI 宿主指南使用同一 alert 正则', () => {
    const peri = HARNESS_GUIDES.peri;
    expect(peri).toBeDefined();
    expect(peri?.template.join('\n')).toContain(`alert: '${ALERT_PATTERN}'`);
    const claude = HARNESS_GUIDES.claude;
    expect(claude?.template.join('\n')).toContain(ALERT_PATTERN);
  });
});
