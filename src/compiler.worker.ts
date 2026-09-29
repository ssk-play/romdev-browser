/// <reference lib="webworker" />
// Builds for every platform (SDCC for gb/gbc, cc65 for nes). A toolchain downloads the first time it is needed:
// `warmup` (optionally naming the platform) starts it early, with progress events.
import { builder, TOOLCHAIN_FILES } from "./build.ts";
import { fetchBytes } from "./fetch.ts";
import { TOOLCHAINS, isPlatform, type ToolchainName } from "./platforms.ts";
import type { EmscriptenFactory, ShareName, ToolLoader } from "./wasmtool.ts";
import type { CompilerEvent, CompilerRequest } from "./protocol.ts";

const post = (m: CompilerEvent) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
const asset = (name: string) => new URL(`./wasm/${name}`, import.meta.url);

// download progress of the toolchain being warmed up
let loaded = 0;
let total = 0;
let lastReport = 0;
const progress = (n: number) => {
  loaded += n;
  const now = Date.now();
  if (now - lastReport > 100 || loaded >= total) {
    lastReport = now;
    post({ type: "progress", loaded: Math.min(loaded, total), total });
  }
};

const modules = new Map<string, Promise<WebAssembly.Module>>();
const factories = new Map<string, Promise<EmscriptenFactory>>();
const shares = new Map<ShareName, Promise<Record<string, Uint8Array>>>();

const loader: ToolLoader = {
  factory(tool) {
    if (!factories.has(tool)) factories.set(tool, import(/* @vite-ignore */ asset(`${tool}.mjs`).href).then((m) => m.default));
    return factories.get(tool)!;
  },
  module(tool) {
    if (!modules.has(tool)) modules.set(tool, fetchBytes(asset(`${tool}.wasm`), progress).then((b) => WebAssembly.compile(b)));
    return modules.get(tool)!;
  },
  share(name) {
    if (!shares.has(name)) {
      shares.set(name, fetchBytes(asset(`${name}-share.json`), progress).then((bytes) => {
        const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
        return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, Uint8Array.from(atob(v), (c) => c.charCodeAt(0))]));
      }));
    }
    return shares.get(name)!;
  },
};

const build = builder(loader);
const warm = new Map<ToolchainName, Promise<void>>();
function warmup(tc: ToolchainName) {
  let p = warm.get(tc);
  if (p) return p;
  const { tools, share } = TOOLCHAIN_FILES[tc];
  loaded = 0;
  total = [...tools.map((t) => `${t}.wasm`), `${share}-share.json`].reduce((n, f) => n + (__ASSET_SIZES__[f] ?? 0), 0);
  p = Promise.all([...tools.map((t) => Promise.all([loader.module(t), loader.factory(t)])), loader.share(share)]).then(
    () => post({ type: "ready" }),
    (err) => {
      // Let a later request retry the download (e.g. after a network blip).
      warm.delete(tc);
      for (const t of tools) {
        modules.delete(t);
        factories.delete(t);
      }
      shares.delete(share);
      throw err;
    },
  );
  warm.set(tc, p);
  return p;
}

self.onmessage = async (e: MessageEvent<CompilerRequest>) => {
  const req = e.data;
  if (req.type === "warmup") {
    const tc = isPlatform(req.platform) ? TOOLCHAINS[req.platform] : "sdcc";
    warmup(tc).catch((err) => post({ type: "error", id: -1, message: String((err as Error)?.message ?? err) }));
    return;
  }
  try {
    if (!isPlatform(req.input.platform)) throw new Error(`unknown platform ${req.input.platform}`);
    await warmup(TOOLCHAINS[req.input.platform]);
    post({ type: "result", id: req.id, result: await build(req.input) });
  } catch (err) {
    post({ type: "error", id: req.id, message: String((err as Error)?.stack ?? err) });
  }
};
