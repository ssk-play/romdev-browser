// The headless service (dist/server.mjs): build a fixture over HTTP, run it with input, read memory and a PNG.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { root, template } from "./helpers.mjs";
import { fixture,config,frame,bundle } from "./bundle-helpers.mjs";
import {BundleReplay}from"../src/bundle-replay.ts";
import {boundaryDigest}from"../src/bundle-checkpoint.ts";
import {gbMultiplayer}from"./fixtures/multiplayer/gb.mjs";

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
  assert.equal(b.objects, undefined, "objects come back only when asked for");
  const kept = await post("/build", { platform: "gbc", sources: { "main.c": template("gbc", "platformer") }, objects: {} });
  assert.equal(kept.rom, b.rom);
  assert.equal(Object.keys(kept.objects).length, 1);
  assert.equal(typeof Object.values(kept.objects)[0].rel, "string");
  const r = await post("/run", { platform: "gbc", rom: b.rom, frames: 240, input: [{ frame: 120, until: 126, buttons: ["start"] }],
    shots: [100, 240], every: 60, memory: [{ offset: 0x1000, length: 16 }], sram: true });
  assert.deepEqual(r.rows.map((x) => x.frame), [60, 100, 120, 180, 240]);
  assert.equal(r.rows[0].memory[0].length, 32);
  assert.equal(r.shots.length, 2);
  assert.equal(Buffer.from(r.shots[0].png, "base64").subarray(1, 4).toString(), "PNG");
  assert.notEqual(r.shots[0].png, r.shots[1].png, "Start should change the screen");
  assert.equal(Buffer.from(r.sram, "base64").length, 8192);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.deepEqual({ ...health, version: undefined }, { ok: true, version: undefined, queued: 0, runningMs: 0, skipped: 0, stopped: 0 });
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

test("server hands fingers only to a game that asks for them", async (t) => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [path.join(root, "dist", "server.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: "pipe" });
  t.after(() => proc.kill());
  await new Promise((ok, fail) => { proc.stdout.on("data", ok); proc.on("exit", fail); });
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(body) })).json();
  // a 2-finger buffer; each frame the game copies it and the count to $D000.. so the run can read what it saw
  const game = (asks) => `#include "gb_hardware.h"
#include "gb_runtime.h"
__at (0xD000) unsigned char seen[7];
__at (0xD0F8) unsigned char header[6];
unsigned char fingers[6];
void main(void) {
  unsigned char i;
  ${asks ? "header[2] = (unsigned char)((unsigned int)fingers & 0xFF); header[3] = (unsigned char)((unsigned int)fingers >> 8); header[4] = 2; header[0] = 0x54; header[1] = 0x43;" : ""}
  for (;;) { wait_vblank(); for (i = 0; i < 6; i++) seen[i] = fingers[i]; seen[6] = header[5]; }
}
`;
  const input = [{ frame: 30, until: 60, buttons: [], touches: [{ x: 77, y: 33 }, { x: 10, y: 20 }] }];
  const asks = await post("/build", { platform: "gbc", sources: { "main.c": game(true) } });
  assert.ok(asks.ok, asks.log);
  const r = await post("/run", { platform: "gbc", rom: asks.rom, frames: 90, input, every: 45, memory: [{ offset: 0x1000, length: 7 }] });
  // both down at 45; at 90 both lifted, each keeping where it let go
  assert.deepEqual(r.rows.map((x) => x.memory[0]), ["014d21010a1402", "004d21000a1400"]);
  const other = await post("/build", { platform: "gbc", sources: { "main.c": game(false) } });
  const o = await post("/run", { platform: "gbc", rom: other.rom, frames: 90, input, every: 45, memory: [{ offset: 0x1000, length: 7 }] });
  assert.ok(o.rows.every((x) => x.memory[0] === "00000000000000"), JSON.stringify(o.rows));   // never written
});

test("headless bundle HTTP runs isolated canonical consoles and rejects invalid traces before boot",async t=>{
  const port=20000+Math.floor(Math.random()*1000),proc=spawn(process.execPath,[path.join(root,"dist","server.mjs")],{env:{...process.env,PORT:String(port)},stdio:"pipe"});t.after(()=>proc.kill());
  await new Promise((ok,fail)=>{proc.stdout.on("data",ok);proc.on("exit",fail);});
  const post=async body=>{const r=await fetch(`http://127.0.0.1:${port}/bundle/run`,{method:"POST",body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
  for(const p of ["gb","gbc","nes"]){
    const c=config(p,p==="nes"?"shared":"player-views",[0,1,2,3]),rom=await fixture(p),inputs=Array.from({length:16},(_,f)=>frame(c,f,[1,2,16,128]));
    const req={config:c,rom:Buffer.from(rom).toString("base64"),frames:16,input:inputs,shots:[16],every:8,memory:[{region:"system_ram",offset:p==="nes"?0x410:0,length:4}]};
    const result=await post(req);assert.equal(result.status,200,JSON.stringify(result.body));const r=result.body;
    assert.equal(r.consoleSlots.length,p==="nes"?1:4);assert.deepEqual(r.rows.map(x=>x.frame),[8,16]);
    assert.equal(Buffer.from(r.shots[0].consoles[0].png,"base64").subarray(1,4).toString(),"PNG");
    if(p!=="nes")assert.notEqual(r.shots[0].consoles[0].png,r.shots[0].consoles[1].png);
    else assert.equal(r.rows[1].consoles[0].memory[0],"01021080");
    const world={trigger:p==='nes'?0x604:0xc009,tick:{region:'system_ram',offset:p==='nes'?0x600:4,length:4},fields:[{name:'positions',region:'system_ram',offset:p==='nes'?0x308:0,length:4},...(p==='nes'?[]:[{name:'score',region:'system_ram',offset:8,length:1}])]};
    const checked=await post({...req,world});assert.equal(checked.status,200,JSON.stringify(checked.body));assert.ok(checked.body.world.checkedTicks>8);assert.equal(checked.body.digest,r.digest);assert.deepEqual(checked.body.shots,r.shots);assert.deepEqual(checked.body.rows,r.rows);
    if(p!=='nes'){
      const bad=await post({...req,config:{...c,slots:[0,2]},input:[],world,rom:Buffer.from(gbMultiplayer(p==='gbc',true)).toString('base64')});
      assert.equal(bad.status,400);assert.match(bad.body.error,/world mismatch at tick 1.*slots 0\/2 field score/);
    }
    // Independent in-process worker adapter must agree with the separate HTTP program.
    const b=await bundle(c,r.build);try{const replay=new BundleReplay(b);for(const f of inputs){replay.enqueue(f);while(!replay.pump(8,1).complete){}replay.confirm(f.frame);}assert.equal(await boundaryDigest(b.descriptorHash,replay.checkpoint(15),{eventSeq:-1,chainHash:"0".repeat(16)}),r.digest);}finally{b.dispose();}
    for(const bad of [{...req,frames:3601},{...req,input:[inputs[1]]},{...req,memory:[{region:"save_ram",offset:0x100000,length:1}]}])assert.equal((await post(bad)).status,400);
  }
});

test("server answers while a job runs, refuses a full queue and stops a job past its deadline", async (t) => {
  const start = async (env) => {
    const port = 18000 + Math.floor(Math.random() * 1000);
    const proc = spawn(process.execPath, [path.join(root, "dist", "server.mjs")], { env: { ...process.env, ...env, PORT: String(port) }, stdio: "pipe" });
    t.after(() => proc.kill());
    await new Promise((ok, fail) => { proc.stdout.on("data", ok); proc.on("exit", fail); });
    const post = async (p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
    const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).json();
    return { post, health };
  };
  const { rom } = await (await start({})).post("/build", { platform: "gbc", sources: { "main.c": template("gbc", "platformer") } });
  const lab = await start({ GAMELAB_QUEUE_MAX: "1", GAMELAB_JOB_MS: "2000" });

  const long = lab.post("/run", { platform: "gbc", rom, frames: 36000 });
  await new Promise((ok) => setTimeout(ok, 300));
  const busy = await lab.health();
  assert.equal(busy.queued, 1, "/health answers while the job runs");
  const refused = await lab.post("/run", { platform: "gbc", rom, frames: 10 });
  assert.equal(refused.status, 503);
  assert.match(refused.error, /busy/);

  const stoppedRun = await long;
  assert.equal(stoppedRun.status, 504);
  assert.match(stoppedRun.error, /run took longer than 2 s and was stopped/);
  const after = await lab.post("/run", { platform: "gbc", rom, frames: 10, memory: [{ offset: 0x1000, length: 1 }] });
  assert.equal(after.status, 200, "a fresh job thread takes the next job");
  assert.equal(after.rows.length, 1);
  const h = await lab.health();
  assert.deepEqual([h.queued, h.stopped], [0, 1]);
});

test("server skips a job whose caller left before its turn", async (t) => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [path.join(root, "dist", "server.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: "pipe" });
  t.after(() => proc.kill());
  await new Promise((ok, fail) => { proc.stdout.on("data", ok); proc.on("exit", fail); });
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const post = (p, body, signal) => fetch(url(p), { method: "POST", body: JSON.stringify(body), signal });
  const { rom } = await (await post("/build", { platform: "gbc", sources: { "main.c": template("gbc", "platformer") } })).json();
  const first = post("/run", { platform: "gbc", rom, frames: 12000 });
  await new Promise((ok) => setTimeout(ok, 200));
  const leaving = new AbortController();
  const left = post("/run", { platform: "gbc", rom, frames: 36000 }, leaving.signal).catch((e) => e);
  await new Promise((ok) => setTimeout(ok, 200));
  assert.equal((await (await fetch(url("/health"))).json()).queued, 2);
  leaving.abort();
  assert.equal((await left).name, "AbortError");
  await new Promise((ok) => setTimeout(ok, 200));
  assert.equal((await (await fetch(url("/health"))).json()).queued, 1, "the slot is free as soon as the caller leaves");
  assert.equal((await first).status, 200);
  const h = await (await fetch(url("/health"))).json();
  assert.deepEqual([h.queued, h.skipped], [0, 1]);
});
