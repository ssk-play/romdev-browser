// NES: romdev's NES C project built with cc65 and booted in the same fceumm core the browser uses (bytes-only mode).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LibretroHost } from "romdev-core-host";
import { Cc65Toolchain, prgBytesUsed } from "../src/cc65.ts";
import { nesRuntime, nodeLoader, root, template } from "./helpers.mjs";

const tc = new Cc65Toolchain(nodeLoader());
const wasm = path.join(root, "dist", "wasm");
const hash = (host) => {
  const { rgba } = host.screenshotRgba();
  let h = 2166136261;
  for (let i = 0; i < rgba.length; i++) h = Math.imul(h ^ rgba[i], 16777619);
  return h >>> 0;
};
const colors = (host) => {
  const { rgba } = host.screenshotRgba();
  const s = new Set();
  for (let i = 0; i < rgba.length; i += 4) s.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  return s.size;
};

test("nes platformer builds to an iNES ROM: 32 KB PRG, CHR-RAM, battery", async () => {
  const r = await tc.build({ platform: "nes", sources: { "main.c": template("nes", "platformer") } }, nesRuntime());
  assert.ok(r.ok, r.log);
  const rom = r.rom;
  assert.deepEqual([...rom.subarray(0, 4)], [0x4e, 0x45, 0x53, 0x1a], "iNES magic");
  assert.equal(rom[4], 2, "2 x 16 KB PRG");
  assert.equal(rom[5], 0, "CHR-RAM");
  assert.equal(rom[6] & 0x02, 0x02, "battery PRG-RAM");
  assert.equal(rom.length, 16 + 32768);
  assert.ok(r.romBytesUsed > 1000 && r.romBytesUsed < 0x7ffa, `PRG used ${r.romBytesUsed}`);
});

test("nes platformer boots in fceumm, renders, reacts to A, and has battery RAM", async () => {
  const r = await tc.build({ platform: "nes", sources: { "main.c": template("nes", "platformer") } }, nesRuntime());
  assert.ok(r.ok, r.log);
  const factory = (await import(pathToFileURL(path.join(wasm, "fceumm.mjs")).href)).default;
  const host = new LibretroHost();
  await host.loadCore({ factory, wasmBinary: readFileSync(path.join(wasm, "fceumm.wasm")), io: false });
  await host.loadMedia({ platform: "nes", bytes: r.rom, name: "game.nes" });
  const { width, height } = host.screenshotRgba();
  assert.deepEqual([width, height], [256, 224], "NTSC picture, overscan cropped");
  assert.ok(host.status.coreFps > 59 && host.status.coreFps < 61, `fps ${host.status.coreFps}`);
  host.stepFrames(120);
  assert.ok(colors(host) > 1, "title screen should not be blank");
  const title = hash(host);
  host.setInput({ ports: [{ a: true }] });
  host.stepFrames(6);
  host.setInput({ ports: [{}] });
  host.stepFrames(60);
  assert.notEqual(hash(host), title, "A should leave the title screen");
  assert.equal(host.regionSize("save_ram"), 8192);
  assert.ok(host.state.audioRing.length > 0, "core should produce audio");
});

test("nes build errors name the file and line", async () => {
  const r = await tc.build({ platform: "nes", sources: { "main.c": '#include "nes_runtime.h"\nvoid main(void) {\n  oops = 1;\n}\n' } }, nesRuntime());
  assert.equal(r.ok, false);
  assert.equal(r.stage, "compile");
  const e = r.issues.find((i) => i.severity === "error");
  assert.ok(e && e.file === "main.c" && e.line === 3, JSON.stringify(r.issues));
});

test("PRG usage comes from the ld65 map", () => {
  const map = "Segment list:\n-------------\nName                   Start     End    Size  Align\n----------------------------------------------------\nCODE                  008000  0081FF  000200  00001\nRODATA                008200  00820F  000010  00001\nBSS                   000300  0003FF  000100  00001\n";
  assert.equal(prgBytesUsed(map), 0x210);
});
