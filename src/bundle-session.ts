import { ConsoleBundle } from "./bundle.ts";
import { BundleReplay, validateSliceBudget } from "./bundle-replay.ts";
import { boundaryDigest, decodeCheckpoint, encodeCheckpoint } from "./bundle-checkpoint.ts";
import type { BundleEvent, BundleRequest } from "./bundle-protocol.ts";
import { pixelProbe, type PixelRegion } from "./pixel-probe.ts";
import { u32, validateConfig } from "./multiplayer.ts";

type Post = (event: BundleEvent, transfer?: Transferable[]) => void;
type Boot = (request: Extract<BundleRequest, { type: "load" }>) => Promise<ConsoleBundle>;

/** The worker and Node regression suite execute this same message handler. */
export class BundleSession {
  private replay: BundleReplay | null = null;
  private canvas: OffscreenCanvas | null = null;
  private probe: PixelRegion | null = null;
  private readonly build: string;
  private readonly boot: Boot;
  private readonly post: Post;
  constructor(build: string, boot: Boot, post: Post) {
    this.build = build;
    this.boot = boot;
    this.post = post;
  }

  private draw() {
    const r = this.replay;
    if (!r) return null;
    const p = r.display();
    if (this.canvas && p.width && p.height) {
      if (this.canvas.width !== p.width) this.canvas.width = p.width;
      if (this.canvas.height !== p.height) this.canvas.height = p.height;
      this.canvas
        .getContext("2d")!
        .putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
    }
    return this.probe ? pixelProbe(p, this.probe) : null;
  }
  private sound() {
    const r = this.replay;
    if (!r) return;
    const chunks = r.drainAudio();
    const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
    if (!pcm.length) return;
    let at = 0;
    for (const c of chunks) {
      pcm.set(c, at);
      at += c.length;
    }
    this.post({ type: "audio", pcm, rate: r.bundle.consoles[0].host.status.audioSampleRate }, [
      pcm.buffer,
    ]);
  }
  private heapBytes() {
    return (
      this.replay?.bundle.consoles.reduce((n, v) => n + (v.host.mod?.HEAPU8.byteLength ?? 0), 0) ??
      0
    );
  }
  async handle(req: BundleRequest): Promise<unknown> {
    if (req.type === "init") {
      this.canvas = req.canvas;
      this.draw();
      return;
    }
    if (req.type === "dispose") {
      this.replay?.dispose();
      this.replay = null;
      return;
    }
    if (req.type === "load") {
      validateConfig(req.config);
      this.replay?.dispose();
      this.replay = null;
      this.probe = null;
      const b = await this.boot(req);
      try {
        this.replay = new BundleReplay(b);
      } catch (e) {
        b.dispose();
        throw e;
      }
      this.draw();
      return {
        build: this.build,
        descriptor: b.descriptorHash,
        consoleSlots: b.consoles.map((v) => v.slot),
        schemas: b.consoles.map((v) => v.host.stateDigest().schema),
        fps: b.consoles[0].host.status.coreFps,
        snapshotBytes: this.replay.snapshotBytes,
        wasmHeapBytes: this.heapBytes(),
      };
    }
    const r = this.replay;
    if (!r) throw new Error("no bundle loaded");
    switch (req.type) {
      case "frame": {
        // Reject an invalid pump budget before accepting its input frame.
        validateSliceBudget(req.budgetMs);
        r.enqueue(req.input);
        const out = r.pump(req.budgetMs),
          pixels = this.draw();
        this.sound();
        return { ...out, pixelHash: pixels, wasmHeapBytes: this.heapBytes() };
      }
      case "correct":
        r.correct(req.inputs, req.confirmed);
        return;
      case "confirm":
        r.confirm(req.frame);
        return;
      case "pump": {
        const out = r.pump(req.budgetMs, req.maxOperations),
          pixels = this.draw();
        this.sound();
        return { ...out, pixelHash: pixels, wasmHeapBytes: this.heapBytes() };
      }
      case "view":
        r.selectView(req.slot);
        this.draw();
        return;
      case "probe": {
        if (req.region) pixelProbe(r.display(), req.region);
        this.probe = req.region ? { ...req.region } : null;
        return this.probe ? pixelProbe(r.display(), this.probe) : null;
      }
      case "digest": {
        const b = r.digestBoundary(req.afterFrame);
        return {
          bundleDigest: await boundaryDigest(r.bundle.descriptorHash, b, req.position),
          nextFrame: b.nextFrame,
          ...req.position,
        };
      }
      case "checkpoint":
        return encodeCheckpoint(
          r.bundle.descriptorHash,
          r.checkpoint(req.afterFrame),
          req.position,
        );
      case "restore": {
        const b = await decodeCheckpoint(req.payload, {
          descriptor: r.bundle.descriptorHash,
          payloadHash: req.payloadHash,
          bundleDigest: req.bundleDigest,
          consoles: r.bundle.consoles.length,
          ...req.position,
        });
        r.restoreCheckpoint(b);
        // Native unserialize does not redraw. Hold the last complete displayed
        // image and tell the caller it is stale until a complete new frame.
        return { nextFrame: r.nextFrame, presentationStale: r.presentationStale };
      }
      case "inspect": {
        if (
          !["system_ram", "save_ram"].includes(req.region) ||
          !Number.isInteger(req.offset) ||
          req.offset < 0 ||
          !Number.isInteger(req.length) ||
          req.length < 1 ||
          req.length > 256 ||
          r.correcting ||
          r.nextFrame !== r.targetFrame
        ) {
          throw new Error("invalid/incomplete inspection");
        }
        return r.bundle.consoles.map((v) => ({
          slot: v.slot,
          bytes: Uint8Array.from(v.host.readMemory(req.region, req.offset, req.length)),
        }));
      }
      default:
        throw new Error("unknown bundle request");
    }
  }
}

/** Bounded admission applies before asynchronous work; replies preserve request IDs. */
export class BundleMessageQueue {
  private queue = Promise.resolve();
  private waiting = 0;
  private readonly session: BundleSession;
  private readonly post: Post;
  constructor(session: BundleSession, post: Post) {
    this.session = session;
    this.post = post;
  }
  receive(value: unknown): Promise<void> {
    const req = value as BundleRequest | null;
    if (
      !req ||
      typeof req !== "object" ||
      Array.isArray(req) ||
      !u32(req.id) ||
      this.waiting >= 64
    ) {
      this.post({
        type: "reply",
        id: req && u32(req.id) ? req.id : -1,
        ok: false,
        error: "invalid/full worker queue",
      });
      return Promise.resolve();
    }
    this.waiting++;
    this.queue = this.queue.then(async () => {
      try {
        this.post({ type: "reply", id: req.id, ok: true, value: await this.session.handle(req) });
      } catch (e) {
        this.post({
          type: "reply",
          id: req.id,
          ok: false,
          error: String((e as Error)?.message ?? e),
        });
      } finally {
        this.waiting--;
      }
    });
    return this.queue;
  }
}
