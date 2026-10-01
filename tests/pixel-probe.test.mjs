import test from 'node:test';
import assert from 'node:assert/strict';
import {pixelProbe}from'../src/pixel-probe.ts';
import {bundle,config,frame}from'./bundle-helpers.mjs';
import {BundleReplay}from'../src/bundle-replay.ts';
const drain=r=>{let out;do{out=r.pump(8,1);}while(!out.complete);};
for(const p of ['gb','gbc','nes'])test(`${p}: rendered P1 probe sees its input and ignores other actors`,async t=>{
 const c=config(p,'shared',[0,1,2,3]),b=await bundle(c);t.after(()=>b.dispose());const r=new BundleReplay(b);
 const region=p==='nes'?{x:0,y:32,width:256,height:16}:{x:0,y:20,width:160,height:8};
 for(let f=0;f<8;f++){r.enqueue(frame(c,f));drain(r);r.confirm(f);}
 const before=pixelProbe(r.display(),region);
 for(let f=8;f<12;f++){r.enqueue(frame(c,f,[0,1,1,1]));drain(r);r.confirm(f);}
 assert.equal(pixelProbe(r.display(),region),before);
 for(let f=12;f<16;f++){r.enqueue(frame(c,f,[f===12?1:0,0,0,0]));drain(r);r.confirm(f);}
 assert.notEqual(pixelProbe(r.display(),region),before);
 assert.throws(()=>pixelProbe(r.display(),{...region,x:-1}),/invalid/);
 assert.throws(()=>pixelProbe(r.display(),{...region,width:4097}),/invalid/);
});
