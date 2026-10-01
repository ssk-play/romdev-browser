declare module "romdev-core-host" {
  export class LibretroHost {
    constructor(opts?: Record<string, unknown>);
    mod: { HEAPU8: Uint8Array } | null;
    state: { audioRing: Int16Array[] } & Record<string, unknown>;
    status: { audioSampleRate: number; fbWidth: number; fbHeight: number; coreFps: number } & Record<string, unknown>;
    loadCore(opts: { factory: unknown; wasmBinary: Uint8Array; io?: false }): Promise<void>;
    loadMedia(args: { platform: string; bytes: Uint8Array; name?: string; deterministic?: { rtcEpochSeconds: number }; controllerTopology?: { kind: "nes"; playerMask: number } }): Promise<void>;
    unloadMedia(): void;
    stepFrames(n: number): void;
    screenshotRgba(): { rgba: Uint8Array | Uint8ClampedArray; width: number; height: number };
    setInput(input: { ports: Record<string, boolean>[] }): void;
    saveState(name: string): unknown;
    loadState(name: string): unknown;
    regionSize(region: string): number;
    readMemory(region: string, offset: number, length: number): ArrayLike<number>;
    writeMemory(region: string, offset: number, bytes: Uint8Array): void;
    reset(): void;
    dispose(): void;
    stateDigest(): { schema: number; bytes: Uint8Array };
    startWorldObservation(request: { trigger: number; value?: number; tick: { region: string; offset: number; length: number }; fields: { region: string; offset: number; length: number }[] }): void;
    drainWorldObservation(): { events: { tick: number; pc: number; bytes: Uint8Array }[]; total: number; truncated: boolean };
    stopWorldObservation(): void;
  }
}
