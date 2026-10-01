import { LibretroHost } from "romdev-core-host";
import { checkHeader, discoverContext, writeContext, type Context } from "./multiplayer-abi.ts";
import {
  CHECKPOINT_LIMIT,
  copyInput,
  hex,
  sha256,
  validateConfig,
  type Boundary,
  type BundleConfig,
  type CoreState,
  type FrameInput,
  type Pixels,
} from "./multiplayer.ts";

export type HostFactory = () => Promise<LibretroHost>;
const buttons = ["right", "left", "up", "down", "a", "b", "select", "start"] as const;
const ports = (masks: readonly number[]) =>
  masks.map((mask) =>
    Object.fromEntries(buttons.map((name, bit) => [name, !!(mask & (1 << bit))])),
  );
const drain = (h: LibretroHost) => h.state.audioRing.splice(0);
export interface ConsoleInstance {
  host: LibretroHost;
  context: Context;
  slot: number;
}

/** One shared console, or the same ordered consoles on EVERY replica. Each factory creates an isolated core heap. */
export class ConsoleBundle {
  readonly config: BundleConfig;
  readonly consoles: readonly ConsoleInstance[];
  readonly descriptorHash: string;
  private disposed = false;
  get retired() {
    return this.disposed;
  }
  private live() {
    if (this.disposed) throw new Error("bundle retired");
  }
  private constructor(c: BundleConfig, consoles: ConsoleInstance[], descriptorHash: string) {
    this.config = Object.freeze({ ...c, slots: Object.freeze([...c.slots]) });
    this.consoles = Object.freeze(consoles);
    this.descriptorHash = descriptorHash;
  }
  static async boot(config: BundleConfig, rom: Uint8Array, build: string, factory: HostFactory) {
    validateConfig(config);
    if (
      !(rom instanceof Uint8Array) ||
      !rom.length ||
      rom.length > 8 * 1024 * 1024 ||
      !build ||
      build.length > 128
    )
      throw new Error("invalid ROM/build identity");
    const c: BundleConfig = {
      platform: config.platform,
      mode: config.mode,
      slots: [...config.slots].sort((a, b) => a - b),
      capacity: config.capacity,
      epoch: config.epoch,
      seed: config.seed,
      policy: config.policy,
      window: config.window,
      rtcEpochSeconds: config.rtcEpochSeconds,
    };
    const consoles: ConsoleInstance[] = [],
      created: LibretroHost[] = [];
    try {
      for (const slot of c.mode === "shared" ? [0xff] : c.slots) {
        const h = await factory();
        created.push(h);
        await h.loadMedia({
          platform: c.platform,
          bytes: rom,
          deterministic: { rtcEpochSeconds: c.rtcEpochSeconds },
          ...(c.platform === "nes"
            ? {
                controllerTopology: {
                  kind: "nes",
                  playerMask: c.slots.reduce((m, s) => m | (1 << s), 0),
                },
              }
            : {}),
        });
        // Always standard zero cartridge RAM; no person's battery save enters an epoch.
        const sram = h.regionSize("save_ram");
        if (sram > CHECKPOINT_LIMIT) throw new Error("unsupported cartridge RAM size");
        if (sram) h.writeMemory("save_ram", 0, new Uint8Array(sram));
        h.setInput({ ports: [] });
        let ctx: Context | null = null;
        for (let n = 0; n < 120 && !ctx; n++) {
          h.stepFrames(1);
          drain(h);
          ctx = discoverContext(h, c.platform);
        }
        if (!ctx) throw new Error("ROM did not publish an MP bootstrap header");
        const flags = h.readMemory(ctx.region, ctx.offset + 7, 1)[0];
        if (flags !== 0) throw new Error("ROM passed world initialization before MP configuration");
        writeContext(h, ctx, c, slot);
        consoles.push({ host: h, context: ctx, slot });
      }
      const romHash = hex(await sha256(rom));
      const descriptorHash = hex(
        await sha256(
          new TextEncoder().encode(
            JSON.stringify([
              "chiptoy-descriptor/1",
              1,
              c.platform,
              c.mode,
              c.slots,
              c.capacity,
              c.epoch,
              c.seed,
              c.policy,
              c.window,
              c.rtcEpochSeconds,
              build,
              romHash,
              consoles.map((v) => v.host.stateDigest().schema),
            ]),
          ),
        ),
      );
      return new ConsoleBundle(c, consoles, descriptorHash);
    } catch (e) {
      created.forEach((h) => h.dispose());
      throw e;
    }
  }
  capture(i: number): CoreState {
    this.live();
    const h = this.consoles[i].host,
      bytes = h.serializeState(),
      d = h.stateDigest();
    return { bytes, schema: d.schema, digest: d.bytes.slice() };
  }
  boundary(nextFrame: number): Boundary {
    return { nextFrame, states: this.consoles.map((_, i) => this.capture(i)) };
  }
  restoreConsole(i: number, s: CoreState) {
    this.live();
    const v = this.consoles[i];
    v.host.unserializeState(s.bytes);
    drain(v.host);
    checkHeader(v.host, this.config.platform, v.context);
    const digest = v.host.stateDigest();
    if (digest.schema !== s.schema || !digest.bytes.every((byte, j) => byte === s.digest[j]))
      throw new Error("checkpoint causal digest mismatch");
  }
  restore(b: Boundary) {
    if (b.states.length !== this.consoles.length)
      throw new Error("checkpoint console count mismatch");
    b.states.forEach((s, i) => {
      if (
        s.schema !== this.consoles[i].host.stateDigest().schema ||
        s.bytes.length !== this.consoles[i].host.serializeState().length
      )
        throw new Error("checkpoint core/schema/length mismatch");
    });
    const previous = this.consoles.map((_, i) => this.capture(i));
    try {
      b.states.forEach((s, i) => {
        this.restoreConsole(i, s);
      });
    } catch (e) {
      try {
        previous.forEach((s, i) => this.restoreConsole(i, s));
      } catch {
        this.dispose();
        throw new Error("bundle restore failed; bundle retired");
      }
      throw e;
    }
  }
  /** Smallest work quantum: one native frame on one console. Never present a partial bundle. */
  runConsole(i: number, input: FrameInput) {
    this.live();
    const f = copyInput(this.config, input),
      v = this.consoles[i];
    checkHeader(v.host, this.config.platform, v.context);
    writeContext(v.host, v.context, this.config, v.slot, f);
    v.host.setInput({ ports: ports(this.config.platform === "nes" ? f.masks : [0]) });
    const stepAt = performance.now();
    v.host.stepFrames(1);
    const stepMs = performance.now() - stepAt;
    const audio = drain(v.host);
    checkHeader(v.host, this.config.platform, v.context);
    const captureAt = performance.now(),
      state = this.capture(i),
      captureMs = performance.now() - captureAt;
    return { state, audio, stepMs, captureMs };
  }
  pixels(): Pixels[] {
    return this.consoles.map((v) => {
      const p = v.host.screenshotRgba();
      return { width: p.width, height: p.height, rgba: Uint8Array.from(p.rgba) };
    });
  }
  dispose() {
    this.disposed = true;
    this.consoles.forEach((v) => v.host.dispose());
  }
}
