// Diagnostic desktop bursts, not the physical-phone presentation gate.
// Uses actual cartridge fixtures and the same bounded replay scheduler as the worker.
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BundleReplay } from '../src/bundle-replay.ts';
import { bundle, config, frame, fixture } from '../tests/bundle-helpers.mjs';
const output=process.argv[2],worst=process.argv[3]==='worst';if(!output||process.argv[3]&&!worst)throw Error('Usage: node scripts/bundle-cost.mjs <report.json> [worst]');
const warmup=20,count=200,depth=24;
const summary=values=>{const s=[...values].sort((a,b)=>a-b);return {p50:s[Math.ceil(.5*s.length)-1],p95:s[Math.ceil(.95*s.length)-1],p99:s[Math.ceil(.99*s.length)-1],max:s.at(-1)};};
const cases=[];
const drain=r=>{let max=0,total=0,n=0;for(;;){const s=r.pump(8,128);max=Math.max(max,s.workMs);total+=s.workMs;if(s.complete)return {max,total};if(++n>1000)throw Error('Unbounded replay');}};
for(const platform of ['gb','gbc','nes'])for(const [mode,slots]of platform==='nes'?[['shared',[0,1,2,3]]]:[['shared',[0]],['shared',[0,2]],['shared',[0,1,2,3]],['player-views',[0]],['player-views',[0,2]],['player-views',[0,1,2,3]]]){
 if(worst&&!(platform==='nes'||platform==='gbc'&&mode==='player-views'&&slots.length===4))continue;
 const c=config(platform,mode,slots),b=await bundle(c),r=new BundleReplay(b);
 try{
  // Initialization can span native frames. Measure ordinary gameplay afterwards.
  for(let f=0;f<90;f++){r.enqueue(frame(c,f));drain(r);r.confirm(f);}
  const initial=r.checkpoint(89),snapshotBytes=initial.states.map(s=>s.bytes.length);
  const restore=[],step=[],capture=[],whole=[],slices=[];let heapBytes=0,historyPeak=0;
  for(let round=0;round<warmup+count;round++){
   r.restoreCheckpoint(initial);
   let start=performance.now();for(let i=0;i<b.consoles.length;i++)b.restoreConsole(i,initial.states[i]);const rt=performance.now()-start;
   start=performance.now();for(let i=0;i<b.consoles.length;i++)b.capture(i);const ct=performance.now()-start;
   let st=0;
   for(let d=0;d<depth;d++){start=performance.now();r.enqueue(frame(c,90+d));drain(r);st+=performance.now()-start;}
   historyPeak=Math.max(historyPeak,r.snapshotBytes);
   const inputs=Array.from({length:depth},(_,d)=>frame(c,90+d,[d%2?1:2,d%3?16:0,d%4?1:2,d%5?2:1]));
   start=performance.now();r.correct(inputs,113);const measured=drain(r);const burst=performance.now()-start;
   heapBytes=Math.max(heapBytes,b.consoles.reduce((n,v)=>n+v.host.mod.HEAPU8.byteLength,0));
   if(round>=warmup){restore.push(rt);capture.push(ct);step.push(st/depth);whole.push(burst);slices.push(measured.max);}
  }
  cases.push({platform,mode,slots,romSha256:createHash('sha256').update(await fixture(platform)).digest('hex'),descriptor:b.descriptorHash,coreSchemas:initial.states.map(s=>s.schema),nativeFramePeriodMs:1000/b.consoles[0].host.status.coreFps,consoles:b.consoles.length,window:depth,snapshotBytesPerConsole:snapshotBytes,retainedHistoryPeakBytes:historyPeak,wasmHeapBytes:heapBytes,restoreAndDigestMs:summary(restore),captureAndDigestMs:summary(capture),forwardFrameWithCaptureMs:summary(step),synchronousFullCorrectionMs:summary(whole),maximumReplaySliceMs:summary(slices)});
 }finally{r.dispose();}
}
const manifest=JSON.parse(readFileSync(new URL('../dist/manifest.json',import.meta.url),'utf8'));
writeFileSync(output,JSON.stringify({kind:'desktop-diagnostic-not-phone-gate',node:process.version,platform:process.platform,arch:process.arch,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),bundleBuild:manifest.bundleBuild,wasmSource:manifest.wasmSource,warmup,bursts:count,depth,selection:worst?'GBC four views and NES four native players':'full matrix',includes:'actual restore, native replay, retained snapshots, core-owned digests and scheduler bookkeeping; excludes browser presentation/IPC/network and thermal effects',cases},null,2)+'\n');
console.log(output);
