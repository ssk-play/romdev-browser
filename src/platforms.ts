// What each platform is built with and runs on. The emulator worker and the server load a core the first time a ROM
// for it arrives, and the compiler worker downloads a toolchain the first time a build needs it, so a page that only
// plays one platform never downloads the others.
import type { Platform, Touch } from "./protocol.ts";

export type Core = "gambatte" | "fceumm";
export type ToolchainName = "sdcc" | "cc65";
export const CORES: Record<Platform, Core> = { gb: "gambatte", gbc: "gambatte", nes: "fceumm" };
export const TOOLCHAINS: Record<Platform, ToolchainName> = { gb: "sdcc", gbc: "sdcc", nes: "cc65" };
export const PLATFORMS = Object.keys(CORES) as Platform[];
export const isPlatform = (p: unknown): p is Platform => typeof p === "string" && Object.hasOwn(CORES, p);

/** Touch input (protocol.ts Touch): the system_ram offset of the 5-byte block [magic "TC", down, x, y] at the end of the
 *  page the engines keep for state ($D0F8 on gb/gbc, $03F8 on nes), and the screen it is measured in. */
export const TOUCH_BLOCK: Record<Platform, number> = { gb: 0x10f8, gbc: 0x10f8, nes: 0x03f8 };
export const TOUCH_MAGIC = [0x54, 0x43];
export const SCREEN: Record<Platform, { width: number; height: number }> = {
  gb: { width: 160, height: 144 }, gbc: { width: 160, height: 144 }, nes: { width: 256, height: 224 },
};

type Memory = { readMemory(region: string, offset: number, length: number): ArrayLike<number>; writeMemory(region: string, offset: number, bytes: Uint8Array): void };
/** Hand `touch` to the running game if its engine asked for touch (the magic is in place); otherwise leave RAM alone. */
export function writeTouch(host: Memory, platform: Platform, touch: Touch | undefined) {
  const at = TOUCH_BLOCK[platform];
  let magic: ArrayLike<number>;
  try { magic = host.readMemory("system_ram", at, 2); } catch { return; }
  if (magic[0] !== TOUCH_MAGIC[0] || magic[1] !== TOUCH_MAGIC[1]) return;
  const { width, height } = SCREEN[platform];
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.floor(v)));
  host.writeMemory("system_ram", at + 2, Uint8Array.of(touch ? 1 : 0, touch ? clamp(touch.x, width) : 0, touch ? clamp(touch.y, height) : 0));
}
