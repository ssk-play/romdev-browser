import type { ConsoleBundle } from "./bundle.ts";
import {
  CHECKPOINT_LIMIT,
  copyInput,
  sameInput,
  type Boundary,
  type DigestBoundary,
  type CoreState,
  type FrameInput,
  type Pixels,
  type SliceResult,
} from "./multiplayer.ts";

export function validateSliceBudget(budgetMs = 8, maxOperations = 128) {
  if (
    !Number.isFinite(budgetMs) ||
    budgetMs <= 0 ||
    budgetMs > 8 ||
    !Number.isInteger(maxOperations) ||
    maxOperations < 1 ||
    maxOperations > 128
  )
    throw new Error("invalid replay slice budget");
}

/** A bounded scheduler, NOT an input predictor or room authority. The caller owns hint/commit reconciliation.
 * Capturing/sending local inputs belongs outside this worker. Every pump yields after bounded native operations. */
export class BundleReplay {
  readonly bundle: ConsoleBundle;
  nextFrame = 0;
  targetFrame = 0;
  confirmed = -1;
  private inputs = new Map<number, FrameInput>();
  private history = new Map<number, Boundary>();
  private partial: { states: CoreState[]; audio: Int16Array[][] } | null = null;
  private dirty: number | null = null;
  private restoring: { boundary: Boundary; index: number } | null = null;
  private replayEnd = 0;
  private correctionStarted: number | null = null;
  private correctionFrom = Infinity;   // the earliest frame this (coalesced) correction replays from
  private correctionWork = 0;
  private shown: Pixels[];
  presentationStale = false;
  private audio: Int16Array[] = [];
  private view = 0;
  private readonly now: () => number;
  private retired = false;
  constructor(bundle: ConsoleBundle, now: () => number = () => performance.now()) {
    this.bundle = bundle;
    this.now = now;
    const b = bundle.boundary(0);
    this.checkSize(b);
    this.history.set(0, b);
    this.shown = bundle.pixels();
  }
  get correcting() {
    return this.dirty !== null || this.restoring !== null || this.correctionStarted !== null;
  }
  get snapshotBytes() {
    let n = 0;
    for (const b of this.history.values()) for (const s of b.states) n += s.bytes.length;
    return n;
  }
  private checkSize(b: Boundary) {
    if (b.states.reduce((n, s) => n + s.bytes.length, 0) > CHECKPOINT_LIMIT)
      throw new Error("bundle exceeds checkpoint memory limit");
  }
  private live() {
    if (this.retired || this.bundle.retired) throw new Error("bundle retired");
  }
  enqueue(input: FrameInput) {
    this.live();
    const f = copyInput(this.bundle.config, input);
    if (f.frame !== this.targetFrame || this.targetFrame >= 0xffffffff)
      throw new Error("non-contiguous or exhausted frame stream");
    if (
      this.targetFrame - this.confirmed > this.bundle.config.window ||
      this.targetFrame - this.nextFrame >= this.bundle.config.window
    )
      throw new Error("prediction/compute backlog limit");
    this.inputs.set(f.frame, f);
    this.targetFrame++;
  }
  /** Validate the whole batch before mutation. Canonical frames include the local player's mask too. */
  correct(inputs: readonly FrameInput[], confirmed: number) {
    this.live();
    this.validateConfirmed(confirmed);
    if (!Array.isArray(inputs) || inputs.length > this.bundle.config.window)
      throw new Error("correction batch too large");
    const copies = inputs.map((f) => copyInput(this.bundle.config, f));
    const seen = new Map<number, FrameInput>();
    let first = Infinity;
    for (const f of copies) {
      const repeated = seen.get(f.frame);
      if (repeated) {
        if (!sameInput(repeated, f)) throw new Error("conflicting correction duplicate");
        continue;
      }
      if (f.frame >= this.targetFrame) throw new Error("correction outside retained inputs");
      seen.set(f.frame, f);
      const old = this.inputs.get(f.frame);
      // Older confirmations cannot change execution. Recent confirmed vectors
      // remain bounded to one window so conflicting repeats can still be reported.
      if (!old && f.frame <= this.confirmed) continue;
      if (!old) throw new Error("correction outside retained inputs");
      if (!sameInput(f, old)) {
        if (f.frame <= this.confirmed) throw new Error("confirmed input is immutable");
        if (
          (f.frame < this.nextFrame || (f.frame === this.nextFrame && this.partial)) &&
          !this.history.has(f.frame)
        )
          throw new Error("correction outside retained snapshots");
        first = Math.min(first, f.frame);
      }
    }
    for (const f of seen.values()) if (f.frame > this.confirmed) this.inputs.set(f.frame, f);
    if (first < this.nextFrame || (first === this.nextFrame && this.partial)) {
      this.dirty = Math.min(this.dirty ?? Infinity, first);
      this.replayEnd = Math.max(this.replayEnd, this.nextFrame);
      this.correctionFrom = Math.min(this.correctionFrom, first);
      if (this.correctionStarted === null) {
        this.correctionStarted = this.now();
        this.correctionWork = 0;
      }
    }
    this.confirmed = confirmed;
    this.prune();
  }
  confirm(frame: number) {
    this.live();
    this.validateConfirmed(frame);
    this.confirmed = frame;
    this.prune();
  }
  private validateConfirmed(frame: number) {
    if (!Number.isInteger(frame) || frame < this.confirmed || frame >= this.targetFrame)
      throw new Error("invalid confirmation watermark");
  }
  private prune() {
    // Keep the entire replay's required boundary, even when commits arrive faster than reconciliation.
    if (this.correcting || this.partial) return;
    const oldest = Math.min(this.confirmed + 1, this.nextFrame);
    for (const f of this.history.keys()) if (f < oldest) this.history.delete(f);
    const oldestInput = Math.max(0, this.confirmed - this.bundle.config.window + 1);
    for (const f of this.inputs.keys()) if (f < oldestInput) this.inputs.delete(f);
  }
  /** A core frame/save/restore cannot be preempted. Overshoot is measured and must pass the phone gate. */
  pump(budgetMs = 8, maxOperations = 128): SliceResult {
    this.live();
    validateSliceBudget(budgetMs, maxOperations);
    const start = this.now();
    let ops = 0,
      replayed = 0,
      nativeStepMs = 0,
      captureMs = 0,
      restoreMs = 0;
    const correctingAtStart = this.correctionStarted !== null;
    let completedCorrection: SliceResult["completedCorrection"] = null;
    try {
      while (ops < maxOperations && this.now() - start < budgetMs) {
        if (this.dirty !== null) {
          const boundary = this.history.get(this.dirty);
          if (!boundary) throw new Error("lost unfinished correction boundary");
          this.restoring = { boundary, index: 0 };
          this.nextFrame = this.dirty;
          this.partial = null;
          for (const f of this.history.keys()) if (f > this.dirty) this.history.delete(f);
          this.dirty = null;
          this.audio = [];
        }
        if (this.restoring) {
          const r = this.restoring,
            at = this.now();
          this.bundle.restoreConsole(r.index, r.boundary.states[r.index]);
          restoreMs += this.now() - at;
          r.index++;
          ops++;
          if (r.index === this.bundle.consoles.length) this.restoring = null;
          continue;
        }
        if (this.nextFrame >= this.targetFrame) break;
        this.partial ??= { states: [], audio: [] };
        const p = this.partial,
          i = p.states.length,
          replay = this.nextFrame < this.replayEnd;
        const out = this.bundle.runConsole(i, this.inputs.get(this.nextFrame)!);
        p.states.push(out.state);
        p.audio.push(out.audio);
        nativeStepMs += out.stepMs;
        captureMs += out.captureMs;
        ops++;
        if (replay) replayed++;
        if (p.states.length === this.bundle.consoles.length) {
          this.nextFrame++;
          const boundary = { nextFrame: this.nextFrame, states: p.states };
          this.checkSize(boundary);
          this.history.set(this.nextFrame, boundary);
          if (!replay) this.audio.push(...p.audio[this.view]);
          this.partial = null;
          let completedStart: number | null = null;
          let completedFrames = 0;
          if (!replay || this.nextFrame >= this.replayEnd) {
            this.shown = this.bundle.pixels();
            this.presentationStale = false;
            if (this.correctionStarted !== null && this.nextFrame >= this.replayEnd) {
              completedStart = this.correctionStarted;
              completedFrames = this.replayEnd - this.correctionFrom;
              this.correctionStarted = null;
              this.correctionFrom = Infinity;
            }
          }
          this.prune();
          if (completedStart !== null) {
            const end = this.now();
            this.correctionWork += end - start;
            completedCorrection = { workMs: this.correctionWork, ageMs: end - completedStart, frames: completedFrames };
          }
        }
      }
    } catch (e) {
      this.retired = true;
      this.bundle.dispose();
      throw e;
    }
    const workMs = this.now() - start;
    if (correctingAtStart && !completedCorrection) this.correctionWork += workMs;
    return {
      nextFrame: this.nextFrame,
      targetFrame: this.targetFrame,
      correcting: this.correcting,
      complete: !this.correcting && !this.partial && this.nextFrame === this.targetFrame,
      workMs,
      correctionAgeMs: this.correctionStarted === null ? 0 : this.now() - this.correctionStarted,
      completedCorrection,
      nativeStepMs,
      captureMs,
      restoreMs,
      replayedConsoles: replayed,
      snapshotBytes: this.snapshotBytes,
      presentationStale: this.presentationStale,
    };
  }
  selectView(slot: number) {
    this.live();
    const i =
      this.bundle.config.mode === "shared" && slot === 0xff
        ? 0
        : this.bundle.consoles.findIndex((v) => v.slot === slot);
    if (i < 0) throw new Error("unknown view slot");
    this.view = i;
    this.audio = [];
  }
  display(): Pixels {
    const p = this.shown[this.view];
    return { ...p, rgba: p.rgba.slice() };
  }
  drainAudio() {
    const out = this.audio;
    this.audio = [];
    return out;
  }
  private checkedBoundary(afterFrame: number): Boundary {
    this.live();
    if (
      !Number.isInteger(afterFrame) ||
      afterFrame < -1 ||
      afterFrame > this.confirmed ||
      this.correcting
    )
      throw new Error("checkpoint is not corrected/confirmed");
    const b = this.history.get(afterFrame + 1);
    if (!b) throw new Error("confirmed checkpoint outside retained history");
    return b;
  }
  digestBoundary(afterFrame: number): DigestBoundary {
    const b = this.checkedBoundary(afterFrame);
    return {
      nextFrame: b.nextFrame,
      states: b.states.map((s) => ({ digest: s.digest.slice(), schema: s.schema })),
    };
  }
  checkpoint(afterFrame: number): Boundary {
    const b = this.checkedBoundary(afterFrame);
    return {
      nextFrame: b.nextFrame,
      states: b.states.map((s) => ({
        bytes: s.bytes.slice(),
        digest: s.digest.slice(),
        schema: s.schema,
      })),
    };
  }
  restoreCheckpoint(b: Boundary) {
    this.live();
    this.checkSize(b);
    if (!Number.isInteger(b.nextFrame) || b.nextFrame < 0 || b.nextFrame > 0xffffffff)
      throw new Error("invalid checkpoint frame");
    this.bundle.restore(b);
    this.nextFrame = this.targetFrame = b.nextFrame;
    this.confirmed = b.nextFrame - 1;
    this.inputs.clear();
    this.history.clear();
    this.history.set(b.nextFrame, {
      nextFrame: b.nextFrame,
      states: b.states.map((s) => ({ ...s, bytes: s.bytes.slice(), digest: s.digest.slice() })),
    });
    this.dirty = null;
    this.partial = null;
    this.restoring = null;
    this.correctionStarted = null;
    this.correctionFrom = Infinity;
    this.replayEnd = 0;
    this.audio = [];
    this.presentationStale = true;
  }
  dispose() {
    this.retired = true;
    this.history.clear();
    this.inputs.clear();
    this.audio = [];
    this.bundle.dispose();
  }
}
