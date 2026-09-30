/// <reference lib="webworker" />
// The platform's libretro core (see platforms.ts) driven by romdev-core-host in bytes-only mode, drawing to an
// OffscreenCanvas handed over by the page; the canvas takes the core's screen size when a ROM loads. Frame pacing and
// input timing belong to the page: it sends {type:"step", frames, buttons} from its animation loop at the core's fps.
import { LibretroHost } from "romdev-core-host";
import { CORES, isPlatform, writeTouches, type Core } from "./platforms.ts";
import type { Buttons, EmulatorEvent, EmulatorRequest, LoadResult, Platform, ProbeResult } from "./protocol.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: EmulatorEvent, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
const asset = (name: string) => new URL(`./wasm/${name}`, import.meta.url);

const hosts = new Map<Core, Promise<LibretroHost>>();
let host: LibretroHost | null = null; // the core holding the loaded ROM
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let image: ImageData | null = null;
let loaded = false;
let platform: Platform = "gbc";   // of the loaded ROM
let busy = 0; // requests in flight (probe awaits PNG encoding); steps are dropped meanwhile

function hostFor(core: Core) {
  let ready = hosts.get(core);
  if (!ready) {
    ready = (async () => {
      const [factory, wasm] = await Promise.all([
        import(/* @vite-ignore */ asset(`${core}.mjs`).href).then((m) => m.default),
        fetch(asset(`${core}.wasm`)).then((r) => r.arrayBuffer()),
      ]);
      const h = new LibretroHost();
      await h.loadCore({ factory, wasmBinary: new Uint8Array(wasm), io: false });
      return h;
    })();
    hosts.set(core, ready);
    ready.catch(() => hosts.delete(core)); // a failed download is tried again by the next load
  }
  return ready;
}

/** The core's current frame at its own size. */
function frame(): { rgba: Uint8ClampedArray; width: number; height: number } | null {
  if (!host) return null;
  const { rgba, width, height } = host.screenshotRgba();
  if (!width || !height) return null;
  return { rgba: rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height };
}

function draw() {
  const f = frame();
  if (!f || !ctx) return;
  if (!image || image.width !== f.width || image.height !== f.height) {
    ctx.canvas.width = f.width;
    ctx.canvas.height = f.height;
    image = new ImageData(f.width, f.height);
  }
  image.data.set(f.rgba);
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
  const { rgba } = frame()!;
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
  const { rgba, width, height } = frame()!;
  const one = new OffscreenCanvas(width, height);
  one.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  let target = one;
  if (scale !== 1) {
    target = new OffscreenCanvas(width * scale, height * scale);
    const c = target.getContext("2d")!;
    c.imageSmoothingEnabled = false;
    c.drawImage(one, 0, 0, width * scale, height * scale);
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
      if (!isPlatform(req.platform)) throw new Error(`unknown platform ${req.platform}`);
      const h = await hostFor(CORES[req.platform]);
      if (loaded) host!.unloadMedia(); // the previous ROM, on this core or another
      loaded = false;
      host = h;
      await h.loadMedia({ platform: req.platform, bytes: req.rom, name: `game.${req.platform}` });
      loaded = true;
      platform = req.platform;
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
      const f = frame();
      return { width: f?.width ?? h.status.fbWidth, height: f?.height ?? h.status.fbHeight, fps: h.status.coreFps } satisfies LoadResult;
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
    case "advance": {
      if (!loaded || !host) throw new Error("no ROM loaded");
      const names = ["right", "left", "up", "down", "a", "b", "select", "start"] as const;
      if (req.masks.length !== 2 || req.masks.some(m => !Number.isInteger(m) || m < 0 || m > 255) ||
          !Number.isInteger(req.frames) || req.frames < 1 || req.frames > 8) throw new Error("invalid network input");
      const ports = req.masks.map(mask => Object.fromEntries(names.map((name, i) => [name, !!(mask & (1 << i))])));
      host.setInput({ ports });
      for (let i = 0; i < req.frames; i++) {
        writeTouches(host, platform, []);
        host.stepFrames(1);
      }
      draw();
      drainAudio(true);
      let hash = 2166136261;
      for (const region of ["system_ram", "save_ram"]) {
        const n = host.regionSize(region);
        if (n) for (const byte of host.readMemory(region, 0, n)) hash = Math.imul(hash ^ byte, 16777619);
      }
      return { hash: hash >>> 0 };
    }
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
    // the page may name the platform it will play, so its core downloads while the ROM does
    if (isPlatform(req.platform)) await hostFor(CORES[req.platform]).catch(() => null);
    post({ type: "ready" });
    return;
  }
  if (req.type === "step") {
    if (!loaded || !host || busy) return;
    input(req.buttons);
    writeTouches(host, platform, req.touches);
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
