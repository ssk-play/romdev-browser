import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldObserver, WorldMismatch } from '../src/world-observation.ts';
import { runBundle } from '../src/bundle-headless.ts';
import { gbMultiplayer } from './fixtures/multiplayer/gb.mjs';
import { readFileSync } from 'node:fs';
import { LibretroHost } from 'romdev-core-host';
import { nodeLoader } from './helpers.mjs';
import { config, bundle, frame, fixture } from './bundle-helpers.mjs';

const request=p=>({trigger:p==='nes'?0x604:0xc009,tick:{region:'system_ram',offset:p==='nes'?0x600:4,length:4},fields:[{name:'positions',region:'system_ram',offset:p==='nes'?0x308:0,length:4},...(p==='nes'?[]:[{name:'score',region:'system_ram',offset:8,length:1}])]});
for(const p of ['gb','gbc','nes'])for(const slots of p==='nes'?[[0,1,2,3]]:[[0],[0,2],[0,1,2,3]])test(`${p}/${slots.length}: world check compares completed pre-view ticks`,async t=>{
 const c=config(p,p==='nes'?'shared':'player-views',slots),b=await bundle(c);t.after(()=>b.dispose());
 const w=new WorldObserver(b,request(p));
 for(let f=0;f<35;f++){for(let i=0;i<b.consoles.length;i++)b.runConsole(i,frame(c,f,[1,0,2,0]));w.collect(b,f+1);}
 const result=w.result();assert.ok(result.checkedTicks>25);assert.ok(result.checkedThroughTick>=result.checkedTicks);assert.ok(result.unmatchedTicks.length<=8);
 if(p!=='nes'&&slots.length>1)assert.ok(b.pixels()[0].rgba.some((v,i)=>v!==b.pixels()[1].rgba[i]),'views differ without a world mismatch');
 w.dispose(b);for(const v of b.consoles)assert.throws(()=>v.host.drainWorldObservation(),/no world/);
});
for(const p of ['gb','gbc'])test(`${p}: slot-dependent simulation fails with exact tick, slots and field`,async t=>{
 const c=config(p,'player-views',[0,2]),b=await bundle(c,'test-m1-7b412f74',gbMultiplayer(p==='gbc',true));t.after(()=>b.dispose());
 const w=new WorldObserver(b,request(p));let error;
 for(let f=0;f<20&&!error;f++){for(let i=0;i<b.consoles.length;i++)b.runConsole(i,frame(c,f));try{w.collect(b,f+1);}catch(e){error=e;}}
 assert.ok(error instanceof WorldMismatch);assert.equal(error.difference.tick,1);assert.deepEqual(error.difference.consoles,[0,2]);assert.equal(error.difference.field,'score');assert.equal(error.difference.offset,8);assert.equal(error.difference.expected,'00');assert.equal(error.difference.actual,'02');
});
for(const p of ['gb','gbc','nes'])test(`${p}: headless world diagnostics preserve the exact offline causal digest and screenshots`,async()=>{
 const c=config(p,p==='nes'?'shared':'player-views',[0,1,2,3]),core=p==='nes'?'fceumm':'gambatte',factory=await nodeLoader().factory(core),wasmBinary=new Uint8Array(readFileSync(new URL(`../dist/wasm/${core}.wasm`,import.meta.url)));
 const host=async()=>{const h=new LibretroHost();await h.loadCore({factory,wasmBinary,io:false});return h;};
 const req={config:c,rom:Buffer.from(await fixture(p)).toString('base64'),frames:35,input:Array.from({length:35},(_,f)=>frame(c,f,[1,0,2,0])),shots:[35],memory:[{region:'system_ram',offset:0,length:8}]},png=rgba=>Buffer.from(rgba).toString('base64');
 const normal=await runBundle(req,'world-regression',host,png),observed=await runBundle({...req,world:request(p)},'world-regression',host,png);
 assert.equal(normal.world,null);assert.ok(observed.world.checkedTicks>25);assert.equal(observed.digest,normal.digest);assert.deepEqual(observed.rows,normal.rows);assert.deepEqual(observed.shots,normal.shots);assert.equal(observed.snapshotBytes,normal.snapshotBytes);
 if(p!=='nes')await assert.rejects(()=>runBundle({...req,rom:Buffer.from(gbMultiplayer(p==='gbc',true)).toString('base64'),world:request(p)},'world-regression',host,png),WorldMismatch);
});
test('logical checker rejects missing/repeated ticks and truncated native buffers; bounded trailing skew is explicit',()=>{
 const hosts=[0,2].map(slot=>({slot,context:{region:'system_ram',offset:0x400},host:{startWorldObservation(){},stopWorldObservation(){}}})),b={consoles:hosts,config:{platform:'gbc'}},r=request('gbc');
 const e=tick=>({tick,pc:0x1234,bytes:new Uint8Array(5)}),report=events=>({events,total:events.length,truncated:false});
 const w=new WorldObserver(b,r);w.ingest(0,report([e(1),e(2)]),1);w.ingest(2,report([e(1)]),1);assert.deepEqual(w.result().unmatchedTicks,[2]);assert.equal(w.result().checkedThroughTick,1);
 assert.throws(()=>w.ingest(2,report([e(1)]),2),/missing\/repeated/);assert.throws(()=>w.ingest(2,{...report([e(2)]),truncated:true},2),/overflow/);
 const gaps=new WorldObserver(b,r);assert.throws(()=>gaps.ingest(0,report([e(2)]),1),/missing\/repeated/);
 const skew=new WorldObserver(b,r);skew.ingest(0,report(Array.from({length:8},(_,i)=>e(i+1))),1);assert.throws(()=>skew.ingest(0,report([e(9)]),2),/skew/);
 const none=new WorldObserver(b,r);assert.throws(()=>none.result(),/did not publish/);
 assert.throws(()=>new WorldObserver(b,{...r,fields:[{name:'bad',region:'system_ram',offset:0x400,length:1}]}),/engine context/);
});
