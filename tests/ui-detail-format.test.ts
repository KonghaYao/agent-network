import { describe, expect, test } from 'bun:test';

import {
  formatByteSize,
  formatCountLabel,
  formatDisplayTime,
  formatEntryCount,
  formatEntryMeta,
  formatParticipantCount,
  mimeFriendlyName,
} from '../src/web/lib/display-format';
import {
  filePreviewKind,
  fileTimeLabel,
  fileTypeLabel,
  formatFileSize,
  isHtmlPreview,
} from '../src/web/lib/files-ui';
import { relativeTime } from '../src/web/lib/rooms';
import {
  TASK_STATUS_DISPLAY_ORDER,
  sortTaskStatusEntries,
  summarizeTaskStatuses,
  taskEntryMeta,
  taskStatusLabel,
  taskTimeLabel,
} from '../src/web/features/tasks/task-format';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 18, 12, 0);

function withNow<T>(now: number, run: () => T): T {
  const original = Date.now;
  Date.now = () => now;
  try {
    return run();
  } finally {
    Date.now = original;
  }
}

describe('formatDisplayTime', () => {
  test('detail 相对时间边界', () => {
    const at = (offset: number): string =>
      formatDisplayTime(NOW - offset, { now: NOW, timeZone: 'UTC' }).display;
    expect(at(0)).toBe('刚刚');
    expect(at(59_000)).toBe('刚刚');
    expect(at(MINUTE)).toBe('1 分钟前');
    expect(at(59 * MINUTE + 59_000)).toBe('59 分钟前');
    expect(at(HOUR)).toBe('1 小时前');
    expect(at(DAY - 1)).toBe('23 小时前');
    expect(at(DAY)).toBe('11月17日 12:00');
  });

  test('detail 跨月、跨年与闰日使用绝对格式', () => {
    expect(
      formatDisplayTime(Date.UTC(2026, 9, 31, 23, 50), {
        now: Date.UTC(2026, 10, 2, 0, 0),
        timeZone: 'UTC',
      }).display,
    ).toBe('10月31日 23:50');
    expect(
      formatDisplayTime(Date.UTC(2025, 11, 31, 23, 59), {
        now: Date.UTC(2026, 0, 2, 0, 0),
        timeZone: 'UTC',
      }).display,
    ).toBe('2025年12月31日 23:59');
    expect(
      formatDisplayTime(Date.UTC(2024, 1, 29, 12, 0), {
        now: Date.UTC(2025, 2, 1, 12, 0),
        timeZone: 'UTC',
      }).display,
    ).toBe('2024年2月29日 12:00');
  });

  test('未来时间不伪装成刚刚', () => {
    expect(
      formatDisplayTime(NOW + MINUTE, { now: NOW, timeZone: 'UTC' }).display,
    ).toBe('11月18日 12:01');
  });

  test('返回展示值、完整值、ISO 与时间戳', () => {
    const timestamp = Date.UTC(2026, 10, 17, 16, 10);
    const result = formatDisplayTime(timestamp, {
      now: Date.UTC(2026, 10, 18, 20, 0),
      timeZone: 'UTC',
    });
    expect(result.display).toBe('11月17日 16:10');
    expect(result.full).toBe('2026年11月17日 16:10');
    expect(result.iso).toBe('2026-11-17T16:10:00.000Z');
    expect(result.timestamp).toBe(timestamp);
  });

  test('compact 保持会话列表口径', () => {
    const at = (timestamp: number): string =>
      formatDisplayTime(timestamp, {
        now: NOW,
        timeZone: 'UTC',
        mode: 'compact',
      }).display;
    expect(at(Date.UTC(2026, 10, 18, 3, 5))).toBe('03:05');
    expect(at(Date.UTC(2026, 10, 17, 23, 0))).toBe('昨天');
    expect(at(Date.UTC(2026, 10, 10, 23, 0))).toBe('11/10');
    expect(at(Date.UTC(2025, 11, 31, 23, 0))).toBe('2025/12/31');
  });

  test('timeZone 影响绝对日期与时间', () => {
    const timestamp = Date.UTC(2026, 10, 18, 1, 30);
    const now = Date.UTC(2026, 10, 20, 0, 0);
    expect(formatDisplayTime(timestamp, { now, timeZone: 'UTC' }).display).toBe(
      '11月18日 01:30',
    );
    expect(
      formatDisplayTime(timestamp, { now, timeZone: 'America/New_York' }).display,
    ).toBe('11月17日 20:30');
  });

  test('0、负数、NaN 与不可解析文本均为未知', () => {
    const unknown = { display: '', full: '', iso: null, timestamp: null };
    for (const value of [null, undefined, '', '   ', 0, -1, Number.NaN, Infinity, 'invalid', new Date(Number.NaN)]) {
      expect(formatDisplayTime(value, { now: NOW, timeZone: 'UTC' })).toEqual(unknown);
    }
  });
});

describe('计数与入口顺序', () => {
  test('带单位计数与 0/未知规则', () => {
    expect(formatCountLabel(3, '条消息')).toBe('3 条消息');
    expect(formatCountLabel(2, '个 Agent')).toBe('2 个 Agent');
    expect(formatCountLabel(0, '条消息')).toBe('0 条消息');
    expect(formatCountLabel(1, 'agents', { singularUnit: 'agent' })).toBe('1 agent');
    expect(formatCountLabel(null, '条消息')).toBe('');
    expect(formatCountLabel(undefined, '条消息', { unknownLabel: '未知' })).toBe('未知');
    expect(formatCountLabel(0, '条消息', { zeroLabel: '没有消息' })).toBe('没有消息');
    expect(formatCountLabel(-1, '条消息')).toBe('');
    expect(formatCountLabel(Number.NaN, '条消息')).toBe('');
    expect(formatCountLabel('3', '条消息')).toBe('3 条消息');
  });

  test('入口计数只做限幅', () => {
    expect(formatEntryCount(3)).toBe('3');
    expect(formatEntryCount(null)).toBe('');
    expect(formatEntryCount(9, { cap: 9 })).toBe('9');
    expect(formatEntryCount(12, { cap: 9 })).toBe('9+');
  });

  test('入口顺序固定且未知项省略', () => {
    expect(
      formatEntryMeta({
        messageCount: 3,
        agentCount: 2,
        time: NOW - 3 * MINUTE,
        now: NOW,
        timeZone: 'UTC',
      }),
    ).toBe('3 条消息 · 2 个 Agent · 3 分钟前');
    expect(
      formatEntryMeta({ messageCount: null, agentCount: 2, time: null, now: NOW }),
    ).toBe('2 个 Agent');
    expect(formatEntryMeta({ messageCount: 0, agentCount: 0 })).toBe(
      '0 条消息 · 0 个 Agent',
    );
    expect(formatEntryMeta({})).toBe('');
    expect(formatParticipantCount(2)).toBe('2 个 Agent 参与');
    expect(formatParticipantCount(null)).toBe('');
  });

  test('Task 入口摘要与 taskTimeLabel 复用 detail 口径', () => {
    expect(
      taskEntryMeta({
        messageCount: 3,
        agentCount: 2,
        time: NOW - 3 * MINUTE,
        now: NOW,
        timeZone: 'UTC',
      }),
    ).toBe('3 条消息 · 2 个 Agent · 3 分钟前');
    const now = new Date(2026, 10, 18, 0, 10).getTime();
    withNow(now, () => {
      expect(taskTimeLabel(String(now - 3 * MINUTE))).toBe('3 分钟前');
      expect(taskTimeLabel(String(now - HOUR))).toBe('1 小时前');
      expect(taskTimeLabel(String(new Date(2026, 10, 16, 16, 10).getTime()))).toBe(
        '11月16日 16:10',
      );
      expect(taskTimeLabel(String(now))).toBe('刚刚');
      expect(taskTimeLabel('invalid')).toBe('');
      expect(taskTimeLabel(null)).toBe('');
    });
  });
});

describe('Task 状态顺序与聚合', () => {
  test('状态顺序固定为 pending, claimed, completed, failed, cancelled', () => {
    expect([...TASK_STATUS_DISPLAY_ORDER]).toEqual([
      'pending',
      'claimed',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(
      sortTaskStatusEntries([
        { status: 'failed', count: 1 },
        { status: 'pending', count: 2 },
        { status: 'cancelled', count: 1 },
        { status: 'completed', count: 3 },
        { status: 'claimed', count: 4 },
      ]).map((entry) => entry.status),
    ).toEqual(['pending', 'claimed', 'completed', 'failed', 'cancelled']);
  });

  test('未知状态稳定排在末尾且不伪装成已知状态', () => {
    expect(
      sortTaskStatusEntries([
        { status: 'mystery' },
        { status: 'pending' },
        { status: 'other' },
      ]).map((entry) => entry.status),
    ).toEqual(['pending', 'mystery', 'other']);
    expect(taskStatusLabel('completed')).toBe('已完成');
    expect(taskStatusLabel('failed')).toBe('失败');
    expect(taskStatusLabel('cancelled')).toBe('已取消');
    expect(taskStatusLabel('mystery')).toBe('');
    expect(taskStatusLabel(null)).toBe('');
  });

  test('已结束不等于成功，失败与取消单列', () => {
    const summary = summarizeTaskStatuses({
      pending: 2,
      claimed: 1,
      completed: 3,
      failed: 2,
      cancelled: 1,
    });
    expect(summary.entries.map((entry) => entry.status)).toEqual([
      'pending',
      'claimed',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(summary.total).toBe(9);
    expect(summary.active).toBe(3);
    expect(summary.ended).toBe(6);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(2);
    expect(summary.cancelled).toBe(1);
    expect(summary.ended).not.toBe(summary.completed);
  });

  test('空计数不显示 0 条目，可选包含零值', () => {
    expect(summarizeTaskStatuses(null).entries).toEqual([]);
    expect(summarizeTaskStatuses(null).total).toBe(0);
    expect(
      summarizeTaskStatuses(
        { pending: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0 },
        { includeZero: true },
      ).entries.map((entry) => entry.count),
    ).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('文件大小与类型', () => {
  test('B/KB/MB 边界与空值', () => {
    expect(formatByteSize(null)).toBe('');
    expect(formatByteSize(undefined)).toBe('');
    expect(formatByteSize('')).toBe('');
    expect(formatByteSize(Number.NaN)).toBe('');
    expect(formatByteSize(Infinity)).toBe('');
    expect(formatByteSize(-1)).toBe('');
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(999)).toBe('999 B');
    expect(formatByteSize(1000)).toBe('1000 B');
    expect(formatByteSize(1023)).toBe('1023 B');
    expect(formatByteSize(1024)).toBe('1 KB');
    expect(formatByteSize(1536)).toBe('1.5 KB');
    expect(formatByteSize(10 * 1024)).toBe('10 KB');
    expect(formatByteSize(1024 * 1024)).toBe('1 MB');
    expect(formatByteSize(1024 * 1024 * 1024)).toBe('1 GB');
    expect(formatFileSize(null)).toBe('');
    expect(formatFileSize(1024)).toBe('1 KB');
  });

  test('MIME 友好名与类型短标签', () => {
    expect(mimeFriendlyName('text/html; charset=utf-8')).toBe('HTML');
    expect(mimeFriendlyName('image/svg+xml')).toBe('SVG');
    expect(mimeFriendlyName('image/png')).toBe('图片');
    expect(mimeFriendlyName('application/pdf')).toBe('PDF');
    expect(mimeFriendlyName('text/markdown')).toBe('Markdown');
    expect(mimeFriendlyName('text/plain')).toBe('文本');
    expect(mimeFriendlyName('audio/mpeg')).toBe('音频');
    expect(mimeFriendlyName('video/mp4')).toBe('视频');
    expect(mimeFriendlyName('application/json')).toBe('文本');
    expect(mimeFriendlyName('application/octet-stream')).toBe('文件');
    expect(mimeFriendlyName(null)).toBe('');
    expect(fileTypeLabel('html')).toBe('网页');
    expect(fileTypeLabel('image')).toBe('图片');
    expect(fileTypeLabel('other')).toBe('文件');
  });

  test('HTML 仅按显式 MIME 识别，SVG 不可预览', () => {
    expect(isHtmlPreview({ file_id: 'html', mime_type: ' Text/HTML; charset=utf-8 ' })).toBe(
      true,
    );
    expect(
      filePreviewKind({ file_id: 'html', mime_type: 'text/html', preview_kind: 'other' }),
    ).toBe('html');
    for (const mime_type of [undefined, '', 'application/octet-stream', 'text/plain']) {
      expect(isHtmlPreview({ file_id: 'html', name: 'page.html', mime_type })).toBe(false);
      expect(
        filePreviewKind({
          file_id: 'html',
          name: 'page.html',
          mime_type,
          preview_kind: 'html',
        }),
      ).not.toBe('html');
    }
    expect(filePreviewKind({ file_id: 'svg', mime_type: 'image/svg+xml' })).toBe('other');
    expect(
      filePreviewKind({ file_id: 'svg', mime_type: 'image/svg+xml', preview_kind: 'image' }),
    ).toBe('other');
    expect(filePreviewKind({ file_id: 'md', name: 'note.md', mime_type: 'text/plain' })).toBe(
      'markdown',
    );
    expect(
      filePreviewKind({
        file_id: 'png',
        name: 'photo.png',
        mime_type: 'application/octet-stream',
      }),
    ).toBe('image');
  });

  test('文件时间统一 detail 口径', () => {
    const now = new Date(2026, 10, 18, 12, 0).getTime();
    withNow(now, () => {
      expect(fileTimeLabel(undefined)).toBe('');
      expect(fileTimeLabel(0)).toBe('');
      expect(fileTimeLabel('invalid')).toBe('');
      expect(fileTimeLabel(now - 3 * MINUTE)).toBe('3 分钟前');
      expect(fileTimeLabel(now - 2 * HOUR)).toBe('2 小时前');
      expect(fileTimeLabel(new Date(2026, 10, 15, 12, 0).getTime())).toBe(
        '11月15日 12:00',
      );
    });
  });
});

describe('会话列表时间', () => {
  test('相对时间保持 compact 口径并拒绝未知值', () => {
    const now = new Date(2026, 10, 18, 12, 0).getTime();
    withNow(now, () => {
      expect(relativeTime(String(new Date(2026, 10, 18, 9, 5).getTime()))).toBe('09:05');
      expect(relativeTime(String(new Date(2026, 10, 17, 9, 5).getTime()))).toBe('昨天');
      expect(relativeTime(String(new Date(2026, 10, 10, 9, 5).getTime()))).toBe('11/10');
      expect(relativeTime(String(new Date(2025, 11, 31, 9, 5).getTime()))).toBe(
        '2025/12/31',
      );
      expect(relativeTime(null)).toBe('');
      expect(relativeTime('invalid')).toBe('');
    });
  });
});
