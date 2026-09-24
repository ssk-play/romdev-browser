// Boots toolchain-built ROMs in the same patched gambatte core the browser uses (bytes-only mode).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LibretroHost } from "romdev-core-host";
import { Toolchain } from "../src/toolchain.ts";
import { nodeLoader, root, runtimeFor, template } from "./helpers.mjs";

const tc = new Toolchain(nodeLoader());
const wasm = path.join(root, "dist", "wasm");

async function boot(platform, rom) {
  const factory = (await import(pathToFileURL(path.join(wasm, "gambatte.mjs")).href)).default;
  const host = new LibretroHost();
  await host.loadCore({ factory, wasmBinary: readFileSync(path.join(wasm, "gambatte.wasm")), io: false });
  await host.loadMedia({ platform, bytes: rom, name: `game.${platform}` });
  return host;
}

const colors = (host) => {
  const { rgba } = host.screenshotRgba();
  const s = new Set();
  for (let i = 0; i < rgba.length; i += 4) s.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  return s.size;
};
const hash = (host) => {
  const { rgba } = host.screenshotRgba();
  let h = 2166136261;
  for (let i = 0; i < rgba.length; i++) h = Math.imul(h ^ rgba[i], 16777619);
  return h >>> 0;
};

for (const platform of ["gb", "gbc"]) {
  test(`${platform} platformer boots, renders, reacts to Start, and has battery RAM`, async () => {
    const r = await tc.build({ platform, sources: { "main.c": template(platform, "platformer") } }, runtimeFor(platform));
    assert.ok(r.ok, r.log);
    const host = await boot(platform, r.rom);
    host.stepFrames(120);
    assert.ok(colors(host) > 1, "title screen should not be blank");
    const title = hash(host);
    host.setInput({ ports: [{ start: true }] });
    host.stepFrames(6);
    host.setInput({ ports: [{}] });
    host.stepFrames(60);
    assert.notEqual(hash(host), title, "Start should leave the title screen");
    assert.equal(host.regionSize("save_ram"), 8192);
    assert.ok(host.state.audioRing.length > 0, "core should produce audio");
  });
}
