import { expect, test } from 'bun:test';

import { ACTOR_STREAM_URI, readActorStream } from '../src/web/lib/actor-stream';
import { emptyPendingRefresh, markPendingRefresh } from '../src/web/lib/room-stream-refresh';
import { summarizeRoomPages, type RawRoom } from '../src/web/lib/rooms';

const ack = {
  method: 'notifications/subscriptions/acknowledged',
  params: { notifications: { resourceSubscriptions: [ACTOR_STREAM_URI] } },
};

function update(items: unknown[]) {
  return {
    method: 'notifications/resources/updated',
    params: { uri: ACTOR_STREAM_URI, _meta: { 'io.agent-network/event': { items } } },
  };
}

test('browser stream preserves split CRLF and UTF-8, ignores keepalives and confirms once', async () => {
  const item = { source: 'room.message', kind: 'message', room_id: '中文', message_id: 'm' };
  const bytes = new TextEncoder().encode([
    '\ufeff: keepalive', '', 'data: broken', '',
    ...[ack, ack, update([item]), update([])].flatMap(value => ['data: ' + JSON.stringify(value), '']),
    '',
  ].join('\r\n'));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.subarray(i, i + 1));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of readActorStream(stream)) frames.push(frame);
  expect(frames).toEqual([
    { type: 'ack' },
    { type: 'event', source: 'room.message', kind: 'message', roomId: '中文', messageId: 'm', change: null, attention: null },
    { type: 'event', source: '', kind: '', roomId: null, messageId: null, change: null, attention: null },
  ]);
});

test('leaving a live stream cancels its body and lets a new connection acknowledge', async () => {
  for (let connection = 0; connection < 2; connection++) {
    const { promise: canceled, resolve } = Promise.withResolvers<void>();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(ack) + '\r\r\n'));
      },
      cancel() { resolve(); },
    });
    for await (const frame of readActorStream(stream)) {
      expect(frame.type).toBe('ack');
      break;
    }
    await canceled;
  }
});

test('room pagination keeps server order and the first summary from overlapping pages', () => {
  function room(id: string, title: string): RawRoom {
    return { room_id: id, kind: 'group', title, head_seq: '1', my_last_read_seq: '0', updated_at: '0', last_message: null };
  }
  const page = (items: RawRoom[]) => ({ items, next_cursor: null, has_more: false });
  const rooms = summarizeRoomPages([
    page([]),
    page([room('b', 'first'), room('a', 'a'), room('a', 'duplicate')]),
    page([room('b', 'older'), room('c', 'c')]),
  ]);
  expect(rooms.map(({room_id, name}) => [room_id, name])).toEqual([['b', 'first'], ['a', 'a'], ['c', 'c']]);
});

test('stream truncation emits a gap so the open room is refreshed', async () => {
  const item = { source: 'room.message', kind: 'message', room_id: 'rm_open', message_id: 'm1' };
  const frame = {
    method: 'notifications/resources/updated',
    params: {
      uri: ACTOR_STREAM_URI,
      _meta: {
        'io.agent-network/event': { items: [item], more: true, dropped: 1 },
      },
    },
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(frame) + '\n\n'));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of readActorStream(stream)) frames.push(frame);
  expect(frames).toEqual([
    {
      type: 'event',
      source: 'room.message',
      kind: 'message',
      roomId: 'rm_open',
      messageId: 'm1',
      change: null,
      attention: null,
    },
    {
      type: 'event',
      source: 'stream.gap',
      kind: 'gap',
      roomId: null,
      messageId: null,
      change: null,
      attention: 'informational',
    },
  ]);
});

test('a dropped-only frame still refreshes current-room history', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const gap = {
        method: 'notifications/resources/updated',
        params: {
          uri: ACTOR_STREAM_URI,
          _meta: {
            'io.agent-network/event': { items: [], more: true, dropped: 2 },
          },
        },
      };
      controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(gap) + '\n\n'));
      controller.close();
    },
  });
  const pending = emptyPendingRefresh();
  for await (const frame of readActorStream(stream)) {
    if (frame.type !== 'event') continue;
    markPendingRefresh(pending, frame, 'rm_open', true);
  }
  expect(pending.rooms).toBe(true);
  expect(pending.detail).toBe(true);
  expect(pending.history).toBe(true);
});
