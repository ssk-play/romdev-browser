/// <reference lib="webworker" />
import { LibretroHost } from "romdev-core-host";
import { ConsoleBundle } from "./bundle.ts";
import { BundleSession, BundleMessageQueue } from "./bundle-session.ts";
import { CORES } from "./platforms.ts";
import type { BundleEvent, BundleRequest } from "./bundle-protocol.ts";
import type { Platform } from "./protocol.ts";

declare const __BUNDLE_BUILD__: string;
const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: BundleEvent, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
const asset = (name: string) => new URL(`./wasm/${name}`, import.meta.url);
const assets = new Map<string, Promise<{ factory: unknown; wasm: Uint8Array }>>();
async function factory(platform: Platform) {
  const core = CORES[platform];
  if (!core) throw new Error("unknown platform");
  if (!assets.has(core)) {
    const load = Promise.all([
      import(/* @vite-ignore */ asset(`${core}.mjs`).href),
      fetch(asset(`${core}.wasm`)).then((r) => {
        if (!r.ok) throw new Error("core download failed");
        return r.arrayBuffer();
      }),
    ]).then(([m, bytes]) => ({ factory: m.default, wasm: new Uint8Array(bytes) }));
    assets.set(core, load);
    load.catch(() => assets.delete(core));
  }
  const a = await assets.get(core)!;
  return async () => {
    const h = new LibretroHost();
    try {
      await h.loadCore({ factory: a.factory, wasmBinary: a.wasm, io: false });
      return h;
    } catch (e) {
      h.dispose();
      throw e;
    }
  };
}
const session = new BundleSession(
  __BUNDLE_BUILD__,
  async (req) =>
    ConsoleBundle.boot(req.config, req.rom, __BUNDLE_BUILD__, await factory(req.config.platform)),
  post,
);
const queue = new BundleMessageQueue(session, post);
scope.onmessage = (e: MessageEvent<BundleRequest>) => {
  void queue.receive(e.data);
};
