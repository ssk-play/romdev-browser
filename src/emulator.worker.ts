/// <reference lib="webworker" />
// gambatte (romdev-core-gambatte) driven by romdev-core-host in bytes-only mode, drawing to an
// OffscreenCanvas handed over by the page. Frame pacing and input timing belong to the page:
// it sends {type:"step", frames, buttons} from its animation loop.
import { LibretroHost } from "romdev-core-host";
import type { Buttons, EmulatorEvent, EmulatorRequest, ProbeResult } from "./protocol.ts";

const W = 160;
const H = 144;
const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: EmulatorEvent, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
const asset = (name: string) => new URL(`./wasm/${name}`, import.meta.url);

let host: LibretroHost | null = null;
let hostReady: Promise<LibretroHost> | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let image: ImageData | null = null;
let loaded = false;
let busy = 0; // requests in flight (probe awaits PNG encoding); steps are dropped meanwhile

function ensureHost() {
  hostReady ??= (async () => {
    const [factory, wasm] = await Promise.all([
      import(/* @vite-ignore */ asset("gambatte.mjs").href).then((m) => m.default),
      fetch(asset("gambatte.wasm")).then((r) => r.arrayBuffer()),
    ]);
    const h = new LibretroHost();
    await h.loadCore({ factory, wasmBinary: new Uint8Array(wasm), io: false });
    host = h;
    return h;
  })();
  return hostReady;
}

function frameRgba(): Uint8ClampedArray | null {
  if (!host) return null;
  const { rgba, width, height } = host.screenshotRgba();
  if (width !== W || height !== H) return null;
  return rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
}

function draw() {
  const rgba = frameRgba();
  if (!rgba || !ctx || !image) return;
  image.data.set(rgba);
  ctx.putImageData(image, 0, 0);
}

function drainAudio(send: boolean) {
  if (!host) return;
  const ring = host.state.audioRing as Int16Array[];
  if (!ring.length) return;
  const chunks = ring.splice(0, ring.length);
  if (!send) return;
  let n = 0;
  for (const c of chunks) n += c.length;
  const pcm = new Int16Array(n);
  let o = 0;
  for (const c of chunks) {
    pcm.set(c, o);
    o += c.length;
  }
  post({ type: "audio", pcm, rate: host.status.audioSampleRate || 32768 }, [pcm.buffer]);
}

function input(b: Buttons) {
  host!.setInput({ ports: [{ ...b }] });
}

function run(n: number, hold?: Buttons) {
  if (hold) input(hold);
  host!.stepFrames(n);
  if (hold) input({});
}

function stats() {
  const rgba = frameRgba()!;
  const seen = new Set<number>();
  let h = 2166136261;
  for (let i = 0; i < rgba.length; i += 4) {
    const px = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    if (seen.size <= 32) seen.add(px);
    h = Math.imul(h ^ px, 16777619);
  }
  return { colors: seen.size, hash: h >>> 0 };
}

async function png(scale: number): Promise<string> {
  const rgba = frameRgba()!;
  const one = new OffscreenCanvas(W, H);
  one.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
  let target = one;
  if (scale !== 1) {
    target = new OffscreenCanvas(W * scale, H * scale);
    const c = target.getContext("2d")!;
    c.imageSmoothingEnabled = false;
    c.drawImage(one, 0, 0, W * scale, H * scale);
  }
  const bytes = new Uint8Array(await (await target.convertToBlob({ type: "image/png" })).arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:image/png;base64," + btoa(s);
}

function readSram(): Uint8Array | null {
  try {
    const size = host!.regionSize("save_ram");
    return size > 0 ? Uint8Array.from(host!.readMemory("save_ram", 0, size)) : null;
  } catch {
    return null;
  }
}

/**
 * Smoke check after a build: boot, press Start, press A, then compare "no input" with
 * "hold Right+A" from one save state. Restores battery RAM and resets to power-on after.
 */
async function probe(): Promise<ProbeResult> {
  const h = host!;
  const sram = readSram();
  const screens: string[] = [];
  h.reset(); // always judge the game from power-on, whatever state the player left it in
  run(90);
  screens.push(await png(2));
  run(8, { start: true });
  run(60);
  screens.push(await png(2));
  run(8, { a: true });
  run(30);
  const screenshot = await png(1);
  const blank = stats().colors <= 1;
  h.saveState("__probe");
  run(45);
  const idle = stats().hash;
  h.loadState("__probe");
  run(45, { right: true, a: true });
  const moved = stats().hash;
  screens.push(await png(2));
  if (sram) h.writeMemory("save_ram", 0, sram);
  h.reset();
  run(1);
  drainAudio(false);
  draw();
  return { blank, inputReactive: idle !== moved, screenshot, screens };
}

async function handle(req: EmulatorRequest): Promise<unknown> {
  switch (req.type) {
    case "load": {
      const h = await ensureHost();
      if (loaded) h.unloadMedia();
      loaded = false;
      await h.loadMedia({ platform: req.platform, bytes: req.rom, name: `game.${req.platform}` });
      loaded = true;
      if (req.sram?.length) {
        try {
          if (h.regionSize("save_ram") >= req.sram.length) {
            h.writeMemory("save_ram", 0, req.sram);
            h.reset(); // the game read its (empty) battery RAM while loading: boot it again with the save in place
          }
        } catch {
          /* no battery RAM on this cart */
        }
      }
      run(1);
      drainAudio(false);
      draw();
      return undefined;
    }
    case "reset":
      if (loaded) {
        host!.reset();
        drainAudio(false);
      }
      return undefined;
    case "probe":
      if (!loaded) throw new Error("no ROM loaded");
      return probe();
    case "readSram":
      return loaded ? readSram() : null;
    default:
      throw new Error(`unknown request ${(req as { type: string }).type}`);
  }
}

scope.onmessage = async (e: MessageEvent<EmulatorRequest>) => {
  const req = e.data;
  if (req.type === "init") {
    ctx = req.canvas.getContext("2d");
    image = new ImageData(W, H);
    await ensureHost().catch(() => null);
    post({ type: "ready" });
    return;
  }
  if (req.type === "step") {
    if (!loaded || !host || busy) return;
    input(req.buttons);
    host.stepFrames(Math.max(1, Math.min(req.frames, 8)));
    draw();
    drainAudio(true);
    return;
  }
  busy++;
  try {
    const value = await handle(req);
    post({ type: "reply", id: req.id, ok: true, value });
  } catch (err) {
    post({ type: "reply", id: req.id, ok: false, error: String((err as Error)?.message ?? err) });
  } finally {
    busy--;
  }
};
