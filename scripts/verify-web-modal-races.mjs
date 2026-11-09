/** Isolated async regressions for the shipped inline handlers. Run: node scripts/verify-web-modal-races.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const groupCreate = readFileSync(new URL('../src/web/chat-group-create-script.ts', import.meta.url), 'utf8');
const members = readFileSync(new URL('../src/web/chat-members-script.ts', import.meta.url), 'utf8');
const groupHandler = groupCreate.slice(groupCreate.indexOf('if (groupForm) {'), groupCreate.lastIndexOf('\n`;'));
const memberHandler = members.slice(members.indexOf('async function submitMembersForm(event)'), members.indexOf('\nif (membersButton)'));
const event = { preventDefault() {} };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function groupHarness() {
  const pending = deferred();
  const calls = [], seeded = [], navigated = [];
  const context = vm.createContext({
    groupForm: { addEventListener(_name, fn) { context.submit = fn; } },
    groupModal: { hidden: false }, groupLoadSeq: 1, groupBusy: false, groupCreateIntent: null,
    groupCreateButton: { disabled: false }, groupErrorElement: { textContent: '' },
    groupTitleInput: { value: 'New group', disabled: false },
    groupPicker: { selectedIds: () => ['friend'], setBusy() {} },
    identity: { actor_id: 'me' }, roomFilter: 'all', MEMBER_CHANGE_MAX: 100,
    updateGroupCreateState() {}, setRoomFilter(value) { context.roomFilter = value; }, showToast() {},
    requestId: () => 'request',
    callTool: (...args) => { calls.push(args); return pending.promise; },
    seedRoomCacheFromDetail: result => { seeded.push(result); return result.room.room_id; },
    navigateTo: path => navigated.push(path),
    closeGroupModal: () => { context.groupLoadSeq++; context.groupModal.hidden = true; },
  });
  vm.runInContext(groupHandler, context);
  return { context, pending, calls, seeded, navigated };
}
{
  const h = groupHarness();
  const first = h.context.submit(event);
  const duplicate = h.context.submit(event);
  assert.equal(h.calls.length, 1, 'double submit must not create a second group');
  h.pending.resolve({ room: { room_id: 'created' } });
  await Promise.all([first, duplicate]);
  assert.deepEqual(h.navigated, ['/c/created'], 'normal success opens created room');
}
for (const reopen of [false, true]) {
  for (const fail of [false, true]) {
    const h = groupHarness();
    const first = h.context.submit(event);
    h.context.closeGroupModal();
    if (reopen) {
      h.context.groupLoadSeq++;
      h.context.groupModal.hidden = false;
    }
    h.context.groupErrorElement.textContent = 'new state';
    h.context.groupCreateButton.disabled = true;
    if (fail) h.pending.reject(new Error('old failure'));
    else h.pending.resolve({ room: { room_id: 'created' } });
    await first;
    assert.equal(h.seeded.length, fail ? 0 : 1, 'successful background creation remains discoverable');
    assert.equal(h.navigated.length, 0, 'dismissed create must not interrupt navigation');
    assert.equal(h.context.groupModal.hidden, !reopen, 'old result must not close reopened modal');
    assert.equal(h.context.groupErrorElement.textContent, 'new state');
    assert.equal(h.context.groupCreateButton.disabled, true, 'old result must not release new submission lock');
  }
}
for (const fail of [false, true]) {
  const pending = deferred();
  let applied = 0, cleared = 0;
  const context = vm.createContext({
    activeRoomId: 'room', roomEpoch: 1, room: { kind: 'group' },
    membersModal: { hidden: false }, membersBusy: false, membersLoadToken: 1,
    members: new Map(), invitedMembers: new Map(), MEMBER_CHANGE_MAX: 100,
    canInviteMembers: () => true, selectedMemberIds: () => ['friend'],
    setMembersError: value => { context.error = value; },
    setMembersBusy: value => { context.membersBusy = value; },
    requestId: () => 'request', callTool: () => pending.promise,
    isActiveRoom: () => true,
    applyRoomDetail: () => { applied++; },
    membersPicker: { clearSelection: () => { cleared++; } },
    membersUpdateError: error => error.message,
    membersContactsCache: [], membersContactNote: '',
    membersCandidates: () => [], renderCurrentMembers() {}, renderMembersContacts() {},
    refresh: () => Promise.resolve(), statusElement: { textContent: '' },
  });
  vm.runInContext(memberHandler, context);
  const first = context.submitMembersForm(event);
  context.membersLoadToken += 2; // close and reopen the same room's members dialog
  context.error = 'new state';
  context.membersBusy = true; // reopened dialog is loading candidates
  if (fail) pending.reject(new Error('old failure'));
  else pending.resolve({ members: [{ actor_id: 'friend' }] });
  await first;
  assert.equal(applied, fail ? 0 : 1, 'committed membership still updates room state');
  assert.equal(cleared, 0, 'old response must not clear newly selected candidates');
  assert.equal(context.error, 'new state');
  assert.equal(context.membersBusy, true, 'old completion must not release new loading lock');
}
console.log('PASS: group single-flight, normal completion, close/reopen success/failure, member-dialog generation isolation');
