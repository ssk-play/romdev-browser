import type { ConsoleBundle } from './bundle.ts';
import { u32 } from './multiplayer.ts';

export interface WorldSpan { region: 'system_ram' | 'save_ram'; offset: number; length: number }
export interface WorldField extends WorldSpan { name: string }
/** Low-level engine observation binding. M3 derives trigger/tick from the trusted
 * engine's linked symbols; worldState is the author's typed field schema. */
export interface WorldObservation { trigger: number; value?: number; tick: WorldSpan; fields: WorldField[] }
export interface WorldEvent { tick: number; pc: number; bytes: Uint8Array }
export interface WorldDifference { nativeFrame: number; tick: number; consoles: [number, number]; field: string; region: string; offset: number; expected: string; actual: string }
const hex = (b: Uint8Array) => [...b].map(v => v.toString(16).padStart(2, '0')).join('');
const overlap = (a: { region: string; offset: number; length: number }, b: { region: string; offset: number; length: number }) => a.region === b.region && a.offset < b.offset + b.length && b.offset < a.offset + a.length;
export class WorldMismatch extends Error {
  readonly difference: WorldDifference;
  constructor(d: WorldDifference) {
    super(`world mismatch at tick ${d.tick}, native frame ${d.nativeFrame}: slots ${d.consoles.join('/')} field ${d.field} ${d.region}+0x${d.offset.toString(16)} (${d.expected} != ${d.actual})`);
    this.difference = d;
  }
}

/** Diagnostic only: copied before rendering, compared at matching logical ticks.
 * Neither native/display-boundary RAM reads nor cross-client bundle digests can
 * replace this check. At most eight unmatched ticks may be retained. */
export class WorldObserver {
  private readonly slots: number[];
  private readonly fields: WorldField[];
  private readonly width: number;
  private readonly pending = new Map<number, Map<number, WorldEvent>>();
  private readonly last = new Map<number, number>();
  private checked = 0;
  constructor(bundle: ConsoleBundle, request: WorldObservation) {
    if (!request || !Array.isArray(request.fields) || !request.fields.length || request.fields.length > 32 || request.tick?.length !== 4) throw new Error('invalid world observation contract');
    this.slots = bundle.consoles.map(c => c.slot);
    this.fields = request.fields.map(f => ({ ...f }));
    if (new Set(this.fields.map(f => f.name)).size !== this.fields.length || this.fields.some(f => !f || typeof f.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(f.name) || !['system_ram', 'save_ram'].includes(f.region) || !Number.isInteger(f.offset) || f.offset < 0 || !Number.isInteger(f.length) || f.length < 1 || f.length > 1024)) throw new Error('invalid world fields');
    this.width = this.fields.reduce((n, f) => n + f.length, 0);
    if (this.width > 1024 || this.fields.some((f, i) => this.fields.slice(0, i).some(g => overlap(f, g)))) throw new Error('oversized/overlapping world fields');
    for (const c of bundle.consoles) {
      const reserved = { region: 'system_ram' as const, offset: bundle.config.platform === 'nes' ? 0x3f0 : 0x10f0, length: 16 };
      if (this.fields.some(f => overlap(f, { ...c.context, length: 32 }) || overlap(f, reserved) || overlap(f, request.tick))) throw new Error('world field overlaps engine context/header/tick');
    }
    try {
      for (const c of bundle.consoles) c.host.startWorldObservation({ ...request, tick: { ...request.tick }, fields: this.fields });
    } catch (e) { this.dispose(bundle); throw e; }
  }
  collect(bundle: ConsoleBundle, nativeFrame: number) {
    const reports = bundle.consoles.map(c => ({ slot: c.slot, report: c.host.drainWorldObservation() }));
    for (const { slot, report } of reports) this.validateReport(slot, report);
    // Interleave drained batches by logical tick: serially draining an entire
    // fast console first must not invent skew before the other reports catch up.
    const events = reports.flatMap(({ slot, report }) => report.events.map(event => ({ slot, event })));
    events.sort((a, b) => a.event.tick - b.event.tick || a.slot - b.slot);
    for (const { slot, event } of events) this.ingest(slot, { events: [event], total: 1, truncated: false }, nativeFrame);
  }
  private validateReport(slot: number, report: { events: WorldEvent[]; total: number; truncated: boolean }) {
    if (!this.slots.includes(slot) || !report || report.truncated || !Array.isArray(report.events) || report.events.length > 8 || report.total !== report.events.length) throw new Error('world observation overflow/invalid console');
  }
  /** Also used by deterministic queue/overflow regression tests. */
  ingest(slot: number, report: { events: WorldEvent[]; total: number; truncated: boolean }, nativeFrame: number) {
    this.validateReport(slot, report);
    for (const source of report.events) {
      const prev = this.last.get(slot) ?? 0;
      if (!u32(source.tick) || source.tick !== prev + 1 || !u32(source.pc) || !(source.bytes instanceof Uint8Array) || source.bytes.length !== this.width) throw new Error(`world publication missing/repeated tick for slot ${slot}`);
      const e = { ...source, bytes: source.bytes.slice() }; this.last.set(slot, e.tick);
      let row = this.pending.get(e.tick); if (!row) this.pending.set(e.tick, row = new Map()); row.set(slot, e);
      if (row.size === this.slots.length) {
        const base = row.get(this.slots[0])!;
        for (const other of this.slots.slice(1)) {
          const actual = row.get(other)!; let at = 0;
          for (const f of this.fields) {
            const wanted = base.bytes.subarray(at, at + f.length), got = actual.bytes.subarray(at, at + f.length);
            if (wanted.some((v, i) => v !== got[i])) throw new WorldMismatch({ nativeFrame, tick: e.tick, consoles: [this.slots[0], other], field: f.name, region: f.region, offset: f.offset, expected: hex(wanted), actual: hex(got) });
            at += f.length;
          }
        }
        this.pending.delete(e.tick); this.checked++;
      }
      if (this.pending.size > 8) throw new Error('world consoles exceed logical-tick skew limit');
    }
  }
  result() {
    if (!this.checked) throw new Error('ROM did not publish a complete logical world tick');
    // A final native boundary can cut different views on opposite sides of a
    // publication. Report this explicitly; never claim those trailing ticks agree.
    return { checkedTicks: this.checked, checkedThroughTick: Math.min(...this.slots.map(s => this.last.get(s) ?? 0)), lastTicks: this.slots.map(slot => ({ slot, tick: this.last.get(slot) ?? 0 })), unmatchedTicks: [...this.pending.keys()].sort((a, b) => a - b) };
  }
  dispose(bundle: ConsoleBundle) { for (const c of bundle.consoles) c.host.stopWorldObservation(); this.pending.clear(); }
}
