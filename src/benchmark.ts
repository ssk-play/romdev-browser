/// <reference lib="dom" />
import { distribution } from "./benchmark-metrics.ts";
import type { BundleEvent, BundleRequest } from "./bundle-protocol.ts";
import type { BundleConfig, FrameInput, SliceResult } from "./multiplayer.ts";

const status = document.querySelector<HTMLParagraphElement>("#status")!;
const results = document.querySelector<HTMLPreElement>("#results")!;
const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
const pad = document.querySelector<HTMLButtonElement>("#pad")!;
const query = new URLSearchParams(location.search), smoke = query.get("profile") === "smoke";
const channel = crypto.randomUUID();
let hidden = 0, cancelled = false, nextId = 0, pressed = false;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
const worker = new Worker(new URL("./bundle.worker.js", import.meta.url), { type: "module" });
worker.onmessage = (e: MessageEvent<BundleEvent>) => {
  if (e.data.type !== "reply") return;
  const p = pending.get(e.data.id); if (!p) return;
  clearTimeout(p.timer); pending.delete(e.data.id);
  if (e.data.ok) p.resolve(e.data.value); else p.reject(new Error(e.data.error));
};
worker.onerror = () => stop(new Error("Benchmark worker failed"));
function stop(error: Error) { cancelled = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); worker.terminate(); }
function rpc<T = any>(req: Omit<BundleRequest, "id">, transfer: Transferable[] = []): Promise<T> {
  if (cancelled) return Promise.reject(new Error("Benchmark stopped"));
  return new Promise((resolve, reject) => {
    const id = ++nextId, timer = window.setTimeout(() => { pending.delete(id); reject(new Error("Worker request timed out")); stop(new Error("Benchmark stopped after timeout")); }, 60_000);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ ...req, id }, transfer);
  });
}
const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function pacer(fps: number) {
  const period=1000/fps;let due=performance.now();
  return async()=>{do{await paint();}while(performance.now()<due);due+=period;if(performance.now()-due>period)due=performance.now();};
}
document.addEventListener("visibilitychange", () => { if (document.hidden) hidden++; });
window.addEventListener("pagehide", () => stop(new Error("Benchmark page closed")));
pad.addEventListener("pointerdown", (e) => { pressed = true; pad.setPointerCapture(e.pointerId); });
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) pad.addEventListener(type, () => { pressed = false; });
const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer))].map(v => v.toString(16).padStart(2,"0")).join("");
const vector = (c: BundleConfig, frame: number, real = false): FrameInput => ({ frame,
  masks: [0,1,2,3].map(s => c.slots.includes(s) && real ? (frame % (s + 2) ? 1 : 2) : 0),
  states: [0,1,2,3].map(s => c.slots.includes(s) ? 1 : 0) });
const position = { eventSeq: 0, chainHash: "0000000000000000" };
type Checkpoint = { payload: Uint8Array; payloadHash: string; bundleDigest: string };
type MeasuredSlice = SliceResult & {wasmHeapBytes:number;pixelHash:string|null};
const checkpoint = (afterFrame: number) => rpc<Checkpoint>({ type: "checkpoint", afterFrame, position } as Omit<BundleRequest,"id">);
const restore = (c: Checkpoint) => rpc({ type: "restore", ...c, position } as Omit<BundleRequest,"id">);
const cases: unknown[] = [];
let lastReport:Record<string,unknown>|null=null;
function publish(report:Record<string,unknown>){lastReport=report;if(parent!==window)parent.postMessage({type:"chiptoy:benchmark-result",channel,report},location.origin);}
const jsHeap=():number|null=>{const n=(performance as Performance & {memory?:{usedJSHeapSize:number}}).memory?.usedJSHeapSize;return typeof n==="number"&&Number.isFinite(n)?n:null;};
async function run() {
  if (!canvas.transferControlToOffscreen) throw new Error("OffscreenCanvas is unavailable in this browser");
  const screen = canvas.transferControlToOffscreen(); await rpc({ type: "init", canvas: screen } as Omit<BundleRequest,"id">, [screen]);
  const fixtures = await fetch(new URL("./benchmark/fixtures.json", import.meta.url)).then(r => { if (!r.ok) throw new Error("Fixture manifest unavailable"); return r.json(); });
  const started = new Date().toISOString(), start = performance.now();
  lastReport={schema:1,started,profile:smoke?"smoke":"full",complete:false,source:fixtures,device:{userAgent:navigator.userAgent,platform:navigator.platform,label:query.get("device")??"unlabelled"},hidden,cases:[]};
  for (const platform of ["gb","gbc","nes"] as const) for (const mode of platform === "nes" ? ["shared"] as const : ["shared","player-views"] as const) for (const count of [1,2,4]) {
    const slots = count === 2 ? [0,2] : Array.from({ length: count }, (_,i) => i);
    const config: BundleConfig = { platform,mode,slots,capacity:4,epoch:7,seed:12,policy:"replace",window:24,rtcEpochSeconds:0 };
    status.textContent = `${platform.toUpperCase()} · ${mode} · ${count} players`;
    const romBytes: ArrayBuffer = await fetch(new URL(`./benchmark/${fixtures.roms[platform].file}`, import.meta.url)).then(r => { if (!r.ok) throw new Error("ROM unavailable"); return r.arrayBuffer(); });
    const rom = new Uint8Array(romBytes);
    if (await sha(rom) !== fixtures.roms[platform].sha256) throw new Error("ROM hash mismatch");
    const loaded = await rpc({ type: "load", rom, config } as Omit<BundleRequest,"id">);
    if (loaded.build !== fixtures.build) throw new Error("Fixture/worker build mismatch");
    // Only P1 occupies this sprite row. Other bots cannot produce a false input response.
    await rpc({type:"probe",region:platform==="nes"?{x:0,y:32,width:256,height:16}:{x:0,y:20,width:160,height:8}} as Omit<BundleRequest,"id">);
    const initial = await checkpoint(-1), canonical = Array.from({ length:24 }, (_,f) => vector(config,f,true));
    const inputSendAge: number[] = [], drawAckAge: number[] = [], offlineVisible: number[] = [], correctedVisible: number[] = [];
    let previousHash:string|null=null, previousMask=0, onset:{at:number;hash:string|null}|null=null, manualOnsets=0;
    pad.disabled = false; status.textContent += " · offline input baseline";const offlinePace=pacer(loaded.fps);
    for (let f=0;f<(smoke?12:120);f++) {
      await offlinePace(); const captured = performance.now(), input = vector(config,f,true);
      const mask=pressed || f>=4&&f%4===0 ? 1 : 0;
      input.masks = [mask, ...input.masks.slice(1)];
      if(mask&&!previousMask&&f>=4){onset={at:captured,hash:previousHash};if(pressed)manualOnsets++;}previousMask=mask;
      inputSendAge.push(performance.now()-captured);
      let out = await rpc<MeasuredSlice>({type:"frame",input} as Omit<BundleRequest,"id">);
      while (!out.complete) { await paint(); out=await rpc({type:"pump"}); }
      drawAckAge.push(performance.now()-captured);
      if(onset&&out.pixelHash!==onset.hash){await paint();offlineVisible.push(performance.now()-onset.at);onset=null;}
      previousHash=out.pixelHash;
      await rpc({type:"confirm",frame:f} as Omit<BundleRequest,"id">);
    }
    pad.disabled = true; await restore(initial);
    for (const input of canonical) { let r = await rpc<SliceResult>({ type: "frame", input } as Omit<BundleRequest,"id">); while (!r.complete) r = await rpc({ type:"pump" }); }
    await rpc({ type:"confirm", frame:23 } as Omit<BundleRequest,"id">); const expected = await checkpoint(23);
    const beforeOnset=await rpc({type:"probe",region:platform==="nes"?{x:0,y:32,width:256,height:16}:{x:0,y:20,width:160,height:8}} as Omit<BundleRequest,"id">);
    const onsetInput=(f:number)=>({...vector(config,f),masks:[f===24?1:0,0,0,0]});
    let expectedPixels:string|null=null;
    for(let f=24;f<28;f++){
      let out=await rpc<MeasuredSlice>({type:"frame",input:onsetInput(f)} as Omit<BundleRequest,"id">);
      while(!out.complete)out=await rpc({type:"pump"});expectedPixels=out.pixelHash;
    }
    if(!expectedPixels||expectedPixels===beforeOnset)throw new Error("Fixture input did not change the isolated P1 pixel region");
    const total: number[] = [], cpu: number[] = [], slices: number[] = [], fresh: number[] = [], held: number[] = [], steps: number[] = [], captures: number[] = [], restores: number[] = [];
    let lastFresh = 0, snapshotPeak = loaded.snapshotBytes, heapPeak=loaded.wasmHeapBytes, jsHeapPeak=jsHeap(), bursts = 0, coalescedBursts=0, deterministic = true;
    const caseStart = performance.now(), thermal = !smoke && count === 4 && (platform === "gbc" && mode === "player-views" || platform === "nes");
    const minBursts = smoke ? 2 : 20, duration = thermal ? 600_000 : 0;
    while (bursts < minBursts || performance.now() - caseStart < duration) {
      await restore(initial); lastFresh=0;const nativePace=pacer(loaded.fps);
      for (let f=0; f<24; f++) {
        await nativePace(); let r = await rpc<SliceResult>({ type:"frame",input:vector(config,f) } as Omit<BundleRequest,"id">);
        while (!r.complete) { await paint(); r = await rpc({ type:"pump" }); }
        const now = performance.now(); if (lastFresh) fresh.push(now-lastFresh); lastFresh=now; snapshotPeak=Math.max(snapshotPeak,r.snapshotBytes);
      }
      const correctionAt = performance.now();
      if(bursts%2){
        await rpc({type:"correct",inputs:canonical.slice(12),confirmed:-1} as Omit<BundleRequest,"id">);
        const partial=await rpc<MeasuredSlice>({type:"pump",maxOperations:1} as Omit<BundleRequest,"id">);
        if(bursts >= (smoke ? 0 : 2)){slices.push(partial.workMs);steps.push(partial.nativeStepMs);captures.push(partial.captureMs);restores.push(partial.restoreMs);}
        await rpc({type:"correct",inputs:canonical.slice(0,12),confirmed:23} as Omit<BundleRequest,"id">);coalescedBursts++;
      }else await rpc({ type:"correct", inputs:canonical,confirmed:23 } as Omit<BundleRequest,"id">);
      const captured=performance.now();let visible=false,completion:SliceResult["completedCorrection"]=null,completeAt=0;
      // Capture and queue a new local input while replay is unfinished; the backlog remains bounded.
      let r=await rpc<MeasuredSlice>({type:"frame",input:onsetInput(24)} as Omit<BundleRequest,"id">);
      while(true){
        if(r.completedCorrection){completion=r.completedCorrection;completeAt=performance.now();}
        if(bursts >= (smoke ? 0 : 2)){slices.push(r.workMs);steps.push(r.nativeStepMs);captures.push(r.captureMs);restores.push(r.restoreMs);}
        snapshotPeak=Math.max(snapshotPeak,r.snapshotBytes);heapPeak=Math.max(heapPeak,r.wasmHeapBytes);
        const heap=jsHeap();if(heap!==null)jsHeapPeak=Math.max(jsHeapPeak??0,heap);
        if(r.pixelHash===expectedPixels&&!visible){await paint();if(bursts >= (smoke ? 0 : 2))correctedVisible.push(performance.now()-captured);visible=true;}
        if(r.complete)break;await paint();r=await rpc({type:"pump"});
      }
      if (!completion) throw new Error("Correction completion metrics missing");
      held.push(completeAt-correctionAt);
      if (bursts >= (smoke ? 0 : 2)) { cpu.push(completion.workMs); total.push(completeAt-correctionAt); }
      deterministic &&= (await checkpoint(23)).bundleDigest === expected.bundleDigest;
      if (!deterministic) throw new Error("Corrected deterministic state differs from uninterrupted execution");
      const responsePace=pacer(loaded.fps);
      for(let f=25;f<28;f++){
        await responsePace();r=await rpc({type:"frame",input:onsetInput(f)} as Omit<BundleRequest,"id">);
        while(!r.complete){await paint();r=await rpc({type:"pump"});}
        if(r.pixelHash===expectedPixels&&!visible){await paint();if(bursts >= (smoke ? 0 : 2))correctedVisible.push(performance.now()-captured);visible=true;}
      }
      if(!visible)throw new Error("Corrected input never produced the expected P1 pixels");
      bursts++;
      status.textContent = `${platform.toUpperCase()} · ${mode} · ${count} players · ${bursts} corrections${thermal ? " · 10-minute sustained run" : ""}`;
    }
    const report = { platform,mode,slots,window:24,depth:24,durationMs:performance.now()-caseStart,bursts,coalescedBursts,deterministic,
      nativeFps:loaded.fps,romHash:fixtures.roms[platform].sha256,descriptor:loaded.descriptor,snapshotPeak,wasmHeapBytes:heapPeak,
      consoleSlots:loaded.consoleSlots,schemas:loaded.schemas,jsHeapBytes:jsHeapPeak,freshFrames:bursts*24,normalFreshFps:fresh.length?1000*fresh.length/fresh.reduce((a,b)=>a+b,0):null,
      correctionCpuMs:distribution(cpu),correctionElapsedMs:distribution(total),sliceMs:distribution(slices),freshIntervalMs:distribution(fresh),heldMs:distribution(held),
      phaseMs:{nativeStepPerSlice:distribution(steps),capturePerSlice:distribution(captures),restorePerSlice:distribution(restores)},inputLatency:{kind:"sampled input to changed P1 pixels plus next animation-frame paint opportunity; software estimate, not physical photons",manualOnsets,sendAgeMs:distribution(inputSendAge),drawAckMs:distribution(drawAckAge),offlineOnsetToPaintMs:distribution(offlineVisible),correctedOnsetToPaintMs:distribution(correctedVisible)},network:null,processMemory:null };
    cases.push(report); results.textContent=JSON.stringify(cases,null,2);
    // Partial uploads preserve measurements if the OS closes this memory-heavy diagnostic later.
    publish({schema:1,started,profile:smoke?"smoke":"full",complete:false,source:fixtures,device:{userAgent:navigator.userAgent,platform:navigator.platform,label:query.get("device")??"unlabelled"},hidden,cases:[...cases]});
  }
  const report = { schema:1,started,profile:smoke?"smoke":"full",complete:true,durationMs:performance.now()-start,source:fixtures,
    device:{userAgent:navigator.userAgent,platform:navigator.platform,label:query.get("device")??"unlabelled"},hidden,cases,
    limitations:["Synthetic local bot inputs; no live network measurements","Visible response is a software pixel/paint estimate, not physical display latency; process memory is unavailable","Held frames are stalls, not fresh 60fps","Physical-phone acceptance requires a named Android and iPhone"] };
  results.textContent=JSON.stringify(report,null,2); status.textContent="Measurement complete. Physical-phone acceptance is assessed separately.";
  publish(report);
  if (parent === window) { const a=document.createElement("a");a.textContent="Download report";a.href=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:"application/json"}));a.download="multiplayer-benchmark.json";document.body.append(a); }
  await rpc({type:"dispose"});worker.terminate();
}
run().catch(error=>{const message=String(error.message??error);status.textContent=`Benchmark failed: ${message}`;if(lastReport)publish({...lastReport,complete:false,hidden,error:message.slice(0,256)});stop(error);});
