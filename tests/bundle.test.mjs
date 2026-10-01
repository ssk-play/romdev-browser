import test from 'node:test';
import assert from 'node:assert/strict';
import { BundleReplay } from '../src/bundle-replay.ts';
import { encodeCheckpoint,decodeCheckpoint } from '../src/bundle-checkpoint.ts';
import { discoverContext,writeContext } from '../src/multiplayer-abi.ts';
import { bundle,config,frame } from './bundle-helpers.mjs';

const drain=r=>{let guard=0;while(!r.pump(8,1).complete)assert.ok(++guard<1000);};
for(const platform of ['gb','gbc','nes'])for(const mode of platform==='nes'?['shared']:['shared','player-views'])for(const slots of [[0],[0,2],[0,1,2],[0,1,2,3]])test(`${platform} ${mode} ${slots.length}: bootstrap, delayed/coalesced correction, whole-bundle checkpoint`,async t=>{
 const c=config(platform,mode,slots),a=await bundle(c),b=await bundle(c);t.after(()=>a.dispose());t.after(()=>b.dispose());
 assert.equal(a.consoles.length,mode==='shared'?1:slots.length);
 for(const v of a.consoles){const h=v.host;assert.equal(h.readMemory('system_ram',platform==='nes'?0x312:0x10,1)[0],0);assert.equal(h.readMemory(v.context.region,v.context.offset+3,1)[0],mode==='shared'?255:v.slot);}
 const expected=new BundleReplay(a),actual=new BundleReplay(b);
 for(let f=0;f<24;f++){const m=[f%2?2:1,f%3?16:0,f%4?1:2,f%5?2:1];expected.enqueue(frame(c,f,m));drain(expected);actual.enqueue(frame(c,f));drain(actual);}
 const corrected=Array.from({length:24},(_,f)=>frame(c,f,[f%2?2:1,f%3?16:0,f%4?1:2,f%5?2:1]));
 const shown=actual.display();actual.drainAudio();actual.correct(corrected.slice(12),-1);actual.pump(8,1);actual.correct(corrected.slice(0,12),23);
 // Partly restored/replayed consoles cannot leak into a displayed or checkpointed bundle.
 assert.deepEqual(actual.display(),shown);assert.throws(()=>actual.checkpoint(23),/corrected/);drain(actual);assert.deepEqual(actual.drainAudio(),[]);
 expected.confirm(23);const ca=expected.checkpoint(23),cb=actual.checkpoint(23);assert.deepEqual(cb,ca);
 for(const v of b.consoles){if(platform!=='nes'){assert.equal(v.host.readMemory('system_ram',0x10,1)[0],0xa5);assert.deepEqual(v.host.readMemory('system_ram',0,9),b.consoles[0].host.readMemory('system_ram',0,9));}}
 const p={eventSeq:3,chainHash:'0123456789abcdef'},packed=await encodeCheckpoint(b.descriptorHash,cb,p);
 const parsed=await decodeCheckpoint(packed.payload,{descriptor:b.descriptorHash,payloadHash:packed.payloadHash,bundleDigest:packed.bundleDigest,consoles:b.consoles.length,...p});assert.deepEqual(parsed,cb);
 actual.restoreCheckpoint(parsed);
 for(let f=24;f<40;f++){const input=frame(c,f,[1,2,16,128]);expected.enqueue(input);drain(expected);expected.confirm(f);actual.enqueue(input);drain(actual);actual.confirm(f);}
 assert.deepEqual(actual.checkpoint(39),expected.checkpoint(39));
 if(mode==='player-views'&&slots.length>1){const before=b.boundary(40);actual.selectView(slots[1]);assert.deepEqual(b.boundary(40),before);assert.ok(actual.display().rgba.some((v,i)=>v!==expected.display().rgba[i]));}
 if(platform==='nes'){for(let i=0;i<4;i++){const mirror=b.consoles[0].host.readMemory('system_ram',0x410+i,1)[0];assert.equal(mirror,c.slots.includes(i)?[1,2,16,128][i]:0);}}
 assert.ok(actual.snapshotBytes<=25*cb.states.reduce((n,s)=>n+s.bytes.length,0));
 const damaged=packed.payload.slice();damaged[damaged.length-1]^=1;await assert.rejects(decodeCheckpoint(damaged,{descriptor:b.descriptorHash,payloadHash:packed.payloadHash,bundleDigest:packed.bundleDigest,consoles:b.consoles.length,...p}),/payload hash/);
 await assert.rejects(decodeCheckpoint(packed.payload,{descriptor:'0'.repeat(64),payloadHash:packed.payloadHash,bundleDigest:packed.bundleDigest,consoles:b.consoles.length,...p}),/descriptor/);
});
test('ABI validates the complete context interval and never overwrites NES native pad mirrors',()=>{
 let ram=new Uint8Array(0x8000);const h={readMemory:(_r,o,n)=>ram.slice(o,o+n),writeMemory:(_r,o,b)=>ram.set(b,o)};
 for(const [platform,at,address]of [['gb',0x10f0,0xcff0],['gbc',0x10f0,0xd000],['nes',0x3f0,0x3e0],['nes',0x3f0,0x6000]]){ram.set([77,80,1,8,address&255,address>>8,32,1],at);assert.throws(()=>discoverContext(h,platform),/context/);}
 ram.set([77,80,1,8,0,4,32,1],0x3f0);ram.set([9,8,7,6],0x410);writeContext(h,discoverContext(h,'nes'),config('nes'),255,frame(config('nes'),0,[1,2,4,8]));assert.deepEqual(Array.from(ram.slice(0x410,0x414)),[9,8,7,6]);
});
test('sliced/coalesced replay reports completion CPU separately from elapsed wait and resets for the next correction',async t=>{
 const c=config('nes','shared',[0]),b=await bundle(c);t.after(()=>b.dispose());let clock=0;
 const run=b.runConsole.bind(b),restore=b.restoreConsole.bind(b);
 b.runConsole=(...args)=>{const out=run(...args);clock+=2;return out;};
 b.restoreConsole=(...args)=>{restore(...args);clock+=3;};
 const r=new BundleReplay(b,()=>clock);
 for(let f=0;f<4;f++){r.enqueue(frame(c,f));drain(r);}
 r.correct([frame(c,0,[1,0,0,0])],-1);
 let slice=r.pump(8,1);assert.equal(slice.completedCorrection,null);assert.equal(slice.workMs,3);
 slice=r.pump(8,1);assert.equal(slice.completedCorrection,null);assert.equal(slice.workMs,2);
 clock+=20; // Scheduling/background work belongs to elapsed latency, not replay CPU.
 r.correct([frame(c,2,[2,0,0,0])],3);
 let guard=0;do{slice=r.pump(8,1);assert.ok(++guard<20);}while(!slice.complete);
 assert.deepEqual(slice.completedCorrection,{workMs:11,ageMs:31});assert.equal(slice.correctionAgeMs,0);
 assert.equal(r.pump(8,1).completedCorrection,null); // Report completion once.
 r.enqueue(frame(c,4));drain(r);r.correct([frame(c,4,[1,0,0,0])],4);
 do{slice=r.pump(8,1);}while(!slice.complete);
 assert.deepEqual(slice.completedCorrection,{workMs:5,ageMs:5});
 assert.deepEqual(r.drainAudio(),[]);
});
test('failed multi-console restore rolls back every console and keeps the presented bundle intact',async t=>{
 const c=config('gbc','player-views',[0,2]),b=await bundle(c);t.after(()=>b.dispose());const r=new BundleReplay(b);
 const boot=r.checkpoint(-1);
 for(let f=0;f<8;f++){r.enqueue(frame(c,f,[1,0,2,0]));drain(r);r.confirm(f);}
 const current=b.boundary(8),shown=r.display();
 const damaged={...boot,states:boot.states.map(s=>({...s,bytes:s.bytes.slice(),digest:s.digest.slice()}))};damaged.states[1].digest[0]^=1;
 assert.throws(()=>r.restoreCheckpoint(damaged),/digest/);
 assert.deepEqual(b.boundary(8),current);assert.deepEqual(r.display(),shown);assert.equal(r.nextFrame,8);
 const packed=await encodeCheckpoint(b.descriptorHash,boot,{eventSeq:-1,chainHash:'0'.repeat(16)});
 await assert.rejects(decodeCheckpoint(packed.payload,{descriptor:b.descriptorHash,payloadHash:packed.payloadHash,bundleDigest:packed.bundleDigest,consoles:2,eventSeq:0,chainHash:'0'.repeat(16)}),/stream position/);
 r.enqueue(frame(c,8,[2,0,1,0]));drain(r);r.confirm(8);assert.equal(r.nextFrame,9);
});
test('a restore whose undo fails retires every core and cannot certify or advance cached state',async t=>{
 const c=config('gbc','player-views',[0,2]),b=await bundle(c);t.after(()=>b.dispose());const r=new BundleReplay(b),boot=r.checkpoint(-1);
 for(let f=0;f<4;f++){r.enqueue(frame(c,f));drain(r);r.confirm(f);}
 const bad={...boot,states:boot.states.map(s=>({...s,digest:s.digest.slice()}))};bad.states[1].digest[0]^=1;
 let calls=0;const restore=b.restoreConsole.bind(b);b.restoreConsole=(...args)=>{if(++calls===3)throw Error('injected undo failure');return restore(...args);};
 assert.throws(()=>r.restoreCheckpoint(bad),/retired/);assert.equal(b.retired,true);
 assert.throws(()=>r.checkpoint(3),/retired/);assert.throws(()=>r.enqueue(frame(c,4)),/retired/);
 assert.throws(()=>r.selectView(2),/retired/);assert.ok(b.consoles.every(v=>v.host.mod===null));
});
