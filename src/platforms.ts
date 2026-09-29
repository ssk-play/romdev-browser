// What each platform is built with and runs on. The emulator worker and the server load a core the first time a ROM
// for it arrives, and the compiler worker downloads a toolchain the first time a build needs it, so a page that only
// plays one platform never downloads the others.
import type { Platform } from "./protocol.ts";

export type Core = "gambatte" | "fceumm";
export type ToolchainName = "sdcc" | "cc65";
export const CORES: Record<Platform, Core> = { gb: "gambatte", gbc: "gambatte", nes: "fceumm" };
export const TOOLCHAINS: Record<Platform, ToolchainName> = { gb: "sdcc", gbc: "sdcc", nes: "cc65" };
export const PLATFORMS = Object.keys(CORES) as Platform[];
export const isPlatform = (p: unknown): p is Platform => typeof p === "string" && Object.hasOwn(CORES, p);
