/// <reference lib="webworker" />
import { LibretroHost } from 'romdev-core-host';
import { ConsoleBundle } from './bundle.ts';
import { WorldObserver, WorldMismatch, type WorldObservation } from './world-observation.ts';
import { hex, sha256, type BundleConfig } from './multiplayer.ts';
import { CORES } from './platforms.ts';

declare const __BUNDLE_BUILD__: string;
const scope = self as unknown as DedicatedWorkerGlobalScope;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
async function bytes(url: URL) { const r = await fetch(url); if (!r.ok) throw Error('Diagnostic asset unavailable'); const data: ArrayBuffer = await r.arrayBuffer(); return new Uint8Array(data); }
const layout = (nes: boolean): WorldObservation => ({ trigger: nes ? 0x604 : 0xc009,
  tick: { region: 'system_ram', offset: nes ? 0x600 : 4, length: 4 },
  fields: [{ name: 'positions', region: 'system_ram', offset: nes ? 0x308 : 0, length: 4 },
    ...(nes ? [] : [{ name: 'score', region: 'system_ram' as const, offset: 8, length: 1 }])] });
async function run() {
  const fixtures = await fetch(new URL('./benchmark/world-fixtures.json', import.meta.url)).then(r => { if (!r.ok) throw Error('Fixture manifest unavailable'); return r.json(); });
  if (fixtures.build !== __BUNDLE_BUILD__) throw Error('Fixture/worker build mismatch');
  const results: unknown[] = [];
  for (const platform of ['gb', 'gbc', 'nes'] as const) {
    const core = CORES[platform], factory = (await import(new URL(`./wasm/${core}.mjs`, import.meta.url).href)).default;
    const wasmBinary = await bytes(new URL(`./wasm/${core}.wasm`, import.meta.url));
    const host = async () => { const h = new LibretroHost(); try { await h.loadCore({factory, wasmBinary, io: false}); return h; } catch (e) { h.dispose(); throw e; } };
    for (const negative of platform === 'nes' ? [false] : [false, true]) {
      const artifact = fixtures.roms[negative ? `${platform}-negative` : platform];
      const rom = await bytes(new URL(`./benchmark/${artifact.file}`, import.meta.url));
      if (hex(await sha256(rom)) !== artifact.sha256) throw Error('Fixture integrity mismatch');
      for (const slots of negative ? [[0, 2]] : platform === 'nes' ? [[0, 1, 2, 3]] : [[0], [0, 2], [0, 1, 2, 3]]) {
        const config: BundleConfig = {platform, mode: platform === 'nes' ? 'shared' : 'player-views', slots, capacity: 4, epoch: 7, seed: 12, policy: 'replace', window: 24, rtcEpochSeconds: 0};
        let b: ConsoleBundle | null = null, baseline: ConsoleBundle | null = null, world: WorldObserver | null = null;
        try {
          b = await ConsoleBundle.boot(config, rom, __BUNDLE_BUILD__, host);
          baseline = await ConsoleBundle.boot(config, rom, __BUNDLE_BUILD__, host);
          world = new WorldObserver(b, layout(platform === 'nes')); let rejected: WorldMismatch | null = null;
          for (let f = 0; f < 35; f++) {
            const input = { frame: f, masks: [0, 0, 0, 0], states: [0, 1, 2, 3].map(s => slots.includes(s) ? 1 : 0) };
            for (let i = 0; i < b.consoles.length; i++) {
              b.runConsole(i, input); baseline.runConsole(i, input);
              const a = b.capture(i), z = baseline.capture(i);
              if (a.schema !== z.schema || !same(a.digest, z.digest) || !same(a.bytes, z.bytes)) throw Error(`Observation changed state at ${platform}/${slots.length} frame ${f}`);
            }
            try { world.collect(b, f + 1); } catch (e) { if (negative && e instanceof WorldMismatch) { rejected = e; break; } throw e; }
          }
          if (negative && (!rejected || rejected.difference.tick !== 1 || rejected.difference.field !== 'score' || rejected.difference.expected !== '00' || rejected.difference.actual !== '02')) throw Error('Invalid world was not rejected precisely');
          const pixels = b.pixels(), original = baseline.pixels();
          if (pixels.some((p, i) => !same(p.rgba, original[i].rgba))) throw Error('Observation changed pixels');
          if (!negative && platform !== 'nes' && slots.length > 1 && same(pixels[0].rgba, pixels[1].rgba)) throw Error('Player views did not differ');
          results.push({platform, slots, negative, stateParity: true, pixelParity: true,
            world: negative ? rejected!.difference : world.result()});
          scope.postMessage({complete: false, build: __BUNDLE_BUILD__, results});
        } finally { if (b) world?.dispose(b); b?.dispose(); baseline?.dispose(); }
      }
    }
  }
  scope.postMessage({complete: true, build: __BUNDLE_BUILD__, results});
}
let started = false;
scope.onmessage = () => { if (started) return; started = true; run().catch(e => scope.postMessage({error: String((e as Error)?.message ?? e)})); };
