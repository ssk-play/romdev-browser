// The headless service (dist/server.mjs): build a fixture over HTTP, run it with input, read memory and a PNG.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { root, template } from "./helpers.mjs";

test("server builds and runs a GBC game over HTTP", async (t) => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [path.join(root, "dist", "server.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: "pipe" });
  t.after(() => proc.kill());
  await new Promise((ok, fail) => { proc.stdout.on("data", ok); proc.on("exit", fail); });
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(body) })).json();

  const bad = await post("/build", { platform: "gbc", sources: { "main.c": "void main(void) { oops }" } });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.severity === "error" && i.line), JSON.stringify(bad.issues));

  const b = await post("/build", { platform: "gbc", sources: { "main.c": template("gbc", "platformer") } });
  assert.ok(b.ok, b.log);
  const r = await post("/run", { platform: "gbc", rom: b.rom, frames: 240, input: [{ frame: 120, until: 126, buttons: ["start"] }],
    shots: [100, 240], every: 60, memory: [{ offset: 0x1000, length: 16 }], sram: true });
  assert.deepEqual(r.rows.map((x) => x.frame), [60, 100, 120, 180, 240]);
  assert.equal(r.rows[0].memory[0].length, 32);
  assert.equal(r.shots.length, 2);
  assert.equal(Buffer.from(r.shots[0].png, "base64").subarray(1, 4).toString(), "PNG");
  assert.notEqual(r.shots[0].png, r.shots[1].png, "Start should change the screen");
  assert.equal(Buffer.from(r.sram, "base64").length, 8192);
});

test("server builds and runs __banked code and data past 4 MB (MBC5)", async (t) => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [path.join(root, "dist", "server.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: "pipe" });
  t.after(() => proc.kill());
  await new Promise((ok, fail) => { proc.stdout.on("data", ok); proc.on("exit", fail); });
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(body) })).json();
  for (const platform of ["gb", "gbc"]) {
    const sources = {
      "main.c": `#include "gb_hardware.h"
#include "gb_runtime.h"
unsigned char far_sum(unsigned char a, unsigned char b) __banked;
extern const unsigned char far_data[];
__at (0xD000) unsigned char result;
__at (0xD001) unsigned char read_hi;
__at (0xD002) unsigned char bank_after;
void main(void) {
  unsigned int back;
  result = far_sum(3, 4);
  back = current_rom_bank;
  SWITCH_ROM(300);
  read_hi = (unsigned char)(far_data[0] + far_data[2]);
  SWITCH_ROM(back);
  bank_after = (unsigned char)current_rom_bank;
  for (;;) wait_vblank();
}
`,
      "far.c": `#include "gb_runtime.h"
#pragma codeseg CODE_3
#pragma constseg CODE_3
static const unsigned char magic[] = { 40, 2 };
unsigned char far_sum(unsigned char a, unsigned char b) __banked { return (unsigned char)(a + b + magic[0] + magic[1]); }
`,
      "high.c": "#pragma constseg CODE_300\nconst unsigned char far_data[] = { 0x5A, 0xA5, 0x3C };\n",
    };
    const b = await post("/build", { platform, sources });
    assert.ok(b.ok, b.log);
    assert.deepEqual(Object.keys(b.banks).map(Number), [3, 300]);
    const rom = Buffer.from(b.rom, "base64");
    assert.equal(rom.length, 8 * 1024 * 1024);
    assert.deepEqual([rom[0x147], rom[0x148]], [0x1b, 8], "MBC5 + RAM + battery, 8 MB");
    assert.deepEqual([...rom.subarray(300 * 0x4000, 300 * 0x4000 + 3)], [0x5a, 0xa5, 0x3c]);
    const r = await post("/run", { platform, rom: b.rom, frames: 20, memory: [{ offset: 0x1000, length: 3 }] });
    // far_sum = 3 + 4 + 40 + 2 = 0x31, bank 300 read 0x5A + 0x3C = 0x96, back in bank 1
    assert.equal(r.rows.at(-1).memory[0], "319601", platform);
  }
});

test("server builds and runs NES next to GBC in one process", async (t) => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [path.join(root, "dist", "server.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: "pipe" });
  t.after(() => proc.kill());
  await new Promise((ok, fail) => { proc.stdout.on("data", ok); proc.on("exit", fail); });
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(body) })).json();

  const nes = await post("/build", { platform: "nes", sources: { "main.c": template("nes", "platformer") } });
  assert.ok(nes.ok, nes.log);
  assert.equal(Buffer.from(nes.rom, "base64").subarray(0, 4).toString("latin1"), "NES\x1a");
  const gbc = await post("/build", { platform: "gbc", sources: { "main.c": template("gbc", "platformer") } });
  assert.ok(gbc.ok, gbc.log);

  const run = (platform, rom) => post("/run", { platform, rom, frames: 200, input: [{ frame: 120, until: 126, buttons: ["a", "start"] }],
    shots: [100, 200], memory: [{ offset: 0, length: 16 }], sram: true });
  const a = await run("nes", nes.rom);
  const pngSize = (b64) => { const b = Buffer.from(b64, "base64"); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  assert.deepEqual(pngSize(a.shots[0].png), [256, 224]);
  assert.notEqual(a.shots[0].png, a.shots[1].png, "A should change the screen");
  assert.equal(Buffer.from(a.sram, "base64").length, 8192);
  const b = await run("gbc", gbc.rom);   // back to the Game Boy core
  assert.deepEqual(pngSize(b.shots[0].png), [160, 144]);
  const c = await run("nes", nes.rom);   // and NES again: same frames as the first run
  assert.equal(c.shots[1].png, a.shots[1].png);

  const bad = await post("/build", { platform: "snes", sources: { "main.c": "" } });
  assert.match(bad.error, /platform: gb or gbc or nes/);
});
