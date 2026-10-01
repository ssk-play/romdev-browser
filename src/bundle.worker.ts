/// <reference lib="webworker" />
import { LibretroHost } from "romdev-core-host";
import { ConsoleBundle } from "./bundle.ts";
import { BundleReplay } from "./bundle-replay.ts";
import { decodeCheckpoint, encodeCheckpoint } from "./bundle-checkpoint.ts";
import { CORES } from "./platforms.ts";
import type { BundleEvent, BundleRequest } from "./bundle-protocol.ts";
import type { Platform } from "./protocol.ts";
import { pixelProbe, type PixelRegion } from "./pixel-probe.ts";

declare const __BUNDLE_BUILD__: string;
const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: BundleEvent, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
const asset = (name: string) => new URL(`./wasm/${name}`, import.meta.url);
let replay: BundleReplay | null = null, canvas: OffscreenCanvas | null = null;
let probe: PixelRegion | null = null;
let queue = Promise.resolve(), waiting = 0;
const assets = new Map<string, Promise<{ factory: unknown; wasm: Uint8Array }>>();
async function factory(platform: Platform) {
  const core = CORES[platform];
  if (!core) throw new Error("unknown platform");
  if (!assets.has(core)) {
    const load = Promise.all([import(/* @vite-ignore */ asset(`${core}.mjs`).href), fetch(asset(`${core}.wasm`)).then((r) => { if (!r.ok) throw new Error("core download failed"); return r.arrayBuffer(); })])
      .then(([m, bytes]) => ({ factory: m.default, wasm: new Uint8Array(bytes) }));
    assets.set(core, load); load.catch(() => assets.delete(core));
  }
  const a = await assets.get(core)!;
  return async () => {
    const h = new LibretroHost();
    try { await h.loadCore({ factory: a.factory, wasmBinary: a.wasm, io: false }); return h; }
    catch (e) { h.dispose(); throw e; }
  };
}
function draw() {
  if (!replay || !canvas) return;
  const p = replay.display();
  if (!p.width || !p.height) return;
  if (canvas.width !== p.width) canvas.width = p.width;
  if (canvas.height !== p.height) canvas.height = p.height;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
  return probe ? pixelProbe(p,probe) : null;
}
function sound() {
  if (!replay) return;
  const chunks = replay.drainAudio();
  const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  if (!pcm.length) return;
  let at = 0; for (const c of chunks) { pcm.set(c, at); at += c.length; }
  post({ type: "audio", pcm, rate: replay.bundle.consoles[0].host.status.audioSampleRate }, [pcm.buffer]);
}
const heapBytes = () => replay?.bundle.consoles.reduce((n, v) => n + (v.host.mod?.HEAPU8.byteLength ?? 0), 0) ?? 0;
async function handle(req: BundleRequest) {
  if (req.type === "init") { canvas = req.canvas; draw(); return; }
  if (req.type === "dispose") { replay?.dispose(); replay = null; return; }
  if (req.type === "load") {
    replay?.dispose(); replay = null; probe = null;
    const bundle = await ConsoleBundle.boot(req.config, req.rom, __BUNDLE_BUILD__, await factory(req.config.platform));
    try { replay = new BundleReplay(bundle); } catch (e) { bundle.dispose(); throw e; }
    draw();
    return { build: __BUNDLE_BUILD__, descriptor: bundle.descriptorHash, consoleSlots: bundle.consoles.map((v) => v.slot), schemas:bundle.consoles.map(v=>v.host.stateDigest().schema), fps: bundle.consoles[0].host.status.coreFps, snapshotBytes: replay.snapshotBytes,
      wasmHeapBytes: bundle.consoles.reduce((n, v) => n + (v.host.mod?.HEAPU8.byteLength ?? 0), 0) };
  }
  const r = replay;
  if (!r) throw new Error("no bundle loaded");
  switch (req.type) {
    case "frame": { r.enqueue(req.input); const out = r.pump(req.budgetMs); const pixels=draw(); sound(); return { ...out, pixelHash:pixels, wasmHeapBytes: heapBytes() }; }
    case "correct": r.correct(req.inputs, req.confirmed); return;
    case "confirm": r.confirm(req.frame); return;
    case "pump": { const out = r.pump(req.budgetMs, req.maxOperations); const pixels=draw(); sound(); return { ...out, pixelHash:pixels, wasmHeapBytes: heapBytes() }; }
    case "view": r.selectView(req.slot); draw(); return;
    case "probe": {
      if(req.region) pixelProbe(r.display(),req.region);
      probe=req.region ? {...req.region} : null;
      return probe ? pixelProbe(r.display(),probe) : null;
    }
    case "checkpoint": return encodeCheckpoint(r.bundle.descriptorHash, r.checkpoint(req.afterFrame), req.position);
    case "restore": {
      const boundary = await decodeCheckpoint(req.payload, { descriptor: r.bundle.descriptorHash, payloadHash: req.payloadHash, bundleDigest: req.bundleDigest, consoles: r.bundle.consoles.length, ...req.position });
      r.restoreCheckpoint(boundary); draw(); return { nextFrame: r.nextFrame };
    }
    case "inspect": {
      if (!["system_ram", "save_ram"].includes(req.region) || !Number.isInteger(req.offset) || req.offset < 0 || !Number.isInteger(req.length) || req.length < 1 || req.length > 256 || r.correcting || r.nextFrame !== r.targetFrame) throw new Error("invalid/incomplete inspection");
      return r.bundle.consoles.map((v) => ({ slot: v.slot, bytes: Uint8Array.from(v.host.readMemory(req.region, req.offset, req.length)) }));
    }
    default: throw new Error("unknown bundle request");
  }
}
scope.onmessage = (e: MessageEvent<BundleRequest>) => {
  const req = e.data;
  if (!req || !Number.isInteger(req.id) || waiting >= 64) { post({ type: "reply", id: req?.id ?? -1, ok: false, error: "invalid/full worker queue" }); return; }
  waiting++;
  queue = queue.then(async () => {
    try { post({ type: "reply", id: req.id, ok: true, value: await handle(req) }); }
    catch (e) { post({ type: "reply", id: req.id, ok: false, error: String((e as Error)?.message ?? e) }); }
    finally { waiting--; }
  });
};
