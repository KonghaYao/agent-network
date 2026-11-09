/** Pairing credential isolation regressions. Run: node scripts/verify-web-pairing-races.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/web/pair.ts', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('  function localPairToken('), source.indexOf("  startButton.addEventListener('click'"));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const requests = [], remembered = [], removed = [], stored = [];
  let uuid = 0;
  const context = vm.createContext({
    PAIR_TOKEN_PREFIX: 'pair:', localToken: null, pairing: null, targetIdentity: null,
    currentIdentity: null, redeemRequestId: null, pollTimer: null, busy: false,
    pairingGeneration: 0, pairingChallenge: null, credentialReady: false,
    challengeInput: { value: 'AAAAAAAAAAAA' }, startButton: {}, switchButton: { hidden: true },
    confirmElement: {}, targetElement: {}, currentElement: {},
    normalizeChallenge: text => text, sessionGet: () => null, sessionSet: () => {},
    sessionRemove: key => removed.push(key), crypto: { randomUUID: () => 'token-' + ++uuid },
    requestId: () => 'request-' + ++uuid, deviceId: () => 'device', deviceLabel: () => 'Browser',
    navigator: { platform: 'test' }, setTimeout: () => 1, clearTimeout: () => {},
    setStatus: text => { context.status = text; },
    callTool: (name, args, token) => {
      const pending = deferred(); requests.push({ name, args, token, ...pending }); return pending.promise;
    },
    currentToken: () => null, storageSet: (key, value) => { stored.push([key, value]); return true; },
    rememberIdentity: (identity, token) => { remembered.push([identity.actor_id, token]); return true; },
    window: { localStorage: { removeItem() {} }, history: { replaceState() {} },
      location: { pathname: '/pair', search: '', replace() {} } },
  });
  vm.runInContext(handlers, context);
  return { context, requests, remembered, removed, stored };
}
const join = actor => ({ pairing: { confirm_code: '123' }, actor: { actor_id: actor, name: actor } });
for (const staleFailure of [false, true]) {
  const h = harness(), c = h.context;
  const firstJoin = c.startPairing(); h.requests[0].resolve(join('actor-A')); await firstJoin;
  const oldRedeem = c.redeem();
  assert.equal(h.requests[1].args.challenge, 'AAAAAAAAAAAA');
  c.challengeInput.value = 'BBBBBBBBBBBB';
  const nextJoin = c.startPairing(); h.requests[2].resolve(join('actor-B')); await nextJoin;
  const currentStatus = c.status;
  if (staleFailure) h.requests[1].reject({ details: { reason: 'not_approved' } });
  else h.requests[1].resolve({ actor_id: 'actor-A' });
  await oldRedeem;
  assert.equal(c.targetIdentity.actor_id, 'actor-B', 'old redemption must not replace new identity');
  assert.equal(c.switchButton.hidden, true, 'old redemption must not offer mismatched credential');
  assert.equal(c.status, currentStatus, 'old failures must not replace current pairing status');
  await c.switchIdentity();
  assert.equal(h.stored.length, 0, 'joined but unredeemed credentials cannot activate');
  // Editing the field must not change the in-progress attempt or cleanup key.
  c.challengeInput.value = 'CCCCCCCCCCCC';
  const currentRedeem = c.redeem();
  assert.equal(h.requests[3].args.challenge, 'BBBBBBBBBBBB');
  assert.equal(h.requests[3].token, h.requests[2].token);
  h.requests[3].resolve({ actor_id: 'actor-B' }); await currentRedeem;
  await c.switchIdentity();
  assert.deepEqual(h.remembered, [['actor-B', h.requests[2].token]]);
  assert.deepEqual(h.removed, ['pair:BBBBBBBBBBBB']);
}
console.log('PASS: stale pairing success/failure isolation, immutable challenge/token, redeem-only activation and cleanup');
