import type { Platform } from "./protocol.ts";
import type { BundleConfig, FrameInput } from "./multiplayer.ts";

export const MP_ABI = 1;
export const MP_HEADER = { gb: 0x10f0, gbc: 0x10f0, nes: 0x03f0 };
export interface Memory {
  readMemory(region: string, offset: number, length: number): ArrayLike<number>;
  writeMemory(region: string, offset: number, bytes: Uint8Array): void;
}
export interface Context { address: number; region: string; offset: number; header: Uint8Array }
export function discoverContext(h: Memory, platform: Platform): Context | null {
  // Gambatte exposes physical WRAM: bank 1 is offset $1000 regardless of SVBK.
  const header = Uint8Array.from(h.readMemory("system_ram", MP_HEADER[platform], 8));
  if (header[0] !== 0x4d || header[1] !== 0x50) return null;
  if (header[2] !== MP_ABI || header[3] !== 8 || header[6] !== 32 || header[7] !== 1) throw new Error("unsupported MP header/bootstrap capability");
  const address = header[4] | header[5] << 8;
  if (platform !== "nes") {
    if (address < 0xc000 || address + 32 > 0xd000) throw new Error("MP context must fit unbanked WRAM");
    return { address, region: "system_ram", offset: address - 0xc000, header };
  }
  if (address >= 0x0400 && address + 32 <= 0x0800 || address < 0x0300 && address + 32 <= 0x0300) return { address, region: "system_ram", offset: address, header };
  if (address >= 0x6100 && address + 32 <= 0x8000) return { address, region: "save_ram", offset: address - 0x6000, header };
  throw new Error("MP context overlaps state page/save area or is not writable RAM");
}
export function checkHeader(h: Memory, platform: Platform, ctx: Context) {
  const actual = Uint8Array.from(h.readMemory("system_ram", MP_HEADER[platform], 8));
  if (!actual.every((v, i) => v === ctx.header[i])) throw new Error("MP header changed during execution");
}
export function contextBytes(c: BundleConfig, viewSlot: number, f?: FrameInput) {
  const b = new Uint8Array(32), dv = new DataView(b.buffer);
  b.set([c.mode === "shared" ? 1 : 2, c.slots.length, c.capacity, viewSlot]);
  b[4] = c.slots.reduce((mask, slot) => mask | 1 << slot, 0);
  const states = f?.states ?? [0, 1, 2, 3].map((s) => c.slots.includes(s) ? 1 : 0);
  b[5] = states.reduce<number>((mask, state, slot) => mask | (state === 1 || state === 2 ? 1 << slot : 0), 0);
  b[6] = c.policy === "replace" ? 1 : 0; b[7] = 1;
  dv.setUint32(8, f?.frame ?? 0, true); dv.setUint32(12, c.seed, true);
  if (f) b.set(f.masks, 16);
  b.set(states, 20);
  return b;
}
export function writeContext(h: Memory, ctx: Context, c: BundleConfig, slot: number, f?: FrameInput) {
  const b = contextBytes(c, slot, f);
  if (c.platform === "nes" && f) {
    // NES offsets 16–19 belong to the ROM's native $4016/$4017 latch, never to the runtime.
    h.writeMemory(ctx.region, ctx.offset, b.subarray(0, 16));
    h.writeMemory(ctx.region, ctx.offset + 20, b.subarray(20));
  } else h.writeMemory(ctx.region, ctx.offset, b);
}
