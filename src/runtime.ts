// Vendored romdev C runtimes (MIT, see vendor/romdev) linked into every ROM.
import type { PlatformRuntime } from "./toolchain.ts";
import type { NesRuntime } from "./cc65.ts";
import gbHardware from "../vendor/romdev/gb/gb_hardware.h";
import gbRuntimeH from "../vendor/romdev/gb/gb_runtime.h";
import gbRuntimeC from "../vendor/romdev/gb/gb_runtime.c";
import gbCrt0 from "../vendor/romdev/gb/gb_crt0.s";
import gbcCrt0 from "../vendor/romdev/gbc/gb_crt0.s";
import fontH from "../vendor/romdev/gbc/font.h";
import nesRuntimeH from "../vendor/romdev/nes/nes_runtime.h";
import nesRuntimeC from "../vendor/romdev/nes/nes_runtime.c";
import nesCrt0 from "../vendor/romdev/nes/chr-ram-wram.crt0.s";
import nesCfg from "../vendor/romdev/nes/chr-ram-wram.cfg";

const headers = { "gb_hardware.h": gbHardware, "gb_runtime.h": gbRuntimeH, "font.h": fontH };
export const RUNTIME: Record<"gb" | "gbc", PlatformRuntime> = {
  gb: { headers, runtimeC: gbRuntimeC, crt0: gbCrt0 },
  gbc: { headers, runtimeC: gbRuntimeC, crt0: gbcCrt0 },
};

/** romdev's NES C project: neslib-shaped runtime, CHR-RAM crt0 (NMI handler, iNES header) and linker config. */
export const NES_RUNTIME: NesRuntime = { headers: { "nes_runtime.h": nesRuntimeH }, runtimeC: nesRuntimeC, crt0: nesCrt0, cfg: nesCfg };
