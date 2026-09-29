// Message protocol of the two workers. Clients talk to them only through postMessage;
// see README.md for the documented shapes (clients may implement them independently).
import type { BuildInput, BuildResult } from "./toolchain.ts";

export type Platform = "gb" | "gbc";
export type Buttons = Partial<Record<"up" | "down" | "left" | "right" | "a" | "b" | "start" | "select", boolean>>;

// ── compiler.worker.js ──
export type CompilerRequest = { type: "warmup" } | { type: "build"; id: number; input: BuildInput };
export type CompilerEvent =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready" }
  | { type: "result"; id: number; result: BuildResult }
  | { type: "error"; id: number; message: string };

// ── emulator.worker.js ──
export interface ProbeResult {
  blank: boolean;
  inputReactive: boolean;
  /** PNG data URL of the gameplay frame at the core's screen size. */
  screenshot: string;
  /** 2x PNG data URLs: after boot, after Start, after holding Right+A. */
  screens: string[];
}
/** The `load` reply: the core's screen (the canvas is set to it) and its frame rate, for the page's pacing. */
export interface LoadResult {
  width: number;
  height: number;
  fps: number;
}
export type EmulatorRequest =
  | { type: "init"; canvas: OffscreenCanvas; platform?: Platform }
  | { type: "load"; id: number; rom: Uint8Array; platform: Platform; sram?: Uint8Array | null }
  | { type: "step"; frames: number; buttons: Buttons }
  | { type: "reset"; id: number }
  | { type: "probe"; id: number }
  | { type: "readSram"; id: number };
export type EmulatorEvent =
  | { type: "ready" }
  | { type: "audio"; pcm: Int16Array; rate: number }
  | { type: "reply"; id: number; ok: true; value?: unknown }
  | { type: "reply"; id: number; ok: false; error: string };
