/// <reference lib="webworker" />
import { Toolchain, type EmscriptenFactory, type ToolLoader, type ToolName } from "./toolchain.ts";
import { RUNTIME } from "./runtime.ts";
import { fetchBytes } from "./fetch.ts";
import type { CompilerEvent, CompilerRequest } from "./protocol.ts";

const post = (m: CompilerEvent) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
const asset = (name: string) => new URL(`./wasm/${name}`, import.meta.url);
const TOOLS: ToolName[] = ["mcpp", "sdcc", "sdasgb", "sdld"];
const DOWNLOADS = [...TOOLS.map((t) => `${t}.wasm`), "sdcc-share.json"];
const total = DOWNLOADS.reduce((n, f) => n + (__ASSET_SIZES__[f] ?? 0), 0);
let loaded = 0;
let lastReport = 0;
const progress = (n: number) => {
  loaded += n;
  const now = Date.now();
  if (now - lastReport > 100 || loaded >= total) {
    lastReport = now;
    post({ type: "progress", loaded: Math.min(loaded, total), total });
  }
};

const modules = new Map<ToolName, Promise<WebAssembly.Module>>();
const factories = new Map<ToolName, Promise<EmscriptenFactory>>();
let share: Promise<Record<string, Uint8Array>> | null = null;

const loader: ToolLoader = {
  factory(tool) {
    if (!factories.has(tool)) factories.set(tool, import(/* @vite-ignore */ asset(`${tool}.mjs`).href).then((m) => m.default));
    return factories.get(tool)!;
  },
  module(tool) {
    if (!modules.has(tool)) modules.set(tool, fetchBytes(asset(`${tool}.wasm`), progress).then((b) => WebAssembly.compile(b)));
    return modules.get(tool)!;
  },
  share() {
    share ??= fetchBytes(asset("sdcc-share.json"), progress).then((bytes) => {
      const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
      return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, Uint8Array.from(atob(v), (c) => c.charCodeAt(0))]));
    });
    return share;
  },
};

const toolchain = new Toolchain(loader);
let warm: Promise<void> | null = null;
const warmup = () =>
  (warm ??= Promise.all([...TOOLS.map((t) => Promise.all([loader.module(t), loader.factory(t)])), loader.share()]).then(
    () => post({ type: "ready" }),
    (err) => {
      // Let a later request retry the download (e.g. after a network blip).
      warm = null;
      modules.clear();
      factories.clear();
      share = null;
      loaded = 0;
      throw err;
    },
  ));

self.onmessage = async (e: MessageEvent<CompilerRequest>) => {
  const req = e.data;
  if (req.type === "warmup") {
    warmup().catch((err) => post({ type: "error", id: -1, message: String((err as Error)?.message ?? err) }));
    return;
  }
  try {
    await warmup();
    const result = await toolchain.build(req.input, RUNTIME[req.input.platform]);
    post({ type: "result", id: req.id, result });
  } catch (err) {
    post({ type: "error", id: req.id, message: String((err as Error)?.stack ?? err) });
  }
};
