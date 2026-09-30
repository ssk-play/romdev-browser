// Bounded full-core snapshots, local to the emulator worker. Audio from resimulation is discarded.
export interface SnapshotCore {
  save(): Uint8Array;
  restore(state: Uint8Array): void;
  frame(masks: number[]): void;
  hash(): number;
  discardAudio(): void;
}
export class RollbackCore {
  next = 0;
  private snapshots = new Map<number, Uint8Array>();
  private readonly core: SnapshotCore;
  constructor(core: SnapshotCore) { this.core = core; this.snapshots.set(0, core.save()); }
  get bytes() { return this.snapshots.get(this.next)?.length ?? 0; }
  private run(masks: number[]) {
    if (masks.length !== 2 || masks.some(m => !Number.isInteger(m) || m < 0 || m > 255)) throw new Error("Invalid pads");
    this.core.frame(masks); this.next++;
    this.snapshots.set(this.next, this.core.save());
    return (this.next % 60 === 0) ? [{ seq: this.next - 1, hash: this.core.hash() }] : [];
  }
  private prune(confirmed: number) {
    if (!Number.isInteger(confirmed) || confirmed < -1 || confirmed >= this.next || this.next - confirmed > 65) throw new Error("Invalid confirmation window");
    for (const frame of this.snapshots.keys()) if (frame < confirmed + 1) this.snapshots.delete(frame);
  }
  step(frame: number, masks: number[], confirmed: number) {
    if (frame !== this.next) throw new Error("Wrong emulator frame");
    const checks = this.run(masks); this.prune(confirmed); return checks;
  }
  replay(from: number, inputs: number[][], confirmed: number) {
    const state = this.snapshots.get(from);
    if (!state || !Number.isInteger(from) || !inputs.length || inputs.length > 64 || from + inputs.length !== this.next)
      throw new Error("Rollback outside history");
    this.core.discardAudio(); this.core.restore(state); this.next = from;
    const checks: { seq: number; hash: number }[] = [];
    for (const masks of inputs) { checks.push(...this.run(masks)); this.core.discardAudio(); }
    this.prune(confirmed); return checks;
  }
}
