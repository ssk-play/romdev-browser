// Standalone GPL core verification: app communicates over its own protocol only.
// node scripts/tetris-core-smoke.mjs <app/src/runtime/rollback.ts> <dev origin> <game UUID>
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LibretroHost } from 'romdev-core-host';
import { NetworkBridge } from '../src/network-bridge.ts';
import { RollbackCore } from '../src/rollback.ts';
import { playerBot } from './tetris-bot.mjs';
const [clientModule,origin,game]=process.argv.slice(2);
assert.ok(['dev.chiptoy.com','127.0.0.1','localhost'].includes(new URL(origin).hostname));
assert.match(game,/^[0-9a-f-]{36}$/);
const { RollbackTimeline }=await import(pathToFileURL(resolve(clientModule)));
const response=await fetch(`${origin}/api/play/${game}/rom`);assert.equal(response.status,200);
const rom=new Uint8Array(await response.arrayBuffer());
const factory=(await import(new URL('../dist/wasm/fceumm.mjs',import.meta.url))).default;
const wasm=readFileSync(new URL('../dist/wasm/fceumm.wasm',import.meta.url));
async function boot(){
 const host=new LibretroHost();await host.loadCore({factory,wasmBinary:wasm,io:false});await host.loadMedia({platform:'nes',bytes:rom,name:'tetris.nes'});
 host.writeMemory('save_ram',0,new Uint8Array(8192));host.reset();host.stepFrames(1);host.state.audioRing.length=0;return host;
}
const names=['right','left','up','down','a','b','select','start'];
function adapter(host){const bridge=new NetworkBridge();return {
 save:()=>host.serializeState(),restore:s=>host.unserializeState(s),
 frame:m=>{host.setInput({ports:m.map(mask=>Object.fromEntries(names.map((n,i)=>[n,!!(mask&(1<<i))])))});bridge.write(host,'nes',true);host.stepFrames(1)},
 hash:()=>{let hash=2166136261;for(const r of ['system_ram','save_ram'])for(const b of host.readMemory(r,0,host.regionSize(r)))hash=Math.imul(hash^b,16777619);return hash>>>0},
 discardAudio:()=>{host.state.audioRing.length=0}};}
const hosts=await Promise.all([boot(),boot(),boot()]),cores=hosts.map(adapter);
const peers=cores.slice(0,2).map((core,slot)=>{const rb=new RollbackCore(core);return new RollbackTimeline(slot,{step:async(...a)=>rb.step(...a),replay:async(...a)=>rb.replay(...a)});});
const bots=[playerBot(0),playerBot(1)],inputs=[],checks=[[],[]];
let delivered=-1, maxPrediction=0, maxLines=[0,0],maxSent=[0,0],maxPending=[0,0];
const total=6000,started=performance.now();
for(let frame=0;frame<total;frame++){
 const st=hosts[2].readMemory('system_ram',0x300,256);inputs.push(frame<170?[0,0]:bots.map(b=>b(st)));
 cores[2].frame(inputs[frame]);cores[2].discardAudio();
 for(let slot=0;slot<2;slot++){await peers[slot].advance(inputs[frame][slot]);maxPrediction=Math.max(maxPrediction,peers[slot].prediction);}
 if(frame%3===0||frame===total-1){const until=frame===total-1?frame:frame-12;while(delivered<until){delivered++;for(const peer of peers)peer.receive(delivered,inputs[delivered]);}for(let slot=0;slot<2;slot++){await peers[slot].reconcile();checks[slot].push(...peers[slot].checks());}}
 if(frame>170)for(let p=0;p<2;p++){const now=hosts[2].readMemory('system_ram',0x300,256);maxLines[p]=Math.max(maxLines[p],now[32+2*p]|now[33+2*p]<<8);maxSent[p]=Math.max(maxSent[p],now[36+2*p]|now[37+2*p]<<8);maxPending[p]=Math.max(maxPending[p],now[23+p]);}
}
assert.deepEqual(checks[0],checks[1]);assert.equal(checks[0].length,total/60);
for(let slot=0;slot<2;slot++){assert.equal(cores[slot].hash(),cores[2].hash());assert.deepEqual(Uint8Array.from(hosts[slot].screenshotRgba().rgba),Uint8Array.from(hosts[2].screenshotRgba().rgba));}
for(const host of hosts)assert.deepEqual([...host.readMemory('system_ram',0x3fe,2)],[0,0]);
assert.ok(maxLines.every(n=>n>20),'both native controller ports must clear lines');assert.ok(maxSent.some(n=>n>0)&&maxPending.some(n=>n>0),'exercise garbage attacks');
writeFileSync('/tmp/chiptoy-tetris-duel.rgba',hosts[2].screenshotRgba().rgba);
// Force top-out through ordinary buttons, then rematch using a release edge.
let winner=0;
for(let frame=0;frame<3000;frame++){
 cores[2].frame([frame%8===0?4:0,frame%8===0?4:0]);cores[2].discardAudio();
 winner=hosts[2].readMemory('system_ram',0x314,1)[0];if(winner)break;
}
assert.ok(winner>=1&&winner<=3,'top-out ends the round');
cores[2].frame([128,0]);for(let n=0;n<120;n++)cores[2].frame([128,0]);assert.equal(hosts[2].readMemory('system_ram',0x314,1)[0],winner,'holding Start does not rematch');
cores[2].frame([0,0]);for(let n=0;n<180;n++)cores[2].frame([0,0]);cores[2].discardAudio();
const fresh=hosts[2].readMemory('system_ram',0x300,256);assert.equal(fresh[20],0);assert.equal(fresh[25],1);assert.equal(fresh[26],1);assert.ok(fresh.slice(64,144).every(x=>x===0));assert.deepEqual([...fresh.slice(254,256)],[0,0]);
// Empty hold at the seven-bag boundary must not trigger a synchronous shuffle spike.
for(let frame=0;frame<1800;frame++) {
 const s=hosts[2].readMemory('system_ram',0x300,256);
 if(s[25]===6&&s[44]===0)break;
 cores[2].frame([frame%16===0?4:0,0]);cores[2].discardAudio();
}
const boundary=hosts[2].readMemory('system_ram',0x300,256);assert.equal(boundary[25],6);assert.equal(boundary[48],255);
for(let frame=0;frame<4;frame++)cores[2].frame([64,0]);
for(let frame=0;frame<180;frame++)cores[2].frame([0,0]);cores[2].discardAudio();
const held=hosts[2].readMemory('system_ram',0x300,256);assert.equal(held[48],boundary[27]);assert.equal(held[27],boundary[46]);assert.equal(held[50],1);assert.deepEqual([...held.slice(254,256)],[0,0]);
console.log(JSON.stringify({frames:total,simulationMs:Math.round(performance.now()-started),checkpoints:checks[0].length,rollbacks:peers.map(p=>p.rollbacks),maxPrediction,maxLines,maxSent,maxPending,winner,rematch:true,holdAtBagBoundary:true,health:[0,0],romBytes:rom.length}));
