// Vendored romdev C runtime (MIT, see vendor/romdev) linked into every ROM.
import type { PlatformRuntime } from "./toolchain.ts";
import type { Platform } from "./protocol.ts";
import gbHardware from "../vendor/romdev/gb/gb_hardware.h";
import gbRuntimeH from "../vendor/romdev/gb/gb_runtime.h";
import gbRuntimeC from "../vendor/romdev/gb/gb_runtime.c";
import gbCrt0 from "../vendor/romdev/gb/gb_crt0.s";
import gbcCrt0 from "../vendor/romdev/gbc/gb_crt0.s";
import fontH from "../vendor/romdev/gbc/font.h";

const headers = { "gb_hardware.h": gbHardware, "gb_runtime.h": gbRuntimeH, "font.h": fontH };
export const RUNTIME: Record<Platform, PlatformRuntime> = {
  gb: { headers, runtimeC: gbRuntimeC, crt0: gbCrt0 },
  gbc: { headers, runtimeC: gbRuntimeC, crt0: gbcCrt0 },
};
