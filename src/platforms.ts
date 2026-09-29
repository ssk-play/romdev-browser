// The emulator core each platform runs on. The emulator worker and the server load a core the first time a ROM for
// it arrives, so a page that only plays one platform never downloads the others.
import type { Platform } from "./protocol.ts";

export type Core = "gambatte";
export const CORES: Record<Platform, Core> = { gb: "gambatte", gbc: "gambatte" };
export const PLATFORMS = Object.keys(CORES) as Platform[];
export const isPlatform = (p: unknown): p is Platform => typeof p === "string" && Object.hasOwn(CORES, p);
