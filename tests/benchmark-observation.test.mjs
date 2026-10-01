import test from 'node:test';
import assert from 'node:assert/strict';
import { LibretroHost } from 'romdev-core-host';
import { BundleSession } from '../src/bundle-session.ts';
import { bundle, config, fixture, frame } from './bundle-helpers.mjs';

// /benchmark loads bundle.worker, which delegates these requests to BundleSession.
// Use its actual native cores, including restores and replay, rather than the
// separate world-check worker that deliberately enables diagnostic observation.
const position = { eventSeq: 0, chainHash: '0000000000000000' };

function assertUnobserved(host) {
  assert.throws(() => host.drainWorldObservation(), /no world observation armed/);
  const mod = host.mod;
  const meta = mod._malloc(12);
  assert.ok(meta);
  try {
    assert.equal(mod._romdev_observe_get(0, 0, meta, 0), 0);
    const counts = new DataView(mod.HEAPU8.buffer, meta, 12);
    assert.equal(counts.getUint32(0, true), 0, 'no native publication copies');
    assert.equal(counts.getUint32(4, true), 0, 'no retained observation events');
  } finally {
    mod._free(meta);
  }
}

for (const platform of ['gb', 'gbc', 'nes']) {
  for (const mode of platform === 'nes' ? ['shared'] : ['shared', 'player-views']) {
    for (const slots of [[0], [0, 2], [0, 1, 2, 3]]) {
      test(`${platform}/${mode}/${slots.length}: benchmark worker never arms world observation`, async t => {
        const c = config(platform, mode, slots);
        let loaded;
        let arms = 0;
        t.mock.method(LibretroHost.prototype, 'startWorldObservation', () => {
          assert.fail('benchmark enabled diagnostic world observation');
        });
        const session = new BundleSession('benchmark-observation', async req => {
          loaded = await bundle(req.config, 'benchmark-observation', req.rom);
          for (const { host } of loaded.consoles) {
            assertUnobserved(host);
            const mod = host.mod;
            const arm = mod._romdev_observe_arm;
            t.mock.method(mod, '_romdev_observe_arm', enabled => {
              if (enabled) arms++;
              return arm(enabled);
            });
          }
          return loaded;
        }, () => {});
        t.after(() => session.handle({ type: 'dispose', id: 999 }));
        let id = 0;
        const call = req => session.handle({ id: ++id, ...req });
        const complete = async out => {
          while (!out.complete) out = await call({ type: 'pump' });
        };

        await call({ type: 'load', config: c, rom: await fixture(platform) });
        const initial = await call({ type: 'checkpoint', afterFrame: -1, position });
        for (let f = 0; f < 24; f++) {
          await complete(await call({ type: 'frame', input: frame(c, f) }));
        }
        const corrected = Array.from({ length: 24 }, (_, f) => frame(c, f, [1, 2, 1, 2]));
        await call({ type: 'correct', inputs: corrected.slice(12), confirmed: -1 });
        await call({ type: 'pump', maxOperations: 1 });
        await call({ type: 'correct', inputs: corrected.slice(0, 12), confirmed: 23 });
        await complete(await call({ type: 'pump' }));
        const checkpoint = await call({ type: 'checkpoint', afterFrame: 23, position });
        const digest = await call({ type: 'digest', afterFrame: 23, position });
        assert.equal(digest.bundleDigest, checkpoint.bundleDigest);
        for (const { host } of loaded.consoles) assertUnobserved(host);

        await call({ type: 'restore', ...initial, position });
        await complete(await call({ type: 'frame', input: frame(c, 0, [1, 2, 1, 2]) }));
        await call({ type: 'confirm', frame: 0 });
        for (const { host } of loaded.consoles) assertUnobserved(host);
        assert.equal(arms, 0);
      });
    }
  }
}
