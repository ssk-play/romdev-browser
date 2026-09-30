// What each platform is built with and runs on. The emulator worker and the server load a core the first time a ROM
// for it arrives, and the compiler worker downloads a toolchain the first time a build needs it, so a page that only
// plays one platform never downloads the others.
import type { Platform, Touches } from "./protocol.ts";

export type Core = "gambatte" | "fceumm";
export type ToolchainName = "sdcc" | "cc65";
export const CORES: Record<Platform, Core> = { gb: "gambatte", gbc: "gambatte", nes: "fceumm" };
export const TOOLCHAINS: Record<Platform, ToolchainName> = { gb: "sdcc", gbc: "sdcc", nes: "cc65" };
export const PLATFORMS = Object.keys(CORES) as Platform[];
export const isPlatform = (p: unknown): p is Platform => typeof p === "string" && Object.hasOwn(CORES, p);

/** Touch input (protocol.ts Touches). A game that wants it writes a 6-byte header at the end of the page the engines keep
 *  for state ($D0F8 on gb/gbc, $03F8 on nes): magic "TC", the address of its finger buffer (little-endian), how many
 *  fingers the buffer holds, and a byte the worker sets to the number of fingers down. Before every frame the worker
 *  writes each finger slot as [down 0/1, x, y] in screen pixels; a lifted finger keeps its last x, y (where it let go). */
export const TOUCH_HEADER: Record<Platform, number> = { gb: 0x10f8, gbc: 0x10f8, nes: 0x03f8 };
export const TOUCH_MAGIC = [0x54, 0x43];
export const SCREEN: Record<Platform, { width: number; height: number }> = {
  gb: { width: 160, height: 144 }, gbc: { width: 160, height: 144 }, nes: { width: 256, height: 224 },
};

/** Where a CPU address lives among the core's memory regions: work RAM (system_ram) or the cart's RAM (save_ram). */
export function ramAt(platform: Platform, addr: number): { region: string; offset: number } | null {
  if (platform === "nes") {
    if (addr < 0x0800) return { region: "system_ram", offset: addr };
    if (addr >= 0x6000 && addr < 0x8000) return { region: "save_ram", offset: addr - 0x6000 };   // PRG-RAM (cc65 statics)
    return null;
  }
  if (addr >= 0xc000 && addr < 0xe000) return { region: "system_ram", offset: addr - 0xc000 };
  if (addr >= 0xa000 && addr < 0xc000) return { region: "save_ram", offset: addr - 0xa000 };
  return null;
}

type Memory = { readMemory(region: string, offset: number, length: number): ArrayLike<number>; writeMemory(region: string, offset: number, bytes: Uint8Array): void };
/** Hand the fingers to the running game if its engine asked for touch (the header is in place); otherwise leave RAM
 *  alone. `touches[i]` is finger slot i (null: lifted); slots past the array are lifted too. */
export function writeTouches(host: Memory, platform: Platform, touches: Touches | undefined) {
  const at = TOUCH_HEADER[platform];
  let h: ArrayLike<number>;
  try { h = host.readMemory("system_ram", at, 5); } catch { return; }
  if (h[0] !== TOUCH_MAGIC[0] || h[1] !== TOUCH_MAGIC[1]) return;
  const buf = ramAt(platform, h[2] | (h[3] << 8));
  const slots = Math.min(h[4], 64);
  if (!buf || !slots) return;
  const { width, height } = SCREEN[platform];
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.floor(v)));
  let prev: ArrayLike<number>;
  try { prev = host.readMemory(buf.region, buf.offset, slots * 3); } catch { return; }
  const out = Uint8Array.from(prev);
  let down = 0;
  for (let i = 0; i < slots; i++) {
    const t = touches?.[i];
    out[i * 3] = t ? 1 : 0;
    if (t) { out[i * 3 + 1] = clamp(t.x, width); out[i * 3 + 2] = clamp(t.y, height); down++; }
  }
  host.writeMemory(buf.region, buf.offset, out);
  host.writeMemory("system_ram", at + 5, Uint8Array.of(down));
}
