// Independent real-core check for a released NES cartridge's network menu.
// node scripts/network-menu-smoke.mjs https://dev.chiptoy.com <game UUID>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LibretroHost } from 'romdev-core-host';
import { NetworkBridge } from '../src/network-bridge.ts';
const [origin,game,profile='duel']=process.argv.slice(2),browser=new URL('../',import.meta.url);
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
function tap(key){frames(4,{[key]:true});frames(12)}
function state(offset){return host.readMemory('system_ram',0x300+offset,1)[0]}
function friends(){reset();frames(90);tap('down');tap('a')}
reset();frames(90);frames(120,{a:true});assert.deepEqual(actions,[]);
frames(12);assert.deepEqual(actions,['join']);frames(120);assert.deepEqual(actions,['join']);
reset();frames(90);tap('down');frames(120,{a:true});assert.equal(state(9),0);
frames(12);assert.equal(state(9),1);assert.deepEqual(actions,[]);
frames(120,{a:true});assert.deepEqual(actions,[]);frames(12);assert.deepEqual(actions,['invite']);
bridge.status=3;bridge.code='UDLRUD';frames(180);assert.equal(state(7),3);
frames(120,{select:true});assert.deepEqual(actions,['invite']);frames(12);assert.deepEqual(actions,['invite','leave']);
friends();tap('down');tap('a');assert.equal(state(9),2);assert.equal(state(10),0);
tap('a');tap('b');assert.equal(state(10),0);assert.deepEqual(actions,[]);
for(const key of ['up','down','left','right','up'])tap(key);
assert.equal(state(10),5);assert.deepEqual(actions,[]);
frames(120,{down:true});assert.equal(state(10),5);assert.deepEqual(actions,[]);
frames(12);assert.equal(bridge.enteredCode(host),'UDLRUD');assert.deepEqual(actions,['enter']);
frames(120);assert.deepEqual(actions,['enter']);
bridge.status=6;frames(90);tap('select');assert.equal(state(10),5);tap('down');
assert.deepEqual(actions,['enter','enter']);assert.equal(bridge.enteredCode(host),'UDLRUD');
for(let i=0;i<7;i++)tap('select');assert.equal(state(9),1);
assert.deepEqual([...host.readMemory('system_ram',0x3fe,2)],[0,0]);
// A menu action still works while another button stays held: no all-buttons release gate.
reset();frames(90);tap('down');frames(4,{right:true,a:true});frames(90,{right:true});
assert.equal(state(9),1);assert.deepEqual(actions,[]);frames(4,{right:true,a:true});frames(90,{right:true});
assert.deepEqual(actions,['invite']);
reset();frames(90,{},true);assert.equal(state(7),4);
if(profile==='tetris') {
 frames(180,{},true);const current=state(27),next=state(46);
 frames(4,{select:true},true);frames(20,{},true);assert.equal(state(48),current);assert.equal(state(27),next);assert.equal(state(50),1);assert.deepEqual(actions,[]);
 frames(4,{select:true},true);frames(20,{},true);assert.equal(state(27),next);
 frames(4,{b:true},true);frames(20,{},true);assert.equal(state(40),3);
 frames(4,{a:true},true);frames(20,{},true);assert.equal(state(40),0);
 frames(4,{up:true},true);frames(180,{},true);assert.equal(state(50),0);assert.ok([...host.readMemory('system_ram',0x340,40)].some(x=>x));
 frames(4,{select:true},true);frames(20,{},true);assert.equal(state(27),current);assert.equal(state(50),1);assert.deepEqual(actions,[]);
} else {frames(120,{select:true},true);assert.deepEqual(actions,[]);frames(12,{},true);assert.deepEqual(actions,['leave']);}
assert.deepEqual([...host.readMemory('system_ram',0x3fe,2)],[0,0]);
// Offline menus also wait for Start release; movement remains held afterward.
reset();host.setInput({ports:[{},{}]});host.stepFrames(90);assert.equal(state(7),0);
host.setInput({ports:[{start:true},{}]});host.stepFrames(120);assert.equal(state(0),0);
host.setInput({ports:[{right:true},{}]});host.stepFrames(100);if(profile==='tetris') {assert.ok(state(25)>0&&state(25)<255);assert.ok(state(29)>5)} else assert.ok(state(0)>40);
assert.deepEqual([...host.readMemory('system_ram',0x3fe,2)],[0,0]);
if(profile==='tetris') console.log('PASS Tetris: Up hard drop, A/B opposite rotations, Select hold once per piece, swap after locking, no unintended leave');
console.log('PASS menu actions on release only, held A cannot skip friends/create, held direction survives menu actions, six directional symbols auto-submit once, A/B ignored, delete/retry, release to leave from the lobby and offline gameplay with zero engine overruns/drops');
