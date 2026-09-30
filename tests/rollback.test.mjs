import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LibretroHost } from "romdev-core-host";
import { RollbackCore } from "../src/rollback.ts";
import { Cc65Toolchain } from "../src/cc65.ts";
import { nesRuntime, nodeLoader, root, template } from "./helpers.mjs";

test("full fceumm snapshots resimulate to identical RAM, video and future behavior; replay audio is discarded", async () => {
  const tc = new Cc65Toolchain(nodeLoader());
  const build = await tc.build({ platform: "nes", sources: { "main.c": template("nes", "platformer") } }, nesRuntime());
  assert.ok(build.ok, build.log);
  const wasm = path.join(root, "dist/wasm");
  const factory = (await import(pathToFileURL(path.join(wasm, "fceumm.mjs")).href)).default;
  const host = new LibretroHost();
  await host.loadCore({ factory, wasmBinary: readFileSync(path.join(wasm, "fceumm.wasm")), io: false });
  await host.loadMedia({ platform: "nes", bytes: build.rom, name: "rollback.nes" });
  const buttons = ["right", "left", "up", "down", "a", "b", "select", "start"];
  const core = {
    save: () => host.serializeState(), restore: state => host.unserializeState(state),
    frame: masks => {
      host.setInput({ ports: masks.map(mask => Object.fromEntries(buttons.map((b, i) => [b, !!(mask & (1 << i))]))) });
      host.stepFrames(1);
    },
    hash: () => {
      let h = 2166136261;
      for (const region of ["system_ram", "save_ram"]) for (const byte of host.readMemory(region, 0, host.regionSize(region))) h = Math.imul(h ^ byte, 16777619);
      return h >>> 0;
    },
    discardAudio: () => { host.state.audioRing.length = 0; },
  };
  const inputs = Array.from({ length: 600 }, (_, n) => [n < 10 ? 16 : n % 91 < 40 ? 1 : 18, n % 53 < 20 ? 2 : 32]);
  const initial = core.save(); const hashes = [], videos = [];
  for (let n = 0; n < inputs.length; n++) {
    core.frame(inputs[n]); core.discardAudio();
    hashes.push(core.hash()); videos.push(Uint8Array.from(host.screenshotRgba().rgba));
  }
  const baselineState = core.save();
  core.restore(initial); core.discardAudio();
  const rollback = new RollbackCore(core);
  assert.ok(rollback.bytes > 8192, "snapshot contains more than cart RAM");
  const checkpoints = new Map();
  for (let from = 0; from < inputs.length; from += 12) {
    for (let n = from; n < from + 12; n++) rollback.step(n, [inputs[n][0], 0], from - 1);
    for (const c of rollback.replay(from, inputs.slice(from, from + 12), from + 11)) checkpoints.set(c.seq, c.hash);
    assert.equal(core.hash(), hashes[from + 11]);
    assert.deepEqual(Uint8Array.from(host.screenshotRgba().rgba), videos[from + 11]);
    assert.equal(host.state.audioRing.length, 0, "resimulation must not replay sound");
    assert.throws(() => rollback.replay(from, inputs.slice(from, from + 12), from + 11), /outside history/);
  }
  for (const [seq, hash] of checkpoints) assert.equal(hash, hashes[seq]);
  // A restored CPU/PPU state must also continue correctly beyond the last compared image.
  core.frame([17, 32]); const future = core.hash(), video = Uint8Array.from(host.screenshotRgba().rgba);
  core.restore(baselineState); core.frame([17, 32]);
  assert.equal(core.hash(), future); assert.deepEqual(Uint8Array.from(host.screenshotRgba().rgba), video);
});
