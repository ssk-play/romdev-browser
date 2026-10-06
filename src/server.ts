// Headless build + run service: the same toolchains and cores as the workers, behind HTTP, for a server that
// makes games for someone (chiptoy's MCP endpoint runs it in a container). Stateless: every request carries its
// sources or ROM. Requests are served one at a time on a job thread; past GAMELAB_QUEUE_MAX (default 4) waiting or
// running, 503; a job past GAMELAB_JOB_MS (default 45000) is stopped, 504.
//
//   node dist/server.mjs            PORT (default 8080); GAMELAB_KEY, when set, must match the x-gamelab-key header
//   GET  /health                    { ok, version, queued, runningMs, skipped, stopped }
//   POST /build { platform: gb | gbc | nes, sources: { "main.c": ..., "x.c": ... }, title?, objects? }
//        -> { ok, stage, rom: base64|null, romBytesUsed, banks: { n: bytes }|null, issues, log, ms, objects? }
//        objects: compiled units a host kept from an earlier result (gb/gbc); sending it (even {}) returns this
//        build's units, so a fresh process recompiles only changed files
//        gb/gbc: data (`#pragma constseg CODE_<n>`, n = 2-511) and `__banked` code (`#pragma codeseg CODE_<n>`) go
//        to switchable ROM bank n; the cart becomes MBC5. nes: romdev's NES C project (32 KB PRG, CHR-RAM, battery).
//   POST /run   { platform, rom: base64, frames, input: [{ frame, until, buttons, touch: {x, y} | touches: [{x, y} | null] }], shots: [frame], every,
//                 memory: [{ region, offset, length }] }
//        -> { rows: [{ frame, memory: [hex] }], shots: [{ frame, png: base64 }], sram: base64|null, ms }
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { LibretroHost } from "romdev-core-host";
import { builder } from "./build.ts";
import { CORES, isPlatform, PLATFORMS, writeTouches, type Core } from "./platforms.ts";
import type { EmscriptenFactory, ShareName, ToolLoader } from "./wasmtool.ts";
import type { Buttons, Platform, Touches } from "./protocol.ts";
import { runBundle, type BundleRunRequest } from "./bundle-headless.ts";
import { Busy, Gone, JobQueue } from "./job-queue.ts";

declare const __VERSION__: string;
declare const __BUNDLE_BUILD__: string;
const asset = (name: string) => new URL(`./wasm/${name}`, import.meta.url);
const MAX_FRAMES = 60 * 60 * 10;
const BUTTONS = ["up", "down", "left", "right", "a", "b", "start", "select"] as const;

// ── toolchain ─────────────────────────────────────────────────────────────────────────────────────────────────
const modules = new Map<string, Promise<WebAssembly.Module>>();
const factories = new Map<string, Promise<EmscriptenFactory>>();
const shares = new Map<ShareName, Promise<Record<string, Uint8Array>>>();
const loader: ToolLoader = {
  factory(tool) {
    if (!factories.has(tool)) factories.set(tool, import(asset(`${tool}.mjs`).href).then((m) => m.default));
    return factories.get(tool)!;
  },
  module(tool) {
    if (!modules.has(tool)) modules.set(tool, WebAssembly.compile(readFileSync(asset(`${tool}.wasm`))));
    return modules.get(tool)!;
  },
  share(name) {
    if (!shares.has(name)) {
      shares.set(name, Promise.resolve(Object.fromEntries(
        Object.entries(JSON.parse(readFileSync(asset(`${name}-share.json`), "utf8")) as Record<string, string>)
          .map(([k, v]) => [k, new Uint8Array(Buffer.from(v, "base64"))]),
      )));
    }
    return shares.get(name)!;
  },
};
const buildRom = builder(loader, `romdev-browser ${__VERSION__}`);

// ── emulator ──────────────────────────────────────────────────────────────────────────────────────────────────
const hosts = new Map<Core, Promise<LibretroHost>>();
function emulator(core: Core) {
  let ready = hosts.get(core);
  if (!ready) {
    ready = (async () => {
      const factory = (await import(asset(`${core}.mjs`).href)).default;
      const h = new LibretroHost();
      await h.loadCore({ factory, wasmBinary: new Uint8Array(readFileSync(asset(`${core}.wasm`))), io: false });
      return h;
    })();
    hosts.set(core, ready);
  }
  return ready;
}
let current: LibretroHost | null = null; // the core holding the last ROM
const platformError = () => new Error(`platform: ${PLATFORMS.join(" or ")}`);

function png(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = y * (width * 3 + 1) + 1 + x * 3;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

interface InputEntry { frame: number; until?: number; buttons: string[]; touch?: { x: number; y: number }; touches?: ({ x: number; y: number } | null)[] }
interface MemoryRead { region?: string; offset: number; length: number }
interface RunRequest {
  platform: Platform; rom: string; frames?: number; input?: InputEntry[]; shots?: number[]; every?: number;
  memory?: MemoryRead[]; sram?: boolean;
}

/** The fingers at frame `f`: an entry's `touches` (slot by slot) or `touch` (slot 0), later entries winning per slot. */
function touchesAt(input: InputEntry[], f: number): Touches {
  const t: Touches = [];
  const point = (p: { x: number; y: number } | null | undefined) => (p ? { x: Number(p.x) || 0, y: Number(p.y) || 0 } : null);
  for (const e of input) {
    if (f < e.frame || f >= (e.until ?? e.frame + 1)) continue;
    const list = Array.isArray(e.touches) ? e.touches : e.touch ? [e.touch] : [];
    list.slice(0, 64).forEach((p, i) => { if (p) t[i] = point(p); });
  }
  return t;
}

function buttonsAt(input: InputEntry[], f: number): Buttons {
  const b: Buttons = {};
  for (const e of input) if (f >= e.frame && f < (e.until ?? e.frame + 1)) for (const k of e.buttons) b[k as keyof Buttons] = true;
  return b;
}

async function run(req: RunRequest) {
  const t0 = Date.now();
  if (!isPlatform(req.platform)) throw platformError();
  const host = await emulator(CORES[req.platform]);
  const frames = Math.max(1, Math.min(MAX_FRAMES, Math.floor(req.frames ?? 300)));
  const input = (req.input ?? []).map((e) => ({ ...e, buttons: e?.buttons ?? [] }))
    .filter((e) => Array.isArray(e.buttons) && e.buttons.every((b) => (BUTTONS as readonly string[]).includes(b)));
  const shots = [...new Set((req.shots ?? []).map(Math.floor).filter((s) => s > 0 && s <= frames))].sort((a, b) => a - b).slice(0, 8);
  const every = Math.max(0, Math.floor(req.every ?? 0));
  const stops = new Set<number>([...shots, frames]);
  if (every) for (let f = every; f < frames && stops.size < 64; f += every) stops.add(f);
  current?.unloadMedia();
  current = null;
  await host.loadMedia({ platform: req.platform, bytes: new Uint8Array(Buffer.from(req.rom, "base64")), name: `game.${req.platform}` });
  current = host;
  const rows: { frame: number; memory: string[] }[] = [];
  const pics: { frame: number; png: string }[] = [];
  let cur = 0;
  let held = "";
  for (const stop of [...stops].sort((a, b) => a - b)) {
    while (cur < stop) {
      const b = buttonsAt(input, cur);
      const key = JSON.stringify(b);
      if (key !== held) { host.setInput({ ports: [b] }); held = key; }
      writeTouches(host, req.platform, touchesAt(input, cur));
      // run to the next frame where the held buttons may change
      let next = stop;
      for (const e of input) for (const edge of [e.frame, e.until ?? e.frame + 1]) if (edge > cur && edge < next) next = edge;
      host.stepFrames(next - cur);
      host.state.audioRing.length = 0;
      cur = next;
    }
    rows.push({ frame: stop, memory: (req.memory ?? []).map((m) => Buffer.from(host.readMemory(m.region ?? "system_ram", m.offset, m.length)).toString("hex")) });
    if (shots.includes(stop)) {
      const { rgba, width, height } = host.screenshotRgba();
      pics.push({ frame: stop, png: png(rgba, width, height).toString("base64") });
    }
  }
  const sram = req.sram && host.regionSize("save_ram") ? Buffer.from(host.readMemory("save_ram", 0, host.regionSize("save_ram"))).toString("base64") : null;
  return { rows, shots: pics, sram, ms: Date.now() - t0 };
}

async function build(req: import("./toolchain.ts").BuildInput) {
  if (!isPlatform(req.platform)) throw platformError();
  if (!req.sources || typeof req.sources["main.c"] !== "string") throw new Error("sources must include main.c");
  const objects = req.objects && typeof req.objects === "object" ? req.objects : undefined;
  const r = await buildRom({ platform: req.platform, sources: req.sources, title: req.title, memoryContract:req.memoryContract, objects });
  return { ok: r.ok, stage: r.stage, rom: r.rom ? Buffer.from(r.rom).toString("base64") : null, romBytesUsed: r.romBytesUsed,
    banks: r.banks ?? null, issues: r.issues, log: r.log.slice(-4000), ms: r.ms, ...(r.objects ? { objects: r.objects } : {}) };
}

async function bundleRun(req:BundleRunRequest) {
  current?.unloadMedia();current=null;
  return runBundle(req,__BUNDLE_BUILD__,async()=>{
    const core=CORES[req.config.platform],factory=(await import(asset(`${core}.mjs`).href)).default,h=new LibretroHost();
    try{await h.loadCore({factory,wasmBinary:new Uint8Array(readFileSync(asset(`${core}.wasm`))),io:false});return h;}catch(e){h.dispose();throw e;}
  },(rgba,width,height)=>png(rgba,width,height).toString("base64"));
}

// ── HTTP (main thread) and jobs (a worker thread) ────────────────────────────────────────────────────────────
// Jobs run on one worker thread, so this thread stays free to answer /health, refuse a full queue and notice callers
// that leave. A job past GAMELAB_JOB_MS (default 45 s) is stopped by terminating that thread; the next job starts a
// fresh one, which loads the toolchain and cores again.
type Kind = "build" | "run" | "bundleRun";
const JOBS: Record<Kind, (body: never) => Promise<unknown>> = { build, run, bundleRun };
const JOB_MS = Number(process.env.GAMELAB_JOB_MS) > 0 ? Number(process.env.GAMELAB_JOB_MS) : 45_000;

if (isMainThread) serve();
else parentPort!.on("message", async ({ kind, body }: { kind: Kind; body: unknown }) => {
  try { parentPort!.postMessage({ result: await JOBS[kind](body as never) }); }
  catch (err) { parentPort!.postMessage({ error: (err as Error).message }); }
});

class Stopped extends Error {}
let thread: Worker | null = null;
let stopped = 0;
/** Run one job on the job thread (one at a time: the queue sees to that), stopping it past JOB_MS. */
function jobThread() {
  const w = new Worker(new URL(import.meta.url));
  // always listened to, so a failure between jobs never takes this thread down; the next job starts a fresh one
  w.on("error", (err) => console.error("job thread:", err)).on("exit", () => { if (thread === w) thread = null; });
  return w;
}
function inThread(kind: Kind, body: unknown): Promise<unknown> {
  const w = (thread ??= jobThread());
  return new Promise((ok, fail) => {
    const done = (end: () => void) => {
      clearTimeout(timer);
      w.off("message", onMessage).off("error", onError).off("exit", onExit);
      end();
    };
    const lost = (why: string) => done(() => { if (thread === w) thread = null; fail(new Error(why)); });
    const onMessage = (m: { result?: unknown; error?: string }) => done(() => (m.error !== undefined ? fail(new Error(m.error)) : ok(m.result)));
    const onError = (err: Error) => lost(`the job thread failed: ${err.message}`);
    const onExit = (code: number) => lost(`the job thread exited (${code})`);
    const timer = setTimeout(() => done(() => {
      if (thread === w) thread = null;
      stopped++;
      void w.terminate();
      fail(new Stopped(`${kind === "bundleRun" ? "bundle run" : kind} took longer than ${JOB_MS / 1000} s and was stopped`));
    }), JOB_MS);
    w.on("message", onMessage).on("error", onError).on("exit", onExit);
    w.postMessage({ kind, body });
  });
}

function serve() {
  const jobs = new JobQueue(Number(process.env.GAMELAB_QUEUE_MAX) || 4);
  /** Queue a job for this request; leaving before its turn (the response closed unfinished) skips it. */
  const serial = (res: ServerResponse, kind: Kind, body: unknown) => {
    const left = new AbortController();
    res.on("close", () => { if (!res.writableEnded) left.abort(); });
    if (res.destroyed || res.socket?.destroyed) left.abort();
    return jobs.add(() => inThread(kind, body), left.signal);
  };
  const ROUTES: Record<string, Kind> = { "/build": "build", "/run": "run", "/bundle/run": "bundleRun" };
  const KEY = process.env.GAMELAB_KEY ?? "";
  createServer(async (req, res) => {
    try {
      if (req.url === "/health") return send(res, 200, { ok: true, version: __VERSION__, ...jobs.status(), stopped });
      if (KEY && req.headers["x-gamelab-key"] !== KEY) return send(res, 401, { error: "unauthorized" });
      const kind = req.method === "POST" ? ROUTES[req.url ?? ""] : undefined;
      if (!kind) return send(res, 404, { error: "not found" });
      const b = await body(req);
      send(res, 200, await serial(res, kind, b));
    } catch (err) {
      if (err instanceof Gone) return;
      send(res, err instanceof Busy ? 503 : err instanceof Stopped ? 504 : 400, { error: (err as Error).message });
    }
  }).listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => console.log(`romdev-browser server ${__VERSION__} on :${process.env.PORT ?? 8080}`));
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
