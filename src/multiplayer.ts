// Transport-independent bundle/ROM contract. A frame is the input BEFORE one native core frame;
// a boundary's nextFrame is the first frame not executed. These types never contain browser identities.
import type { Platform } from "./protocol.ts";

export type ScreenMode = "shared" | "player-views";
export type SeatState = 0 | 1 | 2 | 3 | 4; // absent, active, held, inactive, left
export interface BundleConfig {
  platform: Platform;
  mode: ScreenMode;
  slots: readonly number[];
  capacity: number;
  epoch: number;
  seed: number;
  policy: "wait" | "replace";
  window: number;
  rtcEpochSeconds: number;
}
export interface FrameInput {
  frame: number;
  masks: readonly number[];
  states: readonly SeatState[];
}
export interface CoreState {
  schema: number;
  digest: Uint8Array;
  bytes: Uint8Array;
}
export interface Boundary {
  nextFrame: number;
  states: readonly CoreState[];
}
export interface DigestBoundary {
  nextFrame: number;
  states: readonly Pick<CoreState, "schema" | "digest">[];
}
export interface Pixels {
  width: number;
  height: number;
  rgba: Uint8Array;
}
export interface SliceResult {
  nextFrame: number;
  targetFrame: number;
  correcting: boolean;
  complete: boolean;
  workMs: number;
  correctionAgeMs: number;
  /** Emitted once when a coalesced correction completes; includes all slices and time between them. `frames` is how
   *  many frames it re-ran: from the earliest corrected frame to where the bundle had got (each console). */
  completedCorrection: { workMs: number; ageMs: number; frames: number } | null;
  nativeStepMs: number;
  captureMs: number;
  restoreMs: number;
  replayedConsoles: number;
  snapshotBytes: number;
  /** The held image predates a checkpoint restore; cleared after a complete new bundle frame. */
  presentationStale: boolean;
}
/** Longest prediction window a bundle accepts, frames (one second at 60 fps): how far a player may run ahead of what is
 *  confirmed. It retains window + 1 completed boundaries, so memory grows with it (docs/multiplayer-performance.md). */
export const MAX_WINDOW = 60;
export const CHECKPOINT_LIMIT = 1024 * 1024;
export const CHECKPOINT_META_LIMIT = 4096;
export const u32 = (v: number) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const configKeys = [
  "platform",
  "mode",
  "slots",
  "capacity",
  "epoch",
  "seed",
  "policy",
  "window",
  "rtcEpochSeconds",
];
export function validateConfig(c: BundleConfig) {
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    Object.keys(c).some((key) => !configKeys.includes(key))
  )
    throw new Error("unknown/invalid bundle configuration field");
  if (
    !["gb", "gbc", "nes"].includes(c.platform) ||
    !["shared", "player-views"].includes(c.mode) ||
    (c.platform === "nes" && c.mode !== "shared")
  )
    throw new Error("invalid platform/screen mode");
  if (
    !Array.isArray(c.slots) ||
    !c.slots.length ||
    c.slots.length > 4 ||
    new Set(c.slots).size !== c.slots.length ||
    c.slots.some((s) => !Number.isInteger(s) || s < 0 || s > 3)
  )
    throw new Error("invalid occupied slots");
  if (
    !Number.isInteger(c.capacity) ||
    c.capacity < Math.max(...c.slots) + 1 ||
    c.capacity > 4 ||
    !u32(c.epoch) ||
    !u32(c.seed)
  )
    throw new Error("invalid participant configuration");
  if (
    !["wait", "replace"].includes(c.policy) ||
    !Number.isInteger(c.window) ||
    c.window < 1 ||
    c.window > MAX_WINDOW ||
    !Number.isInteger(c.rtcEpochSeconds) ||
    c.rtcEpochSeconds < 0 ||
    c.rtcEpochSeconds > 0x7fffffff
  )
    throw new Error("invalid frozen bounds/clock");
}
export function copyInput(c: BundleConfig, f: FrameInput): FrameInput {
  if (
    !u32(f.frame) ||
    !Array.isArray(f.masks) ||
    f.masks.length !== 4 ||
    f.masks.some((m) => !Number.isInteger(m) || m < 0 || m > 255) ||
    !Array.isArray(f.states) ||
    f.states.length !== 4 ||
    f.states.some((s) => !Number.isInteger(s) || s < 0 || s > 4)
  )
    throw new Error("invalid frame vector");
  for (let s = 0; s < 4; s++) {
    const occupied = c.slots.includes(s);
    if (
      (!occupied && (f.masks[s] !== 0 || f.states[s] !== 0)) ||
      (occupied && f.states[s] === 0) ||
      (f.states[s] >= 3 && f.masks[s] !== 0)
    )
      throw new Error("input for absent/inactive seat");
  }
  return Object.freeze({
    frame: f.frame,
    masks: Object.freeze([...f.masks]),
    states: Object.freeze([...f.states]),
  });
}
export const sameInput = (a: FrameInput, b: FrameInput) =>
  a.masks.every((m, i) => m === b.masks[i]) && a.states.every((s, i) => s === b.states[i]);
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
export const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
