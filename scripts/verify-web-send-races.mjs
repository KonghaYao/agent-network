/** Run: node scripts/verify-web-send-races.mjs. Exercises production inline handlers without a server. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = name => readFileSync(new URL('../src/web/' + name, import.meta.url), 'utf8');
const chat = source('chat-script.ts');
const handler = chat.slice(chat.indexOf("composer.addEventListener('submit'"), chat.indexOf("\nbodyInput.addEventListener('input'"));
const session = source('chat-session-script.ts');
const clearError = session.slice(session.indexOf('function clearChatError()'), session.indexOf('\nfunction handleRoomError'));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const requests = [];
const c = vm.createContext({
  composer: { addEventListener: (_name, fn) => { c.submit = fn; } },
  composerSendingRooms: new Set(), sendButton: { disabled: false }, activeRoomId: 'A', roomEpoch: 1,
  bodyInput: { value: 'sent text', focus() {} }, composerOutgoingBody: (_id, text) => text,
  composerReadyKeys: () => [], stickyStatus: '', statusElement: {}, room: { kind: 'direct' },
  directInvokeTargets: () => ({ targets: [] }), outboxFindReusable: () => null,
  outboxCreate: room_id => ({ room_id }), scrollController: { pinNextApply() {} },
  outboxSubmit: (intent, options) => { const pending = deferred(); requests.push({ intent, options, ...pending }); return pending.promise; },
  isActiveRoom: (id, epoch) => c.activeRoomId === id && c.roomEpoch === epoch,
  chatErrorElement: null, chatErrorTextElement: null,
});
vm.runInContext(handler + '\n' + clearError, c);
const event = { preventDefault() {} };
const first = c.submit(event);
c.clearChatError();
assert.equal(c.sendButton.disabled, true, 'refresh must preserve pending send lock');
c.sendButton.disabled = false; // another UI path must not bypass the independent lock
await c.submit(event);
assert.equal(requests.length, 1, 'repeated enter cannot duplicate in-flight intent');
c.activeRoomId = 'B'; c.roomEpoch = 2; c.sendButton.disabled = false;
const second = c.submit(event);
assert.equal(requests.length, 2, 'a different room can send independently');
requests[0].resolve(); await first;
assert.equal(c.sendButton.disabled, true, 'old room completion must not release new room send');
assert.equal(c.composerSendingRooms.has('A'), false);
requests[1].reject(new Error('failed'));
await assert.rejects(second, /failed/);
assert.equal(c.sendButton.disabled, false);
assert.equal(c.composerSendingRooms.size, 0, 'failures release independent locks');
assert.equal(requests[0].options.composerDraft, 'sent text');

const outbox = source('chat-outbox-script.ts');
const finish = outbox.slice(outbox.indexOf('function outboxComposerMatches('), outbox.indexOf('\n/**\n * 提交一个持久意图'));
for (const storedInMemory of [false, true]) {
  for (const edited of [false, true]) {
    const saved = edited ? 'new unsent draft' : 'sent text';
    let removed = 0;
    const d = vm.createContext({
      bodyInput: { value: 'B draft' }, roomEpoch: 2, isActiveRoom: id => id === 'B',
      drafts: new Map(storedInMemory ? [['A', saved]] : []), draftLoad: () => saved,
      mentionSelections: new Map(), draftClear: () => { removed++; }, clearComposerFiles() {},
    });
    vm.runInContext(finish, d);
    d.outboxFinishCommitted({ room_id: 'A', body: 'sent text' }, { epoch: 1, composerDraft: 'sent text' });
    assert.equal(removed, edited ? 0 : 1, 'only the submitted draft may be removed after navigation');
    if (storedInMemory && edited) assert.equal(d.drafts.get('A'), saved);
  }
}
console.log('PASS: refresh/re-entry send isolation, cross-room success/failure, draft snapshot and persistent draft preservation');
