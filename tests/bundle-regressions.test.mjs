import test from 'node:test';
import assert from 'node:assert/strict';
import { BundleReplay } from '../src/bundle-replay.ts';
import { BundleSession, BundleMessageQueue } from '../src/bundle-session.ts';
import { boundaryDigest, encodeCheckpoint } from '../src/bundle-checkpoint.ts';
import { validateConfig } from '../src/multiplayer.ts';
import { bundle, config, frame, fixture } from './bundle-helpers.mjs';

function drain(r) {
  let operations = 0;
  while (!r.pump(8, 1).complete) assert.ok(++operations < 1000);
}
const position = { eventSeq: 1, chainHash: '1234567890abcdef' };

test('descriptor is canonical for key/slot order, rejects unknown keys and binds semantic differences', async t => {
  const c = config('gbc', 'player-views', [0, 2]);
  const reordered = Object.fromEntries(Object.entries(c).reverse());
  reordered.slots = [2, 0];
  const a = await bundle(c), b = await bundle(reordered), different = await bundle({ ...c, seed: 13 });
  t.after(() => { a.dispose(); b.dispose(); different.dispose(); });
  assert.equal(a.descriptorHash, b.descriptorHash);
  assert.notEqual(a.descriptorHash, different.descriptorHash);
  assert.deepEqual(a.config.slots, [0, 2]);
  const ba = a.boundary(0), bb = b.boundary(0);
  assert.equal(await boundaryDigest(a.descriptorHash, ba, position), await boundaryDigest(b.descriptorHash, bb, position));
  for (const invalid of [null, [], { ...c, roomId: 'extra' }, { ...c, abi: 1 }]) {
    assert.throws(() => validateConfig(invalid), /configuration/);
  }
  await assert.rejects(bundle({ ...c, roomId: 'extra' }), /configuration/);
});

test('prediction window, compute backlog, non-contiguous frame and correction batch rejection do not mutate input admission', async t => {
  const c = { ...config('nes', 'shared', [0]), window: 2 }, b = await bundle(c);
  t.after(() => b.dispose());
  const r = new BundleReplay(b);
  assert.throws(() => r.enqueue(frame(c, 1)), /non-contiguous/);
  assert.equal(r.targetFrame, 0);
  r.enqueue(frame(c, 0)); r.enqueue(frame(c, 1));
  assert.throws(() => r.enqueue(frame(c, 2)), /prediction\/compute backlog/);
  r.confirm(1); // Authoritative input may arrive before local computation.
  assert.throws(() => r.enqueue(frame(c, 2)), /prediction\/compute backlog/);
  assert.equal(r.targetFrame, 2);
  assert.throws(() => r.correct([frame(c, 0), frame(c, 1), frame(c, 2)], 1), /too large/);
  drain(r);
  r.enqueue(frame(c, 2)); drain(r); r.confirm(2);
  assert.throws(() => r.checkpoint(0), /retained history/);
});

test('recent confirmed repeats are harmless, conflicts are immutable, old repeats never recreate retired inputs', async t => {
  const c = { ...config('nes', 'shared', [0]), window: 2 }, b = await bundle(c);
  t.after(() => b.dispose());
  const r = new BundleReplay(b);
  for (let f = 0; f < 6; f++) { r.enqueue(frame(c, f)); drain(r); r.confirm(f); }
  const before = b.boundary(6);
  r.correct([frame(c, 5), frame(c, 5)], 5);
  assert.deepEqual(b.boundary(6), before);
  assert.throws(() => r.correct([frame(c, 5, [1, 0, 0, 0])], 5), /immutable/);
  r.enqueue(frame(c, 6)); drain(r);
  r.correct([frame(c, 5), frame(c, 6, [2, 0, 0, 0])], 6);
  drain(r);
  assert.equal(r.correcting, false);
  const after = b.boundary(7);
  r.correct([frame(c, 0)], 6);
  assert.deepEqual(b.boundary(7), after);
  assert.notDeepEqual(after, before);
  assert.throws(() => r.correct([frame(c, 7)], 6), /retained inputs/);
});

test('invalid later correction entries cannot partially apply a valid earlier change', async t => {
  const c = config('nes', 'shared', [0]), b = await bundle(c), oracle = await bundle(c);
  t.after(() => { b.dispose(); oracle.dispose(); });
  const r = new BundleReplay(b), expected = new BundleReplay(oracle);
  for (let f = 0; f < 3; f++) { r.enqueue(frame(c, f)); expected.enqueue(frame(c, f)); drain(r); drain(expected); }
  assert.throws(() => r.correct([frame(c, 0, [1, 0, 0, 0]), frame(c, 9)], 2), /retained inputs/);
  assert.equal(r.confirmed, -1);
  assert.equal(r.correcting, false);
  r.correct([frame(c, 1, [2, 0, 0, 0])], 2); drain(r);
  expected.correct([frame(c, 1, [2, 0, 0, 0])], 2); drain(expected);
  assert.deepEqual(r.checkpoint(2), expected.checkpoint(2));
});

test('partial three-console correction matches uninterrupted state, presentation and first-frame audio', async t => {
  const c = config('gbc', 'player-views', [0, 1, 2]), a = await bundle(c), b = await bundle(c);
  t.after(() => { a.dispose(); b.dispose(); });
  const r = new BundleReplay(a), expected = new BundleReplay(b), input = frame(c, 0, [1, 2, 1, 0]);
  const shown = r.display();
  r.enqueue(frame(c, 0)); r.pump(8, 1);
  r.correct([input], 0);
  assert.deepEqual(r.display(), shown);
  assert.equal(r.drainAudio().length, 0);
  expected.enqueue(input); drain(expected); expected.confirm(0);
  drain(r);
  assert.deepEqual(r.checkpoint(0), expected.checkpoint(0));
  assert.deepEqual(r.display(), expected.display());
  const audio = r.drainAudio();
  assert.ok(audio.reduce((n, chunk) => n + chunk.length, 0) > 0);
  assert.deepEqual(audio, expected.drainAudio());
});

test('successful restore holds a marked stale complete image until the next complete bundle frame', async t => {
  const c = config('gbc', 'player-views', [0, 2]), b = await bundle(c), a = await bundle(c);
  t.after(() => { b.dispose(); a.dispose(); });
  const r = new BundleReplay(b), expected = new BundleReplay(a), boot = r.checkpoint(-1);
  for (let f = 0; f < 8; f++) { r.enqueue(frame(c, f, [1, 0, 2, 0])); drain(r); r.confirm(f); }
  const shown = r.display();
  r.restoreCheckpoint(boot);
  assert.equal(r.presentationStale, true);
  assert.deepEqual(r.display(), shown);
  r.enqueue(frame(c, 0));
  assert.equal(r.pump(8, 1).presentationStale, true);
  assert.deepEqual(r.display(), shown);
  drain(r); expected.enqueue(frame(c, 0)); drain(expected);
  assert.equal(r.presentationStale, false);
  assert.deepEqual(r.display(), expected.display());
});

test('digest-only reads a retained confirmed boundary without copying or serializing snapshot bytes', async t => {
  const c = config('nes', 'shared', [0]), b = await bundle(c);
  t.after(() => b.dispose());
  const r = new BundleReplay(b);
  r.enqueue(frame(c, 0)); drain(r); r.confirm(0);
  const encoded = await encodeCheckpoint(b.descriptorHash, r.checkpoint(0), position);
  t.mock.method(b, 'capture', () => { throw Error('unexpected serialize'); });
  const slice = Uint8Array.prototype.slice;
  t.mock.method(Uint8Array.prototype, 'slice', function (...args) {
    if (this.length > 32) throw Error('unexpected snapshot copy');
    return slice.apply(this, args);
  });
  const boundary = r.digestBoundary(0);
  assert.ok(boundary.states.every(s => !('bytes' in s)));
  // Hashing the small canonical digest metadata is expected; no snapshot bytes.
  t.mock.restoreAll();
  assert.equal(await boundaryDigest(b.descriptorHash, boundary, position), encoded.bundleDigest);
});

test('worker frame budget errors are atomic; malformed messages do not poison later replies', async t => {
  const c = config('gbc', 'player-views', [0, 2]), events = [];
  const post = event => events.push(event);
  const session = new BundleSession('queue-build', req => bundle(req.config, 'queue-build', req.rom), post);
  const queue = new BundleMessageQueue(session, post);
  t.after(() => session.handle({ type: 'dispose', id: 999 }));
  await queue.receive({ type: 'load', id: 1, config: c, rom: await fixture('gbc') });
  assert.equal(events.at(-1).ok, true);
  await queue.receive({ type: 'frame', id: 2, input: frame(c, 0), budgetMs: 16 });
  assert.match(events.at(-1).error, /slice budget/);
  await queue.receive({ type: 'frame', id: 3, input: frame(c, 0) });
  assert.equal(events.at(-1).ok, true);
  assert.equal(events.at(-1).value.targetFrame, 1);
  for (const value of [null, [], { id: -1, type: 'pump' }, { id: '4', type: 'pump' }]) {
    await queue.receive(value);
    assert.equal(events.at(-1).ok, false);
    assert.match(events.at(-1).error, /invalid\/full/);
  }
  await queue.receive({ type: 'unknown', id: 4 });
  assert.equal(events.at(-1).ok, false);
  await queue.receive({ type: 'frame', id: 5, input: frame(c, 1) });
  assert.equal(events.at(-1).ok, true);
  assert.equal(events.at(-1).value.targetFrame, 2);
  await queue.receive({ type: 'pump', id: 6, maxOperations: 129 });
  assert.match(events.at(-1).error, /slice budget/);
  await queue.receive({ type: 'pump', id: 7 });
  assert.equal(events.at(-1).ok, true);
});

test('worker admission is bounded while load is pending, then resumes without dropping accepted messages', async t => {
  const c = config('nes', 'shared', [0]), events = [], post = event => events.push(event);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const session = new BundleSession('queue-build', async req => {
    await gate;
    return bundle(req.config, 'queue-build', req.rom);
  }, post);
  const queue = new BundleMessageQueue(session, post);
  t.after(() => session.handle({ type: 'dispose', id: 999 }));
  const accepted = [queue.receive({ type: 'load', id: 0, config: c, rom: await fixture('nes') })];
  for (let id = 1; id < 64; id++) accepted.push(queue.receive({ type: 'pump', id }));
  await queue.receive({ type: 'pump', id: 64 });
  assert.equal(events.at(-1).id, 64);
  assert.equal(events.at(-1).ok, false);
  release(); await Promise.all(accepted);
  const replies = events.filter(e => e.type === 'reply' && e.id < 64);
  assert.deepEqual(replies.map(e => e.id), Array.from({ length: 64 }, (_, i) => i));
  assert.ok(replies.every(e => e.ok));
  await queue.receive({ type: 'frame', id: 65, input: frame(c, 0) });
  assert.equal(events.at(-1).ok, true);
});

test('worker digest matches checkpoint agreement without invoking checkpoint copying and restore advertises stale presentation', async t => {
  const c = config('nes', 'shared', [0]), post = () => {};
  const session = new BundleSession('digest-build', req => bundle(req.config, 'digest-build', req.rom), post);
  t.after(() => session.handle({ type: 'dispose', id: 999 }));
  await session.handle({ type: 'load', id: 0, config: c, rom: await fixture('nes') });
  const boot = await session.handle({ type: 'checkpoint', id: 1, afterFrame: -1, position });
  t.mock.method(BundleReplay.prototype, 'checkpoint', () => { throw Error('unexpected checkpoint'); });
  const digest = await session.handle({ type: 'digest', id: 2, afterFrame: -1, position });
  assert.equal(digest.bundleDigest, boot.bundleDigest);
  t.mock.restoreAll();
  const restored = await session.handle({ type: 'restore', id: 3, ...boot, position });
  assert.equal(restored.presentationStale, true);
  let out = await session.handle({ type: 'frame', id: 4, input: frame(c, 0) });
  while (!out.complete) out = await session.handle({ type: 'pump', id: 5 });
  assert.equal(out.presentationStale, false);
});
