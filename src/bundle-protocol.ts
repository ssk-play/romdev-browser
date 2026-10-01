import type { BundleConfig, FrameInput } from "./multiplayer.ts";
import type { StreamPosition } from "./bundle-checkpoint.ts";
import type { PixelRegion } from "./pixel-probe.ts";

export type BundleRequest =
  | { type: "init"; id: number; canvas: OffscreenCanvas }
  | { type: "load"; id: number; rom: Uint8Array; config: BundleConfig }
  | { type: "frame"; id: number; input: FrameInput; budgetMs?: number }
  | { type: "correct"; id: number; inputs: FrameInput[]; confirmed: number }
  | { type: "confirm"; id: number; frame: number }
  | { type: "pump"; id: number; budgetMs?: number; maxOperations?: number }
  | { type: "view"; id: number; slot: number }
  | { type: "probe"; id: number; region: PixelRegion | null }
  | { type: "digest"; id: number; afterFrame: number; position: StreamPosition }
  | { type: "checkpoint"; id: number; afterFrame: number; position: StreamPosition }
  | {
      type: "restore";
      id: number;
      payload: Uint8Array;
      payloadHash: string;
      bundleDigest: string;
      position: StreamPosition;
    }
  | { type: "inspect"; id: number; region: string; offset: number; length: number }
  | { type: "dispose"; id: number };
export type BundleEvent =
  | { type: "reply"; id: number; ok: true; value?: unknown }
  | { type: "reply"; id: number; ok: false; error: string }
  | { type: "audio"; pcm: Int16Array; rate: number };
