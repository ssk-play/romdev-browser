// Independent real-core check for a released NES cartridge's network menu.
// node scripts/network-menu-smoke.mjs https://dev.chiptoy.com <game UUID>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LibretroHost } from 'romdev-core-host';
import { NetworkBridge } from '../src/network-bridge.ts';
const [origin,game]=process.argv.slice(2),browser=new URL('../',import.meta.url);
assert.ok(['dev.chiptoy.com','127.0.0.1','localhost'].includes(new URL(origin).hostname));
const r=await fetch(`${origin}/api/play/${game}/rom`);assert.equal(r.status,200);const rom=new Uint8Array(await r.arrayBuffer());
const factory=(await import(new URL('dist/wasm/fceumm.mjs',browser))).default;
const host=new LibretroHost();await host.loadCore({factory,wasmBinary:readFileSync(new URL('dist/wasm/fceumm.wasm',browser)),io:false});
await host.loadMedia({platform:'nes',bytes:rom,name:'menu.nes'});
const bridge=new NetworkBridge(),actions=[];
function frames(n,buttons={},playing=false){
 host.setInput({ports:[buttons,{}]});
 for(let i=0;i<n;i++) {bridge.write(host,'nes',playing);host.stepFrames(1);const a=bridge.poll(host,'nes',playing);if(a)actions.push(a);host.state.audioRing.length=0}
}
function reset(){host.writeMemory('save_ram',0,new Uint8Array(8192));host.reset();host.stepFrames(1);bridge.reset();actions.length=0}
reset();frames(90);frames(4,{a:true});frames(10);assert.deepEqual(actions,['join']);
function tap(key){frames(4,{[key]:true});frames(12)}
function friends(){reset();frames(90);tap('down');tap('a')}
friends();tap('a');assert.deepEqual(actions,['invite']);
bridge.status=3;bridge.code='UDLRAB';frames(180);assert.equal(host.readMemory('system_ram',0x307,1)[0],3);
frames(4,{select:true});frames(5);assert.deepEqual(actions,['invite','leave']);
friends();tap('down');tap('a');assert.equal(host.readMemory('system_ram',0x309,1)[0],2);
for(const key of ['up','down','left','right','a','b'])tap(key);
assert.equal(bridge.enteredCode(host),'UDLRAB');
tap('select');assert.equal(host.readMemory('system_ram',0x30a,1)[0],5);tap('b');tap('start');
assert.deepEqual(actions,['enter']);assert.equal(bridge.enteredCode(host),'UDLRAB');
bridge.status=6;frames(90);tap('start');assert.deepEqual(actions,['enter','enter']);
assert.equal(bridge.enteredCode(host),'UDLRAB');
for(let i=0;i<7;i++)tap('select');assert.equal(host.readMemory('system_ram',0x309,1)[0],1);
assert.deepEqual([...host.readMemory('system_ram',0x3fe,2)],[0,0]);
reset();frames(90,{},true);assert.equal(host.readMemory('system_ram',0x307,1)[0],4);
frames(4,{select:true},true);frames(10,{},true);assert.deepEqual(actions,['leave']);
assert.deepEqual([...host.readMemory('system_ram',0x3fe,2)],[0,0]);
// Real hardware / headless consumers without a bridge still enter offline practice.
reset();host.setInput({ports:[{},{}]});host.stepFrames(90);assert.equal(host.readMemory('system_ram',0x307,1)[0],0);
host.setInput({ports:[{start:true},{}]});host.stepFrames(5);host.setInput({ports:[{right:true},{}]});host.stepFrames(100);
assert.ok(host.readMemory('system_ram',0x300,1)[0]>40);
assert.deepEqual([...host.readMemory('system_ram',0x3fe,2)],[0,0]);
console.log('PASS cartridge Online play / Play with friends / Create room / Enter code, six symbols, delete, retry, waiting status, leave in lobby and match, and offline practice with zero engine overruns/drops');
